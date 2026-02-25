import type { FileSystem } from '../filesystem';
import type { TestResult } from './types';

const REPORT_PATH = '/home/user/github-player-report.md';

/**
 * Generate a markdown report from test results and write to disk.
 */
export async function generateReport(fs: FileSystem, results: TestResult[]): Promise<string> {
  const passed = results.filter(r => r.runOk);
  const failed = results.filter(r => !r.runOk);
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);

  let md = `# GitHub Player Test Report\n\n`;
  md += `**Date:** ${new Date().toISOString().slice(0, 10)}\n`;
  md += `**Total:** ${results.length} repos | `;
  md += `**Passed:** ${passed.length} | `;
  md += `**Failed:** ${failed.length} | `;
  md += `**Time:** ${(totalMs / 1000).toFixed(1)}s\n\n`;

  // Summary table
  md += `## Results\n\n`;
  md += `| Repo | Expected | Actual | Clone | Install | Build | Run | Time |\n`;
  md += `|------|----------|--------|-------|---------|-------|-----|------|\n`;
  for (const r of results) {
    const ok = (v: boolean) => v ? '✅' : '❌';
    md += `| ${r.repo} | ${r.expectedKind} | ${r.actualKind} | ${ok(r.cloneOk)} | ${ok(r.installOk)} | ${ok(r.buildOk)} | ${ok(r.runOk)} | ${(r.durationMs / 1000).toFixed(1)}s |\n`;
  }

  // Failures detail
  if (failed.length > 0) {
    md += `\n## Failures\n\n`;
    for (const r of failed) {
      md += `### ${r.repo}\n`;
      md += `- Expected: ${r.expectedKind}, Actual: ${r.actualKind}\n`;
      for (const err of r.errors) {
        md += `- ${err}\n`;
      }
      md += `\n`;
    }
  }

  // Detection accuracy
  const correctDetect = results.filter(r => r.expectedKind === r.actualKind).length;
  md += `## Detection Accuracy\n\n`;
  md += `${correctDetect}/${results.length} repos detected correctly (${Math.round(100 * correctDetect / results.length)}%)\n`;

  // Write to disk
  try {
    await fs.writeFile(REPORT_PATH, new TextEncoder().encode(md));
  } catch {}

  return md;
}

/**
 * Create an empty test result for a candidate.
 */
export function emptyResult(repo: string, expectedKind: string): TestResult {
  return {
    repo,
    expectedKind: expectedKind as TestResult['expectedKind'],
    actualKind: 'unknown',
    cloneOk: false,
    installOk: false,
    buildOk: false,
    runOk: false,
    errors: [],
    durationMs: 0,
  };
}
