<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  /** Text to copy. */
  value: string;
  /** Accessible label, e.g. "Copy instance ID". */
  label: string;
}>();

const copied = ref(false);

async function copy(event: MouseEvent): Promise<void> {
  // Rows and cards are often clickable; copying must not also trigger them.
  event.stopPropagation();
  try {
    await navigator.clipboard.writeText(props.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1400);
  } catch {
    // Clipboard can be blocked (insecure context / permissions): fail silently.
  }
}
</script>

<template>
  <button
    class="copybtn"
    :class="{ done: copied }"
    :aria-label="copied ? 'Copied' : label"
    :title="copied ? 'Copied' : label"
    @click="copy"
  >
    <!-- A standard clipboard glyph (always visible), swapping to a tick on copy. -->
    <svg
      v-if="!copied"
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
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
    <svg
      v-else
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  </button>
</template>

<style scoped>
.copybtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  background: none;
  /* Always visible, but muted until hovered so it never shouts in a dense row. */
  color: var(--text-faint);
  cursor: pointer;
  vertical-align: middle;
  flex: 0 0 auto;
}

.copybtn:hover {
  color: var(--text);
  border-color: var(--border);
  background: var(--bg-hover);
}

.copybtn.done {
  color: var(--ok);
}
</style>
