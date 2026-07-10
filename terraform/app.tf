# =============================================================================
# JetKVM UI — static-assets Worker serving the browser app
#
# The bundle is built from https://github.com/jetkvm/kvm (dev branch, ui/):
#
#   git clone --depth 1 -b dev https://github.com/jetkvm/kvm
#   cd kvm/ui && npm ci
#   echo "VITE_CLOUD_API=https://${api_hostname}" > .env.cloud-production.local
#   npm run build:prod
#   cp -r dist <repo>/dist-ui
#
# The VITE_CLOUD_API override matters: .env.cloud-production ships pointing at
# https://api.jetkvm.com, and Vite bakes that value into the bundle at build
# time. Without the override the app would talk to upstream's API, not ours.
#
# This Worker has no script — only static assets. Cloudflare serves the files
# directly, and unmatched paths fall back to index.html so the SPA router can
# handle them.
# =============================================================================

resource "cloudflare_worker" "app" {
  account_id = local.account_id
  name       = var.app_worker_name

  subdomain = {
    enabled          = true
    previews_enabled = false
  }
}

resource "cloudflare_worker_version" "app" {
  account_id = local.account_id
  worker_id  = cloudflare_worker.app.id

  compatibility_date = "2025-04-01"

  assets = {
    directory = local.app_dist_dir

    config = {
      # SPA: serve index.html for any path that isn't a real file, so deep
      # links like /devices/<id>/settings resolve client-side.
      not_found_handling = "single-page-application"
      html_handling      = "auto-trailing-slash"
    }
  }

  annotations = {
    workers_message = var.app_version_message
  }

  lifecycle {
    precondition {
      condition     = local.app_bundle_built
      error_message = "No UI bundle in ${var.app_dist_dir} (expected index.html). Build it from jetkvm/kvm ui/ as described in app.tf."
    }
  }
}

resource "cloudflare_workers_deployment" "app" {
  account_id  = local.account_id
  script_name = cloudflare_worker.app.name
  strategy    = "percentage"

  versions = [{
    percentage = 100
    version_id = cloudflare_worker_version.app.id
  }]

  annotations = {
    workers_message = var.app_version_message
  }
}

# -----------------------------------------------------------------------------
# The app owns the zone-root hostname; the API lives on api.* (see dns.tf).
# depends_on orders this after the API's custom domain has been moved off this
# hostname — Cloudflare rejects two Workers claiming the same domain.
# -----------------------------------------------------------------------------
resource "cloudflare_workers_custom_domain" "app" {
  count = var.app_hostname != "" ? 1 : 0

  account_id = local.account_id
  hostname   = var.app_hostname
  service    = cloudflare_worker.app.name
  zone_id    = var.cloudflare_zone_id

  lifecycle {
    precondition {
      condition     = var.cloudflare_zone_id != ""
      error_message = "cloudflare_zone_id must be set when app_hostname is set."
    }
    precondition {
      condition     = var.app_hostname != var.api_hostname
      error_message = "app_hostname and api_hostname must differ; a hostname can only route to one Worker."
    }
  }

  depends_on = [
    cloudflare_workers_deployment.app,
    cloudflare_workers_custom_domain.api,
  ]
}
