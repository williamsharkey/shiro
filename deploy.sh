#!/bin/bash
# Deploy Shiro to DigitalOcean droplet
set -e

HOST="root@161.35.13.177"
REMOTE_DIR="/opt/shiro"

echo "Building..."
npm run build

echo "Uploading static files..."
scp -r dist/* "$HOST:$REMOTE_DIR/public/"

echo "Uploading server..."
scp server.mjs "$HOST:$REMOTE_DIR/server.mjs"

echo "Restarting server..."
ssh "$HOST" "systemctl restart shiro"

echo "Done! https://shiro.computer"
