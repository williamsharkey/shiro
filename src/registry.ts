/**
 * ModuleRegistry: Hot-reloadable module system for Shiro
 *
 * Instead of static ES imports, modules register themselves here.
 * This allows runtime replacement with state migration.
 *
 * Usage:
 *   // Register a module
 *   registry.register('commands/ls', lsCmd);
 *
 *   // Get a module (always returns current version)
 *   const ls = registry.get('commands/ls');
 *
 *   // Hot-reload with state migration
 *   registry.replace('commands/ls', newLsCmd);
 *
 * Migration protocol:
 *   If newModule has a static `migrateFrom(old)` method, it's called
 *   during replacement to transfer state from the old version.
 */

export interface Migratable<T = unknown> {
  migrateFrom?(oldModule: T): void;
}

export interface ModuleMetadata {
  version: number;
  registeredAt: number;
  lastUpdatedAt: number;
  source?: string; // Path in VFS where source lives
}

export interface RegistryEntry<T = unknown> {
  module: T;
  metadata: ModuleMetadata;
}

export type ModuleListener = (name: string, newModule: unknown, oldModule: unknown | null) => void;

export class ModuleRegistry {
  private modules = new Map<string, RegistryEntry>();
  private listeners: ModuleListener[] = [];

  /**
   * Register a new module. Throws if already registered (use replace() for updates).
   */
  register<T>(name: string, module: T, source?: string): void {
    if (this.modules.has(name)) {
      throw new Error(`Module '${name}' already registered. Use replace() to update.`);
    }

    const entry: RegistryEntry<T> = {
      module,
      metadata: {
        version: 1,
        registeredAt: Date.now(),
        lastUpdatedAt: Date.now(),
        source,
      },
    };

    this.modules.set(name, entry);
    this.notifyListeners(name, module, null);
  }

  /**
   * Get a module by name. Returns undefined if not found.
   */
  get<T>(name: string): T | undefined {
    const entry = this.modules.get(name);
    return entry?.module as T | undefined;
  }

  /**
   * Get a module, throwing if not found.
   */
  require<T>(name: string): T {
    const module = this.get<T>(name);
    if (module === undefined) {
      throw new Error(`Module '${name}' not found in registry`);
    }
    return module;
  }

  /**
   * Check if a module is registered.
   */
  has(name: string): boolean {
    return this.modules.has(name);
  }

  /**
   * Replace a module with a new version, optionally migrating state.
   *
   * If the new module has a static migrateFrom(old) method, it will be called
   * to transfer state from the old module.
   *
   * Returns true if migration was attempted, false if no migration method exists.
   */
  replace<T extends Migratable>(name: string, newModule: T, source?: string): { migrated: boolean; error?: Error } {
    const oldEntry = this.modules.get(name);
    const oldModule = oldEntry?.module;
    let migrated = false;
    let migrationError: Error | undefined;

    // Attempt migration if new module supports it
    if (newModule.migrateFrom && oldModule) {
      try {
        newModule.migrateFrom(oldModule);
        migrated = true;
        console.log(`[Registry] Migrated state for '${name}'`);
      } catch (e) {
        migrationError = e instanceof Error ? e : new Error(String(e));
        console.warn(`[Registry] Migration failed for '${name}':`, migrationError.message);
      }
    }

    const entry: RegistryEntry<T> = {
      module: newModule,
      metadata: {
        version: (oldEntry?.metadata.version ?? 0) + 1,
        registeredAt: oldEntry?.metadata.registeredAt ?? Date.now(),
        lastUpdatedAt: Date.now(),
        source,
      },
    };

    this.modules.set(name, entry);
    this.notifyListeners(name, newModule, oldModule ?? null);

    return { migrated, error: migrationError };
  }

  /**
   * Unregister a module.
   */
  unregister(name: string): boolean {
    const existed = this.modules.has(name);
    if (existed) {
      const entry = this.modules.get(name);
      this.modules.delete(name);
      this.notifyListeners(name, null, entry?.module ?? null);
    }
    return existed;
  }

  /**
   * List all registered module names.
   */
  list(): string[] {
    return Array.from(this.modules.keys());
  }

  /**
   * Get metadata for a module.
   */
  getMetadata(name: string): ModuleMetadata | undefined {
    return this.modules.get(name)?.metadata;
  }

  /**
   * Subscribe to module changes.
   */
  subscribe(listener: ModuleListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Get a snapshot of all modules (for debugging/inspection).
   */
  snapshot(): Map<string, { module: unknown; metadata: ModuleMetadata }> {
    return new Map(this.modules);
  }

  private notifyListeners(name: string, newModule: unknown, oldModule: unknown | null): void {
    for (const listener of this.listeners) {
      try {
        listener(name, newModule, oldModule);
      } catch (e) {
        console.error(`[Registry] Listener error for '${name}':`, e);
      }
    }
  }
}

// Global registry instance
export const registry = new ModuleRegistry();

// Convenience type for commands
export interface HotReloadableCommand {
  name: string;
  description: string;
  exec: (ctx: unknown) => Promise<number>;
  migrateFrom?: (old: HotReloadableCommand) => void;
}
