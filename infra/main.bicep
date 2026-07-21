// DurableOps infrastructure — everything, from empty subscription to running app.
//
// Nothing here is click-ops: this template creates its own resource groups and
// owns every resource DurableOps needs. Deployed from GitHub Actions via OIDC
// federated credentials (azure/login), so no long-lived cloud secret exists.
//
//   az deployment sub create \
//     --location westeurope \
//     --template-file infra/main.bicep \
//     --parameters environment=dev
//
targetScope = 'subscription'

@description('Short environment name, used to build resource names.')
@allowed(['dev', 'prod'])
param environment string = 'dev'

@description('Region for all resources.')
param location string = 'westeurope'

@description('Deploy the integration-test harness function app. Keep off in prod.')
param deployTestHarness bool = true

@description('Static Web App tier. Defaults to Standard for prod (SLA + Front Door edge + custom domains) and Free elsewhere, so dev/test never sits on the paid prod plan.')
@allowed(['Free', 'Standard'])
param swaSku string = environment == 'prod' ? 'Standard' : 'Free'

@description('Create the DurableOps Operator custom role. Needs Owner or User Access Administrator on the subscription; leave off if you lack those rights or manage roles elsewhere.')
param deployOperatorRole bool = false

@description('Suffix to keep globally-unique names unique. Defaults to a hash of the subscription + environment.')
param nameSuffix string = substring(uniqueString(subscription().id, environment), 0, 5)

var appResourceGroupName = 'rg-durableops-${environment}'
var testResourceGroupName = 'rg-durableops-test-${environment}'

var commonTags = {
  application: 'DurableOps'
  environment: environment
  managedBy: 'bicep'
  repository: 'github.com/cblomart/durableops'
}

// The SPA's own resource group.
resource appResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: appResourceGroupName
  location: location
  tags: commonTags
}

// The harness lives in its own resource group so the CI service principal can be
// scoped to exactly this RG and nothing else — it is the blast radius boundary
// for the integration tests.
resource testResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = if (deployTestHarness) {
  name: testResourceGroupName
  location: location
  tags: union(commonTags, { purpose: 'integration-test-harness' })
}

// Subscription-scoped: a role definition is not a resource-group resource.
module operatorRole 'modules/operator-role.bicep' = if (deployOperatorRole) {
  name: 'durableops-operator-role'
  params: {}
}

module staticWebApp 'modules/swa.bicep' = {
  name: 'durableops-swa'
  scope: appResourceGroup
  params: {
    name: 'stapp-durableops-${environment}-${nameSuffix}'
    location: location
    tags: commonTags
    sku: swaSku
  }
}

module testHarness 'modules/test-harness.bicep' = if (deployTestHarness) {
  name: 'durableops-test-harness'
  scope: testResourceGroup
  params: {
    name: 'func-durableops-harness-${nameSuffix}'
    location: location
    tags: union(commonTags, { purpose: 'integration-test-harness' })
    // The harness must accept browser calls from the deployed SPA, exactly as a
    // real target app must. This is the CORS prerequisite from the README,
    // expressed as code so the E2E smoke test exercises the real path.
    allowedOrigin: 'https://${staticWebApp.outputs.defaultHostname}'
  }
}

output staticWebAppHostname string = staticWebApp.outputs.defaultHostname
output staticWebAppName string = staticWebApp.outputs.name
output appResourceGroupName string = appResourceGroup.name
// `!` asserts the conditional module exists; it is only dereferenced inside the
// same `deployTestHarness` guard that creates it.
output testResourceGroupName string = deployTestHarness ? testResourceGroup!.name : ''
output testHarnessAppName string = deployTestHarness ? testHarness!.outputs.name : ''
output operatorRoleDefinitionId string = deployOperatorRole ? operatorRole!.outputs.roleDefinitionId : ''
