import type { Command } from './index';
import { parseArgs } from './flags';

export const speakCmd: Command = {
  name: 'speak',
  description: 'Text-to-speech via browser SpeechSynthesis',
  async exec(ctx) {
    if (typeof speechSynthesis === 'undefined') {
      ctx.stderr += 'speak: SpeechSynthesis API not available\n';
      return 1;
    }

    const { flags, values, positional } = parseArgs(ctx.args, ['r', 'p', 'v', 'rate', 'pitch', 'voice']);

    // --list: list available voices
    if (flags.list) {
      // Voices may load asynchronously
      let voices = speechSynthesis.getVoices();
      if (voices.length === 0) {
        await new Promise<void>(resolve => {
          speechSynthesis.onvoiceschanged = () => resolve();
          setTimeout(resolve, 1000);
        });
        voices = speechSynthesis.getVoices();
      }
      if (voices.length === 0) {
        ctx.stdout += 'No voices available\n';
        return 0;
      }
      for (const v of voices) {
        const def = v.default ? ' *' : '';
        ctx.stdout += `${v.name} (${v.lang})${def}\n`;
      }
      return 0;
    }

    // --stop: cancel all speech
    if (flags.stop) {
      speechSynthesis.cancel();
      return 0;
    }

    // Get text from args or stdin
    let text = positional.join(' ');
    if (!text && ctx.stdin) {
      text = ctx.stdin.trim();
    }
    if (!text) {
      ctx.stderr += 'Usage: speak [text] or echo "text" | speak\n';
      return 1;
    }

    const rate = parseFloat(values.r || values.rate || '1');
    const pitch = parseFloat(values.p || values.pitch || '1');
    const voiceName = values.v || values.voice || '';

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = isNaN(rate) ? 1 : Math.max(0.1, Math.min(10, rate));
    utterance.pitch = isNaN(pitch) ? 1 : Math.max(0, Math.min(2, pitch));

    if (voiceName) {
      const voices = speechSynthesis.getVoices();
      const match = voices.find(v =>
        v.name.toLowerCase().includes(voiceName.toLowerCase())
      );
      if (match) utterance.voice = match;
    }

    // Await completion so `speak "hi" && echo done` works
    return new Promise<number>((resolve) => {
      utterance.onend = () => resolve(0);
      utterance.onerror = (e) => {
        if (e.error === 'canceled' || e.error === 'interrupted') {
          resolve(130);
        } else {
          ctx.stderr += `speak: ${e.error}\n`;
          resolve(1);
        }
      };

      // Support Ctrl+C abort
      const signal = ctx.shell?.abortController?.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          speechSynthesis.cancel();
        }, { once: true });
      }

      speechSynthesis.speak(utterance);
    });
  },
};
