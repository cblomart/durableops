import { describe, it, expect, beforeEach, vi } from 'vitest';

const STORAGE_KEY = 'durableops.favorites';

/** Minimal in-memory localStorage. Avoids pulling a whole DOM implementation in for one API. */
function createStorage(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => {
      store.clear();
    }),
    key: vi.fn(() => null),
    length: 0,
  };
}

/**
 * favorites.ts reads localStorage at module scope, so the stub has to be in
 * place before the import — hence resetModules + dynamic import per test.
 */
async function loadFavorites(storage: ReturnType<typeof createStorage>) {
  vi.resetModules();
  vi.stubGlobal('localStorage', storage);
  const module = await import('../../src/favorites');
  return module.useFavorites();
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('useFavorites', () => {
  it('starts empty when nothing was ever saved', async () => {
    const { favorites } = await loadFavorites(createStorage());

    expect(favorites.value).toEqual([]);
  });

  it('restores previously saved favourites', async () => {
    const storage = createStorage({ [STORAGE_KEY]: JSON.stringify(['func-a', 'func-b']) });

    const { favorites, isFavorite } = await loadFavorites(storage);

    expect(favorites.value).toEqual(['func-a', 'func-b']);
    expect(isFavorite('func-a')).toBe(true);
    expect(isFavorite('func-zzz')).toBe(false);
  });

  it('adds and removes a favourite, persisting each change', async () => {
    const storage = createStorage();
    const { favorites, isFavorite, toggleFavorite } = await loadFavorites(storage);

    toggleFavorite('func-a');
    expect(isFavorite('func-a')).toBe(true);
    expect(storage.store.get(STORAGE_KEY)).toBe(JSON.stringify(['func-a']));

    toggleFavorite('func-a');
    expect(isFavorite('func-a')).toBe(false);
    expect(favorites.value).toEqual([]);
    expect(storage.store.get(STORAGE_KEY)).toBe(JSON.stringify([]));
  });

  /*
   * Favourites are a convenience, never a dependency: corrupt or unavailable
   * storage must degrade to an empty list, never break the app list.
   */
  it('ignores corrupt JSON in storage', async () => {
    const storage = createStorage({ [STORAGE_KEY]: '{not json' });

    const { favorites } = await loadFavorites(storage);

    expect(favorites.value).toEqual([]);
  });

  it('drops non-string entries from a hand-edited value', async () => {
    const storage = createStorage({
      [STORAGE_KEY]: JSON.stringify(['func-a', 42, null, 'func-b']),
    });

    const { favorites } = await loadFavorites(storage);

    expect(favorites.value).toEqual(['func-a', 'func-b']);
  });

  it('ignores a stored value that is not an array', async () => {
    const storage = createStorage({ [STORAGE_KEY]: JSON.stringify({ func: true }) });

    const { favorites } = await loadFavorites(storage);

    expect(favorites.value).toEqual([]);
  });

  it('survives storage that throws on read (private mode)', async () => {
    const storage = createStorage();
    storage.getItem.mockImplementation(() => {
      throw new Error('SecurityError');
    });

    const { favorites } = await loadFavorites(storage);

    expect(favorites.value).toEqual([]);
  });

  it('keeps working in-session when storage throws on write (quota exceeded)', async () => {
    const storage = createStorage();
    storage.setItem.mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    const { isFavorite, toggleFavorite } = await loadFavorites(storage);
    toggleFavorite('func-a');

    expect(isFavorite('func-a')).toBe(true);
  });
});
