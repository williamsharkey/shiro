#!/usr/bin/env node
/**
 * Level 12: Hot-Reload Tests (Node.js / Direct Import)
 *
 * Tests the hot-reload system by importing Shiro's modules directly into Node.js.
 * No browser needed - runs with tsx (TypeScript execute).
 *
 * Run with: npx tsx tests/level-12-hotreload/hotreload-node.test.js
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHIRO_PATH = join(__dirname, '..', '..', '..', 'shiro', 'src');

console.log('Level 12: Hot-Reload Tests (Node.js Direct)\n');
console.log(`Shiro path: ${SHIRO_PATH}\n`);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}

function assert(condition, msg) {
  if (!condition) {
    throw new Error(msg);
  }
}

// ============================================================================
// Test 1: Import ModuleRegistry
// ============================================================================
console.log('● Importing ModuleRegistry...');

let ModuleRegistry, registry;
try {
  const mod = await import(join(SHIRO_PATH, 'registry.ts'));
  ModuleRegistry = mod.ModuleRegistry;
  registry = new ModuleRegistry();
  console.log('  ✓ ModuleRegistry imported successfully\n');
  passed++;
} catch (e) {
  console.log(`  ✗ Failed to import ModuleRegistry: ${e.message}\n`);
  failed++;
  process.exit(1);
}

// ============================================================================
// Test 2: Basic registration
// ============================================================================
console.log('● Basic Registration');

test('register() adds module to registry', () => {
  const testModule = { name: 'test', value: 42 };
  registry.register('test/module1', testModule);
  assert(registry.has('test/module1'), 'module should be registered');
});

test('get() retrieves registered module', () => {
  const retrieved = registry.get('test/module1');
  assertEqual(retrieved.value, 42, 'value mismatch');
});

test('require() throws for missing module', () => {
  let threw = false;
  try {
    registry.require('nonexistent/module');
  } catch {
    threw = true;
  }
  assert(threw, 'should throw for missing module');
});

test('list() returns all module names', () => {
  const list = registry.list();
  assert(list.includes('test/module1'), 'should include registered module');
});

console.log('');

// ============================================================================
// Test 3: Module replacement
// ============================================================================
console.log('● Module Replacement');

test('replace() updates module in registry', () => {
  const newModule = { name: 'test', value: 100 };
  registry.replace('test/module1', newModule);
  const retrieved = registry.get('test/module1');
  assertEqual(retrieved.value, 100, 'value should be updated');
});

test('replace() increments version', () => {
  const meta = registry.getMetadata('test/module1');
  assertEqual(meta.version, 2, 'version should be 2 after replace');
});

test('replace() updates lastUpdatedAt', () => {
  const meta = registry.getMetadata('test/module1');
  assert(meta.lastUpdatedAt > 0, 'lastUpdatedAt should be set');
});

console.log('');

// ============================================================================
// Test 4: State migration protocol
// ============================================================================
console.log('● State Migration Protocol');

test('migrateFrom() is called during replace()', () => {
  let migrateCalled = false;
  let oldValue = null;

  const moduleV1 = { name: 'stateful', counter: 5 };
  registry.register('test/stateful', moduleV1);

  const moduleV2 = {
    name: 'stateful',
    counter: 0,
    migrateFrom(old) {
      migrateCalled = true;
      oldValue = old.counter;
      this.counter = old.counter;
    }
  };

  const result = registry.replace('test/stateful', moduleV2);

  assert(migrateCalled, 'migrateFrom should be called');
  assertEqual(oldValue, 5, 'should receive old module');
  assertEqual(result.migrated, true, 'result.migrated should be true');
});

test('state is preserved through migration', () => {
  const retrieved = registry.get('test/stateful');
  assertEqual(retrieved.counter, 5, 'counter should be preserved');
});

test('migration errors are caught and reported', () => {
  const badModule = {
    name: 'bad',
    migrateFrom() {
      throw new Error('Migration failed!');
    }
  };

  registry.register('test/bad', { name: 'bad' });
  const result = registry.replace('test/bad', badModule);

  assert(result.error, 'should have error');
  assert(result.error.message.includes('Migration failed'), 'error message should be preserved');
});

console.log('');

// ============================================================================
// Test 5: Listener system
// ============================================================================
console.log('● Listener System');

test('subscribe() receives updates on register', () => {
  let notified = false;
  let notifiedName = null;

  const unsubscribe = registry.subscribe((name, newMod, oldMod) => {
    notified = true;
    notifiedName = name;
  });

  registry.register('test/listener1', { value: 1 });

  assert(notified, 'listener should be notified');
  assertEqual(notifiedName, 'test/listener1', 'should receive correct name');

  unsubscribe();
});

test('subscribe() receives updates on replace', () => {
  let oldModReceived = null;
  let newModReceived = null;

  const unsubscribe = registry.subscribe((name, newMod, oldMod) => {
    if (name === 'test/listener1') {
      oldModReceived = oldMod;
      newModReceived = newMod;
    }
  });

  registry.replace('test/listener1', { value: 2 });

  assertEqual(oldModReceived?.value, 1, 'should receive old module');
  assertEqual(newModReceived?.value, 2, 'should receive new module');

  unsubscribe();
});

test('unsubscribe() stops notifications', () => {
  let callCount = 0;

  const unsubscribe = registry.subscribe(() => {
    callCount++;
  });

  registry.register('test/listener2', {});
  assertEqual(callCount, 1, 'should be called once');

  unsubscribe();

  registry.register('test/listener3', {});
  assertEqual(callCount, 1, 'should not be called after unsubscribe');
});

console.log('');

// ============================================================================
// Test 6: Simulated hot-reload workflow
// ============================================================================
console.log('● Simulated Hot-Reload Workflow');

await asyncTest('full hot-reload cycle with state preservation', async () => {
  // Simulate a command with state
  const commandV1 = {
    name: 'counter-cmd',
    _count: 0,
    exec() {
      this._count++;
      return `Count: ${this._count}`;
    }
  };

  // Register initial version
  registry.register('commands/counter', commandV1);

  // Execute a few times
  let cmd = registry.get('commands/counter');
  cmd.exec();
  cmd.exec();
  cmd.exec();
  assertEqual(cmd._count, 3, 'count should be 3 after 3 executions');

  // "Edit" and create v2 with migration
  const commandV2 = {
    name: 'counter-cmd',
    _count: 0,
    migrateFrom(old) {
      this._count = old._count;
    },
    exec() {
      this._count++;
      return `Count v2: ${this._count}`;
    }
  };

  // Hot-reload
  const result = registry.replace('commands/counter', commandV2);
  assert(result.migrated, 'migration should succeed');

  // Verify state preserved
  cmd = registry.get('commands/counter');
  assertEqual(cmd._count, 3, 'count should still be 3 after reload');

  // Execute again
  const output = cmd.exec();
  assertEqual(cmd._count, 4, 'count should be 4 after one more execution');
  assert(output.includes('v2'), 'should use v2 code');
});

await asyncTest('CommandRegistry integration pattern', async () => {
  // Simulate how main.ts integrates registry with CommandRegistry
  const commandRegistry = new Map();

  // Subscribe to propagate updates
  registry.subscribe((name, newMod) => {
    if (name.startsWith('commands/') && newMod) {
      commandRegistry.set(newMod.name, newMod);
    }
  });

  // Register a command
  const lsCmd = { name: 'ls', exec: () => 'file1\nfile2' };
  registry.register('commands/ls', lsCmd);

  assert(commandRegistry.has('ls'), 'CommandRegistry should have ls');

  // Hot-reload ls
  const lsCmdV2 = { name: 'ls', exec: () => 'file1\nfile2\nfile3' };
  registry.replace('commands/ls', lsCmdV2);

  // Verify CommandRegistry was updated
  const retrieved = commandRegistry.get('ls');
  assertEqual(retrieved.exec(), 'file1\nfile2\nfile3', 'should have v2 behavior');
});

console.log('');

// ============================================================================
// Summary
// ============================================================================
console.log('─'.repeat(50));
console.log(`\nTotal: ${passed} passed, ${failed} failed\n`);

process.exit(failed > 0 ? 1 : 0);
