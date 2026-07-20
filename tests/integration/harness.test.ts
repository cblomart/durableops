/*
 * Integration tests against a REAL Azure Durable Functions app.
 *
 * These drive the same `src/api/*` modules the SPA uses, under Node, against the
 * deployed test harness — no browser, so no CORS in the way. This is the layer
 * that catches the runtime disagreeing with our parser: it is what found
 * TaskScheduled carrying "Name" rather than "FunctionName", which the docs never
 * mention and which mocked unit tests can never discover.
 *
 * Requires the harness (infra/modules/test-harness.bicep) and:
 *   DURABLEOPS_HARNESS_HOST=<app>.azurewebsites.net
 *   DURABLEOPS_HARNESS_KEY=<durabletask_extension system key>
 *
 * Skipped entirely when unset, so `npm test` stays offline and credential-free.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  listInstances,
  getInstance,
  countFailedInstances,
  terminateInstance,
  suspendInstance,
  resumeInstance,
  raiseEvent,
  purgeInstance,
  rewindInstance,
  restartInstance,
  type DurableTarget,
} from '../../src/api/durable';
import {
  buildTriage,
  detectStuck,
  firstFailureIndex,
  groupFailuresBySignature,
  instanceErrorSignature,
} from '../../src/triage';

const hostName = process.env['DURABLEOPS_HARNESS_HOST'] ?? '';
const systemKey = process.env['DURABLEOPS_HARNESS_KEY'] ?? '';
const configured = hostName !== '' && systemKey !== '';

const target: DurableTarget = { hostName, systemKey };

describe.skipIf(!configured)('live harness', () => {
  let instances: Awaited<ReturnType<typeof listInstances>>;

  beforeAll(async () => {
    // Poll until the fast-failing scenario has actually reached Failed, so a
    // freshly-seeded harness does not race the snapshot. The window is generous
    // (105s): on a cold consumption-plan app the first orchestration pays the
    // cold-start cost, so "a couple of seconds after start" can be well over a
    // minute — observed live, where a 30s window snapshotted it still Running.
    for (let i = 0; i < 70; i++) {
      instances = await listInstances(target, { top: 50 });
      if (
        instances.ok &&
        instances.value.instances.some(
          (x) => x.name === 'FailOnActivity' && x.runtimeStatus === 'Failed'
        )
      ) {
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }, 120_000);

  /*
   * Find a seeded instance by scenario name, optionally pinned to a status.
   * The status filter matters for FailOnActivity: the rewind/restart tests seed
   * their own FailOnActivity instances, so more than one can coexist and a plain
   * name match could return a still-running one instead of the seeded failure.
   */
  function instanceNamed(name: string, status?: string): string {
    if (!instances.ok) throw new Error('listInstances failed');
    const found = instances.value.instances.find(
      (i) => i.name === name && (status === undefined || i.runtimeStatus === status)
    );
    if (found === undefined) {
      throw new Error(`No ${status ?? ''} ${name} instance; start the harness scenarios`);
    }
    return found.instanceId;
  }

  it('lists instances from the real task hub', () => {
    expect(instances.ok).toBe(true);
    if (!instances.ok) return;
    expect(instances.value.instances.length).toBeGreaterThan(0);
    // Every row must carry the fields the triage view groups by.
    for (const i of instances.value.instances) {
      expect(i.instanceId).not.toBe('');
      expect(i.name).not.toBe('');
      expect(i.runtimeStatus).not.toBe('');
    }
  });

  it('groups the real fleet by orchestrator and status', () => {
    if (!instances.ok) return;
    const rows = buildTriage(instances.value.instances);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.name === 'FailOnActivity')).toBe(true);
  });

  it('derives an inline error signature from the list payload alone', () => {
    if (!instances.ok) return;
    const failed = instances.value.instances.find(
      (i) => i.name === 'FailOnActivity' && i.runtimeStatus === 'Failed'
    );
    expect(failed).toBeDefined();
    // The list row already carries the reason in `output` — no per-instance call.
    expect(instanceErrorSignature(failed!)).toContain('Simulated activity failure');
  });

  it('groups real failures by signature for the Problems strip', () => {
    if (!instances.ok) return;
    const groups = groupFailuresBySignature(instances.value.instances);
    expect(groups.length).toBeGreaterThan(0);
    // Every group must have a real, non-empty signature and a positive count.
    for (const group of groups) {
      expect(group.signature).not.toBe('');
      expect(group.count).toBeGreaterThan(0);
    }
    // The harness starts several FailOnActivity/-AfterRetries instances that all
    // fail with the same simulated message, so at least one group aggregates.
    expect(groups.some((g) => g.signature.includes('Simulated activity failure'))).toBe(true);
  });

  it('counts the harness failures the way the favourites scan does', async () => {
    const scan = await countFailedInstances(target);
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    // The harness seeds FailOnActivity, FailAfterRetries and SubOrchestrationFail,
    // so at least a few failures are present after seeding.
    expect(scan.value.count).toBeGreaterThan(0);
  });

  it('reports FailOnActivity as Failed with a readable reason', async () => {
    const detail = await getInstance(target, instanceNamed('FailOnActivity', 'Failed'));

    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.value.runtimeStatus).toBe('Failed');

    const index = firstFailureIndex(detail.value.historyEvents);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(detail.value.historyEvents[index]?.reason).toContain('Simulated activity failure');
  });

  /*
   * The regression this whole layer earns its keep on: the runtime names the
   * scheduled activity in "Name", not "FunctionName". If the parser regresses,
   * the timeline goes anonymous and the stuck hint names an event type.
   */
  it('names the scheduled activity on a real TaskScheduled event', async () => {
    const detail = await getInstance(target, instanceNamed('StuckAtScheduling'));

    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    const last = detail.value.historyEvents.at(-1);
    expect(last?.eventType).toBe('TaskScheduled');
    expect(last?.functionName).toBe('NeverRuns');
  });

  it('preserves the complete raw event for every history entry', async () => {
    const detail = await getInstance(target, instanceNamed('FailOnActivity', 'Failed'));
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    for (const event of detail.value.historyEvents) {
      // Nothing is dropped: each event carries its full raw object with a type.
      expect(Object.keys(event.raw).length).toBeGreaterThan(0);
      expect(event.raw['EventType'] ?? event.raw['eventType']).toBeTruthy();
    }
  });

  it('flags StuckAtScheduling as possibly stuck once the gap is long enough', async () => {
    const detail = await getInstance(target, instanceNamed('StuckAtScheduling'));

    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.value.runtimeStatus).toBe('Running');

    // The instance may be minutes old; evaluate as of an hour from now.
    const later = Date.now() + 60 * 60 * 1000;
    const hint = detectStuck(detail.value.historyEvents, detail.value.runtimeStatus, later);
    expect(hint.stuck).toBe(true);
    expect(hint.detail).toContain('NeverRuns');
  });

  it('does not flag a healthy running instance as stuck', async () => {
    const detail = await getInstance(target, instanceNamed('LongRunningHappy'));

    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    const hint = detectStuck(detail.value.historyEvents, detail.value.runtimeStatus, Date.now());
    expect(hint.stuck).toBe(false);
  });

  it('returns a not-found error for an unknown instance', async () => {
    const detail = await getInstance(target, 'does-not-exist-0000');

    expect(detail.ok).toBe(false);
    if (detail.ok) return;
    expect(detail.error).toMatchObject({ kind: 'http', status: 404 });
  });
});

/**
 * Actions that actually transition real instances — the proof M3 works end to
 * end, not just that the right HTTP verb is sent. These mutate the harness, so
 * they run serially and poll for the state change the runtime applies async.
 */
async function waitForStatus(
  target: DurableTarget,
  instanceId: string,
  want: string,
  attempts = 20
): Promise<string> {
  let last = '';
  for (let i = 0; i < attempts; i++) {
    const detail = await getInstance(target, instanceId);
    if (detail.ok) {
      last = detail.value.runtimeStatus;
      if (last === want) return last;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

/**
 * Start a fresh scenario instance via the webhook start route, using the same
 * system key. Lets each action test seed its own instance so the suite is
 * idempotent and re-runnable, rather than depending on pre-seeded state that a
 * previous action test may already have consumed.
 */
async function startScenario(scenario: string): Promise<string> {
  const url = `https://${hostName}/runtime/webhooks/durabletask/orchestrators/${scenario}?code=${encodeURIComponent(systemKey)}`;
  const response = await fetch(url, { method: 'POST' });
  const body = (await response.json()) as { id: string };
  return body.id;
}

// Tests in a file run in order by default, and vitest.integration.config sets
// fileParallelism:false, so these mutating actions never race another suite.
describe.skipIf(!configured)('live harness — actions transition instances', () => {
  const UPN = 'integration@durableops.test';

  it('suspends and then resumes a running instance', async () => {
    const id = await startScenario('LongRunningHappy');
    expect(await waitForStatus(target, id, 'Running')).toBe('Running');

    const suspended = await suspendInstance(target, id, UPN, 'integration: pause it');
    expect(suspended.ok).toBe(true);
    expect(await waitForStatus(target, id, 'Suspended')).toBe('Suspended');

    const resumed = await resumeInstance(target, id, UPN, 'integration: resume it');
    expect(resumed.ok).toBe(true);
    expect(await waitForStatus(target, id, 'Running')).toBe('Running');

    // Clean up so re-runs stay tidy.
    await terminateInstance(target, id, UPN, 'integration: cleanup');
    await waitForStatus(target, id, 'Terminated');
    await purgeInstance(target, id);
  });

  it('raises an external event that a waiting orchestration consumes', async () => {
    const id = await startScenario('WaitForExternalEvent');
    expect(await waitForStatus(target, id, 'Running')).toBe('Running');

    const raised = await raiseEvent(target, id, 'Approval', { approved: true });
    expect(raised.ok).toBe(true);
    // The orchestrator completes once it receives the event.
    expect(await waitForStatus(target, id, 'Completed')).toBe('Completed');

    await purgeInstance(target, id);
  });

  it('terminates a running instance, then purges it', async () => {
    const id = await startScenario('EternalTimer');
    expect(await waitForStatus(target, id, 'Running')).toBe('Running');

    const terminated = await terminateInstance(target, id, UPN, 'integration: terminate it');
    expect(terminated.ok).toBe(true);
    expect(await waitForStatus(target, id, 'Terminated')).toBe('Terminated');

    const purged = await purgeInstance(target, id);
    expect(purged.ok).toBe(true);
    // After purge the instance is gone: getInstance now 404s.
    const gone = await getInstance(target, id);
    expect(gone.ok).toBe(false);
  });

  /*
   * Rewind and restart both act on a *failed* instance. FailOnActivity always
   * fails, so after either the instance re-runs and fails again — the assertion
   * is that the real runtime accepts the reactive call end to end. Both routes
   * carry runtime caveats (rewind is a deprecated, Azure-Storage-only feature;
   * restart is an undocumented route that 404s on older hosts), so a failure
   * here is a real signal about this harness, not a flaky test.
   */
  // A fresh FailOnActivity instance must cold-start and run its activity before
  // it reaches Failed; under queue contention that is well past the default 30s
  // window, so these waits get a generous ceiling (120s) and the tests override
  // the 60s config testTimeout to match.
  const FAIL_ATTEMPTS = 80;
  const FAIL_TIMEOUT = 200_000;

  // Rewind/restart re-run the instance, so it is live again afterwards. Force a
  // terminal state and purge, or it lingers as a Running FailOnActivity that a
  // later run's snapshot could pick up ahead of the seeded failure.
  async function terminateAndPurge(id: string): Promise<void> {
    await terminateInstance(target, id, UPN, 'integration: cleanup');
    await waitForStatus(target, id, 'Terminated', 20);
    await purgeInstance(target, id);
  }

  it(
    'rewinds a failed instance',
    async () => {
      const id = await startScenario('FailOnActivity');
      expect(await waitForStatus(target, id, 'Failed', FAIL_ATTEMPTS)).toBe('Failed');

      const rewound = await rewindInstance(target, id, UPN, 'integration: rewind it');
      expect(rewound.ok).toBe(true);

      await terminateAndPurge(id);
    },
    FAIL_TIMEOUT
  );

  it(
    'restarts a failed instance from its original input',
    async () => {
      const id = await startScenario('FailOnActivity');
      expect(await waitForStatus(target, id, 'Failed', FAIL_ATTEMPTS)).toBe('Failed');

      const restarted = await restartInstance(target, id, false);
      expect(restarted.ok).toBe(true);

      await terminateAndPurge(id);
    },
    FAIL_TIMEOUT
  );
});
