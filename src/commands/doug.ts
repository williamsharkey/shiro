import { Command } from './index';

let videoElement: HTMLVideoElement | null = null;
let stream: MediaStream | null = null;

export const dougCmd: Command = {
  name: 'doug',
  description: 'Webcam underlay behind terminal text',
  async exec(ctx) {
    const sub = ctx.args[0];

    if (sub === 'stop') {
      if (!videoElement) {
        ctx.stderr = 'doug: not running\n';
        return 1;
      }
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
      }
      videoElement.remove();
      videoElement = null;

      const xterm = document.querySelector('.xterm') as HTMLElement | null;
      if (xterm) xterm.style.background = '';
      const viewport = document.querySelector('.xterm-viewport') as HTMLElement | null;
      if (viewport) viewport.style.background = '';
      const screen = document.querySelector('.xterm-screen') as HTMLElement | null;
      if (screen) screen.style.background = '';
      document.body.style.background = '#1a1a2e';

      ctx.stdout = 'doug: stopped\n';
      return 0;
    }

    if (sub === 'status') {
      ctx.stdout = videoElement ? 'doug: running\n' : 'doug: not running\n';
      return 0;
    }

    if (sub && sub !== 'start') {
      ctx.stderr = `doug: unknown subcommand '${sub}'\nUsage: doug [start|stop|status]\n`;
      return 1;
    }

    if (videoElement) {
      ctx.stdout = 'doug: already running (use doug stop first)\n';
      return 0;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
    } catch (err: any) {
      ctx.stderr = `doug: webcam access denied: ${err.message}\n`;
      return 1;
    }

    videoElement = document.createElement('video');
    videoElement.srcObject = stream;
    videoElement.autoplay = true;
    videoElement.playsInline = true;
    videoElement.muted = true;
    videoElement.id = 'doug-video';

    const s = videoElement.style;
    s.position = 'fixed';
    s.top = '0';
    s.left = '0';
    s.width = '100vw';
    s.height = '100vh';
    s.objectFit = 'cover';
    s.zIndex = '-1';
    s.transform = 'scaleX(-1)';
    s.opacity = '0.35';

    document.body.prepend(videoElement);

    const xterm = document.querySelector('.xterm') as HTMLElement | null;
    if (xterm) xterm.style.background = 'transparent';
    const viewport = document.querySelector('.xterm-viewport') as HTMLElement | null;
    if (viewport) viewport.style.background = 'transparent';
    const screen = document.querySelector('.xterm-screen') as HTMLElement | null;
    if (screen) screen.style.background = 'transparent';
    document.body.style.background = 'transparent';

    ctx.stdout = 'doug: webcam underlay active (use doug stop to disable)\n';
    return 0;
  },
};
