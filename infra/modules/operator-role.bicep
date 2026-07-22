// The "DurableOps Operator" custom role.
//
// Least privilege that actually works: reading the app list needs `sites/read`,
// and every Durable operation — listing instances and acting on them — goes
// through the app's host runtime, which needs `sites/hostruntime/*`. Nothing
// else is granted.
//
// This role holds NO `listkeys` permission. DurableOps reaches the Durable
// webhook API through ARM's hostruntime proxy, authorised by the caller's ARM
// token, so it never fetches an app's system key — nor the master key the same
// listkeys response would also expose. That removes the sharpest edge the old
// role had. The hostruntime actions are still management-plane operations on the
// app's runtime, so this is best assigned PIM-ELIGIBLE and activated for a triage
// window, not left standing.
//
// Creating a role definition needs Microsoft.Authorization/roleDefinitions/write
// (Owner or User Access Administrator), which is why main.bicep gates this
// behind a flag: the SPA itself deploys fine without it.
targetScope = 'subscription'

@description('Role name as it appears in the portal.')
param roleName string = 'DurableOps Operator'

resource operatorRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  // Deterministic GUID: re-deploying updates the same role instead of creating duplicates.
  name: guid(subscription().id, roleName)
  properties: {
    roleName: roleName
    description: 'Read function apps and invoke their host runtime (the Durable webhook API via ARM), nothing else. No listkeys or system-key access. Intended to be assigned as PIM-eligible and activated for a triage window.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.Web/sites/read'
          'Microsoft.Web/sites/hostruntime/*'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    assignableScopes: [
      subscription().id
    ]
  }
}

output roleDefinitionId string = operatorRole.id
output roleName string = operatorRole.properties.roleName
