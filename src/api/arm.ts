/**
 * Azure Resource Manager client: function app discovery (Resource Graph) and
 * on-demand system key retrieval (listkeys).
 *
 * Every call carries the signed-in user's ARM token. There is no service
 * principal and no fallback identity — if the user cannot see it, DurableOps
 * cannot see it either. That is the security model, not a limitation.
 */
import {
  ARM_BASE,
  ARG_API_VERSION,
  AUTH_API_VERSION,
  TENANTS_API_VERSION,
  WEB_API_VERSION,
} from '../config';
import { err, ok, type ApiError, type Result } from './errors';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** How many apps to inspect at once. Bounded so a fleet of hundreds does not burst ARM into throttling. */
const CLASSIFY_CONCURRENCY = 8;

export interface FunctionApp {
  /** Full ARM resource ID. Also the stable key for caching and sorting. */
  id: string;
  name: string;
  resourceGroup: string;
  subscriptionId: string;
  location: string;
  kind: string;
  /**
   * The app's real hostname from ARM, e.g. `myapp.azurewebsites.net`.
   *
   * Taken from ARM rather than assembled as `${name}.azurewebsites.net`: that
   * assumption breaks for custom domains, sovereign clouds (.azurewebsites.us,
   * .chinacloudsites.cn) and App Service Environments. ARG hands us the correct
   * host for free, so we never guess.
   */
  defaultHostName: string;
  /** Running / Stopped. A stopped app cannot answer webhook calls. */
  state: string;
}

/**
 * Discovery query.
 *
 * `kind contains 'functionapp'` matches both `functionapp` and the Linux
 * variants (`functionapp,linux`), verified live against a real tenant.
 *
 * `order by id asc` is not cosmetic: Resource Graph only guarantees stable
 * paging across $skipToken requests when the result set is deterministically
 * ordered, and `id` is the only projected column guaranteed unique. Display
 * order is applied client-side.
 */
const DISCOVERY_QUERY = `
resources
| where type =~ 'microsoft.web/sites' and kind contains 'functionapp'
| project id, name, resourceGroup, subscriptionId, location, kind,
          defaultHostName = tostring(properties.defaultHostName),
          state = tostring(properties.state)
| order by id asc
`.trim();

/** ARG's hard ceiling per page. */
const ARG_PAGE_SIZE = 1000;

/** Guard against an unbounded paging loop if ARG ever returns a non-advancing token. */
const MAX_PAGES = 50;

/**
 * In-memory system key cache: ARM resource ID -> durabletask_extension key.
 *
 * Module-scoped and never persisted. Keys are Function-app-wide credentials; the
 * brief forbids them touching localStorage/sessionStorage/IndexedDB/URLs. This
 * Map dies with the tab, and `clearKeyCache()` empties it on sign-out and on
 * "Refresh rights".
 */
const keyCache = new Map<string, string>();

export function clearKeyCache(): void {
  keyCache.clear();
}

export function cachedKeyCount(): number {
  return keyCache.size;
}

function toApiError(status: number, retryAfter: string | null, body: string): ApiError {
  if (status === 401) return { kind: 'auth', message: body || 'Token rejected by Azure' };
  if (status === 403) return { kind: 'forbidden', message: body || 'Denied by Azure RBAC' };
  if (status === 429) {
    const parsed = Number.parseInt(retryAfter ?? '', 10);
    return {
      kind: 'http',
      status,
      message: 'Throttled by Azure Resource Manager',
      ...(Number.isFinite(parsed) ? { retryAfterSeconds: parsed } : {}),
    };
  }
  return { kind: 'http', status, message: body || `Unexpected HTTP ${String(status)}` };
}

async function armFetch(
  url: string,
  token: string,
  body: unknown,
  fetchImpl: typeof fetch,
  method: 'GET' | 'POST' = 'POST'
): Promise<Result<unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    // ARM sends permissive CORS headers, so a throw here is a real network
    // failure (offline, DNS, blocked by policy) rather than a CORS rejection.
    return err({ kind: 'http', status: 0, message: 'Could not reach management.azure.com' });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return err(toApiError(response.status, response.headers.get('Retry-After'), text));
  }

  // Parse inside the guard: a 2xx with a non-JSON body (a proxy error page, a
  // truncated response) must surface as an error, not reject the promise — some
  // callers are fire-and-forget (getTenantName) and a rejection there is unhandled.
  try {
    return ok((await response.json()) as unknown);
  } catch {
    return err({
      kind: 'http',
      status: response.status,
      message: 'management.azure.com returned invalid JSON',
    });
  }
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/**
 * ARG lowercases the `resourceGroup` column but preserves casing inside `id`.
 * ARM URLs are case-insensitive so either works on the wire, but operators
 * recognise their own RG names — so we display the casing they chose.
 */
function resourceGroupFromId(id: string, fallback: string): string {
  const match = /\/resourceGroups\/([^/]+)\//i.exec(id);
  return match?.[1] ?? fallback;
}

function toFunctionApp(row: unknown): FunctionApp | null {
  if (typeof row !== 'object' || row === null) return null;
  const record = row as Record<string, unknown>;
  const id = readString(record, 'id');
  const name = readString(record, 'name');
  if (id === '' || name === '') return null;

  return {
    id,
    name,
    resourceGroup: resourceGroupFromId(id, readString(record, 'resourceGroup')),
    subscriptionId: readString(record, 'subscriptionId'),
    location: readString(record, 'location'),
    kind: readString(record, 'kind'),
    defaultHostName: readString(record, 'defaultHostName'),
    state: readString(record, 'state'),
  };
}

interface ArgPage {
  rows: FunctionApp[];
  skipToken: string | undefined;
}

function parseArgPage(payload: unknown): Result<ArgPage> {
  if (typeof payload !== 'object' || payload === null) {
    return err({ kind: 'http', status: 200, message: 'Resource Graph returned a non-object' });
  }
  const record = payload as Record<string, unknown>;
  const data = record['data'];
  if (!Array.isArray(data)) {
    return err({ kind: 'http', status: 200, message: 'Resource Graph returned no data array' });
  }
  const skipToken = record['$skipToken'];
  return ok({
    rows: data.map(toFunctionApp).filter((app): app is FunctionApp => app !== null),
    skipToken: typeof skipToken === 'string' && skipToken !== '' ? skipToken : undefined,
  });
}

/**
 * List every function app the signed-in user can see, across every subscription
 * they have access to.
 *
 * No subscription list is passed: omitting `subscriptions` makes ARG search the
 * caller's full authorised scope. The result *is* the user's real access, by
 * construction — there is no filtering for us to get wrong.
 */
export async function discoverFunctionApps(
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<Result<FunctionApp[]>> {
  const url = `${ARM_BASE}/providers/Microsoft.ResourceGraph/resources?api-version=${ARG_API_VERSION}`;
  const apps: FunctionApp[] = [];
  let skipToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = {
      query: DISCOVERY_QUERY,
      options: {
        resultFormat: 'objectArray',
        $top: ARG_PAGE_SIZE,
        ...(skipToken === undefined ? {} : { $skipToken: skipToken }),
      },
    };

    const response = await armFetch(url, token, body, fetchImpl);
    if (!response.ok) return err(response.error);

    const parsed = parseArgPage(response.value);
    if (!parsed.ok) return err(parsed.error);

    apps.push(...parsed.value.rows);
    skipToken = parsed.value.skipToken;
    if (skipToken === undefined) break;
  }

  apps.sort((a, b) => a.name.localeCompare(b.name));
  return ok(apps);
}

/**
 * Resolve a tenant's display name (e.g. "SureStacks") from its GUID.
 *
 * A GUID in the top bar tells an operator nothing. ARM's /tenants endpoint
 * returns the display name and default domain for every tenant the caller can
 * reach, and it works with the ARM token we already hold — reading the tenant
 * name from Microsoft Graph instead would mean adding a Graph permission to the
 * app registration, for a cosmetic gain.
 *
 * Falls back to the domain, then to the GUID: never blocks the UI.
 */
function tenantLabel(record: Record<string, unknown>, fallback: string): string {
  const displayName = record['displayName'];
  if (typeof displayName === 'string' && displayName !== '') return displayName;
  const domain = record['defaultDomain'];
  if (typeof domain === 'string' && domain !== '') return domain;
  return fallback;
}

export async function getTenantName(
  tenantId: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const url = `${ARM_BASE}/tenants?api-version=${TENANTS_API_VERSION}`;
  const response = await armFetch(url, token, undefined, fetchImpl, 'GET');
  if (!response.ok) return tenantId;

  const value = asRecord(response.value)?.['value'];
  if (!Array.isArray(value)) return tenantId;

  // /tenants lists every tenant the caller can reach, so pick ours out.
  for (const entry of value) {
    const record = asRecord(entry);
    if (record !== null && record['tenantId'] === tenantId) return tenantLabel(record, tenantId);
  }
  return tenantId;
}

/**
 * Whether the signed-in user can actually *operate* an app.
 *
 * Seeing an app and operating it are different permissions: Resource Graph
 * returns everything the user can READ (Reader shows the whole tenant), while
 * every useful thing DurableOps does needs the durable system key, which needs
 * `listkeys`. Listing apps the operator cannot act on is noise, so we ask ARM
 * per scope and hide what they cannot use.
 */
export type Operability = 'yes' | 'no' | 'unknown';

/** The one action that decides whether DurableOps can do anything with an app. */
const LISTKEYS_ACTION = 'microsoft.web/sites/host/listkeys/action';

/** Turn an RBAC action pattern (`*`, `Microsoft.Web/*`) into a matcher. */
function actionMatches(pattern: string, action: string): boolean {
  const escaped = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`).test(action);
}

/**
 * Azure's rule: a role grants an action when one of its `actions` matches and
 * none of that same role's `notActions` does. Roles are additive, so any single
 * granting entry is enough.
 */
function grantsAction(payload: unknown, action: string): Operability {
  const value = asRecord(payload)?.['value'];
  if (!Array.isArray(value)) return 'unknown';

  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null) continue;
    const actions = Array.isArray(record['actions']) ? record['actions'] : [];
    const notActions = Array.isArray(record['notActions']) ? record['notActions'] : [];

    const allowed = actions.some((p) => typeof p === 'string' && actionMatches(p, action));
    const denied = notActions.some((p) => typeof p === 'string' && actionMatches(p, action));
    if (allowed && !denied) return 'yes';
  }
  return 'no';
}

/**
 * Ask ARM what the *caller* may do at a scope, and whether that includes listkeys.
 *
 * Reads the caller's own effective permissions, which needs only the
 * `Microsoft.Authorization` read actions that the built-in Reader role already
 * has. This reflects PIM activations the moment they happen, which is what makes
 * "Refresh rights" work without a re-login.
 */
export async function checkOperability(
  scope: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<Operability> {
  const url = `${ARM_BASE}${scope}/providers/Microsoft.Authorization/permissions?api-version=${AUTH_API_VERSION}`;
  const response = await armFetch(url, token, undefined, fetchImpl, 'GET');
  // Could not ask => do not claim the operator lacks access.
  if (!response.ok) return 'unknown';
  return grantsAction(response.value, LISTKEYS_ACTION);
}

/**
 * Decide operability for a fleet, cheaply.
 *
 * Roles are usually assigned at subscription (or management group) scope and
 * inherit downwards, so one check per subscription normally settles every app in
 * it. Only when the subscription-level answer is not a clear "yes" do we fall
 * back to per-app checks, which is what catches roles assigned at resource-group
 * or per-app scope.
 */
export async function checkOperabilityForApps(
  apps: readonly FunctionApp[],
  token: string,
  onResult: (id: string, operable: Operability) => void,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const bySubscription = new Map<string, FunctionApp[]>();
  for (const app of apps) {
    const list = bySubscription.get(app.subscriptionId) ?? [];
    list.push(app);
    bySubscription.set(app.subscriptionId, list);
  }

  const needsPerApp: FunctionApp[] = [];
  for (const [subscriptionId, subApps] of bySubscription) {
    const atSubscription = await checkOperability(
      `/subscriptions/${subscriptionId}`,
      token,
      fetchImpl
    );
    if (atSubscription === 'yes') {
      for (const app of subApps) onResult(app.id, 'yes');
    } else {
      needsPerApp.push(...subApps);
    }
  }

  const queue = [...needsPerApp];
  const workers = Array.from({ length: Math.min(CLASSIFY_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const app = queue.shift();
      if (app === undefined) return;
      onResult(app.id, await checkOperability(app.id, token, fetchImpl));
    }
  });
  await Promise.all(workers);
}

/**
 * Whether an app runs Durable Functions.
 *
 * `unknown` is not a synonym for `no`: it means we were not allowed to look, or
 * ARM failed. Those apps stay visible, because hiding an app the operator might
 * legitimately need — purely because we could not classify it — would silently
 * remove work from the list.
 */
export type DurableKind = 'yes' | 'no' | 'unknown';

/** A binding of any of these types can only exist in an app running the Durable Task extension. */
const DURABLE_BINDING_TYPES: ReadonlySet<string> = new Set([
  'orchestrationTrigger',
  'activityTrigger',
  'entityTrigger',
]);

/** Bindings of one function entry; empty when the payload is not the shape we expect. */
function bindingsOf(fn: unknown): unknown[] {
  const config = asRecord(asRecord(fn)?.['properties'])?.['config'];
  const bindings = asRecord(config)?.['bindings'];
  return Array.isArray(bindings) ? bindings : [];
}

function bindingTypesOf(payload: unknown): Set<string> {
  const types = new Set<string>();
  const value = asRecord(payload)?.['value'];
  if (!Array.isArray(value)) return types;

  for (const fn of value) {
    for (const binding of bindingsOf(fn)) {
      const type = asRecord(binding)?.['type'];
      if (typeof type === 'string') types.add(type);
    }
  }
  return types;
}

/**
 * Classify an app as durable or not, WITHOUT fetching any key.
 *
 * Reads the app's function bindings from ARM: an `orchestrationTrigger` /
 * `activityTrigger` / `entityTrigger` binding can only come from the Durable
 * Task extension. Verified live against a real durable app (31 functions,
 * orchestrationTrigger present) and a plain one (httpTrigger/timerTrigger only).
 *
 * Why not probe `listkeys` instead: the presence of a `durabletask_extension`
 * system key is an equally good signal, but obtaining it means pulling an
 * app-wide credential into the browser for every app in the fleet just to draw a
 * list. This call needs only `Microsoft.Web/sites/functions/read` (covered by
 * Reader) and returns no secrets at all.
 */
export async function classifyDurable(
  app: FunctionApp,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<DurableKind> {
  const url = `${ARM_BASE}${app.id}/functions?api-version=${WEB_API_VERSION}`;
  const response = await armFetch(url, token, undefined, fetchImpl, 'GET');
  // A denial or a stopped app means "we could not tell", never "not durable".
  if (!response.ok) return 'unknown';

  const types = bindingTypesOf(response.value);
  if (types.size === 0) return 'unknown';
  for (const type of types) {
    if (DURABLE_BINDING_TYPES.has(type)) return 'yes';
  }
  return 'no';
}

/**
 * Classify a whole fleet with bounded concurrency, reporting each result as it
 * lands so the list can settle progressively rather than blocking on the
 * slowest app.
 */
export async function classifyDurableApps(
  apps: readonly FunctionApp[],
  token: string,
  onResult: (id: string, kind: DurableKind) => void,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const queue = [...apps];
  const workers = Array.from({ length: Math.min(CLASSIFY_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const app = queue.shift();
      if (app === undefined) return;
      onResult(app.id, await classifyDurable(app, token, fetchImpl));
    }
  });
  await Promise.all(workers);
}

/**
 * Pull `systemKeys.durabletask_extension` out of a listkeys payload.
 *
 * A function app with no durabletask_extension key never loaded the Durable Task
 * extension: it is a function app, but not a durable one, which is a normal
 * fleet condition rather than a failure.
 */
function extractDurableKey(payload: unknown, appName: string): Result<string> {
  if (typeof payload !== 'object' || payload === null) {
    return err({ kind: 'http', status: 200, message: 'listkeys returned a non-object' });
  }

  const systemKeys = (payload as Record<string, unknown>)['systemKeys'];
  if (typeof systemKeys !== 'object' || systemKeys === null) {
    return err({ kind: 'notDurable', message: `${appName} exposes no system keys` });
  }

  const key = (systemKeys as Record<string, unknown>)['durabletask_extension'];
  if (typeof key !== 'string' || key === '') {
    return err({
      kind: 'notDurable',
      message: `${appName} has no durabletask_extension system key`,
    });
  }

  return ok(key);
}

/**
 * Fetch (and memoise) an app's `durabletask_extension` system key.
 *
 * Called lazily — only when the operator opens an app — so browsing the app list
 * never pulls credentials for hundreds of apps. A 403 here is the PIM signal:
 * the user can read the app (ARG showed it) but cannot list its keys.
 */
export async function getDurableSystemKey(
  app: FunctionApp,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<Result<string>> {
  const cached = keyCache.get(app.id);
  if (cached !== undefined) return ok(cached);

  const url = `${ARM_BASE}${app.id}/host/default/listkeys?api-version=${WEB_API_VERSION}`;
  const response = await armFetch(url, token, undefined, fetchImpl);
  if (!response.ok) {
    // Name the app in the 403 so the PIM prompt can say which one to activate.
    return err(
      response.error.kind === 'forbidden' ? { ...response.error, scope: app.name } : response.error
    );
  }

  const key = extractDurableKey(response.value, app.name);
  if (key.ok) keyCache.set(app.id, key.value);
  return key;
}
