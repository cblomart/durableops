<script setup lang="ts">
import { computed } from 'vue';
import type { OrchestrationInstance } from '../api/durable';
import { buildTriage, ATTENTION_STATUSES } from '../triage';

const props = defineProps<{
  instances: OrchestrationInstance[];
  /** Whether more pages exist, so the header can admit it is not hub-wide. */
  hasMore: boolean;
}>();

defineEmits<{ pick: [name: string, status: string] }>();

const rows = computed(() => buildTriage(props.instances));
</script>

<template>
  <section v-if="rows.length > 0" class="triage">
    <header class="head">
      <span class="title">Triage</span>
      <span class="faint scope">
        {{ instances.length }} loaded instance{{ instances.length === 1 ? '' : 's' }}
        <!--
          The webhook API has no aggregate endpoint, so these counts describe the
          pages fetched so far, not the whole task hub. Saying so prevents an
          operator reading "2 Failed" as "only 2 failed in total".
        -->
        <template v-if="hasMore"> · more pages not loaded</template>
      </span>
    </header>

    <div class="rows">
      <div v-for="row in rows" :key="row.name" class="row">
        <span class="name" :title="row.name">{{ row.name }}</span>
        <button
          v-for="[status, count] in row.counts"
          :key="status"
          class="cell"
          :class="{ attention: ATTENTION_STATUSES.has(status) }"
          :title="`Filter to ${row.name} · ${status}`"
          @click="$emit('pick', row.name, status)"
        >
          <span class="count">{{ count }}</span>
          <span class="status">{{ status }}</span>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.triage {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-raised);
}

.head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 6px;
}

.title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-faint);
}

.scope {
  font-size: 11px;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.name {
  min-width: 200px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 1px 7px;
  font-size: 11px;
  border-radius: 10px;
}

.cell .count {
  font-weight: 600;
}

.cell .status {
  color: var(--text-dim);
}

.cell.attention {
  border-color: var(--danger);
}

.cell.attention .count,
.cell.attention .status {
  color: var(--danger);
}
</style>
