// Stub FitAddon for headless xterm — no DOM measurements needed in tests
export class FitAddon {
  activate() {}
  dispose() {}
  fit() {}
  proposeDimensions() { return { cols: 80, rows: 24 }; }
}
