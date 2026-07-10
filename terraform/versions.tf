terraform {
  # >= 1.9 for variable validation that references other variables (oidc_* below).
  required_version = ">= 1.9"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3"
    }
    # Used to POST the Cloudflare Calls TURN key, which the cloudflare provider
    # cannot round-trip. See turn.tf.
    http = {
      source  = "hashicorp/http"
      version = "~> 3.4"
    }
  }
}
