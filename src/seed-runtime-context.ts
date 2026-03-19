import type { FileSystem } from './filesystem';

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

export const SHIRO_RUNTIME_CONTEXT_SESSION_KEY = 'shiro_runtime_context_v1';
export const SHIRO_RUNTIME_CONTEXT_MD_PATH = '/home/user/NEO.md';
export const SHIRO_RUNTIME_CONTEXT_JSON_PATH = '/home/user/.shiro-context.json';

type RuntimeContextFS = Pick<FileSystem, 'mkdir' | 'writeFile'>;

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

export function buildNeoMd(context: ShiroRuntimeContext): string {
  if (!context.injected) {
    return `# NEO.md

This file describes the runtime context for this Shiro boot.

- Mode: standalone
- Host page DOM bridge: unavailable
- \`hc live\` inspects Shiro's own DOM
- \`hc outer\` is not expected to work in this boot
`;
  }

  const modeLabel = context.mode === 'seed-blob' ? 'seed blob injection' : 'seed injection';
  const sameOrigin = context.sameOriginParentAccess ? 'yes' : 'no';
  const hostUrl = context.hostUrl || '(unknown)';
  const hostOrigin = context.hostOrigin || '(unknown)';
  const hostTitle = context.hostTitle || '(untitled)';

  return `# NEO.md

This Shiro instance was spawned from a host page.

- Mode: ${modeLabel}
- Host page: ${hostUrl}
- Host origin: ${hostOrigin}
- Host title: ${hostTitle}
- Host DOM bridge: available via \`hc outer\`
- Same-origin parent DOM access: ${sameOrigin}

Start with:

1. Run \`hc outer\`
2. Then use \`hc s\`, \`hc look\`, \`hc q <selector>\`, \`hc @0\`

Notes:

- \`hc live\` inspects Shiro's own DOM, not the host page
- Prefer \`hc outer\` for host-page inspection even in blob mode
- Machine-readable details are in \`${SHIRO_RUNTIME_CONTEXT_JSON_PATH}\`
`;
}

export async function writeRuntimeContextFiles(
  fs: RuntimeContextFS,
  context: ShiroRuntimeContext,
): Promise<void> {
  await fs.mkdir('/home/user', { recursive: true });
  await fs.writeFile(SHIRO_RUNTIME_CONTEXT_MD_PATH, buildNeoMd(context));
  await fs.writeFile(SHIRO_RUNTIME_CONTEXT_JSON_PATH, JSON.stringify(context, null, 2));
}
