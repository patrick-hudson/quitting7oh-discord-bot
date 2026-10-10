locals {
  app_directory = "/home/ubuntu/quitting7oh-bot"
  public_key    = trimspace(file(pathexpand(var.ssh_public_key_path)))

  # Supply immutable digests from the running release in private inputs.
  compose = templatefile("${path.module}/templates/compose.yml.tftpl", {
    app_image      = var.app_image
    postgres_image = var.postgres_image
    caddy_image    = var.caddy_image
  })

  bootstrap = templatefile("${path.module}/templates/bootstrap.sh.tftpl", {
    app_directory     = local.app_directory
    public_key_base64 = base64encode(local.public_key)
    compose_base64    = base64encode(local.compose)
    caddyfile_base64  = base64encode("${var.app_domain} {\n    reverse_proxy web:3000\n}\n")
  })
}

resource "aws_lightsail_instance" "bot" {
  name              = var.instance_name
  availability_zone = var.availability_zone
  blueprint_id      = "ubuntu_24_04"
  bundle_id         = var.bundle_id
  ip_address_type   = "ipv4"
  # Reuse an existing regional key pair that matches the supplied .pub file.
  key_pair_name = var.key_pair_name

  # Lightsail expects a single-line launch command. The decoded script contains
  # only public configuration; neither .env nor the private SSH key enters state.
  user_data = "printf '%s' '${base64encode(local.bootstrap)}' | base64 --decode | bash"

  add_on {
    type          = "AutoSnapshot"
    status        = "Enabled"
    snapshot_time = var.snapshot_time
  }

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = startswith(var.availability_zone, "${var.aws_region}")
      error_message = "The availability zone must belong to the configured region."
    }

    precondition {
      condition     = can(regex("^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+) [A-Za-z0-9+/=]+( |$)", local.public_key))
      error_message = "The public key file must contain an OpenSSH public key."
    }
  }
}

resource "aws_lightsail_static_ip" "bot" {
  name = "${var.instance_name}-ip"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_lightsail_static_ip_attachment" "bot" {
  static_ip_name = aws_lightsail_static_ip.bot.name
  instance_name  = aws_lightsail_instance.bot.name
}

resource "aws_lightsail_instance_public_ports" "bot" {
  instance_name = aws_lightsail_instance.bot.name

  port_info {
    protocol  = "tcp"
    from_port = 22
    to_port   = 22
    cidrs     = var.ssh_allowed_cidrs
  }

  port_info {
    protocol  = "tcp"
    from_port = 80
    to_port   = 80
    cidrs     = ["0.0.0.0/0"]
  }

  port_info {
    protocol  = "tcp"
    from_port = 443
    to_port   = 443
    cidrs     = ["0.0.0.0/0"]
  }
}
