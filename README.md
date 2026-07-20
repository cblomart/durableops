# DurableOps

A 100% client-side SPA for troubleshooting **Azure Durable Functions at scale** (hundreds of function apps), built to work smoothly with **Entra ID PIM**.

DurableOps has **no backend and no identity of its own**. Every Azure call is made from your browser with *your* token, so **Azure enforces your real RBAC on every request**. There is no service principal to over-privilege, no connection string to leak, and no server to compromise.

> Reference UX: [microsoft/DurableFunctionsMonitor](https://github.com/microsoft/DurableFunctionsMonitor) (DfMon). DfMon runs a backend holding its own credentials. DurableOps deliberately does not.

---

## How it works

| Step | Mechanism | Why |
| --- | --- | --- |
| **Discovery** | Azure Resource Graph, with your ARM token | ARG only returns resources *you* can see, so the app list **is** your real access, by construction |
| **Keys** | `listkeys` via ARM, per app, on demand | Fetched only when you open an app; held in memory, never persisted |
| **Reads & actions** | The Durable Functions **HTTP management API** on each function app | Served by the runtime, so it works on any storage backend (Azure Storage, MSSQL, Netherite, DTS) and never depends on internal table schemas |

The tool never touches the storage data plane and never reads the DurableTask table schema — Microsoft explicitly warns against depending on it.

### Status

- **M1 — auth + discovery:** sign-in, app list from ARG, search, favourites, Refresh rights.
- **M2 — read-only troubleshooting:** per-app instance list with filters and paging, triage header (orchestrator × status), **inline error on failed rows**, **error-signature grouping** ("one bug or many?"), instance detail that **leads with the failure**, expandable history timeline with prev/next-failure navigation, and the "possibly stuck" hint.
- **M3 — actions:** Terminate, Rewind, Restart, Suspend/Resume, Raise event, Purge — each gated by a confirmation dialog whose **mandatory ≥10-char reason is the confirmation gesture**, forwarded (with the acting UPN) to the app's telemetry. Verified against a live harness: the actions actually transition real instances.
- Beyond the brief, for 2 AM triage: an operability filter (only shows apps you can act on), a durable-only filter, copy buttons, relative timestamps, keyboard navigation (`j`/`k`/`enter`/`/`), and an opt-in **favourites failure scan**.
- M4 (hardening) — CSP, security headers, and the error taxonomy are in place; see the threat model.

---

## Setup

### 1. Entra app registration (the only one — for the SPA itself)

There is **no client secret**: a SPA cannot hold one. Authentication is auth code + PKCE.

> **The az CLI cannot create a SPA registration.** As of az 2.76 `az ad app create` only offers
> `--web-redirect-uris` and `--public-client-redirect-uris`; neither is the SPA platform, and only
> the SPA platform does auth-code + PKCE without a client secret. The redirect URIs must therefore
> be set through Microsoft Graph, as below.

```bash
APP_ID=$(az ad app create \
  --display-name "DurableOps" \
  --sign-in-audience AzureADMyOrg \
  --query appId -o tsv)

OBJ_ID=$(az ad app show --id "$APP_ID" --query id -o tsv)

# Set the SPA platform (az cannot do this).
az rest --method patch \
  --uri "https://graph.microsoft.com/v1.0/applications/${OBJ_ID}" \
  --headers "Content-Type=application/json" \
  --body '{"spa":{"redirectUris":["https://<your-swa-hostname>","http://localhost:5173"]}}'

# Delegated permission: ARM user_impersonation.
#   797f4846-ba00-4fd7-ba43-dac1f8f63013 = Azure Service Management API
#   41094075-9dad-400e-a0bd-54e686782033 = user_impersonation (delegated)
az ad app permission add --id "$APP_ID" \
  --api 797f4846-ba00-4fd7-ba43-dac1f8f63013 \
  --api-permissions 41094075-9dad-400e-a0bd-54e686782033=Scope

# A service principal must exist before consent has anything to attach to.
az ad sp create --id "$APP_ID"

# Grant tenant-wide admin consent (a tenant admin must run this once).
#
# NOTE: `az ad app permission admin-consent` exits 0 even when it grants nothing.
# Use the explicit grant and verify it landed, rather than trusting the exit code.
az ad app permission grant --id "$APP_ID" \
  --api 797f4846-ba00-4fd7-ba43-dac1f8f63013 \
  --scope user_impersonation

# Verify: this must list `user_impersonation` with consentType AllPrincipals.
SP_ID=$(az ad sp list --filter "appId eq '$APP_ID'" --query "[0].id" -o tsv)
az rest --method get \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/${SP_ID}/oauth2PermissionGrants" \
  --query "value[].{scope:scope, consentType:consentType}"
```

Then set `tenantId` / `clientId` in `config.json` (see [Deployment](#deployment)).

Requesting `user_impersonation` grants DurableOps the *ability to ask* ARM on your behalf — it grants **no rights of its own**. What you can actually do is still decided by your Azure RBAC, per call.

### 2. Operator RBAC (designed to be PIM-eligible)

DurableOps needs two permissions to work: `Microsoft.Web/sites/read` (discovery) and
`Microsoft.Web/sites/host/listkeys/action` (the durable system key).

**Azure ships no built-in role that grants `listkeys` without also granting write.** Exactly four
built-in roles include it — Owner, Contributor, Website Contributor, and Logic Apps Standard
Contributor — and every one of them also grants `Microsoft.Web/sites/*`, i.e. the power to modify or
delete the app. There is no read-only path to a function key. Pick one of:

#### Option A — Website Contributor, made eligible through PIM for Groups (recommended)

Uses only built-in roles, so there is no custom role to own or govern. The trade-off is explicit:
**an operator with an active assignment can also modify or delete the function app.** PIM bounds
that to a time-boxed activation window rather than a standing grant.

```bash
# 1. A group whose membership IS the privilege.
az ad group create --display-name "DurableOps Operators" \
  --mail-nickname "durableops-operators"

GROUP_ID=$(az ad group list --display-name "DurableOps Operators" --query "[0].id" -o tsv)

# 2. One standing RBAC assignment, on the group. Nobody is a member.
az role assignment create --assignee-object-id "$GROUP_ID" --assignee-principal-type Group \
  --role "Website Contributor" --scope "/subscriptions/<sub-id>"
```

3. Make each operator an **eligible member** of the group:
   **Entra ID → Groups → DurableOps Operators → Privileged Identity Management → Add assignments →
   role `Member` → assignment type `Eligible`**.

> `az` cannot perform step 3: the Azure CLI's Graph token lacks the
> `PrivilegedEligibilitySchedule.ReadWrite.AzureADGroup` scope. Use the portal or a Graph client
> holding that permission.

Operators then activate group membership for a triage window and click **Refresh rights**. One RBAC
assignment covers the whole team, and joining the team is an Entra group change rather than a new
role assignment.

#### Option B — the custom role (tighter, but you own its lifecycle)

[`infra/modules/operator-role.bicep`](infra/modules/operator-role.bicep) defines a **DurableOps
Operator** role with exactly the two actions above and nothing else — strictly least privilege, and
it cannot delete anything.

```bash
az deployment sub create --location westeurope --template-file infra/main.bicep \
  --parameters environment=dev deployOperatorRole=true
```

Off by default: creating a role definition needs `Microsoft.Authorization/roleDefinitions/write`
(Owner or User Access Administrator). Assign it the same way as Option A — the group and PIM
mechanics are identical, only the role differs.

> **Why `listkeys` deserves PIM either way.** The response also carries the app's **master key**;
> Azure exposes no finer-grained permission for the durable system key alone. DurableOps reads only
> `systemKeys.durabletask_extension` and ignores the rest, but the *permission* is broader than what
> the tool uses. That is an Azure API limitation, not a design choice — and the reason the grant
> should be time-boxed rather than standing.

Make it **PIM-eligible**, not permanent. The whole tool is built around that: `listkeys/action` is a powerful permission (the system key is app-wide), so it should be activated for a triage window and expire on its own.

> **Note on `listkeys`.** There is no finer-grained built-in permission: retrieving the durable system key requires `Microsoft.Web/sites/host/listkeys/action`, which also exposes the app's master key in the same response. DurableOps reads only `systemKeys.durabletask_extension` and ignores the rest — but the *permission* is broader than what the tool uses. That is an Azure API limitation, not a design choice, and it is precisely why the role should be PIM-eligible and time-boxed.

### 3. CORS on each function app (the one infrastructure prerequisite)

The browser calls each function app directly, so **every app must allow the SPA's origin**:

```bash
az functionapp cors add \
  --name <function-app-name> \
  --resource-group <rg> \
  --allowed-origins "https://<your-swa-hostname>"
```

For a fleet, **do not do this by hand** — enforce it via Azure Policy (`Modify` effect on `Microsoft.Web/sites/config`) or in whatever IaC provisions the apps. Without it, calls fail with an opaque browser CORS error that no amount of DurableOps configuration can fix.

### 4. Easy Auth: a fleet condition worth checking first

If a function app has **App Service Authentication ("Easy Auth")** enabled, it rejects requests **before** the Functions runtime evaluates the `?code=` system key. A perfectly valid key still gets `401`, and from a browser the redirect to `login.microsoftonline.com` carries no CORS headers — so it surfaces as an *opaque CORS error that CORS configuration will not fix*.

This is not hypothetical: it was found on a real app during the design spike.

Check your fleet before rolling out:

```bash
# Lists apps with Easy Auth on — these will not be reachable from a browser-only tool.
az rest --method get \
  --uri "<site-resource-id>/config/authsettingsV2?api-version=2023-12-01" \
  --query "properties.platform.enabled"
```

Options, in order of preference:

1. Leave Easy Auth on and accept those apps are out of scope for DurableOps.
2. Exclude the `/runtime/webhooks/durabletask` path from Easy Auth (`globalValidation.excludedPaths`), keeping the system key as the authorization gate.
3. Set `unauthenticatedClientAction: Return401` so failures are at least honest 401s rather than CORS-shaped mysteries.

DurableOps reports this as its own error kind (`easyAuth`) so operators are not sent down the CORS path for a problem CORS cannot solve.

---

## Deployment

Static files only — deployable to Azure Static Web Apps or a storage static website.

```bash
npm ci
npm run build        # -> dist/
```

`config.json` is **generated at deploy time** and is gitignored. One build artifact promotes across environments:

```json
{
  "tenantId": "<entra-tenant-id>",
  "clientId": "<durableops-spa-client-id>"
}
```

For local development: `cp public/config.json.example public/config.json` and fill it in.

Infrastructure lives in [`infra/`](infra/) as Bicep and is deployed from GitHub Actions using **OIDC federated credentials** (`azure/login`) — no long-lived cloud secrets in the repo. The Azure deploy workflow is **manual** (`workflow_dispatch`); it is not wired to run on every push.

### Host it yourself

DurableOps is static files with runtime config, so any organisation can host its own copy on whatever serves static assets (Azure Static Web Apps, blob static website, Nginx, GitHub Pages, …). Two ways to point it at Entra:

- **Your own app registration (recommended):** create a single-tenant SPA registration as in [Setup §1](#1-entra-app-registration-the-only-one--for-the-spa-itself), then set `tenantId` + `clientId` in `config.json`. Nothing is shared with anyone else.
- **Consent to an existing multi-tenant deployment:** if you use a shared multi-tenant instance (see below), a tenant admin grants consent once and your users sign in against it — no registration of your own. The app still only ever acts as each signed-in user, bounded by their Azure RBAC.

### Multi-tenant deployment (e.g. GitHub Pages)

For a single public instance that any organisation can use, set `multitenant: true` and omit `tenantId` — sign-in then goes through the `/organizations` authority and the tenant is discovered from the signed-in account:

```json
{ "clientId": "<durableops-spa-client-id>", "multitenant": true }
```

The app registration must be **multi-tenant** (`signInAudience: AzureADMultipleOrgs`). This widens *who* can sign in, not what the app can do: there is no client secret and no app-only permission, so it can only ever act as the delegated user under their own RBAC. Each organisation's users (or an admin, via the landing page's **Grant admin consent** button) consent to the Azure Service Management permission once.

A ready **[GitHub Pages workflow](.github/workflows/pages.yml)** builds this multi-tenant variant under the `/durableops/` base path and deploys with the built-in `GITHUB_TOKEN` (no cloud credentials). It is `workflow_dispatch`-only and dormant until you enable Pages (**Settings → Pages → Source: GitHub Actions**; a private repo needs GitHub Pro, a public repo is free).

### CSP and custom domains

[`index.html`](index.html) ships a strict CSP whose `connect-src` allows exactly three origins: `login.microsoftonline.com`, `management.azure.com`, and `*.azurewebsites.net`. If your function apps use **custom domains**, an **App Service Environment**, or a **sovereign cloud**, extend `connect-src` accordingly or the browser will block the calls. DurableOps reads each app's real hostname from ARM rather than assuming `{name}.azurewebsites.net`, so custom domains work — provided CSP allows them.

---

## Threat model

**What DurableOps holds: nothing at rest.**

| Concern | Design |
| --- | --- |
| **Tool credentials** | None. No backend, no service principal, no client secret, no connection strings. There is no credential to steal from this tool because it has none. |
| **Authorization** | Enforced by **Azure, per call**, against the signed-in user's RBAC. DurableOps cannot grant itself anything; a compromised browser session is bounded by that user's own roles. |
| **System keys** | Fetched on demand via ARM, held **in memory only** (module-scoped `Map`), never written to `localStorage` / `sessionStorage` / IndexedDB / URLs. Cleared on sign-out and on **Refresh rights**. They die with the tab. |
| **Tokens** | MSAL caches tokens in **`sessionStorage`** — scoped to the tab, discarded when it closes, and not shared across tabs like `localStorage` would be. This is a forced choice, not a preference: MSAL cannot run the redirect flow with `memoryStorage` (it throws `in_mem_redirect_unavailable`, since auth state must survive the navigation to Entra and back), and popup-only auth breaks whenever a browser blocks the popup. So an ARM bearer token **is** at rest in the tab's `sessionStorage` for the session's duration. Our own code never reads or writes it — the ESLint restricted-globals rule forbids that; only MSAL's own cache does. |
| **Persistence** | Exactly one thing is ever persisted: **favourite app names** in `localStorage`. No keys, no tokens, no instance data. Stealing it reveals a list of app names and grants no access. |
| **Audit trail** | The tool stores nothing, *by design*. Destructive actions require a mandatory reason, sent to the target app as `DurableOps/{UPN}: {reason}` in the `reason` parameter — so **who** and **why** land in the target app's own logs / App Insights. The audit trail lives app-side, where it cannot be edited by the tool. |
| **Telemetry** | None of any kind. MSAL logging is disabled. The CSP blocks calls to any origin other than the three above, so an accidental beacon cannot leave the page. |
| **PIM** | Azure evaluates RBAC server-side on every call, so an activated role applies within moments. **Refresh rights** drops cached keys and forces a fresh token — no re-login. |

**Residual risks, stated plainly:**

- An ARM access token sits in the tab's `sessionStorage` while signed in (see **Tokens** above — MSAL's redirect flow requires it). Anything that can run script in the page can read it. This is the standard MSAL SPA posture, and the same strict CSP and minimal dependency tree that protect the system keys protect this too.
- `listkeys` returns the app's master key alongside the durable system key. DurableOps ignores it, but the *permission* is broad — hence PIM-eligible and time-boxed (see above).
- A system key in browser memory is readable by anything that can run script in the page. The strict CSP (no inline scripts, no third-party origins) and the near-zero dependency count are what defend that; the small, auditable dependency tree is a security control, not just an aesthetic.
- Anyone who can deploy to the hosting origin can serve modified JavaScript to operators. Protect the deployment pipeline as you would any privileged path.

---

## Development

```bash
npm ci
cp public/config.json.example public/config.json   # then fill in tenantId / clientId
npm run dev

npm run verify    # format + lint + typecheck + coverage + build (what CI enforces)
```

### Quality gates (all enforced in CI, required for merge)

- **Lint** — ESLint flat config + `eslint-plugin-vue` + `typescript-eslint` (strict, type-aware), Prettier, `--max-warnings 0`
- **Types** — `vue-tsc --noEmit`, TypeScript `strict`, no `any`
- **Complexity** — `complexity` max 10, `max-lines-per-function` 80, `max-depth` 3
- **Coverage** — Vitest v8: ≥ 80% lines/branches on `src/api/**`, ≥ 70% global. *Ratchet up, never down.*
- **Security** — `npm audit` (high+), Dependency Review, CodeQL, Dependabot, secret scanning + push protection

Two lint rules encode the security model directly, so a violation fails the build rather than relying on a reviewer noticing: `sessionStorage`/`indexedDB` are restricted globals, and `no-console` keeps stray output out of an ops tool.

### Testing

Three layers:

1. **Unit** (Vitest, mocked `fetch`) — API modules: pagination, continuation tokens, error mapping. Runs on every PR.
2. **Integration** (real Azure) — the same `src/api/*` modules under Node against a deployed **test harness** function app (`test-harness/`) in a **dedicated resource group**, using a CI service principal holding exactly the operator role. Runs on merges to `main` and nightly.
3. **UI** (Playwright) — deterministic E2E with MSAL mocked and stubbed API responses; plus one nightly smoke test against the deployed SWA.

---

## Dependencies

Runtime: **`vue`** and **`@azure/msal-browser`**. That is the whole list.

No UI framework, no state library, no HTTP client, no MSAL wrapper. This is an ops tool built with AI assistance: it must stay small enough for a human to audit completely. Bundle: **~87 KB gzipped** (target < 300 KB).

## Out of scope (v1)

Multi-tenant support, entity signalling beyond `raiseEvent`, batch purge, Durable Task Scheduler dashboards (DTS has its own), and any server-side component.

## License

MIT — see [LICENSE](LICENSE).
