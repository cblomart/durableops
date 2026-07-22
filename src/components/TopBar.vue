<script setup lang="ts">
import type { SignedInUser } from '../auth';
import UserMenu from './UserMenu.vue';
import RefreshButton from './RefreshButton.vue';

defineProps<{
  user: SignedInUser | null;
  busy: boolean;
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
        tool needs no re-login: it forces a fresh token and re-runs discovery, so
        newly activated roles take effect within moments.
      -->
      <span title="Activated a PIM role? Forces a fresh token and re-runs discovery.">
        <RefreshButton
          label="Refresh rights"
          text="Refresh rights"
          :busy="busy"
          @refresh="$emit('refreshRights')"
        />
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
</style>
