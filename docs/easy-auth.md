# Running with Easy Auth

DurableOps runs entirely in your browser and acts only as you: it reaches each app's
Durable management API through ARM's `hostruntime` proxy with your delegated ARM token.
App Service Authentication ("Easy Auth") runs _inside_ the app and demands a token for the
app's **own** audience — which a management (ARM) token is not — so it blocks the proxied
call before the Durable runtime ever sees it.

We looked for a way to satisfy Easy Auth without giving up the model that makes DurableOps
trustworthy — 100% client-side, no backend, no stored secret, acting only as the signed-in
user. Every alternative (a backend doing on-behalf-of token exchange, or a token-forwarding
relay) either needs a backend credential, reintroduces the app's system key with a per-app
consent, or doesn't work at all. None was more satisfying than a small, app-side carve-out.

So the supported approach is to **exclude the Durable management webhook path from Easy
Auth**:

```
/runtime/webhooks/durabletask
```

That path stays authenticated — by Azure RBAC through the ARM proxy, and by the system key on
the app's public hostname — so you are not opening the app up; you are letting a management
endpoint use management-plane auth instead of an interactive sign-in. It is harmless on
non-durable apps (they have no such path), so you can apply it uniformly across a fleet.

## One app (Azure CLI)

```bash
ID="/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Web/sites/<app>"

# Read current auth settings, add the exclusion (merged + de-duped), write it back.
az rest --method get \
  --uri "https://management.azure.com${ID}/config/authsettingsV2/list?api-version=2023-12-01" \
| jq '{properties: (.properties
        | .globalValidation.excludedPaths =
            (((.globalValidation.excludedPaths // []) + ["/runtime/webhooks/durabletask"]) | unique))}' \
> authsettings.json

az rest --method put \
  --uri "https://management.azure.com${ID}/config/authsettingsV2?api-version=2023-12-01" \
  --body @authsettings.json
```

Verify — this should return `200`, not `401`:

```bash
TOKEN=$(az account get-access-token --resource https://management.azure.com --query accessToken -o tsv)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  "https://management.azure.com${ID}/hostruntime/runtime/webhooks/durabletask/instances?api-version=2023-12-01&top=1"
```

## Terraform (per app)

The `azurerm` `auth_settings_v2` block does not expose `excluded_paths`, so use the AzAPI
provider to patch the app's `authsettingsV2`. `azapi_update_resource` merges into the existing
auth config rather than replacing it, so your identity providers and other settings are left
untouched:

```hcl
resource "azapi_update_resource" "durable_easyauth_exclusion" {
  type        = "Microsoft.Web/sites/config@2023-12-01"
  resource_id = "${azurerm_linux_function_app.this.id}/config/authsettingsV2"

  body = {
    properties = {
      globalValidation = {
        excludedPaths = ["/runtime/webhooks/durabletask"]
      }
    }
  }
}
```

Apply it to every function app (e.g. with `for_each` over your app module). This is usually
the cleanest place to handle it — right next to where you enable Easy Auth.

## Azure Policy (fleet-wide)

A policy alias exists for the setting (`Microsoft.Web/sites/config/globalValidation.excludedPaths[*]`),
so you can **detect** apps that require Easy Auth but lack the exclusion. Assign this at a
management-group or subscription scope:

```json
{
  "properties": {
    "displayName": "Function apps requiring Easy Auth must exclude the Durable webhook path",
    "policyType": "Custom",
    "mode": "Indexed",
    "policyRule": {
      "if": {
        "allOf": [
          { "field": "type", "equals": "Microsoft.Web/sites" },
          { "field": "kind", "like": "functionapp*" }
        ]
      },
      "then": {
        "effect": "auditIfNotExists",
        "details": {
          "type": "Microsoft.Web/sites/config",
          "name": "authsettingsV2",
          "existenceCondition": {
            "anyOf": [
              {
                "field": "Microsoft.Web/sites/config/globalValidation.requireAuthentication",
                "notEquals": true
              },
              {
                "count": {
                  "field": "Microsoft.Web/sites/config/globalValidation.excludedPaths[*]",
                  "where": {
                    "field": "Microsoft.Web/sites/config/globalValidation.excludedPaths[*]",
                    "equals": "/runtime/webhooks/durabletask"
                  }
                },
                "greater": 0
              }
            ]
          }
        }
      }
    }
  }
}
```

An app is compliant when Easy Auth is not requiring authentication **or** the exclusion is
present; anything else is flagged.

**For automatic remediation, fix it in your IaC** (the Terraform above), re-applied by your
pipeline — that merges safely into the existing auth config. Do **not** reach for a
`DeployIfNotExists` policy here: its remediation template would `PUT` the whole auth config and
overwrite your identity providers and options, because policy cannot read and merge the
existing settings. A `Modify` policy that appends to `…excludedPaths[*]` is non-destructive and
possible, but pilot it on a small scope first — array-alias modify semantics are subtle.
