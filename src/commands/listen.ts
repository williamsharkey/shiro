import type { Command } from './index';
import { parseArgs } from './flags';

export const listenCmd: Command = {
  name: 'listen',
  description: 'Speech-to-text via browser SpeechRecognition',
  async exec(ctx) {
    const SR = typeof window !== 'undefined'
      ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      : undefined;

    if (!SR) {
      ctx.stderr += 'listen: SpeechRecognition API not available\n';
      return 1;
    }

    const { flags, values } = parseArgs(ctx.args, ['t', 'timeout', 'l', 'lang']);

    const continuous = !!flags.c;
    const timeout = parseInt(values.t || values.timeout || '0', 10);
    const lang = values.l || values.lang || 'en-US';

    const rec = new SR();
    rec.continuous = continuous;
    rec.interimResults = false;
    rec.lang = lang;

    return new Promise<number>((resolve) => {
      let resolved = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const done = (code: number) => {
        if (resolved) return;
        resolved = true;
        if (timer) clearTimeout(timer);
        try { rec.stop(); } catch {}
        resolve(code);
      };

      rec.onresult = (e: any) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const result = e.results[i];
          if (result.isFinal) {
            const text = result[0].transcript.trim();
            if (text) {
              ctx.stdout += text + '\n';
            }
          }
        }
        // In single-utterance mode, done after first final result
        if (!continuous) {
          done(0);
        }
      };

      rec.onerror = (e: any) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          ctx.stderr += 'listen: microphone permission denied\n';
          done(1);
        } else if (e.error === 'no-speech') {
          // In single mode, no-speech is just a timeout
          if (!continuous) done(0);
        } else if (e.error === 'aborted') {
          done(130);
        } else {
          ctx.stderr += `listen: ${e.error}\n`;
          done(1);
        }
      };

      rec.onend = () => {
        if (!resolved) {
          if (continuous) {
            // Auto-restart for continuous mode (iOS Safari kills after ~60s)
            try { rec.start(); } catch { done(0); }
          } else {
            done(0);
          }
        }
      };

      // Ctrl+C abort
      const signal = ctx.shell?.abortController?.signal;
      if (signal) {
        signal.addEventListener('abort', () => done(130), { once: true });
      }

      // Timeout
      if (timeout > 0) {
        timer = setTimeout(() => done(0), timeout * 1000);
      }

      try {
        rec.start();
      } catch (e: any) {
        ctx.stderr += `listen: ${e.message || e}\n`;
        done(1);
      }
    });
  },
};
