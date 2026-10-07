import { Command, CommandContext } from './index';

/**
 * agy: Antigravity Python CLI command stub for Shiro OS.
 *
 * This command demonstrates a proof-of-concept for bridging
 * synchronous Python \`subprocess\` calls to asynchronous Shiro
 * commands using a Web Worker and \`Atomics.wait()\` / \`SharedArrayBuffer\`.
 */
export const agyCmd: Command = {
  name: 'agy',
  description: 'Antigravity CLI tool (PoC with Web Worker)',
  async exec(ctx: CommandContext) {
    if (typeof SharedArrayBuffer === 'undefined') {
      ctx.stderr = 'Error: SharedArrayBuffer is not available in this environment.\n';
      ctx.stderr += 'Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers may be required.\n';
      return 1;
    }

    ctx.stdout += 'Starting AGY Web Worker...\n';

    // In a real build, we'd use new Worker(new URL('./agy-worker.ts', import.meta.url), { type: 'module' })
    // We are simulating it for the PoC.
    let worker: Worker;
    try {
      worker = new Worker(new URL('./agy-worker.ts', import.meta.url), { type: 'module' });
    } catch (e: any) {
      ctx.stderr = 'Failed to create worker: ' + e.message + '\n';
      return 1;
    }

    // Allocate SAB for synchronization
    // [0] = status flag (0 = waiting, 1 = main thread finished)
    // [1..N] = data payload (stdout, stderr, etc)
    const sab = new SharedArrayBuffer(1024 * 1024); // 1MB buffer
    const int32 = new Int32Array(sab);
    int32[0] = 0;

        const dumpFS = async (dir: string): Promise<Record<string, Uint8Array>> => {
      const files: Record<string, Uint8Array> = {};
      const entries = await ctx.fs.readdir(dir);
      for (const entry of entries) {
        const fullPath = dir === '/' ? '/' + entry : dir + '/' + entry;
        const stat = await ctx.fs.stat(fullPath);
        if (stat.type === 'dir') {
          Object.assign(files, await dumpFS(fullPath));
        } else if (stat.type === 'file') {
          files[fullPath] = await ctx.fs.readFile(fullPath);
        }
      }
      return files;
    };
    ctx.stdout += 'Dumping file system for Pyodide...\n';
    const initialFiles = await dumpFS('/');
    return new Promise<number>((resolve) => {
      worker.onmessage = async (e) => {
        let msg;
        try {
          msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        } catch {
          msg = e.data;
        }

        if (msg.type === 'exec') {
          const cmdArgs = msg.args;
          ctx.stdout += `[Main Thread] Received subprocess request from Python: ${cmdArgs.join(' ')}\n`;
          
          // Execute the command asynchronously in Shiro
          // Run the command via Shiro shell
          const { stdout, stderr, exitCode } = await ctx.shell.exec(cmdArgs.join(' '));
          
          // Encode strings
          const encoder = new TextEncoder();
          const outBytes = encoder.encode(stdout);
          const errBytes = encoder.encode(stderr);
          
          // Write to SAB
          // [0]: state (0=wait, 1=done)
          // [1]: exitCode
          // [2]: stdout byte length
          // [3]: stderr byte length
          int32[1] = exitCode;
          int32[2] = outBytes.length;
          int32[3] = errBytes.length;
          
          const textBuffer = new Uint8Array(sab, 16, sab.byteLength - 16);
          textBuffer.set(outBytes, 0);
          textBuffer.set(errBytes, outBytes.length);
          
          Atomics.store(int32, 0, 1);
          Atomics.notify(int32, 0, 1);
        } else if (msg.type === 'done') {
          ctx.stdout += 'Worker finished successfully.\n';
          worker.terminate();
          resolve(msg.code);
        } else if (msg.type === 'error') {
          ctx.stderr += 'Worker error: ' + msg.error + '\n';
          worker.terminate();
          resolve(1);
        }
      };

      worker.onerror = (err) => {
        ctx.stderr += 'Worker caught error: ' + err.message + '\n';
        worker.terminate();
        resolve(1);
      };

      


      // Start the worker
      worker.postMessage({
        type: 'init',
        sab,
        args: ctx.args,
        cwd: ctx.cwd,
        files: initialFiles
      });
    });
  },
};
