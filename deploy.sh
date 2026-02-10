#!/bin/bash
# Deploy Shiro to DigitalOcean droplet
set -e

HOST="root@161.35.13.177"
REMOTE_DIR="/opt/shiro"
SSH_KEY="$HOME/.ssh/id_ed25519"
SSH_OPTS="-i $SSH_KEY"

# Auto-increment build number
BUILD_FILE="build-number.txt"
BUILD_NUM=$(($(cat "$BUILD_FILE") + 1))
echo "$BUILD_NUM" > "$BUILD_FILE"
echo "Build #$BUILD_NUM"

echo "Building..."
npm run build

echo "Uploading static files..."
scp $SSH_OPTS -r dist/* "$HOST:$REMOTE_DIR/public/"

echo "Uploading server..."
scp $SSH_OPTS server.mjs "$HOST:$REMOTE_DIR/server.mjs"

echo "Restarting server..."
ssh $SSH_OPTS "$HOST" "systemctl restart shiro"

echo "Done! https://shiro.computer"
