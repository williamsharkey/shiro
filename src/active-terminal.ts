/**
 * Global active terminal tracking.
 * Routes mobile toolbar input to whichever terminal last received focus.
 */

export interface ActiveTerminal {
  injectInput: (data: string) => void;
  term: { paste: (data: string) => void; focus: () => void };
}

let active: ActiveTerminal | null = null;

export function setActiveTerminal(t: ActiveTerminal): void {
  active = t;
}

export function getActiveTerminal(): ActiveTerminal | null {
  return active;
}
