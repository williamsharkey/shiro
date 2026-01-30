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
    if (ctx.args[0] === 'config' && ctx.args[1] === 'set' && ctx.args[2] === 'api_key' && ctx.args[3]) {
      localStorage.setItem('shiro_api_key', ctx.args[3]);
      // Also set in current env so spirit picks it up immediately
      ctx.env['ANTHROPIC_API_KEY'] = ctx.args[3];
      ctx.stdout = 'API key saved.\n';
      return 0;
    }
    if (ctx.args[0] === 'config' && ctx.args[1] === 'get' && ctx.args[2] === 'api_key') {
      const key = localStorage.getItem('shiro_api_key') || '';
      ctx.stdout = key ? `sk-ant-...${key.slice(-8)}\n` : '(not set)\n';
      return 0;
    }
    ctx.stdout = [
      'Usage:',
      '  shiro config set api_key <key>',
      '  shiro config get api_key',
      '',
    ].join('\n');
    return 0;
  },
};
