/**
 * Who shows the Claude sign-in UI (src/claude-signin.ts). The desktop
 * registers its own sheet here; without one, claude-signin.ts shows its
 * floating panel. A module of its own so registering costs nothing at boot.
 */

export interface ClaudeSignInUIOptions {
  /** One line under the title: why sign in now */
  subtitle?: string;
  /** Project directory to pre-trust for Claude Code */
  cwd?: string;
}

/** Shows the sign-in UI; resolves true once signed in, false if dismissed */
export type ClaudeSignInUI = (opts: ClaudeSignInUIOptions) => Promise<boolean>;

let ui: ClaudeSignInUI | null = null;

export function setClaudeSignInUI(fn: ClaudeSignInUI | null): void { ui = fn; }
export function claudeSignInUI(): ClaudeSignInUI | null { return ui; }
