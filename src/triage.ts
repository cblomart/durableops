/**
 * Triage logic: the "what's broken, where" computations behind the ops views.
 *
 * Kept as pure functions, separate from components, for two reasons: it is the
 * logic most likely to be wrong in a way that misleads an operator during an
 * incident, and pure functions can be tested exhaustively without a DOM.
 */
import { FAILURE_EVENT_TYPES, type HistoryEvent, type OrchestrationInstance } from './api/durable';

/** Every status the runtime reports, in the order operators scan for trouble. */
export const ALL_STATUSES = [
  'Failed',
  'Running',
  'Pending',
  'Suspended',
  'Terminated',
  'Completed',
  'Canceled',
  'ContinuedAsNew',
] as const;

/** Statuses that mean "needs a human". Drives default emphasis in the triage header. */
export const ATTENTION_STATUSES: ReadonlySet<string> = new Set(['Failed', 'Terminated']);

export interface TriageRow {
  /** Orchestrator function name. */
  name: string;
  total: number;
  /** Status -> count, only for statuses actually present. */
  counts: Map<string, number>;
}

/**
 * Group fetched instances by orchestrator name × runtime status.
 *
 * This is computed over the pages already fetched, not over the whole task hub:
 * the webhook API offers no aggregate endpoint, so the header describes what the
 * current filter has loaded. Callers should say so in the UI rather than imply a
 * hub-wide count.
 */
export function buildTriage(instances: readonly OrchestrationInstance[]): TriageRow[] {
  const rows = new Map<string, TriageRow>();

  for (const instance of instances) {
    // An instance with no name still needs to appear; hiding it would hide work.
    const name = instance.name === '' ? '(unnamed)' : instance.name;
    const status = instance.runtimeStatus === '' ? 'Unknown' : instance.runtimeStatus;

    let row = rows.get(name);
    if (row === undefined) {
      row = { name, total: 0, counts: new Map<string, number>() };
      rows.set(name, row);
    }
    row.total += 1;
    row.counts.set(status, (row.counts.get(status) ?? 0) + 1);
  }

  // Orchestrators with failures first, then by volume: the ops landing view
  // should lead with what is broken, not with what is alphabetically first.
  return [...rows.values()].sort((a, b) => {
    const aBad = countAttention(a);
    const bBad = countAttention(b);
    if (aBad !== bBad) return bBad - aBad;
    if (a.total !== b.total) return b.total - a.total;
    return a.name.localeCompare(b.name);
  });
}

function countAttention(row: TriageRow): number {
  let total = 0;
  for (const [status, count] of row.counts) {
    if (ATTENTION_STATUSES.has(status)) total += count;
  }
  return total;
}

/** Distinct orchestrator names across fetched pages, for the client-side name filter. */
export function distinctOrchestrators(instances: readonly OrchestrationInstance[]): string[] {
  const names = new Set<string>();
  for (const instance of instances) {
    if (instance.name !== '') names.add(instance.name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Index of the first failure event, or -1. Drives "Go to first failure". */
export function firstFailureIndex(events: readonly HistoryEvent[]): number {
  return events.findIndex((event) => FAILURE_EVENT_TYPES.has(event.eventType));
}

/**
 * Indices to keep when "failures only" is on: each failure plus one event of
 * context either side, so the operator can see what was scheduled just before it
 * blew up without scrolling the whole history.
 */
export function failureIndicesWithContext(events: readonly HistoryEvent[]): Set<number> {
  const keep = new Set<number>();
  events.forEach((event, index) => {
    if (!FAILURE_EVENT_TYPES.has(event.eventType)) return;
    if (index > 0) keep.add(index - 1);
    keep.add(index);
    if (index < events.length - 1) keep.add(index + 1);
  });
  return keep;
}

/**
 * Event types that schedule work and expect a later completion. A history that
 * ends on one of these has, by definition, not been answered yet.
 */
const AWAITING_EVENT_TYPES: ReadonlySet<string> = new Set([
  'TaskScheduled',
  'TimerCreated',
  'SubOrchestrationInstanceCreated',
]);

/** Statuses where being stuck is meaningful. A Completed instance is not stuck. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['Running', 'Pending']);

/** How long a scheduled-but-unanswered tail has to sit before we flag it. */
export const STUCK_THRESHOLD_MS = 15 * 60 * 1000;

export interface StuckHint {
  stuck: boolean;
  /** Index of the event it is stuck on, or -1. Used to jump-link the timeline. */
  index: number;
  /** Human explanation, already phrased for display. */
  detail: string;
}

const NOT_STUCK: StuckHint = { stuck: false, index: -1, detail: '' };

function ageMs(timestamp: string, now: number): number | null {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? null : now - parsed;
}

/**
 * "Possibly stuck at scheduling" heuristic.
 *
 * If a live instance's history ends on a TaskScheduled / timer / sub-orchestration
 * with no completion after it, and that tail has been sitting for a long time,
 * the work was scheduled and never came back — the classic silent failure that a
 * status of "Running" hides.
 *
 * Deliberately a *hint*, never a verdict: a legitimately long activity or a timer
 * with a distant due date looks identical from the history alone. The UI must
 * say "possibly".
 */
export function detectStuck(
  events: readonly HistoryEvent[],
  runtimeStatus: string,
  now: number = Date.now()
): StuckHint {
  if (!LIVE_STATUSES.has(runtimeStatus)) return NOT_STUCK;
  if (events.length === 0) return NOT_STUCK;

  const index = events.length - 1;
  const last = events[index];
  if (last === undefined || !AWAITING_EVENT_TYPES.has(last.eventType)) return NOT_STUCK;

  const age = ageMs(last.timestamp, now);
  if (age === null || age < STUCK_THRESHOLD_MS) return NOT_STUCK;

  const target = last.functionName ?? last.eventType;
  return {
    stuck: true,
    index,
    detail: `${target} was scheduled ${formatDuration(age)} ago and has not completed`,
  };
}

/** Compact duration for dense timeline rows: 1.2s, 3m 04s, 2h 15m. */
export function formatDuration(ms: number): string {
  if (ms < 0) return '0s';
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    return `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`;
  }
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${String(hours)}h ${String(minutes).padStart(2, '0')}m`;
}

/**
 * Coarse "how long ago" for a timestamp, e.g. "3m ago", "2h ago", "4d ago".
 *
 * At 2 AM an operator anchors on *when* something started far faster from a
 * relative age than from an ISO timestamp. The absolute time stays available on
 * hover for correlating with a deploy.
 */
export function relativeTime(timestamp: string, now: number = Date.now()): string {
  const then = Date.parse(timestamp);
  if (Number.isNaN(then)) return '';

  const seconds = Math.round((now - then) / 1000);
  if (seconds < 1) return 'just now';
  if (seconds < 45) return `${String(seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
}

/** Gap between an event and the one before it, for the timeline's duration column. */
export function gapBefore(events: readonly HistoryEvent[], index: number): string {
  if (index <= 0) return '';
  const current = events[index];
  const previous = events[index - 1];
  if (current === undefined || previous === undefined) return '';

  const a = Date.parse(previous.timestamp);
  const b = Date.parse(current.timestamp);
  if (Number.isNaN(a) || Number.isNaN(b)) return '';
  return formatDuration(b - a);
}

export function isFailureEvent(event: HistoryEvent): boolean {
  return FAILURE_EVENT_TYPES.has(event.eventType);
}

/** Indices of every failure event, for prev/next navigation while investigating. */
export function failureIndices(events: readonly HistoryEvent[]): number[] {
  const indices: number[] = [];
  events.forEach((event, index) => {
    if (isFailureEvent(event)) indices.push(index);
  });
  return indices;
}

/**
 * The one-line error signature of an instance, or '' if it is not in a problem
 * state. Used to answer the 2 AM question "one bug, or many?" — several failed
 * instances sharing a signature is a systemic fault; several distinct
 * signatures is a scatter of unrelated ones.
 */
export function instanceErrorSignature(instance: OrchestrationInstance): string {
  if (!ATTENTION_STATUSES.has(instance.runtimeStatus)) return '';
  return parseDurableError(instance.output).headline || '(no message)';
}

export interface ErrorGroup {
  signature: string;
  count: number;
}

/**
 * Group failed/terminated instances by error signature, most common first.
 *
 * This is the root-cause-vs-poison-message signal: "12 instances · 1 error" is a
 * bad deploy; "12 instances · 11 errors" is noise from many unrelated causes.
 */
export function groupFailuresBySignature(
  instances: readonly OrchestrationInstance[]
): ErrorGroup[] {
  const counts = new Map<string, number>();
  for (const instance of instances) {
    const signature = instanceErrorSignature(instance);
    if (signature === '') continue;
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([signature, count]) => ({ signature, count }))
    .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
}

export interface ParsedFailure {
  /** The innermost human message, e.g. "Simulated activity failure: first-try". */
  headline: string;
  /** The function that actually threw, if the text names one. */
  failedFunction: string | undefined;
  /** The machine detail (stack / serialised exception), collapsed by default in the UI. */
  stack: string;
}

/**
 * Untangle a Durable Functions failure string into something an operator can read
 * at 2 AM.
 *
 * The runtime nests failures as a colon-chained sentence with a JSON exception
 * blob appended, captured verbatim from the harness:
 *   "Orchestrator function 'FailOnActivity' failed: Activity function
 *    'AlwaysFails' failed:  Simulated activity failure: first-try \n {…stack…}"
 *
 * We surface the *last* link of the chain (the real cause), name the function
 * that threw, and set the stack aside — nobody woken by a page wants to read a
 * serialised System.Exception first.
 */
export function parseDurableError(raw: unknown): ParsedFailure {
  const text = (typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw)).trim();
  if (text === '') return { headline: '', failedFunction: undefined, stack: '' };

  // The machine detail starts at the first newline that introduces a JSON blob.
  const stackStart = text.search(/\s*\n\s*[[{]/);
  const chain = (stackStart >= 0 ? text.slice(0, stackStart) : text).trim();
  const stack = stackStart >= 0 ? text.slice(stackStart).trim() : '';

  // Last-named function in the chain is the one that actually threw.
  const named = [...chain.matchAll(/(?:Activity|Orchestrator) function '([^']+)' failed/g)];
  const failedFunction = named.at(-1)?.[1];

  // Everything after the final "failed:" is the human message.
  const segments = chain.split(/failed:\s*/);
  const headline = (segments.length > 1 ? (segments.at(-1) ?? '') : chain).trim() || chain;

  return { headline, failedFunction, stack };
}
