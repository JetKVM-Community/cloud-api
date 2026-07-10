# =============================================================================
# JetKVM Cloud API — Minimal Cloudflare Infrastructure
#
# Only a Cloudflare API token is required. The account ID is auto-discovered.
#
# Resources provisioned:
#   • D1 Database             — serverless SQLite
#   • R2 Bucket               — firmware release storage
#   • R2 Custom Domain        — public CDN hostname for releases (dns.tf)
#   • Access Application      — Access as the OIDC provider (access.tf)
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

  # Anchored to the module, not the process working directory, so the path
  # resolves the same whether Terraform runs from here or via -chdir.
  dist_dir   = "${path.module}/${var.worker_dist_dir}"
  wasm_files = fileset(local.dist_dir, "*.wasm")

  # `npx wrangler deploy --dry-run --outdir dist` emits index.js plus the Prisma
  # query-engine .wasm. Built as a comprehension so an unbuilt dist_dir yields an
  # empty list rather than a null that blows up inside a string template; the
  # worker_version preconditions below turn that into an actionable error.
  worker_modules = concat(
    [{
      name         = "index.js"
      content_file = "${local.dist_dir}/index.js"
      content_type = "application/javascript+module"
    }],
    [for wasm in local.wasm_files : {
      name         = wasm
      content_file = "${local.dist_dir}/${wasm}"
      content_type = "application/wasm"
    }],
  )

  worker_bundle_built = fileexists("${local.dist_dir}/index.js") && length(local.wasm_files) > 0

  # Static UI bundle (see app.tf), anchored to the module like dist_dir above.
  app_dist_dir     = "${path.module}/${var.app_dist_dir}"
  app_bundle_built = fileexists("${local.app_dist_dir}/index.html")

  # The Worker builds URLs from these, so they need a scheme; the variables hold
  # bare hostnames.
  api_url    = var.api_hostname != "" ? "https://${var.api_hostname}" : ""
  app_url    = var.app_hostname != "" ? "https://${var.app_hostname}" : ""
  r2_cdn_url = var.r2_cdn_hostname != "" ? "https://${var.r2_cdn_hostname}" : ""

  # Named identities if any were given, otherwise anyone who authenticates.
  # The Worker additionally enforces ALLOWED_IDENTITIES on every request.
  access_include = length(var.access_allowed_emails) > 0 || length(var.access_allowed_email_domains) > 0 ? concat(
    [for email in var.access_allowed_emails : { email = { email = email } }],
    [for domain in var.access_allowed_email_domains : { email_domain = { domain = domain } }],
  ) : [{ everyone = {} }]

  # OIDC credentials come from the Access SaaS app, or from an external IdP.
  # The secret is read off terraform_data rather than the application, because
  # Cloudflare only ever returns it once — see access.tf.
  oidc_client_id     = var.enable_access ? one(cloudflare_zero_trust_access_application.api[*].saas_app.client_id) : var.oidc_client_id
  oidc_client_secret = var.enable_access ? one(terraform_data.oidc_client_secret[*].output) : var.oidc_client_secret

  # Access serves OIDC discovery under a per-client path, and src/auth.ts appends
  # "/.well-known/openid-configuration" to OIDC_ISSUER. The real `iss` claim is
  # read back out of that discovery document, so this need not equal the issuer.
  access_auth_domain = one(data.cloudflare_zero_trust_organization.main[*].auth_domain)
  oidc_issuer = (
    var.enable_access
    ? "https://${local.access_auth_domain}/cdn-cgi/access/sso/oidc/${local.oidc_client_id}"
    : var.oidc_issuer
  )

  # Empty values are omitted so the Worker's optional bindings stay undefined
  # rather than becoming "".
  worker_vars = merge(
    {
      OIDC_ISSUER        = local.oidc_issuer
      OIDC_CLIENT_ID     = local.oidc_client_id
      CLOUDFLARE_TURN_ID = terraform_data.turn_key.output.uid
    },
    local.api_url != "" ? { API_HOSTNAME = local.api_url } : {},
    local.app_url != "" ? { APP_HOSTNAME = local.app_url } : {},
    local.r2_cdn_url != "" ? { R2_CDN_URL = local.r2_cdn_url } : {},
    var.cors_origins != "" ? { CORS_ORIGINS = var.cors_origins } : {},
    var.allowed_identities != "" ? { ALLOWED_IDENTITIES = var.allowed_identities } : {},
  )

  # Both secrets read from terraform_data latches: Cloudflare returns each value
  # only in the response that creates it. See access.tf and turn.tf.
  worker_secrets = {
    COOKIE_SECRET         = random_password.cookie_secret.result
    OIDC_CLIENT_SECRET    = local.oidc_client_secret
    CLOUDFLARE_TURN_TOKEN = terraform_data.turn_key.output.secret
  }

  worker_env_bindings = concat(
    [for name, text in local.worker_vars : { name = name, type = "plain_text", text = text }],
    [for name, text in local.worker_secrets : { name = name, type = "secret_text", text = text }],
  )
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
# Durable Object bootstrap — retired, kept out of state
#
# A bootstrap worker_version carried the `DeviceSignaling` migration (tag "v1")
# so that a later version could bind the DO class. That migration has been
# applied, and the resources cannot stay under management:
#
#   • Their modules track the compiled bundle, so every code change replaced the
#     bootstrap version AND redeployed it at 100% traffic — briefly serving a
#     version with no OIDC, TURN or DO bindings.
#   • `ignore_changes` does not help: the provider recomputes each module's
#     content_sha256 from the file during plan, and that computed value is what
#     forces the replacement.
#   • Re-uploading would resend migrations {new_tag = "v1", old_tag = ""} against
#     a Worker already tagged v1, which Cloudflare rejects.
#
# `removed` drops them from state without deleting anything in Cloudflare. The
# migration is a one-time, account-level fact; the live Worker keeps it.
#
# Standing up a brand-new environment needs the migration applied once. Restore
# these resources from git history (they precede this commit), apply, then
# re-add these `removed` blocks.
# See: https://developers.cloudflare.com/workers/platform/infrastructure-as-code/#considerations-with-durable-objects
# -----------------------------------------------------------------------------
removed {
  from = cloudflare_worker_version.bootstrap

  lifecycle {
    destroy = false
  }
}

removed {
  from = cloudflare_workers_deployment.bootstrap

  lifecycle {
    destroy = false
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
  modules     = local.worker_modules

  compatibility_date  = "2025-04-01"
  compatibility_flags = ["nodejs_compat"]

  annotations = {
    workers_message = var.worker_version_message
  }

  # ── Resource bindings ──────────────────────────────────────────────────────

  bindings = concat(
    [
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
    ],
    # OIDC, TURN, hostnames and the cookie secret — see locals in this file.
    local.worker_env_bindings,
  )

  lifecycle {
    precondition {
      condition     = local.worker_bundle_built
      error_message = "No Worker bundle in ${var.worker_dist_dir}. Build it first: npx wrangler deploy --dry-run --outdir dist"
    }
  }
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
