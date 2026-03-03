/**
 * Node.js 'net' and 'tls' module shims.
 * Extracted from node-cmd.ts case 'net' / 'tls'.
 */

export function createNetModule(): any {
  class FakeSocket {
    writable = true;
    readable = true;
    destroyed = false;
    _events: Record<string, Function[]> = {};
    on(ev: string, fn: Function) { (this._events[ev] ||= []).push(fn); return this; }
    once(ev: string, fn: Function) { return this.on(ev, fn); }
    off() { return this; }
    emit(ev: string, ...args: any[]) { (this._events[ev] || []).forEach(f => f(...args)); }
    write(data: any, encoding?: any, cb?: Function) { if (typeof encoding === 'function') cb = encoding; cb?.(); return true; }
    end(data?: any, encoding?: any, cb?: Function) { if (typeof data === 'function') cb = data; cb?.(); this.destroyed = true; }
    destroy() { this.destroyed = true; return this; }
    setEncoding() { return this; }
    setKeepAlive() { return this; }
    setNoDelay() { return this; }
    setTimeout() { return this; }
    ref() { return this; }
    unref() { return this; }
    address() { return { address: '127.0.0.1', family: 'IPv4', port: 0 }; }
    get remoteAddress() { return '127.0.0.1'; }
    get remotePort() { return 0; }
    get localAddress() { return '127.0.0.1'; }
    get localPort() { return 0; }
    pipe(dest: any) { return dest; }
  }

  class FakeServer {
    _events: Record<string, Function[]> = {};
    on(ev: string, fn: Function) { (this._events[ev] ||= []).push(fn); return this; }
    once(ev: string, fn: Function) { return this.on(ev, fn); }
    listen(port?: any, host?: any, cb?: Function) {
      if (typeof port === 'function') cb = port;
      else if (typeof host === 'function') cb = host;
      setTimeout(() => cb?.(), 0);
      return this;
    }
    close(cb?: Function) { cb?.(); return this; }
    address() { return { address: '127.0.0.1', family: 'IPv4', port: 0 }; }
    ref() { return this; }
    unref() { return this; }
  }

  return {
    Socket: FakeSocket,
    Server: FakeServer,
    createServer: (opts?: any, handler?: Function) => {
      if (typeof opts === 'function') { handler = opts; }
      return new FakeServer();
    },
    createConnection: (opts?: any, cb?: Function) => {
      const sock = new FakeSocket();
      if (cb) setTimeout(() => cb(), 0);
      return sock;
    },
    connect: (opts?: any, cb?: Function) => {
      const sock = new FakeSocket();
      if (cb) setTimeout(() => cb(), 0);
      return sock;
    },
    isIP: (input: string) => /^\d+\.\d+\.\d+\.\d+$/.test(input) ? 4 : (input.includes(':') ? 6 : 0),
    isIPv4: (input: string) => /^\d+\.\d+\.\d+\.\d+$/.test(input),
    isIPv6: (input: string) => input.includes(':'),
  };
}

export interface TlsDeps {
  getBuiltinModule: (name: string) => any;
}

export function createTlsModule(deps: TlsDeps): any {
  const { getBuiltinModule } = deps;
  const netMod = getBuiltinModule('net');
  return {
    ...netMod,
    TLSSocket: netMod.Socket,
    createSecureContext: () => ({}),
    getCiphers: () => ['TLS_AES_256_GCM_SHA384'],
    DEFAULT_MIN_VERSION: 'TLSv1.2',
    DEFAULT_MAX_VERSION: 'TLSv1.3',
    connect: (opts: any, cb?: Function) => netMod.connect(opts, cb),
  };
}
