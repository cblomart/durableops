import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  discoverFunctionApps,
  getDurableSystemKey,
  classifyDurable,
  classifyDurableApps,
  checkOperability,
  checkOperabilityForApps,
  getTenantName,
  clearKeyCache,
  cachedKeyCount,
  type FunctionApp,
} from '../../src/api/arm';

const TOKEN = 'fake-arm-token';

/** Shape mirrors a real Resource Graph response captured during the design spike. */
function argRow(name: string, rg = 'RG-acme', sub = 'sub-1'): Record<string, unknown> {
  return {
    id: `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Web/sites/${name}`,
    name,
    resourceGroup: rg.toLowerCase(), // ARG really does lowercase this column.
    subscriptionId: sub,
    location: 'westeurope',
    kind: 'functionapp,linux',
    defaultHostName: `${name}.azurewebsites.net`,
    state: 'Running',
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function errorResponse(status: number, body = 'denied', headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

/**
 * A Response body can only be read once, so a mock that must answer several
 * calls has to mint a fresh Response each time rather than reuse one instance.
 */
function alwaysRespond(factory: () => Response): typeof fetch {
  return vi.fn().mockImplementation(() => Promise.resolve(factory()));
}

beforeEach(() => {
  clearKeyCache();
});

describe('discoverFunctionApps', () => {
  it('returns the apps ARG reports, mapped to typed rows', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [argRow('func-a')] }));

    const result = await discoverFunctionApps(TOKEN, fetchMock);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toMatchObject({
      name: 'func-a',
      location: 'westeurope',
      defaultHostName: 'func-a.azurewebsites.net',
      state: 'Running',
    });
  });

  it('sends the bearer token and asks ARG for objectArray results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));

    await discoverFunctionApps(TOKEN, fetchMock);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/providers/Microsoft.ResourceGraph/resources');
    expect(url).toContain('api-version=2022-10-01');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(init.body as string) as {
      query: string;
      options: Record<string, unknown>;
    };
    expect(body.options['resultFormat']).toBe('objectArray');
    // Deterministic ordering is what makes $skipToken paging safe.
    expect(body.query).toContain('order by id asc');
  });

  it('preserves the resource group casing from the resource id, not ARG’s lowercased column', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [argRow('func-a', 'RG-Billing')] }));

    const result = await discoverFunctionApps(TOKEN, fetchMock);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.resourceGroup).toBe('RG-Billing');
  });

  it('follows $skipToken until ARG stops returning one, and concatenates pages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [argRow('func-a')], $skipToken: 'tok-1' }))
      .mockResolvedValueOnce(jsonResponse({ data: [argRow('func-b')], $skipToken: 'tok-2' }))
      .mockResolvedValueOnce(jsonResponse({ data: [argRow('func-c')] }));

    const result = await discoverFunctionApps(TOKEN, fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((a) => a.name)).toEqual(['func-a', 'func-b', 'func-c']);

    // Page 1 must not carry a token; pages 2 and 3 must echo the previous one.
    const bodies = fetchMock.mock.calls.map(
      (call) =>
        (
          JSON.parse((call[1] as RequestInit).body as string) as {
            options: Record<string, unknown>;
          }
        ).options
    );
    expect(bodies[0]?.['$skipToken']).toBeUndefined();
    expect(bodies[1]?.['$skipToken']).toBe('tok-1');
    expect(bodies[2]?.['$skipToken']).toBe('tok-2');
  });

  it('stops paging at the guard rather than looping forever on a non-advancing token', async () => {
    const fetchMock = alwaysRespond(() =>
      jsonResponse({ data: [argRow('func-a')], $skipToken: 'stuck' })
    );

    const result = await discoverFunctionApps(TOKEN, fetchMock);

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(50);
  });

  it('sorts results by name for display', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [argRow('func-z'), argRow('func-a')] }));

    const result = await discoverFunctionApps(TOKEN, fetchMock);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((a) => a.name)).toEqual(['func-a', 'func-z']);
  });

  it('skips malformed rows instead of failing the whole discovery', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [argRow('func-a'), null, {}, 'nonsense'] }));

    const result = await discoverFunctionApps(TOKEN, fetchMock);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((a) => a.name)).toEqual(['func-a']);
  });

  it('maps 401 to an auth error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401, 'token expired'));

    const result = await discoverFunctionApps(TOKEN, fetchMock);

    expect(result).toMatchObject({ ok: false, error: { kind: 'auth' } });
  });

  it('maps 403 to a forbidden error (the PIM case)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(403, 'RBAC denied'));

    const result = await discoverFunctionApps(TOKEN, fetchMock);

    expect(result).toMatchObject({ ok: false, error: { kind: 'forbidden' } });
  });

  it('maps 429 to an http error carrying Retry-After seconds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(errorResponse(429, 'slow down', { 'Retry-After': '42' }));

    const result = await discoverFunctionApps(TOKEN, fetchMock);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'http', status: 429, retryAfterSeconds: 42 },
    });
  });

  it('omits retryAfterSeconds when Retry-After is absent or unparseable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(429, 'slow down'));

    const result = await discoverFunctionApps(TOKEN, fetchMock);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'http', status: 429 });
    expect('retryAfterSeconds' in result.error).toBe(false);
  });

  it('maps a network throw to a reachability error, not a crash', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await discoverFunctionApps(TOKEN, fetchMock);

    expect(result).toMatchObject({ ok: false, error: { kind: 'http', status: 0 } });
  });

  it('rejects a response with no data array', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ totalRecords: 0 }));

    const result = await discoverFunctionApps(TOKEN, fetchMock);

    expect(result.ok).toBe(false);
  });
});

describe('getDurableSystemKey', () => {
  const app: FunctionApp = {
    id: '/subscriptions/sub-1/resourceGroups/RG-acme/providers/Microsoft.Web/sites/func-a',
    name: 'func-a',
    resourceGroup: 'RG-acme',
    subscriptionId: 'sub-1',
    location: 'westeurope',
    kind: 'functionapp',
    defaultHostName: 'func-a.azurewebsites.net',
    state: 'Running',
  };

  it('returns the durabletask_extension system key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        masterKey: 'master-should-be-ignored',
        systemKeys: { durabletask_extension: 'the-key' },
      })
    );

    const result = await getDurableSystemKey(app, TOKEN, fetchMock);

    expect(result).toEqual({ ok: true, value: 'the-key' });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/host/default/listkeys');
    expect(url).toContain('api-version=2023-12-01');
  });

  it('caches the key in memory and does not call ARM twice', async () => {
    const fetchMock = alwaysRespond(() =>
      jsonResponse({ systemKeys: { durabletask_extension: 'the-key' } })
    );

    await getDurableSystemKey(app, TOKEN, fetchMock);
    const second = await getDurableSystemKey(app, TOKEN, fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ ok: true, value: 'the-key' });
    expect(cachedKeyCount()).toBe(1);
  });

  it('clearKeyCache drops every cached key (sign-out / Refresh rights)', async () => {
    const fetchMock = alwaysRespond(() =>
      jsonResponse({ systemKeys: { durabletask_extension: 'the-key' } })
    );

    await getDurableSystemKey(app, TOKEN, fetchMock);
    expect(cachedKeyCount()).toBe(1);

    clearKeyCache();

    // The key must be re-fetched from ARM, proving nothing survived the clear.
    expect(cachedKeyCount()).toBe(0);
    await getDurableSystemKey(app, TOKEN, fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps 403 to forbidden and tags the app name for the PIM message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(403, 'no listkeys for you'));

    const result = await getDurableSystemKey(app, TOKEN, fetchMock);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'forbidden', scope: 'func-a' },
    });
  });

  it('does not cache anything when the call fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(403));

    await getDurableSystemKey(app, TOKEN, fetchMock);

    expect(cachedKeyCount()).toBe(0);
  });

  it('reports notDurable when the app has system keys but no durabletask_extension', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ systemKeys: { eventgrid_extension: 'other' } }));

    const result = await getDurableSystemKey(app, TOKEN, fetchMock);

    expect(result).toMatchObject({ ok: false, error: { kind: 'notDurable' } });
  });

  it('reports notDurable when the app exposes no system keys at all', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ functionKeys: {} }));

    const result = await getDurableSystemKey(app, TOKEN, fetchMock);

    expect(result).toMatchObject({ ok: false, error: { kind: 'notDurable' } });
  });
});

/** Mirrors the ARM /functions payload shape captured live during the spike. */
function functionsPayload(...bindingTypes: string[][]): Record<string, unknown> {
  return {
    value: bindingTypes.map((types, i) => ({
      name: `fn${String(i)}`,
      properties: { config: { bindings: types.map((type) => ({ type, name: 'x' })) } },
    })),
  };
}

describe('classifyDurable', () => {
  const app: FunctionApp = {
    id: '/subscriptions/sub-1/resourceGroups/RG-acme/providers/Microsoft.Web/sites/func-a',
    name: 'func-a',
    resourceGroup: 'RG-acme',
    subscriptionId: 'sub-1',
    location: 'westeurope',
    kind: 'functionapp',
    defaultHostName: 'func-a.azurewebsites.net',
    state: 'Running',
  };

  it('reads function bindings via GET and never touches listkeys', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(functionsPayload(['orchestrationTrigger'])));

    await classifyDurable(app, TOKEN, fetchMock);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/functions?api-version=');
    expect(init.method).toBe('GET');
    // The whole point: classification must not pull an app-wide credential.
    expect(url).not.toContain('listkeys');
  });

  it.each([['orchestrationTrigger'], ['activityTrigger'], ['entityTrigger']])(
    'reports yes when a %s binding is present',
    async (type) => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(functionsPayload([type])));

      await expect(classifyDurable(app, TOKEN, fetchMock)).resolves.toBe('yes');
    }
  );

  it('reports yes when a durable binding sits among many plain ones', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          functionsPayload(
            ['httpTrigger'],
            ['timerTrigger'],
            ['orchestrationTrigger', 'durableClient']
          )
        )
      );

    await expect(classifyDurable(app, TOKEN, fetchMock)).resolves.toBe('yes');
  });

  it('reports no for an app with only plain triggers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(functionsPayload(['httpTrigger'], ['timerTrigger'])));

    await expect(classifyDurable(app, TOKEN, fetchMock)).resolves.toBe('no');
  });

  /*
   * "unknown" must never collapse into "no": a denied or stopped app would then
   * be hidden from the list, silently removing work the operator may need.
   */
  it('reports unknown on 403 rather than assuming not-durable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(403, 'denied'));

    await expect(classifyDurable(app, TOKEN, fetchMock)).resolves.toBe('unknown');
  });

  it('reports unknown when ARM is unreachable', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(classifyDurable(app, TOKEN, fetchMock)).resolves.toBe('unknown');
  });

  it('reports unknown for an app exposing no functions (e.g. stopped)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ value: [] }));

    await expect(classifyDurable(app, TOKEN, fetchMock)).resolves.toBe('unknown');
  });

  it('reports unknown for a malformed payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ nonsense: true }));

    await expect(classifyDurable(app, TOKEN, fetchMock)).resolves.toBe('unknown');
  });

  it('tolerates functions with missing or malformed bindings', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        value: [{ name: 'a' }, { name: 'b', properties: {} }, null, { properties: { config: {} } }],
      })
    );

    await expect(classifyDurable(app, TOKEN, fetchMock)).resolves.toBe('unknown');
  });
});

describe('classifyDurableApps', () => {
  function appN(n: number): FunctionApp {
    return {
      id: `/subscriptions/sub-1/resourceGroups/RG/providers/Microsoft.Web/sites/func-${String(n)}`,
      name: `func-${String(n)}`,
      resourceGroup: 'RG',
      subscriptionId: 'sub-1',
      location: 'westeurope',
      kind: 'functionapp',
      defaultHostName: `func-${String(n)}.azurewebsites.net`,
      state: 'Running',
    };
  }

  it('classifies every app and reports each result as it lands', async () => {
    const apps = [appN(1), appN(2), appN(3)];
    const fetchMock = alwaysRespond(() => jsonResponse(functionsPayload(['orchestrationTrigger'])));
    const results: string[] = [];

    await classifyDurableApps(apps, TOKEN, (id, kind) => results.push(`${id}=${kind}`), fetchMock);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.endsWith('=yes'))).toBe(true);
  });

  it('handles an empty fleet without spawning workers', async () => {
    const fetchMock = vi.fn();

    await classifyDurableApps([], TOKEN, () => undefined, fetchMock);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  /* A fleet is hundreds of apps: bursting them all at once invites 429s. */
  it('never runs more than the concurrency cap at once', async () => {
    const apps = Array.from({ length: 30 }, (_, i) => appN(i));
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return jsonResponse(functionsPayload(['httpTrigger']));
    });

    await classifyDurableApps(apps, TOKEN, () => undefined, fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(30);
    expect(peak).toBeLessThanOrEqual(8);
  });
});

/** Mirrors the Microsoft.Authorization/permissions payload shape. */
function permissions(actions: string[], notActions: string[] = []): Record<string, unknown> {
  return { value: [{ actions, notActions, dataActions: [], notDataActions: [] }] };
}

const SCOPE = '/subscriptions/sub-1';

describe('checkOperability', () => {
  it('says yes when the role grants listkeys explicitly', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          permissions(['Microsoft.Web/sites/read', 'Microsoft.Web/sites/host/listkeys/action'])
        )
      );

    await expect(checkOperability(SCOPE, TOKEN, fetchMock)).resolves.toBe('yes');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/providers/Microsoft.Authorization/permissions');
    expect(init.method).toBe('GET');
  });

  it.each([
    ['Owner/Contributor', ['*']],
    ['Website Contributor', ['Microsoft.Web/sites/*']],
    ['a broad Web wildcard', ['Microsoft.Web/*']],
  ])('resolves wildcards: %s grants listkeys', async (_label, actions) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(permissions(actions)));

    await expect(checkOperability(SCOPE, TOKEN, fetchMock)).resolves.toBe('yes');
  });

  /* Reader is the exact trap this whole filter exists for: it can SEE every app
   * but cannot fetch a key, so it can operate nothing. */
  it('says no for Reader, which can see everything but operate nothing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(permissions(['*/read'])));

    await expect(checkOperability(SCOPE, TOKEN, fetchMock)).resolves.toBe('no');
  });

  it('honours notActions subtracting a granted wildcard', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(permissions(['*'], ['Microsoft.Web/sites/host/listkeys/action']))
      );

    await expect(checkOperability(SCOPE, TOKEN, fetchMock)).resolves.toBe('no');
  });

  it('is additive across roles: one granting role is enough', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        value: [
          { actions: ['*/read'], notActions: [] },
          { actions: ['Microsoft.Web/sites/host/listkeys/action'], notActions: [] },
        ],
      })
    );

    await expect(checkOperability(SCOPE, TOKEN, fetchMock)).resolves.toBe('yes');
  });

  it('matches action names case-insensitively, as Azure does', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(permissions(['MICROSOFT.WEB/SITES/HOST/LISTKEYS/ACTION'])));

    await expect(checkOperability(SCOPE, TOKEN, fetchMock)).resolves.toBe('yes');
  });

  it('reports unknown rather than no when the permissions call fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(403, 'denied'));

    await expect(checkOperability(SCOPE, TOKEN, fetchMock)).resolves.toBe('unknown');
  });

  it('reports unknown for a malformed payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ nope: 1 }));

    await expect(checkOperability(SCOPE, TOKEN, fetchMock)).resolves.toBe('unknown');
  });
});

describe('checkOperabilityForApps', () => {
  function appIn(sub: string, n: number): FunctionApp {
    return {
      id: `/subscriptions/${sub}/resourceGroups/RG/providers/Microsoft.Web/sites/func-${String(n)}`,
      name: `func-${String(n)}`,
      resourceGroup: 'RG',
      subscriptionId: sub,
      location: 'westeurope',
      kind: 'functionapp',
      defaultHostName: `func-${String(n)}.azurewebsites.net`,
      state: 'Running',
    };
  }

  /*
   * Roles are normally assigned at subscription/MG scope and inherit, so one
   * check should settle a whole subscription rather than one call per app.
   */
  it('checks once per subscription when the subscription already grants listkeys', async () => {
    const apps = [appIn('sub-1', 1), appIn('sub-1', 2), appIn('sub-1', 3)];
    const fetchMock = alwaysRespond(() =>
      jsonResponse(permissions(['Microsoft.Web/sites/host/listkeys/action']))
    );
    const results = new Map<string, string>();

    await checkOperabilityForApps(apps, TOKEN, (id, kind) => results.set(id, kind), fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([...results.values()]).toEqual(['yes', 'yes', 'yes']);
  });

  it('falls back to per-app checks when the subscription does not grant it', async () => {
    const apps = [appIn('sub-1', 1), appIn('sub-1', 2)];
    const fetchMock = vi
      .fn()
      // Subscription scope: Reader only.
      .mockResolvedValueOnce(jsonResponse(permissions(['*/read'])))
      // func-1 has a per-app assignment; func-2 does not.
      .mockResolvedValueOnce(jsonResponse(permissions(['Microsoft.Web/sites/*'])))
      .mockResolvedValueOnce(jsonResponse(permissions(['*/read'])));
    const results = new Map<string, string>();

    await checkOperabilityForApps(apps, TOKEN, (id, kind) => results.set(id, kind), fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(results.get(apps[0]!.id)).toBe('yes');
    expect(results.get(apps[1]!.id)).toBe('no');
  });

  it('checks each subscription separately', async () => {
    const apps = [appIn('sub-1', 1), appIn('sub-2', 2)];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(permissions(['*'])))
      .mockResolvedValueOnce(jsonResponse(permissions(['*/read'])))
      .mockResolvedValueOnce(jsonResponse(permissions(['*/read'])));
    const results = new Map<string, string>();

    await checkOperabilityForApps(apps, TOKEN, (id, kind) => results.set(id, kind), fetchMock);

    expect(results.get(apps[0]!.id)).toBe('yes');
    expect(results.get(apps[1]!.id)).toBe('no');
  });

  it('handles an empty fleet', async () => {
    const fetchMock = vi.fn();

    await checkOperabilityForApps([], TOKEN, () => undefined, fetchMock);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getTenantName', () => {
  const TENANT = '00000000-0000-0000-0000-000000000000';

  it('resolves the tenant GUID to its display name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        value: [
          { tenantId: 'other', displayName: 'Wrong' },
          { tenantId: TENANT, displayName: 'SureStacks', defaultDomain: 'surestacks.io' },
        ],
      })
    );

    await expect(getTenantName(TENANT, TOKEN, fetchMock)).resolves.toBe('SureStacks');
  });

  it('falls back to the default domain when there is no display name', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ value: [{ tenantId: TENANT, defaultDomain: 'x.onmicrosoft.com' }] })
      );

    await expect(getTenantName(TENANT, TOKEN, fetchMock)).resolves.toBe('x.onmicrosoft.com');
  });

  /* Cosmetic only: a failed lookup must degrade to the GUID, never throw. */
  it('falls back to the GUID when the call fails or the tenant is absent', async () => {
    await expect(
      getTenantName(TENANT, TOKEN, vi.fn().mockResolvedValue(errorResponse(403)))
    ).resolves.toBe(TENANT);
    await expect(
      getTenantName(TENANT, TOKEN, vi.fn().mockResolvedValue(jsonResponse({ value: [] })))
    ).resolves.toBe(TENANT);
    await expect(
      getTenantName(TENANT, TOKEN, vi.fn().mockResolvedValue(jsonResponse({ bad: true })))
    ).resolves.toBe(TENANT);
  });

  /*
   * A 2xx with a non-JSON body (a proxy error page) must resolve to the fallback,
   * never reject: getTenantName is called fire-and-forget, so a rejection here is
   * an unhandled promise rejection.
   */
  it('falls back rather than rejecting when a 200 carries a non-JSON body', async () => {
    const notJson = new Response('<html>gateway error</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    await expect(getTenantName(TENANT, TOKEN, vi.fn().mockResolvedValue(notJson))).resolves.toBe(
      TENANT
    );
  });
});
