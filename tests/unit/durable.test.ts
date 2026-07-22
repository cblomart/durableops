import { describe, it, expect, vi } from 'vitest';
import {
  listInstances,
  getInstance,
  terminateInstance,
  rewindInstance,
  suspendInstance,
  resumeInstance,
  restartInstance,
  raiseEvent,
  purgeInstance,
  buildAuditReason,
  countFailedInstances,
  availableActions,
  ACTION_META,
  MIN_REASON_LENGTH,
  FAILURE_EVENT_TYPES,
  type DurableTarget,
} from '../../src/api/durable';
import { WEB_API_VERSION } from '../../src/config';

const RESOURCE_ID = '/subscriptions/sub-1/resourceGroups/rg-a/providers/Microsoft.Web/sites/func-a';
const TARGET: DurableTarget = { resourceId: RESOURCE_ID };
const TOKEN = 'arm-token-xyz';

/** Everything the proxy serves lives under this path suffix, whatever the host. */
const WEBHOOK_PATH = `${RESOURCE_ID}/hostruntime/runtime/webhooks/durabletask`;

const UPN = 'ops@contoso.com';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function mockFetch(response: Response) {
  return vi.fn().mockResolvedValue(response);
}

/** Instance rows come back camelCase, mirroring a real query response. */
function instanceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instanceId: 'abc123',
    name: 'OrderSaga',
    runtimeStatus: 'Running',
    createdTime: '2026-06-04T10:46:39Z',
    lastUpdatedTime: '2026-06-04T10:46:47Z',
    input: null,
    output: null,
    customStatus: null,
    ...overrides,
  };
}

function urlOf(fetchMock: ReturnType<typeof mockFetch>, call = 0): URL {
  return new URL((fetchMock.mock.calls[call] as [string])[0]);
}

describe('listInstances', () => {
  it('returns typed instances via the ARM hostruntime proxy with a bearer token', async () => {
    const fetchMock = mockFetch(jsonResponse([instanceRow()]));

    const result = await listInstances(TARGET, TOKEN, {}, fetchMock);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instances[0]).toMatchObject({
      instanceId: 'abc123',
      name: 'OrderSaga',
      runtimeStatus: 'Running',
    });

    const url = urlOf(fetchMock);
    // The call goes through ARM, not the app's own hostname — that is what
    // eliminates per-app CORS and the system key.
    expect(url.origin).toBe('https://management.azure.com');
    expect(url.pathname).toBe(`${WEBHOOK_PATH}/instances`);
    expect(url.searchParams.get('api-version')).toBe(WEB_API_VERSION);
    expect(url.searchParams.has('code')).toBe(false);

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('sends every server-side filter the API actually supports', async () => {
    const fetchMock = mockFetch(jsonResponse([]));

    await listInstances(
      TARGET,
      TOKEN,
      {
        createdTimeFrom: new Date('2026-06-01T00:00:00Z'),
        createdTimeTo: new Date('2026-06-02T00:00:00Z'),
        runtimeStatus: ['Failed', 'Running'],
        instanceIdPrefix: 'order-',
        top: 50,
      },
      fetchMock
    );

    const params = urlOf(fetchMock).searchParams;
    expect(params.get('createdTimeFrom')).toBe('2026-06-01T00:00:00.000Z');
    expect(params.get('createdTimeTo')).toBe('2026-06-02T00:00:00.000Z');
    // Multi-status filtering is a comma-separated list, not repeated params.
    expect(params.get('runtimeStatus')).toBe('Failed,Running');
    expect(params.get('instanceIdPrefix')).toBe('order-');
    expect(params.get('top')).toBe('50');
  });

  it('omits filters that were not supplied', async () => {
    const fetchMock = mockFetch(jsonResponse([]));

    await listInstances(TARGET, TOKEN, {}, fetchMock);

    const params = urlOf(fetchMock).searchParams;
    expect(params.has('runtimeStatus')).toBe(false);
    expect(params.has('createdTimeFrom')).toBe(false);
    expect(params.has('top')).toBe(false);
  });

  it('omits runtimeStatus when an empty status list is passed', async () => {
    const fetchMock = mockFetch(jsonResponse([]));

    await listInstances(TARGET, TOKEN, { runtimeStatus: [] }, fetchMock);

    expect(urlOf(fetchMock).searchParams.has('runtimeStatus')).toBe(false);
  });

  it('surfaces the continuation token from the response header', async () => {
    const fetchMock = mockFetch(
      jsonResponse([instanceRow()], { headers: { 'x-ms-continuation-token': 'token-abc' } })
    );

    const result = await listInstances(TARGET, TOKEN, {}, fetchMock);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.continuationToken).toBe('token-abc');
  });

  it('sends a supplied continuation token back as a request header', async () => {
    const fetchMock = mockFetch(jsonResponse([]));

    await listInstances(TARGET, TOKEN, { continuationToken: 'token-abc' }, fetchMock);

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['x-ms-continuation-token']).toBe('token-abc');
  });

  it('reports no continuation token when the header is absent or empty', async () => {
    const fetchMock = mockFetch(jsonResponse([instanceRow()]));

    const result = await listInstances(TARGET, TOKEN, {}, fetchMock);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.continuationToken).toBeUndefined();
  });

  /*
   * 404 is overloaded on this API. On the collection route it means the Durable
   * Task extension is not installed — a normal fleet condition we badge rather
   * than an error to shout about.
   */
  it('maps 404 on the collection route to notDurable', async () => {
    const fetchMock = mockFetch(new Response('Not Found', { status: 404 }));

    const result = await listInstances(TARGET, TOKEN, {}, fetchMock);

    expect(result).toMatchObject({ ok: false, error: { kind: 'notDurable' } });
  });

  /*
   * ARM sends permissive CORS headers, so a browser fetch never fails the
   * cross-origin check the way a direct app-hostname call did. A throw here is a
   * genuine network failure, reported as a zero-status http error — there is no
   * longer any `cors` or `easyAuth` outcome to distinguish.
   */
  it('maps a fetch throw to a zero-status network error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await listInstances(TARGET, TOKEN, {}, fetchMock);

    expect(result).toMatchObject({ ok: false, error: { kind: 'http', status: 0 } });
  });

  it('maps a 401 to an auth error (the ARM token was rejected)', async () => {
    const fetchMock = mockFetch(new Response('', { status: 401 }));

    const result = await listInstances(TARGET, TOKEN, {}, fetchMock);

    expect(result).toMatchObject({ ok: false, error: { kind: 'auth' } });
  });

  it('maps 429 to an http error carrying Retry-After', async () => {
    const fetchMock = mockFetch(
      new Response('slow down', { status: 429, headers: { 'Retry-After': '17' } })
    );

    const result = await listInstances(TARGET, TOKEN, {}, fetchMock);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'http', status: 429, retryAfterSeconds: 17 },
    });
  });

  it('maps 403 to forbidden', async () => {
    const fetchMock = mockFetch(new Response('nope', { status: 403 }));

    const result = await listInstances(TARGET, TOKEN, {}, fetchMock);

    expect(result).toMatchObject({ ok: false, error: { kind: 'forbidden' } });
  });

  it('rejects invalid JSON instead of throwing', async () => {
    const fetchMock = mockFetch(new Response('{not json', { status: 200 }));

    const result = await listInstances(TARGET, TOKEN, {}, fetchMock);

    expect(result).toMatchObject({ ok: false, error: { kind: 'http' } });
  });

  it('rejects a payload that is not an array', async () => {
    const fetchMock = mockFetch(jsonResponse({ instances: [] }));

    const result = await listInstances(TARGET, TOKEN, {}, fetchMock);

    expect(result.ok).toBe(false);
  });

  it('skips malformed rows rather than failing the page', async () => {
    const fetchMock = mockFetch(jsonResponse([instanceRow(), null, {}, 'nonsense']));

    const result = await listInstances(TARGET, TOKEN, {}, fetchMock);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instances).toHaveLength(1);
  });
});

describe('getInstance', () => {
  it('requests history, history output and input', async () => {
    const fetchMock = mockFetch(jsonResponse({ ...instanceRow(), historyEvents: [] }));

    await getInstance(TARGET, TOKEN, 'abc123', fetchMock);

    const params = urlOf(fetchMock).searchParams;
    expect(params.get('showHistory')).toBe('true');
    expect(params.get('showHistoryOutput')).toBe('true');
    expect(params.get('showInput')).toBe('true');
  });

  /*
   * The API is not self-consistent: instance fields are camelCase but history
   * events come back PascalCase. Reading both casings is what stops the timeline
   * silently rendering blank rows.
   */
  it('parses PascalCase history events as the runtime actually returns them', async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        ...instanceRow(),
        historyEvents: [
          {
            EventType: 'TaskFailed',
            FunctionName: 'ChargeCard',
            Timestamp: '2026-06-04T10:46:41Z',
            ScheduledTime: '2026-06-04T10:46:40Z',
            Reason: 'Card declined',
            Details: 'System.Exception: declined',
          },
        ],
      })
    );

    const result = await getInstance(TARGET, TOKEN, 'abc123', fetchMock);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.historyEvents[0]).toMatchObject({
      eventType: 'TaskFailed',
      functionName: 'ChargeCard',
      reason: 'Card declined',
      details: 'System.Exception: declined',
    });
  });

  it('parses camelCase history events too', async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        ...instanceRow(),
        historyEvents: [{ eventType: 'ExecutionStarted', timestamp: '2026-06-04T10:46:39Z' }],
      })
    );

    const result = await getInstance(TARGET, TOKEN, 'abc123', fetchMock);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.historyEvents[0]?.eventType).toBe('ExecutionStarted');
  });

  it('keeps the complete raw event and the activity input, losing nothing', async () => {
    const rawEvent = {
      EventType: 'TaskScheduled',
      Name: 'ChargeCard',
      Input: '{"amount":42}',
      Version: '',
      Correlation: null,
      Timestamp: '2026-06-04T10:46:42Z',
    };
    const fetchMock = mockFetch(jsonResponse({ ...instanceRow(), historyEvents: [rawEvent] }));

    const result = await getInstance(TARGET, TOKEN, 'abc123', fetchMock);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const event = result.value.historyEvents[0];
    // Parsed convenience fields...
    expect(event?.functionName).toBe('ChargeCard');
    expect(event?.input).toBe('{"amount":42}');
    // ...but the whole event is preserved verbatim for investigation.
    expect(event?.raw).toEqual(rawEvent);
    expect(event?.raw['Correlation']).toBeNull();
  });

  it('treats a missing history as empty rather than failing', async () => {
    const fetchMock = mockFetch(jsonResponse(instanceRow()));

    const result = await getInstance(TARGET, TOKEN, 'abc123', fetchMock);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.historyEvents).toEqual([]);
  });

  it('accepts 202, which the runtime returns for an in-progress instance', async () => {
    const fetchMock = mockFetch(
      jsonResponse({ ...instanceRow(), runtimeStatus: 'Running' }, { status: 202 })
    );

    const result = await getInstance(TARGET, TOKEN, 'abc123', fetchMock);

    expect(result.ok).toBe(true);
  });

  /* On an instance route, 404 means "no such instance" — NOT "app isn't durable". */
  it('maps 404 on an instance route to a not-found http error, not notDurable', async () => {
    const fetchMock = mockFetch(new Response('', { status: 404 }));

    const result = await getInstance(TARGET, TOKEN, 'missing', fetchMock);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('http');
    expect(result.error).toMatchObject({ status: 404 });
  });

  it('url-encodes instance ids containing awkward characters', async () => {
    const fetchMock = mockFetch(jsonResponse(instanceRow()));

    await getInstance(TARGET, TOKEN, 'order/123 456', fetchMock);

    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('order%2F123%20456');
  });
});

describe('buildAuditReason', () => {
  /*
   * This format IS the audit trail: DurableOps stores nothing, so the target
   * app's telemetry is the only durable record of who did what and why.
   */
  it('prefixes the acting identity onto the operator reason', () => {
    expect(buildAuditReason(UPN, 'runaway retry loop')).toBe(
      'DurableOps/ops@contoso.com: runaway retry loop'
    );
  });

  it('exposes the minimum reason length the dialog enforces', () => {
    expect(MIN_REASON_LENGTH).toBe(10);
  });
});

describe('actions', () => {
  it('terminate posts to /terminate with the identity-prefixed reason', async () => {
    const fetchMock = mockFetch(new Response('', { status: 202 }));

    const result = await terminateInstance(
      TARGET,
      TOKEN,
      'abc123',
      UPN,
      'stuck forever',
      fetchMock
    );

    expect(result.ok).toBe(true);
    const url = urlOf(fetchMock);
    expect(url.pathname).toBe(`${WEBHOOK_PATH}/instances/abc123/terminate`);
    expect(url.searchParams.get('reason')).toBe('DurableOps/ops@contoso.com: stuck forever');
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(init.method).toBe('POST');
    // A body is required: the proxy answers 411 to a POST with no Content-Length.
    expect(init.body).toBe('');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    ['rewind', rewindInstance],
    ['suspend', suspendInstance],
    ['resume', resumeInstance],
  ])('%s posts to its route with an audited reason', async (operation, fn) => {
    const fetchMock = mockFetch(new Response('', { status: 202 }));

    const result = await fn(TARGET, TOKEN, 'abc123', UPN, 'operator reason', fetchMock);

    expect(result.ok).toBe(true);
    expect(urlOf(fetchMock).pathname).toBe(`${WEBHOOK_PATH}/instances/abc123/${operation}`);
    expect(urlOf(fetchMock).searchParams.get('reason')).toBe(
      'DurableOps/ops@contoso.com: operator reason'
    );
  });

  it('restart posts to /restart with restartWithNewInstanceId', async () => {
    const fetchMock = mockFetch(new Response('', { status: 202 }));

    const result = await restartInstance(TARGET, TOKEN, 'abc123', true, fetchMock);

    expect(result.ok).toBe(true);
    const url = urlOf(fetchMock);
    expect(url.pathname).toBe(`${WEBHOOK_PATH}/instances/abc123/restart`);
    expect(url.searchParams.get('restartWithNewInstanceId')).toBe('true');
  });

  it('raiseEvent posts a JSON body to the named event route', async () => {
    const fetchMock = mockFetch(new Response('', { status: 202 }));

    const result = await raiseEvent(
      TARGET,
      TOKEN,
      'abc123',
      'Approval',
      { approved: true },
      fetchMock
    );

    expect(result.ok).toBe(true);
    const url = urlOf(fetchMock);
    expect(url.pathname).toBe(`${WEBHOOK_PATH}/instances/abc123/raiseEvent/Approval`);
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"approved":true}');
  });

  it('raiseEvent url-encodes the event name', async () => {
    const fetchMock = mockFetch(new Response('', { status: 202 }));

    await raiseEvent(TARGET, TOKEN, 'abc123', 'my event/1', '"payload"', fetchMock);

    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('raiseEvent/my%20event%2F1');
  });

  it('purge DELETEs the instance route with no operation segment', async () => {
    const fetchMock = mockFetch(jsonResponse({ instancesDeleted: 1 }));

    const result = await purgeInstance(TARGET, TOKEN, 'abc123', fetchMock);

    expect(result.ok).toBe(true);
    expect(urlOf(fetchMock).pathname).toBe(`${WEBHOOK_PATH}/instances/abc123`);
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(init.method).toBe('DELETE');
    // Same 411 constraint as POST: DELETE must carry a Content-Length too.
    expect(init.body).toBe('');
  });

  it('surfaces 410 Gone (already completed) as an http error', async () => {
    const fetchMock = mockFetch(new Response('instance completed', { status: 410 }));

    const result = await terminateInstance(TARGET, TOKEN, 'abc123', UPN, 'too late now', fetchMock);

    expect(result).toMatchObject({ ok: false, error: { kind: 'http', status: 410 } });
  });
});

describe('FAILURE_EVENT_TYPES', () => {
  it('covers the event types the jump-to-error affordance looks for', () => {
    expect(FAILURE_EVENT_TYPES.has('TaskFailed')).toBe(true);
    expect(FAILURE_EVENT_TYPES.has('SubOrchestrationInstanceFailed')).toBe(true);
    expect(FAILURE_EVENT_TYPES.has('TaskCompleted')).toBe(false);
  });
});

/*
 * Shapes captured verbatim from a live task hub (the deployed harness), not from
 * the docs. The docs show only FunctionName; the runtime actually uses "Name" on
 * TaskScheduled, which left scheduled events anonymous until the harness proved
 * it. Keep these fixtures real.
 */
describe('history events, as the runtime really emits them', () => {
  const REAL_STUCK_HISTORY = [
    {
      EventType: 'ExecutionStarted',
      Input: '""',
      Generation: 0,
      Timestamp: '2026-07-17T13:58:54.9749053Z',
      FunctionName: 'StuckAtScheduling',
    },
    {
      EventType: 'TaskScheduled',
      // The runtime uses "Name" here, NOT "FunctionName".
      Name: 'NeverRuns',
      Input: null,
      Timestamp: '2026-07-17T13:58:58.4951624Z',
    },
  ];

  it('reads the activity name from "Name" on TaskScheduled', async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        ...instanceRow({ name: 'StuckAtScheduling' }),
        historyEvents: REAL_STUCK_HISTORY,
      })
    );

    const result = await getInstance(TARGET, TOKEN, 'abc123', fetchMock);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.historyEvents[0]?.functionName).toBe('StuckAtScheduling');
    // Would be undefined if we only read FunctionName.
    expect(result.value.historyEvents[1]?.functionName).toBe('NeverRuns');
  });

  it('parses a real TaskFailed, keeping the full reason and details', async () => {
    const realFailure = {
      EventType: 'TaskFailed',
      Reason: "Activity function 'AlwaysFails' failed:  Simulated activity failure: with-retries",
      Details: '{"$type":"System.Exception","Message":"Simulated activity failure"}',
      FailureDetails: null,
      Timestamp: '2026-07-17T13:58:58.8697174Z',
      ScheduledTime: '2026-07-17T13:58:58.4932392+00:00',
      FunctionName: 'AlwaysFails',
      Input: null,
    };
    const fetchMock = mockFetch(jsonResponse({ ...instanceRow(), historyEvents: [realFailure] }));

    const result = await getInstance(TARGET, TOKEN, 'abc123', fetchMock);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const event = result.value.historyEvents[0];
    expect(event).toMatchObject({
      eventType: 'TaskFailed',
      functionName: 'AlwaysFails',
      scheduledTime: '2026-07-17T13:58:58.4932392+00:00',
    });
    // The reason is why the operator is here: never truncate it.
    expect(event?.reason).toContain('Simulated activity failure: with-retries');
    expect(event?.details).toContain('System.Exception');
  });
});

describe('countFailedInstances', () => {
  it('counts failed and terminated instances in one page', async () => {
    const fetchMock = mockFetch(
      jsonResponse([
        instanceRow({ instanceId: 'a', runtimeStatus: 'Failed' }),
        instanceRow({ instanceId: 'b', runtimeStatus: 'Terminated' }),
      ])
    );

    const result = await countFailedInstances(TARGET, TOKEN, fetchMock);

    expect(result).toEqual({ ok: true, value: { count: 2, more: false } });
    // It must ask only for the attention statuses, cheaply.
    const params = urlOf(fetchMock).searchParams;
    expect(params.get('runtimeStatus')).toBe('Failed,Terminated');
    expect(params.get('top')).toBe('200');
  });

  it('flags "more" when the page is not the whole failed set', async () => {
    const fetchMock = mockFetch(
      jsonResponse([instanceRow({ runtimeStatus: 'Failed' })], {
        headers: { 'x-ms-continuation-token': 'next' },
      })
    );

    const result = await countFailedInstances(TARGET, TOKEN, fetchMock);

    expect(result).toMatchObject({ ok: true, value: { count: 1, more: true } });
  });

  it('returns zero for a healthy app', async () => {
    const fetchMock = mockFetch(jsonResponse([]));

    const result = await countFailedInstances(TARGET, TOKEN, fetchMock);

    expect(result).toEqual({ ok: true, value: { count: 0, more: false } });
  });

  it('propagates the error when the app cannot be queried', async () => {
    const fetchMock = mockFetch(new Response('nope', { status: 403 }));

    const result = await countFailedInstances(TARGET, TOKEN, fetchMock);

    expect(result).toMatchObject({ ok: false, error: { kind: 'forbidden' } });
  });
});

describe('availableActions', () => {
  it('offers recovery and purge for a Failed instance (not terminate — it is already dead)', () => {
    expect(availableActions('Failed')).toEqual(['rewind', 'restart', 'purge']);
  });

  it('offers signal, suspend and terminate for a Running instance — but not purge', () => {
    const actions = availableActions('Running');
    expect(actions).toContain('raiseEvent');
    expect(actions).toContain('suspend');
    expect(actions).toContain('terminate');
    expect(actions).not.toContain('purge');
    expect(actions).not.toContain('rewind');
  });

  it('offers resume (not suspend) for a Suspended instance', () => {
    const actions = availableActions('Suspended');
    expect(actions).toContain('resume');
    expect(actions).not.toContain('suspend');
    expect(actions).toContain('terminate');
  });

  it('offers only restart and purge for a Completed instance', () => {
    expect(availableActions('Completed')).toEqual(['restart', 'purge']);
  });

  it('never offers rewind outside Failed', () => {
    for (const status of ['Running', 'Pending', 'Completed', 'Terminated', 'Suspended']) {
      expect(availableActions(status)).not.toContain('rewind');
    }
  });

  it('returns nothing for an unknown status rather than guessing', () => {
    expect(availableActions('Nonsense')).toEqual([]);
  });
});

describe('ACTION_META', () => {
  it('marks exactly the reason-bearing webhook operations as forwarding a reason', () => {
    const forwards = Object.entries(ACTION_META)
      .filter(([, meta]) => meta.forwardsReason)
      .map(([action]) => action)
      .sort();
    // terminate/rewind/suspend/resume take a `reason` param; restart/raiseEvent/purge do not.
    expect(forwards).toEqual(['resume', 'rewind', 'suspend', 'terminate']);
  });

  it('reserves the danger tone for the one irreversible action', () => {
    // Red keeps its meaning: only purge (irreversible) is danger; terminate is a
    // recoverable-but-disruptive warn; recovery actions are neutral.
    expect(ACTION_META.purge.tone).toBe('danger');
    expect(ACTION_META.terminate.tone).toBe('warn');
    expect(ACTION_META.rewind.tone).toBe('normal');
    expect(ACTION_META.restart.tone).toBe('normal');
    expect(ACTION_META.resume.tone).toBe('normal');
  });
});
