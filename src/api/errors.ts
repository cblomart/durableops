/**
 * The single error vocabulary for every Azure call DurableOps makes.
 *
 * Both API modules (`arm.ts`, `durable.ts`) return `Result<T>` and never throw
 * for an expected condition. Callers switch on `error.kind`; adding a variant
 * here forces every call site to handle it (TypeScript exhaustiveness), which
 * is the point.
 */

/** The caller has no usable token, or the token was rejected (HTTP 401). */
export interface AuthError {
  kind: 'auth';
  message: string;
}

/**
 * Azure RBAC said no (HTTP 403). This is the PIM case: the user is
 * authenticated but their role is not currently active. Recoverable by
 * activating the role and clicking "Refresh rights" — no re-login needed,
 * because Azure evaluates RBAC server-side on every call.
 */
export interface ForbiddenError {
  kind: 'forbidden';
  message: string;
  /** Resource the call was denied on, for a precise remediation message. */
  scope?: string;
}

/**
 * The webhook route returned 404: the app is a function app but has no Durable
 * Task extension (or no task hub). Not an error the operator can fix — we mark
 * the app "not durable" in the list and move on.
 */
export interface NotDurableError {
  kind: 'notDurable';
  message: string;
}

/**
 * The browser refused to hand us the response, so `fetch` threw with no status
 * and no headers to inspect.
 *
 * Two different faults land here and the browser cannot tell them apart:
 *   1. the app does not list our origin in its CORS allow-list (most common), or
 *   2. the app has Easy Auth on, and its redirect/401 carries no CORS headers.
 *
 * Because the distinction is invisible from a browser, `describeError` names
 * both causes rather than confidently pointing at the wrong one. Only the Node
 * integration tests — where CORS does not apply — can positively identify Easy
 * Auth and return `EasyAuthError` instead.
 */
export interface CorsError {
  kind: 'cors';
  message: string;
}

/**
 * The function app has App Service Authentication ("Easy Auth") enabled.
 *
 * Easy Auth sits in front of the Functions host, so it rejects or redirects the
 * request *before* the runtime ever evaluates the `?code=` system key. A valid
 * key still yields 401/302. Verified live during the design spike against a real
 * app with `unauthenticatedClientAction: RedirectToLoginPage`.
 *
 * From a browser this is nastier than it sounds: the 302 to login.microsoftonline.com
 * carries no CORS headers, so `fetch` reports an opaque network failure that is
 * indistinguishable from a plain CORS misconfiguration — but the remediation is
 * completely different (exclude the durabletask webhook path from Easy Auth, or
 * accept that the app is unreachable from a browser-only tool). We keep it as a
 * distinct variant so the UI can offer the right fix instead of sending the
 * operator down the CORS path.
 */
export interface EasyAuthError {
  kind: 'easyAuth';
  message: string;
}

/** Anything else, including 429. `retryAfterSeconds` is set when Azure sent Retry-After. */
export interface HttpError {
  kind: 'http';
  status: number;
  message: string;
  retryAfterSeconds?: number;
}

export type ApiError =
  AuthError | ForbiddenError | NotDurableError | CorsError | EasyAuthError | HttpError;

export type Result<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T>(error: ApiError): Result<T> {
  return { ok: false, error };
}

/** True when the operator can plausibly fix this by activating a PIM role. */
export function isPimRecoverable(error: ApiError): boolean {
  return error.kind === 'forbidden' || error.kind === 'auth';
}

/**
 * Human-facing text. Kept next to the types so every surface phrases a given
 * failure identically, and so the PIM wording exists in exactly one place.
 */
export function describeError(error: ApiError): string {
  switch (error.kind) {
    case 'auth':
      return 'Your session expired or the token was rejected. Sign in again.';
    case 'forbidden':
      return "You don't have permission to operate on this app — activate your PIM role, then click Refresh rights.";
    case 'notDurable':
      return 'This app has no Durable Functions extension, so there is nothing to troubleshoot here.';
    case 'cors':
      // The browser gives us no status or headers here, so this message must not
      // pretend to know which of the two causes it is: sending an operator to
      // fix CORS on an Easy Auth app wastes an incident.
      return (
        'The browser blocked this request before DurableOps could read the response. ' +
        "Either the app's CORS allow-list is missing this origin (most likely), or the app " +
        'has App Service Authentication (Easy Auth) enabled, which rejects the call before ' +
        'the Durable Functions runtime sees it. See "CORS prerequisite" and "Easy Auth" in the README.'
      );
    case 'easyAuth':
      return 'This app sits behind App Service Authentication (Easy Auth), which rejects the request before the Durable Functions runtime sees it. A valid system key cannot get past it — see "Easy Auth" in the README.';
    case 'http':
      return error.status === 429
        ? `Azure is throttling this request. Retry in ${String(error.retryAfterSeconds ?? 30)}s.`
        : `Azure returned HTTP ${String(error.status)}: ${error.message}`;
  }
}
