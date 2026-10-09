/**
 * Environment variables were SHIRO_…; tabcomputer's names are TABCOMPUTER_….
 * Both work: the new name wins when both are set (docs/PROFILES.md).
 */
export function envVar(env: Record<string, string | undefined> | undefined, name: string): string | undefined {
  if (!env) return undefined;
  return env[`TABCOMPUTER_${name}`] ?? env[`SHIRO_${name}`];
}
