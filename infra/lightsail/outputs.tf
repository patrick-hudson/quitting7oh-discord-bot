output "instance_name" {
  value     = aws_lightsail_instance.bot.name
  sensitive = true
}

output "static_ip" {
  value     = aws_lightsail_static_ip.bot.ip_address
  sensitive = true
}

output "app_directory" {
  value = local.app_directory
}

output "bundle_id" {
  value = var.bundle_id
}
