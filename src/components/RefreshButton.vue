<script setup lang="ts">
defineProps<{
  /** Accessible label, e.g. "Refresh instance". */
  label: string;
  /** Spins the icon while a refresh is in flight. */
  busy?: boolean;
}>();

const emit = defineEmits<{ refresh: [] }>();

function onClick(event: MouseEvent): void {
  // Rows are clickable; a refresh must not also open the object.
  event.stopPropagation();
  emit('refresh');
}
</script>

<template>
  <button
    class="refreshbtn"
    :class="{ spin: busy }"
    :aria-label="label"
    :title="label"
    :disabled="busy"
    @click="onClick"
  >
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  </button>
</template>

<style scoped>
.refreshbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  background: none;
  color: var(--text-faint);
  cursor: pointer;
  vertical-align: middle;
  flex: 0 0 auto;
}

.refreshbtn:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border);
  background: var(--bg-hover);
}

.refreshbtn.spin svg {
  animation: refresh-spin 0.7s linear infinite;
}

@keyframes refresh-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
