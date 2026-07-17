/**
 * Entra sign-in and ARM token acquisition.
 *
 * DurableOps has no identity of its own: every Azure call is made with the
 * signed-in user's token, so Azure enforces that user's real RBAC on every
 * request. There is no client secret (a SPA cannot hold one) and no backend to
 * hold one for us — auth code + PKCE only.
 *
 * MSAL is used directly rather than through a Vue wrapper: msal-browser is
 * framework-agnostic and the surface we need is four calls wide.
 */
import {
  PublicClientApplication,
  InteractionRequiredAuthError,
  BrowserCacheLocation,
  type AccountInfo,
  type AuthenticationResult,
  type Configuration,
} from '@azure/msal-browser';
import { ARM_SCOPE, getConfig } from './config';
import { clearKeyCache } from './api/arm';

export interface SignedInUser {
  /** UPN / username. Shown in the top bar and prefixed onto every action reason. */
  upn: string;
  tenantId: string;
  name: string;
}

let msal: PublicClientApplication | null = null;

/**
 * Injected fake auth, for the deterministic Playwright layer only.
 *
 * The alternative — hand-seeding MSAL's cache in sessionStorage — means depending
 * on an undocumented internal schema that changes between MSAL versions. That is
 * the same class of mistake as reading the DurableTask table directly, so we do
 * not do it here either.
 *
 * This branch does not exist in the production bundle: Vite statically replaces
 * `import.meta.env.MODE`, so `'production' !== 'e2e'` folds to a constant and the
 * whole path is dead-code-eliminated. CI greps `dist/` to prove it (see ci.yml).
 */
interface TestAuth {
  upn: string;
  tenantId: string;
  name: string;
  token: string;
}

declare global {
  interface Window {
    __durableOpsTestAuth?: TestAuth;
  }
}

function testAuth(): TestAuth | undefined {
  if (import.meta.env.MODE !== 'e2e') return undefined;
  return window.__durableOpsTestAuth;
}

function buildMsalConfig(): Configuration {
  const { tenantId, clientId, redirectUri } = getConfig();
  return {
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      redirectUri: redirectUri ?? window.location.origin,
      postLogoutRedirectUri: redirectUri ?? window.location.origin,
    },
    cache: {
      /*
       * sessionStorage, not memoryStorage — a forced choice, not a preference.
       *
       * MSAL cannot perform the redirect flow with memoryStorage: it throws
       * `in_mem_redirect_unavailable`, because auth state must survive the full
       * page navigation to Entra and back, and memory does not. Redirect is
       * required here (popup-only auth breaks whenever a browser blocks the
       * popup, which is not acceptable for an incident tool).
       *
       * sessionStorage is the tightest cache that supports redirect:
       *   - scoped to this tab; closing it discards the tokens
       *   - NOT shared across tabs, unlike localStorage
       *   - never read or written by our own code (the ESLint restricted-globals
       *     rule still forbids that); only MSAL's own cache uses it
       *
       * What this does NOT change: DurableOps still has no client secret and no
       * identity of its own, and Function system keys remain memory-only in
       * arm.ts — they never touch any browser storage.
       */
      cacheLocation: BrowserCacheLocation.SessionStorage,
    },
    system: {
      loggerOptions: {
        // No telemetry of any kind. MSAL logging stays off in all environments.
        loggerCallback: () => undefined,
        piiLoggingEnabled: false,
      },
    },
  };
}

/** Must resolve before any other function here. Handles the redirect leg of the PKCE flow. */
export async function initAuth(): Promise<void> {
  if (testAuth() !== undefined) return;
  const instance = new PublicClientApplication(buildMsalConfig());
  await instance.initialize();
  await instance.handleRedirectPromise();
  msal = instance;
}

function client(): PublicClientApplication {
  if (msal === null) throw new Error('initAuth() must resolve before using auth');
  return msal;
}

function activeAccount(): AccountInfo | null {
  const instance = client();
  const active = instance.getActiveAccount();
  if (active !== null) return active;

  const [first] = instance.getAllAccounts();
  if (first !== undefined) {
    instance.setActiveAccount(first);
    return first;
  }
  return null;
}

export function getSignedInUser(): SignedInUser | null {
  const fake = testAuth();
  if (fake !== undefined) {
    return { upn: fake.upn, tenantId: fake.tenantId, name: fake.name };
  }

  const account = activeAccount();
  if (account === null) return null;
  return {
    upn: account.username,
    tenantId: account.tenantId,
    name: account.name ?? account.username,
  };
}

export async function signIn(): Promise<void> {
  await client().loginRedirect({ scopes: [ARM_SCOPE] });
}

export async function signOut(): Promise<void> {
  // Drop in-memory system keys before the redirect so a key cannot outlive the
  // session even if the redirect is slow or cancelled.
  clearKeyCache();
  await client().logoutRedirect();
}

/**
 * Acquire an ARM access token.
 *
 * `forceRefresh` is the post-PIM-activation path: it bypasses the MSAL token
 * cache so the new token carries freshly activated role claims. Azure evaluates
 * RBAC server-side per call, so this is belt-and-braces — but a cached token is
 * also cached *state*, and refreshing it makes "Refresh rights" honest.
 *
 * Silent acquisition falls back to a redirect only when Entra says interaction
 * is genuinely required; any other failure is surfaced, not papered over.
 */
export async function getArmToken(forceRefresh = false): Promise<string> {
  const fake = testAuth();
  if (fake !== undefined) return fake.token;

  const account = activeAccount();
  if (account === null) throw new Error('Not signed in');

  try {
    const result: AuthenticationResult = await client().acquireTokenSilent({
      scopes: [ARM_SCOPE],
      account,
      forceRefresh,
    });
    return result.accessToken;
  } catch (error: unknown) {
    if (error instanceof InteractionRequiredAuthError) {
      await client().acquireTokenRedirect({ scopes: [ARM_SCOPE], account });
      // acquireTokenRedirect navigates away; this line is unreachable in a
      // browser but keeps the function's return type honest.
      throw new Error('Redirecting for interactive sign-in', { cause: error });
    }
    throw error;
  }
}

/** Test seam only. */
export function __setMsalForTests(instance: PublicClientApplication | null): void {
  msal = instance;
}
