import type { Command } from './index';
import { parseArgs } from './flags';

export const cameraCmd: Command = {
  name: 'camera',
  description: 'Take a webcam snapshot and save to filesystem',
  async exec(ctx) {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      ctx.stderr += 'camera: getUserMedia API not available\n';
      return 1;
    }

    const { values, positional } = parseArgs(ctx.args, ['o', 'output']);
    const outputFile = values.o || values.output || positional[0] || '';

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });

      // Create hidden video element to capture a frame
      const video = document.createElement('video');
      video.srcObject = stream;
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      video.style.position = 'fixed';
      video.style.left = '-9999px';
      document.body.appendChild(video);

      // Wait for video to be ready
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error('Failed to load video stream'));
        setTimeout(() => resolve(), 3000); // timeout fallback
      });
      // Small delay for auto-exposure
      await new Promise(r => setTimeout(r, 500));

      // Draw frame to canvas
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      const ctx2d = canvas.getContext('2d')!;
      ctx2d.drawImage(video, 0, 0);

      // Clean up video element
      video.remove();

      // Convert to PNG blob
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => b ? resolve(b) : reject(new Error('Failed to create image')),
          'image/png'
        );
      });

      const buffer = new Uint8Array(await blob.arrayBuffer());

      // Determine output path
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = outputFile || `camera-${timestamp}.png`;
      const fullPath = filename.startsWith('/')
        ? filename
        : ctx.fs.resolvePath(ctx.cwd, filename);

      await ctx.fs.writeFile(fullPath, buffer);
      ctx.stdout += `${fullPath}\n`;
      return 0;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('denied') || msg.includes('NotAllowed')) {
        ctx.stderr += 'camera: webcam access denied\n';
      } else {
        ctx.stderr += `camera: ${msg}\n`;
      }
      return 1;
    } finally {
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
      }
    }
  },
};
