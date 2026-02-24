import { Command, CommandContext } from './index';

/**
 * convert / magick: ImageMagick via magick-wasm (WebAssembly)
 *
 * Downloads magick-wasm (~15MB) on first use, browser-cached.
 * Supports common convert operations on images in Shiro's filesystem.
 *
 * Usage:
 *   convert input.png -resize 50% output.png
 *   convert input.jpg -quality 80 output.jpg
 *   convert input.png -flip output.png
 *   convert input.png -rotate 90 output.png
 *   convert input.png -grayscale output.png
 *   convert input.png -blur 3 output.png
 *   convert input.png -crop 100x100+10+10 output.png
 *   magick identify input.png
 */

const MAGICK_CDN = 'https://esm.sh/@imagemagick/magick-wasm@0.0.38';

let magickModule: any = null;
let loadPromise: Promise<any> | null = null;

async function ensureMagick(ctx: CommandContext): Promise<any> {
  if (magickModule) return magickModule;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    ctx.stdout += 'Loading ImageMagick (15MB WASM, first time only)... ';

    const mod = await import(/* @vite-ignore */ MAGICK_CDN);
    const { ImageMagick, initializeImageMagick, MagickFormat, MagickGeometry, Percentage } = mod;

    // Initialize WASM
    const wasmUrl = 'https://esm.sh/@aspect-build/imagemagick-wasm@0.0.38/magick.wasm';
    // Try fetching the WASM location from the module
    if (initializeImageMagick) {
      try {
        await initializeImageMagick();
      } catch {
        // Some versions need a WASM URL
        try {
          const wasmMod = await import(/* @vite-ignore */ `${MAGICK_CDN}/dist/magick.wasm`);
          await initializeImageMagick(wasmMod.default || wasmMod);
        } catch {
          // Try without explicit WASM path — module may self-initialize
        }
      }
    }

    magickModule = { ImageMagick, MagickFormat, MagickGeometry, Percentage, ...mod };
    ctx.stdout += 'done.\n';
    return magickModule;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null;
    magickModule = null;
    throw err;
  }
}

function getFormat(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    png: 'Png', jpg: 'Jpeg', jpeg: 'Jpeg', gif: 'Gif',
    bmp: 'Bmp', webp: 'WebP', tiff: 'Tiff', tif: 'Tiff',
    ico: 'Ico', svg: 'Svg', pdf: 'Pdf', avif: 'Avif',
  };
  return map[ext] || 'Png';
}

/**
 * Parse convert-style arguments into operations.
 * convert input.png -resize 50% -flip output.png
 */
function parseOps(args: string[]): {
  input: string;
  output: string;
  ops: { name: string; value: string }[];
} | null {
  if (args.length < 2) return null;

  const input = args[0];
  const output = args[args.length - 1];
  const ops: { name: string; value: string }[] = [];

  let i = 1;
  while (i < args.length - 1) {
    const arg = args[i];
    if (arg.startsWith('-')) {
      const name = arg.slice(1);
      // Check if next arg is a value (not another flag and not the output)
      if (i + 1 < args.length - 1 && !args[i + 1].startsWith('-')) {
        ops.push({ name, value: args[i + 1] });
        i += 2;
      } else {
        ops.push({ name, value: '' });
        i++;
      }
    } else {
      i++;
    }
  }

  return { input, output, ops };
}

export const convertCmd: Command = {
  name: 'convert',
  description: 'ImageMagick image conversion (magick-wasm)',
  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args;

    if (args.length === 0 || args.includes('--help') || args.includes('-help')) {
      ctx.stdout = [
        'convert (Shiro) — ImageMagick powered by magick-wasm',
        '',
        'Usage: convert input [options] output',
        '',
        'Options:',
        '  -resize WxH or N%     Resize image',
        '  -quality N            Set output quality (1-100)',
        '  -rotate N             Rotate by N degrees',
        '  -flip                 Flip vertically',
        '  -flop                 Flip horizontally',
        '  -grayscale            Convert to grayscale',
        '  -blur N               Gaussian blur (radius)',
        '  -crop WxH+X+Y        Crop region',
        '  -strip                Strip metadata',
        '',
        'Examples:',
        '  convert photo.png -resize 50% small.png',
        '  convert input.jpg -quality 80 -resize 800x600 out.jpg',
        '  convert img.png -rotate 90 -flip rotated.png',
        '  convert photo.png -grayscale gray.png',
        '',
      ].join('\n');
      return 0;
    }

    if (args.includes('--version') || args.includes('-version')) {
      ctx.stdout = 'ImageMagick (magick-wasm 0.0.38) — browser WebAssembly build\n';
      return 0;
    }

    const parsed = parseOps(args);
    if (!parsed) {
      ctx.stderr = 'convert: need at least input and output file\n';
      return 1;
    }

    // Read input file
    const inputPath = ctx.fs.resolvePath(parsed.input, ctx.cwd);
    let inputData: Uint8Array;
    try {
      const data = await ctx.fs.readFile(inputPath);
      inputData = data instanceof Uint8Array
        ? data
        : new TextEncoder().encode(data as string);
    } catch (err: any) {
      ctx.stderr = `convert: ${parsed.input}: ${err.message}\n`;
      return 1;
    }

    // Load ImageMagick
    let magick: any;
    try {
      magick = await ensureMagick(ctx);
    } catch (err: any) {
      ctx.stderr = `convert: failed to load ImageMagick: ${err.message}\n`;
      return 1;
    }

    const { ImageMagick, MagickFormat, MagickGeometry, Percentage } = magick;

    // Process image
    try {
      let outputData: Uint8Array | null = null;
      const outputFormat = getFormat(parsed.output);

      ImageMagick.read(inputData, (image: any) => {
        // Apply operations
        for (const op of parsed.ops) {
          switch (op.name) {
            case 'resize': {
              if (op.value.endsWith('%')) {
                const pct = parseInt(op.value);
                if (Percentage) {
                  image.resize(new Percentage(pct), new Percentage(pct));
                } else {
                  const w = Math.round(image.width * pct / 100);
                  const h = Math.round(image.height * pct / 100);
                  image.resize(w, h);
                }
              } else if (op.value.includes('x')) {
                const [w, h] = op.value.split('x').map(Number);
                if (MagickGeometry) {
                  image.resize(new MagickGeometry(w, h || 0));
                } else {
                  image.resize(w, h || 0);
                }
              } else {
                const size = parseInt(op.value);
                image.resize(size, size);
              }
              break;
            }
            case 'quality':
              image.quality = parseInt(op.value) || 85;
              break;
            case 'rotate':
              image.rotate(parseFloat(op.value) || 0);
              break;
            case 'flip':
              image.flip();
              break;
            case 'flop':
              image.flop();
              break;
            case 'grayscale':
            case 'colorspace':
              image.grayscale();
              break;
            case 'blur': {
              const radius = parseFloat(op.value) || 1;
              image.blur(radius, radius);
              break;
            }
            case 'crop': {
              const m = op.value.match(/(\d+)x(\d+)(?:\+(\d+)\+(\d+))?/);
              if (m) {
                const [, w, h, x, y] = m.map(Number);
                if (MagickGeometry) {
                  image.crop(new MagickGeometry(x || 0, y || 0, w, h));
                } else {
                  image.crop(w, h, x || 0, y || 0);
                }
              }
              break;
            }
            case 'strip':
              image.strip();
              break;
          }
        }

        // Write output
        const fmt = (MagickFormat && MagickFormat[outputFormat]) || outputFormat;
        image.write(fmt, (data: Uint8Array) => {
          outputData = new Uint8Array(data);
        });
      });

      if (!outputData) {
        ctx.stderr = 'convert: failed to produce output\n';
        return 1;
      }

      // Write to Shiro FS
      const outputPath = ctx.fs.resolvePath(parsed.output, ctx.cwd);
      const parentDir = outputPath.split('/').slice(0, -1).join('/') || '/';
      try { await ctx.fs.mkdir(parentDir, { recursive: true }); } catch { /* exists */ }
      await ctx.fs.writeFile(outputPath, outputData);

      const sizeKB = ((outputData as Uint8Array).length / 1024).toFixed(1);
      ctx.stdout += `${parsed.output}: ${sizeKB} KB\n`;
      return 0;
    } catch (err: any) {
      ctx.stderr = `convert: ${err.message}\n`;
      return 1;
    }
  },
};

export const magickCmd: Command = {
  name: 'magick',
  description: 'ImageMagick (magick-wasm)',
  async exec(ctx: CommandContext): Promise<number> {
    // magick identify input.png
    if (ctx.args[0] === 'identify' && ctx.args[1]) {
      const filePath = ctx.fs.resolvePath(ctx.args[1], ctx.cwd);
      let data: Uint8Array;
      try {
        const raw = await ctx.fs.readFile(filePath);
        data = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw as string);
      } catch (err: any) {
        ctx.stderr = `magick: ${ctx.args[1]}: ${err.message}\n`;
        return 1;
      }

      let magick: any;
      try {
        magick = await ensureMagick(ctx);
      } catch (err: any) {
        ctx.stderr = `magick: failed to load: ${err.message}\n`;
        return 1;
      }

      try {
        magick.ImageMagick.read(data, (image: any) => {
          const fmt = image.format || 'unknown';
          ctx.stdout += `${ctx.args[1]}: ${fmt} ${image.width}x${image.height}\n`;
        });
        return 0;
      } catch (err: any) {
        ctx.stderr = `magick: ${err.message}\n`;
        return 1;
      }
    }

    // Default: delegate to convert
    return convertCmd.exec(ctx);
  },
};
