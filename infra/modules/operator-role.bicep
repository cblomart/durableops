// The "DurableOps Operator" custom role.
//
// Least privilege that actually works: reading the app list needs
// `sites/read`, and fetching the durable system key needs
// `sites/host/listkeys/action`. Nothing else is required, so nothing else is
// granted.
//
// Intended to be assigned as PIM-ELIGIBLE, not permanent. `listkeys/action` is
// deliberately powerful — the same response also carries the app's master key
// (Azure exposes no finer-grained permission for the durable system key), so the
// right control is a time-boxed activation rather than a standing assignment.
// DurableOps reads only systemKeys.durabletask_extension and ignores the rest.
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
    description: 'Read function apps and retrieve the durabletask system key, nothing else. Intended to be assigned as PIM-eligible and activated for a triage window.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.Web/sites/read'
          'Microsoft.Web/sites/host/listkeys/action'
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
