import type { Command } from '../commands/index';

/**
 * Wrap a command with transparent lazy loading.
 * Registers as a thin stub at boot; on first invocation, dynamically
 * imports the real module, caches it, and runs. Zero difference from
 * the user's perspective.
 */
export function lazyCommand(
  name: string,
  description: string,
  loader: () => Promise<Command>,
  /** Synchronous parts of the command needed before it loads (keepOverPackage) */
  extra: Partial<Pick<Command, 'keepOverPackage'>> = {},
): Command {
  let loaded: Command | null = null;
  return {
    ...extra,
    name,
    description,
    async exec(ctx) {
      if (!loaded) loaded = await loader();
      return loaded.exec(ctx);
    },
  };
}
