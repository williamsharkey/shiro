/**
 * Pearl and Holo foil (iconsets.ts): the mockup's fragment shader, drawn
 * behind the dock's glyph tiles. One WebGL context renders every tile into a
 * row (an atlas) that is copied into a small 2D canvas inside each tile, so
 * tiles keep their own layout, hover transform and stacking. Loaded only
 * while one of these sets is chosen; dispose() releases the context, loops
 * and listeners. Animates only while the dock is on screen and the tab
 * visible; with reduced motion it draws one still frame.
 */

import type { LiveIconEngine } from './iconsets';

const VS = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }';
// The mockup's shader, with the tile size as a uniform and one tile per atlas cell
const FS = `
precision highp float;
uniform vec2 uRes; uniform float uTime; uniform float uDark; uniform float uMode; uniform vec2 uMouse; uniform float uTile;
float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float a = .5, s = 0.; for (int i=0;i<5;i++){ s += a*vn(p); p = p*2.03 + 17.1; a *= .5; } return s; }
float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q,0.)) + min(max(q.x,q.y),0.) - r; }
vec3 pal(float t){ return .5 + .5*cos(6.28318*(vec3(0.,.33,.67) + t)); }
void main(){
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  float idx = floor(px.x / uTile);
  vec2 lp = px - vec2(idx*uTile, 0.);
  float RAD = uTile * .24;
  float d = sdRound(lp - uTile*.5, vec2(uTile*.5), RAD);
  float inside = 1. - smoothstep(-.6, .6, d);
  vec2 uv = lp / uTile;
  float seed = idx * 1.91;
  float t = uTime;
  vec3 col;
  if (uMode < .5) {
    vec2 q = vec2(fbm(uv*1.7 + seed + t*.035), fbm(uv*1.7 + seed + 4.3 - t*.03));
    float n = fbm(uv*2.4 + q*2.2 + vec2(t*.02, -t*.015));
    float streams = pow(1. - abs(sin(n*26.)), 14.) * (0.55 + .45*fbm(uv*6. + seed));
    vec3 tint = pal(n*1.4 + uv.y*.25 + seed*.05 + t*.01);
    vec3 base = uDark > .5 ? vec3(.105,.105,.13) + tint*.05 : vec3(.968,.965,.978) - (1.-tint)*.035;
    col = base + tint * streams * (uDark > .5 ? .55 : .36);
    col += pal(uv.x*.6 + uv.y*.4 + t*.012 + .1) * (uDark > .5 ? .07 : .05) * smoothstep(1., .1, uv.y);
    col += (uDark > .5 ? .08 : .05) * smoothstep(.55, 0., uv.y) * (1. - abs(uv.x - .5));
  } else {
    vec2 m = uMouse - .5;
    float brushed = fbm(vec2(uv.x*40., uv.y*1.2) + seed) * .06;
    float film = uv.x*.55 + uv.y*.75 + dot(m, vec2(1.1, .8)) + t*.025 + fbm(uv*3. + seed + t*.02)*.55;
    vec3 rainbow = pal(film);
    vec3 silver = uDark > .5 ? vec3(.30,.30,.34) : vec3(.86,.86,.89);
    col = mix(silver, rainbow * (uDark > .5 ? .62 : .95), uDark > .5 ? .30 : .32) + brushed;
    float band = exp(-pow((uv.x + uv.y*.8 - fract(t*.06 + idx*.07)*3. + .6)*3.2, 2.));
    col += band * (uDark > .5 ? .18 : .22);
    float sparkle = step(.985, h21(floor(lp*1.5) + floor(t*6.))) * .35 * smoothstep(.2,.8,fbm(uv*5.+t*.1));
    col += sparkle;
  }
  float rim = smoothstep(-1.6, -.2, d) * (1. - smoothstep(-.2, .6, d));
  col += rim * (uDark > .5 ? .10 : .16);
  col *= 1. - .10 * smoothstep(-8., 0., d);
  gl_FragColor = vec4(col*inside, inside);
}`;

/** Live tiles that draw from an atlas row: shared by both live engines */
export class TileCanvases {
  tiles: { el: HTMLElement; c: HTMLCanvasElement; x: CanvasRenderingContext2D }[] = [];
  attach(els: HTMLElement[]): void {
    for (const t of this.tiles) if (!els.includes(t.el)) { t.c.remove(); t.el.classList.remove('sd-live'); }
    this.tiles = els.map((el) => {
      const old = this.tiles.find(t => t.el === el);
      if (old) return old;
      const c = document.createElement('canvas');
      c.className = 'sd-ic-live';
      el.prepend(c);
      el.classList.add('sd-live');
      return { el, c, x: c.getContext('2d')! };
    });
  }
  /** The atlas read back once per frame; tiles slice it (a WebGL canvas read per tile is slow) */
  private stage = document.createElement('canvas');
  private sx = this.stage.getContext('2d')!;
  /** Read the atlas back (once per frame) */
  stageFrom(src: HTMLCanvasElement): void {
    if (this.stage.width !== src.width || this.stage.height !== src.height) { this.stage.width = src.width; this.stage.height = src.height; }
    else this.sx.clearRect(0, 0, src.width, src.height);
    this.sx.drawImage(src, 0, 0);
  }
  /** Copy cell i of the atlas into tile i */
  blit(src: HTMLCanvasElement, cell: number): void {
    this.stageFrom(src);
    this.slice(cell);
  }
  /** Copy cell i of the last staged frame into tile i (2D to 2D: cheap) */
  slice(cell: number): void {
    this.tiles.forEach((t, i) => {
      if (t.c.width !== cell || t.c.height !== cell) { t.c.width = cell; t.c.height = cell; }
      t.x.clearRect(0, 0, cell, cell);
      t.x.drawImage(this.stage, i * cell, 0, cell, cell, 0, 0, cell, cell);
    });
  }
  clear(): void {
    for (const t of this.tiles) { t.c.remove(); t.el.classList.remove('sd-live'); }
    this.tiles = [];
    this.stage.width = this.stage.height = 0;
  }
}

/** rAF loop that runs only while the dock is on screen, the tab visible and motion allowed */
export class Driver {
  private raf = 0;
  private onScreen = true;
  private io: IntersectionObserver;
  private reduce = matchMedia('(prefers-reduced-motion: reduce)');
  private onVis = () => this.kick();
  private onMotion = () => this.kick();
  constructor(private target: HTMLElement, private frame: (now: number) => void) {
    this.io = new IntersectionObserver((es) => { this.onScreen = es[es.length - 1].isIntersecting; this.kick(); });
    this.io.observe(target);
    document.addEventListener('visibilitychange', this.onVis);
    this.reduce.addEventListener('change', this.onMotion);
  }
  get running(): boolean { return this.raf !== 0; }
  private held = false;
  private live(): boolean { return !this.held && this.onScreen && !document.hidden && !this.reduce.matches; }
  hold(on: boolean): void { this.held = on; if (!on) this.kick(); }
  kick(): void {
    if (this.live() && !this.raf) {
      const loop = (now: number) => { this.frame(now); this.raf = this.live() ? requestAnimationFrame(loop) : 0; };
      this.raf = requestAnimationFrame(loop);
    }
  }
  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.io.disconnect();
    document.removeEventListener('visibilitychange', this.onVis);
    this.reduce.removeEventListener('change', this.onMotion);
  }
}

/** Pointer position over the dock (0..1), eased; listeners live only as long as the engine */
export class Pointer {
  pos: [number, number] = [.5, .5];
  private target: [number, number] = [.5, .5];
  private move = (e: PointerEvent) => {
    const r = this.el.getBoundingClientRect();
    this.target = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  private leave = () => { this.target = [.5, .5]; };
  constructor(private el: HTMLElement) {
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerleave', this.leave);
  }
  step(): void {
    this.pos[0] += (this.target[0] - this.pos[0]) * .06;
    this.pos[1] += (this.target[1] - this.pos[1]) * .06;
  }
  private on = true;
  dispose(): void {
    if (!this.on) return;
    this.on = false;
    this.el.removeEventListener('pointermove', this.move);
    this.el.removeEventListener('pointerleave', this.leave);
  }
}

/** The atlas cell size in device pixels: the dock tile's size */
export function cellSize(dock: HTMLElement): number {
  const t = dock.querySelector<HTMLElement>('.sd-ic');
  const css = t?.offsetWidth || 45;
  return Math.max(16, Math.round(css * Math.min(window.devicePixelRatio || 1, 2)));
}

export function createShaderEngine(mode: 0 | 1, dock: HTMLElement, theme: 'light' | 'dark'): LiveIconEngine | null {
  const atlas = document.createElement('canvas');
  const gl = atlas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true });
  if (!gl) return null;
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const pr = gl.createProgram()!;
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { gl.getExtension('WEBGL_lose_context')?.loseContext(); return null; }
  gl.useProgram(pr);
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n: string) => gl.getUniformLocation(pr, n);
  const u = { res: U('uRes'), time: U('uTime'), dark: U('uDark'), mode: U('uMode'), mouse: U('uMouse'), tile: U('uTile') };
  gl.uniform1f(u.mode, mode);
  let dark = theme === 'dark';
  const tiles = new TileCanvases();
  const pointer = mode === 1 ? new Pointer(dock) : null;
  const t0 = performance.now() * (Math.random() * .3 + 1);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let cell = cellSize(dock);

  const draw = (now: number, n = Math.max(1, tiles.tiles.length), blit = true) => {
    if (atlas.width !== n * cell || atlas.height !== cell) {
      atlas.width = n * cell; atlas.height = cell;
      gl.viewport(0, 0, atlas.width, atlas.height);
    }
    pointer?.step();
    gl.uniform2f(u.res, atlas.width, atlas.height);
    gl.uniform1f(u.tile, cell);
    gl.uniform1f(u.dark, dark ? 1 : 0);
    gl.uniform1f(u.time, reduce.matches ? 12 : (now + t0) / 1000);
    gl.uniform2f(u.mouse, pointer?.pos[0] ?? .5, pointer?.pos[1] ?? .5);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (blit) tiles.blit(atlas, cell);
  };
  const driver = new Driver(dock, (now) => draw(now));
  /** Tiles the atlas holds a ready frame for (prepare), 0 when stale */
  let prepared = 0;

  return {
    prepare(apps) { draw(performance.now(), Math.max(1, apps.length), false); tiles.stageFrom(atlas); prepared = Math.max(1, apps.length); },
    attach(els) {
      tiles.attach(els);
      const c = cellSize(dock);
      // The prepared frame is shown as is (copying it is cheap); otherwise draw one now
      if (prepared === els.length && c === cell) tiles.slice(cell);
      else { cell = c; draw(performance.now()); }
      prepared = 0;
      driver.kick();
    },
    setTheme(t) { dark = t === 'dark'; draw(performance.now()); },
    hold(on) { driver.hold(on); },
    freeze() { driver.dispose(); pointer?.dispose(); },
    dispose() {
      driver.dispose();
      pointer?.dispose();
      tiles.clear();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      atlas.width = atlas.height = 0;
    },
  };
}
