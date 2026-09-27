#!/usr/bin/env bash
# Runs a command with AnyList credentials taken from the GNOME keyring (libsecret),
# so they never live in a file or in an MCP client's config.
#
# Store them once, in a terminal outside any agent session (you'll be prompted, input hidden):
#   secret-tool store --label="anylist-mcp username" service anylist-mcp field username
#   secret-tool store --label="anylist-mcp password" service anylist-mcp field password
#
# Usage:
#   scripts/with-anylist-creds.sh                          # start the stdio MCP server
#   scripts/with-anylist-creds.sh npm run test:integration
# ANYLIST_LIST_NAME defaults to "Test List"; set it in the environment to change it.
set -euo pipefail

cd "$(dirname "$0")/.."

lookup() {
  secret-tool lookup service anylist-mcp field "$1" || {
    echo "anylist-mcp: no '$1' in the keyring (see scripts/with-anylist-creds.sh)" >&2
    exit 1
  }
}

ANYLIST_USERNAME=$(lookup username)
ANYLIST_PASSWORD=$(lookup password)
export ANYLIST_USERNAME ANYLIST_PASSWORD
export ANYLIST_LIST_NAME="${ANYLIST_LIST_NAME:-Test List}"

if (( $# == 0 )); then
  set -- node src/server.js
fi
exec mise exec -- "$@"
