import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadConfig,
  getConfig,
  adminConsentUrl,
  __setConfigForTests,
  ARM_SCOPE,
  ARG_API_VERSION,
  WEB_API_VERSION,
} from '../../src/config';

const VALID = {
  tenantId: '00000000-0000-0000-0000-000000000000',
  clientId: '11111111-1111-1111-1111-111111111111',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  __setConfigForTests(null);
});

describe('constants', () => {
  /*
   * These three strings are the app's entire contract with Azure. Pinning them
   * in a test means a careless edit shows up as a failing test rather than as a
   * 400 in production. Both API versions were verified live during the spike.
   */
  it('requests only delegated ARM user_impersonation', () => {
    expect(ARM_SCOPE).toBe('https://management.azure.com/user_impersonation');
  });

  it('pins the verified api-versions', () => {
    expect(ARG_API_VERSION).toBe('2022-10-01');
    expect(WEB_API_VERSION).toBe('2023-12-01');
  });
});

describe('loadConfig', () => {
  it('fetches and returns a valid config', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(VALID));

    await expect(loadConfig(fetchMock)).resolves.toEqual(VALID);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/config.json');
    // Must never be served from cache: a stale config points at the wrong tenant.
    expect(init.cache).toBe('no-store');
  });

  it('keeps an optional redirectUri when present', async () => {
    const withRedirect = { ...VALID, redirectUri: 'https://ops.example.com' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(withRedirect));

    await expect(loadConfig(fetchMock)).resolves.toEqual(withRedirect);
  });

  it('caches after the first load and does not re-fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(VALID));

    await loadConfig(fetchMock);
    await loadConfig(fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails loudly when config.json is missing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }));

    await expect(loadConfig(fetchMock)).rejects.toThrow(/config\.json/);
  });

  it.each([
    ['a non-object', 'a string'],
    ['a missing tenantId', { clientId: 'x' }],
    ['an empty tenantId', { tenantId: '', clientId: 'x' }],
    ['a missing clientId', { tenantId: 'x' }],
    ['an empty clientId', { tenantId: 'x', clientId: '' }],
    ['a non-string redirectUri', { ...VALID, redirectUri: 42 }],
  ])('rejects %s rather than starting against a wrong tenant', async (_label, body) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));

    await expect(loadConfig(fetchMock)).rejects.toThrow();
  });
});

describe('getConfig', () => {
  it('throws when called before loadConfig resolves', () => {
    expect(() => getConfig()).toThrow(/loadConfig/);
  });

  it('returns the loaded config', async () => {
    await loadConfig(vi.fn().mockResolvedValue(jsonResponse(VALID)));

    expect(getConfig()).toEqual(VALID);
  });
});

describe('multi-tenant config', () => {
  it('makes tenantId optional when multitenant is true', async () => {
    const body = { clientId: 'client-x', multitenant: true };
    const config = await loadConfig(vi.fn().mockResolvedValue(jsonResponse(body)));

    expect(config).toEqual({ tenantId: '', clientId: 'client-x', multitenant: true });
  });

  it('still requires tenantId for a single-tenant deploy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ clientId: 'client-x' }));
    await expect(loadConfig(fetchMock)).rejects.toThrow(/tenantId/);
  });

  it('rejects a non-boolean multitenant', async () => {
    const body = { ...VALID, multitenant: 'yes' };
    await expect(loadConfig(vi.fn().mockResolvedValue(jsonResponse(body)))).rejects.toThrow(
      /multitenant/
    );
  });
});

describe('adminConsentUrl', () => {
  it('targets the named tenant for a single-tenant deploy', async () => {
    await loadConfig(vi.fn().mockResolvedValue(jsonResponse(VALID)));

    const url = new URL(adminConsentUrl('https://ops.example.com'));
    expect(url.pathname).toBe('/00000000-0000-0000-0000-000000000000/adminconsent');
    expect(url.searchParams.get('client_id')).toBe('11111111-1111-1111-1111-111111111111');
    expect(url.searchParams.get('redirect_uri')).toBe('https://ops.example.com');
  });

  it('targets /organizations for a multi-tenant deploy', async () => {
    const body = { clientId: 'client-x', multitenant: true };
    await loadConfig(vi.fn().mockResolvedValue(jsonResponse(body)));

    const url = new URL(adminConsentUrl('https://cblomart.github.io/durableops/'));
    expect(url.pathname).toBe('/organizations/adminconsent');
    expect(url.searchParams.get('client_id')).toBe('client-x');
  });

  it('prefers a configured redirectUri over the passed origin', async () => {
    await loadConfig(
      vi.fn().mockResolvedValue(jsonResponse({ ...VALID, redirectUri: 'https://fixed.example' }))
    );

    const url = new URL(adminConsentUrl('https://ignored.example'));
    expect(url.searchParams.get('redirect_uri')).toBe('https://fixed.example');
  });
});
