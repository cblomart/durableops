<script setup lang="ts">
import { computed } from 'vue';
import type { InstanceAction, InstanceDetail } from '../api/durable';
import type { Result } from '../api/errors';
import { detectStuck } from '../triage';
import JsonBlock from './JsonBlock.vue';
import HistoryTimeline from './HistoryTimeline.vue';
import FailureSummary from './FailureSummary.vue';
import ActionBar from './ActionBar.vue';
import CopyButton from './CopyButton.vue';

const props = defineProps<{
  detail: InstanceDetail;
  appName: string;
  runner: (
    action: InstanceAction,
    args: { reason?: string; eventName?: string; payload?: unknown }
  ) => Promise<Result<void>>;
}>();

defineEmits<{ back: []; home: []; actionDone: [action: InstanceAction] }>();

const stuck = computed(() => detectStuck(props.detail.historyEvents, props.detail.runtimeStatus));

/** Lead with the error for the states an operator gets paged about. */
const isProblem = computed(
  () => props.detail.runtimeStatus === 'Failed' || props.detail.runtimeStatus === 'Terminated'
);
</script>

<template>
  <section class="detail">
    <header class="head">
      <!--
        A real breadcrumb, broad to specific, so an operator always knows where
        they are: which app, which orchestrator, which instance. App and app name
        are clickable to step back up; the instance is the current location.
      -->
      <nav class="crumbs" aria-label="Breadcrumb">
        <button class="crumb link" @click="$emit('home')">Apps</button>
        <span class="sep" aria-hidden="true">›</span>
        <button class="crumb link" @click="$emit('back')">{{ appName }}</button>
        <span class="sep" aria-hidden="true">›</span>
        <span class="crumb">{{ detail.name || '(unnamed orchestrator)' }}</span>
      </nav>

      <div class="title">
        <span class="badge" :class="detail.runtimeStatus.toLowerCase()">
          {{ detail.runtimeStatus }}
        </span>
        <span class="idlabel faint">instance</span>
        <span class="id mono">{{ detail.instanceId }}</span>
        <CopyButton :value="detail.instanceId" label="Copy instance ID" />
      </div>
    </header>

    <!-- Remediation, right under the header: see the error, then act on it. -->
    <ActionBar
      :instance-id="detail.instanceId"
      :orchestrator="detail.name || '(unnamed)'"
      :app-name="appName"
      :runtime-status="detail.runtimeStatus"
      :runner="runner"
      @done="(action) => $emit('actionDone', action)"
    />

    <!--
      Lead with the error. An operator opening a Failed/Terminated instance wants
      the cause first, not after scrolling past input and custom status.
    -->
    <FailureSummary
      v-if="isProblem"
      :output="detail.output"
      :runtime-status="detail.runtimeStatus"
    />

    <!--
      A "possibly stuck" hint, never a verdict: from history alone, a legitimately
      long activity is indistinguishable from one that will never return.
    -->
    <div v-if="stuck.stuck" class="banner warn stuckbar">
      <span>Possibly stuck at scheduling — {{ stuck.detail }}.</span>
    </div>

    <dl class="meta">
      <div>
        <dt>Created</dt>
        <dd class="mono">{{ detail.createdTime || '—' }}</dd>
      </div>
      <div>
        <dt>Last updated</dt>
        <dd class="mono">{{ detail.lastUpdatedTime || '—' }}</dd>
      </div>
    </dl>

    <!--
      Instance payloads, first-class rather than buried. The input anchors "which
      customer/order is this", and custom status is where developers log their
      own diagnostics — often the thing that actually explains a failure. Each is
      collapsed by JsonBlock when large; Output is redundant with the failure
      summary on a problem instance, so it is shown only otherwise.
    -->
    <section class="payloads">
      <JsonBlock label="Input" :value="detail.input" />
      <JsonBlock label="Custom status" :value="detail.customStatus" />
      <JsonBlock v-if="!isProblem" label="Output" :value="detail.output" />
    </section>

    <HistoryTimeline :events="detail.historyEvents" :stuck-index="stuck.index" />
  </section>
</template>

<style scoped>
.detail {
  padding: 12px 14px;
}

.head {
  margin-bottom: 12px;
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
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

.sep {
  color: var(--text-faint);
}

.title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.idlabel {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.id {
  font-weight: 600;
}

.stuckbar {
  margin-bottom: 10px;
}

.payloads {
  margin: 0 0 12px;
}

.meta {
  display: flex;
  gap: 24px;
  margin: 0 0 12px;
}

.meta div {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

dt {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-faint);
}

dd {
  margin: 0;
  font-size: 12px;
}

.badge {
  padding: 1px 7px;
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
</style>
