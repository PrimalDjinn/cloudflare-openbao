storage "cloudflare-d1" {
  # Configuration is picked up from environment variables:
  # BAO_D1_DATABASE_ID, BAO_D1_TOKEN, etc.
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = 1
}

ui = true
disable_mlock = true

seal "static" {
  current_key_id = "cloudflare-2026-05-14-1"
  current_key = "env://BAO_STATIC_SEAL_KEY"
  # Used to rotate keys, create a new one
  # previous_key_id = "20250306-1"
  # previous_key = "file:///openbao/secrets/unseal-20250306-1.key" or "env://"
}