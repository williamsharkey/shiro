import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { batch, messages } from './gl-encode';
import { MSG_FRAME } from '@shiro/gl/wire';

/**
 * src/gl on real WebGL2 (headless Chromium with SwiftShader): the GLSL front
 * end on a corpus of real shaders (fixtures/glsl), every kind of generated
 * fixed-function program, and the executor's pixels. Skipped where Chromium
 * isn't installed.
 */
const CHROME = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ROOT = join(__dirname, '../../..');
const CORPUS = join(__dirname, 'fixtures/glsl');

/** The constants glmark2's scenes add in front of their shaders (ShaderSource::add_const), as far as each uses them. */
function glmark2Preamble(src: string): string {
  const consts: [string, string][] = [
    ['LightSourcePosition', 'vec4(0.0, 1.0, 1.0, 0.0)'], ['LightSourceHalfVector', 'vec3(0.0, 0.5, 1.0)'],
    ['LightSourceAmbient', 'vec4(0.1, 0.1, 0.1, 1.0)'], ['LightSourceDiffuse', 'vec4(0.8, 0.8, 0.8, 1.0)'], ['LightSourceSpecular', 'vec4(0.8, 0.8, 0.8, 1.0)'],
    ['MaterialAmbient', 'vec4(1.0, 1.0, 1.0, 1.0)'], ['MaterialDiffuse', 'vec4(0.0, 0.0, 1.0, 1.0)'], ['MaterialSpecular', 'vec4(1.0, 1.0, 1.0, 1.0)'],
    ['MaterialShininess', '100.0'], ['TextureStepX', '0.001'], ['TextureStepY', '0.001'],
  ];
  let out = '#define HIGHP_OR_DEFAULT\n';
  for (const [name, value] of consts) {
    if (!new RegExp(`\\b${name}\\b`).test(src) || new RegExp(`(const|uniform)\\s+\\w+\\s+${name}\\b`).test(src)) continue;
    out += `const ${value.startsWith('vec3') ? 'vec3' : value.startsWith('vec4') ? 'vec4' : 'float'} ${name} = ${value};\n`;
  }
  return out;
}

type Page = { evaluate<R, A>(fn: (a: A) => R | Promise<R>, arg: A): Promise<R> };
let browser: { close(): Promise<void> } | null = null;
let page: Page;

describe.skipIf(!existsSync(CHROME))('GL on WebGL2 in Chromium', () => {
  beforeAll(async () => {
    const esbuild = await import('esbuild');
    const out = await esbuild.build({ entryPoints: [join(__dirname, 'gl-page.ts')], bundle: true, write: false, format: 'iife', target: 'es2022', absWorkingDir: ROOT });
    const { chromium } = await import('playwright-core');
    const b = await chromium.launch({ executablePath: CHROME, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    browser = b;
    const p = await b.newPage();
    await p.setContent('<html><body></body></html>');
    await p.addScriptTag({ content: out.outputFiles[0].text });
    page = p as unknown as Page;
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  it('translates every corpus shader to GLSL ES that compiles, and the pairs link', async () => {
    const files: Record<string, string> = {};
    for (const n of readdirSync(CORPUS)) {
      if (!/\.(vert|frag)$/.test(n)) continue;
      let src = readFileSync(join(CORPUS, n), 'utf8');
      if (n.startsWith('stk-')) src = `#version 330\n${src}`; // the game adds it
      if (n.startsWith('glmark2-')) src = glmark2Preamble(src) + src;
      files[n] = src;
    }
    const names = Object.keys(files);
    expect(names.length).toBeGreaterThan(40);
    const pairs: [string, string][] = names.filter((n) => n.endsWith('.vert') && files[n.replace(/\.vert$/, '.frag')]).map((n) => [n, n.replace(/\.vert$/, '.frag')]);
    pairs.push(['glmark2-light-basic.vert', 'glmark2-light-basic-tex.frag'], ['stk-screenquad.vert', 'stk-gaussian3h.frag']);
    const results = await page.evaluate(([f, p]) => (globalThis as any).glTest.corpus(f, p), [files, pairs] as const) as Record<string, string | null>;
    const failed = Object.entries(results).filter(([, r]) => r !== null);
    expect(failed.map(([n, r]) => `${n}: ${r}`)).toEqual([]);
    expect(Object.keys(results).length).toBe(names.length + pairs.length);
  }, 60_000);

  it('generates fixed-function programs that compile and link for every kind of state', async () => {
    const results = await page.evaluate(() => (globalThis as any).glTest.ffVariants(), null) as Record<string, string | null>;
    expect(Object.keys(results).length).toBeGreaterThan(60);
    expect(Object.entries(results).filter(([, r]) => r !== null).map(([n, r]) => `${n}: ${r}`)).toEqual([]);
  }, 60_000);

  describe('executor pixels', () => {
    const W = 32, H = 32, WIN = 0x400001;
    const open = () => page.evaluate(([w, h]) => (globalThis as any).glTest.execOpen(w, h) as number, [W, H] as const);
    const run = async (id: number, ctx: number, cmds: Parameters<typeof batch>[1]) => {
      const r = await page.evaluate(([i, b]) => (globalThis as any).glTest.execRun(i, b), [id, Array.from(batch(ctx, cmds))] as const) as
        { ok: boolean; out: number[][]; frames: { xid: number; width: number; height: number; pixels: number[] }[]; logs: string[] };
      expect(r.ok).toBe(true);
      return r;
    };
    /** RGBA at (x, y), y from the top as on screen */
    const px = (f: { width: number; height: number; pixels: number[] }, x: number, y: number) => {
      const o = ((f.height - 1 - y) * f.width + x) * 4;
      return f.pixels.slice(o, o + 4);
    };
    const start = async () => {
      const id = await open();
      await run(id, 0, [['tcCreateContext', 1, 0, 2, 1, 0], ['tcMakeCurrent', 1, WIN, WIN, 0x100]]);
      return id;
    };
    const swap = async (id: number, n = 1) => {
      const r = await run(id, 1, [['tcSwapBuffers', WIN, n]]);
      expect(messages(r.out.map((o) => new Uint8Array(o))).some((m) => m.kind === MSG_FRAME)).toBe(true);
      expect(r.frames).toHaveLength(1);
      return r.frames[0];
    };

    it('clears to a color', async () => {
      const id = await start();
      await run(id, 1, [['glClearColor', 1, 0, 0, 1], ['glClear', 0x4000]]);
      const f = await swap(id);
      expect([f.width, f.height]).toEqual([W, H]);
      expect(px(f, 0, 0)).toEqual([255, 0, 0, 255]);
      expect(px(f, W - 1, H - 1)).toEqual([255, 0, 0, 255]);
    });

    it('draws an immediate-mode triangle with the current color and the matrices', async () => {
      const id = await start();
      await run(id, 1, [
        ['glClearColor', 0, 0, 0, 1], ['glClear', 0x4000],
        ['glMatrixMode', 0x1701 /* PROJECTION */], ['glLoadIdentity'], ['glOrtho', 0, W, 0, H, -1, 1],
        ['glMatrixMode', 0x1700 /* MODELVIEW */], ['glLoadIdentity'],
        // the lower-left half of the window, y up
        ['glColor3f', 0, 1, 0], ['glBegin', 4], ['glVertex2f', 0, 0], ['glVertex2f', W, 0], ['glVertex2f', 0, H], ['glEnd'],
      ]);
      const f = await swap(id);
      expect(px(f, 2, H - 3)).toEqual([0, 255, 0, 255]); // bottom left
      expect(px(f, W - 3, 2)).toEqual([0, 0, 0, 255]); // top right
    });

    it('replays a display list with transforms between calls', async () => {
      const id = await start();
      await run(id, 1, [
        ['glClear', 0x4000], ['glGenLists', 1, 1],
        ['glNewList', 1, 0x1300], ['glColor3f', 0, 0, 1], ['glRectf', -1, -1, 0, 0], ['glEndList'],
        ['glCallList', 1], ['glTranslatef', 1, 1, 0], ['glCallList', 1],
      ]);
      const f = await swap(id);
      expect(px(f, 4, H - 5)).toEqual([0, 0, 255, 255]); // bottom-left quarter
      expect(px(f, W - 5, 4)).toEqual([0, 0, 255, 255]); // top-right quarter, translated
      expect(px(f, W - 5, H - 5)).toEqual([0, 0, 0, 0]); // untouched (cleared to 0)
    });

    it('samples a texture with GL_REPLACE', async () => {
      const id = await start();
      const tex = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]); // 2×2: red green / blue white
      await run(id, 1, [
        ['glGenTextures', new Uint32Array([5])], ['glBindTexture', 0x0de1, 5],
        ['glTexParameteri', 0x0de1, 0x2801, 0x2600], ['glTexParameteri', 0x0de1, 0x2800, 0x2600], // NEAREST
        ['glTexImage2D', 0x0de1, 0, 0x1908, 2, 2, 0, 0x1908, 0x1401, tex],
        ['glTexEnvi', 0x2300, 0x2200, 0x1e01 /* REPLACE */], ['glEnable', 0x0de1],
        ['glBegin', 7 /* QUADS */],
        ['glTexCoord2f', 0, 0], ['glVertex2f', -1, -1], ['glTexCoord2f', 1, 0], ['glVertex2f', 1, -1],
        ['glTexCoord2f', 1, 1], ['glVertex2f', 1, 1], ['glTexCoord2f', 0, 1], ['glVertex2f', -1, 1],
        ['glEnd'],
      ]);
      const f = await swap(id);
      expect(px(f, 4, H - 5)).toEqual([255, 0, 0, 255]); // texel (0,0) at the bottom left
      expect(px(f, W - 5, H - 5)).toEqual([0, 255, 0, 255]);
      expect(px(f, 4, 4)).toEqual([0, 0, 255, 255]);
      expect(px(f, W - 5, 4)).toEqual([255, 255, 255, 255]);
    });

    it('lights a surface facing the light and not one facing away', async () => {
      const id = await start();
      const v4 = (...a: number[]) => new Float32Array(a);
      await run(id, 1, [
        ['glClearColor', 0, 0, 0, 1], ['glClear', 0x4000],
        ['glEnable', 0x0b50 /* LIGHTING */], ['glEnable', 0x4000 /* LIGHT0 */],
        ['glLightfv', 0x4000, 0x1203 /* POSITION */, v4(0, 0, 1, 0)],
        ['glLightModelfv', 0x0b53 /* LIGHT_MODEL_AMBIENT */, v4(0, 0, 0, 1)],
        ['glMaterialfv', 0x0408, 0x1201 /* DIFFUSE */, v4(1, 1, 0, 1)],
        ['glMaterialfv', 0x0408, 0x1200 /* AMBIENT */, v4(0, 0, 0, 1)],
        ['glBegin', 7], ['glNormal3f', 0, 0, 1], ['glVertex2f', -1, -1], ['glVertex2f', 0, -1], ['glVertex2f', 0, 1], ['glVertex2f', -1, 1], ['glEnd'],
        ['glBegin', 7], ['glNormal3f', 0, 0, -1], ['glVertex2f', 0, -1], ['glVertex2f', 1, -1], ['glVertex2f', 1, 1], ['glVertex2f', 0, 1], ['glEnd'],
      ]);
      const f = await swap(id);
      expect(px(f, 4, H / 2)).toEqual([255, 255, 0, 255]);
      expect(px(f, W - 5, H / 2)).toEqual([0, 0, 0, 255]);
    });

    it('runs a legacy GLSL program with gl_Vertex and gl_FragColor', async () => {
      const id = await start();
      const enc = (s: string) => new TextEncoder().encode(s);
      await run(id, 1, [
        ['glClear', 0x4000],
        ['glCreateShader', 0x8b31, 1], ['glShaderSource', 1, enc('void main() { gl_Position = gl_ModelViewProjectionMatrix * gl_Vertex; gl_FrontColor = gl_Color; }')], ['glCompileShader', 1],
        ['glCreateShader', 0x8b30, 2], ['glShaderSource', 2, enc('uniform float k; void main() { gl_FragColor = vec4(gl_Color.rgb * k, 1.0); }')], ['glCompileShader', 2],
        ['glCreateProgram', 3], ['glAttachShader', 3, 1], ['glAttachShader', 3, 2], ['glLinkProgram', 3], ['glUseProgram', 3],
        ['glGetProgramInfo', 3],
      ]);
      // the uniform's location comes from the program info reply; look it up the way the guest does
      const info = await run(id, 1, [['glGetProgramInfo', 3]]);
      const reply = messages(info.out.map((o) => new Uint8Array(o)))[0].payload;
      const dv = new DataView(reply.buffer);
      expect(dv.getUint32(0, true)).toBe(1); // linked
      let o = 4; o += 4 + ((dv.getUint32(o, true) + 3) & ~3); // the log
      const skip = () => { const n = dv.getUint32(o, true); o += 4; const vars = []; for (let i = 0; i < n; i++) { const type = dv.getUint32(o, true), loc = dv.getInt32(o + 8, true); const len = dv.getUint32(o + 12, true); const name = new TextDecoder().decode(reply.subarray(o + 16, o + 16 + len)); o += 16 + ((len + 3) & ~3); vars.push({ type, loc, name }); } return vars; };
      skip();
      const k = skip().find((u) => u.name === 'k')!;
      expect(k).toBeTruthy();
      await run(id, 1, [['glUniform1f', k.loc, 0.5], ['glColor3f', 1, 1, 1], ['glRectf', -1, -1, 1, 1]]);
      const f = await swap(id);
      const c = px(f, W / 2, H / 2);
      expect(c[0]).toBeGreaterThanOrEqual(126); expect(c[0]).toBeLessThanOrEqual(129);
      expect(c[3]).toBe(255);
    });
  });
});
