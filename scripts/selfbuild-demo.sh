#!/bin/sh
# selfbuild-demo.sh - Demonstrates Shiro's self-build and hot-reload capabilities
#
# This script shows how Shiro can:
# 1. Clone its own repository
# 2. Edit source files
# 3. Hot-reload commands without page refresh
# 4. Preserve state across reloads
#
# Run with: source demo/selfbuild-demo.sh
# Or copy commands manually for the recording.

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║        Shiro Self-Build & Hot-Reload Demo                     ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

# Step 1: Start recording (if termcast available)
echo "📹 Starting terminal recording..."
termcast start /tmp/shiro-selfbuild-demo.cast

echo ""
echo "=== Step 1: Clone Shiro from GitHub ==="
echo ""

# Clone Shiro
rm -rf /tmp/shiro-clone
git clone https://github.com/williamsharkey/shiro /tmp/shiro-clone

echo ""
echo "=== Step 2: Explore the cloned repository ==="
echo ""

# Show structure
ls -la /tmp/shiro-clone
echo ""
cat /tmp/shiro-clone/package.json | head -10
echo ""
ls /tmp/shiro-clone/src/commands/

echo ""
echo "=== Step 3: Create a custom command ==="
echo ""

# Create a custom command
mkdir -p /tmp/shiro-clone/custom
cat > /tmp/shiro-clone/custom/hello-world.ts << 'CMDEOF'
// hello-world.ts - A hot-reloadable command with state

export const helloWorldCmd = {
  name: 'hello-world',
  description: 'Demo command with state preservation',
  _greetCount: 0,

  migrateFrom(old) {
    // Preserve state from previous version
    this._greetCount = old._greetCount || 0;
    console.log('[hello-world] Migrated count:', this._greetCount);
  },

  async exec(ctx) {
    this._greetCount++;
    ctx.stdout = `👋 Hello from Shiro! (greet #${this._greetCount})\n`;
    ctx.stdout += `   This command was hot-loaded from VFS.\n`;
    return 0;
  }
};

export default helloWorldCmd;
CMDEOF

echo "Created: /tmp/shiro-clone/custom/hello-world.ts"
cat /tmp/shiro-clone/custom/hello-world.ts

echo ""
echo "=== Step 4: Hot-load the new command ==="
echo ""

# Hot-load it
reload commands/hello-world /tmp/shiro-clone/custom/hello-world.ts

echo ""
echo "=== Step 5: Execute the hot-loaded command ==="
echo ""

# Execute it multiple times to build up state
hello-world
hello-world
hello-world

echo ""
echo "=== Step 6: Modify and hot-reload with state preservation ==="
echo ""

# Update the command to v2
cat > /tmp/shiro-clone/custom/hello-world.ts << 'CMDEOF'
// hello-world.ts v2 - Updated with new behavior

export const helloWorldCmd = {
  name: 'hello-world',
  description: 'Demo command with state preservation (v2)',
  _greetCount: 0,

  migrateFrom(old) {
    this._greetCount = old._greetCount || 0;
    console.log('[hello-world] Migrated count:', this._greetCount);
  },

  async exec(ctx) {
    this._greetCount++;
    ctx.stdout = `🌟 Hello from Shiro v2! (greet #${this._greetCount})\n`;
    ctx.stdout += `   State was preserved through hot-reload!\n`;
    ctx.stdout += `   Total greets: ${this._greetCount}\n`;
    return 0;
  }
};

export default helloWorldCmd;
CMDEOF

echo "Modified hello-world.ts to v2"

# Hot-reload (state should be preserved!)
reload commands/hello-world /tmp/shiro-clone/custom/hello-world.ts

echo ""
echo "=== Step 7: Verify state was preserved ==="
echo ""

# Run again - counter should continue from where it left off
hello-world

echo ""
echo "=== Step 8: Show module registry status ==="
echo ""

reload --status | grep -A3 hello-world

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║        Demo Complete!                                         ║"
echo "║                                                               ║"
echo "║  Shiro successfully:                                          ║"
echo "║  ✓ Cloned its own repository                                  ║"
echo "║  ✓ Created a custom command                                   ║"
echo "║  ✓ Hot-loaded without page refresh                            ║"
echo "║  ✓ Preserved state through reload                             ║"
echo "║                                                               ║"
echo "║  This is a truly self-modifying browser OS!                   ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

# Step 9: Stop recording
echo "📹 Stopping recording..."
termcast stop

echo ""
echo "Recording saved to: /tmp/shiro-selfbuild-demo.cast"
echo "Play it back with: termcast play /tmp/shiro-selfbuild-demo.cast"
