<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue';
import type { OrchestrationInstance, RuntimeStatus } from '../api/durable';
import type { Filters } from '../filters';
import {
  ALL_STATUSES,
  ATTENTION_STATUSES,
  distinctOrchestrators,
  groupFailuresBySignature,
  instanceErrorSignature,
  relativeTime,
} from '../triage';
import TriageHeader from './TriageHeader.vue';
import CopyButton from './CopyButton.vue';

const props = defineProps<{
  instances: OrchestrationInstance[];
  filters: Filters;
  loading: boolean;
  hasMore: boolean;
  autoRefresh: boolean;
  refreshSeconds: number;
}>();

const emit = defineEmits<{
  'update:filters': [filters: Filters];
  'update:autoRefresh': [value: boolean];
  'update:refreshSeconds': [value: number];
  select: [instance: OrchestrationInstance];
  loadMore: [];
  apply: [];
}>();

const orchestrators = computed(() => distinctOrchestrators(props.instances));

/** Distinct error signatures across the loaded failures — the "one bug or many?" strip. */
const errorGroups = computed(() => groupFailuresBySignature(props.instances));

/** Client-side filter to a single error signature, set by clicking a Problems chip. */
const signatureFilter = ref<string | null>(null);

function isProblem(instance: OrchestrationInstance): boolean {
  return ATTENTION_STATUSES.has(instance.runtimeStatus);
}

/**
 * Orchestrator name and error signature are filtered here, client-side, over the
 * pages already fetched — the webhook API exposes no server-side filter for
 * either (only runtimeStatus, createdTime* and instanceIdPrefix). Failures sort
 * to the top so a paged operator lands on what is broken without scrolling.
 */
const visible = computed<OrchestrationInstance[]>(() => {
  let list = props.instances;
  if (props.filters.orchestrator !== '') {
    list = list.filter((i) => i.name === props.filters.orchestrator);
  }
  if (signatureFilter.value !== null) {
    list = list.filter((i) => instanceErrorSignature(i) === signatureFilter.value);
  }
  return [...list].sort((a, b) => Number(isProblem(b)) - Number(isProblem(a)));
});

function patch(change: Partial<Filters>): void {
  emit('update:filters', { ...props.filters, ...change });
}

function toggleStatus(status: RuntimeStatus): void {
  const statuses = props.filters.statuses.includes(status)
    ? props.filters.statuses.filter((s) => s !== status)
    : [...props.filters.statuses, status];
  patch({ statuses });
}

function toggleSignature(signature: string): void {
  signatureFilter.value = signatureFilter.value === signature ? null : signature;
}

/*
 * Keyboard triage: j/k (or arrows) move a highlight, Enter opens, "/" jumps to
 * search. An operator woken at 2 AM should not have to reach for the mouse.
 */
const selected = ref(-1);
const searchInput = useTemplateRef<HTMLInputElement>('searchInput');
const rowsBody = useTemplateRef<HTMLElement>('rowsBody');

// Reset the highlight whenever the visible set changes underneath it.
watch(visible, () => {
  selected.value = -1;
});

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

function moveSelection(delta: number): void {
  const count = visible.value.length;
  if (count === 0) return;
  const next = selected.value < 0 ? (delta > 0 ? 0 : count - 1) : selected.value + delta;
  selected.value = Math.max(0, Math.min(count - 1, next));
  void nextFrameScroll();
}

async function nextFrameScroll(): Promise<void> {
  await Promise.resolve();
  const row = rowsBody.value?.querySelector(`[data-idx="${String(selected.value)}"]`);
  row?.scrollIntoView({ block: 'nearest' });
}

function openSelected(): void {
  const instance = selected.value >= 0 ? visible.value[selected.value] : undefined;
  if (instance !== undefined) emit('select', instance);
}

/** Arrow/vim keys map to a selection delta; everything else to 0 (no move). */
function selectionDelta(key: string): number {
  if (key === 'j' || key === 'ArrowDown') return 1;
  if (key === 'k' || key === 'ArrowUp') return -1;
  return 0;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === '/' && !isTypingTarget(event.target)) {
    event.preventDefault();
    searchInput.value?.focus();
    return;
  }
  if (isTypingTarget(event.target)) return;

  const delta = selectionDelta(event.key);
  if (delta !== 0) {
    event.preventDefault();
    moveSelection(delta);
  } else if (event.key === 'Enter') {
    openSelected();
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <TriageHeader
    :instances="instances"
    :has-more="hasMore"
    @pick="
      (name, status) => {
        patch({ orchestrator: name, statuses: [status as RuntimeStatus] });
        emit('apply');
      }
    "
  />

  <!--
    "One bug or many?" at a glance. Each chip is a distinct error across the
    loaded failures; clicking one filters the list to just those instances, so an
    operator can separate a systemic fault from a scatter of unrelated ones.
  -->
  <section v-if="errorGroups.length > 0" class="problems">
    <span class="plabel">Problems</span>
    <button
      v-for="group in errorGroups"
      :key="group.signature"
      class="sig"
      :class="{ on: signatureFilter === group.signature }"
      :title="group.signature"
      @click="toggleSignature(group.signature)"
    >
      <span class="scount">{{ group.count }}</span>
      <span class="stext">{{ group.signature }}</span>
    </button>
  </section>

  <section class="list">
    <div class="filters">
      <div class="statuses">
        <button
          v-for="status in ALL_STATUSES"
          :key="status"
          class="chip"
          :class="{ on: filters.statuses.includes(status) }"
          :aria-pressed="filters.statuses.includes(status)"
          @click="toggleStatus(status)"
        >
          {{ status }}
        </button>
      </div>

      <div class="inputs">
        <label>
          <span class="lbl">Orchestrator</span>
          <select
            :value="filters.orchestrator"
            @change="patch({ orchestrator: ($event.target as HTMLSelectElement).value })"
          >
            <option value="">All</option>
            <option v-for="name in orchestrators" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>

        <label>
          <span class="lbl">Instance ID prefix</span>
          <input
            ref="searchInput"
            type="text"
            :value="filters.instanceIdPrefix"
            placeholder="order-  ( / )"
            @input="patch({ instanceIdPrefix: ($event.target as HTMLInputElement).value })"
          />
        </label>

        <label>
          <span class="lbl">Created from</span>
          <input
            type="datetime-local"
            :value="filters.createdFrom"
            @input="patch({ createdFrom: ($event.target as HTMLInputElement).value })"
          />
        </label>

        <label>
          <span class="lbl">Created to</span>
          <input
            type="datetime-local"
            :value="filters.createdTo"
            @input="patch({ createdTo: ($event.target as HTMLInputElement).value })"
          />
        </label>

        <button class="primary" :disabled="loading" @click="emit('apply')">
          {{ loading ? 'Loading…' : 'Apply' }}
        </button>
      </div>

      <div class="refresh">
        <label class="auto">
          <input
            type="checkbox"
            :checked="autoRefresh"
            @change="emit('update:autoRefresh', ($event.target as HTMLInputElement).checked)"
          />
          Auto-refresh
        </label>
        <!-- Floor of 10s: this polls every app in the fleet the operator has open. -->
        <input
          class="secs"
          type="number"
          min="10"
          step="5"
          :value="refreshSeconds"
          :disabled="!autoRefresh"
          aria-label="Refresh interval in seconds"
          @change="emit('update:refreshSeconds', Number(($event.target as HTMLInputElement).value))"
        />
        <span class="faint">s</span>
      </div>
    </div>

    <p v-if="loading && instances.length === 0" class="state muted">Loading instances…</p>

    <p v-else-if="instances.length === 0" class="state muted">No instances match these filters.</p>

    <p v-else-if="visible.length === 0" class="state muted">
      No loaded instance is named “{{ filters.orchestrator }}”. It may exist on a page that has not
      been loaded — clear the filter or load more.
    </p>

    <template v-else>
      <!--
        table-layout: fixed with an explicit colgroup so the columns stay aligned
        regardless of content length. Cells that hold a copy button use an inner
        flex wrapper (.cell) — putting display:flex on the <td> itself removes it
        from the table's column sizing and is what broke the alignment before.
      -->
      <table class="grid">
        <colgroup>
          <col class="col-id" />
          <col class="col-orch" />
          <col class="col-status" />
          <col class="col-error" />
          <col class="col-created" />
        </colgroup>
        <thead>
          <tr>
            <th>Instance ID</th>
            <th>Orchestrator</th>
            <th>Status</th>
            <th>Error</th>
            <th class="right">Created</th>
          </tr>
        </thead>
        <tbody ref="rowsBody">
          <tr
            v-for="(instance, idx) in visible"
            :key="instance.instanceId"
            :data-idx="idx"
            class="row"
            :class="{ problem: isProblem(instance), selected: idx === selected }"
            @click="emit('select', instance)"
          >
            <td>
              <div class="cell">
                <span class="idtext mono">{{ instance.instanceId }}</span>
                <CopyButton :value="instance.instanceId" label="Copy instance ID" />
              </div>
            </td>
            <td>{{ instance.name || '—' }}</td>
            <td>
              <span class="badge" :class="instance.runtimeStatus.toLowerCase()">
                {{ instance.runtimeStatus }}
              </span>
            </td>
            <!--
              The error, inline, straight from the list payload (`output`): the
              operator sees WHAT broke without opening anything. Truncated with
              the full text on hover; the row click opens the full investigation.
            -->
            <td class="err">
              <div class="cell">
                <span class="errtext" :title="instanceErrorSignature(instance)">{{
                  instanceErrorSignature(instance)
                }}</span>
                <CopyButton
                  v-if="instanceErrorSignature(instance) !== ''"
                  :value="instanceErrorSignature(instance)"
                  label="Copy error"
                />
              </div>
            </td>
            <!-- Relative age for fast "when did this start" anchoring; exact time on hover. -->
            <td class="right faint" :title="instance.createdTime">
              {{ relativeTime(instance.createdTime) }}
            </td>
          </tr>
        </tbody>
      </table>

      <div class="more">
        <span class="faint">
          {{ visible.length
          }}<span v-if="visible.length !== instances.length"> / {{ instances.length }}</span>
          shown
        </span>
        <button v-if="hasMore" :disabled="loading" @click="emit('loadMore')">
          {{ loading ? 'Loading…' : 'Load more' }}
        </button>
        <span class="spacer" />
        <!-- Keyboard shortcuts, spelled out with arrows so the hint needs no decoding. -->
        <span class="kbd faint" title="Keyboard shortcuts for this list">
          <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> open · <kbd>/</kbd> search
        </span>
      </div>
    </template>
  </section>
</template>

<style scoped>
.problems {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--danger) 5%, var(--bg-raised));
}

.plabel {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--danger);
  font-weight: 600;
}

.sig {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  max-width: 380px;
  padding: 2px 8px;
  border-radius: 10px;
  border-color: var(--danger);
}

.sig.on {
  background: var(--danger);
  color: #fff;
}

.sig .scount {
  font-weight: 600;
}

.sig .stext {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list {
  padding: 10px 14px;
}

.filters {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
}

.statuses {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  color: var(--text-dim);
}

.chip.on {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.inputs {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

label {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.lbl {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-faint);
}

select,
input[type='datetime-local'],
input[type='number'] {
  font: inherit;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 6px;
}

.refresh {
  display: flex;
  align-items: center;
  gap: 6px;
}

.auto {
  flex-direction: row;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  cursor: pointer;
}

.secs {
  width: 58px;
}

.state {
  padding: 18px 2px;
  max-width: 62ch;
}

.grid {
  width: 100%;
  border-collapse: collapse;
  /* Fixed layout: columns take the colgroup widths, not their content, so the
     header and every row line up no matter how long an id or error is. */
  table-layout: fixed;
}

/* Column widths. The Error column is left unset so it absorbs the slack. */
.col-id {
  width: 34ch;
}

.col-orch {
  width: 22%;
}

.col-status {
  width: 108px;
}

.col-created {
  width: 76px;
}

.grid th {
  text-align: left;
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-faint);
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}

.grid td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  /* Every cell clips rather than pushing the column wider. */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}

.right {
  text-align: right;
}

.row {
  cursor: pointer;
}

.row:hover {
  background: var(--bg-hover);
}

/* Inner flex wrapper for cells that pair text with a copy button. */
.cell {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.idtext,
.errtext {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.err {
  color: var(--danger);
}

/* The copy button only appears on hover/selection, to keep dense rows clean. */
.copybtn {
  flex: 0 0 auto;
  opacity: 0;
}

.row:hover .copybtn,
.row.selected .copybtn,
.copybtn:focus-visible {
  opacity: 1;
}

.row.problem {
  background: color-mix(in srgb, var(--danger) 4%, transparent);
}

.row.problem:hover {
  background: color-mix(in srgb, var(--danger) 9%, transparent);
}

.row.selected {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}

.badge {
  padding: 0 6px;
  border-radius: 10px;
  font-size: 11px;
  border: 1px solid var(--border);
  color: var(--text-dim);
}

.badge.failed,
.badge.terminated {
  border-color: var(--danger);
  color: var(--danger);
}

.badge.running,
.badge.pending {
  border-color: var(--accent);
  color: var(--accent);
}

.badge.completed {
  border-color: var(--ok);
  color: var(--ok);
}

.badge.suspended {
  border-color: var(--warn);
  color: var(--warn);
}

.more {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}

.more .spacer {
  flex: 1;
}

.kbd {
  font-size: 11px;
  white-space: nowrap;
}

.kbd kbd {
  display: inline-block;
  min-width: 14px;
  padding: 0 4px;
  margin: 0 1px;
  font-family: ui-monospace, monospace;
  font-size: 10px;
  text-align: center;
  color: var(--text-dim);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 3px;
}
</style>
