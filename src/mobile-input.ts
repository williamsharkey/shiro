import type { ShiroTerminal } from './terminal';

// Web Speech API types (not in default lib)
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

/** Key definitions for the virtual key toolbar */
const VKEYS: { label: string; data: string; mod?: boolean }[] = [
  { label: 'Esc', data: '\x1b', mod: true },
  { label: 'Tab', data: '\t', mod: true },
  { label: 'Ctrl', data: '', mod: true }, // sticky toggle, handled specially
  { label: '\u2191', data: '\x1b[A' },
  { label: '\u2193', data: '\x1b[B' },
  { label: '\u2190', data: '\x1b[D' },
  { label: '\u2192', data: '\x1b[C' },
  { label: '-', data: '-' },
  { label: '|', data: '|' },
  { label: '/', data: '/' },
  { label: '~', data: '~' },
  { label: '`', data: '`' },
  { label: '[', data: '[' },
  { label: ']', data: ']' },
];

/**
 * Initialize mobile input features: virtual key toolbar and voice input.
 * Only active on touch devices (pointer: coarse).
 */
export function initMobileInput(terminal: ShiroTerminal): void {
  // Only run on touch devices
  if (!window.matchMedia('(pointer: coarse)').matches) return;

  const vkeys = createVirtualKeys(terminal);
  const micBtn = createMicButton(terminal);

  // Add mic button to the mobile toolbar (next to Paste/Copy)
  const toolbar = document.getElementById('shiro-mobile-toolbar');
  if (toolbar && micBtn) {
    toolbar.appendChild(micBtn);
  }

  // Reposition both toolbars above the iOS keyboard
  if (window.visualViewport) {
    const reposition = () => repositionToolbars(vkeys, toolbar);
    window.visualViewport.addEventListener('resize', reposition);
    window.visualViewport.addEventListener('scroll', reposition);
  }
}

/** Create the virtual key toolbar and attach it to the DOM */
function createVirtualKeys(terminal: ShiroTerminal): HTMLElement {
  const bar = document.createElement('div');
  bar.id = 'shiro-vkeys';

  let ctrlActive = false;
  let ctrlBtn: HTMLButtonElement | null = null;

  for (const key of VKEYS) {
    const btn = document.createElement('button');
    btn.className = 'shiro-vkey' + (key.mod ? ' mod' : '');
    btn.textContent = key.label;

    if (key.label === 'Ctrl') {
      ctrlBtn = btn;
    }

    bar.appendChild(btn);
  }

  // Use touchstart with preventDefault to keep the iOS keyboard open
  bar.addEventListener('touchstart', (e) => {
    const btn = (e.target as HTMLElement).closest('.shiro-vkey') as HTMLElement | null;
    if (!btn) return;
    e.preventDefault(); // Keep keyboard open!

    const label = btn.textContent || '';

    if (label === 'Ctrl') {
      // Toggle sticky Ctrl
      ctrlActive = !ctrlActive;
      btn.classList.toggle('active', ctrlActive);
      return;
    }

    const keyDef = VKEYS.find(k => k.label === label);
    if (!keyDef) return;

    if (ctrlActive) {
      // Send Ctrl+key: for single printable chars, compute control code
      ctrlActive = false;
      ctrlBtn?.classList.remove('active');

      if (keyDef.data.length === 1 && keyDef.data >= 'A' && keyDef.data <= 'z') {
        const code = keyDef.data.toUpperCase().charCodeAt(0) - 64;
        terminal.injectInput(String.fromCharCode(code));
      } else {
        // For non-letter keys, just send the data as-is
        terminal.injectInput(keyDef.data);
      }
    } else {
      terminal.injectInput(keyDef.data);
    }
  }, { passive: false });

  // Also handle click for non-touch scenarios (desktop emulation)
  bar.addEventListener('click', (e) => {
    // Only handle if not already handled by touchstart
    if (e.target === bar) return;
    const btn = (e.target as HTMLElement).closest('.shiro-vkey') as HTMLElement | null;
    if (!btn) return;

    const label = btn.textContent || '';
    if (label === 'Ctrl') {
      ctrlActive = !ctrlActive;
      btn.classList.toggle('active', ctrlActive);
      return;
    }

    const keyDef = VKEYS.find(k => k.label === label);
    if (!keyDef) return;

    if (ctrlActive) {
      ctrlActive = false;
      ctrlBtn?.classList.remove('active');
      if (keyDef.data.length === 1 && keyDef.data >= 'A' && keyDef.data <= 'z') {
        const code = keyDef.data.toUpperCase().charCodeAt(0) - 64;
        terminal.injectInput(String.fromCharCode(code));
      } else {
        terminal.injectInput(keyDef.data);
      }
    } else {
      terminal.injectInput(keyDef.data);
    }
  });

  document.body.appendChild(bar);
  return bar;
}

/** Create a mic button for voice input. Returns null if Speech API unavailable. */
function createMicButton(terminal: ShiroTerminal): HTMLButtonElement | null {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SR) return null;

  const btn = document.createElement('button');
  btn.className = 'shiro-mic-btn';
  btn.textContent = '\uD83C\uDF99'; // microphone emoji
  btn.title = 'Voice input';
  // Match existing mobile toolbar button styles
  btn.style.cssText = `
    height: 36px;
    padding: 0 14px;
    border-radius: 18px;
    border: 1px solid #3d3d5c;
    background: #1a1a2e;
    color: #e0e0e0;
    font-size: 16px;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    cursor: pointer;
    touch-action: manipulation;
    display: flex;
    align-items: center;
    justify-content: center;
    user-select: none;
    -webkit-user-select: none;
    transition: background 0.1s, transform 0.1s;
  `;

  let mode: 'off' | 'dictate' | 'wake' = 'off';
  let rec: any = null; // SpeechRecognition instance

  function startRecognition() {
    if (rec) return;
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = 'en-US';

    rec.onresult = (e: SpeechRecognitionEvent) => {
      const last = e.results[e.results.length - 1];
      if (!last.isFinal) return;

      const raw = last[0].transcript.trim().toLowerCase();
      const original = last[0].transcript.trim();

      if (mode === 'dictate') {
        if (raw === 'send' || raw === 'enter') {
          terminal.injectInput('\r');
        } else {
          for (const ch of original) {
            terminal.injectInput(ch);
          }
        }
        return;
      }

      if (mode === 'wake') {
        const WAKE = 'shiro';
        if (!raw.startsWith(WAKE)) return;

        const cmd = raw.slice(WAKE.length).replace(/^[,\s]+/, '').trim();
        if (!cmd) return;

        const voiceCommands: Record<string, string> = {
          'send': '\r',
          'enter': '\r',
          'cancel': '\x03',
          'escape': '\x1b',
          'tab': '\t',
          'up': '\x1b[A',
          'down': '\x1b[B',
          'left': '\x1b[D',
          'right': '\x1b[C',
        };

        if (voiceCommands[cmd]) {
          terminal.injectInput(voiceCommands[cmd]);
        } else {
          // Type the command text preserving original case
          const originalCmd = original
            .slice(original.toLowerCase().indexOf(WAKE) + WAKE.length)
            .replace(/^[,\s]+/, '');
          for (const ch of originalCmd) {
            terminal.injectInput(ch);
          }
        }
      }
    };

    // iOS Safari kills recognition after ~60s silence — auto-restart
    rec.onend = () => {
      if (mode !== 'off') {
        try { rec.start(); } catch { /* ignore */ }
      }
    };

    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error === 'not-allowed') {
        console.warn('[voice] Microphone permission denied');
        stopRecognition();
      }
      // 'no-speech' is normal silence
    };

    rec.start();
  }

  function stopRecognition() {
    mode = 'off';
    btn.classList.remove('dictating');
    if (rec) {
      try { rec.stop(); } catch { /* ignore */ }
      rec = null;
    }
  }

  btn.addEventListener('click', () => {
    if (mode === 'dictate') {
      // Stop dictation
      stopRecognition();
    } else {
      // Start dictation
      mode = 'dictate';
      btn.classList.add('dictating');
      startRecognition();
    }
  });

  return btn;
}

/** Reposition virtual keys and mobile toolbar above the iOS keyboard */
function repositionToolbars(vkeys: HTMLElement, toolbar: HTMLElement | null): void {
  const vv = window.visualViewport;
  if (!vv) return;

  const keyboardOffset = window.innerHeight - vv.height - vv.offsetTop;
  const bottom = Math.max(0, keyboardOffset);

  // Virtual keys sit at the bottom (above keyboard)
  vkeys.style.bottom = bottom + 'px';

  // Mobile toolbar sits above the virtual keys
  if (toolbar) {
    toolbar.style.bottom = (bottom + 44) + 'px'; // 40px vkeys height + 4px gap
  }
}
