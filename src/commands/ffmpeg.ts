import { Command, CommandContext } from './index';

/**
 * ffmpeg: Video/audio processing via ffmpeg.wasm (WebAssembly)
 *
 * Downloads ffmpeg-core.wasm (~25MB) on first use, browser-cached.
 * Single-threaded mode — no COOP/COEP headers required.
 * Bridges Shiro's IndexedDB filesystem to ffmpeg's in-memory FS.
 *
 * Usage:
 *   ffmpeg -i input.mp4 output.gif                          # convert
 *   ffmpeg -i video.mp4 -vf scale=320:-1 small.mp4          # resize
 *   ffmpeg -i input.mp4 -ss 2 -t 3 -f gif out.gif          # clip to gif
 *   ffmpeg -i audio.wav -b:a 128k output.mp3                # transcode audio
 *   ffmpeg -version                                         # show version
 */

const FFMPEG_CDN = 'https://esm.sh/@ffmpeg/ffmpeg@0.12.15';
const CORE_CDN = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';

let ffmpeg: any = null;
let loadPromise: Promise<any> | null = null;

async function ensureFFmpeg(ctx: CommandContext): Promise<any> {
  if (ffmpeg) return ffmpeg;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    ctx.stdout += 'Loading FFmpeg (25MB WASM, first time only)... ';

    const mod = await import(/* @vite-ignore */ FFMPEG_CDN);
    const FFmpeg = mod.FFmpeg || mod.default?.FFmpeg;
    if (!FFmpeg) throw new Error('Failed to load FFmpeg module');

    ffmpeg = new FFmpeg();

    // Log progress during load
    ffmpeg.on('progress', ({ progress }: { progress: number }) => {
      // Progress events during processing — we use these in exec
    });

    await ffmpeg.load({
      coreURL: `${CORE_CDN}/ffmpeg-core.js`,
      wasmURL: `${CORE_CDN}/ffmpeg-core.wasm`,
    });

    ctx.stdout += 'done.\n';
    return ffmpeg;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null;
    ffmpeg = null;
    throw err;
  }
}

/**
 * Parse ffmpeg args to find input files (-i <file>) and the output file (last arg).
 * Returns paths that exist in Shiro FS so we can bridge them to ffmpeg's MEMFS.
 */
function parseFilePaths(args: string[]): { inputs: string[]; output: string | null } {
  const inputs: string[] = [];
  let output: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-i' && i + 1 < args.length) {
      inputs.push(args[i + 1]);
      i++; // skip the filename
    }
  }

  // Output is typically the last argument (if it doesn't start with -)
  if (args.length > 0) {
    const last = args[args.length - 1];
    if (!last.startsWith('-')) {
      output = last;
    }
  }

  return { inputs, output };
}

export const ffmpegCmd: Command = {
  name: 'ffmpeg',
  description: 'Video/audio processing (ffmpeg.wasm)',
  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args;

    if (args.length === 0) {
      ctx.stdout = [
        'ffmpeg (Shiro) — powered by ffmpeg.wasm',
        '',
        'Usage: ffmpeg [options] [[infile options] -i infile]... {[outfile options] outfile}...',
        '',
        'Examples:',
        '  ffmpeg -i input.mp4 output.gif              Convert MP4 to GIF',
        '  ffmpeg -i input.mp4 -vf scale=320:-1 s.mp4  Resize video',
        '  ffmpeg -i input.mp4 -ss 2 -t 3 clip.mp4     Extract 3s clip',
        '  ffmpeg -i audio.wav -b:a 128k out.mp3        Transcode audio',
        '  ffmpeg -version                              Show version',
        '',
      ].join('\n');
      return 0;
    }

    // Handle -version
    if (args.includes('-version') || args.includes('--version')) {
      ctx.stdout = 'ffmpeg version 7.1 (ffmpeg.wasm 0.12.15) -- browser WebAssembly build\n';
      return 0;
    }

    // Load ffmpeg
    let ff: any;
    try {
      ff = await ensureFFmpeg(ctx);
    } catch (err: any) {
      ctx.stderr = `ffmpeg: failed to load: ${err.message}\n`;
      return 1;
    }

    // Parse input/output file paths
    const { inputs, output } = parseFilePaths(args);

    // Bridge input files: Shiro FS → ffmpeg MEMFS
    for (const inputPath of inputs) {
      const resolved = ctx.fs.resolvePath(inputPath, ctx.cwd);
      try {
        const data = await ctx.fs.readFile(resolved);
        const uint8 = data instanceof Uint8Array
          ? data
          : new TextEncoder().encode(data as string);
        // Use just the filename in ffmpeg's flat MEMFS
        const name = inputPath.split('/').pop() || inputPath;
        await ff.writeFile(name, uint8);
      } catch (err: any) {
        ctx.stderr = `ffmpeg: ${inputPath}: ${err.message}\n`;
        return 1;
      }
    }

    // Rewrite args to use flat filenames for ffmpeg's MEMFS
    const ffArgs = args.map((arg, i) => {
      // If this arg follows -i, use just the filename
      if (i > 0 && args[i - 1] === '-i') {
        return arg.split('/').pop() || arg;
      }
      // If this is the output (last non-flag arg), use just the filename
      if (arg === output && output) {
        return output.split('/').pop() || output;
      }
      return arg;
    });

    // Collect log output
    const logs: string[] = [];
    const logHandler = ({ message }: { message: string }) => {
      logs.push(message);
    };
    ff.on('log', logHandler);

    // Show progress
    let lastProgress = -1;
    const progressHandler = ({ progress }: { progress: number }) => {
      const pct = Math.round(progress * 100);
      if (pct > lastProgress && pct % 10 === 0) {
        lastProgress = pct;
      }
    };
    ff.on('progress', progressHandler);

    // Execute
    try {
      const ret = await ff.exec(ffArgs);

      // Remove event listeners
      ff.off('log', logHandler);
      ff.off('progress', progressHandler);

      if (ret !== 0) {
        ctx.stderr = `ffmpeg: exited with code ${ret}\n`;
        // Show last few log lines for debugging
        const tail = logs.slice(-10).join('\n');
        if (tail) ctx.stderr += tail + '\n';
        return ret;
      }
    } catch (err: any) {
      ff.off('log', logHandler);
      ff.off('progress', progressHandler);
      ctx.stderr = `ffmpeg: ${err.message}\n`;
      return 1;
    }

    // Bridge output file: ffmpeg MEMFS → Shiro FS
    if (output) {
      const outputName = output.split('/').pop() || output;
      try {
        const outputData = await ff.readFile(outputName);
        const resolved = ctx.fs.resolvePath(output, ctx.cwd);

        // Ensure parent directory exists
        const parentDir = resolved.split('/').slice(0, -1).join('/') || '/';
        try { await ctx.fs.mkdir(parentDir, { recursive: true }); } catch { /* exists */ }

        await ctx.fs.writeFile(resolved, outputData);

        const sizeKB = (outputData.length / 1024).toFixed(1);
        ctx.stdout += `Output: ${output} (${sizeKB} KB)\n`;
      } catch (err: any) {
        ctx.stderr = `ffmpeg: failed to write output: ${err.message}\n`;
        return 1;
      }

      // Clean up ffmpeg's MEMFS
      try { await ff.deleteFile(outputName); } catch { /* ignore */ }
    }

    // Clean up input files from ffmpeg's MEMFS
    for (const inputPath of inputs) {
      const name = inputPath.split('/').pop() || inputPath;
      try { await ff.deleteFile(name); } catch { /* ignore */ }
    }

    return 0;
  },
};
