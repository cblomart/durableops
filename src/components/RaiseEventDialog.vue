<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, useTemplateRef } from 'vue';

const props = defineProps<{
  instanceId: string;
  busy: boolean;
}>();

const emit = defineEmits<{ confirm: [eventName: string, payload: unknown]; cancel: [] }>();

const eventName = ref('');
const payloadText = ref('');
const nameInput = useTemplateRef<HTMLInputElement>('nameInput');

/** Empty payload is valid (a bare signal); otherwise it must parse as JSON. */
const payloadError = computed<string>(() => {
  if (payloadText.value.trim() === '') return '';
  try {
    JSON.parse(payloadText.value);
    return '';
  } catch (cause: unknown) {
    return cause instanceof Error ? cause.message : 'Invalid JSON';
  }
});

const ready = computed(
  () => eventName.value.trim() !== '' && payloadError.value === '' && !props.busy
);

function confirm(): void {
  if (!ready.value) return;
  const payload: unknown = payloadText.value.trim() === '' ? null : JSON.parse(payloadText.value);
  emit('confirm', eventName.value.trim(), payload);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('cancel');
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  nameInput.value?.focus();
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="backdrop" @click.self="emit('cancel')">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Raise event">
      <h2 class="title">Raise event</h2>
      <p class="desc">
        Send an external event to instance <span class="mono">{{ instanceId }}</span
        >. The orchestrator must be waiting for this event by name.
      </p>

      <label class="field">
        <span>Event name</span>
        <input
          ref="nameInput"
          v-model="eventName"
          type="text"
          placeholder="Approval"
          @keydown.stop
        />
      </label>

      <label class="field">
        <span>JSON payload <span class="faint">(optional)</span></span>
        <textarea
          v-model="payloadText"
          rows="5"
          class="mono"
          placeholder='{ "approved": true }'
          @keydown.stop
        />
      </label>
      <p v-if="payloadError" class="err">Payload is not valid JSON: {{ payloadError }}</p>

      <div class="actions">
        <button :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button class="primary" :disabled="!ready" @click="confirm">
          {{ busy ? 'Sending…' : 'Send event' }}
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

.desc {
  margin: 0 0 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
  font-size: 12px;
}

.field input,
.field textarea {
  font: inherit;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 8px;
  resize: vertical;
}

.err {
  margin: 0 0 12px;
  color: var(--danger);
  font-size: 12px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
