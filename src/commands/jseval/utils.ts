export class ProcessExitError extends Error {
  code: number;
  _isProcessExit = true;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

export function formatArg(arg: any): string {
  if (typeof arg === 'string') return arg;
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  try {
    return JSON.stringify(arg, null, 2);
  } catch {
    return String(arg);
  }
}
