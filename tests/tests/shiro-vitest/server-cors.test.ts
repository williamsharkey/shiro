import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('server CORS handling for seeded blobs', () => {
  const source = readFileSync(new URL('../../../server.mjs', import.meta.url), 'utf8');

  it('reflects access-control-request-headers on preflight responses', () => {
    expect(source).toContain("req.headers['access-control-request-headers']");
    expect(source).toContain('buildAllowedHeaders(requestHeaders)');
  });

  it('allows Claude-specific cross-origin headers used by seeded sessions', () => {
    expect(source).toContain("'x-app'");
    expect(source).toContain("'x-stainless-timeout'");
  });
});
