<script setup lang="ts">
import { computed, ref } from 'vue';
import { ACTION_META, availableActions, type InstanceAction } from '../api/durable';
import { describeError, type Result } from '../api/errors';
import ConfirmDialog from './ConfirmDialog.vue';
import RaiseEventDialog from './RaiseEventDialog.vue';

const props = defineProps<{
  instanceId: string;
  orchestrator: string;
  appName: string;
  runtimeStatus: string;
  /**
   * Executes an action against the target. Passed from the parent, which holds
   * the target (host + key) and the signed-in UPN. Returns a typed Result so the
   * dialog can show a failure without unwinding the component.
   */
  runner: (
    action: InstanceAction,
    args: { reason?: string; eventName?: string; payload?: unknown }
  ) => Promise<Result<void>>;
}>();

const emit = defineEmits<{ done: [action: InstanceAction] }>();

const actions = computed(() => availableActions(props.runtimeStatus));

/** Which dialog is open, if any. */
const active = ref<InstanceAction | null>(null);
const busy = ref(false);
const failure = ref('');

const meta = computed(() => (active.value === null ? null : ACTION_META[active.value]));

/** The exact, plain-words description of what confirming will do. */
const description = computed<string>(() => {
  const id = props.instanceId;
  const where = `of orchestrator ${props.orchestrator} on app ${props.appName}`;
  switch (active.value) {
    case 'terminate':
      return `Terminate instance ${id} ${where}. It stops immediately and cannot be resumed.`;
    case 'rewind':
      return `Rewind failed instance ${id} ${where}. The runtime replays the most recent failed steps to try to move it forward.`;
    case 'restart':
      return `Restart instance ${id} ${where}. A fresh run starts from the original input; the current run is left as-is.`;
    case 'suspend':
      return `Suspend instance ${id} ${where}. It pauses until you resume it.`;
    case 'resume':
      return `Resume instance ${id} ${where}. It continues from where it was suspended.`;
    case 'purge':
      return `Purge instance ${id} ${where}. Its history is permanently deleted. This cannot be undone.`;
    default:
      return '';
  }
});

function open(action: InstanceAction): void {
  failure.value = '';
  active.value = action;
}

function close(): void {
  active.value = null;
  busy.value = false;
  failure.value = '';
}

async function run(args: {
  reason?: string;
  eventName?: string;
  payload?: unknown;
}): Promise<void> {
  if (active.value === null) return;
  const action = active.value;
  busy.value = true;
  failure.value = '';
  const result = await props.runner(action, args);
  busy.value = false;
  if (result.ok) {
    close();
    emit('done', action);
  } else {
    failure.value = describeError(result.error);
  }
}
</script>

<template>
  <section class="actionbar">
    <button
      v-for="action in actions"
      :key="action"
      class="act"
      :class="ACTION_META[action].tone"
      @click="open(action)"
    >
      {{ ACTION_META[action].label }}
    </button>

    <RaiseEventDialog
      v-if="active === 'raiseEvent'"
      :instance-id="instanceId"
      :busy="busy"
      @cancel="close"
      @confirm="(name, payload) => run({ eventName: name, payload })"
    />

    <ConfirmDialog
      v-else-if="active !== null && meta !== null"
      :title="`${meta.label} instance`"
      :description="description"
      :confirm-label="meta.label"
      :danger="meta.tone === 'danger'"
      :forwards-reason="meta.forwardsReason"
      :busy="busy"
      @cancel="close"
      @confirm="(reason) => run({ reason })"
    />

    <p v-if="failure" class="failure banner error">{{ failure }}</p>
  </section>
</template>

<style scoped>
.actionbar {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 4px 0 12px;
}

/* Colour charter: red is reserved for the one irreversible action (purge),
   amber for the disruptive-but-recoverable one (terminate); recovery actions
   keep the neutral button styling so the page is not a wall of red. */
.act.danger {
  border-color: var(--danger);
  color: var(--danger);
}

.act.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.act.warn {
  border-color: var(--warn);
  color: var(--warn);
}

.act.warn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--warn) 12%, transparent);
}

.failure {
  flex-basis: 100%;
  margin-top: 4px;
}
</style>
