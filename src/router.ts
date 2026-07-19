/**
 * A deliberately tiny hash router — no dependency, no history abstraction.
 *
 * The whole app is three views, so a URL only needs to name which app and which
 * instance are open. That makes a link shareable ("here's the failing instance")
 * and survives a reload, without a router library or a server that rewrites paths
 * (there is no server — this is a static SPA).
 *
 * The route key for an app is its NAME, not its ARM id: a Function App name is a
 * globally unique DNS label (it becomes `{name}.azurewebsites.net`), so it is
 * both unambiguous and URL-clean, where the full ARM id is neither.
 *
 * This module is pure: it parses and serialises strings and touches no browser
 * globals. App.vue owns `window.location` and the `hashchange` listener, so this
 * stays trivial to unit-test.
 */

export type Route =
  | { view: 'apps' }
  | { view: 'app'; appKey: string }
  | { view: 'instance'; appKey: string; instanceId: string };

/**
 * Serialise a route to a location hash, e.g. `#/app/func-prod-billing/i/abc123`.
 * Both parts are percent-encoded: an instance id is arbitrary user text and can
 * contain characters (`/`, `#`, spaces) that would otherwise corrupt the hash.
 */
export function routeToHash(route: Route): string {
  if (route.view === 'apps') return '#/';
  const base = `#/app/${encodeURIComponent(route.appKey)}`;
  if (route.view === 'instance') {
    return `${base}/i/${encodeURIComponent(route.instanceId)}`;
  }
  return base;
}

/**
 * Parse a location hash back to a route. Anything unrecognised falls back to the
 * app list, so a hand-mangled URL degrades to a safe view rather than an error.
 */
export function parseHash(hash: string): Route {
  const segments = hash
    .replace(/^#/, '')
    .replace(/^\//, '')
    .split('/')
    .filter((segment) => segment.length > 0);

  if (segments[0] === 'app' && segments[1] !== undefined) {
    const appKey = decodeURIComponent(segments[1]);
    if (segments[2] === 'i' && segments[3] !== undefined) {
      return { view: 'instance', appKey, instanceId: decodeURIComponent(segments[3]) };
    }
    return { view: 'app', appKey };
  }
  return { view: 'apps' };
}

/** True when two routes denote the same view — the loop-breaker for hash<->state sync. */
export function sameRoute(a: Route, b: Route): boolean {
  return routeToHash(a) === routeToHash(b);
}
