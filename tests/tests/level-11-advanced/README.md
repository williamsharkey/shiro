# Level 11: Advanced Command Tests

Tests for advanced Foam-specific commands that extend beyond standard coreutils.

## Commands Tested

### File Operations
| Command | Description | Example |
|---------|-------------|---------|
| `glob` | Pattern matching | `glob "*.txt" /path` |
| `less` / `more` | File pager | `less file.txt` |
| `ed` | Line editor | `ed file.txt 1s/old/new/ w` |

### Shell Builtins
| Command | Description | Example |
|---------|-------------|---------|
| `source` / `.` | Source script file | `source setup.sh` |
| `type` | Identify command type | `type echo` |
| `which` | Find command path | `which cat` |
| `unset` | Unset environment var | `unset MYVAR` |
| `read` | Read input to variable | `read MYVAR` |
| `help` | Show available commands | `help` |

### Pipeline Tools
| Command | Description | Example |
|---------|-------------|---------|
| `xargs` | Build args from stdin | `find . | xargs rm` |
| `xargs -I` | Replace placeholder | `xargs -I {} echo "{}"` |

### Build Tools
| Command | Description | Example |
|---------|-------------|---------|
| `make` | Run Makefile targets | `make build` |
| `make -f` | Use custom Makefile | `make -f Build.mk` |

### Test Operators
| Operator | Description | Example |
|----------|-------------|---------|
| `-e` | File exists | `test -e file.txt` |
| `-z` | String is empty | `test -z ""` |
| `-a` | Logical AND | `test A -a B` |
| `-o` | Logical OR | `test A -o B` |
| `-le` | Less or equal | `test 1 -le 2` |
| `-ge` | Greater or equal | `test 2 -ge 1` |

## Test Coverage

- **glob**: Basic patterns, recursive (`**`), no matches
- **source**: Script execution, dot alias, comment handling
- **type/which**: Builtin detection, path lookup, not found
- **unset**: Variable removal verification
- **xargs**: Basic, `-I` replace mode
- **less/more**: File reading, `-N` line numbers, piped input
- **make**: Basic targets, dependencies, default target, errors
- **ed**: Print, numbered, change, substitute, search, write
- **test**: File operators, string operators, logical operators

## Running Tests

```bash
# Run all tests including level-11
npm test

# Or specifically with linkedom
npm run test:linkedom
```

## Notes

- These tests work in linkedom mode (no real browser needed)
- Some commands (like `read`) have limited testing due to subshell behavior
- `make` tests use simple Makefiles with echo commands
