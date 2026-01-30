# vi Editor Guide

Shiro includes a minimal vi-like modal text editor that runs entirely in the browser terminal.

## Status

⚠️ **Note**: The vi editor has full modal editing logic implemented but requires terminal integration for interactive keyboard input. Currently, it demonstrates the architecture but cannot capture raw terminal input. Use `cat`, `echo`, and shell redirects for file editing until terminal raw mode is implemented.

## Features Implemented

### Modes

- ✅ **Normal Mode** - Navigation and command execution (default)
- ✅ **Insert Mode** - Text insertion and editing
- ✅ **Command Mode** - File operations (:w, :q, :wq, :q!)
- ✅ **Search Mode** - Pattern searching with n/N navigation

### Normal Mode Commands

#### Navigation
- `h` - Move cursor left
- `j` - Move cursor down
- `k` - Move cursor up
- `l` - Move cursor right
- `0` - Jump to start of line
- `$` - Jump to end of line
- `gg` - Go to first line
- `G` - Go to last line

#### Editing
- `i` - Enter insert mode at cursor
- `a` - Enter insert mode after cursor
- `o` - Insert new line below and enter insert mode
- `O` - Insert new line above and enter insert mode
- `x` - Delete character under cursor
- `dd` - Delete current line

#### Search
- `/` - Enter search mode
- `n` - Jump to next search result
- `N` - Jump to previous search result

#### Commands
- `:` - Enter command mode

### Insert Mode

- **ESC** - Return to normal mode
- **Backspace** - Delete character before cursor
- **Enter** - Create new line
- **Any printable character** - Insert at cursor

### Command Mode

- `:w` - Write (save) file
- `:q` - Quit (fails if unsaved changes)
- `:q!` - Quit without saving (discard changes)
- `:wq` - Write and quit
- **ESC** - Cancel command, return to normal mode

### Search Mode

- **Type pattern** - Build search string
- **Enter** - Execute search and jump to first match
- **ESC** - Cancel search, return to normal mode
- **Backspace** - Delete character from search pattern

Search features:
- Forward search with `/pattern`
- Next result with `n`
- Previous result with `N`
- Wrap-around search (continues from start/end of file)
- Pattern persistence (saved between searches)
- Visual feedback for found/not found

## Usage Examples

### Basic Editing Workflow

```bash
# Open a file (or create new)
vi myfile.txt

# In normal mode:
# - Press 'i' to enter insert mode
# - Type your text
# - Press ESC to return to normal mode
# - Type ':w' and Enter to save
# - Type ':q' and Enter to quit

# Full session example:
vi config.txt
i                    # Enter insert mode
Hello, world!        # Type text
<ESC>                # Back to normal mode
:wq                  # Save and quit
```

### Searching

```bash
vi large-file.txt

# Search for "error":
/error<Enter>        # Find first occurrence
n                    # Next match
n                    # Next match
N                    # Previous match

# Search for "function":
/function<Enter>     # New search
n                    # Next occurrence
```

### Navigation

```bash
vi document.txt

gg                   # Jump to top of file
G                    # Jump to bottom
10j                  # Move down 10 lines (if repeat counts implemented)
0                    # Go to start of line
$                    # Go to end of line
```

### Editing

```bash
vi script.sh

i                    # Insert mode
#!/bin/bash         # Type text
<ESC>                # Normal mode
o                    # New line below, insert mode
echo "Hello"         # Type more text
<ESC>                # Normal mode
dd                   # Delete current line
x                    # Delete character
:wq                  # Save and quit
```

## Implementation Details

### Architecture

The vi editor is implemented as a command in `src/commands/vi.ts` with:

- **Modal state machine** - Tracks current mode and transitions
- **Buffer management** - Lines stored as string array
- **Cursor tracking** - Row and column position with bounds checking
- **Command parsing** - Handles : commands and / searches
- **Search engine** - Forward/backward pattern matching with wrap

### State Structure

```typescript
interface EditorState {
  lines: string[];           // File content
  cursorRow: number;         // Current line (0-indexed)
  cursorCol: number;         // Current column (0-indexed)
  mode: Mode;                // Current mode
  commandBuffer: string;     // : command being typed
  searchBuffer: string;      // / search being typed
  searchPattern: string;     // Last completed search
  lastKey: string;           // Previous key (for dd, gg)
  modified: boolean;         // Unsaved changes flag
  scrollOffset: number;      // Viewport scroll position
  message: string;           // Status line message
}
```

### Terminal Integration Needed

The current implementation has full logic but needs:

1. **Raw terminal mode** - Capture individual keystrokes
2. **ANSI escape sequences** - For cursor positioning and screen clearing
3. **Terminal dimensions** - Dynamic viewport sizing
4. **Key event handling** - Map terminal key codes to editor commands

This would require integration with `ShiroTerminal` class to:
- Enter raw mode when vi starts
- Route keypresses to editor instead of shell
- Restore line mode when vi exits

### File I/O

- Reads from virtual filesystem on startup
- Writes to virtual filesystem on `:w`
- Creates new files if they don't exist
- Preserves file content on quit without save

### Search Algorithm

**Forward search (n):**
1. Start from current cursor position + 1
2. Search each line from cursor to end of file
3. If not found, wrap to start and search to cursor
4. Move cursor to match position
5. Display "Found" or "Not found" message

**Backward search (N):**
1. Start from current cursor position - 1
2. Search backward character by character
3. Check each position for pattern match
4. Wrap to end of file if not found
5. Move cursor to match position

## Limitations

### Current Version

- ❌ No interactive keyboard input (needs terminal raw mode)
- ❌ No repeat counts (e.g., `5j`, `10dd`)
- ❌ No visual mode or selection
- ❌ No undo/redo
- ❌ No yank/paste (copy/paste)
- ❌ No marks or jumps
- ❌ No syntax highlighting
- ❌ No line numbers display
- ❌ No multiple buffers
- ❌ No macros or registers

### Workarounds

Until terminal integration is complete, use these alternatives:

**View files:**
```bash
cat file.txt
less file.txt  # if implemented
```

**Edit files:**
```bash
# Append to file
echo "new line" >> file.txt

# Overwrite file
cat > file.txt << 'EOF'
line 1
line 2
EOF

# Edit with sed
sed -i 's/old/new/g' file.txt
```

**Create files:**
```bash
# Simple file
echo "content" > newfile.txt

# Multi-line file
cat > config.json << 'EOF'
{
  "key": "value"
}
EOF
```

## Future Enhancements

### High Priority

1. **Terminal raw mode integration**
   - Capture keystrokes in ShiroTerminal
   - Route to vi editor
   - Handle special keys (arrows, delete, etc.)

2. **Visual feedback**
   - Real-time cursor rendering
   - Mode indicator in status line
   - Line numbers
   - Syntax highlighting for common languages

3. **Additional commands**
   - `u` - Undo
   - `Ctrl+R` - Redo
   - `y` - Yank (copy)
   - `p` - Paste
   - `v` - Visual mode
   - `.` - Repeat last command

### Medium Priority

4. **Enhanced navigation**
   - `w`, `b`, `e` - Word movement
   - `{`, `}` - Paragraph movement
   - `%` - Matching bracket
   - `f`, `t` - Find character in line
   - `*`, `#` - Search word under cursor

5. **Advanced editing**
   - `c` - Change (delete and insert)
   - `r` - Replace character
   - `J` - Join lines
   - `>>`, `<<` - Indent/unindent
   - `=` - Auto-indent

6. **Search enhancements**
   - Regex patterns
   - Case-insensitive search (`/pattern/i`)
   - Replace (`:s/old/new/g`)
   - Highlight matches
   - Search history

### Low Priority

7. **Multiple files**
   - `:e filename` - Open different file
   - `:n`, `:p` - Next/previous buffer
   - Split windows

8. **Advanced features**
   - Macros (`q`, `@`)
   - Marks (`m`, `'`)
   - Registers (`"a-z`)
   - Ex commands (`:!shell`)

## Testing

Since interactive vi isn't fully functional yet, test the logic with:

```bash
# Test file creation
vi test.txt
# (Would enter insert mode, type text, save)

# For now, use shell commands:
echo "test content" > test.txt
cat test.txt
```

When terminal integration is complete:

```bash
# Basic edit test
vi README.md
i
# Type some text
<ESC>
:wq

# Search test
vi large-file.log
/ERROR
n
n
:q

# Edit workflow test
vi script.sh
i
#!/bin/bash
echo "Hello"
<ESC>
dd
o
echo "World"
<ESC>
:wq
```

## Architecture Diagram

```
┌─────────────────────────────────────┐
│         ShiroTerminal               │
│  (needs raw mode integration)       │
└──────────────┬──────────────────────┘
               │ keypress events
               ▼
┌─────────────────────────────────────┐
│           vi Command                │
│                                     │
│  ┌──────────────────────────────┐  │
│  │      EditorState             │  │
│  │  - lines[]                   │  │
│  │  - cursor position           │  │
│  │  - mode (normal/insert/...)  │  │
│  │  - search pattern            │  │
│  └──────────────────────────────┘  │
│                                     │
│  ┌──────────────────────────────┐  │
│  │   Mode Handlers              │  │
│  │  - handleNormalMode()        │  │
│  │  - handleInsertMode()        │  │
│  │  - handleCommandMode()       │  │
│  │  - handleSearchMode()        │  │
│  └──────────────────────────────┘  │
│                                     │
│  ┌──────────────────────────────┐  │
│  │   Search Functions           │  │
│  │  - searchNext()              │  │
│  │  - searchPrevious()          │  │
│  └──────────────────────────────┘  │
└──────────────┬──────────────────────┘
               │ file I/O
               ▼
┌─────────────────────────────────────┐
│      Virtual FileSystem             │
│  (IndexedDB-backed)                 │
└─────────────────────────────────────┘
```

## Conclusion

Shiro's vi editor provides a solid foundation for terminal-based text editing with:
- Complete modal editing logic
- Full search functionality with wrap-around
- File I/O integration with virtual filesystem
- Clean state management and mode handling

The architecture is ready for terminal integration to enable full interactive editing in the browser!
