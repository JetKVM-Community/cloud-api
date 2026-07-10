# =============================================================================
# Cloudflare Calls — TURN key for WebRTC ICE
#
# src/webrtc.ts calls
#   https://rtc.live.cloudflare.com/v1/turn/keys/${CLOUDFLARE_TURN_ID}/credentials/...
# with `Authorization: Bearer ${CLOUDFLARE_TURN_TOKEN}`, so the key's `uid` is
# the ID and its `key` is the bearer token.
# =============================================================================

resource "cloudflare_calls_turn_app" "webrtc" {
  account_id = local.account_id
  name       = var.turn_app_name
}
