# DurableOps

A browser-only tool for troubleshooting Azure Durable Functions across many function apps. Live at **[durableops.app](https://durableops.app)**.

There is no backend and no identity of its own. Every Azure call is made from your browser with your own token, so Azure enforces your RBAC on each request. There is no service principal, client secret, or connection string anywhere in it.

Reference UX: [DurableFunctionsMonitor](https://github.com/microsoft/DurableFunctionsMonitor), which runs a backend that holds its own credentials. DurableOps deliberately doesn't.

## How it works

- **Discovery** — Azure Resource Graph, with your ARM token. ARG only returns resources you can see, so the app list is your real access.
- **Keys** — `listkeys` via ARM, per app, on demand. Fetched when you open an app, kept in memory, never persisted.
- **Reads and actions** — the Durable Functions HTTP management API on each app. It works on any storage backend and never reads the DurableTask table.

## What it does

- Sign in, list your function apps, search, and star favourites.
- Per-app instance list with server-side filters and paging, a triage view (orchestrator × status), inline errors on failed rows, and error-signature grouping ("one bug or many?").
- Instance detail that leads with the failure, an expandable history timeline with jump-to-failure, and a "possibly stuck" hint.
- Actions: terminate, rewind, restart, suspend/resume, raise event, purge. Each needs a reason of at least 10 characters — that reason _is_ the confirmation, and it's written to the app's own telemetry as `DurableOps/{UPN}: {reason}`.
- Apps you can't operate, and apps that run no Durable Functions, are hidden. A viewport-bounded scan flags failing apps in the list.

## Setup

Three things: an Entra app registration, an operator role, and CORS on each function app.

### 1. Entra app registration

Auth is auth-code + PKCE, so there is no client secret. The az CLI can't set SPA redirect URIs, so do that through Microsoft Graph:

```bash
APP_ID=$(az ad app create --display-name "DurableOps" \
  --sign-in-audience AzureADMyOrg --query appId -o tsv)
OBJ_ID=$(az ad app show --id "$APP_ID" --query id -o tsv)

# SPA redirect URIs (az can only set web / public-client platforms, not SPA).
az rest --method patch \
  --uri "https://graph.microsoft.com/v1.0/applications/${OBJ_ID}" \
  --headers "Content-Type=application/json" \
  --body '{"spa":{"redirectUris":["https://<your-host>","http://localhost:5173"]}}'

# Delegated ARM user_impersonation, then admin-consent it (tenant admin, once).
az ad app permission add --id "$APP_ID" \
  --api 797f4846-ba00-4fd7-ba43-dac1f8f63013 \
  --api-permissions 41094075-9dad-400e-a0bd-54e686782033=Scope
az ad sp create --id "$APP_ID"
az ad app permission grant --id "$APP_ID" \
  --api 797f4846-ba00-4fd7-ba43-dac1f8f63013 --scope user_impersonation
```

`user_impersonation` only lets DurableOps _ask_ ARM on your behalf; what you can do is still decided by your RBAC, per call. Put `tenantId` and `clientId` in `config.json` (see [Deploy](#deploy)).

### 2. Operator role

DurableOps needs two permissions: `Microsoft.Web/sites/read` (discovery) and `Microsoft.Web/sites/host/listkeys/action` (the durable system key).

No built-in role grants `listkeys` without also granting write — the four that include it (Owner, Contributor, Website Contributor, Logic Apps Standard Contributor) all grant `Microsoft.Web/sites/*`. And `listkeys` returns the app's master key in the same response, which DurableOps ignores but the permission still allows. So the role should be **PIM-eligible and time-boxed**, not standing. Two options:

**A — Website Contributor via PIM for Groups (recommended).** Built-in roles only; nothing custom to own.

```bash
az ad group create --display-name "DurableOps Operators" --mail-nickname durableops-operators
GROUP_ID=$(az ad group list --display-name "DurableOps Operators" --query "[0].id" -o tsv)
az role assignment create --assignee-object-id "$GROUP_ID" --assignee-principal-type Group \
  --role "Website Contributor" --scope "/subscriptions/<sub-id>"
```

Then make each operator an **eligible** member of the group in Entra → Groups → PIM. (az can't do this step — its Graph token lacks the PIM-for-Groups scope.) Operators activate for a triage window and click **Refresh rights**.

**B — Custom role.** [`infra/modules/operator-role.bicep`](infra/modules/operator-role.bicep) grants exactly those two actions and nothing else; it can't delete anything. Deploy with `deployOperatorRole=true`. Off by default, since creating a role definition needs Owner or User Access Administrator.

### 3. CORS (and Easy Auth)

The browser calls each app directly, so each app must allow your origin:

```bash
az functionapp cors add --name <app> --resource-group <rg> \
  --allowed-origins "https://<your-host>"
```

For a fleet, enforce this with Azure Policy rather than by hand. Without it, calls fail with an opaque browser CORS error. When that happens, DurableOps shows the exact origin to add.

If an app has **App Service Authentication (Easy Auth)** on, it rejects the call before the runtime checks the key, and from a browser that also looks like a CORS error. Either exclude the `/runtime/webhooks/durabletask` path from Easy Auth, or accept the app is out of reach for a browser-only tool. DurableOps reports this as its own `easyAuth` error so you aren't sent down the CORS path for it.

## Deploy

Static files plus a runtime `config.json` — any static host works (Azure Static Web Apps, blob static website, a CDN, GitHub Pages).

```bash
npm ci && npm run build   # -> dist/
```

`config.json` is gitignored and generated at deploy time:

```json
{ "tenantId": "<entra-tenant-id>", "clientId": "<spa-client-id>" }
```

- **Self-host:** use your own app registration (above), or point users at a shared multi-tenant instance and consent to it once — no registration of your own.
- **Multi-tenant** (as on durableops.app): set `"multitenant": true` and omit `tenantId`; sign-in goes through `/organizations`. The app registration must be `AzureADMultipleOrgs`. It still only ever acts as the signed-in user under their own RBAC.
- **Operator notice:** for a publicly-offered instance, EU/Belgian law wants the provider identifiable. Optional `operatorName` / `operatorContact` / `operatorId` render quietly in the in-app About dialog.
- **CSP:** [`index.html`](index.html) ships a strict CSP allowing three origins — `login.microsoftonline.com`, `management.azure.com`, `*.azurewebsites.net`. Custom domains, App Service Environments, or sovereign clouds need `connect-src` extended.

Infrastructure is Bicep under [`infra/`](infra/). Prod is a separate Standard SWA released only by CI: merging the release PR cuts a version and deploys it. Dev is a Free SWA. Neither deploy stores a long-lived cloud secret — the pipeline authenticates with OIDC.

## Threat model

Nothing is held at rest.

- **Tool credentials:** none — no backend, secret, or connection string.
- **Authorization:** enforced by Azure per call against your RBAC. The tool can't grant itself anything.
- **System keys:** fetched on demand, kept in a memory-only `Map`, never written to storage; cleared on sign-out and Refresh rights.
- **Tokens:** MSAL caches its token in `sessionStorage` (tab-scoped, discarded on close). This is forced by MSAL's redirect flow, not a choice; our own code never reads it (an ESLint rule forbids it).
- **Persisted:** only favourite app names, in `localStorage`. Nothing else.
- **Audit:** destructive actions carry a mandatory reason into the target app's own logs; the trail lives app-side, where the tool can't edit it.
- **Telemetry:** none. MSAL logging is off, and the CSP blocks any other origin.

Residual risks, plainly: the ARM token in `sessionStorage` and any system key in memory are readable by anything that can run script on the page — the strict CSP and two-dependency tree are the defence. `listkeys` is broad (it returns the master key), which is why the role is PIM-eligible. And anyone who can deploy to the hosting origin can serve modified JavaScript, so protect the pipeline.

## Development

```bash
npm ci
cp public/config.json.example public/config.json   # fill in tenantId / clientId
npm run dev
npm run verify   # format + lint + typecheck + coverage + build (what CI runs)
```

CI must pass to merge: Prettier and ESLint (type-aware, `--max-warnings 0`), `vue-tsc` strict with no `any`, complexity ≤ 10 and functions ≤ 80 lines, coverage ≥ 80% on `src/api` and ≥ 70% overall, and dependency/SAST scanning (npm audit, Dependency Review, Semgrep, Snyk, Dependabot). Two ESLint rules encode the security model: `sessionStorage`/`indexedDB` are banned in our code, and `no-console` keeps stray output out.

Tests run in three layers: unit (Vitest, mocked `fetch`), integration (the `src/api` modules against a real Azure [test harness](test-harness/), on merge and nightly), and UI (Playwright with MSAL and Azure stubbed). Versioning is release-please over Conventional Commits.

## Dependencies

`vue` and `@azure/msal-browser`. Nothing else — no UI framework, state library, HTTP client, or MSAL wrapper, so the whole thing stays auditable. About 104 KB gzipped.

## License

MIT — see [LICENSE](LICENSE).
