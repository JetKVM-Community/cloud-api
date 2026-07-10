# =============================================================================
# DNS — custom domains for the Worker and the R2 release bucket
#
# Both resources provision their own proxied DNS record and edge certificate,
# so no hand-written cloudflare_dns_record is needed for either hostname.
# =============================================================================

# -----------------------------------------------------------------------------
# Worker custom domain — serves the API at https://${var.api_hostname}
#
# This is the hostname the Worker already believes it lives at: API_HOSTNAME is
# bound to https://${var.api_hostname}, and the Access application's OIDC
# redirect URI is ${api_hostname}/oidc/callback. Without this resource that
# hostname resolves nowhere and the OIDC callback dead-ends.
# -----------------------------------------------------------------------------
resource "cloudflare_workers_custom_domain" "api" {
  count = var.api_hostname != "" ? 1 : 0

  account_id = local.account_id
  hostname   = var.api_hostname
  service    = cloudflare_worker.api.name
  zone_id    = var.cloudflare_zone_id

  lifecycle {
    precondition {
      condition     = var.cloudflare_zone_id != ""
      error_message = "cloudflare_zone_id must be set when api_hostname is set; the Worker custom domain is created inside that zone."
    }
  }

  # Attach only once a version is actually serving, so the hostname never
  # resolves to a Worker with no deployment.
  depends_on = [cloudflare_workers_deployment.api]
}

# -----------------------------------------------------------------------------
# R2 CDN DNS — public custom domain for firmware releases
#
# `cloudflare_r2_custom_domain` attaches the bucket to a hostname in the zone
# and provisions the DNS record and edge certificate for it. A hand-written
# CNAME is not needed (and would not serve bucket objects on its own), so the
# Worker's R2_CDN_URL is derived from this hostname.
# -----------------------------------------------------------------------------

resource "cloudflare_r2_custom_domain" "releases" {
  count = var.r2_cdn_hostname != "" ? 1 : 0

  account_id  = local.account_id
  bucket_name = cloudflare_r2_bucket.releases.name
  domain      = var.r2_cdn_hostname
  zone_id     = var.cloudflare_zone_id
  enabled     = true
  min_tls     = "1.2"

  lifecycle {
    precondition {
      condition     = var.cloudflare_zone_id != ""
      error_message = "cloudflare_zone_id must be set when r2_cdn_hostname is set; the custom domain is created inside that zone."
    }
  }
}
