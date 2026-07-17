// Azure Static Web App hosting the DurableOps SPA.
//
// Static files only. There is deliberately no managed API (`Microsoft.Web/staticSites/config`
// for functions is never configured): a backend would give the tool an identity
// of its own, which is exactly what this architecture rejects.

@description('Name of the static web app.')
param name string

@description('Region. Note: SWA is available in a limited set of regions.')
param location string

@description('Tags applied to the resource.')
param tags object

resource staticSite 'Microsoft.Web/staticSites@2023-12-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    // Free is sufficient: this serves a handful of static assets and has no API.
    name: 'Free'
    tier: 'Free'
  }
  properties: {
    // The build is produced by GitHub Actions and pushed with the SWA deploy
    // action, rather than SWA building from source itself. That keeps one
    // reviewed artifact promotable across environments.
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: 'Enabled'
    provider: 'Custom'
  }
}

output name string = staticSite.name
output defaultHostname string = staticSite.properties.defaultHostname
output id string = staticSite.id
