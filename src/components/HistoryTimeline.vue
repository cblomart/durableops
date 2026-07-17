<script setup lang="ts">
import { computed, ref, useTemplateRef, nextTick } from 'vue';
import type { HistoryEvent } from '../api/durable';
import {
  failureIndices,
  failureIndicesWithContext,
  gapBefore,
  isFailureEvent,
  parseDurableError,
} from '../triage';

const props = defineProps<{
  events: HistoryEvent[];
  /** Index the "possibly stuck" hint points at, or -1. */
  stuckIndex: number;
}>();

const failuresOnly = ref(false);
const rowsRef = useTemplateRef<HTMLElement>('rows');

/** Which rows are expanded to show their payload. Investigation is per-event. */
const expanded = ref<Set<number>>(new Set());

const failures = computed(() => failureIndices(props.events));
const contextIndices = computed(() => failureIndicesWithContext(props.events));

/** Position within the failure list, so ◀/▶ can walk between failures. */
const cursor = ref(0);

interface Row {
  index: number;
  event: HistoryEvent;
  gap: string;
  failed: boolean;
  /** The event's own payload (activity result, or a failure's message), pretty-printed. */
  payload: string;
}

function payloadOf(event: HistoryEvent): string {
  if (event.reason !== undefined || event.details !== undefined) {
    const parsed = parseDurableError(event.reason ?? event.details);
    return parsed.stack !== '' ? `${parsed.headline}\n\n${parsed.stack}` : parsed.headline;
  }
  if (event.result === null || event.result === undefined) return '';
  return typeof event.result === 'string' ? event.result : JSON.stringify(event.result, null, 2);
}

const rows = computed<Row[]>(() => {
  const keep = contextIndices.value;
  return props.events
    .map((event, index) => ({
      index,
      event,
      gap: gapBefore(props.events, index),
      failed: isFailureEvent(event),
      payload: payloadOf(event),
    }))
    .filter((row) => !failuresOnly.value || keep.has(row.index));
});

function toggle(index: number): void {
  const next = new Set(expanded.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  expanded.value = next;
}

async function scrollTo(index: number): Promise<void> {
  // Turning the filter off first guarantees the target row exists to scroll to.
  if (failuresOnly.value && !contextIndices.value.has(index)) failuresOnly.value = false;
  await nextTick();
  const target = rowsRef.value?.querySelector(`[data-index="${String(index)}"]`);
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** Walk to the previous/next failure and bring it into view. */
async function step(delta: number): Promise<void> {
  if (failures.value.length === 0) return;
  const count = failures.value.length;
  cursor.value = (cursor.value + delta + count) % count;
  const index = failures.value[cursor.value];
  if (index !== undefined) await scrollTo(index);
}
</script>

<template>
  <section class="timeline">
    <header class="bar">
      <span class="title">History</span>
      <span class="faint">{{ events.length }} event{{ events.length === 1 ? '' : 's' }}</span>

      <div class="spacer" />

      <!--
        Failure navigation is for *investigation*, not entry: the summary card
        already brought the operator to the error. These let them walk between
        failures (retries produce several) and loop back through the run.
      -->
      <template v-if="failures.length > 0">
        <span class="failnav">
          <button aria-label="Previous failure" title="Previous failure" @click="step(-1)">
            ◀
          </button>
          <span class="faint">failure {{ cursor + 1 }} / {{ failures.length }}</span>
          <button aria-label="Next failure" title="Next failure" @click="step(1)">▶</button>
        </span>
        <label class="only">
          <input v-model="failuresOnly" type="checkbox" />
          Failures only
        </label>
      </template>
    </header>

    <p v-if="events.length === 0" class="empty muted">
      No history. The instance may not have started yet, or its history was purged.
    </p>

    <ol v-else ref="rows" class="rows">
      <li
        v-for="row in rows"
        :key="row.index"
        :data-index="row.index"
        class="row"
        :class="{
          failed: row.failed,
          dim: failuresOnly && !row.failed,
          stuck: row.index === stuckIndex,
        }"
      >
        <span class="gap faint mono">{{ row.gap }}</span>
        <span class="dot" />
        <div class="body">
          <button
            class="line"
            :class="{ clickable: row.payload !== '' }"
            :disabled="row.payload === ''"
            :aria-expanded="expanded.has(row.index)"
            @click="toggle(row.index)"
          >
            <span v-if="row.payload !== ''" class="chevron">{{
              expanded.has(row.index) ? '▾' : '▸'
            }}</span>
            <span class="type">{{ row.event.eventType }}</span>
            <span v-if="row.event.functionName" class="fn mono">{{ row.event.functionName }}</span>
            <span class="ts faint mono">{{ row.event.timestamp }}</span>
          </button>

          <!--
            Payload is collapsed by default: activity inputs/outputs and stacks
            can carry PII or secrets, and an operator screenshotting a ticket
            should reveal them deliberately, not by default.
          -->
          <pre v-if="expanded.has(row.index)" class="payload mono">{{ row.payload }}</pre>
        </div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.timeline {
  margin-top: 12px;
}

.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-faint);
}

.spacer {
  flex: 1;
}

.failnav {
  display: flex;
  align-items: center;
  gap: 6px;
}

.failnav button {
  padding: 1px 7px;
  border-color: var(--danger);
  color: var(--danger);
}

.only {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  cursor: pointer;
}

.empty {
  padding: 12px 2px;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.row {
  display: grid;
  grid-template-columns: 62px 12px 1fr;
  align-items: start;
  gap: 8px;
  padding: 3px 0;
  border-left: 2px solid transparent;
}

.row.failed {
  border-left-color: var(--danger);
  background: color-mix(in srgb, var(--danger) 7%, transparent);
}

.row.stuck {
  border-left-color: var(--warn);
  background: color-mix(in srgb, var(--warn) 8%, transparent);
}

.row.dim {
  opacity: 0.5;
}

.gap {
  text-align: right;
  font-size: 11px;
  padding-top: 4px;
}

.dot {
  width: 7px;
  height: 7px;
  margin-top: 7px;
  border-radius: 50%;
  background: var(--border);
}

.row.failed .dot {
  background: var(--danger);
}

.row.stuck .dot {
  background: var(--warn);
}

.line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  width: 100%;
  padding: 2px 0;
  border: none;
  background: none;
  text-align: left;
  color: inherit;
}

.line.clickable {
  cursor: pointer;
}

.line:disabled {
  cursor: default;
}

.chevron {
  color: var(--text-faint);
  font-size: 10px;
}

.type {
  font-weight: 500;
}

.row.failed .type {
  color: var(--danger);
}

.ts {
  font-size: 11px;
}

.payload {
  margin: 3px 0 6px;
  padding: 6px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 3px;
  max-height: 280px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.row.failed .payload {
  border-color: var(--danger);
}
</style>
