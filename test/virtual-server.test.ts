import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '../src/shell';
import { FileSystem } from '../src/filesystem';

/**
 * Virtual Server Tests
 *
 * NOTE: Service Workers don't exist in Node.js/linkedom, so we can't test
 * the full ?PORT=N flow. These tests verify:
 * 1. The Express shim creates and handles requests correctly
 * 2. The http.createServer shim works
 *
 * For full E2E testing with actual service worker interception,
 * use windwalker in a real browser.
 */

describe('Virtual Server Shims', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    const env = await createTestShell();
    shell = env.shell;
    fs = env.fs;
  });

  describe('Express shim', () => {
    it('should create an express app that can define routes', async () => {
      const { output, exitCode } = await run(shell, `node -e "
        const express = require('express');
        const app = express();

        // Verify express is shimmed correctly
        console.log('express type:', typeof express);
        console.log('app type:', typeof app);
        console.log('app.get type:', typeof app.get);
        console.log('app.post type:', typeof app.post);
        console.log('app.use type:', typeof app.use);
        console.log('app.listen type:', typeof app.listen);

        // Define a route
        app.get('/api/test', (req, res) => {
          res.json({ success: true });
        });

        console.log('Routes defined successfully');
      "`);

      expect(exitCode).toBe(0);
      expect(output).toContain('express type: function');
      expect(output).toContain('app type: function');
      expect(output).toContain('app.get type: function');
      expect(output).toContain('app.post type: function');
      expect(output).toContain('app.use type: function');
      expect(output).toContain('app.listen type: function');
      expect(output).toContain('Routes defined successfully');
    });

    it('should handle Express middleware chain', async () => {
      const { output, exitCode } = await run(shell, `node -e "
        const express = require('express');
        const app = express();

        let middlewareOrder = [];

        app.use((req, res, next) => {
          middlewareOrder.push('global1');
          next();
        });

        app.use((req, res, next) => {
          middlewareOrder.push('global2');
          next();
        });

        app.get('/test', (req, res) => {
          middlewareOrder.push('handler');
          res.json({ order: middlewareOrder });
        });

        const response = await app._handleRequest({
          method: 'GET',
          path: '/test',
          headers: {},
          query: {},
          body: null,
        });
        console.log('Status:', response.status);
        console.log('Body:', response.body);
      "`);

      expect(exitCode).toBe(0);
      expect(output).toContain('Status: 200');
      expect(output).toContain('global1');
      expect(output).toContain('global2');
      expect(output).toContain('handler');
    });

    it('should handle route parameters', async () => {
      const { output, exitCode } = await run(shell, `node -e "
        const express = require('express');
        const app = express();

        app.get('/users/:id', (req, res) => {
          res.json({ userId: req.params.id });
        });

        app.get('/posts/:postId/comments/:commentId', (req, res) => {
          res.json({
            postId: req.params.postId,
            commentId: req.params.commentId
          });
        });

        // Test single param
        const r1 = await app._handleRequest({
          method: 'GET',
          path: '/users/123',
          headers: {},
          query: {},
          body: null,
        });
        console.log('User:', r1.body);

        // Test multiple params
        const r2 = await app._handleRequest({
          method: 'GET',
          path: '/posts/456/comments/789',
          headers: {},
          query: {},
          body: null,
        });
        console.log('Post/Comment:', r2.body);
      "`);

      expect(exitCode).toBe(0);
      expect(output).toContain('"userId":"123"');
      expect(output).toContain('"postId":"456"');
      expect(output).toContain('"commentId":"789"');
    });

    it('should return 404 for unmatched routes', async () => {
      const { output, exitCode } = await run(shell, `node -e "
        const express = require('express');
        const app = express();

        app.get('/exists', (req, res) => res.send('OK'));

        const r = await app._handleRequest({
          method: 'GET',
          path: '/does-not-exist',
          headers: {},
          query: {},
          body: null,
        });
        console.log('Status:', r.status);
        console.log('Body:', r.body);
      "`);

      expect(exitCode).toBe(0);
      expect(output).toContain('Status: 404');
      expect(output).toContain('Cannot GET /does-not-exist');
    });

    it('should handle JSON body parsing', async () => {
      // Note: Using single quotes in JSON.stringify to avoid escaping issues
      const { output, exitCode } = await run(shell, `node -e "
        const express = require('express');
        const app = express();

        app.use(express.json());

        app.post('/api/data', (req, res) => {
          console.log('Received body:', JSON.stringify(req.body));
          res.json({ received: req.body });
        });

        const r = await app._handleRequest({
          method: 'POST',
          path: '/api/data',
          headers: { 'content-type': 'application/json' },
          query: {},
          body: '{\\\"name\\\":\\\"test\\\",\\\"value\\\":42}',
        });
        console.log('Response:', r.body);
      "`);

      // If it fails, show what we got
      if (exitCode !== 0) {
        console.log('JSON body test output:', output);
      }

      expect(exitCode).toBe(0);
      expect(output).toContain('"name":"test"');
      expect(output).toContain('"value":42');
    });
  });

  describe('http.createServer shim', () => {
    it('should create a server with request handler', async () => {
      const { output, exitCode } = await run(shell, `node -e "
        const http = require('http');

        console.log('http.createServer type:', typeof http.createServer);

        const server = http.createServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Hello World');
        });

        console.log('server.listen type:', typeof server.listen);
        console.log('server.close type:', typeof server.close);
        console.log('server.on type:', typeof server.on);
      "`);

      expect(exitCode).toBe(0);
      expect(output).toContain('http.createServer type: function');
      expect(output).toContain('server.listen type: function');
      expect(output).toContain('server.close type: function');
      expect(output).toContain('server.on type: function');
    });
  });

  // Skip: better-sqlite3 shim requires sql.js WASM which isn't available in Node/linkedom
  describe.skip('better-sqlite3 shim', () => {
    it('should create a Database class with prepare method', async () => {
      const { output, exitCode } = await run(shell, `node -e "
        const Database = require('better-sqlite3');
        console.log('Database type:', typeof Database);
        console.log('Is constructor:', Database.toString().includes('class') || Database.prototype?.constructor);
      "`);

      expect(exitCode).toBe(0);
      expect(output).toContain('Database type: function');
    });

    it('should support prepare().run() and prepare().all()', async () => {
      // Note: This test can't fully run sql.js in Node/linkedom (no WASM),
      // but it verifies the shim structure is correct
      const { output, exitCode } = await run(shell, `node -e "
        const Database = require('better-sqlite3');
        const db = new Database(':memory:');

        console.log('db.prepare type:', typeof db.prepare);
        console.log('db.exec type:', typeof db.exec);
        console.log('db.pragma type:', typeof db.pragma);
        console.log('db.transaction type:', typeof db.transaction);
        console.log('db.close type:', typeof db.close);
      "`);

      expect(exitCode).toBe(0);
      expect(output).toContain('db.prepare type: function');
      expect(output).toContain('db.exec type: function');
      expect(output).toContain('db.pragma type: function');
      expect(output).toContain('db.transaction type: function');
      expect(output).toContain('db.close type: function');
    });
  });

  describe('Response helpers', () => {
    it('should support res.status().json()', async () => {
      const { output, exitCode } = await run(shell, `node -e "
        const express = require('express');
        const app = express();

        app.get('/created', (req, res) => {
          res.status(201).json({ id: 1, created: true });
        });

        const r = await app._handleRequest({
          method: 'GET',
          path: '/created',
          headers: {},
          query: {},
          body: null,
        });
        console.log('Status:', r.status);
        console.log('Body:', r.body);
      "`);

      expect(exitCode).toBe(0);
      expect(output).toContain('Status: 201');
      expect(output).toContain('"created":true');
    });

    it('should support res.redirect()', async () => {
      const { output, exitCode } = await run(shell, `node -e "
        const express = require('express');
        const app = express();

        app.get('/old', (req, res) => {
          res.redirect('/new');
        });

        const r = await app._handleRequest({
          method: 'GET',
          path: '/old',
          headers: {},
          query: {},
          body: null,
        });
        console.log('Redirect status:', r.status);
        console.log('Location:', r.headers.location);
      "`);

      expect(exitCode).toBe(0);
      expect(output).toContain('Redirect status: 302');
      expect(output).toContain('Location: /new');
    });
  });
});
