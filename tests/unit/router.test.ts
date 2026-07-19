import { describe, it, expect } from 'vitest';
import { parseHash, routeToHash, sameRoute, type Route } from '../../src/router';

describe('routeToHash', () => {
  it('serialises the app list as the root hash', () => {
    expect(routeToHash({ view: 'apps' })).toBe('#/');
  });

  it('serialises an app by its name', () => {
    expect(routeToHash({ view: 'app', appKey: 'func-prod-billing' })).toBe(
      '#/app/func-prod-billing'
    );
  });

  it('serialises an instance under its app', () => {
    expect(
      routeToHash({ view: 'instance', appKey: 'func-prod-billing', instanceId: 'abc123' })
    ).toBe('#/app/func-prod-billing/i/abc123');
  });

  it('percent-encodes an instance id with hash-breaking characters', () => {
    const hash = routeToHash({
      view: 'instance',
      appKey: 'func-prod-billing',
      instanceId: 'order/42 #7',
    });
    expect(hash).toBe('#/app/func-prod-billing/i/order%2F42%20%237');
  });
});

describe('parseHash', () => {
  it('reads the app list from an empty or root hash', () => {
    expect(parseHash('')).toEqual({ view: 'apps' });
    expect(parseHash('#/')).toEqual({ view: 'apps' });
    expect(parseHash('#')).toEqual({ view: 'apps' });
  });

  it('reads an app route', () => {
    expect(parseHash('#/app/func-prod-billing')).toEqual({
      view: 'app',
      appKey: 'func-prod-billing',
    });
  });

  it('reads an instance route', () => {
    expect(parseHash('#/app/func-prod-billing/i/abc123')).toEqual({
      view: 'instance',
      appKey: 'func-prod-billing',
      instanceId: 'abc123',
    });
  });

  it('decodes a percent-encoded instance id', () => {
    expect(parseHash('#/app/func-prod-billing/i/order%2F42%20%237')).toEqual({
      view: 'instance',
      appKey: 'func-prod-billing',
      instanceId: 'order/42 #7',
    });
  });

  it('falls back to the app list for an unrecognised hash', () => {
    expect(parseHash('#/nonsense/path')).toEqual({ view: 'apps' });
    expect(parseHash('#/app')).toEqual({ view: 'apps' }); // app segment with no name
  });
});

describe('round-trip and sameRoute', () => {
  const routes: Route[] = [
    { view: 'apps' },
    { view: 'app', appKey: 'func-prod-billing' },
    { view: 'instance', appKey: 'func-prod-billing', instanceId: 'order/42 #7' },
  ];

  it('parseHash(routeToHash(route)) is the identity', () => {
    for (const route of routes) {
      expect(parseHash(routeToHash(route))).toEqual(route);
    }
  });

  it('sameRoute compares by canonical hash', () => {
    expect(sameRoute({ view: 'apps' }, { view: 'apps' })).toBe(true);
    expect(
      sameRoute({ view: 'app', appKey: 'a' }, { view: 'instance', appKey: 'a', instanceId: 'x' })
    ).toBe(false);
  });
});
