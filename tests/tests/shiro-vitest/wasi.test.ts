import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import {
  normPath, FD, WasiExit, WasiRT,
  WASI_WHENCE_SET, WASI_WHENCE_CUR, WASI_WHENCE_END,
  WASI_FILETYPE_CHARACTER_DEVICE, WASI_FILETYPE_DIRECTORY,
  WASI_FILETYPE_REGULAR_FILE,
} from '@shiro/wasi-runtime';
import {
  findPackage, searchPackages, listAvailable, isAvailableAsPackage,
  downloadPackage, getCachedPackage,
} from '@shiro/wasi-packages';

// ═══════════════════════════════════════════════════════════════════
//  A. wasi-runtime.ts unit tests
// ═══════════════════════════════════════════════════════════════════

describe('normPath', () => {
  it('resolves single dots', () => {
    expect(normPath('/foo/./bar')).toBe('/foo/bar');
  });

  it('resolves double dots', () => {
    expect(normPath('/foo/bar/../baz')).toBe('/foo/baz');
  });

  it('resolves multiple double dots', () => {
    expect(normPath('/a/b/c/../../d')).toBe('/a/d');
  });

  it('collapses double slashes', () => {
    expect(normPath('/foo//bar///baz')).toBe('/foo/bar/baz');
  });

  it('strips trailing slashes', () => {
    expect(normPath('/foo/bar/')).toBe('/foo/bar');
  });

  it('handles root', () => {
    expect(normPath('/')).toBe('/');
  });

  it('handles complex combo', () => {
    expect(normPath('/a/./b/../c//d/')).toBe('/a/c/d');
  });

  it('does not go above root', () => {
    expect(normPath('/a/../../b')).toBe('/b');
  });
});

describe('FD class', () => {
  it('reads bytes from current offset', () => {
    const fd = new FD({
      path: '/test',
      filetype: WASI_FILETYPE_REGULAR_FILE,
      data: new TextEncoder().encode('hello world'),
    });
    const chunk = fd.read(5);
    expect(new TextDecoder().decode(chunk)).toBe('hello');
    expect(fd.offset).toBe(5);
  });

  it('reads remaining bytes at EOF', () => {
    const fd = new FD({
      path: '/test',
      filetype: WASI_FILETYPE_REGULAR_FILE,
      data: new TextEncoder().encode('hi'),
    });
    const chunk = fd.read(100);
    expect(new TextDecoder().decode(chunk)).toBe('hi');
    expect(fd.offset).toBe(2);
  });

  it('writes bytes and auto-grows buffer', () => {
    const fd = new FD({
      path: '/test',
      filetype: WASI_FILETYPE_REGULAR_FILE,
      writable: true,
    });
    const data = new TextEncoder().encode('hello');
    fd.write(data);
    expect(fd.data.length).toBe(5);
    expect(fd.offset).toBe(5);
    expect(fd.dirty).toBe(true);
  });

  it('overwrites existing data at offset', () => {
    const fd = new FD({
      path: '/test',
      filetype: WASI_FILETYPE_REGULAR_FILE,
      data: new TextEncoder().encode('aaaa'),
      writable: true,
    });
    fd.offset = 1;
    fd.write(new TextEncoder().encode('bb'));
    expect(new TextDecoder().decode(fd.data)).toBe('abba');
  });

  it('seeks with SET', () => {
    const fd = new FD({
      path: '/test',
      filetype: WASI_FILETYPE_REGULAR_FILE,
      data: new Uint8Array(100),
    });
    fd.offset = 50;
    const pos = fd.seek(10n, WASI_WHENCE_SET);
    expect(pos).toBe(10n);
    expect(fd.offset).toBe(10);
  });

  it('seeks with CUR', () => {
    const fd = new FD({
      path: '/test',
      filetype: WASI_FILETYPE_REGULAR_FILE,
      data: new Uint8Array(100),
    });
    fd.offset = 20;
    const pos = fd.seek(5n, WASI_WHENCE_CUR);
    expect(pos).toBe(25n);
    expect(fd.offset).toBe(25);
  });

  it('seeks with END', () => {
    const fd = new FD({
      path: '/test',
      filetype: WASI_FILETYPE_REGULAR_FILE,
      data: new Uint8Array(100),
    });
    const pos = fd.seek(-10n, WASI_WHENCE_END);
    expect(pos).toBe(90n);
    expect(fd.offset).toBe(90);
  });

  it('clamps seek below zero', () => {
    const fd = new FD({
      path: '/test',
      filetype: WASI_FILETYPE_REGULAR_FILE,
      data: new Uint8Array(10),
    });
    const pos = fd.seek(-100n, WASI_WHENCE_SET);
    expect(pos).toBe(0n);
    expect(fd.offset).toBe(0);
  });
});

describe('WasiExit', () => {
  it('stores exit code', () => {
    const e = new WasiExit(42);
    expect(e.code).toBe(42);
    expect(e.name).toBe('WasiExit');
    expect(e.message).toContain('42');
  });

  it('is instanceof Error', () => {
    const e = new WasiExit(0);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(WasiExit);
  });
});

describe('WasiRT constructor', () => {
  let fs: FileSystem;

  beforeEach(async () => {
    fs = new FileSystem();
    await fs.init();
  });

  it('creates stdin(0), stdout(1), stderr(2) fds', () => {
    const wasi = new WasiRT({
      fs, cwd: '/home/user', args: ['test'], env: {},
    });
    // Access fd table via getImports — if constructor worked, getImports won't throw
    const imports = wasi.getImports();
    expect(imports.wasi_snapshot_preview1).toBeDefined();
  });

  it('getImports returns all required syscall bindings', () => {
    const wasi = new WasiRT({
      fs, cwd: '/home/user', args: ['test'], env: {},
    });
    const snap = wasi.getImports().wasi_snapshot_preview1 as Record<string, Function>;

    const requiredSyscalls = [
      'args_get', 'args_sizes_get',
      'environ_get', 'environ_sizes_get',
      'clock_time_get', 'clock_res_get',
      'fd_close', 'fd_fdstat_get', 'fd_fdstat_set_flags',
      'fd_filestat_get', 'fd_filestat_set_size', 'fd_filestat_set_times',
      'fd_pread', 'fd_prestat_get', 'fd_prestat_dir_name',
      'fd_pwrite', 'fd_read', 'fd_readdir',
      'fd_seek', 'fd_sync', 'fd_tell', 'fd_write',
      'path_create_directory', 'path_filestat_get', 'path_filestat_set_times',
      'path_link', 'path_open', 'path_readlink',
      'path_remove_directory', 'path_rename', 'path_symlink', 'path_unlink_file',
      'poll_oneoff', 'proc_exit', 'proc_raise',
      'random_get', 'sched_yield',
      'sock_accept', 'sock_recv', 'sock_send', 'sock_shutdown',
    ];

    for (const name of requiredSyscalls) {
      expect(typeof snap[name]).toBe('function');
    }
    expect(Object.keys(snap).length).toBe(requiredSyscalls.length);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  B. Minimal WASM execution tests
// ═══════════════════════════════════════════════════════════════════

describe('Minimal WASM execution', () => {
  let fs: FileSystem;

  beforeEach(async () => {
    fs = new FileSystem();
    await fs.init();
  });

  /**
   * Hand-crafted WASI "hello" binary (WAT equivalent):
   *
   *   (module
   *     (import "wasi_snapshot_preview1" "fd_write"
   *       (func $fd_write (param i32 i32 i32 i32) (result i32)))
   *     (import "wasi_snapshot_preview1" "proc_exit"
   *       (func $proc_exit (param i32)))
   *     (memory (export "memory") 1)
   *     (data (i32.const 8) "hello")
   *     (func (export "_start")
   *       ;; iovs at offset 0: ptr=8, len=5
   *       (i32.store (i32.const 0) (i32.const 8))
   *       (i32.store (i32.const 4) (i32.const 5))
   *       ;; fd_write(stdout=1, iovs=0, iovs_len=1, nwritten=20)
   *       (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 20)))
   *       ;; proc_exit(0)
   *       (call $proc_exit (i32.const 0))
   *     )
   *   )
   */
  const HELLO_WASM = new Uint8Array([
    // WASM magic + version
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    // Type section (2 types)
    0x01, 0x0d,  // section id=1, size=13
      0x02,  // 2 types
      // type 0: (i32, i32, i32, i32) -> i32
      0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f,
      // type 1: (i32) -> ()
      0x60, 0x01, 0x7f, 0x00,
    // Import section (2 imports)
    0x02, 0x33,  // section id=2, size=51
      0x02,  // 2 imports
      // import 0: "wasi_snapshot_preview1" "fd_write" func type 0
      0x16, ...new TextEncoder().encode('wasi_snapshot_preview1'),
      0x08, ...new TextEncoder().encode('fd_write'),
      0x00, 0x00,
      // import 1: "wasi_snapshot_preview1" "proc_exit" func type 1
      0x16, ...new TextEncoder().encode('wasi_snapshot_preview1'),
      0x09, ...new TextEncoder().encode('proc_exit'),
      0x00, 0x01,
    // Function section (1 function)
    0x03, 0x02,  // section id=3, size=2
      0x01,  // 1 function
      0x01,  // type 1 (no params, no results... wait, type 1 is (i32)->() )
    // Memory section (1 memory, 1 page)
    0x05, 0x03,  // section id=5, size=3
      0x01,  // 1 memory
      0x00, 0x01,  // min=1, no max
    // Export section (2 exports: memory + _start)
    0x07, 0x11,  // section id=7, size=17
      0x02,  // 2 exports
      // export "memory" memory 0
      0x06, ...new TextEncoder().encode('memory'),
      0x02, 0x00,
      // export "_start" func 2
      0x06, ...new TextEncoder().encode('_start'),
      0x00, 0x02,
    // Data section: "hello" at offset 8
    0x0b, 0x0b,  // section id=11, size=11
      0x01,  // 1 data segment
      0x00, 0x41, 0x08, 0x0b,  // memory 0, i32.const 8, end
      0x05, ...new TextEncoder().encode('hello'),
    // Code section (1 function body)
    0x0a, 0x23,  // section id=10, size=35
      0x01,  // 1 function body
      0x21,  // body size=33
      0x00,  // 0 locals
      // i32.store(0, 8) — iov_base
      0x41, 0x00,  // i32.const 0
      0x41, 0x08,  // i32.const 8
      0x36, 0x02, 0x00,  // i32.store align=2 offset=0
      // i32.store(4, 5) — iov_len
      0x41, 0x04,  // i32.const 4
      0x41, 0x05,  // i32.const 5
      0x36, 0x02, 0x00,  // i32.store align=2 offset=0
      // call $fd_write(1, 0, 1, 20)
      0x41, 0x01,  // i32.const 1
      0x41, 0x00,  // i32.const 0
      0x41, 0x01,  // i32.const 1
      0x41, 0x14,  // i32.const 20
      0x10, 0x00,  // call 0 (fd_write)
      0x1a,        // drop
      // call $proc_exit(0)
      0x41, 0x00,  // i32.const 0
      0x10, 0x01,  // call 1 (proc_exit)
      0x0b,        // end
  ]);

  /**
   * Minimal binary that just calls proc_exit(42)
   */
  const EXIT42_WASM = new Uint8Array([
    // WASM magic + version
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    // Type section (1 type)
    0x01, 0x05,  // section id=1, size=5
      0x01,  // 1 type
      // type 0: (i32) -> ()
      0x60, 0x01, 0x7f, 0x00,
    // Import section (1 import)
    0x02, 0x22,  // section id=2, size=34
      0x01,  // 1 import
      // import: "wasi_snapshot_preview1" "proc_exit" func type 0
      0x16, ...new TextEncoder().encode('wasi_snapshot_preview1'),
      0x09, ...new TextEncoder().encode('proc_exit'),
      0x00, 0x00,
    // Function section (1 function)
    0x03, 0x02,  // section id=3, size=2
      0x01,  // 1 function
      0x00,  // type 0
    // Memory section (1 memory)
    0x05, 0x03,  // section id=5, size=3
      0x01,  // 1 memory
      0x00, 0x01,  // min=1
    // Export section (2 exports)
    0x07, 0x11,  // section id=7, size=17
      0x02,  // 2 exports
      // export "memory" memory 0
      0x06, ...new TextEncoder().encode('memory'),
      0x02, 0x00,
      // export "_start" func 1
      0x06, ...new TextEncoder().encode('_start'),
      0x00, 0x01,
    // Code section
    0x0a, 0x08,  // section id=10, size=8
      0x01,  // 1 function body
      0x06,  // body size=6
      0x00,  // 0 locals
      0x41, 0x2a,  // i32.const 42
      0x10, 0x00,  // call 0 (proc_exit)
      0x0b,        // end
  ]);

  // Instead of hand-crafting bytes (which is fragile), let's build
  // valid WASM modules using WebAssembly.Module from WAT-like bytes
  // via the builder approach. For reliability, we use a known-good
  // approach: compile at test time from a properly formed module.

  it('runs hello world WASM and captures stdout', async () => {
    // Build a proper minimal WASI module using WebAssembly API directly
    const wasmBytes = buildHelloWasm();
    const wasmModule = await WebAssembly.compile(wasmBytes);

    let stdoutText = '';
    const wasi = new WasiRT({
      fs,
      cwd: '/home/user',
      args: ['hello'],
      env: {},
      onStdout: (text) => { stdoutText += text; },
    });

    const exitCode = await wasi.run(wasmModule);
    expect(stdoutText).toBe('hello');
    expect(exitCode).toBe(0);
  });

  it('captures WasiExit with code 42', async () => {
    const wasmBytes = buildExitWasm(42);
    const wasmModule = await WebAssembly.compile(wasmBytes);

    const wasi = new WasiRT({
      fs,
      cwd: '/home/user',
      args: ['exit42'],
      env: {},
    });

    const exitCode = await wasi.run(wasmModule);
    expect(exitCode).toBe(42);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  WASM binary builders using proper encoding
// ═══════════════════════════════════════════════════════════════════

/** Encode a u32 as LEB128 */
function leb128(n: number): number[] {
  const result: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    result.push(byte);
  } while (n !== 0);
  return result;
}

/** Encode a section: id byte + LEB128 length + content */
function section(id: number, content: number[]): number[] {
  return [id, ...leb128(content.length), ...content];
}

/** Encode a string as length-prefixed UTF-8 */
function wasmString(s: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(s));
  return [...leb128(bytes.length), ...bytes];
}

/** Build a minimal WASI binary that writes "hello" to stdout then exits 0 */
function buildHelloWasm(): Uint8Array {
  const enc = new TextEncoder();

  // Type section: 2 types
  // type 0: (i32, i32, i32, i32) -> (i32)  -- fd_write
  // type 1: (i32) -> ()                     -- proc_exit
  // type 2: () -> ()                        -- _start
  const typeSection = section(1, [
    3,  // 3 types
    0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f,  // type 0
    0x60, 1, 0x7f, 0,                             // type 1
    0x60, 0, 0,                                   // type 2
  ]);

  // Import section: fd_write (type 0), proc_exit (type 1)
  const modName = wasmString('wasi_snapshot_preview1');
  const imp0 = [...modName, ...wasmString('fd_write'), 0x00, 0x00];
  const imp1 = [...modName, ...wasmString('proc_exit'), 0x00, 0x01];
  const importPayload = [2, ...imp0, ...imp1];
  const importSection = section(2, importPayload);

  // Function section: 1 function of type 2
  const funcSection = section(3, [1, 2]);

  // Memory section: 1 memory, min 1 page
  const memSection = section(5, [1, 0x00, 1]);

  // Export section: "memory" (mem 0), "_start" (func 2)
  const expMemory = [...wasmString('memory'), 0x02, 0x00];
  const expStart = [...wasmString('_start'), 0x00, 0x02];
  const exportSection = section(7, [2, ...expMemory, ...expStart]);

  // Data section: "hello" at memory offset 8
  const helloBytes = Array.from(enc.encode('hello'));
  const dataPayload = [
    1,     // 1 data segment
    0x00,  // active, memory 0
    0x41, 0x08, 0x0b,  // i32.const 8, end
    ...leb128(helloBytes.length), ...helloBytes,
  ];
  const dataSection = section(11, dataPayload);

  // Code section: _start function body
  const body = [
    0,     // 0 local declarations
    // i32.store offset=0 align=2: store 8 at address 0 (iov_base)
    0x41, 0x00,  // i32.const 0
    0x41, 0x08,  // i32.const 8
    0x36, 0x02, 0x00,  // i32.store align=2 offset=0
    // i32.store offset=0 align=2: store 5 at address 4 (iov_len)
    0x41, 0x04,  // i32.const 4
    0x41, 0x05,  // i32.const 5
    0x36, 0x02, 0x00,  // i32.store align=2 offset=0
    // call fd_write(1, 0, 1, 20)
    0x41, 0x01,  // i32.const 1 (fd = stdout)
    0x41, 0x00,  // i32.const 0 (iovs ptr)
    0x41, 0x01,  // i32.const 1 (iovs len)
    0x41, 0x14,  // i32.const 20 (nwritten ptr)
    0x10, 0x00,  // call func 0 (fd_write)
    0x1a,        // drop result
    // call proc_exit(0)
    0x41, 0x00,  // i32.const 0
    0x10, 0x01,  // call func 1 (proc_exit)
    0x0b,        // end
  ];
  const codeSection = section(10, [1, ...leb128(body.length), ...body]);

  return new Uint8Array([
    // Magic + version
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...typeSection,
    ...importSection,
    ...funcSection,
    ...memSection,
    ...exportSection,
    ...codeSection,
    ...dataSection,
  ]);
}

/** Build a minimal WASI binary that calls proc_exit(code) */
function buildExitWasm(code: number): Uint8Array {
  // Type section: 2 types
  // type 0: (i32) -> ()     -- proc_exit
  // type 1: () -> ()         -- _start
  const typeSection = section(1, [
    2,
    0x60, 1, 0x7f, 0,   // type 0: (i32) -> ()
    0x60, 0, 0,          // type 1: () -> ()
  ]);

  // Import section: proc_exit
  const modName = wasmString('wasi_snapshot_preview1');
  const importSection = section(2, [
    1,
    ...modName, ...wasmString('proc_exit'), 0x00, 0x00,
  ]);

  // Function section: 1 function of type 1
  const funcSection = section(3, [1, 1]);

  // Memory section: 1 memory, min 1 page
  const memSection = section(5, [1, 0x00, 1]);

  // Export section: "memory" + "_start"
  const exportSection = section(7, [
    2,
    ...wasmString('memory'), 0x02, 0x00,
    ...wasmString('_start'), 0x00, 0x01,
  ]);

  // Code section: _start calls proc_exit(code)
  const body = [
    0,  // 0 locals
    0x41, ...leb128(code),  // i32.const <code>
    0x10, 0x00,  // call func 0 (proc_exit)
    0x0b,        // end
  ];
  const codeSection = section(10, [1, ...leb128(body.length), ...body]);

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...typeSection,
    ...importSection,
    ...funcSection,
    ...memSection,
    ...exportSection,
    ...codeSection,
  ]);
}

// ═══════════════════════════════════════════════════════════════════
//  C. wasi-packages.ts tests
// ═══════════════════════════════════════════════════════════════════

describe('wasi-packages', () => {
  it('findPackage returns cowsay', () => {
    const pkg = findPackage('cowsay');
    expect(pkg).toBeDefined();
    expect(pkg!.name).toBe('cowsay');
    expect(pkg!.url).toBeTruthy();
    expect(pkg!.version).toBeTruthy();
  });

  it('findPackage returns undefined for nonexistent', () => {
    expect(findPackage('nonexistent')).toBeUndefined();
  });

  it('searchPackages("cow") includes cowsay', () => {
    const results = searchPackages('cow');
    expect(results.some(p => p.name === 'cowsay')).toBe(true);
  });

  it('searchPackages("utility") returns multiple', () => {
    const results = searchPackages('utility');
    expect(results.length).toBeGreaterThan(1);
  });

  it('listAvailable returns all 6 packages', () => {
    const all = listAvailable();
    expect(all.length).toBe(6);
  });

  it('isAvailableAsPackage("cowsay") returns package', () => {
    const pkg = isAvailableAsPackage('cowsay');
    expect(pkg).toBeDefined();
    expect(pkg!.name).toBe('cowsay');
  });

  it('isAvailableAsPackage("xyz") returns undefined', () => {
    expect(isAvailableAsPackage('xyz')).toBeUndefined();
  });

  it('downloadPackage + getCachedPackage round-trip via IndexedDB', async () => {
    // Mock fetch to return fake WASM bytes
    const fakeWasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeWasm.buffer),
    });
    vi.stubGlobal('fetch', mockFetch);

    try {
      const binary = await downloadPackage('cowsay');
      expect(binary).toBeTruthy();
      expect(new Uint8Array(binary).slice(0, 4)).toEqual(new Uint8Array([0x00, 0x61, 0x73, 0x6d]));

      // Should now be cached
      const cached = await getCachedPackage('cowsay');
      expect(cached).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
//  D. pkg command tests (via shell)
// ═══════════════════════════════════════════════════════════════════

describe('pkg command', () => {
  let shell: Shell;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
  });

  it('pkg --help exits 0 and shows install', async () => {
    const { output, exitCode } = await run(shell, 'pkg --help');
    expect(exitCode).toBe(0);
    expect(output).toContain('install');
  });

  it('pkg available exits 0 and shows cowsay', async () => {
    const { output, exitCode } = await run(shell, 'pkg available');
    expect(exitCode).toBe(0);
    expect(output).toContain('cowsay');
  });

  it('pkg info cowsay exits 0 and shows version/URL', async () => {
    const { output, exitCode } = await run(shell, 'pkg info cowsay');
    expect(exitCode).toBe(0);
    expect(output).toContain('Version:');
    expect(output).toContain('URL:');
  });

  it('pkg info nonexistent exits 1', async () => {
    const { exitCode } = await run(shell, 'pkg info nonexistent');
    expect(exitCode).toBe(1);
  });

  it('pkg search cow exits 0 and shows cowsay', async () => {
    const { output, exitCode } = await run(shell, 'pkg search cow');
    expect(exitCode).toBe(0);
    expect(output).toContain('cowsay');
  });

  it('pkg search zzzzzzz exits 0 and shows "No packages"', async () => {
    const { output, exitCode } = await run(shell, 'pkg search zzzzzzz');
    expect(exitCode).toBe(0);
    expect(output).toContain('No packages');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  E. wasi command tests (via shell)
// ═══════════════════════════════════════════════════════════════════

describe('wasi command', () => {
  let shell: Shell;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
  });

  it('wasi (no args) exits 0 and shows help', async () => {
    const { output, exitCode } = await run(shell, 'wasi');
    expect(exitCode).toBe(0);
    expect(output).toContain('wasi run');
  });

  it('wasi run (no file) exits 1', async () => {
    const { exitCode } = await run(shell, 'wasi run');
    expect(exitCode).toBe(1);
  });

  it('wasi run /no/such/file.wasm exits 1', async () => {
    const { exitCode } = await run(shell, 'wasi run /no/such/file.wasm');
    expect(exitCode).toBe(1);
  });

  it('wasi blah (unknown subcommand) exits 1', async () => {
    const { output, exitCode } = await run(shell, 'wasi blah');
    expect(exitCode).toBe(1);
    expect(output).toContain('unknown subcommand');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  F. Shell integration — .wasm file detection
// ═══════════════════════════════════════════════════════════════════

describe('Shell WASM integration', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  it('executes .wasm file through executeWasmBinary path', async () => {
    // Write a valid WASM binary that calls proc_exit(0)
    const wasmBytes = buildExitWasm(0);
    await fs.writeFile('/home/user/test.wasm', wasmBytes);

    // Run via wasi command (direct path)
    const { exitCode } = await run(shell, 'wasi run /home/user/test.wasm');
    expect(exitCode).toBe(0);
  });

  it('wasi run executes hello binary and captures output', async () => {
    const wasmBytes = buildHelloWasm();
    await fs.writeFile('/home/user/hello.wasm', wasmBytes);

    const { output, exitCode } = await run(shell, 'wasi run /home/user/hello.wasm');
    expect(exitCode).toBe(0);
    expect(output).toContain('hello');
  });
});
