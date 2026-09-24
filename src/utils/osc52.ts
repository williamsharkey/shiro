import type { Terminal } from '@xterm/xterm';

/** Decode base64 to a UTF-8 string. */
function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Legacy copy via a hidden textarea; works where the async API is refused. */
function execCommandCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  const prevFocus = document.activeElement as HTMLElement | null;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  prevFocus?.focus?.();
  return ok;
}

/** Copy to the clipboard, falling back when the async API is refused (e.g. document not focused). */
export function copyText(text: string): void {
  const fallback = (why: string) => {
    const ok = execCommandCopy(text);
    console.log(`[osc52] ${ok ? 'copied' : 'FAILED to copy'} ${text.length} chars via execCommand (${why})`);
  };
  if (!navigator.clipboard?.writeText) { fallback('no async clipboard API'); return; }
  navigator.clipboard.writeText(text).then(
    () => console.log(`[osc52] copied ${text.length} chars`),
    (e) => fallback(e?.message || String(e)),
  );
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
    let text: string;
    try {
      text = decodeBase64Utf8(payload);
    } catch (e: any) {
      console.warn('[osc52] bad payload:', e?.message || e);
      return true;
    }
    copyText(text);
    return true;
  });
}
