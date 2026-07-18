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
}>();

const emit = defineEmits<{
  select: [app: FunctionApp];
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

// Re-observe whenever the row set changes (search, sort, discovery) OR when the
// table first appears — the table is only rendered once loading/classifying
// finishes, and that transition does not change `visible`, so it must be watched
// explicitly or the observer would never attach to the initial rows.
watch([visible, () => props.loading, () => props.classifying], () => void nextTick(observeRows));
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

      <!--
        Failures are checked automatically as rows scroll into view (bounded
        queue in the parent). This is just a quiet activity hint while that runs.
      -->
      <span v-if="scanning" class="faint scanning">checking for failures…</span>
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
          <th>Health</th>
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
          :class="{ problem: (failuresOf(app)?.count ?? 0) > 0 }"
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
          <td class="name">{{ app.name }}</td>
          <!--
            Failures are first-class on an ops tool, so they get their own column
            plus a row-level treatment (tint + red edge, matching the instance
            list) — a bold, plainly-worded count, never a decorative pill. A
            scanned clean app shows a quiet tick; an unscanned one shows nothing.
            Kept out of the Name cell so the app's name stays its own identity.
          -->
          <td class="health">
            <span
              v-if="failuresOf(app) && failuresOf(app)!.count > 0"
              class="failcount"
              :title="`${failuresOf(app)!.count}${failuresOf(app)!.more ? '+' : ''} failed or terminated instance(s)`"
            >
              <span class="fdot" aria-hidden="true"></span>
              {{ failuresOf(app)!.count }}{{ failuresOf(app)!.more ? '+' : '' }} failed
            </span>
            <span
              v-else-if="failuresOf(app)"
              class="clean"
              title="No failed or terminated instances found"
              >✓ healthy</span
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

/* A failing app is a first-class concern: the whole row reads as "attention
   needed", matching how failed instances look, so it can never be overlooked. */
.row.problem {
  background: color-mix(in srgb, var(--danger) 5%, transparent);
}

.row.problem:hover {
  background: color-mix(in srgb, var(--danger) 10%, transparent);
}

.row.problem > td:first-child {
  box-shadow: inset 3px 0 0 var(--danger);
}

.name {
  font-weight: 500;
}

.failcount {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 10px;
  color: var(--danger);
  font-weight: 600;
  font-size: 12px;
}

.fdot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--danger);
}

.clean {
  margin-left: 10px;
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
