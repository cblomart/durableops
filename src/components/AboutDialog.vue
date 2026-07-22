<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue';
import { getConfig } from '../config';

const emit = defineEmits<{ close: [] }>();

const version = __APP_VERSION__;
const sha = __BUILD_SHA__;
const config = getConfig();

const REPO = 'https://github.com/cblomart/durableops';

// Esc closes, matching the account flyout.
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}
onMounted(() => {
  document.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="scrim" @click.self="$emit('close')">
    <section class="about" role="dialog" aria-modal="true" aria-label="About DurableOps">
      <header class="ahead">
        <h2>DurableOps</h2>
        <span class="ver mono">v{{ version }}</span>
        <span class="sha mono faint">{{ sha }}</span>
        <span class="spacer" />
        <button class="x" aria-label="Close" @click="$emit('close')">✕</button>
      </header>

      <div class="body">
        <section>
          <h3>Privacy</h3>
          <p>
            DurableOps has no backend and collects nothing. It runs entirely in your browser and
            talks only to Microsoft (sign-in) and Azure (your subscriptions), using your own
            delegated token; nothing about your session reaches whoever operates this instance. It
            <strong>sets no cookies</strong> and uses no analytics or tracking. The only things kept
            on your device are your sign-in session (held by Microsoft's library in tab-scoped
            session storage) and your list of favourite apps (local storage) — both
            <strong>strictly necessary</strong> to provide the tool you asked for. Signing in sends
            you to Microsoft, which sets its own strictly-necessary cookies on its domain.
          </p>
        </section>

        <section>
          <h3>Use at your own risk</h3>
          <p>
            DurableOps is provided <strong>“as is”, without warranty of any kind</strong>. It can
            terminate, rewind, restart and permanently purge orchestration instances in your own
            Azure subscriptions: you are responsible for the actions you take with it. To the extent
            permitted by law, the authors and operator accept no liability for any loss arising from
            its use.
          </p>
        </section>

        <section>
          <h3>Licence</h3>
          <p>
            DurableOps is open source under the
            <a :href="`${REPO}/blob/main/LICENSE`" target="_blank" rel="noopener noreferrer"
              >MIT Licence</a
            >
            (© 2026 Cedric Blomart). It bundles two MIT-licensed libraries:
            <a href="https://github.com/vuejs/core" target="_blank" rel="noopener noreferrer"
              >Vue</a
            >
            (© Evan You) and
            <a
              href="https://github.com/AzureAD/microsoft-authentication-library-for-js"
              target="_blank"
              rel="noopener noreferrer"
              >MSAL</a
            >
            (© Microsoft Corporation).
          </p>
          <p v-if="config.showGitHubStar" class="gh">
            If DurableOps saved you time, a
            <a :href="REPO" target="_blank" rel="noopener noreferrer">star on GitHub</a> helps
            others find it.
          </p>
        </section>

        <!-- Set apart from the licence so the ask actually lands, but kept warm
             and low-pressure, not a banner. -->
        <section v-if="config.donateUrl" class="support">
          <p class="supportline">
            <span class="bigheart" aria-hidden="true">♥</span>
            If DurableOps ever saved your night, you can
            <a :href="config.donateUrl" target="_blank" rel="noopener noreferrer">buy me a coffee</a
            >. Completely optional, always appreciated.
          </p>
        </section>

        <section v-if="config.operatorName">
          <h3>Legal notice</h3>
          <p class="imprint">
            Operated by <strong>{{ config.operatorName }}</strong
            ><template v-if="config.operatorId"> · {{ config.operatorId }}</template
            ><template v-if="config.operatorContact">
              · <span class="mono">{{ config.operatorContact }}</span></template
            >.
          </p>
        </section>
      </div>
    </section>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 45%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  z-index: 50;
}

.about {
  width: min(640px, 100%);
  max-height: 85vh;
  overflow-y: auto;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 10px 40px rgb(0 0 0 / 30%);
}

.ahead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.ahead h2 {
  margin: 0;
  font-size: 16px;
}

.ver {
  font-weight: 600;
}

.sha {
  font-size: 12px;
}

.spacer {
  flex: 1;
}

.x {
  border: none;
  background: none;
  color: var(--text-faint);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 6px;
}

.x:hover {
  color: var(--text);
}

.body {
  padding: 8px 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.body h3 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-faint);
  margin: 0 0 6px;
}

.body p {
  margin: 0;
  line-height: 1.55;
  color: var(--text-dim);
  font-size: 13px;
}

.body strong {
  color: var(--text);
}

/* Soft, not a pitch: a smaller, fainter aside under the licence. */
.body .gh {
  font-size: 12px;
  color: var(--text-faint);
  margin-top: 4px;
}

/* The support ask, set apart: a warm pink left-accent gives it presence without
   turning into a banner. */
.support {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-left: 3px solid #db61a2;
  border-radius: 8px;
  background: var(--bg-raised);
}

.support .supportline {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text);
}

.support .bigheart {
  color: #db61a2;
  margin-right: 3px;
}

/* Deliberately the quietest thing here: the operator imprint the law wants
   present, but not prominent. */
.imprint {
  font-size: 11px;
  color: var(--text-faint);
}
</style>
