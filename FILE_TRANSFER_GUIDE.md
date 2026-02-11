# File Transfer Guide - Skyeyes

Complete guide for transferring files between host and browser OS (Shiro/Foam) using Skyeyes.

## Overview

Skyeyes provides bidirectional file transfer capabilities:
- **Upload**: Transfer files from host to browser OS virtual filesystem (VFS)
- **Download**: Transfer files from browser OS to host
- **Encoding**: Base64 encoding for binary data over WebSocket
- **VFS Integration**: Works with Shiro and Foam virtual filesystems

## Prerequisites

- Nimbus server running with Skyeyes bridges
- Browser OS (Shiro or Foam) with VFS initialized
- Page must have `window.shiro?.vfs` or `window.foam?.shell?.vfs` available

## Upload Files to Browser OS

Upload files from host machine to the browser OS virtual filesystem.

### Method 1: Direct VFS Write via Eval (Recommended)

```bash
# Upload text file
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const vfs = window.foam?.shell?.vfs; vfs.writeFile(\"/home/user/test.txt\", \"Hello from host!\"); return {success: true, path: \"/home/user/test.txt\"};"
  }'
```

### Method 2: Upload with Base64 Encoding (for binary files)

```bash
# Encode file on host
FILE_CONTENT=$(base64 -w 0 /path/to/binary/file.png)

# Upload to browser OS
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d "{
    \"code\": \"const vfs = window.foam?.shell?.vfs; const decoded = atob('$FILE_CONTENT'); vfs.writeFile('/home/user/file.png', decoded); return {success: true};\"
  }"
```

### Method 3: Upload JSON/Structured Data

```bash
# Upload JSON configuration
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const vfs = window.foam?.shell?.vfs; const config = {api_key: \"test\", enabled: true}; vfs.writeFile(\"/home/user/config.json\", JSON.stringify(config, null, 2)); return {success: true};"
  }'
```

## Download Files from Browser OS

Download files from browser OS to host machine.

### Method 1: Direct VFS Read via Eval

```bash
# Download text file
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const vfs = window.foam?.shell?.vfs; const content = vfs.readFile(\"/home/user/test.txt\"); return {content, size: content.length};"
  }' | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.loads(d['result'])['content'])"
```

### Method 2: Download with Base64 Encoding (for binary files)

```bash
# Download and decode binary file
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const vfs = window.foam?.shell?.vfs; const content = vfs.readFile(\"/home/user/file.png\"); const encoded = btoa(content); return {content: encoded, encoding: \"base64\"};"
  }' | python3 -c "import sys,json,base64; d=json.load(sys.stdin); r=json.loads(d['result']); open('downloaded.png', 'wb').write(base64.b64decode(r['content']))"
```

### Method 3: Download JSON/Structured Data

```bash
# Download and parse JSON
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const vfs = window.foam?.shell?.vfs; const content = vfs.readFile(\"/home/user/config.json\"); const parsed = JSON.parse(content); return {data: parsed};"
  }' | python3 -m json.tool
```

## Advanced Usage

### Check VFS Availability

```bash
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "return {hasVFS: !!(window.foam?.shell?.vfs || window.shiro?.vfs), type: window.foam ? \"foam\" : \"shiro\"};"
  }'
```

### List Directory Contents

```bash
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const vfs = window.foam?.shell?.vfs; const entries = vfs.readdir(\"/home/user\"); return {count: entries.length, entries: entries.map(e => ({name: e.name, type: e.type}))};"
  }'
```

### Create Directory

```bash
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const vfs = window.foam?.shell?.vfs; vfs.mkdir(\"/home/user/project\"); return {success: true, path: \"/home/user/project\"};"
  }'
```

### Check File Existence

```bash
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const vfs = window.foam?.shell?.vfs; try { vfs.readFile(\"/home/user/test.txt\"); return {exists: true}; } catch (err) { return {exists: false, error: err.message}; }"
  }'
```

### Delete File

```bash
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const vfs = window.foam?.shell?.vfs; vfs.unlink(\"/home/user/test.txt\"); return {deleted: true};"
  }'
```

### Get File Stats

```bash
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const vfs = window.foam?.shell?.vfs; const content = vfs.readFile(\"/home/user/test.txt\"); return {size: content.length, type: typeof content};"
  }'
```

## Base64 Encoding/Decoding

### Encode Binary Data (Host Side)

```bash
# Linux/Mac
base64 -w 0 input.bin > output.b64
FILE_CONTENT=$(cat output.b64)

# Or inline
FILE_CONTENT=$(base64 -w 0 input.bin)
```

### Decode Binary Data (Browser Side)

```javascript
const vfs = window.foam?.shell?.vfs;
const base64Content = "SGVsbG8gV29ybGQh"; // Base64 encoded data
const decoded = atob(base64Content);
vfs.writeFile("/home/user/file.bin", decoded);
```

### Encode for Download (Browser Side)

```javascript
const vfs = window.foam?.shell?.vfs;
const content = vfs.readFile("/home/user/file.bin");
const encoded = btoa(content);
return {content: encoded, encoding: "base64"};
```

### Decode on Host (Python)

```python
import base64
import json

# Parse response
response = json.loads(response_json)
result = json.loads(response['result'])

# Decode base64 content
decoded = base64.b64decode(result['content'])

# Write to file
with open('output.bin', 'wb') as f:
    f.write(decoded)
```

## Batch File Operations

### Upload Multiple Files

```bash
# Upload several files at once
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const vfs = window.foam?.shell?.vfs; const files = {\"file1.txt\": \"Content 1\", \"file2.txt\": \"Content 2\", \"file3.txt\": \"Content 3\"}; const results = []; for (const [name, content] of Object.entries(files)) { vfs.writeFile(\"/home/user/\" + name, content); results.push({file: name, success: true}); } return {count: results.length, results};"
  }'
```

### Download Multiple Files

```bash
# Download several files
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const vfs = window.foam?.shell?.vfs; const files = [\"file1.txt\", \"file2.txt\", \"file3.txt\"]; const results = {}; for (const name of files) { try { results[name] = vfs.readFile(\"/home/user/\" + name); } catch (err) { results[name] = {error: err.message}; } } return results;"
  }'
```

## Error Handling

### Robust Upload with Error Handling

```javascript
const vfs = window.foam?.shell?.vfs;

if (!vfs) {
  return {error: "VFS not available"};
}

try {
  // Resolve path (handles ~ expansion, relative paths)
  const resolvedPath = vfs.resolvePath("~/myfile.txt");

  // Write file
  vfs.writeFile(resolvedPath, "File content here");

  // Verify write
  const content = vfs.readFile(resolvedPath);

  return {
    success: true,
    path: resolvedPath,
    size: content.length,
    verified: content === "File content here"
  };
} catch (err) {
  return {
    success: false,
    error: err.message,
    stack: err.stack
  };
}
```

### Robust Download with Error Handling

```javascript
const vfs = window.foam?.shell?.vfs;

if (!vfs) {
  return {error: "VFS not available"};
}

try {
  const path = "/home/user/data.json";

  // Check if file exists
  let content;
  try {
    content = vfs.readFile(path);
  } catch (err) {
    return {error: "File not found", path};
  }

  // Determine encoding
  const isBinary = content.some && content.some(byte => byte === 0);
  const encoding = isBinary ? "base64" : "utf8";

  return {
    success: true,
    path,
    content: isBinary ? btoa(content) : content,
    encoding,
    size: content.length
  };
} catch (err) {
  return {
    success: false,
    error: err.message
  };
}
```

## Use Cases

### 1. Deploy Code to Browser OS

```bash
# Upload a JavaScript file for testing
CODE=$(cat script.js)
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d "{
    \"code\": \"const vfs = window.foam?.shell?.vfs; vfs.writeFile('/home/user/script.js', $(echo "$CODE" | jq -Rs .)); return {deployed: true};\"
  }"
```

### 2. Extract Test Results

```bash
# Run tests and download results
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const vfs = window.foam?.shell?.vfs; const results = {passed: 10, failed: 2, tests: []}; vfs.writeFile(\"/home/user/test-results.json\", JSON.stringify(results)); const saved = vfs.readFile(\"/home/user/test-results.json\"); return {saved: JSON.parse(saved)};"
  }'
```

### 3. Configuration Management

```bash
# Upload config
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const vfs = window.foam?.shell?.vfs; const config = {theme: \"dark\", fontSize: 14}; vfs.writeFile(\"/home/user/.config/app.json\", JSON.stringify(config, null, 2)); return {configured: true};"
  }'

# Download config
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const vfs = window.foam?.shell?.vfs; const raw = vfs.readFile(\"/home/user/.config/app.json\"); return {config: JSON.parse(raw)};"
  }'
```

### 4. Backup Files

```bash
# Backup entire directory
curl -X POST http://localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "const vfs = window.foam?.shell?.vfs; const entries = vfs.readdir(\"/home/user/project\"); const backup = {}; for (const e of entries) { if (e.type === \"file\") { backup[e.name] = vfs.readFile(\"/home/user/project/\" + e.name); } } return {files: Object.keys(backup).length, backup};"
  }'
```

## Best Practices

1. **Always check VFS availability** before operations
2. **Use try/catch** for robust error handling
3. **Resolve paths** with `vfs.resolvePath()` to handle ~ and relative paths
4. **Verify writes** by reading back the content
5. **Use Base64** for binary files to avoid encoding issues
6. **Limit file sizes** for large transfers (chunk if needed)
7. **Clean up** temporary files after operations
8. **Check file existence** before reading to handle missing files gracefully

## Limitations

- File transfer happens through eval (no direct WebSocket message type yet)
- Large files may impact performance (consider chunking >1MB files)
- Binary detection is basic (checks for null bytes)
- VFS must be initialized and available in the page context
- Works only with Shiro and Foam browser OS (requires VFS)

## Troubleshooting

### "No VFS available"
- Ensure you're targeting a Shiro or Foam page
- Check that the VFS is initialized: `window.foam?.shell?.vfs` or `window.shiro?.vfs`
- Try reloading the page

### "File not found"
- Verify the path is correct
- Use absolute paths or resolve with `vfs.resolvePath()`
- Check directory exists with `vfs.readdir(parentDir)`

### "Binary encoding issues"
- Always use Base64 for binary files
- Use `btoa()` to encode, `atob()` to decode
- Check for null bytes to detect binary content

### "Large file timeout"
- Increase timeout in eval command
- Consider chunking files >1MB
- Use batch operations for multiple small files

## Examples Repository

See `test-file-transfer.sh` for comprehensive examples of:
- VFS availability checks
- Text file read/write
- Base64 encoding/decoding
- Path resolution
- Error handling
- UTF-8 support
- JSON file handling
- Large file operations
