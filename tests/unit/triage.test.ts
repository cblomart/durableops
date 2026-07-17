import { describe, it, expect } from 'vitest';
import {
  buildTriage,
  distinctOrchestrators,
  firstFailureIndex,
  failureIndicesWithContext,
  detectStuck,
  formatDuration,
  gapBefore,
  isFailureEvent,
  failureIndices,
  parseDurableError,
  instanceErrorSignature,
  groupFailuresBySignature,
  relativeTime,
  STUCK_THRESHOLD_MS,
} from '../../src/triage';
import type { HistoryEvent, OrchestrationInstance } from '../../src/api/durable';

function instance(
  name: string,
  runtimeStatus: string,
  output: unknown = null
): OrchestrationInstance {
  return {
    instanceId: `${name}-${runtimeStatus}-${String(Math.random())}`,
    name,
    runtimeStatus,
    createdTime: '2026-06-04T10:00:00Z',
    lastUpdatedTime: '2026-06-04T10:05:00Z',
    input: null,
    output,
    customStatus: null,
  };
}

function event(eventType: string, timestamp: string, functionName?: string): HistoryEvent {
  return {
    eventType,
    timestamp,
    functionName,
    scheduledTime: undefined,
    input: null,
    result: null,
    reason: undefined,
    details: undefined,
    orchestrationStatus: undefined,
    raw: { EventType: eventType, Timestamp: timestamp },
  };
}

const NOW = Date.parse('2026-06-04T12:00:00Z');

describe('buildTriage', () => {
  it('groups by orchestrator name and runtime status', () => {
    const rows = buildTriage([
      instance('OrderSaga', 'Failed'),
      instance('OrderSaga', 'Failed'),
      instance('OrderSaga', 'Running'),
      instance('Shipping', 'Running'),
    ]);

    expect(rows).toHaveLength(2);
    const orderSaga = rows.find((r) => r.name === 'OrderSaga');
    expect(orderSaga?.total).toBe(3);
    expect(orderSaga?.counts.get('Failed')).toBe(2);
    expect(orderSaga?.counts.get('Running')).toBe(1);
  });

  /*
   * The ops landing view must lead with what is broken. An orchestrator with
   * failures outranks a busier one with none, however many instances it has.
   */
  it('ranks orchestrators with failures above higher-volume healthy ones', () => {
    const rows = buildTriage([
      ...Array.from({ length: 10 }, () => instance('BusyHealthy', 'Running')),
      instance('RareBroken', 'Failed'),
    ]);

    expect(rows[0]?.name).toBe('RareBroken');
  });

  it('counts Terminated as needing attention, like Failed', () => {
    const rows = buildTriage([
      ...Array.from({ length: 5 }, () => instance('Healthy', 'Completed')),
      instance('Killed', 'Terminated'),
    ]);

    expect(rows[0]?.name).toBe('Killed');
  });

  it('breaks ties on volume, then name', () => {
    const rows = buildTriage([
      instance('Bbb', 'Running'),
      instance('Aaa', 'Running'),
      instance('Ccc', 'Running'),
      instance('Ccc', 'Running'),
    ]);

    expect(rows.map((r) => r.name)).toEqual(['Ccc', 'Aaa', 'Bbb']);
  });

  /* Hiding an unnamed instance would hide real work from triage. */
  it('surfaces unnamed orchestrators rather than dropping them', () => {
    const rows = buildTriage([instance('', 'Running')]);

    expect(rows[0]?.name).toBe('(unnamed)');
  });

  it('labels a missing status as Unknown', () => {
    const rows = buildTriage([instance('OrderSaga', '')]);

    expect(rows[0]?.counts.get('Unknown')).toBe(1);
  });

  it('returns nothing for no instances', () => {
    expect(buildTriage([])).toEqual([]);
  });
});

describe('distinctOrchestrators', () => {
  it('lists unique names alphabetically', () => {
    const names = distinctOrchestrators([
      instance('Zeta', 'Running'),
      instance('Alpha', 'Failed'),
      instance('Zeta', 'Completed'),
    ]);

    expect(names).toEqual(['Alpha', 'Zeta']);
  });

  it('ignores empty names', () => {
    expect(distinctOrchestrators([instance('', 'Running')])).toEqual([]);
  });
});

describe('firstFailureIndex', () => {
  it('finds the first failure event', () => {
    const events = [
      event('ExecutionStarted', '2026-06-04T10:00:00Z'),
      event('TaskCompleted', '2026-06-04T10:00:01Z'),
      event('TaskFailed', '2026-06-04T10:00:02Z'),
      event('TaskFailed', '2026-06-04T10:00:03Z'),
    ];

    expect(firstFailureIndex(events)).toBe(2);
  });

  it('recognises sub-orchestration failures', () => {
    expect(
      firstFailureIndex([event('SubOrchestrationInstanceFailed', '2026-06-04T10:00:00Z')])
    ).toBe(0);
  });

  it('returns -1 when nothing failed', () => {
    expect(firstFailureIndex([event('TaskCompleted', '2026-06-04T10:00:00Z')])).toBe(-1);
  });

  it('returns -1 for an empty history', () => {
    expect(firstFailureIndex([])).toBe(-1);
  });
});

describe('failureIndicesWithContext', () => {
  it('keeps one event either side of each failure', () => {
    const events = [
      event('ExecutionStarted', '2026-06-04T10:00:00Z'), // 0
      event('TaskScheduled', '2026-06-04T10:00:01Z'), // 1 <- context before
      event('TaskFailed', '2026-06-04T10:00:02Z'), // 2 <- failure
      event('TaskCompleted', '2026-06-04T10:00:03Z'), // 3 <- context after
      event('TaskCompleted', '2026-06-04T10:00:04Z'), // 4  dropped
    ];

    expect([...failureIndicesWithContext(events)].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('does not run off the start or end of the history', () => {
    const events = [event('TaskFailed', '2026-06-04T10:00:00Z')];

    expect([...failureIndicesWithContext(events)]).toEqual([0]);
  });

  it('merges overlapping context from adjacent failures', () => {
    const events = [
      event('TaskCompleted', '2026-06-04T10:00:00Z'),
      event('TaskFailed', '2026-06-04T10:00:01Z'),
      event('TaskFailed', '2026-06-04T10:00:02Z'),
      event('TaskCompleted', '2026-06-04T10:00:03Z'),
    ];

    expect([...failureIndicesWithContext(events)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('keeps nothing when there are no failures', () => {
    expect(failureIndicesWithContext([event('TaskCompleted', '2026-06-04T10:00:00Z')]).size).toBe(
      0
    );
  });
});

describe('detectStuck', () => {
  const longAgo = '2026-06-04T11:00:00Z'; // 1h before NOW
  const justNow = '2026-06-04T11:59:00Z'; // 1m before NOW

  it('flags a Running instance whose history ends on a long-unanswered TaskScheduled', () => {
    const hint = detectStuck(
      [event('ExecutionStarted', longAgo), event('TaskScheduled', longAgo, 'ChargeCard')],
      'Running',
      NOW
    );

    expect(hint.stuck).toBe(true);
    expect(hint.index).toBe(1);
    expect(hint.detail).toContain('ChargeCard');
  });

  it('flags a stuck timer', () => {
    expect(detectStuck([event('TimerCreated', longAgo)], 'Running', NOW).stuck).toBe(true);
  });

  it('flags a stuck sub-orchestration', () => {
    expect(
      detectStuck([event('SubOrchestrationInstanceCreated', longAgo)], 'Running', NOW).stuck
    ).toBe(true);
  });

  it('does not flag a scheduled task that is still young', () => {
    expect(detectStuck([event('TaskScheduled', justNow)], 'Running', NOW).stuck).toBe(false);
  });

  /* A completed history ending on TaskScheduled is just history, not a problem. */
  it('does not flag an instance that is not live', () => {
    expect(detectStuck([event('TaskScheduled', longAgo)], 'Completed', NOW).stuck).toBe(false);
    expect(detectStuck([event('TaskScheduled', longAgo)], 'Failed', NOW).stuck).toBe(false);
  });

  it('does not flag when the last event is a completion', () => {
    expect(
      detectStuck(
        [event('TaskScheduled', longAgo), event('TaskCompleted', longAgo)],
        'Running',
        NOW
      ).stuck
    ).toBe(false);
  });

  it('flags a Pending instance that never started', () => {
    expect(detectStuck([event('TaskScheduled', longAgo)], 'Pending', NOW).stuck).toBe(true);
  });

  it('handles an empty history', () => {
    expect(detectStuck([], 'Running', NOW).stuck).toBe(false);
  });

  it('does not flag on an unparseable timestamp rather than guessing', () => {
    expect(detectStuck([event('TaskScheduled', 'not-a-date')], 'Running', NOW).stuck).toBe(false);
  });

  it('uses a 15 minute threshold', () => {
    expect(STUCK_THRESHOLD_MS).toBe(15 * 60 * 1000);

    const justUnder = new Date(NOW - STUCK_THRESHOLD_MS + 1000).toISOString();
    const justOver = new Date(NOW - STUCK_THRESHOLD_MS - 1000).toISOString();
    expect(detectStuck([event('TaskScheduled', justUnder)], 'Running', NOW).stuck).toBe(false);
    expect(detectStuck([event('TaskScheduled', justOver)], 'Running', NOW).stuck).toBe(true);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0ms'],
    [250, '250ms'],
    [1500, '1.5s'],
    [45_000, '45.0s'],
    [65_000, '1m 05s'],
    [3_600_000, '1h 00m'],
    [8_100_000, '2h 15m'],
    [-5, '0s'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('gapBefore', () => {
  it('reports the elapsed time since the previous event', () => {
    const events = [
      event('ExecutionStarted', '2026-06-04T10:00:00Z'),
      event('TaskCompleted', '2026-06-04T10:00:02Z'),
    ];

    expect(gapBefore(events, 1)).toBe('2.0s');
  });

  it('reports nothing for the first event', () => {
    expect(gapBefore([event('ExecutionStarted', '2026-06-04T10:00:00Z')], 0)).toBe('');
  });

  it('reports nothing when a timestamp is unparseable', () => {
    const events = [
      event('ExecutionStarted', 'bad'),
      event('TaskCompleted', '2026-06-04T10:00:02Z'),
    ];

    expect(gapBefore(events, 1)).toBe('');
  });

  it('reports nothing for an out-of-range index', () => {
    expect(gapBefore([], 5)).toBe('');
  });
});

describe('isFailureEvent', () => {
  it('identifies failures and non-failures', () => {
    expect(isFailureEvent(event('TaskFailed', '2026-06-04T10:00:00Z'))).toBe(true);
    expect(isFailureEvent(event('TaskCompleted', '2026-06-04T10:00:00Z'))).toBe(false);
  });
});

describe('failureIndices', () => {
  it('lists every failure position for prev/next navigation', () => {
    const events = [
      event('ExecutionStarted', '2026-06-04T10:00:00Z'),
      event('TaskFailed', '2026-06-04T10:00:01Z'),
      event('TaskScheduled', '2026-06-04T10:00:02Z'),
      event('TaskFailed', '2026-06-04T10:00:03Z'),
    ];
    expect(failureIndices(events)).toEqual([1, 3]);
  });

  it('is empty for a clean history', () => {
    expect(failureIndices([event('TaskCompleted', '2026-06-04T10:00:00Z')])).toEqual([]);
  });
});

describe('parseDurableError', () => {
  /* Captured verbatim from the deployed harness — not invented. */
  const REAL_OUTPUT =
    "Orchestrator function 'FailOnActivity' failed: Activity function 'AlwaysFails' failed:  " +
    'Simulated activity failure: first-try \n {"$type":"System.Exception, System.Private.CoreLib",' +
    '"Message":" Simulated activity failure: first-try"}';

  it('extracts the innermost human message as the headline', () => {
    const parsed = parseDurableError(REAL_OUTPUT);
    expect(parsed.headline).toBe('Simulated activity failure: first-try');
  });

  it('names the function that actually threw (the last in the chain)', () => {
    expect(parseDurableError(REAL_OUTPUT).failedFunction).toBe('AlwaysFails');
  });

  it('sets the JSON exception blob aside as stack', () => {
    const parsed = parseDurableError(REAL_OUTPUT);
    expect(parsed.stack).toContain('System.Exception');
    expect(parsed.headline).not.toContain('System.Exception');
  });

  it('handles a nested sub-orchestration failure, keeping the deepest cause', () => {
    const nested =
      "Orchestrator function 'SubOrchestrationFail' failed: Orchestrator function " +
      "'FailOnActivity' failed: Activity function 'AlwaysFails' failed:  boom \n {\"x\":1}";
    const parsed = parseDurableError(nested);
    expect(parsed.headline).toBe('boom');
    expect(parsed.failedFunction).toBe('AlwaysFails');
  });

  it('handles a bare TaskFailed reason with no stack', () => {
    const parsed = parseDurableError("Activity function 'ChargeCard' failed:  Card declined");
    expect(parsed.headline).toBe('Card declined');
    expect(parsed.failedFunction).toBe('ChargeCard');
    expect(parsed.stack).toBe('');
  });

  it('treats a terminate reason (no "failed:") as its own headline', () => {
    const parsed = parseDurableError('DurableOps/ops@contoso.com: stuck, killing it');
    expect(parsed.headline).toBe('DurableOps/ops@contoso.com: stuck, killing it');
    expect(parsed.failedFunction).toBeUndefined();
  });

  it('is empty for null or empty input', () => {
    expect(parseDurableError(null).headline).toBe('');
    expect(parseDurableError('').headline).toBe('');
  });

  it('stringifies a non-string output rather than crashing', () => {
    expect(parseDurableError({ some: 'object' }).headline).toContain('some');
  });
});

describe('instanceErrorSignature', () => {
  const failOutput =
    "Orchestrator function 'OrderSaga' failed: Activity function 'ChargeCard' failed:  Card declined \n {}";

  it('returns the parsed headline for a failed instance', () => {
    expect(instanceErrorSignature(instance('OrderSaga', 'Failed', failOutput))).toBe(
      'Card declined'
    );
  });

  it('returns empty for a non-problem instance, even with output', () => {
    expect(instanceErrorSignature(instance('OrderSaga', 'Running', failOutput))).toBe('');
    expect(instanceErrorSignature(instance('OrderSaga', 'Completed', '"done"'))).toBe('');
  });

  it('labels a failed instance with no message', () => {
    expect(instanceErrorSignature(instance('OrderSaga', 'Failed', null))).toBe('(no message)');
  });
});

describe('groupFailuresBySignature', () => {
  const declined =
    "Orchestrator function 'OrderSaga' failed: Activity function 'ChargeCard' failed:  Card declined \n {}";
  const timeout =
    "Orchestrator function 'OrderSaga' failed: Activity function 'CallBank' failed:  Timed out \n {}";

  /* The systemic-vs-scattered signal: many instances, one error = one bug. */
  it('collapses many instances sharing one error into a single group', () => {
    const groups = groupFailuresBySignature([
      instance('OrderSaga', 'Failed', declined),
      instance('OrderSaga', 'Failed', declined),
      instance('OrderSaga', 'Failed', declined),
    ]);
    expect(groups).toEqual([{ signature: 'Card declined', count: 3 }]);
  });

  it('separates distinct errors and orders by count', () => {
    const groups = groupFailuresBySignature([
      instance('OrderSaga', 'Failed', declined),
      instance('OrderSaga', 'Failed', timeout),
      instance('OrderSaga', 'Failed', timeout),
    ]);
    expect(groups).toEqual([
      { signature: 'Timed out', count: 2 },
      { signature: 'Card declined', count: 1 },
    ]);
  });

  it('ignores healthy instances', () => {
    expect(
      groupFailuresBySignature([
        instance('OrderSaga', 'Running'),
        instance('OrderSaga', 'Completed', '"ok"'),
      ])
    ).toEqual([]);
  });

  it('counts terminated instances too', () => {
    const groups = groupFailuresBySignature([
      instance('OrderSaga', 'Terminated', 'DurableOps/ops: killed'),
    ]);
    expect(groups).toEqual([{ signature: 'DurableOps/ops: killed', count: 1 }]);
  });
});

describe('relativeTime', () => {
  const NOW2 = Date.parse('2026-06-04T12:00:00Z');

  it.each([
    [0, 'just now'],
    [10_000, '10s ago'],
    [90_000, '2m ago'],
    [3_600_000, '1h ago'],
    [7_200_000, '2h ago'],
    [90_000_000, '1d ago'],
  ])('formats an age of %ims as %s', (ageMs, expected) => {
    const ts = new Date(NOW2 - ageMs).toISOString();
    expect(relativeTime(ts, NOW2)).toBe(expected);
  });

  it('treats a future timestamp as just now rather than negative', () => {
    const ts = new Date(NOW2 + 5000).toISOString();
    expect(relativeTime(ts, NOW2)).toBe('just now');
  });

  it('returns empty for an unparseable timestamp', () => {
    expect(relativeTime('not-a-date', NOW2)).toBe('');
  });
});
