<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, useTemplateRef } from 'vue';
import { MIN_REASON_LENGTH } from '../api/durable';

const props = defineProps<{
  title: string;
  /** Exactly what will happen, in plain words — e.g. "Terminate instance abc123… on func-prod". */
  description: string;
  confirmLabel: string;
  danger: boolean;
  /** Whether the typed reason reaches the target app's telemetry (who + why). */
  forwardsReason: boolean;
  busy: boolean;
}>();

const emit = defineEmits<{ confirm: [reason: string]; cancel: [] }>();

const reason = ref('');
const reasonInput = useTemplateRef<HTMLTextAreaElement>('reasonInput');

const remaining = computed(() => MIN_REASON_LENGTH - reason.value.trim().length);
const ready = computed(() => reason.value.trim().length >= MIN_REASON_LENGTH && !props.busy);

function confirm(): void {
  if (ready.value) emit('confirm', reason.value.trim());
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('cancel');
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  reasonInput.value?.focus();
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="backdrop" @click.self="emit('cancel')">
    <div class="dialog" role="dialog" aria-modal="true" :aria-label="title">
      <h2 class="title" :class="{ danger }">{{ title }}</h2>
      <p class="desc">{{ description }}</p>

      <label class="reasonlabel">
        <span>Reason <span class="req">(required)</span></span>
        <!--
          Typing the reason IS the confirmation gesture — there is no second
          "are you sure" step. The confirm button stays disabled until it is
          long enough, so a reflexive click cannot fire a destructive action.
        -->
        <textarea
          ref="reasonInput"
          v-model="reason"
          rows="3"
          :placeholder="`Why are you doing this? (min ${MIN_REASON_LENGTH} characters)`"
          @keydown.stop
        />
      </label>

      <p class="note faint">
        <template v-if="forwardsReason">
          Recorded in the app’s telemetry as
          <span class="mono">DurableOps/&lt;you&gt;: {{ reason.trim() || '…' }}</span> — who and
          why, auditable app-side.
        </template>
        <template v-else>
          This operation takes no reason parameter, so your note is not forwarded to the app’s
          telemetry. It only gates this confirmation.
        </template>
      </p>

      <div class="actions">
        <button :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button
          class="confirm"
          :class="{ danger }"
          :disabled="!ready"
          :title="ready ? '' : `${remaining} more character(s) needed`"
          @click="confirm"
        >
          {{ busy ? 'Working…' : confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgb(0 0 0 / 55%);
}

.dialog {
  width: 520px;
  max-width: 100%;
  max-height: 90vh;
  overflow: auto;
  padding: 16px 18px;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 12px 40px rgb(0 0 0 / 40%);
}

.title {
  margin: 0 0 8px;
  font-size: 15px;
}

.title.danger {
  color: var(--danger);
}

.desc {
  margin: 0 0 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.reasonlabel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}

.req {
  color: var(--danger);
}

textarea {
  font: inherit;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 8px;
  resize: vertical;
}

.note {
  margin: 8px 0 14px;
  font-size: 11px;
  line-height: 1.4;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.confirm.danger:not(:disabled) {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}
</style>
