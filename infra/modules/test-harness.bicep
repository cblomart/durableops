// Integration-test harness: a real Durable Functions app that reproduces the
// failure taxonomy an ops admin has to handle.
//
// The integration tests run the SAME src/api/*.ts modules under Node against
// this app, using a CI service principal that holds exactly the DurableOps
// Operator role on this resource group — so the tests validate the real RBAC
// path a human operator takes, not a privileged shortcut.

@description('Name of the harness function app. Must be globally unique.')
@minLength(3)
@maxLength(40)
param name string

@description('Region for all harness resources.')
param location string

@description('Tags applied to every resource.')
param tags object

@description('Origin allowed to call this app from a browser (the deployed SPA).')
param allowedOrigin string

// Storage account names: 3-24 chars, lowercase alphanumeric only. The
// uniqueString suffix both guarantees global uniqueness and keeps the name
// above the minimum length regardless of what `name` contains.
var storageAccountName = take('st${replace(toLower(name), '-', '')}${uniqueString(resourceGroup().id)}', 24)

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
  }
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${name}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// App Insights is what makes the audit story real: the `reason` parameter that
// DurableOps forwards (prefixed with the acting UPN) lands in this app's own
// telemetry, where the tool cannot edit it.
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${name}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'plan-${name}'
  location: location
  tags: tags
  sku: {
    // Consumption: the harness is idle except during test runs.
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {
    // Linux.
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: name
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'Node|22'
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      // The CORS prerequisite from the README, as code. Without this the SPA
      // cannot call the app from a browser at all.
      cors: {
        allowedOrigins: [allowedOrigin]
        supportCredentials: false
      }
      appSettings: [
        { name: 'AzureWebJobsStorage', value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${storage.listKeys().keys[0].value}' }
        { name: 'WEBSITE_CONTENTAZUREFILECONNECTIONSTRING', value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${storage.listKeys().keys[0].value}' }
        { name: 'WEBSITE_CONTENTSHARE', value: toLower(name) }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~22' }
        // The @azure/functions v4 programming model indexes functions in the
        // worker, not the host. Without this the app deploys cleanly and then
        // registers zero functions — a silent, confusing no-op.
        { name: 'AzureWebJobsFeatureFlags', value: 'EnableWorkerIndexing' }
        // Zip deploy with a remote npm install, so CI ships source, not node_modules.
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
        { name: 'ENABLE_ORYX_BUILD', value: 'true' }
        // THE stuck-at-scheduling trick: the host refuses to run this activity,
        // so any orchestrator calling it writes TaskScheduled and then waits
        // forever — a real queued-but-never-picked-up activity, not a timeout.
        { name: 'AzureWebJobs.NeverRuns.Disabled', value: '1' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
      ]
    }
  }
}

// NOTE: Easy Auth (authsettingsV2) is deliberately NOT enabled on this app.
//
// Easy Auth intercepts requests before the Functions runtime evaluates the
// `?code=` system key, so a valid key still yields 401 — and from a browser it
// surfaces as an opaque CORS error rather than an honest 401. This was verified
// live against a real app during the design spike. The harness must stay
// reachable for the tests to mean anything; the `easyAuth` error path is covered
// by unit tests instead.

output name string = functionApp.name
output id string = functionApp.id
output defaultHostName string = functionApp.properties.defaultHostName
output principalId string = functionApp.identity.principalId
