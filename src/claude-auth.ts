import type { FileSystem } from './filesystem';
import { DEFAULT_CLAUDE_THEME, ensureClaudeBootstrap } from './claude-config';
import { getShiroOrigin } from './utils/shiro-origin';

type JsonRecord = Record<string, any>;

export interface ClaudeOAuthTokens {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null;
  scopes?: string[] | null;
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
}

export interface EnsureClaudeAuthStateOptions {
  homeDir?: string;
  projectPath?: string;
  origin?: string;
  tokens?: ClaudeOAuthTokens | null;
  theme?: 'dark' | 'light' | 'auto';
  ensureBootstrap?: boolean;
  refreshRemoteState?: boolean;
}

type ClaudeAuthFS = Pick<FileSystem, 'mkdir' | 'readFile' | 'resolvePath' | 'unlink' | 'writeFile'>;

interface OAuthProfileResponse {
  account?: {
    uuid?: string;
    email?: string;
    display_name?: string;
    created_at?: string;
  };
  organization?: {
    uuid?: string;
    name?: string;
    organization_type?: string;
    has_extra_usage_enabled?: boolean;
    billing_type?: string;
    subscription_created_at?: string;
    rate_limit_tier?: string;
  };
}

interface OAuthRolesResponse {
  organization_name?: string;
  organization_role?: string;
  workspace_role?: string | null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(fs: ClaudeAuthFS, path: string): Promise<JsonRecord> {
  try {
    const existing = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(existing as string);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeJson(fs: ClaudeAuthFS, path: string, value: JsonRecord): Promise<void> {
  await fs.writeFile(path, JSON.stringify(value, null, 2));
}

function hasInferenceScope(scopes: unknown): scopes is string[] {
  return Array.isArray(scopes) && scopes.includes('user:inference');
}

function isCompleteOAuthAccount(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.accountUuid === 'string'
    && typeof value.emailAddress === 'string'
    && typeof value.organizationUuid === 'string';
}

function mapSubscriptionType(profile: OAuthProfileResponse | null | undefined): string | null {
  switch (profile?.organization?.organization_type) {
    case 'claude_max':
      return 'max';
    case 'claude_pro':
      return 'pro';
    case 'claude_enterprise':
      return 'enterprise';
    case 'claude_team':
      return 'team';
    default:
      return null;
  }
}

async function fetchJson<T>(url: string, headers: Record<string, string>): Promise<T | null> {
  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) return null;
    return await resp.json() as T;
  } catch {
    return null;
  }
}

async function unlinkIfPresent(fs: ClaudeAuthFS, path: string): Promise<boolean> {
  try {
    await fs.unlink(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureClaudeAuthState(
  fs: ClaudeAuthFS,
  options: EnsureClaudeAuthStateOptions = {},
): Promise<void> {
  const homeDir = options.homeDir || '/home/user';
  const origin = options.origin || getShiroOrigin();
  const credsPath = homeDir + '/.claude/.credentials.json';
  const configPath = homeDir + '/.claude.json';
  const mcpNeedsAuthCachePath = homeDir + '/.claude/mcp-needs-auth-cache.json';

  try { await fs.mkdir(homeDir + '/.claude', { recursive: true }); } catch {}

  const existingCreds = await readJson(fs, credsPath);
  const existingOauth = isRecord(existingCreds.claudeAiOauth) ? existingCreds.claudeAiOauth : {};

  if (options.tokens?.accessToken) {
    const nextScopes = Array.isArray(options.tokens.scopes)
      ? options.tokens.scopes.filter((scope): scope is string => typeof scope === 'string' && scope.length > 0)
      : Array.isArray(existingOauth.scopes)
        ? existingOauth.scopes.filter((scope): scope is string => typeof scope === 'string' && scope.length > 0)
        : [];
    existingCreds.claudeAiOauth = {
      accessToken: options.tokens.accessToken,
      refreshToken: options.tokens.refreshToken ?? existingOauth.refreshToken ?? null,
      expiresAt: options.tokens.expiresAt ?? existingOauth.expiresAt ?? null,
      scopes: nextScopes,
      subscriptionType: options.tokens.subscriptionType ?? existingOauth.subscriptionType ?? null,
      rateLimitTier: options.tokens.rateLimitTier ?? existingOauth.rateLimitTier ?? null,
    };
    await writeJson(fs, credsPath, existingCreds);
  }

  const currentCreds = await readJson(fs, credsPath);
  const currentOauth = isRecord(currentCreds.claudeAiOauth) ? currentCreds.claudeAiOauth : {};
  const accessToken = typeof currentOauth.accessToken === 'string' ? currentOauth.accessToken : null;
  const scopes = Array.isArray(currentOauth.scopes)
    ? currentOauth.scopes.filter((scope): scope is string => typeof scope === 'string')
    : [];

  if (!accessToken || !hasInferenceScope(scopes)) {
    if (options.ensureBootstrap) {
      await ensureClaudeBootstrap(fs, {
        homeDir,
        projectPath: options.projectPath,
        theme: options.theme || DEFAULT_CLAUDE_THEME,
        completeOnboarding: true,
        trustProject: true,
        completeProjectOnboarding: true,
        acceptBypassPermissions: true,
      });
    }
    return;
  }

  const config = await readJson(fs, configPath);
  const shouldRefreshRemoteState = Boolean(
    options.refreshRemoteState
    || !isCompleteOAuthAccount(config.oauthAccount)
    || !isRecord(config.clientDataCache)
    || isRecord(config.clientDataCache) && !('data' in config.clientDataCache)
    || await readJson(fs, mcpNeedsAuthCachePath).then((value) => Object.keys(value).length > 0).catch(() => false),
  );

  if (shouldRefreshRemoteState) {
    const authHeaders = {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
      'User-Agent': 'claude-code/2.1.81',
    };

    const profile = await fetchJson<OAuthProfileResponse>(
      `${origin}/api/anthropic/api/oauth/profile`,
      authHeaders,
    );
    const roles = await fetchJson<OAuthRolesResponse>(
      `${origin}/api/anthropic/api/oauth/claude_cli/roles`,
      authHeaders,
    );
    const clientDataResp = await fetchJson<{ client_data?: Record<string, unknown> | null }>(
      `${origin}/api/anthropic/api/oauth/claude_cli/client_data`,
      authHeaders,
    );

    const oauthAccount = isRecord(config.oauthAccount) ? { ...config.oauthAccount } : {};
    let configChanged = false;

    if (profile?.account?.uuid && profile?.account?.email && profile?.organization?.uuid) {
      oauthAccount.accountUuid = profile.account.uuid;
      oauthAccount.emailAddress = profile.account.email;
      oauthAccount.organizationUuid = profile.organization.uuid;
      if (profile.account.display_name) oauthAccount.displayName = profile.account.display_name;
      if (profile.organization.name) oauthAccount.organizationName = profile.organization.name;
      if (typeof profile.organization.has_extra_usage_enabled === 'boolean') {
        oauthAccount.hasExtraUsageEnabled = profile.organization.has_extra_usage_enabled;
      }
      if (profile.organization.billing_type) oauthAccount.billingType = profile.organization.billing_type;
      if (profile.account.created_at) oauthAccount.accountCreatedAt = profile.account.created_at;
      if (profile.organization.subscription_created_at) {
        oauthAccount.subscriptionCreatedAt = profile.organization.subscription_created_at;
      }
      config.oauthAccount = oauthAccount;
      configChanged = true;

      const profileSubscriptionType = mapSubscriptionType(profile);
      if (profileSubscriptionType && config.hasAvailableSubscription !== true) {
        config.hasAvailableSubscription = true;
        configChanged = true;
      }

      const nextCreds = await readJson(fs, credsPath);
      const nextOauth = isRecord(nextCreds.claudeAiOauth) ? { ...nextCreds.claudeAiOauth } : {};
      let credsChanged = false;
      if (profileSubscriptionType && nextOauth.subscriptionType !== profileSubscriptionType) {
        nextOauth.subscriptionType = profileSubscriptionType;
        credsChanged = true;
      }
      if (profile?.organization?.rate_limit_tier && nextOauth.rateLimitTier !== profile.organization.rate_limit_tier) {
        nextOauth.rateLimitTier = profile.organization.rate_limit_tier;
        credsChanged = true;
      }
      if (credsChanged) {
        nextCreds.claudeAiOauth = nextOauth;
        await writeJson(fs, credsPath, nextCreds);
      }
    }

    if (roles) {
      if (roles.organization_name) oauthAccount.organizationName = roles.organization_name;
      if (roles.organization_role) oauthAccount.organizationRole = roles.organization_role;
      oauthAccount.workspaceRole = roles.workspace_role ?? null;
      config.oauthAccount = oauthAccount;
      configChanged = true;
    }

    if (clientDataResp && 'client_data' in clientDataResp) {
      config.clientDataCache = {
        data: clientDataResp.client_data ?? null,
        timestamp: Date.now(),
      };
      configChanged = true;
    }

    if (configChanged) {
      await writeJson(fs, configPath, config);
    }

    await unlinkIfPresent(fs, mcpNeedsAuthCachePath);
  }

  if (options.ensureBootstrap) {
    await ensureClaudeBootstrap(fs, {
      homeDir,
      projectPath: options.projectPath,
      theme: options.theme || DEFAULT_CLAUDE_THEME,
      completeOnboarding: true,
      trustProject: true,
      completeProjectOnboarding: true,
      acceptBypassPermissions: true,
    });
  }
}
