<script setup lang="ts">
import { computed } from 'vue';
import type { InstanceAction, InstanceDetail } from '../api/durable';
import type { Result } from '../api/errors';
import { detectStuck } from '../triage';
import JsonBlock from './JsonBlock.vue';
import HistoryTimeline from './HistoryTimeline.vue';
import FailureSummary from './FailureSummary.vue';
import ActionBar from './ActionBar.vue';

const props = defineProps<{
  detail: InstanceDetail;
  appName: string;
  runner: (
    action: InstanceAction,
    args: { reason?: string; eventName?: string; payload?: unknown }
  ) => Promise<Result<void>>;
}>();

defineEmits<{ back: []; actionDone: [action: InstanceAction] }>();

const stuck = computed(() => detectStuck(props.detail.historyEvents, props.detail.runtimeStatus));

/** Lead with the error for the states an operator gets paged about. */
const isProblem = computed(
  () => props.detail.runtimeStatus === 'Failed' || props.detail.runtimeStatus === 'Terminated'
);
</script>

<template>
  <section class="detail">
    <header class="head">
      <button class="back" @click="$emit('back')">← Instances</button>
      <span class="id mono">{{ detail.instanceId }}</span>
      <span class="badge" :class="detail.runtimeStatus.toLowerCase()">{{
        detail.runtimeStatus
      }}</span>
      <span v-if="detail.name" class="orch">{{ detail.name }}</span>
      <span class="faint app">on {{ appName }}</span>
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

    <HistoryTimeline :events="detail.historyEvents" :stuck-index="stuck.index" />

    <!--
      Raw payloads live below the investigation surface now, collapsed: the
      timeline and summary are what an operator needs first. Output is redundant
      with the failure summary for problem instances, so it is hidden there.
    -->
    <details class="raw">
      <summary>Raw payloads</summary>
      <JsonBlock label="Input" :value="detail.input" />
      <JsonBlock label="Custom status" :value="detail.customStatus" />
      <JsonBlock v-if="!isProblem" label="Output" :value="detail.output" />
    </details>
  </section>
</template>

<style scoped>
.detail {
  padding: 12px 14px;
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.id {
  font-weight: 600;
}

.orch {
  color: var(--text-dim);
}

.app {
  font-size: 11px;
}

.stuckbar {
  margin-bottom: 10px;
}

.raw {
  margin-top: 16px;
}

.raw summary {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-faint);
  cursor: pointer;
  margin-bottom: 8px;
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
