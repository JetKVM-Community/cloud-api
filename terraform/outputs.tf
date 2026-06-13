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
  description = "Workers.dev URL for the deployed Worker."
  value       = "https://${cloudflare_worker.api.name}.${local.account_id}.workers.dev"
}

output "worker_version_id" {
  description = "ID of the deployed Worker version."
  value       = cloudflare_worker_version.api.id
}
