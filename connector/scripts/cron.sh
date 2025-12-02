#!/bin/bash
# MCP & Plugin Registry Sync Cron Job
# Fetches latest servers from Glama, GOAT (npm), and ElizaOS (GitHub)
# 
# Run manually: ./scripts/cron.sh
# Install cron: crontab -e
#   0 */6 * * * cd ~/connector && ./scripts/cron.sh >> /var/log/mcp-sync.log 2>&1

set -e

cd "$(dirname "$0")/.."

echo "=========================================="
echo "Registry Sync - $(date -Iseconds)"
echo "=========================================="

# Sync MCP servers from Glama
echo "[1/3] Syncing MCP servers from Glama..."
npx tsx scripts/sync.ts

# Sync GOAT and ElizaOS plugins
echo "[2/3] Syncing GOAT & ElizaOS plugins..."
npx tsx scripts/sync-plugins.ts

# Reload the registry
echo "[3/3] Reloading registry..."
curl -s -X POST http://localhost:4001/registry/reload

echo ""
echo "Sync complete at $(date -Iseconds)"
echo "=========================================="

