import type { Page, Route } from '@playwright/test';

/**
 * Stubs for the deterministic E2E layer.
 *
 * Every Azure origin is intercepted, so these tests need no tenant, no token and
 * no network. They assert what an operator sees, not what Azure does.
 */

export const APP_NAME = 'func-prod-billing';

function argRow(name: string) {
  return {
    id: `/subscriptions/sub-1/resourceGroups/RG-Billing/providers/Microsoft.Web/sites/${name}`,
    name,
    resourceGroup: 'rg-billing',
    subscriptionId: 'sub-1',
    location: 'westeurope',
    kind: 'functionapp',
    defaultHostName: `${name}.azurewebsites.net`,
    state: 'Running',
  };
}

export function instance(
  instanceId: string,
  name: string,
  runtimeStatus: string,
  output: unknown = null
): Record<string, unknown> {
  return {
    instanceId,
    name,
    runtimeStatus,
    createdTime: '2026-06-04T10:46:39Z',
    lastUpdatedTime: '2026-06-04T10:46:47Z',
    input: null,
    output,
    customStatus: null,
  };
}

/** A failure output whose parsed headline is `message`, for list-triage tests. */
export function failureOutput(activity: string, message: string): string {
  return `Orchestrator function 'OrderSaga' failed: Activity function '${activity}' failed:  ${message} \n {}`;
}

/** A history that fails partway, for the jump-to-error assertions. */
export const FAILING_HISTORY = [
  { EventType: 'ExecutionStarted', FunctionName: 'OrderSaga', Timestamp: '2026-06-04T10:46:39Z' },
  { EventType: 'TaskScheduled', FunctionName: 'ReserveStock', Timestamp: '2026-06-04T10:46:40Z' },
  { EventType: 'TaskCompleted', FunctionName: 'ReserveStock', Timestamp: '2026-06-04T10:46:41Z' },
  { EventType: 'TaskScheduled', FunctionName: 'ChargeCard', Timestamp: '2026-06-04T10:46:42Z' },
  {
    EventType: 'TaskFailed',
    FunctionName: 'ChargeCard',
    Timestamp: '2026-06-04T10:46:43Z',
    Reason: 'Card declined by issuer',
    Details: 'System.Exception: declined at ChargeCard.Run()',
  },
];

/**
 * A live instance whose history ends on a long-unanswered TaskScheduled — the
 * "possibly stuck" case. Timestamps are far in the past so the 15-minute
 * threshold is exceeded no matter when the test runs.
 */
export const STUCK_HISTORY = [
  { EventType: 'ExecutionStarted', FunctionName: 'StuckSaga', Timestamp: '2020-01-01T00:00:00Z' },
  { EventType: 'TaskScheduled', FunctionName: 'NeverReturns', Timestamp: '2020-01-01T00:00:01Z' },
];

/** A layered failure output shaped exactly like the runtime's, for the summary card. */
export const FAILED_OUTPUT =
  "Orchestrator function 'OrderSaga' failed: Activity function 'ChargeCard' failed:  " +
  'Card declined by issuer \n {"$type":"System.Exception","Message":"Card declined by issuer"}';

export interface StubOptions {
  instances?: Record<string, unknown>[];
  history?: Record<string, unknown>[];
  detailStatus?: string;
  /** The instance-detail `output`; defaults to a realistic failure when status is Failed. */
  output?: unknown;
  /**
   * Force the Durable data-plane call to 403, for the PIM path. Through the ARM
   * proxy, RBAC — not a system key — is what a denied operator hits, so the 403
   * lands on the instance query, not on listkeys.
   */
  forbidData?: boolean;
  /** Trigger bindings ARM reports for the app; drives the durable/not-durable filter. */
  bindings?: string[];
  /** Force the /functions call to 403, so the app classifies as "unknown". */
  forbidFunctions?: boolean;
  // RBAC actions the signed-in user holds. Defaults to a role that can operate.
  // Passing only a read wildcard reproduces Reader: sees every app, operates none.
  actions?: string[];
}

/**
 * Stub every Azure origin the app talks to: ARG, the permissions check,
 * /functions, and the Durable webhook API — the last reached through ARM's
 * hostruntime proxy (management.azure.com/{resourceId}/hostruntime/...), so the
 * webhook globs match by path suffix whatever the host.
 */
export async function stubAzure(page: Page, options: StubOptions = {}): Promise<void> {
  const {
    instances = [instance('abc123', 'OrderSaga', 'Failed')],
    history = FAILING_HISTORY,
    detailStatus = 'Failed',
    output = detailStatus === 'Failed' ? FAILED_OUTPUT : null,
    forbidData = false,
    bindings = ['orchestrationTrigger', 'activityTrigger'],
    forbidFunctions = false,
    actions = ['Microsoft.Web/sites/read', 'Microsoft.Web/sites/hostruntime/host/action'],
  } = options;

  await page.route('**/providers/Microsoft.ResourceGraph/resources**', (route: Route) =>
    route.fulfill({ json: { data: [argRow(APP_NAME)], totalRecords: 1 } })
  );

  // What the signed-in user is allowed to do — decides whether an app is listed.
  await page.route('**/providers/Microsoft.Authorization/permissions**', (route: Route) =>
    route.fulfill({ json: { value: [{ actions, notActions: [] }] } })
  );

  // Tenant display name for the account flyout.
  await page.route('**/tenants?api-version=**', (route: Route) =>
    route.fulfill({
      json: {
        value: [{ tenantId: 'tenant-id', displayName: 'Contoso', defaultDomain: 'contoso.com' }],
      },
    })
  );

  // Durable classification: read from ARM function bindings, no keys involved.
  await page.route('**/functions?api-version=**', (route: Route) =>
    forbidFunctions
      ? route.fulfill({ status: 403, body: 'denied' })
      : route.fulfill({
          json: {
            value: [
              {
                name: 'fn',
                properties: { config: { bindings: bindings.map((type) => ({ type })) } },
              },
            ],
          },
        })
  );

  // Instance detail must be routed before the collection route, since the
  // collection glob would otherwise swallow it.
  await page.route(`**/runtime/webhooks/durabletask/instances/*`, (route: Route) =>
    forbidData
      ? route.fulfill({ status: 403, body: 'RBAC denied' })
      : route.fulfill({
          json: {
            ...instance('abc123', 'OrderSaga', detailStatus),
            output,
            historyEvents: history,
          },
        })
  );

  await page.route(`**/runtime/webhooks/durabletask/instances?**`, (route: Route) =>
    forbidData
      ? route.fulfill({ status: 403, body: 'RBAC denied' })
      : route.fulfill({ json: instances })
  );

  // Instance action sub-routes (terminate / suspend / resume / rewind / restart /
  // raiseEvent). One extra path segment after the id, so this never shadows the
  // instance-detail route. Accept with 202, as the runtime does.
  await page.route(`**/runtime/webhooks/durabletask/instances/*/**`, (route: Route) =>
    route.fulfill({ status: 202, body: '' })
  );
}

/** Pre-seed favourite app names in localStorage before the app boots. */
export async function seedFavorites(page: Page, names: string[]): Promise<void> {
  await page.addInitScript((favs: string[]) => {
    localStorage.setItem('durableops.favorites', JSON.stringify(favs));
  }, names);
}

/**
 * Inject a fake signed-in user before any app script runs.
 *
 * This uses the `__durableOpsTestAuth` seam in auth.ts, which only exists in an
 * `--mode e2e` build — the production bundle has the branch compiled out. It
 * beats hand-seeding MSAL's sessionStorage cache, which would couple the tests
 * to an undocumented internal schema.
 */
export async function signInAs(page: Page, upn = 'ops@contoso.com'): Promise<void> {
  await page.addInitScript(
    ({ user }) => {
      window.__durableOpsTestAuth = {
        upn: user,
        tenantId: 'tenant-id',
        name: user,
        token: 'fake-arm-token',
      };
    },
    { user: upn }
  );
}
