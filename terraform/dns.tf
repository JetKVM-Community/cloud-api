# =============================================================================
# R2 CDN DNS — public custom domain for firmware releases
#
# `cloudflare_r2_custom_domain` attaches the bucket to a hostname in the zone
# and provisions the DNS record and edge certificate for it. A hand-written
# CNAME is not needed (and would not serve bucket objects on its own), so the
# Worker's R2_CDN_URL is derived from this hostname.
# =============================================================================

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
