<script setup lang="ts">
import { computed, ref } from 'vue';
import { parseDurableError } from '../triage';

const props = defineProps<{
  /** The instance's `output` (Failed) or terminate reason (Terminated). */
  output: unknown;
  runtimeStatus: string;
}>();

const parsed = computed(() => parseDurableError(props.output));
const copied = ref(false);

async function copy(): Promise<void> {
  const text =
    parsed.value.stack === ''
      ? parsed.value.headline
      : `${parsed.value.headline}\n\n${parsed.value.stack}`;
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    // Clipboard can be blocked (permissions, insecure context); silently no-op.
  }
}

const showStack = ref(false);
</script>

<template>
  <div v-if="parsed.headline !== ''" class="summary" :class="runtimeStatus.toLowerCase()">
    <div class="head">
      <span class="label">{{ runtimeStatus === 'Terminated' ? 'Terminated' : 'Failure' }}</span>
      <span v-if="parsed.failedFunction" class="fn mono">in {{ parsed.failedFunction }}</span>
      <div class="spacer" />
      <button class="copy" @click="copy">{{ copied ? 'Copied' : 'Copy' }}</button>
    </div>

    <p class="headline">{{ parsed.headline }}</p>

    <!-- Stack collapsed by default: it is machine detail, and may hold secrets. -->
    <button v-if="parsed.stack !== ''" class="toggle" @click="showStack = !showStack">
      {{ showStack ? 'Hide detail' : 'Show detail' }}
    </button>
    <pre v-if="showStack && parsed.stack !== ''" class="stack mono">{{ parsed.stack }}</pre>
  </div>
</template>

<style scoped>
.summary {
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px solid var(--danger);
  border-left-width: 3px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--danger) 8%, transparent);
}

.summary.terminated {
  border-color: var(--warn);
  background: color-mix(in srgb, var(--warn) 8%, transparent);
}

.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}

.label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--danger);
}

.summary.terminated .label {
  color: var(--warn);
}

.fn {
  font-size: 12px;
  color: var(--text-dim);
}

.spacer {
  flex: 1;
}

.copy,
.toggle {
  font-size: 11px;
  padding: 2px 8px;
}

.headline {
  margin: 0;
  font-weight: 500;
  white-space: pre-wrap;
  word-break: break-word;
}

.toggle {
  margin-top: 8px;
}

.stack {
  margin: 8px 0 0;
  padding: 8px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 3px;
  max-height: 300px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
