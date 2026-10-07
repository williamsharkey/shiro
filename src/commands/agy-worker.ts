/// <reference lib="webworker" />
const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.27.2/full';

self.onmessage = async (e) => {
  const { type, sab, args, cwd } = e.data;
  if (type === 'init') {
    const int32_arr = new Int32Array(sab); self.int32_arr = int32_arr;
    const textBuffer = new Uint8Array(sab, 16, sab.byteLength - 16); self.textBuffer = textBuffer;
    
    // Load Pyodide
    let loadPyodide;
    let pyodideOptions = {};
    
    try {
      const mod = await import(PYODIDE_CDN + '/pyodide.mjs');
      loadPyodide = mod.loadPyodide || mod.default?.loadPyodide;
      pyodideOptions = { indexURL: PYODIDE_CDN };
    } catch (err) {
      console.log("[Worker] Falling back to node pyodide:", err.message);
      const mod = await import(/* @vite-ignore */ 'pyodide');
      loadPyodide = mod.loadPyodide || mod.default?.loadPyodide;
    }
    
    const pyodide = await loadPyodide({ ...pyodideOptions, stdout: (msg) => console.log("[Pyodide stdout]", msg), stderr: (msg) => console.error("[Pyodide stderr]", msg) });
    
    
    // Populate FileSystem
    if (e.data.files) {
      for (const [path, content] of Object.entries(e.data.files)) {
        // Create directories if they don't exist
        const parts = path.split('/').filter(Boolean);
        let curr = '/';
        for (let i = 0; i < parts.length - 1; i++) {
          curr += parts[i] + '/';
          try {
            pyodide.FS.mkdir(curr);
          } catch (e) {
            // Ignore if exists
          }
        }
        try { pyodide.FS.writeFile(path, content as Uint8Array); } catch(e) { console.log("Failed to write", path); }
      }
    }
    
    // Set cwd
    if (cwd) {
      try {
        pyodide.FS.chdir(cwd);
      } catch (e) {
        console.log("Could not chdir to", cwd);
      }
    }

    // Patch subprocess using python
    pyodide.runPython(`
import sys
import json
from js import postMessage, Int32Array, Uint8Array, Atomics, int32_arr, textBuffer
import time

class DummyCompletedProcess:
    def __init__(self, args, returncode, stdout, stderr):
        self.args = args
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr

def sync_exec(cmd_args):
    # Send message to main thread
    msg = json.dumps({"type": "exec", "args": cmd_args})
    postMessage(msg)
    
    # Wait until main thread sets it to 1
    while True:
        res = Atomics.wait(int32_arr, 0, 0)
        if int32_arr[0] == 1:
            break
            
    # Read result from textBuffer
    exit_code = int32_arr[1]
    out_len = int32_arr[2]
    err_len = int32_arr[3]
    
    # Read bytes from textBuffer
    all_bytes = textBuffer.to_bytes()
    out_bytes = all_bytes[0:out_len]
    err_bytes = all_bytes[out_len:out_len+err_len]
    
    # Reset for next call
    int32_arr[0] = 0
    
    return DummyCompletedProcess(cmd_args, exit_code, out_bytes, err_bytes)
import subprocess
subprocess.run = sync_exec
subprocess.Popen = lambda *a, **kw: None
`);
    
try {
        if (args && args.length > 0) {
            const scriptPath = args[0];
            const scriptContent = pyodide.FS.readFile(scriptPath, { encoding: 'utf8' });
            pyodide.runPython(scriptContent);
        } else {
            pyodide.runPython(`
import subprocess
import os
print("CWD:", os.getcwd())
print("Files:", os.listdir("."))
result = subprocess.run(["ls", "-la"])
print("ls -la stdout:", result.stdout.decode('utf-8'))
`);
        }
        postMessage(JSON.stringify({ type: 'done', code: 0 }));
    } catch (err: any) {
        postMessage(JSON.stringify({ type: 'error', error: err.message }));
    }
  }
};
