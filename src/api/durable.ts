/**
 * The Durable Functions HTTP management API, served by the runtime on each
 * function app.
 *
 * Why this and not the storage data plane: this API is implemented by the
 * Durable Task extension itself, so it behaves identically whatever the backend
 * is (Azure Storage, MSSQL, Netherite, DTS) and never exposes us to the internal
 * table schema — which Microsoft explicitly warns against depending on.
 *
 * Auth is the app's `durabletask_extension` system key, passed as `?code=`.
 * The key is fetched on demand via ARM (see arm.ts) and lives in memory only.
 *
 * Routes verified against the current docs and the extension source during the
 * design spike:
 *   https://learn.microsoft.com/azure/durable-task/durable-functions/durable-functions-http-api
 */
import { err, ok, type ApiError, type Result } from './errors';

/** Values the runtime reports. `ContinuedAsNew` is transient and rarely seen in a query. */
export type RuntimeStatus =
  | 'Running'
  | 'Pending'
  | 'Failed'
  | 'Completed'
  | 'Terminated'
  | 'Suspended'
  | 'Canceled'
  | 'ContinuedAsNew';

export interface OrchestrationInstance {
  instanceId: string;
  /**
   * The orchestrator function name.
   *
   * This is what the triage view groups by. Note the webhook API has NO
   * server-side filter for it — `runtimeStatus`, `createdTime*` and
   * `instanceIdPrefix` are the only server-side filters — so filtering by
   * orchestrator name is necessarily done client-side over fetched pages.
   */
  name: string;
  runtimeStatus: string;
  createdTime: string;
  lastUpdatedTime: string;
  input: unknown;
  output: unknown;
  customStatus: unknown;
}

export interface HistoryEvent {
  eventType: string;
  timestamp: string;
  functionName: string | undefined;
  scheduledTime: string | undefined;
  result: unknown;
  /** Failure text, when the event is a failure. */
  reason: string | undefined;
  details: string | undefined;
  orchestrationStatus: string | undefined;
}

export interface InstanceDetail extends OrchestrationInstance {
  historyEvents: HistoryEvent[];
}

export interface InstancePage {
  instances: OrchestrationInstance[];
  /** Pass back to `listInstances` to fetch the next page; undefined when exhausted. */
  continuationToken: string | undefined;
}

export interface ListInstancesOptions {
  createdTimeFrom?: Date;
  createdTimeTo?: Date;
  runtimeStatus?: RuntimeStatus[];
  /**
   * Server-side prefix filter (extension >= 2.7.2). Older hosts ignore the
   * parameter rather than failing, in which case the caller sees unfiltered
   * results instead of an error.
   */
  instanceIdPrefix?: string;
  top?: number;
  continuationToken?: string;
}

/** Header name for paging. The runtime uses the same name on the request and the response. */
const CONTINUATION_HEADER = 'x-ms-continuation-token';

/** Event types that mean "something failed here". Used by the jump-to-error affordances. */
export const FAILURE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'TaskFailed',
  'SubOrchestrationInstanceFailed',
  'ExecutionFailed',
  'OrchestratorFailed',
]);

export interface DurableTarget {
  /** The app's real hostname from ARM, e.g. `func-a.azurewebsites.net`. */
  hostName: string;
  /** The durabletask_extension system key. Memory-only; never logged or persisted. */
  systemKey: string;
}

function baseUrl(target: DurableTarget): string {
  return `https://${target.hostName}/runtime/webhooks/durabletask`;
}

/**
 * Distinguishes an Easy Auth rejection from an ordinary 401.
 *
 * Easy Auth answers with an HTML login page or redirect; the Functions runtime
 * answers a bad system key with a plain/empty body. Verified live during the
 * spike (Easy Auth returned `401` with `Content-Type: text/html` even though the
 * system key was valid).
 *
 * This only ever fires under Node (integration tests). In a browser the same
 * response has no CORS headers, so `fetch` throws first and we report the
 * ambiguous `cors` error instead — by design, since the browser genuinely
 * cannot tell the two apart.
 */
function looksLikeEasyAuth(response: Response, body: string): boolean {
  const contentType = response.headers.get('Content-Type') ?? '';
  return contentType.includes('text/html') || body.includes('<html');
}

/** A valid system key still yields 401 behind Easy Auth, so the two must be told apart. */
function map401(response: Response, body: string): ApiError {
  return looksLikeEasyAuth(response, body)
    ? {
        kind: 'easyAuth',
        message: 'App Service Authentication rejected the call before the runtime saw it',
      }
    : { kind: 'auth', message: body || 'The system key was rejected' };
}

function map429(response: Response): ApiError {
  const parsed = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
  return {
    kind: 'http',
    status: 429,
    message: 'The function app is throttling requests',
    ...(Number.isFinite(parsed) ? { retryAfterSeconds: parsed } : {}),
  };
}

function mapStatus(response: Response, body: string, notFound: ApiError): ApiError {
  switch (response.status) {
    case 401:
      return map401(response, body);
    case 403:
      return { kind: 'forbidden', message: body || 'Denied by the function app' };
    case 404:
      return notFound;
    case 429:
      return map429(response);
    default:
      return {
        kind: 'http',
        status: response.status,
        message: body || `HTTP ${String(response.status)}`,
      };
  }
}

interface RawResponse {
  body: string;
  continuationToken: string | undefined;
}

/**
 * One request to the webhook API, with uniform error mapping.
 *
 * `notFound` is supplied per call site because 404 is overloaded: on the
 * collection route it means the app has no Durable Task extension, while on an
 * instance route it means that instance does not exist.
 */
async function call(
  url: string,
  init: RequestInit,
  notFound: ApiError,
  fetchImpl: typeof fetch
): Promise<Result<RawResponse>> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    return err({
      kind: 'cors',
      message: 'The browser blocked the request to the function app',
    });
  }

  const body = await response.text().catch(() => '');

  // 202 is a success for actions and for in-progress instance queries.
  if (!response.ok && response.status !== 202) {
    return err(mapStatus(response, body, notFound));
  }

  const token = response.headers.get(CONTINUATION_HEADER);
  return ok({ body, continuationToken: token !== null && token !== '' ? token : undefined });
}

function parseJson(body: string): Result<unknown> {
  if (body === '') return ok(null);
  try {
    return ok(JSON.parse(body) as unknown);
  } catch {
    return err({ kind: 'http', status: 200, message: 'The function app returned invalid JSON' });
  }
}

/**
 * Reads a field regardless of casing.
 *
 * The API is not self-consistent: instance fields come back camelCase
 * (`instanceId`, `runtimeStatus`) while history events come back PascalCase
 * (`EventType`, `FunctionName`, `Timestamp`) — see the response samples in the
 * HTTP API docs. Rather than encode that split and break on the next host
 * version, we accept either.
 */
function field(record: Record<string, unknown>, name: string): unknown {
  const direct = record[name];
  if (direct !== undefined) return direct;
  const pascal = name.charAt(0).toUpperCase() + name.slice(1);
  return record[pascal];
}

function str(record: Record<string, unknown>, name: string): string {
  const value = field(record, name);
  return typeof value === 'string' ? value : '';
}

function optionalStr(record: Record<string, unknown>, name: string): string | undefined {
  const value = field(record, name);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function toInstance(row: unknown): OrchestrationInstance | null {
  const record = asRecord(row);
  if (record === null) return null;
  const instanceId = str(record, 'instanceId');
  if (instanceId === '') return null;

  return {
    instanceId,
    name: str(record, 'name'),
    runtimeStatus: str(record, 'runtimeStatus'),
    createdTime: str(record, 'createdTime'),
    lastUpdatedTime: str(record, 'lastUpdatedTime'),
    input: field(record, 'input') ?? null,
    output: field(record, 'output') ?? null,
    customStatus: field(record, 'customStatus') ?? null,
  };
}

function toHistoryEvent(row: unknown): HistoryEvent | null {
  const record = asRecord(row);
  if (record === null) return null;
  const eventType = str(record, 'eventType');
  if (eventType === '') return null;

  return {
    eventType,
    timestamp: str(record, 'timestamp'),
    /*
     * The runtime names the target function differently per event type, which no
     * documentation mentions — captured from a live task hub:
     *   ExecutionStarted / TaskFailed / TaskCompleted -> "FunctionName"
     *   TaskScheduled                                 -> "Name"
     * Reading only one of them leaves scheduled events anonymous in the
     * timeline, and makes the "possibly stuck" hint name an event type instead
     * of the activity everyone is waiting on.
     */
    functionName: optionalStr(record, 'functionName') ?? optionalStr(record, 'name'),
    scheduledTime: optionalStr(record, 'scheduledTime'),
    result: field(record, 'result') ?? null,
    reason: optionalStr(record, 'reason'),
    details: optionalStr(record, 'details'),
    orchestrationStatus: optionalStr(record, 'orchestrationStatus'),
  };
}

function buildListQuery(target: DurableTarget, options: ListInstancesOptions): string {
  const params = new URLSearchParams({ code: target.systemKey });

  if (options.createdTimeFrom) params.set('createdTimeFrom', options.createdTimeFrom.toISOString());
  if (options.createdTimeTo) params.set('createdTimeTo', options.createdTimeTo.toISOString());
  // The runtime expects a comma-separated list for multi-status filtering.
  if (options.runtimeStatus && options.runtimeStatus.length > 0) {
    params.set('runtimeStatus', options.runtimeStatus.join(','));
  }
  if (options.instanceIdPrefix) params.set('instanceIdPrefix', options.instanceIdPrefix);
  if (options.top !== undefined) params.set('top', String(options.top));

  return `${baseUrl(target)}/instances?${params.toString()}`;
}

/**
 * One page of instances.
 *
 * The runtime may return fewer than `top` items and still have more results, so
 * callers must page on the continuation token rather than on page size.
 */
export async function listInstances(
  target: DurableTarget,
  options: ListInstancesOptions = {},
  fetchImpl: typeof fetch = fetch
): Promise<Result<InstancePage>> {
  const headers: Record<string, string> =
    options.continuationToken === undefined
      ? {}
      : { [CONTINUATION_HEADER]: options.continuationToken };

  const response = await call(
    buildListQuery(target, options),
    { method: 'GET', headers },
    // 404 on the collection route means the extension is not installed at all.
    { kind: 'notDurable', message: 'This app has no Durable Functions extension' },
    fetchImpl
  );
  if (!response.ok) return err(response.error);

  const parsed = parseJson(response.value.body);
  if (!parsed.ok) return err(parsed.error);
  if (!Array.isArray(parsed.value)) {
    return err({ kind: 'http', status: 200, message: 'Expected an array of instances' });
  }

  return ok({
    instances: parsed.value.map(toInstance).filter((i): i is OrchestrationInstance => i !== null),
    continuationToken: response.value.continuationToken,
  });
}

export interface FailureCount {
  count: number;
  /** True when there are more failures than the single page we counted. */
  more: boolean;
}

/**
 * Count an app's failed/terminated instances — the favourites failure scan.
 *
 * One page (top=200) is enough to answer "does this app need attention, and
 * roughly how badly": a precise total would mean paging the whole failed set,
 * which at 2 AM is neither wanted nor kind to a struggling app. When more exist
 * than one page, `more` is set and the UI shows "200+".
 */
export async function countFailedInstances(
  target: DurableTarget,
  fetchImpl: typeof fetch = fetch
): Promise<Result<FailureCount>> {
  const result = await listInstances(
    target,
    { runtimeStatus: ['Failed', 'Terminated'], top: 200 },
    fetchImpl
  );
  if (!result.ok) return err(result.error);
  return ok({
    count: result.value.instances.length,
    more: result.value.continuationToken !== undefined,
  });
}

/**
 * Build the `reason` value sent to the target app.
 *
 * This is the entire audit trail. DurableOps stores nothing, so the only durable
 * record of a destructive action is what the *target app* logs — and the runtime
 * writes `reason` into its own telemetry / App Insights. Prefixing the acting UPN
 * puts "who" next to "why" in a place this tool cannot later edit.
 *
 * Exported for tests, and because the format is a contract with whoever reads
 * those logs, not an implementation detail.
 */
export function buildAuditReason(upn: string, reason: string): string {
  return `DurableOps/${upn}: ${reason}`;
}

/** The minimum reason length the confirmation dialog enforces before enabling confirm. */
export const MIN_REASON_LENGTH = 10;

export type InstanceAction =
  'rewind' | 'restart' | 'raiseEvent' | 'suspend' | 'resume' | 'terminate' | 'purge';

interface ActionMeta {
  label: string;
  /** Runtime statuses on which this action is valid (avoids offering a 410-Gone). */
  validOn: readonly string[];
  /**
   * Whether the operator's reason reaches the target app's telemetry. Only the
   * webhook operations that accept a `reason` query parameter do; restart,
   * raiseEvent and purge have no such parameter, so their reason cannot be
   * forwarded and the dialog says so.
   */
  forwardsReason: boolean;
  /** Irreversible or state-destroying — the UI styles these as dangerous. */
  destructive: boolean;
}

/**
 * The action catalogue: what each does, where it is valid, and whether its reason
 * is auditable app-side. Validity mirrors the runtime, which answers 410 Gone
 * when an action does not apply to the current state — so we never offer one that
 * would just fail.
 */
export const ACTION_META: Record<InstanceAction, ActionMeta> = {
  rewind: { label: 'Rewind', validOn: ['Failed'], forwardsReason: true, destructive: true },
  restart: {
    label: 'Restart',
    validOn: ['Failed', 'Completed', 'Terminated', 'Canceled'],
    forwardsReason: false,
    destructive: true,
  },
  raiseEvent: {
    label: 'Raise event',
    validOn: ['Running', 'Pending', 'Suspended'],
    forwardsReason: false,
    destructive: false,
  },
  suspend: {
    label: 'Suspend',
    validOn: ['Running', 'Pending'],
    forwardsReason: true,
    destructive: false,
  },
  resume: { label: 'Resume', validOn: ['Suspended'], forwardsReason: true, destructive: false },
  terminate: {
    label: 'Terminate',
    validOn: ['Running', 'Pending', 'Suspended'],
    forwardsReason: true,
    destructive: true,
  },
  purge: {
    label: 'Purge',
    validOn: ['Failed', 'Completed', 'Terminated', 'Canceled'],
    forwardsReason: false,
    destructive: true,
  },
};

/** Left-to-right order actions appear in the action bar: recover, then signal, then destroy. */
const ACTION_ORDER: readonly InstanceAction[] = [
  'rewind',
  'restart',
  'raiseEvent',
  'suspend',
  'resume',
  'terminate',
  'purge',
];

/** The actions valid for an instance in the given runtime status, in display order. */
export function availableActions(runtimeStatus: string): InstanceAction[] {
  return ACTION_ORDER.filter((action) => ACTION_META[action].validOn.includes(runtimeStatus));
}

async function action(
  target: DurableTarget,
  instanceId: string,
  operation: string,
  params: Record<string, string>,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<Result<void>> {
  const query = new URLSearchParams({ code: target.systemKey, ...params });
  const path = operation === '' ? '' : `/${operation}`;
  const url = `${baseUrl(target)}/instances/${encodeURIComponent(instanceId)}${path}?${query.toString()}`;

  const response = await call(
    url,
    init,
    { kind: 'http', status: 404, message: `Instance ${instanceId} was not found` },
    fetchImpl
  );
  return response.ok ? ok(undefined) : err(response.error);
}

export async function terminateInstance(
  target: DurableTarget,
  instanceId: string,
  upn: string,
  reason: string,
  fetchImpl: typeof fetch = fetch
): Promise<Result<void>> {
  return action(
    target,
    instanceId,
    'terminate',
    { reason: buildAuditReason(upn, reason) },
    { method: 'POST' },
    fetchImpl
  );
}

/** Only valid on a Failed instance; the runtime answers 410 Gone otherwise. */
export async function rewindInstance(
  target: DurableTarget,
  instanceId: string,
  upn: string,
  reason: string,
  fetchImpl: typeof fetch = fetch
): Promise<Result<void>> {
  return action(
    target,
    instanceId,
    'rewind',
    { reason: buildAuditReason(upn, reason) },
    { method: 'POST' },
    fetchImpl
  );
}

export async function suspendInstance(
  target: DurableTarget,
  instanceId: string,
  upn: string,
  reason: string,
  fetchImpl: typeof fetch = fetch
): Promise<Result<void>> {
  return action(
    target,
    instanceId,
    'suspend',
    { reason: buildAuditReason(upn, reason) },
    { method: 'POST' },
    fetchImpl
  );
}

export async function resumeInstance(
  target: DurableTarget,
  instanceId: string,
  upn: string,
  reason: string,
  fetchImpl: typeof fetch = fetch
): Promise<Result<void>> {
  return action(
    target,
    instanceId,
    'resume',
    { reason: buildAuditReason(upn, reason) },
    { method: 'POST' },
    fetchImpl
  );
}

/**
 * Restart an instance from its original input.
 *
 * NOTE: this route is undocumented on the HTTP API page but is implemented by
 * the extension (`RestartOperation = "restart"`, with `restartWithNewInstanceId`
 * — see HttpApiHandler.cs in Azure/azure-functions-durable-extension). It was
 * confirmed against the extension source during the design spike. Because it is
 * undocumented, older hosts may answer 404; that surfaces as a plain HTTP error
 * rather than something the operator can act on.
 *
 * It takes no `reason` parameter, so restarts are audited only by the
 * ExecutionStarted event the runtime writes.
 */
export async function restartInstance(
  target: DurableTarget,
  instanceId: string,
  restartWithNewInstanceId: boolean,
  fetchImpl: typeof fetch = fetch
): Promise<Result<void>> {
  return action(
    target,
    instanceId,
    'restart',
    { restartWithNewInstanceId: String(restartWithNewInstanceId) },
    { method: 'POST' },
    fetchImpl
  );
}

/**
 * Raise an external event. The body must be JSON; the runtime rejects anything
 * else with 400, and answers 410 Gone if the instance already finished.
 */
export async function raiseEvent(
  target: DurableTarget,
  instanceId: string,
  eventName: string,
  payload: unknown,
  fetchImpl: typeof fetch = fetch
): Promise<Result<void>> {
  const query = new URLSearchParams({ code: target.systemKey });
  const url = `${baseUrl(target)}/instances/${encodeURIComponent(instanceId)}/raiseEvent/${encodeURIComponent(eventName)}?${query.toString()}`;

  const response = await call(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    { kind: 'http', status: 404, message: `Instance ${instanceId} was not found` },
    fetchImpl
  );
  return response.ok ? ok(undefined) : err(response.error);
}

/**
 * Purge an instance's history. Irreversible, and takes no `reason` parameter —
 * so the only record is what DurableOps showed the operator at confirmation time.
 */
export async function purgeInstance(
  target: DurableTarget,
  instanceId: string,
  fetchImpl: typeof fetch = fetch
): Promise<Result<void>> {
  return action(target, instanceId, '', {}, { method: 'DELETE' }, fetchImpl);
}

/** Full detail for one instance, including execution history for the timeline. */
export async function getInstance(
  target: DurableTarget,
  instanceId: string,
  fetchImpl: typeof fetch = fetch
): Promise<Result<InstanceDetail>> {
  const params = new URLSearchParams({
    code: target.systemKey,
    showHistory: 'true',
    showHistoryOutput: 'true',
    showInput: 'true',
  });
  const url = `${baseUrl(target)}/instances/${encodeURIComponent(instanceId)}?${params.toString()}`;

  const response = await call(
    url,
    { method: 'GET' },
    // On an instance route, 404 means this instance is unknown — not that the
    // app lacks the extension.
    { kind: 'http', status: 404, message: `Instance ${instanceId} was not found` },
    fetchImpl
  );
  if (!response.ok) return err(response.error);

  const parsed = parseJson(response.value.body);
  if (!parsed.ok) return err(parsed.error);

  const instance = toInstance(parsed.value);
  if (instance === null) {
    return err({ kind: 'http', status: 200, message: 'Malformed instance payload' });
  }

  const record = asRecord(parsed.value);
  const rawHistory = record === null ? null : field(record, 'historyEvents');

  return ok({
    ...instance,
    historyEvents: Array.isArray(rawHistory)
      ? rawHistory.map(toHistoryEvent).filter((e): e is HistoryEvent => e !== null)
      : [],
  });
}
