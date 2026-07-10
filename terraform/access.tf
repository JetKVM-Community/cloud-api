# =============================================================================
# Zero Trust Access — Cloudflare Access as the OIDC provider
#
# A SaaS application with `auth_type = "oidc"` makes Access itself the identity
# provider for the Worker. Cloudflare mints the client credentials, so
# OIDC_CLIENT_ID / OIDC_CLIENT_SECRET come out of this resource rather than
# being supplied by hand.
#
# Set `enable_access = false` to authenticate against an external IdP instead,
# in which case the oidc_* variables must be supplied.
# =============================================================================

# The Zero Trust org's auth domain (e.g. "acme.cloudflareaccess.com") forms the
# base of every OIDC endpoint Access serves.
data "cloudflare_zero_trust_organization" "main" {
  count      = var.enable_access ? 1 : 0
  account_id = local.account_id
}

resource "cloudflare_zero_trust_access_application" "api" {
  count      = var.enable_access ? 1 : 0
  account_id = local.account_id

  name                 = var.access_app_name
  type                 = "saas"
  session_duration     = var.access_session_duration
  app_launcher_visible = true

  saas_app = {
    auth_type        = "oidc"
    grant_types      = ["authorization_code"]
    scopes           = ["openid", "email", "profile"]
    redirect_uris    = ["${local.api_url}/oidc/callback"]
    app_launcher_url = local.app_url != "" ? local.app_url : null
  }

  policies = [{
    name       = "${var.access_app_name} — allowed users"
    decision   = "allow"
    precedence = 1
    include    = local.access_include
  }]

  lifecycle {
    precondition {
      condition     = var.api_hostname != ""
      error_message = "api_hostname must be set when enable_access = true; it forms the OIDC redirect URI."
    }
  }
}

# Cloudflare returns saas_app.client_secret only in the response to the POST that
# creates the application; every later read omits it. Latch the value here on
# first apply and ignore subsequent changes, so the Worker's OIDC_CLIENT_SECRET
# binding keeps a stable value instead of churning as the field empties.
#
# replace_triggered_by tracks the application's `id`, NOT the whole resource. A
# whole-resource reference also fires on in-place updates — editing a redirect
# URI, say — and that would recreate this latch and re-read a client_secret the
# update response does not contain, silently blanking OIDC_CLIENT_SECRET. The id
# changes only when the application is genuinely recreated, which is exactly when
# a new secret is minted and must be re-captured.
#
# sensitive() keeps the captured secret out of plan output.
resource "terraform_data" "oidc_client_secret" {
  count = var.enable_access ? 1 : 0

  input = sensitive(cloudflare_zero_trust_access_application.api[count.index].saas_app.client_secret)

  lifecycle {
    ignore_changes       = [input]
    replace_triggered_by = [cloudflare_zero_trust_access_application.api[count.index].id]
  }
}
