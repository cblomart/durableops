/**
 * Favourite function apps.
 *
 * This is the ONLY thing DurableOps ever persists, and it stores names only —
 * never keys, tokens, subscription topology or instance data. A stolen
 * localStorage entry here reveals a list of app names the user cared about and
 * nothing more; it grants no access, since every call is still gated by the
 * user's own Entra token and Azure RBAC.
 */
import { ref, type Ref } from 'vue';

const STORAGE_KEY = 'durableops.favorites';

function read(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    // Corrupt or unavailable storage (private mode, quota, hand-edited value)
    // must never break the app list: favourites are a convenience.
    return [];
  }
}

const favorites: Ref<string[]> = ref(read());

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites.value));
  } catch {
    // Ignore: the in-memory list still works for this session.
  }
}

export function useFavorites(): {
  favorites: Ref<string[]>;
  isFavorite: (name: string) => boolean;
  toggleFavorite: (name: string) => void;
} {
  return {
    favorites,
    isFavorite: (name: string) => favorites.value.includes(name),
    toggleFavorite: (name: string) => {
      favorites.value = favorites.value.includes(name)
        ? favorites.value.filter((n) => n !== name)
        : [...favorites.value, name];
      persist();
    },
  };
}
