import type { CommandContext } from '../commands/index';

/**
 * Pre-load files from the virtual filesystem into the memory cache.
 * This enables synchronous readFileSync/statSync to work without IndexedDB round-trips.
 */
export async function preloadDir(
  ctx: CommandContext,
  fileCache: Map<string, string>,
  fileMtimes: Map<string, number>,
  dir: string,
  depth = 0,
  maxDepth = 5,
): Promise<void> {
  if (depth > maxDepth) return;
  try {
    const entries = await ctx.fs.readdir(dir);
    for (const name of entries) {
      if (name === '.git') continue;
      if (name === 'node_modules' && depth > 0) continue;
      const fp = dir + '/' + name;
      try {
        const st = await ctx.fs.stat(fp);
        if (st.isDirectory()) {
          fileMtimes.set(fp, st.mtime?.getTime?.() || Date.now());
          await preloadDir(ctx, fileCache, fileMtimes, fp, depth + 1, maxDepth);
        } else if (st.size < 16777216) { // 16MB limit
          const content = await ctx.fs.readFile(fp, 'utf8');
          fileCache.set(fp, content as string);
          fileMtimes.set(fp, st.mtime?.getTime?.() || Date.now());
        }
      } catch { /* skip */ }
    }
  } catch (e: any) {
    if (depth === 0) console.warn(`[preload] readdir('${dir}') FAILED: ${e.message}`);
  }
}

/**
 * Full environment initialization: repair dirs, replay WAL, create config dirs,
 * preload common locations, OAuth token refresh, node_modules preloading.
 */
export async function preloadEnvironment(
  ctx: CommandContext,
  fileCache: Map<string, string>,
  fileMtimes: Map<string, number>,
  scriptPath: string,
): Promise<void> {
  const homeDir = ctx.env['HOME'] || '/home/user';

  // Repair corrupted directory nodes
  for (const dirPath of ['/', '/home', homeDir, '/tmp']) {
    try {
      const st = await ctx.fs.stat(dirPath);
      if (!st.isDirectory()) {
        console.warn(`[init] Repairing corrupted dir node: ${dirPath}`);
        try { await ctx.fs.unlink(dirPath); } catch {}
        await ctx.fs.mkdir(dirPath, { recursive: true });
      }
    } catch {
      try { await ctx.fs.mkdir(dirPath, { recursive: true }); } catch {}
    }
  }
  try { await ctx.fs.mkdir(homeDir, { recursive: true }); } catch {}
  try { await ctx.fs.mkdir('/tmp', { recursive: true }); } catch {}

  // Replay localStorage WAL — recover config files that didn't flush to IndexedDB before page close
  try {
    const walKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('wal:')) walKeys.push(key);
    }
    let walReplayed = 0, walSkipped = 0;
    for (const key of walKeys) {
      const path = key.slice(4); // strip 'wal:' prefix
      if (path.includes('.tmp.')) {
        localStorage.removeItem(key);
        walSkipped++;
        continue;
      }
      const data = localStorage.getItem(key);
      if (data !== null) {
        const parentDir = path.substring(0, path.lastIndexOf('/'));
        try { await ctx.fs.mkdir(parentDir, { recursive: true }); } catch {}
        await ctx.fs.writeFile(path, data);
        walReplayed++;
      }
      localStorage.removeItem(key);
    }
    if (walReplayed || walSkipped) {
      console.warn(`[wal] Replayed ${walReplayed} files, skipped ${walSkipped} .tmp files`);
    }
  } catch (e: any) {
    console.warn(`[wal] Replay error: ${e.message}`);
  }

  // Clean up stale .tmp files from atomic writes (home dir + .claude dir)
  for (const cleanDir of [homeDir, homeDir + '/.claude']) {
    try {
      const entries = await ctx.fs.readdir(cleanDir);
      let tmpCleaned = 0;
      for (const name of entries) {
        if (name.includes('.tmp.')) {
          try { await ctx.fs.unlink(cleanDir + '/' + name); tmpCleaned++; } catch {}
        }
      }
      if (tmpCleaned) console.warn(`[init] Cleaned ${tmpCleaned} stale .tmp files from ${cleanDir}`);
    } catch {}
  }

  // Create essential directories
  try { await ctx.fs.mkdir(homeDir + '/.claude', { recursive: true }); } catch {}
  try { await ctx.fs.mkdir(homeDir + '/.claude/projects', { recursive: true }); } catch {}
  try { await ctx.fs.mkdir(homeDir + '/.claude/statsig', { recursive: true }); } catch {}
  try { await ctx.fs.mkdir(homeDir + '/.config', { recursive: true }); } catch {}

  // Ensure Claude Code settings has proper permissions structure
  {
    const settingsPath = homeDir + '/.claude/settings.json';
    let settings: any = {};
    try {
      const existing = await ctx.fs.readFile(settingsPath, 'utf8');
      settings = JSON.parse(existing as string);
    } catch { /* file doesn't exist or invalid JSON */ }
    // Add permissions block if missing (required by newer Claude Code versions)
    if (!settings.permissions) {
      settings.permissions = {
        allow: [
          "Bash", "Read", "Edit", "Write", "WebFetch", "WebSearch",
          "Glob", "Grep", "mcp__*"
        ],
        deny: []
      };
      try { await ctx.fs.writeFile(settingsPath, JSON.stringify(settings, null, 2)); } catch {}
    }
    // Remove legacy/unrecognized keys that /doctor flags
    if (settings.skipDangerousModePermissionPrompt !== undefined) {
      delete settings.skipDangerousModePermissionPrompt;
      try { await ctx.fs.writeFile(settingsPath, JSON.stringify(settings, null, 2)); } catch {}
    }
  }
  try { await ctx.fs.stat(homeDir + '/.claude/statsig/cache.json'); } catch {
    try { await ctx.fs.writeFile(homeDir + '/.claude/statsig/cache.json', '{}'); } catch {}
  }

  // Pre-load files from common locations
  const preloadDirs = [ctx.cwd];
  if (homeDir !== ctx.cwd) preloadDirs.push(homeDir);
  preloadDirs.push('/tmp');
  preloadDirs.push(homeDir + '/.claude');
  preloadDirs.push(homeDir + '/.config');

  for (const dir of preloadDirs) {
    await preloadDir(ctx, fileCache, fileMtimes, dir, 0, 5);
    try {
      const st = await ctx.fs.stat(dir);
      if (st.isDirectory()) {
        fileCache.set(dir + '/.', ''); // marker for directory existence
      }
    } catch { /* skip if dir doesn't exist */ }
  }

  // Explicitly preload critical CLI config files (safety net)
  const criticalFiles = [
    homeDir + '/.claude.json',
    homeDir + '/.claude/.credentials.json',
    homeDir + '/.claude/.config.json',
    homeDir + '/.claude/settings.json',
    homeDir + '/.claude/settings.local.json',
  ];
  for (const fp of criticalFiles) {
    if (!fileCache.has(fp)) {
      try {
        const content = await ctx.fs.readFile(fp, 'utf8');
        fileCache.set(fp, content as string);
      } catch { /* file doesn't exist yet, that's OK */ }
    }
  }

  // Pre-flight OAuth token refresh for Claude Code CLI
  if (scriptPath?.includes('claude-code')) {
    const credsPath = homeDir + '/.claude/.credentials.json';
    const credsStr = fileCache.get(credsPath);
    if (credsStr) {
      try {
        const creds = JSON.parse(credsStr);
        const oauth = creds.claudeAiOauth;
        if (oauth?.refreshToken && oauth.expiresAt && (oauth.expiresAt - Date.now() < 300000)) {
          console.log(`[node] OAuth token expires in ${Math.round((oauth.expiresAt - Date.now()) / 1000)}s, refreshing...`);
          const proxyOrigin = typeof window !== 'undefined' ? window.location.origin : '';
          const tokenUrl = proxyOrigin + '/api/platform/v1/oauth/token';
          const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: oauth.refreshToken,
            client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
          });
          const resp = await fetch(tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
          });
          if (resp.ok) {
            const data = await resp.json();
            oauth.accessToken = data.access_token;
            oauth.refreshToken = data.refresh_token || oauth.refreshToken;
            oauth.expiresAt = Date.now() + (data.expires_in || 28800) * 1000;
            if (data.scope) oauth.scopes = data.scope.split(' ');
            const newCredsStr = JSON.stringify(creds);
            fileCache.set(credsPath, newCredsStr);
            await ctx.fs.writeFile(credsPath, newCredsStr);
            console.log(`[node] OAuth token refreshed, expires in ${data.expires_in || 28800}s`);
          } else {
            console.warn(`[node] OAuth token refresh failed: ${resp.status} ${await resp.text().catch(() => '')}`);
          }
        }
      } catch (e: any) {
        console.warn(`[node] OAuth token refresh error: ${e.message}`);
      }
    }
  }

  console.log(`[node] ${fileCache.size} files preloaded`);

  // Pre-load node_modules — walk up from cwd
  let nmSearch = ctx.cwd;
  while (nmSearch) {
    const nmDir = nmSearch === '/' ? '/node_modules' : nmSearch + '/node_modules';
    try {
      const entries = await ctx.fs.readdir(nmDir);
      for (const name of entries) {
        await preloadDir(ctx, fileCache, fileMtimes, nmDir + '/' + name, 0, 10);
      }
    } catch { /* no node_modules at this level */ }
    const parent = nmSearch.substring(0, nmSearch.lastIndexOf('/')) || '';
    if (parent === nmSearch || !parent) break;
    nmSearch = parent;
  }

  // Pre-load global node_modules
  try {
    const globalNmDir = '/usr/local/lib/node_modules';
    const globalEntries = await ctx.fs.readdir(globalNmDir);
    for (const name of globalEntries) {
      await preloadDir(ctx, fileCache, fileMtimes, globalNmDir + '/' + name, 0, 10);
    }
  } catch { /* no global node_modules */ }

  // If running a script file, ensure its project directory is fully loaded
  if (scriptPath) {
    let projectRoot = scriptPath.substring(0, scriptPath.lastIndexOf('/')) || ctx.cwd;
    let searchDir = projectRoot;
    while (searchDir && searchDir !== homeDir && searchDir !== '/') {
      try {
        await ctx.fs.stat(searchDir + '/package.json');
        projectRoot = searchDir;
        break;
      } catch {
        const parentDir = searchDir.substring(0, searchDir.lastIndexOf('/')) || '';
        if (parentDir === searchDir || !parentDir) break;
        searchDir = parentDir;
      }
    }
    await preloadDir(ctx, fileCache, fileMtimes, projectRoot, 0, 10);
  }
}
