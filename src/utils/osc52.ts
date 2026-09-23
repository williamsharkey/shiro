import type { Terminal } from '@xterm/xterm';

/** Decode base64 to a UTF-8 string. */
function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * OSC 52 clipboard writes (`ESC ] 52 ; c ; <base64> BEL`). TUIs that handle the
 * mouse themselves, like Claude Code's fullscreen mode, copy a selection this
 * way, since the highlight they draw isn't an xterm selection Cmd+C can see.
 * Clipboard reads (`?`) are ignored.
 */
export function installOsc52(term: Terminal): void {
  term.parser.registerOscHandler(52, (data) => {
    const sep = data.indexOf(';');
    const payload = sep >= 0 ? data.slice(sep + 1) : data;
    if (!payload || payload === '?') return true;
    try {
      const text = decodeBase64Utf8(payload);
      navigator.clipboard?.writeText(text).catch((e) => console.warn('[osc52] clipboard write failed:', e?.message || e));
    } catch (e: any) {
      console.warn('[osc52] bad payload:', e?.message || e);
    }
    return true;
  });
}
