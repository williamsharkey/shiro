export type ShiroRuntimeMode = 'standalone' | 'seed' | 'seed-blob';

export interface ShiroRuntimeContext {
  mode: ShiroRuntimeMode;
  injected: boolean;
  hcOuterAvailable: boolean;
  sameOriginParentAccess: boolean;
  hostUrl: string | null;
  hostOrigin: string | null;
  hostTitle: string | null;
  createdAt: string;
}

export const SHIRO_RUNTIME_CONTEXT_SESSION_KEY = 'tabcomputer_runtime_context_v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function defaultRuntimeContext(): ShiroRuntimeContext {
  return {
    mode: 'standalone',
    injected: false,
    hcOuterAvailable: false,
    sameOriginParentAccess: false,
    hostUrl: null,
    hostOrigin: null,
    hostTitle: null,
    createdAt: new Date().toISOString(),
  };
}

export function parseRuntimeContext(raw: string | null | undefined): ShiroRuntimeContext {
  if (!raw) return defaultRuntimeContext();

  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return defaultRuntimeContext();

    const mode = parsed.mode === 'seed' || parsed.mode === 'seed-blob' || parsed.mode === 'standalone'
      ? parsed.mode
      : 'standalone';

    return {
      mode,
      injected: parsed.injected === true,
      hcOuterAvailable: parsed.hcOuterAvailable === true,
      sameOriginParentAccess: parsed.sameOriginParentAccess === true,
      hostUrl: typeof parsed.hostUrl === 'string' ? parsed.hostUrl : null,
      hostOrigin: typeof parsed.hostOrigin === 'string' ? parsed.hostOrigin : null,
      hostTitle: typeof parsed.hostTitle === 'string' ? parsed.hostTitle : null,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
    };
  } catch {
    return defaultRuntimeContext();
  }
}
