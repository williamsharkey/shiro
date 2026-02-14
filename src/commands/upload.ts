import { Command } from './index';

export const uploadCmd: Command = {
  name: 'upload',
  description: 'Upload files from host machine into virtual filesystem',
  async exec(ctx) {
    const targetDir = ctx.args[0] || '.';

    return new Promise<number>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.style.display = 'none';
      document.body.appendChild(input);

      input.addEventListener('change', async () => {
        const files = input.files;
        if (!files || files.length === 0) {
          ctx.stdout = 'No files selected.\n';
          document.body.removeChild(input);
          resolve(0);
          return;
        }

        const outputs: string[] = [];
        for (const file of Array.from(files)) {
          try {
            const content = await file.text();
            const destPath = targetDir === '.'
              ? ctx.fs.resolvePath(file.name, ctx.cwd)
              : ctx.fs.resolvePath(`${targetDir}/${file.name}`, ctx.cwd);
            await ctx.fs.writeFile(destPath, content);
            outputs.push(`Uploaded: ${destPath} (${file.size} bytes)`);
          } catch (err: any) {
            outputs.push(`Failed to upload ${file.name}: ${err.message}`);
          }
        }
        ctx.stdout = outputs.join('\n') + '\n';
        document.body.removeChild(input);
        resolve(0);
      });

      input.addEventListener('cancel', () => {
        ctx.stdout = 'Upload cancelled.\n';
        document.body.removeChild(input);
        resolve(0);
      });

      setTimeout(() => {
        if (document.body.contains(input)) {
          document.body.removeChild(input);
        }
      }, 120000);

      input.click();
    });
  },
};

function triggerDownload(content: string, filename: string) {
  const blob = new Blob([content], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export const downloadCmd: Command = {
  name: 'download',
  description: 'Download files from virtual filesystem to host machine',
  async exec(ctx) {
    // Direct download with arguments
    if (ctx.args.length > 0) {
      const outputs: string[] = [];
      for (const filePath of ctx.args) {
        try {
          const resolvedPath = ctx.fs.resolvePath(filePath, ctx.cwd);
          const content = await ctx.fs.readFile(resolvedPath, 'utf8') as string;
          triggerDownload(content, filePath.split('/').pop() || 'file');
          outputs.push(`Downloaded: ${filePath}`);
        } catch (err: any) {
          ctx.stderr = `download: ${err.message}\n`;
          return 1;
        }
      }
      ctx.stdout = outputs.join('\n') + '\n';
      return 0;
    }

    // No args — show file browser UI
    return showFileBrowser(ctx);
  },
};

async function showFileBrowser(ctx: import('./index').CommandContext): Promise<number> {
  return new Promise<number>(async (resolve) => {
    let currentPath = ctx.cwd;

    // Create overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';

    // Create dialog
    const dialog = document.createElement('div');
    dialog.style.cssText = 'width:480px;max-width:90vw;max-height:70vh;background:#1e1e1e;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,0.5);overflow:hidden;display:flex;flex-direction:column;color:#e0e0e0';

    // Title bar
    const titleBar = document.createElement('div');
    titleBar.style.cssText = 'display:flex;align-items:center;padding:10px 16px;background:#2d2d2d;border-bottom:1px solid #3a3a3a;gap:8px;user-select:none';

    const closeBtn = document.createElement('div');
    closeBtn.style.cssText = 'width:12px;height:12px;border-radius:50%;background:#ff5f56;cursor:pointer;flex-shrink:0';
    closeBtn.onclick = () => { cleanup(); resolve(0); };

    const titleText = document.createElement('div');
    titleText.style.cssText = 'flex:1;text-align:center;font-size:13px;font-weight:500;color:#ccc';
    titleText.textContent = 'Download File';

    titleBar.append(closeBtn, titleText, document.createElement('div')); // spacer on right

    // Path bar
    const pathBar = document.createElement('div');
    pathBar.style.cssText = 'padding:8px 16px;background:#252525;border-bottom:1px solid #3a3a3a;font-size:12px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';

    // File list container
    const listContainer = document.createElement('div');
    listContainer.style.cssText = 'flex:1;overflow-y:auto;min-height:200px;max-height:50vh';

    // Button bar
    const buttonBar = document.createElement('div');
    buttonBar.style.cssText = 'padding:10px 16px;background:#2d2d2d;border-top:1px solid #3a3a3a;display:flex;justify-content:flex-end;gap:8px';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding:5px 16px;border-radius:5px;border:1px solid #555;background:#3a3a3a;color:#ccc;cursor:pointer;font-size:13px';
    cancelBtn.onclick = () => { cleanup(); resolve(0); };
    buttonBar.append(cancelBtn);

    dialog.append(titleBar, pathBar, listContainer, buttonBar);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Click outside to close
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { cleanup(); resolve(0); }
    });

    // ESC to close
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { cleanup(); resolve(0); }
    };
    document.addEventListener('keydown', onKey);

    function cleanup() {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    }

    async function renderDir(dirPath: string) {
      currentPath = dirPath;
      pathBar.textContent = dirPath;
      listContainer.innerHTML = '';

      let entries: string[];
      try {
        entries = await ctx.fs.readdir(dirPath);
        entries.sort();
      } catch {
        const err = document.createElement('div');
        err.style.cssText = 'padding:20px;color:#f55;text-align:center';
        err.textContent = 'Cannot read directory';
        listContainer.appendChild(err);
        return;
      }

      // Parent directory entry
      if (dirPath !== '/') {
        const row = makeRow('..', 'dir');
        row.onclick = () => renderDir(dirPath === '/' ? '/' : dirPath.replace(/\/[^/]+$/, '') || '/');
        listContainer.appendChild(row);
      }

      // Entries
      for (const name of entries) {
        if (name === '.' || name === '..') continue;
        const fullPath = (dirPath === '/' ? '' : dirPath) + '/' + name;
        let type = 'file';
        try {
          const stat = await ctx.fs.stat(fullPath);
          if (stat.type === 'dir') type = 'dir';
        } catch { /* assume file */ }

        const row = makeRow(name, type);
        if (type === 'dir') {
          row.onclick = () => renderDir(fullPath);
        } else {
          row.onclick = async () => {
            try {
              const content = await ctx.fs.readFile(fullPath, 'utf8') as string;
              triggerDownload(content, name);
              ctx.stdout = `Downloaded: ${fullPath}\n`;
            } catch (e: any) {
              ctx.stderr = `download: ${e.message}\n`;
            }
            cleanup();
            resolve(0);
          };
        }
        listContainer.appendChild(row);
      }

      if (entries.length === 0 || (entries.length <= 2 && entries.every(e => e === '.' || e === '..'))) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:20px;color:#666;text-align:center;font-size:13px';
        empty.textContent = 'Empty directory';
        listContainer.appendChild(empty);
      }
    }

    function makeRow(name: string, type: string) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;padding:6px 16px;cursor:pointer;gap:8px;font-size:13px;border-bottom:1px solid #2a2a2a';
      row.onmouseenter = () => row.style.background = '#2a2d3a';
      row.onmouseleave = () => row.style.background = '';

      const icon = document.createElement('span');
      icon.style.cssText = 'font-size:16px;width:20px;text-align:center;flex-shrink:0';
      icon.textContent = type === 'dir' ? '\uD83D\uDCC1' : '\uD83D\uDCC4';

      const label = document.createElement('span');
      label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      label.textContent = name;
      if (type === 'dir') label.style.color = '#6cb6ff';

      row.append(icon, label);
      return row;
    }

    await renderDir(currentPath);
  });
}

export const shiroConfigCmd: Command = {
  name: 'shiro',
  description: 'Shiro OS configuration',
  async exec(ctx) {
    // Helper to mask API keys for display
    const maskKey = (key: string, prefix: string) => {
      if (!key) return '(not set)';
      return `${prefix}...${key.slice(-8)}`;
    };

    // Anthropic API key
    if (ctx.args[0] === 'config' && ctx.args[1] === 'set' && ctx.args[2] === 'anthropic_key' && ctx.args[3]) {
      localStorage.setItem('shiro_anthropic_key', ctx.args[3]);
      ctx.env['ANTHROPIC_API_KEY'] = ctx.args[3];
      ctx.stdout = 'Anthropic API key saved.\n';
      return 0;
    }
    if (ctx.args[0] === 'config' && ctx.args[1] === 'get' && ctx.args[2] === 'anthropic_key') {
      const key = localStorage.getItem('shiro_anthropic_key') || '';
      ctx.stdout = maskKey(key, 'sk-ant-') + '\n';
      return 0;
    }

    // OpenAI API key
    if (ctx.args[0] === 'config' && ctx.args[1] === 'set' && ctx.args[2] === 'openai_key' && ctx.args[3]) {
      localStorage.setItem('shiro_openai_key', ctx.args[3]);
      ctx.env['OPENAI_API_KEY'] = ctx.args[3];
      ctx.stdout = 'OpenAI API key saved.\n';
      return 0;
    }
    if (ctx.args[0] === 'config' && ctx.args[1] === 'get' && ctx.args[2] === 'openai_key') {
      const key = localStorage.getItem('shiro_openai_key') || '';
      ctx.stdout = maskKey(key, 'sk-') + '\n';
      return 0;
    }

    // Google API key
    if (ctx.args[0] === 'config' && ctx.args[1] === 'set' && ctx.args[2] === 'google_key' && ctx.args[3]) {
      localStorage.setItem('shiro_google_key', ctx.args[3]);
      ctx.env['GOOGLE_API_KEY'] = ctx.args[3];
      ctx.stdout = 'Google API key saved.\n';
      return 0;
    }
    if (ctx.args[0] === 'config' && ctx.args[1] === 'get' && ctx.args[2] === 'google_key') {
      const key = localStorage.getItem('shiro_google_key') || '';
      ctx.stdout = maskKey(key, 'AIza') + '\n';
      return 0;
    }

    // Legacy api_key (for backwards compatibility, maps to Anthropic)
    if (ctx.args[0] === 'config' && ctx.args[1] === 'set' && ctx.args[2] === 'api_key' && ctx.args[3]) {
      localStorage.setItem('shiro_anthropic_key', ctx.args[3]);
      ctx.env['ANTHROPIC_API_KEY'] = ctx.args[3];
      ctx.stdout = 'Anthropic API key saved.\n';
      return 0;
    }
    if (ctx.args[0] === 'config' && ctx.args[1] === 'get' && ctx.args[2] === 'api_key') {
      const key = localStorage.getItem('shiro_anthropic_key') || localStorage.getItem('shiro_api_key') || '';
      ctx.stdout = maskKey(key, 'sk-ant-') + '\n';
      return 0;
    }

    // GitHub token (for git push/pull)
    if (ctx.args[0] === 'config' && ctx.args[1] === 'set' && ctx.args[2] === 'github_token' && ctx.args[3]) {
      localStorage.setItem('shiro_github_token', ctx.args[3]);
      ctx.env['GITHUB_TOKEN'] = ctx.args[3];
      ctx.stdout = 'GitHub token saved. You can now use git push/pull.\n';
      return 0;
    }
    if (ctx.args[0] === 'config' && ctx.args[1] === 'get' && ctx.args[2] === 'github_token') {
      const token = localStorage.getItem('shiro_github_token') || '';
      ctx.stdout = maskKey(token, 'ghp_') + '\n';
      return 0;
    }

    // List all config
    if (ctx.args[0] === 'config' && ctx.args[1] === 'list') {
      const anthropicKey = localStorage.getItem('shiro_anthropic_key') || localStorage.getItem('shiro_api_key') || '';
      const openaiKey = localStorage.getItem('shiro_openai_key') || '';
      const googleKey = localStorage.getItem('shiro_google_key') || '';
      const ghToken = localStorage.getItem('shiro_github_token') || '';
      ctx.stdout = 'Configuration:\n';
      ctx.stdout += `  anthropic_key: ${maskKey(anthropicKey, 'sk-ant-')}\n`;
      ctx.stdout += `  openai_key:    ${maskKey(openaiKey, 'sk-')}\n`;
      ctx.stdout += `  google_key:    ${maskKey(googleKey, 'AIza')}\n`;
      ctx.stdout += `  github_token:  ${maskKey(ghToken, 'ghp_')}\n`;
      return 0;
    }

    ctx.stdout = [
      'Usage:',
      '  shiro config set anthropic_key <key>  Set Anthropic (Claude) API key',
      '  shiro config set openai_key <key>     Set OpenAI (GPT) API key',
      '  shiro config set google_key <key>     Set Google (Gemini) API key',
      '  shiro config set github_token <tok>   Set GitHub token for git push/pull',
      '  shiro config get <key_name>           Show a config value',
      '  shiro config list                     Show all configuration',
      '',
      'Get API keys at:',
      '  Anthropic: https://console.anthropic.com/settings/keys',
      '  OpenAI:    https://platform.openai.com/api-keys',
      '  Google:    https://aistudio.google.com/app/apikey',
      '  GitHub:    https://github.com/settings/tokens',
      '',
    ].join('\n');
    return 0;
  },
};
