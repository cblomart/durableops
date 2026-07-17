<script setup lang="ts">
import type { SignedInUser } from '../auth';
import UserMenu from './UserMenu.vue';

defineProps<{
  user: SignedInUser | null;
  busy: boolean;
  /** System keys currently held in memory — surfaced so the operator can see the tool holds nothing at rest. */
  keysInMemory: number;
  /** Resolved tenant display name, e.g. "SureStacks". */
  tenantName: string;
}>();

defineEmits<{
  refreshRights: [];
  signIn: [];
  signOut: [];
}>();
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="name">DurableOps</span>
    </div>

    <div class="spacer" />

    <template v-if="user">
      <!--
        "Refresh rights" is the post-PIM-activation gesture and the reason this
        tool needs no re-login: it drops every cached key and forces a fresh
        token, so newly activated roles take effect within moments.
      -->
      <button
        class="primary refresh"
        :disabled="busy"
        title="Activated a PIM role? Drops cached keys, forces a fresh token, and re-runs discovery."
        @click="$emit('refreshRights')"
      >
        {{ busy ? 'Refreshing…' : 'Refresh rights' }}
      </button>

      <span
        v-if="keysInMemory > 0"
        class="keys faint"
        :title="`${keysInMemory} system key(s) held in memory only, cleared on sign-out`"
      >
        {{ keysInMemory }} key{{ keysInMemory === 1 ? '' : 's' }} in memory
      </span>
    </template>

    <UserMenu
      :user="user"
      :tenant-name="tenantName"
      @sign-in="$emit('signIn')"
      @sign-out="$emit('signOut')"
    />
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  /* Fixed height so the bar does not reflow between signed-out and signed-in. */
  height: 46px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-raised);
}

.brand {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.name {
  font-weight: 600;
  letter-spacing: 0.2px;
}

.spacer {
  flex: 1;
}

.refresh {
  height: 28px;
  border-radius: 14px;
}

.keys {
  font-size: 11px;
  padding: 2px 6px;
  border: 1px dashed var(--border);
  border-radius: 3px;
}
</style>
