/**
 * Instance-list filter state.
 *
 * Lives in its own module rather than in the component: `<script setup>` cannot
 * export declarations, so a type declared there is invisible to importers (it
 * silently resolves to `any`/error rather than failing loudly). Keeping it here
 * also lets the parent own the state so it survives navigating into an instance
 * and back.
 */
import type { RuntimeStatus } from './api/durable';

export interface Filters {
  /** Sent to the runtime as a comma-separated runtimeStatus filter. */
  statuses: RuntimeStatus[];
  /** Applied client-side: the webhook API has no server-side name filter. */
  orchestrator: string;
  /** `datetime-local` values, converted to ISO on send. */
  createdFrom: string;
  createdTo: string;
}

export function emptyFilters(): Filters {
  return { statuses: [], orchestrator: '', createdFrom: '', createdTo: '' };
}
