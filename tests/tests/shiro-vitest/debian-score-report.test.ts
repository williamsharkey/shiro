import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReport } from '../../../scripts/debian/score-report.mjs';

const ROOT = join(__dirname, '../../..');

/** score.mjs --seed-from-report: a fresh clone's results cache comes from the committed report. */
describe('debian-score report parsing', () => {
  it('reads pass, fail and skip rows and leaves unscored ones out', () => {
    const rows = parseReport([
      '| # | Package | Version | Result | How / failure | Install |',
      '| --- | --- | --- | --- | --- | --- |',
      '| 3 | adduser | 3.152 | pass | /usr/sbin/adduser --version | 54 s |',
      "| 33 | bash | 5.2.37-2+b10 | pass | /usr/bin/bash -c 'echo smoke-ok' |  |",
      '| 202 | linux-image-amd64 | 6.12.107-1 | **fail** (dpkg) | dpkg: error processing package linux-image-amd64 (--configure): | 33 s (base) |',
      '| 446 | intel-microcode |  | skip (not-in-trixie) | no such binary package in trixie amd64 |  |',
      '| 1137 | gnome-themes-extra-data |  | **unscored** (not-yet-scored) |  |  |',
      '| 9 | pipes | 1.0 | pass | /usr/bin/x --help (ran: "a \\| b") |  |',
    ].join('\n'));
    expect(Object.keys(rows)).toEqual(['adduser', 'bash', 'linux-image-amd64', 'intel-microcode', 'pipes']);
    expect(rows.adduser).toMatchObject({ rank: 3, version: '3.152', result: 'pass', smoke: '/usr/sbin/adduser --version', installMs: 54000, already: false });
    expect(rows.bash.installMs).toBeUndefined();
    expect(rows['linux-image-amd64']).toMatchObject({ result: 'fail', category: 'dpkg', installMs: 33000, already: true });
    expect(rows['intel-microcode']).toMatchObject({ result: 'skip', category: 'not-in-trixie' });
    expect(rows['intel-microcode'].version).toBeUndefined();
    expect(rows.pipes.smoke).toBe('/usr/bin/x --help (ran: "a | b")');
  });

  it('covers every scored row of docs/DEBIAN_SCORE.md', () => {
    const doc = readFileSync(join(ROOT, 'docs/DEBIAN_SCORE.md'), 'utf8');
    const rows = Object.values(parseReport(doc)) as { result: string }[];
    const m = /\*\*(\d+) pass\*\*, (\d+) fail/.exec(doc)!;
    expect(rows.filter((r) => r.result === 'pass').length).toBe(+m[1]);
    expect(rows.filter((r) => r.result === 'fail').length).toBe(+m[2]);
  });
});
