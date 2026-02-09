// image.ts - Shiro Image management for IndexedDB snapshots
// Enables fast test setup by saving/loading filesystem state

import { Command, CommandContext } from './index';
import { FileSystem } from '../filesystem';

/**
 * Shiro Image format - a complete filesystem snapshot
 */
export interface ShiroImage {
  version: string;           // Format version
  created: string;           // ISO timestamp
  description: string;       // Human-readable description
  shiroVersion?: string;     // Shiro version that created this

  // Files in the snapshot
  files: {
    path: string;
    content: string;         // Base64 for binary, plain for text
    encoding: 'utf8' | 'base64';
    mode: number;
    mtime: number;
  }[];

  // Optional: environment variables to restore
  env?: Record<string, string>;

  // Optional: localStorage state
  localStorage?: Record<string, string>;

  // Metadata
  stats: {
    fileCount: number;
    totalSize: number;
    directories: number;
  };
}

/**
 * Recursively collect all files from a directory
 */
async function collectFiles(
  fs: FileSystem,
  dir: string,
  files: ShiroImage['files'],
  stats: ShiroImage['stats']
): Promise<void> {
  const entries = await fs.readdir(dir);

  for (const entry of entries) {
    const fullPath = dir + (dir.endsWith('/') ? '' : '/') + entry;
    const stat = await fs.stat(fullPath);

    if (!stat) continue;

    if (stat.type === 'dir') {
      stats.directories++;
      await collectFiles(fs, fullPath, files, stats);
    } else if (stat.type === 'file') {
      const content = await fs.readFile(fullPath);
      const isText = typeof content === 'string' || isTextContent(content);

      let encoded: string;
      let encoding: 'utf8' | 'base64';

      if (typeof content === 'string') {
        encoded = content;
        encoding = 'utf8';
      } else if (isText) {
        encoded = new TextDecoder().decode(content);
        encoding = 'utf8';
      } else {
        encoded = btoa(String.fromCharCode(...content));
        encoding = 'base64';
      }

      files.push({
        path: fullPath,
        content: encoded,
        encoding,
        mode: stat.mode || 0o644,
        mtime: stat.mtime?.getTime() || Date.now(),
      });

      stats.fileCount++;
      stats.totalSize += typeof content === 'string' ? content.length : content.length;
    }
  }
}

/**
 * Check if content appears to be text (not binary)
 */
function isTextContent(data: Uint8Array): boolean {
  // Check first 1000 bytes for non-printable characters
  const sample = data.slice(0, 1000);
  let nonPrintable = 0;

  for (const byte of sample) {
    // Allow tabs, newlines, carriage returns, and printable ASCII
    if (byte < 9 || (byte > 13 && byte < 32) || byte === 127) {
      nonPrintable++;
    }
  }

  // If more than 10% non-printable, treat as binary
  return nonPrintable / sample.length < 0.1;
}

/**
 * Save filesystem state to a shiro image file
 */
async function saveImage(ctx: CommandContext, name: string, description: string, directories: string[]): Promise<number> {
  const fs = ctx.fs;

  // Create image directory if it doesn't exist
  const imageDir = '/home/user/shiro-images';
  if (!await fs.stat(imageDir)) {
    await fs.mkdir(imageDir, { recursive: true });
  }

  const image: ShiroImage = {
    version: '1.0',
    created: new Date().toISOString(),
    description,
    files: [],
    stats: {
      fileCount: 0,
      totalSize: 0,
      directories: 0,
    },
  };

  // Collect files from specified directories
  ctx.stdout = `Collecting files...\n`;

  for (const dir of directories) {
    const absDir = fs.resolvePath(dir, ctx.cwd);
    const stat = await fs.stat(absDir);

    if (!stat) {
      ctx.stderr = `image: directory not found: ${dir}\n`;
      continue;
    }

    if (stat.type !== 'dir') {
      ctx.stderr = `image: not a directory: ${dir}\n`;
      continue;
    }

    image.stats.directories++;
    await collectFiles(fs, absDir, image.files, image.stats);
  }

  // Capture environment variables (non-sensitive ones)
  const safeEnvKeys = ['HOME', 'USER', 'PWD', 'PATH', 'SHELL', 'TERM', 'NODE_ENV'];
  image.env = {};
  for (const key of safeEnvKeys) {
    if (ctx.env[key]) {
      image.env[key] = ctx.env[key];
    }
  }

  // Write image file
  const imagePath = `${imageDir}/${name}.json`;
  const imageContent = JSON.stringify(image, null, 2);
  await fs.writeFile(imagePath, imageContent);

  const sizeKB = (imageContent.length / 1024).toFixed(1);
  ctx.stdout = `Saved image "${name}" to ${imagePath}\n`;
  ctx.stdout += `  Files: ${image.stats.fileCount}\n`;
  ctx.stdout += `  Directories: ${image.stats.directories}\n`;
  ctx.stdout += `  Size: ${sizeKB} KB\n`;
  ctx.stdout += `  Description: ${description}\n`;

  return 0;
}

/**
 * Load a shiro image into the filesystem
 */
async function loadImage(ctx: CommandContext, name: string, targetDir?: string): Promise<number> {
  const fs = ctx.fs;

  // Find image file
  const imagePaths = [
    `/home/user/shiro-images/${name}.json`,
    `/home/user/shiro-images/${name}`,
    name, // Allow full path
  ];

  let imagePath: string | null = null;
  for (const path of imagePaths) {
    const absPath = fs.resolvePath(path, ctx.cwd);
    if (await fs.stat(absPath)) {
      imagePath = absPath;
      break;
    }
  }

  if (!imagePath) {
    ctx.stderr = `image: image not found: ${name}\n`;
    ctx.stderr += `Searched:\n`;
    for (const path of imagePaths) {
      ctx.stderr += `  ${fs.resolvePath(path, ctx.cwd)}\n`;
    }
    return 1;
  }

  // Read and parse image
  const content = await fs.readFile(imagePath, 'utf8') as string;
  let image: ShiroImage;
  try {
    image = JSON.parse(content);
  } catch (err) {
    ctx.stderr = `image: invalid image file: ${err instanceof Error ? err.message : 'parse error'}\n`;
    return 1;
  }

  // Validate version
  if (!image.version || !image.files) {
    ctx.stderr = `image: invalid image format\n`;
    return 1;
  }

  ctx.stdout = `Loading image "${name}"...\n`;
  ctx.stdout += `  Description: ${image.description}\n`;
  ctx.stdout += `  Created: ${image.created}\n`;
  ctx.stdout += `  Files: ${image.stats?.fileCount || image.files.length}\n`;

  // Determine target directory
  const target = targetDir ? fs.resolvePath(targetDir, ctx.cwd) : '';

  let restored = 0;
  let errors = 0;

  for (const file of image.files) {
    try {
      // Compute target path
      let filePath = file.path;
      if (target) {
        // Replace original root with target
        const firstSlash = file.path.indexOf('/', 1);
        const relativePath = firstSlash > 0 ? file.path.substring(firstSlash) : file.path;
        filePath = target + relativePath;
      }

      // Ensure parent directory exists
      const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
      if (parentDir && !await fs.stat(parentDir)) {
        await fs.mkdir(parentDir, { recursive: true });
      }

      // Decode content
      let content: string | Uint8Array;
      if (file.encoding === 'base64') {
        const binary = atob(file.content);
        content = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          content[i] = binary.charCodeAt(i);
        }
      } else {
        content = file.content;
      }

      // Write file
      await fs.writeFile(filePath, content);
      restored++;
    } catch (err) {
      ctx.stderr += `  Error restoring ${file.path}: ${err instanceof Error ? err.message : 'unknown'}\n`;
      errors++;
    }
  }

  // Restore environment variables
  if (image.env) {
    for (const [key, value] of Object.entries(image.env)) {
      ctx.env[key] = value;
    }
  }

  ctx.stdout += `Restored ${restored} files\n`;
  if (errors > 0) {
    ctx.stdout += `Errors: ${errors}\n`;
  }

  return errors > 0 ? 1 : 0;
}

/**
 * List available shiro images
 */
async function listImages(ctx: CommandContext): Promise<number> {
  const fs = ctx.fs;
  const imageDir = '/home/user/shiro-images';

  const stat = await fs.stat(imageDir);
  if (!stat) {
    ctx.stdout = 'No images found\n';
    ctx.stdout += `Images are stored in ${imageDir}\n`;
    return 0;
  }

  const entries = await fs.readdir(imageDir);
  const images = entries.filter(e => e.endsWith('.json'));

  if (images.length === 0) {
    ctx.stdout = 'No images found\n';
    return 0;
  }

  ctx.stdout = 'Available images:\n';

  for (const name of images) {
    const path = `${imageDir}/${name}`;
    try {
      const content = await fs.readFile(path, 'utf8') as string;
      const image: ShiroImage = JSON.parse(content);
      const sizeKB = (content.length / 1024).toFixed(1);
      const baseName = name.replace('.json', '');
      ctx.stdout += `  ${baseName}\n`;
      ctx.stdout += `    ${image.description || 'No description'}\n`;
      ctx.stdout += `    ${image.stats?.fileCount || image.files?.length || '?'} files, ${sizeKB} KB\n`;
      ctx.stdout += `    Created: ${image.created || 'unknown'}\n`;
    } catch {
      ctx.stdout += `  ${name.replace('.json', '')} (unreadable)\n`;
    }
  }

  return 0;
}

/**
 * Delete a shiro image
 */
async function deleteImage(ctx: CommandContext, name: string): Promise<number> {
  const fs = ctx.fs;
  const imagePath = `/home/user/shiro-images/${name}.json`;

  const stat = await fs.stat(imagePath);
  if (!stat) {
    ctx.stderr = `image: image not found: ${name}\n`;
    return 1;
  }

  await fs.unlink(imagePath);
  ctx.stdout = `Deleted image: ${name}\n`;
  return 0;
}

const IMAGE_USAGE = `shiro image <command> [options]

Commands:
  save <name> [directories...]   Save filesystem state to an image
  load <name> [target]           Load an image into the filesystem
  list                           List available images
  delete <name>                  Delete an image

Options:
  -d, --description <text>       Description for saved image

Examples:
  # Save node_modules as an image
  shiro image save react-18 /home/user/myapp/node_modules -d "React 18 + deps"

  # Load an image
  shiro image load react-18

  # Load image to a specific directory
  shiro image load react-18 /home/user/newproject

  # List images
  shiro image list

  # Delete an image
  shiro image delete old-image

Use Cases:
  - Fast test setup: Pre-install dependencies once, load instantly in tests
  - Share configurations: Export and share development environments
  - Backup state: Save filesystem state before risky operations`;

export const imageCmd: Command = {
  name: 'image',
  description: 'Manage shiro images (filesystem snapshots)',

  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args;

    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      ctx.stdout = IMAGE_USAGE + '\n';
      return 0;
    }

    const command = args[0];

    switch (command) {
      case 'save': {
        if (args.length < 2) {
          ctx.stderr = 'image save: missing name\n';
          return 1;
        }

        const name = args[1];
        let description = '';
        const directories: string[] = [];

        for (let i = 2; i < args.length; i++) {
          if (args[i] === '-d' || args[i] === '--description') {
            description = args[++i] || '';
          } else {
            directories.push(args[i]);
          }
        }

        // Default to current directory if none specified
        if (directories.length === 0) {
          directories.push(ctx.cwd);
        }

        return saveImage(ctx, name, description || `Image created ${new Date().toLocaleDateString()}`, directories);
      }

      case 'load': {
        if (args.length < 2) {
          ctx.stderr = 'image load: missing name\n';
          return 1;
        }
        const name = args[1];
        const target = args[2];
        return loadImage(ctx, name, target);
      }

      case 'list':
      case 'ls':
        return listImages(ctx);

      case 'delete':
      case 'rm': {
        if (args.length < 2) {
          ctx.stderr = 'image delete: missing name\n';
          return 1;
        }
        return deleteImage(ctx, args[1]);
      }

      default:
        ctx.stderr = `image: unknown command: ${command}\n`;
        ctx.stderr += `Run 'shiro image --help' for usage\n`;
        return 1;
    }
  }
};

// Also export as 'shiro image' subcommand
export const shiroImageCmd = imageCmd;
