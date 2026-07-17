<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  /** Text to copy. */
  value: string;
  /** Optional accessible label, e.g. "Copy instance ID". */
  label?: string;
}>();

const copied = ref(false);

async function copy(event: MouseEvent): Promise<void> {
  // Rows are clickable; copying must not also open the instance.
  event.stopPropagation();
  try {
    await navigator.clipboard.writeText(props.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1200);
  } catch {
    // Clipboard can be blocked (insecure context / permissions): fail silently.
  }
}
</script>

<template>
  <button
    class="copybtn"
    :class="{ done: copied }"
    :aria-label="label ?? 'Copy'"
    :title="copied ? 'Copied' : (label ?? 'Copy')"
    @click="copy"
  >
    {{ copied ? '✓' : '⧉' }}
  </button>
</template>

<style scoped>
.copybtn {
  padding: 0 5px;
  border: 1px solid transparent;
  background: none;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1;
  border-radius: 3px;
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
