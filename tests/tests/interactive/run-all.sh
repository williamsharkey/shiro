#!/bin/sh
# run-all.sh - Run all interactive tests
#
# Run in Shiro terminal: source test/interactive/run-all.sh

echo "Running all interactive tests..."
echo ""

# Get the directory of this script
SCRIPT_DIR="$(dirname "$0")"

# Run each test
source "$SCRIPT_DIR/virtual-server.sh"

# Add more tests here as they're created:
# source "$SCRIPT_DIR/some-other-test.sh"

echo ""
echo "All interactive tests complete!"
