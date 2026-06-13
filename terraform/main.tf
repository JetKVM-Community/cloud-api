# =============================================================================
# JetKVM Cloud API — Minimal Cloudflare Infrastructure
#
# Only a Cloudflare API token is required. The account ID is auto-discovered.
#
# Resources provisioned:
#   • D1 Database             — serverless SQLite
#   • R2 Bucket               — firmware release storage
#   • Worker                  — container for the Worker script
#   • Worker Version          — compiled Worker with all modules and bindings
#   • Workers Deployment      — deploys the version to production
#
# Prerequisites:
#   1.  npm ci && npx prisma generate
#   2.  npx wrangler deploy --dry-run --outdir dist
#   3.  terraform init && terraform apply
# =============================================================================

# -----------------------------------------------------------------------------
# Auto-discover account ID from the API token
# -----------------------------------------------------------------------------
data "cloudflare_accounts" "main" {}

locals {
  account_id = data.cloudflare_accounts.main.result[0].id
  wasm_files = fileset(var.worker_dist_dir, "*.wasm")
  wasm_file  = one(local.wasm_files)
}

# -----------------------------------------------------------------------------
# Cookie secret — auto-generated so no manual input is needed
# -----------------------------------------------------------------------------
resource "random_password" "cookie_secret" {
  length  = 32
  special = false
}

# -----------------------------------------------------------------------------
# D1 Database
# -----------------------------------------------------------------------------
resource "cloudflare_d1_database" "api" {
  account_id = local.account_id
  name       = var.d1_database_name

  lifecycle {
    ignore_changes = [read_replication]
  }
}

# -----------------------------------------------------------------------------
# R2 Bucket — firmware release storage
# -----------------------------------------------------------------------------
resource "cloudflare_r2_bucket" "releases" {
  account_id = local.account_id
  name       = var.r2_bucket_name
  location   = var.r2_bucket_location
}

# -----------------------------------------------------------------------------
# Worker — container for the Worker script
# -----------------------------------------------------------------------------
resource "cloudflare_worker" "api" {
  account_id = local.account_id
  name       = var.worker_name

  subdomain = {
    enabled          = true
    previews_enabled = true
  }
}

# -----------------------------------------------------------------------------
# Worker Version (bootstrap) — applies DO migration without DO binding
#
# Cloudflare requires migrations to be deployed before bindings can reference
# the DO class. This bootstrap version carries the migration only.
# See: https://developers.cloudflare.com/workers/platform/infrastructure-as-code/#considerations-with-durable-objects
# -----------------------------------------------------------------------------
resource "cloudflare_worker_version" "bootstrap" {
  account_id = local.account_id
  worker_id  = cloudflare_worker.api.id

  main_module = "index.js"

  modules = [
    {
      name         = "index.js"
      content_file = "${var.worker_dist_dir}/index.js"
      content_type = "application/javascript+module"
    },
    {
      name         = local.wasm_file
      content_file = "${var.worker_dist_dir}/${local.wasm_file}"
      content_type = "application/wasm"
    },
  ]

  compatibility_date  = "2025-04-01"
  compatibility_flags = ["nodejs_compat"]

  annotations = {
    workers_message = "Bootstrap: apply DO migration"
  }

  bindings = [
    {
      name = "DB"
      type = "d1"
      id   = cloudflare_d1_database.api.id
    },
    {
      name        = "R2_BUCKET"
      type        = "r2_bucket"
      bucket_name = cloudflare_r2_bucket.releases.name
    },
    {
      name = "COOKIE_SECRET"
      type = "secret_text"
      text = random_password.cookie_secret.result
    },
  ]

  migrations = {
    new_sqlite_classes = ["DeviceSignaling"]
    new_tag            = "v1"
  }
}

# Deploy the bootstrap version to apply the migration
resource "cloudflare_workers_deployment" "bootstrap" {
  account_id  = local.account_id
  script_name = cloudflare_worker.api.name
  strategy    = "percentage"

  versions = [{
    percentage = 100
    version_id = cloudflare_worker_version.bootstrap.id
  }]

  annotations = {
    workers_message = "Bootstrap: apply DO migration"
  }
}

# -----------------------------------------------------------------------------
# Worker Version — full version with all bindings (including DO)
#
# Build first:  npx wrangler deploy --dry-run --outdir dist
# -----------------------------------------------------------------------------
resource "cloudflare_worker_version" "api" {
  account_id = local.account_id
  worker_id  = cloudflare_worker.api.id

  main_module = "index.js"

  modules = [
    {
      name         = "index.js"
      content_file = "${var.worker_dist_dir}/index.js"
      content_type = "application/javascript+module"
    },
    {
      name         = local.wasm_file
      content_file = "${var.worker_dist_dir}/${local.wasm_file}"
      content_type = "application/wasm"
    },
  ]

  compatibility_date  = "2025-04-01"
  compatibility_flags = ["nodejs_compat"]

  annotations = {
    workers_message = var.worker_version_message
  }

  # ── Resource bindings ──────────────────────────────────────────────────────

  bindings = [
    # D1 Database
    {
      name = "DB"
      type = "d1"
      id   = cloudflare_d1_database.api.id
    },
    # R2 Bucket
    {
      name        = "R2_BUCKET"
      type        = "r2_bucket"
      bucket_name = cloudflare_r2_bucket.releases.name
    },
    # Durable Object — DeviceSignaling (defined in the same script)
    {
      name       = "DEVICE_SIGNALING"
      type       = "durable_object_namespace"
      class_name = "DeviceSignaling"
    },
    # Session cookie signing key (auto-generated)
    {
      name = "COOKIE_SECRET"
      type = "secret_text"
      text = random_password.cookie_secret.result
    },
  ]

  depends_on = [cloudflare_workers_deployment.bootstrap]
}

# -----------------------------------------------------------------------------
# Workers Deployment — deploys the full version to production (100 % traffic)
# -----------------------------------------------------------------------------
resource "cloudflare_workers_deployment" "api" {
  account_id  = local.account_id
  script_name = cloudflare_worker.api.name
  strategy    = "percentage"

  versions = [{
    percentage = 100
    version_id = cloudflare_worker_version.api.id
  }]

  annotations = {
    workers_message = var.worker_version_message
  }
}
