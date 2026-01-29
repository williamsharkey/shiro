/**
 * Re-export ShiroProvider from the Spirit submodule.
 *
 * Spirit provides its own ShiroProvider that implements OSProvider
 * by wrapping Shiro's FileSystem, Shell, and Terminal interfaces.
 * No need to maintain a duplicate adapter here.
 */
export { ShiroProvider } from '../spirit/src/providers/shiro-provider.js';
export type { OSProvider, FileInfo, StatResult, ShellResult, HostInfo } from '../spirit/src/providers/types.js';
