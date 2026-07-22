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
 * Anything else, including 429 and a status-0 network failure.
 *
 * A `status: 0` here is a real transport failure (offline, DNS, blocked by
 * policy) — never a CORS rejection: every Azure call goes through
 * management.azure.com, which sends permissive CORS headers, so the browser
 * never blocks the cross-origin request the way a direct app-hostname call could.
 *
 * `retryAfterSeconds` is set when Azure sent Retry-After.
 */
export interface HttpError {
  kind: 'http';
  status: number;
  message: string;
  retryAfterSeconds?: number;
}

export type ApiError = AuthError | ForbiddenError | NotDurableError | HttpError;

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
    case 'http':
      if (error.status === 429) {
        return `Azure is throttling this request. Retry in ${String(error.retryAfterSeconds ?? 30)}s.`;
      }
      if (error.status === 0) {
        return 'Could not reach Azure (management.azure.com). Check your connection and try again.';
      }
      return `Azure returned HTTP ${String(error.status)}: ${error.message}`;
  }
}
