import type { FileSystem } from './filesystem';

type JsonRecord = Record<string, any>;

export const DEFAULT_CLAUDE_THEME = 'dark';

export const DEFAULT_CLAUDE_PERMISSIONS = {
  allow: [
    'Bash',
    'Read',
    'Edit',
    'Write',
    'WebFetch',
    'WebSearch',
    'Glob',
    'Grep',
    'mcp__*',
  ],
  deny: [],
};

export interface ClaudeBootstrapOptions {
  homeDir?: string;
  projectPath?: string;
  theme?: 'dark' | 'light' | 'auto';
  completeOnboarding?: boolean;
  trustProject?: boolean;
  completeProjectOnboarding?: boolean;
  acceptBypassPermissions?: boolean;
}

type ClaudeConfigFS = Pick<FileSystem, 'readFile' | 'writeFile' | 'resolvePath'>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(fs: ClaudeConfigFS, path: string): Promise<JsonRecord> {
  try {
    const existing = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(existing as string);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeJson(fs: ClaudeConfigFS, path: string, value: JsonRecord): Promise<void> {
  await fs.writeFile(path, JSON.stringify(value, null, 2));
}

export async function ensureClaudeBootstrap(
  fs: ClaudeConfigFS,
  options: ClaudeBootstrapOptions = {},
): Promise<void> {
  const homeDir = options.homeDir || '/home/user';
  const settingsPath = homeDir + '/.claude/settings.json';
  const configPath = homeDir + '/.claude.json';

  const settings = await readJson(fs, settingsPath);
  let settingsChanged = false;

  if (!isRecord(settings.permissions)) {
    settings.permissions = DEFAULT_CLAUDE_PERMISSIONS;
    settingsChanged = true;
  }

  if (options.acceptBypassPermissions && settings.skipDangerousModePermissionPrompt !== true) {
    settings.skipDangerousModePermissionPrompt = true;
    settingsChanged = true;
  }

  if (settingsChanged) {
    await writeJson(fs, settingsPath, settings);
  }

  const config = await readJson(fs, configPath);
  let configChanged = false;

  if (options.completeOnboarding && config.hasCompletedOnboarding !== true) {
    config.hasCompletedOnboarding = true;
    configChanged = true;
  }

  if (options.theme && typeof config.theme !== 'string') {
    config.theme = options.theme;
    configChanged = true;
  }

  if (options.projectPath) {
    const projectKey = fs.resolvePath(options.projectPath, homeDir);
    const projects = isRecord(config.projects) ? { ...config.projects } : {};
    const project = isRecord(projects[projectKey]) ? { ...projects[projectKey] } : {};
    let projectChanged = false;

    if (options.trustProject && project.hasTrustDialogAccepted !== true) {
      project.hasTrustDialogAccepted = true;
      projectChanged = true;
    }

    if (options.completeProjectOnboarding) {
      if (project.hasCompletedProjectOnboarding !== true) {
        project.hasCompletedProjectOnboarding = true;
        projectChanged = true;
      }
      const seenCount = typeof project.projectOnboardingSeenCount === 'number'
        ? project.projectOnboardingSeenCount
        : 0;
      if (seenCount < 1) {
        project.projectOnboardingSeenCount = 1;
        projectChanged = true;
      }
    }

    if (projectChanged) {
      projects[projectKey] = project;
      config.projects = projects;
      configChanged = true;
    }
  }

  if (configChanged) {
    await writeJson(fs, configPath, config);
  }
}
