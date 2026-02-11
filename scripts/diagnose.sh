#!/bin/sh
# diagnose.sh - Diagnose common Shiro issues
#
# Run with: source demo/diagnose.sh

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║        Shiro Diagnostic Script                                ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

# Check 1: Detect origin
echo "=== Check 1: Detecting Origin ==="
js "window.location.origin"
echo ""

ORIGIN=$(js "window.location.origin" 2>/dev/null | tr -d '\n')

if [ "$ORIGIN" = "null" ] || [ "$ORIGIN" = "file://" ]; then
  echo "⚠️  WARNING: Running from file:// protocol"
  echo "   This will cause CORS issues with:"
  echo "   - git clone (GitHub API blocked)"
  echo "   - npm install (registry may fail)"
  echo ""
  echo "   WORKAROUND: Run Shiro via localhost instead:"
  echo "   cd shiro && npm run dev"
  echo "   Then open http://localhost:5173"
  echo ""
else
  echo "✓ Running from: $ORIGIN"
  echo "  CORS should work for most operations."
  echo ""
fi

# Check 2: Test fetch to GitHub API
echo "=== Check 2: Testing GitHub API Access ==="
echo "Attempting to fetch GitHub API..."

# This will show if CORS is working
fetch https://api.github.com/repos/williamsharkey/shiro 2>&1 | head -5

echo ""

# Check 3: Test npm registry access
echo "=== Check 3: Testing npm Registry Access ==="
echo "Attempting to fetch from npm registry..."

fetch https://registry.npmjs.org/lodash 2>&1 | head -3

echo ""

# Check 4: List available git commands
echo "=== Check 4: Git Subcommands ==="
echo "Available: init, add, commit, status, log, diff, branch, checkout, clone"
echo "           push, pull, fetch, remote, merge"
echo ""
echo "NOT available: help, config, stash, rebase, tag, reset"
echo ""

# Check 5: List npm capabilities
echo "=== Check 5: npm Capabilities ==="
echo "Supported: npm install [packages...]"
echo "           npm list"
echo "           npm run <script>"
echo "           npm uninstall <package>"
echo ""
echo "NOT supported: --include=dev, --save-dev, -D flags"
echo "               (dev dependencies are installed by default)"
echo ""

# Check 6: Filesystem status
echo "=== Check 6: Filesystem Status ==="
echo "Home directory:"
ls -la ~
echo ""

# Summary
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║        Diagnostic Summary                                     ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

if [ "$ORIGIN" = "null" ] || [ "$ORIGIN" = "file://" ]; then
  echo "❌ CRITICAL: Running from file:// - many features will fail"
  echo ""
  echo "To fix: Run via localhost with 'npm run dev'"
  echo ""
else
  echo "✓ Origin looks good for network operations"
fi

echo ""
echo "Known limitations:"
echo "  1. git help, git config not implemented"
echo "  2. npm flags like --save-dev not parsed"
echo "  3. npm scripts may not work for complex projects"
echo "  4. No node_modules/.bin execution"
echo ""
echo "For issues: https://github.com/williamsharkey/shiro/issues"
echo ""
