# Deployment identifiers belong in ignored terraform.tfvars or private TF_VAR_*.
variable "aws_region" {
  description = "AWS region for the deployment; supplied privately."
  type        = string

  validation {
    condition     = length(trimspace(var.aws_region)) > 0
    error_message = "Supply the AWS region."
  }
}

variable "availability_zone" {
  description = "Availability zone in the configured region; supplied privately."
  type        = string

  validation {
    condition     = length(trimspace(var.availability_zone)) > 0
    error_message = "Supply the availability zone."
  }
}

variable "allowed_account_ids" {
  description = "Explicit account allowlist to prevent provisioning under the wrong AWS session."
  type        = list(string)
  sensitive   = true

  validation {
    condition     = length(var.allowed_account_ids) > 0 && alltrue([for id in var.allowed_account_ids : can(regex("^[0-9]{12}$", id))])
    error_message = "Supply at least one valid AWS account ID privately."
  }
}

variable "instance_name" {
  description = "New host name; supplied privately. Never reuse an existing host's name."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9_-]*$", var.instance_name))
    error_message = "Supply an instance name containing letters, numbers, underscores or hyphens."
  }
}

variable "key_pair_name" {
  description = "Existing Lightsail key-pair name in the configured region."
  type        = string
  sensitive   = true

  validation {
    condition     = length(trimspace(var.key_pair_name)) > 0
    error_message = "Supply an existing regional Lightsail key-pair name."
  }
}

variable "bundle_id" {
  description = "2 GiB by default; medium_3_0 provides 4 GiB for heavier workloads."
  type        = string
  default     = "small_3_0"

  validation {
    condition     = contains(["small_3_0", "medium_3_0"], var.bundle_id)
    error_message = "Choose small_3_0 (2 GiB) or medium_3_0 (4 GiB)."
  }
}

variable "ssh_allowed_cidrs" {
  description = "Private operator input: IPv4 CIDRs allowed to SSH, with /24 or narrower prefixes."
  type        = list(string)
  sensitive   = true

  validation {
    condition = length(var.ssh_allowed_cidrs) > 0 && alltrue([
      for cidr in var.ssh_allowed_cidrs :
      can(cidrnetmask(cidr)) && try(tonumber(split("/", cidr)[1]) >= 24, false)
    ])
    error_message = "Supply IPv4 CIDRs with /24 or narrower prefixes; SSH must not be open to the internet."
  }
}

variable "ssh_public_key_path" {
  description = "Path to the operator's .pub file. The private key stays on the workstation."
  type        = string

  validation {
    condition     = endswith(var.ssh_public_key_path, ".pub")
    error_message = "Use a .pub file, never a private key."
  }
}

variable "app_domain" {
  description = "Application DNS hostname for HTTPS; supplied privately."
  type        = string

  validation {
    condition     = length(var.app_domain) <= 253 && can(regex("^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$", var.app_domain))
    error_message = "Supply a DNS hostname without ports, paths, whitespace or shell syntax."
  }
}

variable "app_image" {
  description = "Immutable application image reference from the running release."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._/:-]*@sha256:[0-9a-f]{64}$", var.app_image))
    error_message = "Pin the application image to a full SHA-256 digest."
  }
}

variable "postgres_image" {
  description = "Immutable PostgreSQL image reference matching the source major version."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._/:-]*@sha256:[0-9a-f]{64}$", var.postgres_image))
    error_message = "Pin the PostgreSQL image to a full SHA-256 digest."
  }
}

variable "caddy_image" {
  description = "Immutable Caddy image reference from the running release."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._/:-]*@sha256:[0-9a-f]{64}$", var.caddy_image))
    error_message = "Pin the Caddy image to a full SHA-256 digest."
  }
}

variable "snapshot_time" {
  description = "Daily snapshot time in UTC, on the hour."
  type        = string
  default     = "08:00"

  validation {
    condition     = can(regex("^([01][0-9]|2[0-3]):00$", var.snapshot_time))
    error_message = "Use HH:00 UTC with an hour from 00 through 23."
  }
}
