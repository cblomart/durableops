import { describe, it, expect } from 'vitest';
import { describeError, isPimRecoverable, ok, err, type ApiError } from '../../src/api/errors';

describe('Result helpers', () => {
  it('wraps a value', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it('wraps an error', () => {
    const error: ApiError = { kind: 'auth', message: 'nope' };
    expect(err(error)).toEqual({ ok: false, error });
  });
});

describe('isPimRecoverable', () => {
  it('treats 403 as recoverable by activating a PIM role', () => {
    expect(isPimRecoverable({ kind: 'forbidden', message: '' })).toBe(true);
  });

  it('treats an auth failure as recoverable by signing in again', () => {
    expect(isPimRecoverable({ kind: 'auth', message: '' })).toBe(true);
  });

  it.each<ApiError>([
    { kind: 'notDurable', message: '' },
    { kind: 'cors', message: '' },
    { kind: 'easyAuth', message: '' },
    { kind: 'http', status: 500, message: '' },
  ])('does not offer a PIM prompt for $kind, which PIM cannot fix', (error) => {
    expect(isPimRecoverable(error)).toBe(false);
  });
});

describe('describeError', () => {
  it('points a 403 at PIM activation and the Refresh rights button', () => {
    const text = describeError({ kind: 'forbidden', message: 'denied' });
    expect(text).toContain('PIM role');
    expect(text).toContain('Refresh rights');
  });

  it('sends a CORS failure to the CORS remediation, not to PIM', () => {
    const text = describeError({ kind: 'cors', message: '' });
    expect(text).toContain('CORS');
    expect(text).not.toContain('PIM');
  });

  /*
   * Easy Auth and CORS both surface as opaque browser failures, so the two
   * messages must never be confusable: they have completely different fixes.
   */
  it('distinguishes Easy Auth from a plain CORS misconfiguration', () => {
    const text = describeError({ kind: 'easyAuth', message: '' });
    expect(text).toContain('Easy Auth');
    expect(text).toContain('system key');
    expect(text).not.toBe(describeError({ kind: 'cors', message: '' }));
  });

  it('reports Retry-After seconds on a 429', () => {
    const text = describeError({
      kind: 'http',
      status: 429,
      message: 'throttled',
      retryAfterSeconds: 42,
    });
    expect(text).toContain('42s');
  });

  it('falls back to a default delay when a 429 carried no Retry-After', () => {
    expect(describeError({ kind: 'http', status: 429, message: 'throttled' })).toContain('30s');
  });

  it('surfaces the status and body for an unexpected HTTP error', () => {
    const text = describeError({ kind: 'http', status: 503, message: 'backend down' });
    expect(text).toContain('503');
    expect(text).toContain('backend down');
  });

  it('explains that a non-durable app has nothing to troubleshoot', () => {
    expect(describeError({ kind: 'notDurable', message: '' })).toContain('Durable Functions');
  });

  it('tells an expired session to sign in again', () => {
    expect(describeError({ kind: 'auth', message: '' })).toContain('Sign in again');
  });
});
