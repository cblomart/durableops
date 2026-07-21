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
            delegated token. Nothing about your session is sent to whoever operates this instance.
            The only things stored on your device are your sign-in token (kept by Microsoft's
            library, in tab-scoped session storage) and your list of favourite apps (local storage)
            — both strictly necessary, so there are no tracking cookies and no consent banner.
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

.imprint {
  color: var(--text);
}
</style>
