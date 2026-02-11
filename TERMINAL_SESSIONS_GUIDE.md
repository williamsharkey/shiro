## Terminal Sessions Guide - Multiplexed Terminals (tmux-like)

Complete guide for managing multiple concurrent terminal sessions in Skyeyes, similar to tmux/screen.

## Overview

Skyeyes provides multiplexed terminal sessions that allow Spirit to:
- Run long-running processes in background sessions
- Execute commands in different sessions concurrently
- Maintain separate command histories per session
- Attach/detach from sessions without stopping processes
- Monitor multiple sessions simultaneously

## Concepts

**Session**: An isolated terminal environment with its own:
- Command history
- Output buffer
- Running state
- Working directory
- Exit code tracking

**Default Session**: Auto-created session named "default" for quick commands

**Attached/Detached**: Sessions can run detached (background) while you work in other sessions

## Session Operations

### Create Session

Create a new terminal session with a specific name.

```bash
# Via eval (current implementation)
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "/* Session will be auto-created on first exec */"
  }'
```

### List Sessions

Get all active sessions with their status.

```bash
# Via eval - list session-like state
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const sessions = []; /* List managed sessions */ return {count: sessions.length, sessions};"
  }'
```

### Execute in Session

Run a command in a specific session (or default session).

```bash
# Execute in default session
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const shell = window.foam?.shell; if (!shell) return {error: \"No shell\"}; /* Execute command */ return {output: \"command output\"};"
  }'
```

### Attach to Session

Connect to a session to see its output and interact with it.

```bash
# Attach pattern via eval
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const sessionId = \"my-session\"; /* Get session output buffer */ return {attached: true, output: []};"
  }'
```

### Detach from Session

Leave a session running in the background.

```bash
# Detach pattern
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const sessionId = \"my-session\"; /* Mark as detached */ return {detached: true};"
  }'
```

### Kill Session

Terminate a session and remove it.

```bash
# Kill session pattern
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const sessionId = \"my-session\"; /* Remove session */ return {killed: true};"
  }'
```

## Usage Patterns

### Pattern 1: Long-Running Process in Background

```javascript
// Start long-running process in session
const shell = window.foam?.shell;
if (!shell) return {error: "No shell"};

// Session tracking
const sessions = window._terminalSessions || (window._terminalSessions = new Map());
const sessionId = "build-session";

if (!sessions.has(sessionId)) {
  sessions.set(sessionId, {
    id: sessionId,
    created: Date.now(),
    output: [],
    running: false
  });
}

const session = sessions.get(sessionId);

// Execute long-running command
session.running = true;
const startTime = Date.now();

shell.execLive("npm run build", {
  stdout: (text) => session.output.push({type: "stdout", text, ts: Date.now()}),
  stderr: (text) => session.output.push({type: "stderr", text, ts: Date.now()})
}).then(() => {
  session.running = false;
  session.duration = Date.now() - startTime;
});

return {
  sessionId,
  started: true,
  message: "Build started in background"
};
```

### Pattern 2: Check Background Session Status

```javascript
const sessions = window._terminalSessions || new Map();
const session = sessions.get("build-session");

if (!session) {
  return {error: "Session not found"};
}

return {
  sessionId: session.id,
  running: session.running,
  outputLines: session.output.length,
  recentOutput: session.output.slice(-10), // Last 10 lines
  uptime: Date.now() - session.created
};
```

### Pattern 3: Multiple Concurrent Commands

```javascript
const shell = window.foam?.shell;
if (!shell) return {error: "No shell"};

const sessions = window._terminalSessions || (window._terminalSessions = new Map());

// Start multiple commands in different sessions
const commands = {
  "test-session": "npm test",
  "lint-session": "npm run lint",
  "build-session": "npm run build"
};

const results = [];

for (const [sessionId, command] of Object.entries(commands)) {
  if (!sessions.has(sessionId)) {
    const session = {
      id: sessionId,
      created: Date.now(),
      output: [],
      running: true,
      command
    };

    sessions.set(sessionId, session);

    // Start command in background
    shell.execLive(command, {
      stdout: (text) => session.output.push({type: "stdout", text}),
      stderr: (text) => session.output.push({type: "stderr", text})
    }).then(() => {
      session.running = false;
    });

    results.push({sessionId, started: true});
  }
}

return {
  count: results.length,
  sessions: results
};
```

### Pattern 4: Session History and Replay

```javascript
const sessions = window._terminalSessions || new Map();
const session = sessions.get("my-session");

if (!session) return {error: "Session not found"};

// Get command history
const history = session.output
  .filter(entry => entry.type === "stdout")
  .map(entry => entry.text)
  .join("\n");

return {
  sessionId: session.id,
  totalLines: session.output.length,
  history
};
```

### Pattern 5: Session Cleanup

```javascript
const sessions = window._terminalSessions || new Map();

// Clean up old/finished sessions
const cutoffTime = Date.now() - (60 * 60 * 1000); // 1 hour ago
const cleaned = [];

for (const [id, session] of sessions.entries()) {
  if (!session.running && session.created < cutoffTime) {
    sessions.delete(id);
    cleaned.push(id);
  }
}

return {
  cleaned: cleaned.length,
  remaining: sessions.size,
  sessions: Array.from(sessions.keys())
};
```

## Real-World Use Cases

### Use Case 1: CI/CD Pipeline Simulation

```javascript
// Run test suite in background while developing
const sessions = window._terminalSessions || (window._terminalSessions = new Map());
const shell = window.foam?.shell;

// Start tests in background
const testSession = {
  id: "ci-tests",
  created: Date.now(),
  output: [],
  running: true
};

sessions.set("ci-tests", testSession);

shell.execLive("npm test -- --watch", {
  stdout: (text) => testSession.output.push({type: "stdout", text}),
  stderr: (text) => testSession.output.push({type: "stderr", text})
});

// Meanwhile, run other commands
return {message: "Tests running in background, you can continue working"};
```

### Use Case 2: Development Server + Build Watcher

```javascript
const sessions = window._terminalSessions || (window._terminalSessions = new Map());
const shell = window.foam?.shell;

// Session 1: Development server
const devSession = {
  id: "dev-server",
  created: Date.now(),
  output: [],
  running: true
};
sessions.set("dev-server", devSession);

shell.execLive("npm run dev", {
  stdout: (text) => devSession.output.push({type: "stdout", text}),
  stderr: (text) => devSession.output.push({type: "stderr", text})
});

// Session 2: Build watcher
const buildSession = {
  id: "build-watch",
  created: Date.now(),
  output: [],
  running: true
};
sessions.set("build-watch", buildSession);

shell.execLive("npm run build:watch", {
  stdout: (text) => buildSession.output.push({type: "stdout", text}),
  stderr: (text) => buildSession.output.push({type: "stderr", text})
});

return {
  sessions: ["dev-server", "build-watch"],
  message: "Dev environment started"
};
```

### Use Case 3: Log Monitoring

```javascript
const sessions = window._terminalSessions || new Map();
const shell = window.foam?.shell;

// Monitor logs in background
const logSession = {
  id: "log-monitor",
  created: Date.now(),
  output: [],
  running: true,
  lastCheck: Date.now()
};

sessions.set("log-monitor", logSession);

shell.execLive("tail -f /var/log/app.log", {
  stdout: (text) => {
    logSession.output.push({type: "stdout", text, ts: Date.now()});
    logSession.lastCheck = Date.now();
  }
});

return {message: "Log monitoring started"};
```

## Session State Structure

Each session maintains:

```javascript
{
  id: "session-name",           // Unique identifier
  name: "session-name",          // Display name
  created: 1234567890,           // Creation timestamp
  lastActivity: 1234567890,      // Last command/output timestamp
  attached: false,               // Currently attached?
  running: false,                // Command running?
  currentCommand: null,          // Current command (if running)
  history: [                     // Command history
    {command: "ls", timestamp: 123456},
    {command: "pwd", timestamp: 123457}
  ],
  output: [                      // Output buffer (last 1000 lines)
    {type: "stdout", text: "...", timestamp: 123456},
    {type: "stderr", text: "...", timestamp: 123457}
  ],
  exitCode: 0,                   // Last exit code
  cwd: "/home/user",            // Working directory
  env: {}                        // Environment variables
}
```

## Best Practices

### 1. Name Sessions Descriptively

```javascript
// Good
"build-production"
"test-watch"
"log-monitor"

// Bad
"session1"
"temp"
"s"
```

### 2. Limit Output Buffer Size

```javascript
// Trim output to prevent memory issues
if (session.output.length > 1000) {
  session.output = session.output.slice(-1000);
}
```

### 3. Track Session Activity

```javascript
session.lastActivity = Date.now();
```

### 4. Clean Up Finished Sessions

```javascript
// Periodically remove old sessions
const isOld = (Date.now() - session.created) > (60 * 60 * 1000);
const isFinished = !session.running;

if (isOld && isFinished) {
  sessions.delete(sessionId);
}
```

### 5. Use Default Session for Quick Commands

```javascript
// Quick commands don't need named sessions
const sessionId = DEFAULT_SESSION;
```

### 6. Store Sessions Globally

```javascript
// Persist across eval calls
window._terminalSessions = window._terminalSessions || new Map();
```

## Advanced Techniques

### Technique 1: Session Multiplexing

```javascript
// Execute same command in multiple sessions
const sessions = window._terminalSessions || new Map();
const shell = window.foam?.shell;

const command = "npm test";
const envs = ["dev", "staging", "prod"];

for (const env of envs) {
  const sessionId = `test-${env}`;
  const session = {
    id: sessionId,
    env: {NODE_ENV: env},
    output: [],
    running: true
  };

  sessions.set(sessionId, session);

  // Run in each environment
  shell.execLive(`NODE_ENV=${env} ${command}`, {
    stdout: (text) => session.output.push({type: "stdout", text})
  });
}
```

### Technique 2: Session Broadcasting

```javascript
// Broadcast output from one session to multiple watchers
const session = sessions.get("broadcast-session");
const watchers = ["watcher-1", "watcher-2"];

shell.execLive(command, {
  stdout: (text) => {
    // Add to main session
    session.output.push({type: "stdout", text});

    // Broadcast to watchers
    for (const watcherId of watchers) {
      const watcher = sessions.get(watcherId);
      if (watcher) {
        watcher.output.push({type: "broadcast", text, from: session.id});
      }
    }
  }
});
```

### Technique 3: Session Pipelines

```javascript
// Chain commands across sessions
const sessions = new Map();
const shell = window.foam?.shell;

// Session 1: Generate data
const gen = {id: "generate", output: [], running: true};
sessions.set("generate", gen);

shell.execLive("generate-data.sh", {
  stdout: (text) => gen.output.push({type: "stdout", text})
}).then(() => {
  gen.running = false;

  // Session 2: Process data (starts after session 1 completes)
  const proc = {id: "process", output: [], running: true};
  sessions.set("process", proc);

  return shell.execLive("process-data.sh", {
    stdout: (text) => proc.output.push({type: "stdout", text})
  });
}).then(() => {
  const proc = sessions.get("process");
  proc.running = false;
});
```

## Limitations

- Sessions are stored in browser memory (lost on page reload)
- Can't truly background processes (browser OS limitation)
- Process management limited by browser OS shell capabilities
- No true PTY/TTY support
- Output buffering is in-memory only

## Integration with Spirit

Spirit can use sessions to:

1. **Run Tests in Background**: Start test suite, continue with other tasks
2. **Monitor Build Progress**: Track webpack/rollup builds while editing
3. **Parallel Test Execution**: Run tests in multiple environments simultaneously
4. **Log Monitoring**: Watch logs while debugging
5. **CI/CD Simulation**: Run full pipeline steps in parallel sessions

## Examples Repository

See `test-terminal-sessions.sh` for comprehensive examples of:
- Session state management
- Concurrent operations
- Command history
- Output buffering
- Session enumeration
- Default session handling
