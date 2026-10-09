/**
 * Judge an LTP test's output: it passes when it printed its Summary with
 * passed > 0 and no failed or broken results. (Exit status isn't used: under
 * Shiro a test may not get to exit after printing its summary.) The summary
 * counts live in a MAP_SHARED page the forked test child writes; when fork
 * doesn't share it (Blink's snapshot fork) the summary reads all zeros, so
 * the result lines (TPASS/TFAIL/TBROK, printed by whichever process reports
 * them) are counted instead.
 */
export function judgeLtp(text) {
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\x1b\[[0-9;]*m/g, '');
  const num = (k) => { const m = new RegExp(`^${k}\\s+(\\d+)`, 'm').exec(text); return m ? Number(m[1]) : null; };
  const summary = /^Summary:/m.test(text);
  let passed = num('passed'), failed = num('failed'), broken = num('broken'), skipped = num('skipped');
  // (the parent's "haven't reported results" is the same lost page)
  const lines = (t) => text.split('\n').filter((l) => new RegExp(`\\b${t}\\b`).test(l) && !/haven't reported results/.test(l)).length;
  const counted = { passed: lines('TPASS'), failed: lines('TFAIL'), broken: lines('TBROK'), skipped: lines('TCONF') };
  if (summary && !passed && !failed && !broken && counted.passed + counted.failed + counted.broken > 0) {
    ({ passed, failed, broken } = counted);
    skipped = skipped || counted.skipped;
  }
  const ok = summary && passed > 0 && failed === 0 && broken === 0;
  let reason = '';
  if (!summary) reason = 'no summary';
  else if (!ok) {
    const bad = text.split('\n').find((l) => /\bT(FAIL|BROK)\b/.test(l) && !/haven't reported results/.test(l));
    reason = bad ? bad.trim().slice(0, 160) : `passed ${passed} failed ${failed} broken ${broken}`;
  }
  return { ok, summary, passed, failed, broken, skipped, reason };
}
