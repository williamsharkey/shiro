import type { FileSystem } from '../filesystem';
import type { Shell } from '../shell';
import type { ShiroTerminal } from '../terminal';

/** Detected project type */
export type ProjectKind =
  | 'static'
  | 'node-web'
  | 'node-cli'
  | 'python-cli'
  | 'python-web'
  | 'c'
  | 'lua'
  | 'unknown';

/** Result of project detection */
export interface DetectResult {
  kind: ProjectKind;
  /** Entry file or directory to serve */
  entry?: string;
  /** Extra info (e.g. framework name, build script) */
  meta?: Record<string, string>;
}

/** Context passed to runners */
export interface RunContext {
  fs: FileSystem;
  shell: Shell;
  terminal: ShiroTerminal;
  dir: string;
  repoName: string;
  user: string;
  log: (msg: string) => void;
}

/** Result of running a project */
export interface RunnerResult {
  success: boolean;
  /** What actually happened */
  action: string;
  error?: string;
}

/** Test candidate repo */
export interface Candidate {
  user: string;
  repo: string;
  expectedKind: ProjectKind;
  description: string;
}

/** Test result for a candidate */
export interface TestResult {
  repo: string;
  expectedKind: ProjectKind;
  actualKind: ProjectKind;
  cloneOk: boolean;
  installOk: boolean;
  buildOk: boolean;
  runOk: boolean;
  errors: string[];
  durationMs: number;
}
