/**
 * server.mjs's /git-proxy/ must not fetch private, loopback, link-local or
 * cloud-metadata addresses (it once returned the droplet's metadata).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

describe('git proxy target checks', () => {
  it('refuses non-public targets, odd schemes and ports; allows public https', () => {
    // Plain Node (vitest's polyfilled modules can't load server.mjs)
    const server = new URL('../../../server.mjs', import.meta.url).href;
    const cases: Record<string, string> = {
      'https://github.com/a/b.git/info/refs': '',
      'http://140.82.112.3/x': '',
      'http://169.254.169.254/metadata/v1/user-data': 'address not allowed',
      'http://127.0.0.1:3000/': 'port not allowed',
      'http://localhost/': 'address not allowed',
      'https://internal.example/': 'address not allowed',
      'http://[::1]/': 'address not allowed',
      'http://10.1.2.3/': 'address not allowed',
      'file:///etc/passwd': 'only http(s)',
      'https://github.com:8443/': 'port not allowed',
    };
    // Fixed DNS answers so the test needs no network
    const dnsTable = { 'github.com': ['140.82.112.3'], localhost: ['127.0.0.1'], 'internal.example': ['93.184.215.14', '10.0.0.7'] };
    const out = execFileSync('node', ['--input-type=module', '-e', `
      const m = await import(${JSON.stringify(server)});
      const table = ${JSON.stringify(dnsTable)};
      const lookup = async (h) => (table[h] || []).map((address) => ({ address }));
      const urls = ${JSON.stringify(Object.keys(cases))};
      console.log(JSON.stringify(await Promise.all(urls.map((u) => m.gitProxyRefusal(u, lookup)))));
      process.exit(0);`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const got = JSON.parse(out.trim().split('\n').pop()!);
    expect(Object.fromEntries(Object.keys(cases).map((u, i) => [u, got[i]]))).toEqual(cases);
  });
});
