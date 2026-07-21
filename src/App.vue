<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import TopBar from './components/TopBar.vue';
import AppList from './components/AppList.vue';
import InstanceList from './components/InstanceList.vue';
import InstanceDetail from './components/InstanceDetail.vue';
import RefreshButton from './components/RefreshButton.vue';
import CopyButton from './components/CopyButton.vue';
import AboutDialog from './components/AboutDialog.vue';
import { emptyFilters, type Filters } from './filters';
import { getArmToken, getSignedInUser, signIn, signOut, type SignedInUser } from './auth';
import { adminConsentUrl } from './config';
import {
  cachedKeyCount,
  checkOperabilityForApps,
  classifyDurableApps,
  clearKeyCache,
  discoverFunctionApps,
  getDurableSystemKey,
  getTenantName,
  type DurableKind,
  type FunctionApp,
  type Operability,
} from './api/arm';
import {
  countFailedInstances,
  getInstance,
  listInstances,
  purgeInstance,
  raiseEvent,
  restartInstance,
  resumeInstance,
  rewindInstance,
  suspendInstance,
  terminateInstance,
  type DurableTarget,
  type FailureCount,
  type InstanceAction,
  type InstanceDetail as Detail,
  type OrchestrationInstance,
} from './api/durable';
import { describeError, err, isPimRecoverable, type ApiError, type Result } from './api/errors';
import { parseHash, routeToHash, sameRoute, type Route } from './router';

const user = ref<SignedInUser | null>(getSignedInUser());
const apps = ref<FunctionApp[]>([]);
const loading = ref(false);
const busy = ref(false);
const error = ref<ApiError | null>(null);
const keysInMemory = ref(0);

/**
 * App id -> durable classification, filled in progressively after discovery.
 *
 * Apps confirmed non-durable are hidden: an ops tool for Durable Functions has
 * no business listing apps that run none. Classification reads function
 * bindings from ARM and pulls no keys, so this costs no credentials.
 */
const durable = ref(new Map<string, DurableKind>());

/**
 * App id -> whether the user can actually operate it (holds `listkeys`).
 *
 * Discovery returns what the user can READ, which is not the same as what they
 * can DO — Reader shows the whole tenant but cannot fetch a key. Listing apps
 * the operator is powerless over is noise, so confirmed-unusable apps are hidden.
 */
const operable = ref(new Map<string, Operability>());
const classifying = ref(false);

/** A GUID means nothing to an operator; resolved to a display name once signed in. */
const tenantName = ref(user.value?.tenantId ?? '');

/**
 * Opportunistic failure scan: app id -> failed instance count.
 *
 * Counting failures needs a per-app key and a webhook call, so scanning the
 * whole fleet at once would pull hundreds of keys just to draw a list. Instead
 * the app list scans only the rows scrolled into view (see AppList's intersection
 * observer), through the bounded queue below — so at small scale everything gets
 * a count, and at fleet scale only the apps the operator actually looks at are
 * scanned (and only they have a key pulled). Failures are first-class here, so
 * this runs automatically; the bounded queue keeps it from storming any app.
 */
const failureScan = ref(new Map<string, FailureCount>());
/**
 * App id -> why its data plane is unreachable from this browser.
 *
 * The scan calls the app's own hostname directly (no backend), so an app whose
 * CORS list omits our origin — or that sits behind Easy Auth — fails the browser's
 * cross-origin check before we read anything. That is a fixable config gap, not a
 * failure of the app, so we flag it rather than leave the row blank.
 */
const unreachable = ref(new Map<string, 'cors' | 'easyAuth'>());
/** app id -> when it was last scanned, so a visible row can refresh lazily. */
const scannedAt = new Map<string, number>();
const scanning = ref(false);
/** app ids being scanned right now — reactive, so a row's refresh button can spin. */
const scanningIds = ref<Set<string>>(new Set());

/** Hits app runtimes, not ARM — keep it modest so a scan never storms an app. */
const SCAN_CONCURRENCY = 4;
/** A visible app's failure count is trusted for this long before a lazy re-scan. */
const SCAN_TTL_MS = 60_000;
const scanQueue: FunctionApp[] = [];

function isFreshlyScanned(id: string): boolean {
  const at = scannedAt.get(id);
  return at !== undefined && Date.now() - at < SCAN_TTL_MS;
}

/**
 * Queue a usable app for scanning. Deduped against in-flight scans and, unless
 * forced, against results still within the TTL — so the viewport tick can call
 * this freely and only stale rows actually re-scan.
 */
function enqueueScan(app: FunctionApp, force = false): void {
  if (scanningIds.value.has(app.id)) return;
  if (!force && isFreshlyScanned(app.id)) return;
  if (operable.value.get(app.id) === 'no' || durable.value.get(app.id) === 'no') return;
  if (scanQueue.some((queued) => queued.id === app.id)) return;
  scanQueue.push(app);
  pumpScanQueue();
}

/** Force an immediate re-scan of one app (the per-app refresh button). */
function rescanApp(app: FunctionApp): void {
  enqueueScan(app, true);
}

function setUnreachable(id: string, kind: 'cors' | 'easyAuth'): void {
  unreachable.value = new Map(unreachable.value).set(id, kind);
}

function clearUnreachable(id: string): void {
  if (!unreachable.value.has(id)) return;
  const next = new Map(unreachable.value);
  next.delete(id);
  unreachable.value = next;
}

async function scanOne(app: FunctionApp): Promise<void> {
  try {
    const token = await getArmToken();
    const key = await getDurableSystemKey(app, token);
    keysInMemory.value = cachedKeyCount();
    if (!key.ok) return;
    const scan = await countFailedInstances({
      hostName: app.defaultHostName,
      systemKey: key.value,
    });
    if (scan.ok) {
      failureScan.value = new Map(failureScan.value).set(app.id, scan.value);
      clearUnreachable(app.id);
    } else if (scan.error.kind === 'cors' || scan.error.kind === 'easyAuth') {
      // The scan is the real data-plane call, so it detects the block for free.
      setUnreachable(app.id, scan.error.kind);
    }
  } catch {
    // A single app's scan failing must never break the list.
  } finally {
    scannedAt.set(app.id, Date.now());
  }
}

function markInFlight(id: string, active: boolean): void {
  const next = new Set(scanningIds.value);
  if (active) next.add(id);
  else next.delete(id);
  scanningIds.value = next;
}

function pumpScanQueue(): void {
  while (scanningIds.value.size < SCAN_CONCURRENCY && scanQueue.length > 0) {
    const app = scanQueue.shift();
    if (app === undefined) break;
    markInFlight(app.id, true);
    scanning.value = true;
    void scanOne(app).finally(() => {
      markInFlight(app.id, false);
      scanning.value = scanningIds.value.size > 0 || scanQueue.length > 0;
      pumpScanQueue();
    });
  }
}

const selectedApp = ref<FunctionApp | null>(null);
const target = ref<DurableTarget | null>(null);
const instances = ref<OrchestrationInstance[]>([]);
const continuationToken = ref<string | undefined>(undefined);
const detail = ref<Detail | null>(null);

const autoRefresh = ref(false);
const refreshSeconds = ref(30);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const filters = ref<Filters>(emptyFilters());

/**
 * Last-used filters per app, for this session only.
 *
 * In memory by design: filters can carry instance-id fragments, which are
 * customer data. They die with the tab, like everything else here except
 * favourite app names.
 */
const filtersByApp = new Map<string, Filters>();

function setError(cause: unknown): void {
  error.value = {
    kind: 'auth',
    message: cause instanceof Error ? cause.message : 'Something went wrong',
  };
}

/** This app's own origin — the value an operator adds to a blocked app's CORS list. */
const appOrigin = window.location.origin;

/** Tenant admin-consent URL, for the signed-out landing's "grant access" button. */
const adminConsentHref = adminConsentUrl(appOrigin);

/** Build identity for the status bar. Frozen into the bundle at build time. */
const appVersion = __APP_VERSION__;
const buildSha = __BUILD_SHA__;
const showAbout = ref(false);

/** A ready-to-run command to allow this origin on the currently open app. */
const corsCommand = computed(() => {
  const app = selectedApp.value;
  if (app === null) return '';
  return `az functionapp cors add -g ${app.resourceGroup} -n ${app.name} --allowed-origins "${appOrigin}"`;
});

/**
 * Work out what the operator can actually use, in the background.
 *
 * Operability first, then durability — and only for the apps that survive. An
 * app the user cannot operate is hidden regardless of whether it is durable, so
 * checking its bindings would be wasted calls against a fleet of hundreds.
 *
 * Deliberately fire-and-forget: the app list renders immediately and settles as
 * results land. A classification failure must never block discovery.
 */
async function classify(token: string): Promise<void> {
  classifying.value = true;
  try {
    await checkOperabilityForApps(apps.value, token, (id, kind) => {
      operable.value = new Map(operable.value).set(id, kind);
    });

    const usable = apps.value.filter((app) => operable.value.get(app.id) !== 'no');
    await classifyDurableApps(usable, token, (id, kind) => {
      // Replace the Map so Vue sees the change; these are small maps.
      durable.value = new Map(durable.value).set(id, kind);
    });
  } finally {
    classifying.value = false;
  }
}

async function discover(forceRefresh = false): Promise<void> {
  const signedIn = user.value;
  if (signedIn === null) return;
  loading.value = true;
  error.value = null;
  try {
    const token = await getArmToken(forceRefresh);
    // Cosmetic only: never let a failed name lookup block discovery.
    void getTenantName(signedIn.tenantId, token).then((name) => {
      tenantName.value = name;
    });
    const result = await discoverFunctionApps(token);
    if (result.ok) {
      apps.value = result.value;
      durable.value = new Map();
      operable.value = new Map();
      void classify(token);
    } else {
      error.value = result.error;
      apps.value = [];
    }
  } catch (cause: unknown) {
    setError(cause);
  } finally {
    loading.value = false;
    keysInMemory.value = cachedKeyCount();
  }
}

/**
 * The post-PIM-activation gesture.
 *
 * Order matters: drop cached keys and loaded data first, so a failure part-way
 * through cannot leave stale, over-privileged state on screen. Then force a
 * fresh ARM token (carrying newly activated role claims) and re-discover.
 */
async function refreshRights(): Promise<void> {
  busy.value = true;
  clearKeyCache();
  keysInMemory.value = 0;
  apps.value = [];
  durable.value = new Map();
  operable.value = new Map();
  failureScan.value = new Map();
  unreachable.value = new Map();
  scannedAt.clear();
  scanQueue.length = 0;
  scanningIds.value = new Set();
  target.value = null;
  instances.value = [];
  detail.value = null;
  try {
    await discover(true);
    if (selectedApp.value !== null) await openApp(selectedApp.value);
  } finally {
    busy.value = false;
  }
}

/** Filters the runtime can apply server-side. Orchestrator name is not one of them. */
function buildQuery(token?: string) {
  const from = filters.value.createdFrom;
  const to = filters.value.createdTo;
  return {
    ...(filters.value.statuses.length > 0 ? { runtimeStatus: filters.value.statuses } : {}),
    ...(from !== '' ? { createdTimeFrom: new Date(from) } : {}),
    ...(to !== '' ? { createdTimeTo: new Date(to) } : {}),
    ...(token === undefined ? {} : { continuationToken: token }),
    top: 100,
  };
}

/*
 * Monotonic guard against out-of-order responses: the filters now apply on
 * change, so a fast operator can have two list fetches in flight. Without this,
 * whichever *resolves* last wins — not whichever was *requested* last — and the
 * grid could settle on stale, wrong-filtered instances.
 */
let fetchToken = 0;

async function fetchInstances(append = false): Promise<void> {
  if (target.value === null) return;
  const token = ++fetchToken;
  loading.value = true;
  error.value = null;
  try {
    const result = await listInstances(
      target.value,
      buildQuery(append ? continuationToken.value : undefined)
    );
    if (token !== fetchToken) return; // a newer fetch superseded this one
    if (!result.ok) {
      error.value = result.error;
      return;
    }
    instances.value = append
      ? [...instances.value, ...result.value.instances]
      : result.value.instances;
    continuationToken.value = result.value.continuationToken;
  } catch (cause: unknown) {
    if (token === fetchToken) setError(cause);
  } finally {
    if (token === fetchToken) loading.value = false;
  }
}

async function openApp(app: FunctionApp): Promise<void> {
  selectedApp.value = app;
  detail.value = null;
  filters.value = filtersByApp.get(app.id) ?? emptyFilters();
  instances.value = [];
  continuationToken.value = undefined;
  error.value = null;
  loading.value = true;

  try {
    const token = await getArmToken();
    // The system key is fetched only now — opening an app, not listing them.
    const key = await getDurableSystemKey(app, token);
    keysInMemory.value = cachedKeyCount();
    if (!key.ok) {
      error.value = key.error;
      target.value = null;
      return;
    }
    target.value = { hostName: app.defaultHostName, systemKey: key.value };
    await fetchInstances();
  } catch (cause: unknown) {
    setError(cause);
  } finally {
    loading.value = false;
  }
}

async function openInstanceById(instanceId: string): Promise<void> {
  if (target.value === null) return;
  loading.value = true;
  error.value = null;
  try {
    const result = await getInstance(target.value, instanceId);
    if (result.ok) detail.value = result.value;
    else error.value = result.error;
  } catch (cause: unknown) {
    setError(cause);
  } finally {
    loading.value = false;
  }
}

function openInstance(instance: OrchestrationInstance): Promise<void> {
  return openInstanceById(instance.instanceId);
}

/**
 * Manual re-fetch of the whole app view. Triage, Problems and the instance list
 * are all computed from `instances`, so one fetch refreshes all three; this backs
 * the "Refresh now" button in the app header. Kept distinct from `loading` so the
 * button spins only for an explicit refresh, not for load-more or the first open.
 */
const listRefreshing = ref(false);

async function refreshList(): Promise<void> {
  if (target.value === null || listRefreshing.value) return;
  listRefreshing.value = true;
  try {
    await fetchInstances(false);
  } finally {
    listRefreshing.value = false;
  }
}

/** Manual re-fetch of the open instance (the detail refresh button). */
const detailRefreshing = ref(false);

async function refreshDetail(): Promise<void> {
  const current = detail.value;
  if (current === null || target.value === null || detailRefreshing.value) return;
  detailRefreshing.value = true;
  try {
    const result = await getInstance(target.value, current.instanceId);
    if (result.ok) detail.value = result.value;
    else error.value = result.error;
  } catch (cause: unknown) {
    setError(cause);
  } finally {
    detailRefreshing.value = false;
  }
}

/**
 * Execute an instance action against the live app.
 *
 * The signed-in UPN is folded into the reason here (via each api function), so
 * every reason-bearing action lands in the target app's telemetry as
 * "DurableOps/{upn}: {reason}" — the who-and-why audit trail. Returns a typed
 * Result so the dialog can report a failure without tearing down.
 */
async function runAction(
  action: InstanceAction,
  args: { reason?: string; eventName?: string; payload?: unknown }
): Promise<Result<void>> {
  const t = target.value;
  const signedIn = user.value;
  const id = detail.value?.instanceId;
  if (t === null || signedIn === null || id === undefined) {
    return err({ kind: 'auth', message: 'Not ready to act' });
  }
  const reason = args.reason ?? '';
  const upn = signedIn.upn;

  // A dispatch table rather than a switch: one entry per action, each a thunk.
  const handlers: Record<InstanceAction, () => Promise<Result<void>>> = {
    terminate: () => terminateInstance(t, id, upn, reason),
    rewind: () => rewindInstance(t, id, upn, reason),
    suspend: () => suspendInstance(t, id, upn, reason),
    resume: () => resumeInstance(t, id, upn, reason),
    restart: () => restartInstance(t, id, false),
    purge: () => purgeInstance(t, id),
    raiseEvent: () => raiseEvent(t, id, args.eventName ?? '', args.payload),
  };
  return handlers[action]();
}

/**
 * After an action, confirm what actually happened.
 *
 * Purge destroys the instance, so there is nothing to re-read — go back to the
 * list. For everything else, poll the instance once after 2s (the runtime
 * applies most actions asynchronously) and show the new status.
 */
function onActionDone(action: InstanceAction): void {
  if (action === 'purge') {
    detail.value = null;
    void fetchInstances();
    return;
  }
  const current = detail.value;
  if (current === null || target.value === null) return;
  const instanceId = current.instanceId;
  window.setTimeout(() => {
    // Re-read state here: 2s is long enough for the operator to have navigated
    // away (target cleared) or opened a different instance. Both would make this
    // re-fetch wrong, so guard rather than cast the null away.
    const t = target.value;
    if (t === null || detail.value?.instanceId !== instanceId) return;
    void getInstance(t, instanceId).then((result) => {
      if (result.ok && detail.value?.instanceId === instanceId) detail.value = result.value;
    });
  }, 2000);
}

function backToApps(): void {
  selectedApp.value = null;
  target.value = null;
  instances.value = [];
  detail.value = null;
  error.value = null;
}

/*
 * Deep-link routing. The view is a pure function of `selectedApp` and `detail`,
 * so `currentRoute` derives the URL from state, and `applyRoute` drives state
 * from a URL. The two are kept from chasing each other by `syncingFromHash`:
 * while a hash-driven navigation runs, the state->hash writer stands down.
 */
const currentRoute = computed<Route>(() => {
  const app = selectedApp.value;
  if (app === null) return { view: 'apps' };
  if (detail.value !== null) {
    return { view: 'instance', appKey: app.name, instanceId: detail.value.instanceId };
  }
  return { view: 'app', appKey: app.name };
});

let syncingFromHash = false;

/** Drive app state to match a route parsed from the URL (deep link, back/forward). */
async function applyRoute(route: Route): Promise<void> {
  if (route.view === 'apps') {
    backToApps();
    return;
  }
  // Match on name — an app's globally unique DNS label, and our route key.
  const app = apps.value.find((candidate) => candidate.name === route.appKey);
  if (app === undefined) return; // unknown or not-yet-discovered app: leave the view as-is.

  if (selectedApp.value?.id !== app.id) {
    await openApp(app);
    if (target.value === null) return; // openApp failed (e.g. 403); don't chase the instance.
  }
  if (route.view === 'instance') {
    if (detail.value?.instanceId !== route.instanceId) await openInstanceById(route.instanceId);
  } else if (detail.value !== null) {
    detail.value = null;
  }
}

// State -> URL. A real hash change pushes a history entry, so Back works.
watch(currentRoute, (route) => {
  if (syncingFromHash) return;
  const hash = routeToHash(route);
  if (window.location.hash !== hash) window.location.hash = hash;
});

// URL -> state, for back/forward and hand-edited links.
async function onHashChange(): Promise<void> {
  const route = parseHash(window.location.hash);
  if (sameRoute(route, currentRoute.value)) return;
  syncingFromHash = true;
  try {
    await applyRoute(route);
  } finally {
    syncingFromHash = false;
  }
}

// A stable reference so add/removeEventListener target the same handler.
function hashListener(): void {
  void onHashChange();
}

function onFilters(next: Filters): void {
  filters.value = next;
  if (selectedApp.value !== null) filtersByApp.set(selectedApp.value.id, next);
}

function stopTimer(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * Auto-refresh is off by default and floored at 10s: it polls a live function
 * app, and an ops tool must not be the reason an app gets throttled.
 */
function syncTimer(): void {
  stopTimer();
  if (!autoRefresh.value || target.value === null) return;
  const seconds = Math.max(10, refreshSeconds.value);
  refreshTimer = setInterval(() => {
    // Never poll over an open detail view or a request already in flight.
    if (detail.value === null && !loading.value) void fetchInstances();
  }, seconds * 1000);
}

watch([autoRefresh, refreshSeconds, target], syncTimer);

onMounted(async () => {
  // Discovery must finish before a deep link can resolve: applyRoute matches the
  // URL's app against the discovered list. initAuth() (in main.ts) has already
  // consumed and cleared any MSAL redirect hash, so what remains is our route.
  if (user.value !== null) await discover();
  const initial = parseHash(window.location.hash);
  if (!sameRoute(initial, currentRoute.value)) {
    syncingFromHash = true;
    try {
      await applyRoute(initial);
    } finally {
      syncingFromHash = false;
    }
  }
  window.addEventListener('hashchange', hashListener);
});

onUnmounted(() => {
  stopTimer();
  window.removeEventListener('hashchange', hashListener);
});
</script>

<template>
  <TopBar
    :user="user"
    :busy="busy"
    :keys-in-memory="keysInMemory"
    :tenant-name="tenantName"
    @sign-in="signIn"
    @sign-out="signOut"
    @refresh-rights="refreshRights"
  />

  <main>
    <section v-if="user === null" class="landing">
      <h1 class="ltitle">Troubleshoot Azure Durable Functions at scale</h1>
      <p class="lsub">
        DurableOps runs entirely in your browser. It has no backend and no secrets: every call is
        made with your own Azure sign-in, so Azure enforces your real permissions on every request.
      </p>

      <button class="primary big" @click="signIn">Sign in with Microsoft</button>

      <!--
        Onboarding, not a wall of text: the three things a first-time user (or the
        admin they have to ask) needs to know to actually get in.
      -->
      <div class="access">
        <h2>Granting access</h2>
        <ol>
          <li>
            <strong>Signing in</strong> asks you to consent to the Azure Service Management
            permission — that is what lets DurableOps act as you against your subscriptions. It
            grants the app nothing of its own.
          </li>
          <li>
            <strong>If your organisation requires admin approval</strong>, a Global Administrator or
            Privileged Role Administrator can grant it once for everyone, so individual users do not
            each hit a consent wall:
            <a class="consentbtn" :href="adminConsentHref" target="_blank" rel="noopener noreferrer"
              >Grant admin consent</a
            >
          </li>
          <li>
            <strong>You still need Azure roles</strong> to operate apps — consent alone grants no
            access to any resource. Activate an eligible role through PIM, then use “Refresh
            rights”.
          </li>
        </ol>
      </div>
    </section>

    <template v-else>
      <div v-if="error" class="banner error err">
        <div class="errtop">
          <div>{{ describeError(error) }}</div>
          <RefreshButton
            v-if="isPimRecoverable(error)"
            label="Refresh rights"
            text="Refresh rights"
            :busy="busy"
            @refresh="refreshRights"
          />
        </div>
        <!--
          A CORS block is one config line to fix, so hand the operator both the
          exact origin (to paste into the portal) and a ready-to-run command.
        -->
        <div v-if="error.kind === 'cors' && selectedApp !== null" class="corsfix">
          <div class="corsrow">
            <span class="clbl">Origin to allow</span>
            <code class="mono">{{ appOrigin }}</code>
            <CopyButton :value="appOrigin" label="Copy origin" />
          </div>
          <div class="corsrow">
            <span class="clbl">Or run</span>
            <code class="mono cmd">{{ corsCommand }}</code>
            <CopyButton :value="corsCommand" label="Copy command" />
          </div>
        </div>
      </div>

      <AppList
        v-if="selectedApp === null"
        :apps="apps"
        :loading="loading"
        :durable="durable"
        :operable="operable"
        :classifying="classifying"
        :failure-scan="failureScan"
        :unreachable="unreachable"
        :scanning="scanning"
        :scanning-ids="scanningIds"
        @select="openApp"
        @scan="enqueueScan"
        @rescan="rescanApp"
      />

      <InstanceDetail
        v-else-if="detail !== null"
        :detail="detail"
        :app-name="selectedApp.name"
        :runner="runAction"
        :refreshing="detailRefreshing"
        @back="detail = null"
        @home="backToApps"
        @refresh="refreshDetail"
        @action-done="onActionDone"
      />

      <template v-else>
        <nav class="crumbs" aria-label="Breadcrumb">
          <button class="crumb link" @click="backToApps">Apps</button>
          <span class="sep" aria-hidden="true">›</span>
          <span class="crumb current">{{ selectedApp.name }}</span>
          <span class="faint rg mono">{{ selectedApp.resourceGroup }}</span>

          <span class="spacer" />

          <!--
            One refresh governs the whole view: triage, problems and the list all
            recompute from the same fetch. Manual "refresh now" plus an optional
            auto-refresh on an interval, sat in the app header so their scope reads
            as the page, not just the list below.
          -->
          <div class="viewrefresh" title="Refreshes triage, problems and the instance list">
            <RefreshButton :busy="listRefreshing" label="Refresh now" @refresh="refreshList" />
            <label class="auto">
              <input
                type="checkbox"
                :checked="autoRefresh"
                @change="autoRefresh = ($event.target as HTMLInputElement).checked"
              />
              Auto
            </label>
            <!-- Floor of 10s: this polls the app the operator has open. -->
            <input
              class="secs"
              type="number"
              min="10"
              step="5"
              :value="refreshSeconds"
              :disabled="!autoRefresh"
              aria-label="Refresh interval in seconds"
              @change="refreshSeconds = Number(($event.target as HTMLInputElement).value)"
            />
            <span class="faint">s</span>
          </div>
        </nav>

        <InstanceList
          v-if="target !== null"
          :instances="instances"
          :filters="filters"
          :loading="loading"
          :has-more="continuationToken !== undefined"
          @update:filters="onFilters"
          @apply="fetchInstances(false)"
          @load-more="fetchInstances(true)"
          @select="openInstance"
          @go-to-instance="openInstanceById"
        />
      </template>
    </template>
  </main>

  <!-- Build identity + the legal/About entry point, out of the way at the foot. -->
  <footer class="statusbar">
    <span class="ver mono">v{{ appVersion }}</span>
    <span class="sha mono faint" :title="`build ${buildSha}`">{{ buildSha }}</span>
    <span class="spacer" />
    <button class="aboutlink" @click="showAbout = true">About &amp; legal</button>
  </footer>

  <AboutDialog v-if="showAbout" @close="showAbout = false" />
</template>

<style scoped>
main {
  padding-bottom: 24px;
}

.landing {
  padding: 40px 16px;
  max-width: 68ch;
}

.ltitle {
  font-size: 24px;
  font-weight: 600;
  margin: 0 0 10px;
}

.lsub {
  color: var(--text-dim);
  margin: 0 0 20px;
  line-height: 1.5;
}

.primary.big {
  font-size: 14px;
  padding: 8px 16px;
  border-radius: 6px;
}

.access {
  margin-top: 28px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-raised);
}

.access h2 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-faint);
  margin: 0 0 10px;
}

.access ol {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.access li {
  line-height: 1.5;
  color: var(--text-dim);
}

.access strong {
  color: var(--text);
  font-weight: 600;
}

.consentbtn {
  display: inline-block;
  margin-top: 6px;
  padding: 5px 12px;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  text-decoration: none;
  font-size: 13px;
}

.consentbtn:hover {
  background: var(--accent-dim);
}

.err {
  margin: 12px 14px 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
}

.errtop {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.corsfix {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
}

.corsrow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.corsrow .clbl {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-faint);
  min-width: 92px;
}

.corsrow code {
  font-size: 12px;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
}

.corsrow code.cmd {
  overflow-x: auto;
  max-width: 100%;
  white-space: pre;
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px 0;
  font-size: 13px;
}

.crumb {
  padding: 0;
  border: none;
  background: none;
  color: var(--text);
  font: inherit;
}

.crumb.link {
  color: var(--accent);
  cursor: pointer;
}

.crumb.link:hover {
  text-decoration: underline;
}

.crumb.current {
  font-weight: 600;
}

.sep {
  color: var(--text-faint);
}

.rg {
  font-size: 11px;
}

.crumbs .spacer {
  flex: 1;
}

.viewrefresh {
  display: flex;
  align-items: center;
  gap: 6px;
}

.viewrefresh .auto {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  cursor: pointer;
}

.viewrefresh .secs {
  width: 58px;
  font: inherit;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 6px;
}

.statusbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 14px;
  border-top: 1px solid var(--border);
  background: var(--bg-raised);
  font-size: 11px;
  color: var(--text-faint);
}

.statusbar .ver {
  color: var(--text-dim);
  font-weight: 600;
}

.statusbar .sha {
  font-size: 10px;
}

.statusbar .spacer {
  flex: 1;
}

.aboutlink {
  border: none;
  background: none;
  color: var(--text-dim);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  padding: 2px 4px;
}

.aboutlink:hover {
  color: var(--text);
  text-decoration: underline;
}
</style>
