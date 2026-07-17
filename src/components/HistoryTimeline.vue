<script setup lang="ts">
import { computed, ref, useTemplateRef, nextTick } from 'vue';
import type { HistoryEvent } from '../api/durable';
import { failureIndices, failureIndicesWithContext, gapBefore, isFailureEvent } from '../triage';
import JsonBlock from './JsonBlock.vue';

const props = defineProps<{
  events: HistoryEvent[];
  /** Index the "possibly stuck" hint points at, or -1. */
  stuckIndex: number;
}>();

const failuresOnly = ref(false);
const rowsRef = useTemplateRef<HTMLElement>('rows');

/** Which rows are expanded to show their full detail. Investigation is per-event. */
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
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined;
}

const rows = computed<Row[]>(() => {
  const keep = contextIndices.value;
  return props.events
    .map((event, index) => ({
      index,
      event,
      gap: gapBefore(props.events, index),
      failed: isFailureEvent(event),
    }))
    .filter((row) => !failuresOnly.value || keep.has(row.index));
});

function toggle(index: number): void {
  const next = new Set(expanded.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  expanded.value = next;
}

const allExpanded = computed(
  () => rows.value.length > 0 && rows.value.every((row) => expanded.value.has(row.index))
);

/** Dump or hide every visible event at once — an expert wants all the evidence, fast. */
function toggleAll(): void {
  expanded.value = allExpanded.value ? new Set() : new Set(rows.value.map((row) => row.index));
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

      <button v-if="rows.length > 0" class="expandall" @click="toggleAll">
        {{ allExpanded ? 'Collapse all' : 'Expand all' }}
      </button>
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
            class="line clickable"
            :aria-expanded="expanded.has(row.index)"
            @click="toggle(row.index)"
          >
            <span class="chevron">{{ expanded.has(row.index) ? '▾' : '▸' }}</span>
            <span class="type">{{ row.event.eventType }}</span>
            <span v-if="row.event.functionName" class="fn mono">{{ row.event.functionName }}</span>
            <span class="ts faint mono">{{ row.event.timestamp }}</span>
          </button>

          <!--
            Full per-event detail on demand: the failure text, the activity's
            input and result, and the complete raw event. Nothing is dropped —
            the parsed fields above are a convenience, this is the evidence. All
            collapsed by default, since payloads can carry PII or secrets that an
            operator should reveal deliberately, not by accident in a screenshot.
          -->
          <div v-if="expanded.has(row.index)" class="event-detail">
            <p v-if="row.event.reason" class="reason">{{ row.event.reason }}</p>
            <JsonBlock v-if="present(row.event.input)" label="Input" :value="row.event.input" />
            <JsonBlock v-if="present(row.event.result)" label="Result" :value="row.event.result" />
            <JsonBlock v-if="row.event.details" label="Details" :value="row.event.details" />
            <JsonBlock label="Raw event" :value="row.event.raw" />
          </div>
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

.event-detail {
  margin: 4px 0 8px;
  padding: 8px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
}

.row.failed .event-detail {
  border-color: var(--danger);
}

.reason {
  margin: 0 0 8px;
  color: var(--danger);
  white-space: pre-wrap;
  word-break: break-word;
}

.expandall {
  font-size: 11px;
  padding: 1px 8px;
}
</style>
