# =============================================================================
# Outputs
# =============================================================================

output "account_id" {
  description = "Cloudflare account ID (auto-discovered from API token)."
  value       = local.account_id
}

output "d1_database_id" {
  description = "ID of the D1 database."
  value       = cloudflare_d1_database.api.id
}

output "d1_database_name" {
  description = "Name of the D1 database."
  value       = cloudflare_d1_database.api.name
}

output "r2_bucket_name" {
  description = "Name of the R2 bucket."
  value       = cloudflare_r2_bucket.releases.name
}

output "worker_name" {
  description = "Name of the deployed Worker."
  value       = cloudflare_worker.api.name
}

output "worker_subdomain_url" {
  description = "Workers.dev URL for the deployed Worker, or null when workers_dev_subdomain is unset."
  value = (
    var.workers_dev_subdomain != ""
    ? "https://${cloudflare_worker.api.name}.${var.workers_dev_subdomain}.workers.dev"
    : null
  )
}

output "worker_version_id" {
  description = "ID of the deployed Worker version."
  value       = cloudflare_worker_version.api.id
}

# -----------------------------------------------------------------------------
# Zero Trust Access
# -----------------------------------------------------------------------------

output "access_application_id" {
  description = "ID of the Access SaaS application, or null when enable_access = false."
  value       = one(cloudflare_zero_trust_access_application.api[*].id)
}

output "access_auth_domain" {
  description = "Zero Trust auth domain, e.g. acme.cloudflareaccess.com."
  value       = local.access_auth_domain
}

output "oidc_issuer" {
  description = "OIDC issuer/discovery base handed to the Worker."
  value       = local.oidc_issuer
}

output "oidc_client_id" {
  description = "OIDC client ID handed to the Worker."
  value       = local.oidc_client_id
}

output "oidc_client_secret" {
  description = "OIDC client secret handed to the Worker. Cloudflare returns this only on creation."
  value       = local.oidc_client_secret
  sensitive   = true
}

# -----------------------------------------------------------------------------
# TURN / R2 CDN
# -----------------------------------------------------------------------------

output "turn_key_id" {
  description = "Cloudflare Calls TURN key ID (CLOUDFLARE_TURN_ID), latched at creation. See turn.tf."
  value       = terraform_data.turn_key.output.uid
}

output "turn_key_token" {
  description = "Cloudflare Calls TURN bearer token (CLOUDFLARE_TURN_TOKEN), latched at creation."
  value       = terraform_data.turn_key.output.secret
  sensitive   = true
}

output "r2_cdn_url" {
  description = "Public URL prefix serving R2 release artifacts, or \"\" when no custom domain is configured."
  value       = local.r2_cdn_url
}

output "api_url" {
  description = "Public URL of the Worker custom domain, or \"\" when api_hostname is unset."
  value       = local.api_url
}

output "worker_custom_domain_id" {
  description = "ID of the Worker custom domain attachment."
  value       = one(cloudflare_workers_custom_domain.api[*].id)
}

# -----------------------------------------------------------------------------
# Static UI app
# -----------------------------------------------------------------------------

output "app_worker_name" {
  description = "Name of the static-assets Worker serving the UI."
  value       = cloudflare_worker.app.name
}

output "app_url" {
  description = "Public URL of the UI app, or \"\" when app_hostname is unset."
  value       = local.app_url
}

output "app_version_id" {
  description = "ID of the deployed UI Worker version."
  value       = cloudflare_worker_version.app.id
}
