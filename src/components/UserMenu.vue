<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue';
import type { SignedInUser } from '../auth';

const props = defineProps<{
  user: SignedInUser | null;
  /** Resolved tenant display name, e.g. "SureStacks". Falls back to the GUID. */
  tenantName: string;
}>();

defineEmits<{ signIn: []; signOut: [] }>();

const open = ref(false);
const root = useTemplateRef<HTMLElement>('root');

/**
 * Initials, the way Microsoft's persona control renders an account with no photo.
 *
 * A real profile photo would need Microsoft Graph (`User.Read` + /me/photo),
 * and this app deliberately holds only the ARM scope — one delegated permission
 * is a meaningful part of the security story, and a picture is not worth
 * widening it. Initials are the same fallback Microsoft itself uses.
 */
const initials = computed<string>(() => {
  const source = props.user?.name ?? props.user?.upn ?? '';
  const words = source
    .replace(/@.*$/, '') // "cedric@surestacks.io" -> "cedric"
    .split(/[\s._-]+/)
    .filter((word) => word.length > 0);

  // Intl.Segmenter takes the first *grapheme*, so accented and non-Latin names
  // ("Cédric", "Łukasz", an emoji display name) yield one whole character
  // rather than a broken half of a surrogate pair.
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const firstGrapheme = (word: string): string => [...segmenter.segment(word)][0]?.segment ?? '';

  const joined = words.slice(0, 2).map(firstGrapheme).join('');
  return (joined === '' ? '?' : joined).toUpperCase();
});

/** Deterministic hue per user, so the same person always gets the same colour. */
const hue = computed<number>(() => {
  const source = props.user?.upn ?? '';
  let hash = 0;
  for (const char of source) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
});

function close(): void {
  open.value = false;
}

function onDocumentClick(event: MouseEvent): void {
  if (root.value !== null && !root.value.contains(event.target as Node)) close();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') close();
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div ref="root" class="usermenu">
    <!--
      Signed out: a pill the same height as the avatar, in the same slot, so the
      bar keeps its shape across the sign-in transition instead of reflowing.
    -->
    <button v-if="user === null" class="signin-pill" @click="$emit('signIn')">Sign in</button>

    <template v-else>
      <button
        class="avatar"
        :style="{ background: `hsl(${hue} 55% 42%)` }"
        :aria-label="`Account: ${user.upn}`"
        :aria-expanded="open"
        aria-haspopup="menu"
        :title="user.upn"
        @click="open = !open"
      >
        {{ initials }}
      </button>

      <div v-if="open" class="flyout" role="menu">
        <div class="who">
          <span class="avatar big" :style="{ background: `hsl(${hue} 55% 42%)` }">
            {{ initials }}
          </span>
          <div class="who-text">
            <span class="name">{{ user.name }}</span>
            <span class="upn faint">{{ user.upn }}</span>
            <span class="tenant faint">{{ tenantName }}</span>
          </div>
        </div>
        <button class="signout" role="menuitem" @click="$emit('signOut')">Sign out</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.usermenu {
  position: relative;
  display: flex;
  align-items: center;
}

.avatar {
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 50%;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex: 0 0 auto;
}

.avatar:hover {
  filter: brightness(1.15);
}

.avatar.big {
  width: 40px;
  height: 40px;
  font-size: 14px;
  cursor: default;
}

/* Same 28px height as the avatar: the top bar must not jump on sign-in. */
.signin-pill {
  height: 28px;
  padding: 0 14px;
  border-radius: 14px;
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 500;
}

.signin-pill:hover {
  filter: brightness(1.1);
  border-color: var(--accent);
}

.flyout {
  position: absolute;
  top: 34px;
  right: 0;
  z-index: 20;
  min-width: 240px;
  padding: 12px;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 6px 24px rgb(0 0 0 / 28%);
}

.who {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.who-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.35;
}

.name {
  font-weight: 600;
}

.upn,
.tenant {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.signout {
  width: 100%;
  text-align: center;
}
</style>
