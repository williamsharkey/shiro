import type { ShiroTerminal } from './terminal';
import { smartCopyProcess } from './utils/copy-utils';
import { getActiveTerminal } from './active-terminal';

// Web Speech API types (not in default lib)
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

/**
 * Row 1: [Esc] [Tab] [Ctrl] [[] []] [{] [}]  ···spacer···  [Paste] [Speak]     [ ↑ ]
 * Row 2: [ - ] [ | ] [ / ]  [~] [`] [$] [&]  ···spacer···  [ Copy] [  ;  ]  [←] [↓] [→]
 */
const ROW1_KEYS: { label: string; data: string; mod?: boolean; id?: string }[] = [
  { label: 'Esc', data: '\x1b', mod: true },
  { label: 'Tab', data: '\t', mod: true },
  { label: 'Ctrl', data: '', mod: true, id: 'ctrl' },
  { label: '[', data: '[' },
  { label: ']', data: ']' },
  { label: '{', data: '{' },
  { label: '}', data: '}' },
];

const ROW2_KEYS: { label: string; data: string }[] = [
  { label: '-', data: '-' },
  { label: '|', data: '|' },
  { label: '/', data: '/' },
  { label: '~', data: '~' },
  { label: '`', data: '`' },
  { label: '$', data: '$' },
  { label: '&', data: '&' },
];

/**
 * Initialize mobile input: unified 2-row toolbar with virtual keys, arrows,
 * copy/paste, and voice input. Only active on touch devices.
 */
export function initMobileInput(terminal: ShiroTerminal): void {
  if (!window.matchMedia('(pointer: coarse)').matches) return;

  const bar = createUnifiedToolbar(terminal);

  if (window.visualViewport) {
    const reposition = () => repositionToolbar(bar);
    window.visualViewport.addEventListener('resize', reposition);
    window.visualViewport.addEventListener('scroll', reposition);
  }
}

function createUnifiedToolbar(terminal: ShiroTerminal): HTMLElement {
  const bar = document.createElement('div');
  bar.id = 'shiro-vkeys';

  let ctrlActive = false;
  let ctrlBtn: HTMLButtonElement | null = null;

  // All key buttons (for event delegation)
  const keyMap = new Map<HTMLElement, { data: string; label: string }>();

  /** Route input to the active terminal (spawned window or main). */
  function inject(data: string) {
    const active = getActiveTerminal();
    if (active?.injectInput) {
      active.injectInput(data);
    } else {
      terminal.injectInput(data);
    }
  }

  function handleKey(btn: HTMLElement) {
    const entry = keyMap.get(btn);
    if (!entry) return;

    if (entry.label === 'Ctrl') {
      ctrlActive = !ctrlActive;
      btn.classList.toggle('active', ctrlActive);
      return;
    }

    if (ctrlActive) {
      ctrlActive = false;
      ctrlBtn?.classList.remove('active');
      if (entry.data.length === 1 && entry.data >= 'A' && entry.data <= 'z') {
        const code = entry.data.toUpperCase().charCodeAt(0) - 64;
        inject(String.fromCharCode(code));
      } else {
        inject(entry.data);
      }
    } else {
      inject(entry.data);
    }
  }

  function makeKey(label: string, data: string, classes: string = ''): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'shiro-vkey' + (classes ? ' ' + classes : '');
    btn.textContent = label;
    keyMap.set(btn, { data, label });
    return btn;
  }

  function makeSpacer(): HTMLDivElement {
    const s = document.createElement('div');
    s.className = 'vkey-spacer';
    return s;
  }

  // Track action buttons so we can exclude them from key delegation
  const actionBtns: HTMLElement[] = [];

  // === Row 1: [Esc] [Tab] [Ctrl] [[] []] [{] [}]  ···spacer···  [Paste] [Speak]  [ ↑ ] ===
  const row1 = document.createElement('div');
  row1.className = 'vkey-row';

  for (const key of ROW1_KEYS) {
    const btn = makeKey(key.label, key.data, key.mod ? 'mod' : '');
    if (key.id === 'ctrl') ctrlBtn = btn;
    row1.appendChild(btn);
  }

  row1.appendChild(makeSpacer());

  // Paste
  const pasteBtn = document.createElement('button');
  pasteBtn.className = 'shiro-vkey action';
  pasteBtn.textContent = 'Paste';
  pasteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const target = getActiveTerminal()?.term || terminal.term;
    try {
      const text = await navigator.clipboard.readText();
      if (text) target.paste(text);
    } catch {
      const text = prompt('Paste text:');
      if (text) target.paste(text);
    }
  });
  row1.appendChild(pasteBtn);
  actionBtns.push(pasteBtn);

  // Speak
  const speakBtn = createSpeakButton(terminal, inject);
  if (speakBtn) {
    row1.appendChild(speakBtn);
    actionBtns.push(speakBtn);
  }

  // Arrow cluster: invisible placeholder, ↑, invisible placeholder
  // so ↑ lines up exactly above ↓ between ← and →
  const phantom1 = document.createElement('button');
  phantom1.className = 'shiro-vkey';
  phantom1.style.visibility = 'hidden';
  row1.appendChild(phantom1);

  row1.appendChild(makeKey('\u2191', '\x1b[A'));

  const phantom2 = document.createElement('button');
  phantom2.className = 'shiro-vkey';
  phantom2.style.visibility = 'hidden';
  row1.appendChild(phantom2);

  bar.appendChild(row1);

  // === Row 2: [-] [|] [/] [~] [`] [$] [&]  ···spacer···  [Copy] [;]  [←] [↓] [→] ===
  const row2 = document.createElement('div');
  row2.className = 'vkey-row';

  for (const key of ROW2_KEYS) {
    row2.appendChild(makeKey(key.label, key.data));
  }

  row2.appendChild(makeSpacer());

  // Copy (lines up under Paste)
  const copyBtn = document.createElement('button');
  copyBtn.className = 'shiro-vkey action';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const selection = terminal.term.getSelection();
    if (selection) {
      try { await navigator.clipboard.writeText(selection); } catch {}
    } else {
      const content = smartCopyProcess(terminal.getLastCommandOutput());
      try { await navigator.clipboard.writeText(content); } catch {}
    }
  });
  row2.appendChild(copyBtn);
  actionBtns.push(copyBtn);

  // ; (lines up under Speak)
  row2.appendChild(makeKey(';', ';'));

  // ← ↓ → (inverted-T: ↑ above ↓, ← and → flanking)
  row2.appendChild(makeKey('\u2190', '\x1b[D'));
  row2.appendChild(makeKey('\u2193', '\x1b[B'));
  row2.appendChild(makeKey('\u2192', '\x1b[C'));

  bar.appendChild(row2);

  // === Event delegation for virtual keys ===
  bar.addEventListener('touchstart', (e) => {
    const btn = (e.target as HTMLElement).closest('.shiro-vkey') as HTMLElement | null;
    if (!btn || actionBtns.includes(btn)) return;
    e.preventDefault(); // Keep keyboard open
    handleKey(btn);
  }, { passive: false });

  bar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.shiro-vkey') as HTMLElement | null;
    if (!btn || actionBtns.includes(btn)) return;
    handleKey(btn);
  });

  document.body.appendChild(bar);
  return bar;
}

/** Create the Speak button for voice input. Returns null if Speech API unavailable. */
function createSpeakButton(terminal: ShiroTerminal, inject: (data: string) => void): HTMLButtonElement | null {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SR) return null;

  const btn = document.createElement('button');
  btn.className = 'shiro-vkey action';
  btn.textContent = 'Mic';

  let mode: 'off' | 'dictate' = 'off';
  let rec: any = null;

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

      if (raw === 'send' || raw === 'enter') {
        inject('\r');
      } else {
        for (const ch of original) {
          inject(ch);
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
    };

    rec.start();
  }

  function stopRecognition() {
    mode = 'off';
    btn.classList.remove('dictating');
    btn.textContent = 'Mic';
    if (rec) {
      try { rec.stop(); } catch { /* ignore */ }
      rec = null;
    }
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (mode === 'dictate') {
      stopRecognition();
    } else {
      mode = 'dictate';
      btn.classList.add('dictating');
      btn.textContent = 'Stop';
      startRecognition();
    }
  });

  return btn;
}

/** Reposition the toolbar above the iOS keyboard */
function repositionToolbar(bar: HTMLElement): void {
  const vv = window.visualViewport;
  if (!vv) return;

  const keyboardOffset = window.innerHeight - vv.height - vv.offsetTop;
  bar.style.bottom = Math.max(0, keyboardOffset) + 'px';
}
