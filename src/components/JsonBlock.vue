<script setup lang="ts">
import { computed, ref } from 'vue';
import CopyButton from './CopyButton.vue';

const props = withDefaults(
  defineProps<{
    label: string;
    value: unknown;
    /** Payloads longer than this start collapsed — big inputs otherwise bury the page. */
    collapseOver?: number;
  }>(),
  { collapseOver: 400 }
);

const pretty = computed<string>(() => {
  if (props.value === null || props.value === undefined) return '';
  if (typeof props.value === 'string') {
    // Durable payloads are often JSON *strings*. Show the structure when we can.
    try {
      return JSON.stringify(JSON.parse(props.value), null, 2);
    } catch {
      return props.value;
    }
  }
  try {
    return JSON.stringify(props.value, null, 2);
  } catch {
    // JSON.stringify only throws on cycles or BigInt. Say so, rather than
    // rendering a useless "[object Object]" at an operator mid-incident.
    return '<payload could not be displayed: not serialisable as JSON>';
  }
});

const isEmpty = computed(() => pretty.value === '');
const isLarge = computed(() => pretty.value.length > props.collapseOver);
const expanded = ref(false);
const show = computed(() => !isLarge.value || expanded.value);
</script>

<template>
  <section class="json">
    <header>
      <span class="label">{{ label }}</span>
      <span v-if="isEmpty" class="faint">—</span>
      <button v-else-if="isLarge" class="toggle" @click="expanded = !expanded">
        {{ expanded ? 'Collapse' : `Expand (${pretty.length.toLocaleString()} chars)` }}
      </button>
      <!-- Copy the payload, the way a markdown renderer offers on a code block. -->
      <CopyButton v-if="!isEmpty" :value="pretty" :label="`Copy ${label.toLowerCase()}`" />
    </header>
    <pre v-if="!isEmpty && show" class="mono">{{ pretty }}</pre>
  </section>
</template>

<style scoped>
.json {
  margin-bottom: 10px;
}

header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 3px;
}

.label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-faint);
}

.toggle {
  padding: 0 6px;
  font-size: 11px;
}

pre {
  margin: 0;
  padding: 8px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
