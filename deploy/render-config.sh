#!/bin/sh
# Renders the runtime web config consumed by src/config.ts. A deployment that
# bind-mounts its own config.json takes precedence and skips rendering.
set -eu

config="/usr/share/nginx/html/config.json"

if [ -s "$config" ]; then
  echo "render-config: $config already provided, leaving it in place" >&2
  exit 0
fi

# Validate before opening the output file so a failed start never leaves a
# partial config.json behind for the next restart to mistake for a mount.
: "${PUBLIC_CONVEX_URL:?PUBLIC_CONVEX_URL is required}"
: "${PUBLIC_CONVEX_SITE_URL:?PUBLIC_CONVEX_SITE_URL is required}"
: "${GOOGLE_CLIENT_ID:?GOOGLE_CLIENT_ID is required}"

cat > "$config.tmp" <<EOF
{
  "CONVEX_URL": "$PUBLIC_CONVEX_URL",
  "CONVEX_SITE_URL": "$PUBLIC_CONVEX_SITE_URL",
  "GOOGLE_CLIENT_ID": "$GOOGLE_CLIENT_ID"
}
EOF
mv "$config.tmp" "$config"
