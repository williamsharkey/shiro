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

export const downloadCmd: Command = {
  name: 'download',
  description: 'Download files from virtual filesystem to host machine',
  async exec(ctx) {
    if (ctx.args.length === 0) {
      ctx.stderr = 'Usage: download <file> [file2 ...]\n';
      return 1;
    }

    const outputs: string[] = [];
    for (const filePath of ctx.args) {
      try {
        const resolvedPath = ctx.fs.resolvePath(filePath, ctx.cwd);
        const content = await ctx.fs.readFile(resolvedPath, 'utf8') as string;
        const blob = new Blob([content], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filePath.split('/').pop() || 'file';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        outputs.push(`Downloaded: ${filePath}`);
      } catch (err: any) {
        ctx.stderr = `download: ${err.message}\n`;
        return 1;
      }
    }
    ctx.stdout = outputs.join('\n') + '\n';
    return 0;
  },
};

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
