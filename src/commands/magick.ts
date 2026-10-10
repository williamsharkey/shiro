import { Command, CommandContext } from './index';

/**
 * convert / magick: ImageMagick via magick-wasm (WebAssembly), loaded from
 * the CDN on first use.
 *
 * The command line is read the way ImageMagick reads it: left to right,
 * settings (-size, -background, -fill, -font, -pointsize, -gravity ...)
 * apply to the images read after them, an image is a file or a pseudo-image
 * (xc:COLOR, canvas:COLOR, gradient:A-B, label:TEXT, caption:TEXT),
 * operators apply to the images read so far, and the last argument is the
 * output. Options the builtin doesn't know are an error (as in ImageMagick),
 * not file names. Debian's imagemagick (apt install imagemagick) replaces
 * these builtins once it is installed.
 *
 *   magick -size 600x120 xc:white -fill navy -pointsize 32 -gravity center -annotate +0+0 'Hello' t.png
 *   convert input.png -resize 50% -quality 80 output.jpg
 *   magick identify input.png
 */

const MAGICK_VERSION = '0.0.38';
const MAGICK_BASE = `https://cdn.jsdelivr.net/npm/@imagemagick/magick-wasm@${MAGICK_VERSION}/dist`;
/** Text needs a TrueType font: Debian's DejaVu Sans when it's there, else this copy */
const FONT_PATHS = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];
const FONT_URL = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf';
const DEFAULT_FONT = 'DejaVuSans';

type MagickModule = any;
let loader: () => Promise<MagickModule> = async () => {
  const mod = await import(/* @vite-ignore */ `${MAGICK_BASE}/index.js`);
  const wasm = new Uint8Array(await (await fetch(`${MAGICK_BASE}/magick.wasm`)).arrayBuffer());
  await mod.initializeImageMagick(wasm);
  return mod;
};
let loading: Promise<MagickModule> | null = null;

/** Tests load magick-wasm their own way (null restores the CDN) */
export function setMagickLoader(f: (() => Promise<MagickModule>) | null): void {
  loading = null;
  fontsAdded.clear();
  if (f) loader = f;
}

async function ensureMagick(ctx: CommandContext): Promise<MagickModule> {
  if (!loading) {
    if (ctx.terminal) ctx.terminal.writeOutput('Loading ImageMagick (WebAssembly, first time only)...\r\n');
    loading = loader().catch((e) => { loading = null; throw e; });
  }
  return loading;
}

const fontsAdded = new Set<string>();

/** Register `font` (a TrueType file in the filesystem, or the default) with magick-wasm; its name */
async function ensureFont(m: MagickModule, ctx: CommandContext, font: string | undefined): Promise<string> {
  const path = font && /\.(ttf|otf)$/i.test(font) ? ctx.fs.resolvePath(font, ctx.cwd) : undefined;
  const name = path ? path.replace(/^.*\//, '').replace(/\.\w+$/, '') : DEFAULT_FONT;
  if (fontsAdded.has(name)) return name;
  let bytes: Uint8Array | null = null;
  for (const p of path ? [path] : FONT_PATHS) {
    try { const d = await ctx.fs.readFile(p); bytes = typeof d === 'string' ? new TextEncoder().encode(d) : d; break; } catch { /* next */ }
  }
  if (!bytes && path) throw new Error(`unable to read font \`${font}'`);
  if (!bytes) bytes = new Uint8Array(await (await fetch(FONT_URL)).arrayBuffer());
  m.Magick.addFont(name, bytes);
  fontsAdded.add(name);
  return name;
}

const FORMATS: Record<string, string> = {
  png: 'Png', jpg: 'Jpeg', jpeg: 'Jpeg', gif: 'Gif', bmp: 'Bmp', webp: 'WebP', tiff: 'Tiff', tif: 'Tiff',
  ico: 'Ico', svg: 'Svg', pdf: 'Pdf', avif: 'Avif', ppm: 'Ppm', pgm: 'Pgm', tga: 'Tga',
};
function formatOf(filename: string): string {
  const m = /^([a-z0-9]+):/i.exec(filename);
  if (m && FORMATS[m[1].toLowerCase()]) return FORMATS[m[1].toLowerCase()];
  return FORMATS[filename.split('.').pop()?.toLowerCase() || ''] || 'Png';
}

// ── the command line ──

/** Options and how many arguments each takes */
const SETTINGS: Record<string, number> = {
  size: 1, background: 1, fill: 1, stroke: 1, strokewidth: 1, font: 1, pointsize: 1, gravity: 1,
  quality: 1, density: 1, depth: 1, bordercolor: 1, interline_spacing: 1, kerning: 1,
};
const OPERATORS: Record<string, number> = {
  resize: 1, scale: 1, sample: 1, thumbnail: 1, rotate: 1, flip: 0, flop: 0, grayscale: 1, colorspace: 1, type: 1,
  blur: 1, sharpen: 1, crop: 1, strip: 0, negate: 0, trim: 0, repage: 0, extent: 1, border: 1,
  annotate: 2, draw: 1, gamma: 1, transparent: 1, 'auto-orient': 0, 'sepia-tone': 1, modulate: 1,
  append: 0, monochrome: 0,
};
const NOOPS: Record<string, number> = { verbose: 0, quiet: 0, define: 1, units: 1, interlace: 1, alpha: 1, flatten: 0 };

export type Step =
  | { kind: 'setting'; name: string; plus: boolean; value: string }
  | { kind: 'op'; name: string; plus: boolean; args: string[] }
  | { kind: 'read'; spec: string };

/** Parse `magick` / `convert` arguments: the steps, and the output; or an error message */
export function parseCommandLine(args: string[]): { steps: Step[]; output: string } | { error: string } {
  if (args.length < 2) return { error: 'missing an image filename' };
  const output = args[args.length - 1];
  const steps: Step[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    const a = args[i];
    if (/^[-+][a-z]/i.test(a)) {
      const plus = a[0] === '+';
      const name = a.slice(1).toLowerCase();
      let n = SETTINGS[name] ?? OPERATORS[name] ?? NOOPS[name];
      if (n === undefined) return { error: `unrecognized option \`${a}'` };
      if (plus && name !== 'annotate') n = 0; // +repage, +append, +gravity: no argument
      // -grayscale [method], -colorspace Gray: accept the IM6 bare form too
      if (name === 'grayscale' && (i + 1 >= args.length - 1 || /^[-+]/.test(args[i + 1]) || /[.:/]/.test(args[i + 1]))) n = 0;
      const vals = args.slice(i + 1, i + 1 + n);
      if (vals.length < n || i + n >= args.length - 1) return { error: `option requires an argument \`${a}'` };
      i += n;
      if (name in SETTINGS) steps.push({ kind: 'setting', name, plus, value: vals[0] ?? '' });
      else if (name in OPERATORS) steps.push({ kind: 'op', name, plus, args: vals });
    } else {
      steps.push({ kind: 'read', spec: a });
    }
  }
  if (!steps.some((s) => s.kind === 'read')) return { error: 'no images defined' };
  return { steps, output };
}

/** "WxH+X+Y" pieces (any may be missing); percent when it ends with % */
function geometry(g: string): { w?: number; h?: number; x?: number; y?: number; pct: boolean } {
  const m = /^(\d+(?:\.\d+)?)?(?:x(\d+(?:\.\d+)?))?%?([+-]\d+)?([+-]\d+)?/.exec(g.trim()) ?? [];
  return { w: m[1] ? +m[1] : undefined, h: m[2] ? +m[2] : undefined, x: m[3] ? +m[3] : undefined, y: m[4] ? +m[4] : undefined, pct: g.includes('%') };
}

function gravityOf(m: MagickModule, g: string | undefined): number | undefined {
  if (!g) return undefined;
  const key = Object.keys(m.Gravity).find((k) => k.toLowerCase() === g.toLowerCase().replace(/[^a-z]/g, ''));
  return key ? m.Gravity[key] : undefined;
}

/** Run the steps; the output's bytes */
async function run(m: MagickModule, ctx: CommandContext, steps: Step[], output: string): Promise<Uint8Array> {
  const set: Record<string, string> = {};
  let images: any[] = [];
  const color = (c: string) => new m.MagickColor(c);
  const textFont = async () => ensureFont(m, ctx, set.font);
  try {
    for (const s of steps) {
      if (s.kind === 'setting') {
        if (s.plus) delete set[s.name]; else set[s.name] = s.value;
        continue;
      }
      if (s.kind === 'read') {
        const rs = new m.MagickReadSettings();
        const size = set.size ? geometry(set.size) : null;
        if (size?.w) rs.width = size.w;
        if (size?.h) rs.height = size.h;
        if (set.background) rs.backgroundColor = color(set.background);
        if (set.density) rs.density = new m.Density(parseFloat(set.density));
        const img = m.MagickImage.create();
        const pseudo = /^(xc|canvas|gradient|radial-gradient|label|caption|pattern|plasma|null):/i.exec(s.spec)?.[1]?.toLowerCase();
        if (pseudo === 'label' || pseudo === 'caption') {
          rs.font = await textFont();
          if (set.pointsize) rs.fontPointsize = parseFloat(set.pointsize);
          if (set.fill) rs.fillColor = color(set.fill);
          if (set.gravity) rs.textGravity = gravityOf(m, set.gravity);
          img.read(s.spec, rs);
        } else if (pseudo) {
          img.read(pseudo === 'canvas' ? 'xc:' + s.spec.slice(7) : s.spec, rs);
        } else {
          const path = ctx.fs.resolvePath(s.spec.replace(/\[\d+\]$/, ''), ctx.cwd);
          let data: Uint8Array;
          try {
            const d = await ctx.fs.readFile(path);
            data = typeof d === 'string' ? new TextEncoder().encode(d) : d;
          } catch {
            throw new Error(`unable to open image \`${s.spec}': No such file or directory`);
          }
          img.read(data, rs);
        }
        images.push(img);
        continue;
      }
      // operators: on every image so far
      const [a0, a1] = s.args;
      if (s.name === 'append') {
        if (images.length > 1) {
          const coll = m.MagickImageCollection.create();
          for (const im of images) coll.push(im);
          let joined: any = null;
          // (the joined image lives only in the callback: copied out losslessly)
          const take = (im: any) => im.write(m.MagickFormat.Miff, (d: Uint8Array) => { joined = m.MagickImage.create(); joined.read(new Uint8Array(d)); });
          if (s.plus) coll.appendHorizontally(take); else coll.appendVertically(take);
          coll.dispose(); // (disposes the images in it)
          images = joined ? [joined] : [];
        }
        continue;
      }
      for (const img of images) {
        switch (s.name) {
          case 'resize': case 'scale': case 'sample': case 'thumbnail': {
            const g = geometry(a0);
            const w = g.pct ? Math.round(img.width * (g.w ?? 100) / 100) : g.w ?? 0;
            const h = g.pct ? Math.round(img.height * (g.h ?? g.w ?? 100) / 100) : g.h ?? 0;
            const geo = new m.MagickGeometry(w, h);
            if (a0.includes('!')) geo.ignoreAspectRatio = true;
            if (s.name === 'thumbnail') img.thumbnail(geo); else img.resize(geo);
            break;
          }
          case 'rotate': img.rotate(parseFloat(a0) || 0); break;
          case 'flip': img.flip(); break;
          case 'flop': img.flop(); break;
          case 'grayscale': case 'monochrome': img.grayscale(); break;
          case 'colorspace': case 'type':
            if (/^gr[ae]y/i.test(a0) || /^grayscale/i.test(a0)) img.grayscale();
            break;
          case 'blur': { const [r, sg] = a0.split('x').map(Number); img.blur(r || 0, sg || r || 1); break; }
          case 'sharpen': { const [r, sg] = a0.split('x').map(Number); img.sharpen(r || 0, sg || r || 1); break; }
          case 'crop': {
            const g = geometry(a0);
            img.crop(new m.MagickGeometry(g.x ?? 0, g.y ?? 0, g.w ?? img.width, g.h ?? img.height));
            break;
          }
          case 'strip': img.strip(); break;
          case 'negate': img.negate(); break;
          case 'trim': img.trim(); break;
          case 'repage': img.resetPage(); break;
          case 'auto-orient': img.autoOrient(); break;
          case 'gamma': img.gammaCorrect(parseFloat(a0) || 1); break;
          case 'sepia-tone': img.sepiaTone(new m.Percentage(parseFloat(a0) || 80)); break;
          case 'modulate': {
            const [b, sat, hue] = a0.split(',').map((v) => new m.Percentage(parseFloat(v)));
            img.modulate(b, sat ?? new m.Percentage(100), hue ?? new m.Percentage(100));
            break;
          }
          case 'transparent': img.transparent(color(a0)); break;
          case 'extent': {
            const g = geometry(a0);
            if (set.background) img.backgroundColor = color(set.background);
            img.extent(new m.MagickGeometry(g.w ?? img.width, g.h ?? img.height), gravityOf(m, set.gravity) ?? m.Gravity.Northwest);
            break;
          }
          case 'border': {
            const g = geometry(a0);
            if (set.bordercolor) img.borderColor = color(set.bordercolor);
            img.border(g.w ?? 0, g.h ?? g.w ?? 0);
            break;
          }
          case 'annotate': {
            // -annotate geometry text: an offset (+X+Y) from where -gravity puts it, or the top left
            const g = geometry(a0);
            const font = await textFont();
            const draw: any[] = [new m.DrawableFont(font)];
            if (set.pointsize) draw.push(new m.DrawableFontPointSize(parseFloat(set.pointsize)));
            draw.push(new m.DrawableFillColor(color(set.fill ?? 'black')));
            if (set.stroke) draw.push(new m.DrawableStrokeColor(color(set.stroke)));
            if (set.strokewidth) draw.push(new m.DrawableStrokeWidth(parseFloat(set.strokewidth)));
            const grav = gravityOf(m, set.gravity);
            if (grav !== undefined) draw.push(new m.DrawableGravity(grav));
            draw.push(new m.DrawableText(g.x ?? 0, g.y ?? (grav === undefined ? parseFloat(set.pointsize ?? '12') : 0), a1));
            img.draw(draw);
            break;
          }
          case 'draw': {
            const d = await drawables(m, a0, set, textFont);
            img.draw(d);
            break;
          }
        }
      }
    }
    const fmt = m.MagickFormat[formatOf(output)];
    const out = images[images.length - 1];
    if (!out) throw new Error('no images defined');
    if (set.quality) out.quality = parseInt(set.quality, 10);
    let bytes: Uint8Array | null = null;
    out.write(fmt, (d: Uint8Array) => { bytes = new Uint8Array(d); });
    if (!bytes) throw new Error('unable to write the output');
    return bytes;
  } finally {
    for (const img of images) { try { img.dispose(); } catch { /* gone */ } }
  }
}

/** -draw primitives: text X,Y 'str', rectangle/roundrectangle X0,Y0 X1,Y1, line X0,Y0 X1,Y1, point X,Y */
async function drawables(m: MagickModule, spec: string, set: Record<string, string>, font: () => Promise<string>): Promise<any[]> {
  const out: any[] = [];
  if (set.fill) out.push(new m.DrawableFillColor(new m.MagickColor(set.fill)));
  if (set.stroke) out.push(new m.DrawableStrokeColor(new m.MagickColor(set.stroke)));
  if (set.strokewidth) out.push(new m.DrawableStrokeWidth(parseFloat(set.strokewidth)));
  const nums = (s: string) => (s.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const t = /^\s*text\s+(-?[\d.]+)\s*,\s*(-?[\d.]+)\s+(['"])([\s\S]*)\3\s*$/i.exec(spec);
  if (t) {
    out.push(new m.DrawableFont(await font()));
    if (set.pointsize) out.push(new m.DrawableFontPointSize(parseFloat(set.pointsize)));
    const grav = set.gravity ? Object.keys(m.Gravity).find((k) => k.toLowerCase() === set.gravity.toLowerCase()) : undefined;
    if (grav) out.push(new m.DrawableGravity(m.Gravity[grav]));
    out.push(new m.DrawableText(+t[1], +t[2], t[4]));
    return out;
  }
  const [kind, ...rest] = spec.trim().split(/\s+/);
  const n = nums(rest.join(' '));
  switch (kind.toLowerCase()) {
    case 'rectangle': out.push(new m.DrawableRectangle(n[0], n[1], n[2], n[3])); break;
    case 'roundrectangle': out.push(new m.DrawableRoundRectangle(n[0], n[1], n[2], n[3], n[4] ?? 0, n[5] ?? n[4] ?? 0)); break;
    case 'line': out.push(new m.DrawableLine(n[0], n[1], n[2], n[3])); break;
    case 'point': out.push(new m.DrawableRectangle(n[0], n[1], n[0], n[1])); break;
    default: throw new Error(`non-conforming drawing primitive definition \`${kind}'`);
  }
  return out;
}

const USAGE = [
  'Usage: magick [settings] image... [operators] output',
  '       convert input [options] output',
  '',
  'Settings (for the images read after them):',
  '  -size WxH  -background C  -fill C  -stroke C  -strokewidth N  -font F.ttf',
  '  -pointsize N  -gravity G  -quality N  -density N  -bordercolor C',
  'Images: FILE, xc:COLOR, canvas:COLOR, gradient:A-B, label:TEXT, caption:TEXT',
  'Operators:',
  '  -resize WxH|N%  -thumbnail WxH  -rotate N  -flip  -flop  -grayscale',
  '  -blur R[xS]  -sharpen R[xS]  -crop WxH+X+Y  -extent WxH  -border N',
  '  -annotate +X+Y TEXT  -draw "text X,Y \'str\'" | "rectangle X0,Y0 X1,Y1"',
  '  -negate  -trim  +repage  -strip  -gamma N  -modulate B,S,H  -append  +append',
  '',
  'Examples:',
  '  magick -size 600x120 xc:white -fill navy -pointsize 32 -gravity center -annotate +0+0 Hello t.png',
  '  convert photo.png -resize 50% small.png',
  '  magick identify photo.png',
  '',
].join('\n');

async function convert(ctx: CommandContext, prog: string): Promise<number> {
  const args = ctx.args;
  if (args.length === 0 || args.includes('--help') || args.includes('-help')) { ctx.stdout = USAGE; return 0; }
  if (args.includes('--version') || args.includes('-version')) {
    ctx.stdout = `Version: ImageMagick (magick-wasm ${MAGICK_VERSION}), tabcomputer's builtin\n`;
    return 0;
  }
  const parsed = parseCommandLine(args);
  if ('error' in parsed) { ctx.stderr = `${prog}: ${parsed.error}.\n`; return 1; }
  // Input files first: a missing one is an error without loading anything
  for (const s of parsed.steps) {
    if (s.kind !== 'read' || /^[a-z-]+:/i.test(s.spec)) continue;
    if (!(await ctx.fs.exists(ctx.fs.resolvePath(s.spec.replace(/\[\d+\]$/, ''), ctx.cwd)))) {
      ctx.stderr = `${prog}: unable to open image \`${s.spec}': No such file or directory.\n`;
      return 1;
    }
  }
  let m: MagickModule;
  try { m = await ensureMagick(ctx); } catch (err: any) {
    ctx.stderr = `${prog}: failed to load ImageMagick (magick-wasm): ${err?.message ?? err}\n`;
    return 1;
  }
  try {
    const bytes = await run(m, ctx, parsed.steps, parsed.output);
    const outPath = ctx.fs.resolvePath(parsed.output.replace(/^[a-z0-9]+:/i, ''), ctx.cwd);
    await ctx.fs.writeFile(outPath, bytes);
    return 0;
  } catch (err: any) {
    ctx.stderr = `${prog}: ${err?.message ?? err}\n`;
    return 1;
  }
}

async function identify(ctx: CommandContext, prog: string, files: string[]): Promise<number> {
  if (!files.length) { ctx.stderr = `${prog}: missing an image filename.\n`; return 1; }
  let m: MagickModule;
  try { m = await ensureMagick(ctx); } catch (err: any) {
    ctx.stderr = `${prog}: failed to load ImageMagick (magick-wasm): ${err?.message ?? err}\n`;
    return 1;
  }
  let code = 0;
  for (const f of files) {
    try {
      const d = await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd));
      const data = typeof d === 'string' ? new TextEncoder().encode(d) : d;
      m.ImageMagick.read(data, (img: any) => {
        ctx.stdout += `${f} ${String(img.format).toUpperCase()} ${img.width}x${img.height} ${img.width}x${img.height}+0+0 ${img.depth}-bit ${data.length}B\n`;
      });
    } catch {
      ctx.stderr += `${prog}: unable to open image \`${f}': No such file or directory.\n`;
      code = 1;
    }
  }
  return code;
}

export const convertCmd: Command = {
  name: 'convert',
  description: 'ImageMagick image conversion (magick-wasm)',
  exec: (ctx) => convert(ctx, 'convert'),
};

export const magickCmd: Command = {
  name: 'magick',
  description: 'ImageMagick (magick-wasm)',
  async exec(ctx: CommandContext): Promise<number> {
    const [sub, ...rest] = ctx.args;
    if (sub === 'identify') return identify(ctx, 'magick identify', rest.filter((a) => !a.startsWith('-')));
    if (sub === 'convert') return convert({ ...ctx, args: rest } as CommandContext, 'magick').then((c) => c);
    return convert(ctx, 'magick');
  },
};
