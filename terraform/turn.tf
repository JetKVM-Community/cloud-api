# =============================================================================
# Cloudflare Calls — TURN key for WebRTC ICE
#
# src/webrtc.ts calls
#   https://rtc.live.cloudflare.com/v1/turn/keys/${CLOUDFLARE_TURN_ID}/credentials/...
# with `Authorization: Bearer ${CLOUDFLARE_TURN_TOKEN}`, so the key's uid is the
# ID and its secret is the bearer token.
#
# Why this is not `cloudflare_calls_turn_app` (provider 5.21.1):
#   • The create API returns the bearer token in a field named `secret`, but the
#     resource schema declares it as `key`, so the token lands in state as null.
#   • The token is returned only on create; GET omits it, and the resource does
#     not support import. Once lost, it is unrecoverable.
#   • `key_id` is never populated from the created key's uid, yet the read and
#     delete paths require it, so a managed key fails every later plan with
#     "missing required key_id parameter" and cannot even be destroyed.
#
# So the key is minted with a raw POST and latched into terraform_data.
#
# ─── IMPORTANT: create_turn_key is a one-shot switch ─────────────────────────
# A `data` source is re-read on EVERY plan and apply, and this POST is not
# idempotent — each read mints another TURN key. The hashicorp/http docs say as
# much: "POST support is only intended for read-only URLs." The count guard is
# what keeps that from happening.
#
#   1. set create_turn_key = true, then `terraform apply`  (mints the key)
#   2. set create_turn_key = false                          (stops re-minting)
#
# terraform_data.turn_key latches the credential on that first apply and
# `ignore_changes` pins it, so flipping the flag back to false — which makes the
# data source's value vanish — cannot disturb the stored value.
#
# Flip it to true again only to rotate the key; the old one is not deleted for
# you, and `terraform destroy` will not delete the key either. Prune stale keys:
#   GET/DELETE https://api.cloudflare.com/client/v4/accounts/<id>/calls/turn_keys
# =============================================================================

data "http" "turn_key" {
  count = var.create_turn_key ? 1 : 0

  url    = "https://api.cloudflare.com/client/v4/accounts/${local.account_id}/calls/turn_keys"
  method = "POST"

  request_headers = {
    Authorization  = "Bearer ${var.cloudflare_api_token}"
    "Content-Type" = "application/json"
  }

  request_body = jsonencode({ name = var.turn_app_name })

  lifecycle {
    postcondition {
      condition     = contains([200, 201], self.status_code)
      error_message = "Creating the TURN key failed with HTTP ${self.status_code}. The API token needs Calls Write."
    }
  }
}

locals {
  # null on every run where create_turn_key = false.
  turn_created = one([for r in data.http.turn_key[*].response_body : jsondecode(r).result])
}

# Latches the credential. `secret` is marked sensitive so it never reaches the
# console; `uid` deliberately is not, so it can be surfaced as an output.
resource "terraform_data" "turn_key" {
  input = {
    uid    = try(local.turn_created.uid, null)
    secret = try(sensitive(local.turn_created.secret), null)
  }

  # On the very first apply create_turn_key must be true, otherwise this latches
  # nulls and the Worker gets no TURN credential. ignore_changes then pins the
  # captured value for every later run.
  lifecycle {
    ignore_changes = [input]
  }
}
