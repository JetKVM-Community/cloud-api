# =============================================================================
# Variables — only cloudflare_api_token is required
# =============================================================================

variable "cloudflare_api_token" {
  description = "Cloudflare API token with Workers, D1, R2, and Account permissions."
  type        = string
  sensitive   = true
}

variable "worker_name" {
  description = "Name of the Cloudflare Worker."
  type        = string
  default     = "jetkvm-cloud-api"
}

variable "d1_database_name" {
  description = "Name of the D1 database."
  type        = string
  default     = "jetkvm-cloud-api"
}

variable "r2_bucket_name" {
  description = "Name of the R2 bucket for firmware releases."
  type        = string
  default     = "jetkvm-releases"
}

variable "r2_bucket_location" {
  description = "Location hint for the R2 bucket (apac, eeur, enam, weur, wnam, oc)."
  type        = string
  default     = "wnam"
}

variable "worker_dist_dir" {
  description = "Path to the compiled Worker output directory (relative to terraform/)."
  type        = string
  default     = "../dist"
}

variable "worker_version_message" {
  description = "Human-readable annotation for the deployed Worker version."
  type        = string
  default     = "Deployed via Terraform"
}
