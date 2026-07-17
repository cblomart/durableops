/*
 * DurableOps test harness.
 *
 * Each orchestrator reproduces one failure an ops admin actually has to
 * recognise and act on. The integration tests drive these through the same
 * src/api modules the SPA uses, so a scenario that stops behaving like the real
 * thing fails the build rather than quietly weakening the tests.
 *
 * Plain JavaScript on purpose: no compile step, so the harness deploys as a zip
 * and CI needs no extra SDK.
 */
const { app } = require('@azure/functions');
const df = require('durable-functions');

/* ---------------------------------------------------------------- activities */

df.app.activity('AlwaysFails', {
  handler: (input) => {
    throw new Error(`Simulated activity failure: ${input ?? 'no input'}`);
  },
});

df.app.activity('Echo', {
  handler: (input) => `echo:${input ?? ''}`,
});

/**
 * Never runs — and that is the point.
 *
 * The Bicep sets `AzureWebJobs.NeverRuns.Disabled = 1`, so the host refuses to
 * execute it. An orchestrator that calls it gets its TaskScheduled written to
 * history and then nothing, forever: exactly what a real stuck activity looks
 * like (message queued, no worker ever picks it up). Sleeping instead would only
 * hit the function timeout and turn into a failure, which is a different bug.
 */
df.app.activity('NeverRuns', {
  handler: () => 'unreachable',
});

/* ------------------------------------------------------------ orchestrators */

/** Activity throws on first call: the simplest Failed instance. */
df.app.orchestration('FailOnActivity', function* (context) {
  return yield context.df.callActivity('AlwaysFails', 'first-try');
});

/** Retry policy exhausted — history shows repeated TaskScheduled/TaskFailed pairs. */
df.app.orchestration('FailAfterRetries', function* (context) {
  const retry = new df.RetryOptions(2000, 3);
  return yield context.df.callActivityWithRetry('AlwaysFails', retry, 'with-retries');
});

/** Last history event stays TaskScheduled: the "possibly stuck" badge target. */
df.app.orchestration('StuckAtScheduling', function* (context) {
  return yield context.df.callActivity('NeverRuns', 'never');
});

/** Running, waiting on a timer years out. Terminate is the only way home. */
df.app.orchestration('EternalTimer', function* (context) {
  const farFuture = new Date(context.df.currentUtcDateTime.getTime() + 365 * 24 * 3600 * 1000);
  yield context.df.createTimer(farFuture);
  return 'never reached in practice';
});

/** Waits for an external event: the raiseEvent target. */
df.app.orchestration('WaitForExternalEvent', function* (context) {
  const payload = yield context.df.waitForExternalEvent('Approval');
  return { approved: true, payload };
});

/** Failure inside a sub-orchestration: exercises SubOrchestrationInstanceFailed. */
df.app.orchestration('SubOrchestrationFail', function* (context) {
  return yield context.df.callSubOrchestrator('FailOnActivity', 'from-parent');
});

/**
 * Healthy and long-lived: the target for terminate / suspend / resume / purge.
 *
 * Short timers in a loop rather than one long sleep, so suspend and resume have
 * frequent checkpoints to actually take effect at.
 */
df.app.orchestration('LongRunningHappy', function* (context) {
  const iterations = 60;
  const results = [];
  for (let i = 0; i < iterations; i++) {
    yield context.df.createTimer(new Date(context.df.currentUtcDateTime.getTime() + 10_000));
    results.push(yield context.df.callActivity('Echo', `tick-${i}`));
    context.df.setCustomStatus({ tick: i, of: iterations });
  }
  return results.length;
});

/* ----------------------------------------------------------------- starters */

const SCENARIOS = [
  'FailOnActivity',
  'FailAfterRetries',
  'StuckAtScheduling',
  'EternalTimer',
  'WaitForExternalEvent',
  'SubOrchestrationFail',
  'LongRunningHappy',
];

/**
 * POST /api/start/{scenario} -> starts one instance and returns its id.
 *
 * `StuckPending` is not an orchestrator: it is any scenario started with a
 * scheduled start time in the future, which the runtime reports as Pending
 * having written no history at all. Request it with ?startInMinutes=N.
 */
app.http('start', {
  route: 'start/{scenario}',
  methods: ['POST'],
  authLevel: 'function',
  extraInputs: [df.input.durableClient()],
  handler: async (request, context) => {
    const scenario = request.params.scenario;
    if (!SCENARIOS.includes(scenario)) {
      return {
        status: 400,
        jsonBody: { error: `Unknown scenario '${scenario}'`, known: SCENARIOS },
      };
    }

    const client = df.getClient(context);
    const startInMinutes = Number(request.query.get('startInMinutes') ?? '0');
    const options = {};
    if (Number.isFinite(startInMinutes) && startInMinutes > 0) {
      options.startAt = new Date(Date.now() + startInMinutes * 60_000);
    }

    const instanceId = await client.startNew(scenario, options);
    return { status: 202, jsonBody: { instanceId, scenario } };
  },
});

/** GET /api/scenarios -> what this harness can start. Used by the tests to self-check. */
app.http('scenarios', {
  route: 'scenarios',
  methods: ['GET'],
  authLevel: 'function',
  handler: async () => ({ status: 200, jsonBody: { scenarios: SCENARIOS } }),
});
