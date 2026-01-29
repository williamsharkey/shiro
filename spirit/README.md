# Spirit: Claude Code for Browser-Based JS Operating Systems

Spirit is a single TypeScript library that implements the Claude Code agent loop (prompt → API → tool_use → execute → loop) targeting virtual filesystems and terminals instead of a real OS. It runs entirely in-browser JavaScript and works in both [Shiro](https://github.com/williamsharkey/shiro) and [Foam](https://github.com/williamsharkey/foam) via an `OSProvider` adapter interface.

- **Distribution**: Git submodule included in both foam and shiro
- **First target**: Shiro (already has `@anthropic-ai/sdk`, TypeScript, structured architecture)

---

## Architecture

```
┌─────────────────────────────────────┐
│           SpiritAgent               │  ← Public facade
├─────────────────────────────────────┤
│           AgentLoop                 │  ← prompt → API → tools → loop
├──────────┬──────────────────────────┤
│ ApiClient│     ToolRegistry         │  ← fetch-based API + tool dispatch
│          ├──────┬───┬───┬───┬──────┤
│          │ Bash │Read│Write│Edit│... │  ← Tool implementations
├──────────┴──────┴───┴───┴───┴──────┤
│           OSProvider (interface)     │  ← Abstract OS layer
├─────────────────┬───────────────────┤
│  ShiroProvider  │   FoamProvider    │  ← Concrete adapters
└─────────────────┴───────────────────┘
```

## File Structure

```
spirit/
  package.json
  tsconfig.json
  vite.config.ts              # Library mode build (ES module bundle for Foam)
  src/
    index.ts                  # Public exports
    spirit.ts                 # SpiritAgent facade class
    agent-loop.ts             # Core loop: messages → API → tool exec → repeat
    api-client.ts             # Fetch-based Anthropic Messages API client
    system-prompt.ts          # System prompt builder (adapts to host env)
    types.ts                  # All shared interfaces
    tools/
      index.ts                # ToolRegistry: definitions + dispatch
      bash.ts                 # provider.exec(command)
      read.ts                 # provider.readFile(path) with line numbers
      write.ts                # provider.writeFile(path, content)
      edit.ts                 # String replacement in files
      glob.ts                 # provider.glob(pattern)
      ask-user.ts             # provider.readFromUser(question)
    providers/
      types.ts                # OSProvider interface
      shiro-provider.ts       # Wraps Shiro's FileSystem + Shell
      foam-provider.ts        # Wraps Foam's VFS + shell
```

## Key Interface: OSProvider

Every tool calls the provider, never the host directly:

```typescript
interface OSProvider {
  // Filesystem
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<FileInfo[]>;
  stat(path: string): Promise<StatResult>;
  exists(path: string): Promise<boolean>;
  unlink(path: string): Promise<void>;
  rename(old: string, new_: string): Promise<void>;

  // Path / env
  resolvePath(path: string): string;
  getCwd(): string;
  setCwd(path: string): void;
  getEnv(): Record<string, string>;

  // Search
  glob(pattern: string, base?: string): Promise<string[]>;

  // Shell
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;

  // Terminal I/O
  writeToTerminal(text: string): void;
  readFromUser(prompt: string): Promise<string>;

  // Host info (for system prompt)
  getHostInfo(): { name: string; version: string };
}
```

Shiro and Foam have nearly identical capabilities but slightly different APIs (Shiro uses `Uint8Array` + `'utf8'` flag, Foam uses strings directly; Shiro's `readdir` returns `string[]` vs Foam returns objects). The providers normalize these differences.

## Phase 1 Tool Set (6 tools)

| Tool | What it does |
|------|-------------|
| **Bash** | Runs shell commands via `provider.exec()` — gives access to all host commands (ls, git, grep, etc.) |
| **Read** | Reads file contents with optional offset/limit, returns with line numbers |
| **Write** | Creates/overwrites files, auto-creates parent dirs |
| **Edit** | Exact string replacement in files (must match uniquely) |
| **Glob** | Pattern-match file paths (e.g., `**/*.ts`) |
| **AskUserQuestion** | Prompts user for input via terminal |

## Agent Loop

1. User message → append to `messages[]`
2. Call Anthropic Messages API with system prompt + messages + tool definitions
3. If response has `tool_use` blocks → execute each tool via `ToolRegistry` → append results → go to 2
4. If response has only text → output to terminal → done
5. Abort via `AbortController` (Ctrl+C support)

## API Client

- Direct `fetch()` to `https://api.anthropic.com/v1/messages`
- Header: `anthropic-dangerous-direct-browser-access: true` (enables browser CORS)
- API key stored by user in their environment (Shiro: env var, Foam: localStorage)
- Phase 1: non-streaming responses. Phase 2: SSE streaming for real-time text output.

## Integration

### Shiro

Spirit registers as a `spirit` shell command in Shiro's command system. `ShiroProvider` wraps `FileSystem`, `Shell`, and terminal.

```
export ANTHROPIC_API_KEY=sk-ant-...
spirit "fix the bug in main.ts"
```

### Foam (Phase 2)

`FoamProvider` wraps VFS, shell interpreter, and xterm.js. Pre-built ES module bundle (`spirit.bundle.js`) imported via `<script type="module">`. Integrated into Foam's existing claude.js module.

## Implementation Steps

1. `git init` + `package.json` + `tsconfig.json` + `vite.config.ts`
2. `src/types.ts` + `src/providers/types.ts` — all interfaces
3. `src/api-client.ts` — fetch-based Anthropic API caller
4. `src/tools/bash.ts`, `read.ts`, `write.ts` — core 3 tools
5. `src/tools/index.ts` — ToolRegistry
6. `src/agent-loop.ts` — the core loop
7. `src/system-prompt.ts` — dynamic system prompt
8. `src/spirit.ts` + `src/index.ts` — facade + exports
9. `src/tools/edit.ts`, `glob.ts`, `ask-user.ts` — remaining tools
10. `src/providers/shiro-provider.ts` — Shiro adapter
11. Vite library build config
12. Test in Shiro as a shell command

## Verification

- Build with `npm run build` — produces `dist/spirit.es.js`
- Import into Shiro, register as command, run `spirit "create a hello world file"`
- Verify: file gets created in virtual FS, agent loop completes, terminal shows output
- Test multi-turn: `spirit "read the file you just created and add a comment"`
- Test Bash tool: `spirit "list all files in the current directory"`
- Test Edit tool: `spirit "change 'hello' to 'goodbye' in hello.js"`
