import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';
import { loadConfig } from './config';
import { initAuth } from './auth';

/**
 * Config and auth must both be ready before the app mounts: config supplies the
 * tenant/client IDs MSAL needs, and MSAL must consume any redirect response
 * before a component reads the account. A failure in either is fatal and shown
 * as plain text — an ops tool that half-starts against the wrong tenant is worse
 * than one that refuses to start.
 */
async function bootstrap(): Promise<void> {
  const root = document.getElementById('app');
  if (root === null) throw new Error('#app mount point missing from index.html');

  try {
    await loadConfig();
    await initAuth();
    createApp(App).mount(root);
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    root.textContent = `DurableOps failed to start: ${message}`;
    throw cause;
  }
}

void bootstrap();
