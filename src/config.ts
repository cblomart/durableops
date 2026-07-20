/**
 * Runtime configuration.
 *
 * Nothing here is baked into the bundle: `config.json` is generated per
 * environment at deploy time (see infra/ and the deploy workflow) and fetched
 * before the app mounts. That keeps one build artifact promotable across
 * environments, and keeps tenant/client IDs out of git.
 *
 * None of these values are secrets — a public client ID and tenant ID are
 * discoverable by design. The SPA has no client secret because it cannot hold
 * one. This module exists for deploy-time injection, not confidentiality.
 */

export interface AppConfig {
  /**
   * Entra tenant ID (GUID) or domain for a single-tenant deployment. Unused when
   * `multitenant` is true — sign-in then goes through the `/organizations`
   * authority and the tenant is discovered from the signed-in account.
   */
  tenantId: string;
  /** Application (client) ID of the DurableOps SPA registration. */
  clientId: string;
  /**
   * Multi-tenant deployment: any Entra organisation's users can sign in (the app
   * registration must be AzureADMultipleOrgs). The app still only ever acts as
   * the signed-in user with their own Azure RBAC — this only widens *who* may
   * sign in, not what the app can do. Used by the public GitHub Pages build.
   */
  multitenant?: boolean;
  /**
   * Redirect URI registered on the SPA platform of the app registration.
   * Defaults to the current origin, which is correct for every normal deploy.
   */
  redirectUri?: string;
}

export const ARM_SCOPE = 'https://management.azure.com/user_impersonation';
export const ARM_BASE = 'https://management.azure.com';

/**
 * API versions are pinned deliberately.
 *
 * Newer stable versions exist (verified against the live Microsoft.Web and
 * Microsoft.ResourceGraph providers during the design spike: sites is at
 * 2026-03-15, ARG at 2024-04-01). We stay on these older, widely-deployed
 * versions because both were confirmed working live and neither call needs
 * anything the newer versions add. Bump only with a live re-test.
 */
export const ARG_API_VERSION = '2022-10-01';
export const WEB_API_VERSION = '2023-12-01';
/** Microsoft.Authorization/permissions — used to ask what the signed-in user may do. Verified live. */
export const AUTH_API_VERSION = '2022-04-01';
/** ARM /tenants — resolves a tenant GUID to its display name. Verified live. */
export const TENANTS_API_VERSION = '2022-12-01';

let cached: AppConfig | null = null;

/** A required, non-empty string. */
function required(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`config.json: "${key}" is required`);
  }
  return value;
}

/** An optional string: absent is fine, wrong type is not. */
function optional(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`config.json: "${key}" must be a string when present`);
  }
  return value;
}

/** An optional boolean: absent is fine, wrong type is not. */
function optionalBool(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`config.json: "${key}" must be a boolean when present`);
  }
  return value;
}

function validate(raw: unknown): AppConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config.json must be a JSON object');
  }
  const record = raw as Record<string, unknown>;

  const multitenant = optionalBool(record, 'multitenant') === true;
  const redirectUri = optional(record, 'redirectUri');
  // A single-tenant deploy must name its tenant; a multi-tenant one signs in via
  // /organizations, so tenantId is not needed and defaults to empty.
  const tenantId = multitenant
    ? (optional(record, 'tenantId') ?? '')
    : required(record, 'tenantId');

  return {
    tenantId,
    clientId: required(record, 'clientId'),
    ...(multitenant ? { multitenant: true } : {}),
    ...(redirectUri === undefined ? {} : { redirectUri }),
  };
}

/**
 * The Entra admin-consent URL for this app: a Global/Privileged Role admin opens
 * it to grant the Azure Service Management permission for their whole tenant, so
 * users who cannot self-consent can still be onboarded. Built from the client ID
 * — no secret involved. `/organizations` when multi-tenant, else the named tenant.
 */
export function adminConsentUrl(origin: string): string {
  const config = getConfig();
  const authority = config.multitenant === true ? 'organizations' : config.tenantId;
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri ?? origin,
  });
  return `https://login.microsoftonline.com/${authority}/adminconsent?${params.toString()}`;
}

/**
 * Fetch and validate config.json. Called once from main.ts before mount; a
 * failure here is fatal and surfaces as a static error page rather than a
 * half-initialised app pointed at the wrong tenant.
 */
export async function loadConfig(fetchImpl: typeof fetch = fetch): Promise<AppConfig> {
  if (cached !== null) return cached;

  const response = await fetchImpl('/config.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(
      `Could not load /config.json (HTTP ${String(response.status)}). ` +
        'This file is generated at deploy time; see README "Deployment".'
    );
  }
  cached = validate(await response.json());
  return cached;
}

export function getConfig(): AppConfig {
  if (cached === null) {
    throw new Error('loadConfig() must resolve before getConfig() is called');
  }
  return cached;
}

/** Test seam only. */
export function __setConfigForTests(config: AppConfig | null): void {
  cached = config;
}
