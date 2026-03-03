import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { createFakeBuffer } from '@shiro/node-compat/buffer';
import { createPathModule } from '@shiro/node-compat/modules/path';
import { createEventsModule } from '@shiro/node-compat/modules/events';
import { createUrlModule } from '@shiro/node-compat/modules/url';
import { createUtilModule } from '@shiro/node-compat/modules/util';
import { createStreamModule } from '@shiro/node-compat/modules/stream';
import { createNetModule } from '@shiro/node-compat/modules/net-tls';
import { createAutoStubFactory } from '@shiro/node-compat/auto-stub';

/** Minimal ctx mock for createPathModule */
function mockCtx(cwd = '/') {
  return { cwd, fs: { resolvePath(p: string, base: string) {
    const raw = p.startsWith('/') ? p : base + '/' + p;
    const stack: string[] = [];
    for (const s of raw.split('/').filter(Boolean))
      s === '..' ? stack.pop() : s !== '.' && stack.push(s);
    return '/' + stack.join('/');
  } } } as any;
}

describe('Node Compat Modular Tests', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  describe('Buffer module (direct)', () => {
    it('should create Buffer from string and encode to hex', () => {
      const B = createFakeBuffer();
      expect(B.from('hello').toString('hex')).toBe('68656c6c6f');
    });
    it('should round-trip utf8/base64/hex encodings', () => {
      const B = createFakeBuffer();
      const buf = B.from('Hello, World!', 'utf8');
      expect(B.from(buf.toString('hex'), 'hex').toString('utf8')).toBe('Hello, World!');
      expect(B.from(buf.toString('base64'), 'base64').toString('utf8')).toBe('Hello, World!');
    });
    it('should support Buffer.alloc and Buffer.isBuffer', () => {
      const B = createFakeBuffer();
      const buf = B.alloc(10);
      expect(buf.length).toBe(10);
      expect(B.isBuffer(buf)).toBe(true);
      expect(B.isBuffer('not a buffer')).toBe(false);
    });
    it('should support Buffer.concat', () => {
      const B = createFakeBuffer();
      expect(B.concat([B.from('hello'), B.from(' world')]).toString()).toBe('hello world');
    });
  });

  describe('Path module (direct)', () => {
    it('should join paths', () => {
      const path = createPathModule(mockCtx('/home/user'));
      expect(path.join('/foo', 'bar', 'baz')).toBe('/foo/bar/baz');
      expect(path.join('/foo/', '/bar')).toBe('/foo/bar');
    });
    it('should resolve paths', () => {
      const path = createPathModule(mockCtx('/home/user'));
      expect(path.resolve('/foo', 'bar')).toBe('/foo/bar');
      expect(path.resolve('foo', 'bar')).toBe('/home/user/foo/bar');
    });
    it('should handle dirname/basename/extname', () => {
      const path = createPathModule(mockCtx());
      expect(path.dirname('/foo/bar/baz.js')).toBe('/foo/bar');
      expect(path.basename('/foo/bar/baz.js')).toBe('baz.js');
      expect(path.basename('/foo/bar/baz.js', '.js')).toBe('baz');
      expect(path.extname('/foo/bar/baz.js')).toBe('.js');
    });
    it('should parse and format paths', () => {
      const path = createPathModule(mockCtx());
      const parsed = path.parse('/home/user/file.txt');
      expect(parsed.root).toBe('/');
      expect(parsed.dir).toBe('/home/user');
      expect(parsed.base).toBe('file.txt');
      expect(parsed.name).toBe('file');
      expect(parsed.ext).toBe('.txt');
      expect(path.format(parsed)).toBe('/home/user/file.txt');
    });
    it('should expose posix/win32 and sep/delimiter', () => {
      const path = createPathModule(mockCtx());
      expect(path.sep).toBe('/');
      expect(path.delimiter).toBe(':');
      expect(path.posix).toBeDefined();
      expect(path.win32).toBeDefined();
    });
  });

  describe('EventEmitter (direct)', () => {
    it('should support on/emit', () => {
      const EE = createEventsModule();
      const e = new EE();
      const results: string[] = [];
      e.on('test', (val: string) => results.push(val));
      e.emit('test', 'hello');
      e.emit('test', 'world');
      expect(results).toEqual(['hello', 'world']);
    });
    it('should support once (fires only once)', () => {
      const EE = createEventsModule();
      const e = new EE();
      let count = 0;
      e.once('ping', () => count++);
      e.emit('ping');
      e.emit('ping');
      expect(count).toBe(1);
    });
    it('should support off/removeListener', () => {
      const EE = createEventsModule();
      const e = new EE();
      let count = 0;
      const handler = () => count++;
      e.on('test', handler);
      e.emit('test');
      e.off('test', handler);
      e.emit('test');
      expect(count).toBe(1);
    });
    it('should support removeAllListeners', () => {
      const EE = createEventsModule();
      const e = new EE();
      let a = 0, b = 0;
      e.on('a', () => a++);
      e.on('b', () => b++);
      e.removeAllListeners('a');
      e.emit('a');
      e.emit('b');
      expect(a).toBe(0);
      expect(b).toBe(1);
    });
    it('should support listenerCount and eventNames', () => {
      const EE = createEventsModule();
      const e = new EE();
      e.on('foo', () => {});
      e.on('foo', () => {});
      e.on('bar', () => {});
      expect(e.listenerCount('foo')).toBe(2);
      expect(e.eventNames()).toEqual(['foo', 'bar']);
    });
    it('should support static EventEmitter.once', async () => {
      const EE = createEventsModule();
      const e = new EE();
      const promise = EE.once(e, 'ready');
      e.emit('ready', 42);
      const [result] = await promise;
      expect(result).toBe(42);
    });
  });

  describe('URL module (direct)', () => {
    it('should parse URLs', () => {
      const url = createUrlModule();
      const p = url.parse('http://example.com:8080/path?q=1#hash');
      expect(p.protocol).toBe('http:');
      expect(p.hostname).toBe('example.com');
      expect(p.port).toBe('8080');
      expect(p.pathname).toBe('/path');
    });
    it('should support fileURLToPath', () => {
      expect(createUrlModule().fileURLToPath('file:///home/user/test.js')).toBe('/home/user/test.js');
    });
    it('should export URL and URLSearchParams', () => {
      const url = createUrlModule();
      expect(url.URL).toBe(URL);
      expect(url.URLSearchParams).toBe(URLSearchParams);
    });
  });

  describe('Util module (direct)', () => {
    it('should format strings like printf', () => {
      const util = createUtilModule();
      expect(util.format('hello %s', 'world')).toBe('hello world');
      expect(util.format('count: %d', 42)).toBe('count: 42');
      expect(util.format('%j', { a: 1 })).toBe('{"a":1}');
    });
    it('should support promisify', () => {
      const util = createUtilModule();
      const fn = (x: number, cb: (err: any, r: number) => void) => cb(null, x * 2);
      expect(typeof util.promisify(fn)).toBe('function');
    });
    it('should support inspect', () => {
      const result = createUtilModule().inspect({ a: 1, b: 'hello' });
      expect(result).toContain('a');
      expect(result).toContain('1');
    });
    it('should have types object', () => {
      const util = createUtilModule();
      expect(util.types).toBeDefined();
      expect(util.types.isPromise(Promise.resolve())).toBe(true);
      expect(util.types.isPromise(42)).toBe(false);
    });
    it('should support inherits', () => {
      const util = createUtilModule();
      function Parent() {}
      (Parent as any).prototype.hello = () => 'hi';
      function Child() {}
      util.inherits(Child, Parent);
      expect((Child as any).super_).toBe(Parent);
    });
  });

  describe('Stream module (direct)', () => {
    it('should export stream classes', () => {
      const s = createStreamModule();
      expect(s.Readable).toBeDefined();
      expect(s.Writable).toBeDefined();
      expect(s.Transform).toBeDefined();
      expect(s.PassThrough).toBeDefined();
      expect(s.Duplex).toBeDefined();
      expect(s.pipeline).toBeDefined();
      expect(s.finished).toBeDefined();
    });
    it('should support stream events', () => {
      const s = createStreamModule();
      const stream = new s.Stream();
      const chunks: string[] = [];
      stream.on('data', (c: string) => chunks.push(c));
      stream.emit('data', 'hello');
      expect(chunks).toEqual(['hello']);
    });
    it('should support stream.destroy', () => {
      const s = createStreamModule();
      const r = new s.Readable();
      expect(r.destroyed).toBe(false);
      r.destroy();
      expect(r.destroyed).toBe(true);
    });
  });

  describe('Net module (direct)', () => {
    it('should export Socket and Server classes', () => {
      const net = createNetModule();
      expect(net.Socket).toBeDefined();
      expect(net.Server).toBeDefined();
      expect(net.createServer).toBeDefined();
      expect(net.createConnection).toBeDefined();
    });
    it('should support IP address detection', () => {
      const net = createNetModule();
      expect(net.isIP('127.0.0.1')).toBe(4);
      expect(net.isIPv4('192.168.1.1')).toBe(true);
      expect(net.isIPv6('::1')).toBe(true);
      expect(net.isIP('not-an-ip')).toBe(0);
    });
    it('should create a socket with proper defaults', () => {
      const net = createNetModule();
      const socket = new net.Socket();
      expect(socket.writable).toBe(true);
      expect(socket.readable).toBe(true);
      expect(socket.destroyed).toBe(false);
      expect(socket.remoteAddress).toBe('127.0.0.1');
    });
  });

  describe('Auto-stub (direct)', () => {
    it('should return existing properties unchanged', () => {
      const { createAutoStub } = createAutoStubFactory();
      const stubbed = createAutoStub('test', { foo: 42, bar: 'hello' });
      expect(stubbed.foo).toBe(42);
      expect(stubbed.bar).toBe('hello');
    });
    it('should return callable stubs for missing properties', () => {
      const { createAutoStub } = createAutoStubFactory();
      const stubbed = createAutoStub('test', {});
      expect(typeof stubbed.someMissingMethod).toBe('function');
      stubbed.someMissingMethod();
    });
    it('should return undefined for then/toJSON/__esModule', () => {
      const { createAutoStub } = createAutoStubFactory();
      const stubbed = createAutoStub('test', {});
      expect(stubbed.then).toBeUndefined();
      expect(stubbed.toJSON).toBeUndefined();
      expect(stubbed.__esModule).toBeUndefined();
    });
    it('should allow stub classes to be extended', () => {
      const { createAutoStub } = createAutoStubFactory();
      const stubbed = createAutoStub('test', {});
      class Child extends stubbed.SomeClass { constructor() { super(); } }
      expect(new Child()).toBeDefined();
    });
  });

  describe('Cross-module coherence (via node -e)', () => {
    it('should share fileCache between fs.writeFileSync and fs.readFileSync', async () => {
      const { output, exitCode } = await run(shell, `node -e "
        const fs = require('fs');
        fs.writeFileSync('/tmp/test-coherence.txt', 'shared-data');
        const data = fs.readFileSync('/tmp/test-coherence.txt', 'utf8');
        console.log(data);
      "`);
      expect(exitCode).toBe(0);
      expect(output).toContain('shared-data');
    });
    it('should share fileCache between sync and async fs operations', async () => {
      const { output, exitCode } = await run(shell, `node -e "
        const fs = require('fs'); const fsp = require('fs/promises');
        fs.writeFileSync('/tmp/test-async.txt', 'async-test');
        console.log(await fsp.readFile('/tmp/test-async.txt', 'utf8'));
      "`);
      expect(exitCode).toBe(0);
      expect(output).toContain('async-test');
    });
    it('should handle writeFile then readFile in same invocation', async () => {
      const { output, exitCode } = await run(shell, `node -e "
        const fs = require('fs');
        fs.writeFileSync('/tmp/same-inv.txt', 'round-trip');
        console.log(fs.readFileSync('/tmp/same-inv.txt', 'utf8'));
      "`);
      expect(exitCode).toBe(0);
      expect(output).toContain('round-trip');
    });
  });

  describe('Module resolution (via node -e)', () => {
    it('should resolve built-in modules with and without node: prefix', async () => {
      const { output, exitCode } = await run(shell,
        `node -e "const a=require('path'),b=require('node:path');console.log(a.join('/a','b'),typeof b.join)"`);
      expect(exitCode).toBe(0);
      expect(output).toContain('/a/b');
      expect(output).toContain('function');
    });
    it('should handle module.isBuiltin', async () => {
      const { output, exitCode } = await run(shell,
        `node -e "const m=require('module');console.log(m.isBuiltin('path'),m.isBuiltin('nope'))"`);
      expect(exitCode).toBe(0);
      expect(output).toContain('true');
      expect(output).toContain('false');
    });
  });

  describe('Multiple built-in modules (via node -e)', () => {
    it('should use path and url modules together', async () => {
      const { output, exitCode } = await run(shell, `node -e "
        const path = require('path');
        const url = require('url');
        console.log(path.basename('/home/user/file.txt'));
        console.log(url.parse('http://example.com').hostname);
      "`);
      expect(exitCode).toBe(0);
      expect(output).toContain('file.txt');
      expect(output).toContain('example.com');
    });
  });

  describe('child_process routes through shell (via node -e)', () => {
    it('should execute shell commands via execSync', async () => {
      const { output, exitCode } = await run(shell,
        `node -e "console.log(require('child_process').execSync('echo hi').toString().trim())"`);
      expect(exitCode).toBe(0);
      expect(output).toContain('hi');
    });
  });
});
