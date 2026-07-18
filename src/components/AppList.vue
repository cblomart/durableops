<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue';
import type { DurableKind, FunctionApp, Operability } from '../api/arm';
import type { FailureCount } from '../api/durable';
import { useFavorites } from '../favorites';

const props = defineProps<{
  apps: FunctionApp[];
  loading: boolean;
  /** App id -> durable classification. Absent while still being checked. */
  durable: Map<string, DurableKind>;
  /** App id -> whether the user holds listkeys on it. Absent while still being checked. */
  operable: Map<string, Operability>;
  /** True while the fleet is still being classified. */
  classifying: boolean;
  /** App id -> failed instance count, filled in as rows are scanned. */
  failureScan: Map<string, FailureCount>;
  /** True while any opportunistic scan is in flight. */
  scanning: boolean;
  /** Whether opportunistic (viewport) failure scanning is enabled. */
  autoScan: boolean;
}>();

const emit = defineEmits<{
  select: [app: FunctionApp];
  'update:autoScan': [value: boolean];
  /** Emitted when a row scrolls into view and should be scanned. */
  scan: [app: FunctionApp];
}>();

const { isFavorite, toggleFavorite } = useFavorites();
const search = ref('');

/** Failure count for an app from the scan, or null if it was not scanned yet. */
function failuresOf(app: FunctionApp): FailureCount | null {
  return props.failureScan.get(app.id) ?? null;
}

/**
 * Only apps the operator can actually act on.
 *
 * Two separate filters, both hiding only *confirmed* negatives:
 *  - `operable === 'no'`: discovery shows what you can READ; without listkeys
 *    you can do nothing with the app, so listing it is noise.
 *  - `durable === 'no'`: it runs no Durable Functions, so there is nothing here.
 *
 * `unknown` never hides anything — that would silently drop work we merely
 * failed to classify.
 *
 * What is filtered out is NOT reported to the operator, deliberately. Counting
 * hidden apps, or explaining that reading and managing are different
 * permissions, only raises questions an operator should never have to care
 * about. They get the list they can work with, and one button that fixes the
 * empty case.
 */
const usableApps = computed<FunctionApp[]>(() =>
  props.apps.filter(
    (app) => props.operable.get(app.id) !== 'no' && props.durable.get(app.id) !== 'no'
  )
);

/**
 * Client-side search across the fields an operator actually recalls under
 * pressure: app name, resource group, region. Discovery already returned the
 * user's full authorised set, so filtering here costs nothing and avoids
 * re-querying ARG on every keystroke.
 */
const visible = computed<FunctionApp[]>(() => {
  const needle = search.value.trim().toLowerCase();
  const matched =
    needle === ''
      ? usableApps.value
      : usableApps.value.filter((app) =>
          [app.name, app.resourceGroup, app.location].some((field) =>
            field.toLowerCase().includes(needle)
          )
        );

  // Order for a 2 AM glance: apps the scan found broken first, then favourites,
  // then name. Broken-first means the operator's suspects surface at the top.
  return [...matched].sort((a, b) => {
    const broken =
      Number((failuresOf(b)?.count ?? 0) > 0) - Number((failuresOf(a)?.count ?? 0) > 0);
    if (broken !== 0) return broken;
    const fav = Number(isFavorite(b.name)) - Number(isFavorite(a.name));
    return fav !== 0 ? fav : a.name.localeCompare(b.name);
  });
});

/*
 * Opportunistic scanning: watch the rendered rows with an IntersectionObserver
 * and ask the parent to scan each one only as it scrolls into view. This is the
 * throttle — at fleet scale we never scan (or pull a key for) an app the operator
 * has not actually looked at. The parent owns the bounded queue and the keys.
 */
const bodyRef = useTemplateRef<HTMLElement>('body');
let observer: IntersectionObserver | null = null;

function onIntersect(entries: IntersectionObserverEntry[]): void {
  if (!props.autoScan) return;
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const id = (entry.target as HTMLElement).dataset['appId'];
    const app = props.apps.find((candidate) => candidate.id === id);
    if (app !== undefined) emit('scan', app);
  }
}

function observeRows(): void {
  const obs = observer;
  const body = bodyRef.value;
  if (obs === null || body === null) return;
  obs.disconnect();
  for (const row of body.querySelectorAll('[data-app-id]')) obs.observe(row);
}

onMounted(() => {
  // `rootMargin` starts a scan slightly before a row is fully on screen.
  observer = new IntersectionObserver(onIntersect, { rootMargin: '120px' });
  void nextTick(observeRows);
});

onBeforeUnmount(() => observer?.disconnect());

// Re-observe after the row set changes, and when scanning is switched on (so
// rows already on screen are picked up immediately).
watch([visible, () => props.autoScan], () => void nextTick(observeRows));
</script>

<template>
  <section class="applist">
    <div class="toolbar">
      <input
        v-model="search"
        type="search"
        class="search"
        placeholder="Filter by name, resource group or region…"
        aria-label="Filter function apps"
      />
      <span class="count faint">
        {{ visible.length }} app{{ visible.length === 1 ? '' : 's' }}
        <template v-if="classifying"> · loading…</template>
      </span>

      <div class="tspacer" />

      <!--
        Opportunistic failure scan. When on, each app is checked for failures as
        it scrolls into view (throttled, bounded) — so at small scale every app
        gets a badge and at fleet scale only what you look at is scanned. Off by
        default: enabling it opts into pulling a key for the apps you browse.
      -->
      <label class="scan-toggle" title="Check apps for failures as they scroll into view">
        <input
          type="checkbox"
          :checked="autoScan"
          @change="emit('update:autoScan', ($event.target as HTMLInputElement).checked)"
        />
        Scan for failures
      </label>
      <span v-if="scanning" class="faint scanning">scanning…</span>
    </div>

    <p v-if="loading || classifying" class="state muted">Loading apps…</p>

    <!--
      One calm empty state for every reason the list can be empty (no apps, none
      durable, none the operator may touch). It says nothing about filtering,
      access, or hidden apps: surfacing that only worries an operator, and the
      recovery — Refresh rights — already lives in the top bar for the case where
      a role was just activated. The operator does not need an RBAC lesson.
    -->
    <p v-else-if="usableApps.length === 0" class="state muted">No apps to show.</p>

    <p v-else-if="visible.length === 0" class="state muted">No app matches “{{ search }}”.</p>

    <table v-else class="grid">
      <thead>
        <tr>
          <th class="star" aria-label="Favourite"></th>
          <th>Name</th>
          <th>Resource group</th>
          <th>Region</th>
          <th>State</th>
        </tr>
      </thead>
      <tbody ref="body">
        <tr
          v-for="app in visible"
          :key="app.id"
          :data-app-id="app.id"
          class="row"
          @click="$emit('select', app)"
        >
          <td class="star">
            <button
              class="starbtn"
              :class="{ on: isFavorite(app.name) }"
              :aria-label="
                isFavorite(app.name) ? `Unfavourite ${app.name}` : `Favourite ${app.name}`
              "
              :aria-pressed="isFavorite(app.name)"
              @click.stop="toggleFavorite(app.name)"
            >
              {{ isFavorite(app.name) ? '★' : '☆' }}
            </button>
          </td>
          <!--
            An app we could not classify (stopped, or not readable) is listed
            plainly, with no marker: it stays visible so nothing is silently
            dropped, but it carries no explanation the operator would have to
            decode. If it turns out not to be durable, opening it says so.
          -->
          <td class="name">
            {{ app.name }}
            <!-- Scan result: a red count when this favourite has failures, a quiet tick when clean. -->
            <span
              v-if="failuresOf(app) && failuresOf(app)!.count > 0"
              class="failbadge"
              :title="`${failuresOf(app)!.count}${failuresOf(app)!.more ? '+' : ''} failed or terminated instance(s)`"
            >
              {{ failuresOf(app)!.count }}{{ failuresOf(app)!.more ? '+' : '' }} failed
            </span>
            <span
              v-else-if="failuresOf(app)"
              class="cleanbadge"
              title="No failures found in the latest scan"
              >✓</span
            >
          </td>
          <td class="muted">{{ app.resourceGroup }}</td>
          <td class="muted">{{ app.location }}</td>
          <td>
            <span v-if="app.state !== 'Running'" class="badge stopped" :title="app.state">
              {{ app.state }}
            </span>
            <span v-else class="faint">Running</span>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.applist {
  padding: 12px 14px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.tspacer {
  flex: 1;
}

.scan-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.scanning {
  font-size: 11px;
}

.search {
  width: 340px;
}

.count {
  font-size: 11px;
}

.state {
  padding: 18px 2px;
  max-width: 62ch;
}

.grid {
  width: 100%;
  border-collapse: collapse;
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
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
}

.row {
  cursor: pointer;
}

.row:hover {
  background: var(--bg-hover);
}

.name {
  font-weight: 500;
}

.failbadge {
  margin-left: 8px;
  padding: 0 6px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  background: var(--danger);
}

.cleanbadge {
  margin-left: 8px;
  font-size: 11px;
  color: var(--ok);
}

.star {
  width: 28px;
}

.starbtn {
  border: none;
  background: none;
  padding: 0 2px;
  color: var(--text-faint);
  line-height: 1;
}

.starbtn.on {
  color: var(--warn);
}

.badge.stopped {
  color: var(--warn);
  border: 1px solid var(--warn);
  border-radius: 3px;
  padding: 0 5px;
  font-size: 11px;
}
</style>
