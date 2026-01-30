# 🐰 FluffyCoreutils

**Shared Unix coreutils for browser-based virtual operating systems**

A TypeScript library providing 79 essential Unix command-line utilities designed for browser-based virtual filesystems like Foam, Shiro, and Spirit.

## ✨ Features

- 🌐 **Browser-Native**: Pure TypeScript implementation with no Node.js dependencies
- 🔧 **79 Commands**: From `cat` and `ls` to `grep`, `sed`, `awk`, and `make`
- 🎯 **Filesystem Agnostic**: Works with any virtual filesystem implementing the `FluffyFS` interface
- 📦 **Tree-Shakeable**: Import only the commands you need
- 🔒 **Type-Safe**: Full TypeScript definitions included

## 📦 Installation

```bash
npm install fluffycoreutils
```

## 🚀 Quick Start

```typescript
import { ls, cat, grep } from 'fluffycoreutils';

// Use individual commands
const result = await ls.exec(['-la'], { stdin: '', env: {}, cwd: '/', fs: myFS });
console.log(result.stdout);

// Or import all commands
import { allCommands } from 'fluffycoreutils';
const shell = Object.fromEntries(
  Object.entries(allCommands).map(([name, cmd]) => [name, cmd.exec])
);
```

## 📚 Available Commands

### File Operations
- **cat** - Concatenate and print files
- **cp** - Copy files and directories
- **mv** - Move/rename files
- **rm** - Remove files and directories
- **touch** - Create or update file timestamps
- **ln** - Create symbolic links
- **mkdir** - Create directories

### File Inspection
- **ls** - List directory contents
- **less** - View file contents with pagination
- **head** - Output first part of files
- **tail** - Output last part of files
- **wc** - Word, line, and byte count
- **stat** - Display detailed file status
- **file** - Determine file type

### Text Processing
- **awk** - Pattern scanning and text processing
- **grep** - Search text using patterns
- **sed** - Stream editor
- **cut** - Cut out selected portions of lines (-d delimiter, -f fields)
- **paste** - Merge lines of files
- **join** - Join lines based on common field
- **comm** - Compare sorted files line by line
- **sort** - Sort lines of text
- **uniq** - Report or filter repeated lines (enhanced with -i, -f, -s, -w, -u flags)
- **tr** - Translate or delete characters
- **diff** - Compare files line by line
- **fold** - Wrap lines to specified width
- **fmt** - Format text into paragraphs
- **nl** - Number lines of files

### Path Utilities
- **basename** - Strip directory from filename
- **dirname** - Extract directory from path
- **pwd** - Print working directory
- **readlink** - Display symbolic link target
- **realpath** - Print resolved absolute path

### System Info
- **date** - Display date and time (enhanced with format strings, -d, -u)
- **echo** - Display text
- **env** - Display environment variables
- **printenv** - Print all or part of environment
- **hostname** - Show system hostname
- **uname** - Print system information
- **whoami** - Print current user
- **id** - Print user identity

### Utilities
- **find** - Search for files
- **which** - Locate a command in PATH
- **type** - Display command type information
- **seq** - Generate sequences of numbers
- **xargs** - Build and execute commands
- **tee** - Read stdin and write to stdout and files
- **printf** - Format and print data
- **expr** - Evaluate expressions (arithmetic, string, comparison)
- **test** - Evaluate conditions
- **true** / **false** - Return success/failure
- **clear** - Clear the terminal
- **chmod** - Change file permissions
- **touch** - Change file timestamps (enhanced with -c flag)
- **sleep** - Delay for specified time
- **time** - Measure command execution time
- **timeout** - Run command with time limit
- **yes** - Output string repeatedly
- **expand** - Convert tabs to spaces
- **unexpand** - Convert spaces to tabs

### Shell Script Support
- **source** / **.** - Execute commands from a file in the current shell context

### Build & Package Tools
- **make** - Build automation with basic Makefile support
- **patch** - Apply unified diff patches to files
- **install** - Copy files and set attributes
- **base64** - Encode/decode Base64 data
- **md5sum** - Compute MD5 checksums
- **sha256sum** - Compute SHA-256 checksums (uses Web Crypto API)
- **strings** - Extract printable strings from files
- **od** - Octal/hex dump of files
- **hexdump** - Hexadecimal file viewer

### System Management
- **chown** - Change file owner and group (stub for compatibility)
- **du** - Estimate file space usage
- **df** - Report filesystem disk space (stub with mock values)
- **free** - Display memory usage (stub with mock values)
- **uptime** - Show system uptime (mock values for browser)

## 🏗️ Architecture

FluffyCoreutils uses a minimal filesystem abstraction (`FluffyFS`) that your virtual filesystem must implement:

```typescript
interface FluffyFS {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<FluffyEntry[]>;
  stat(path: string): Promise<FluffyStat>;
  exists(path: string): Promise<boolean>;
  unlink(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rmdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  symlink?(target: string, path: string): Promise<void>;
  resolvePath(path: string, cwd: string): string;
}
```

Each command follows the same interface:

```typescript
interface FluffyCommand {
  name: string;
  description: string;
  exec(args: string[], io: CommandIO): Promise<CommandResult>;
}
```

## 🔧 Usage Example

```typescript
import { grep, cat, allCommands } from 'fluffycoreutils';
import type { FluffyFS, CommandIO } from 'fluffycoreutils';

// Implement your virtual filesystem
const myFS: FluffyFS = {
  // ... your filesystem implementation
};

// Execute a command
const io: CommandIO = {
  stdin: '',
  env: { USER: 'alice', HOME: '/home/alice' },
  cwd: '/home/alice',
  fs: myFS
};

const result = await grep.exec(['-r', 'TODO', '.'], io);
console.log(result.stdout);
console.log(`Exit code: ${result.exitCode}`);
```

## 🎯 Use Cases

- **Browser-based IDEs**: Provide shell commands in web-based development environments
- **Educational Tools**: Teach Unix commands in an interactive browser environment
- **Virtual Operating Systems**: Power command-line interfaces in browser-based OS simulations
- **Testing & Simulation**: Simulate Unix environments for testing without actual filesystem access

## 📄 License

MIT

## 🤝 Contributing

Contributions are welcome! This library is designed to be shared across multiple browser-based virtual operating systems.

## 🔗 Related Projects

- **Foam** - Browser-based virtual operating system
- **Shiro** - Browser-based virtual operating system
- **Spirit** - Browser-based virtual operating system
