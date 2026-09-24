/**
 * `sharp` for the browser: the subset Claude Code and typical scripts use
 * (metadata, resize, jpeg/png/webp output, toBuffer/toFile), implemented with
 * createImageBitmap and a canvas. The native module can't load in a page, and
 * Claude Code's own bundled copy stalled image reads, so its loader is pointed
 * here instead (see CAPABILITY_PATCHES in claude-code-version.ts).
 */

type OutFormat = 'jpeg' | 'png' | 'webp';

interface ResizeOpts { fit?: string; withoutEnlargement?: boolean; width?: number; height?: number }

function sniffFormat(b: Uint8Array): string | undefined {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b[0] === 0x3c) return 'svg';
  return undefined;
}

async function decode(bytes: Uint8Array): Promise<ImageBitmap> {
  const type = sniffFormat(bytes);
  const blob = new Blob([bytes as BlobPart], type === 'svg' ? { type: 'image/svg+xml' } : type ? { type: `image/${type}` } : {});
  return createImageBitmap(blob);
}

async function encode(bitmap: ImageBitmap, w: number, h: number, format: OutFormat, quality?: number): Promise<Uint8Array> {
  const type = `image/${format}`;
  const q = quality === undefined ? undefined : Math.max(0, Math.min(1, quality / 100));
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext('2d')!;
    if (format === 'jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); } // no alpha in JPEG
    g.drawImage(bitmap, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type, quality: q });
    return new Uint8Array(await blob.arrayBuffer());
  }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d')!;
  if (format === 'jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }
  g.drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, q));
  if (!blob) throw new Error(`sharp: could not encode ${format}`);
  return new Uint8Array(await blob.arrayBuffer());
}

/** Target size for sharp's resize(width, height, { fit }) */
function targetSize(srcW: number, srcH: number, r: ResizeOpts): [number, number] {
  let w = r.width, h = r.height;
  if (!w && !h) return [srcW, srcH];
  if (w && !h) h = Math.round(srcH * w / srcW);
  else if (h && !w) w = Math.round(srcW * h / srcH);
  else if (r.fit === 'inside' || r.fit === 'contain' || r.fit === 'outside') {
    const scale = r.fit === 'outside' ? Math.max(w! / srcW, h! / srcH) : Math.min(w! / srcW, h! / srcH);
    w = Math.round(srcW * scale); h = Math.round(srcH * scale);
  }
  if (r.withoutEnlargement && (w! > srcW || h! > srcH)) return [srcW, srcH];
  return [Math.max(1, w!), Math.max(1, h!)];
}

export function createBrowserSharp(toNodeBuffer: (bytes: Uint8Array) => any, readFile: (path: string) => Promise<Uint8Array>, writeFile: (path: string, data: Uint8Array) => Promise<void>): any {
  const sharp: any = (input?: any) => {
    let resize: ResizeOpts | null = null;
    let format: OutFormat | null = null;
    let quality: number | undefined;
    let bytesP: Promise<Uint8Array> | null = null;
    const bytes = () => bytesP ??= (async () => {
      if (typeof input === 'string') return readFile(input);
      if (input instanceof ArrayBuffer) return new Uint8Array(input);
      if (input instanceof Uint8Array) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      throw new Error('sharp: unsupported input');
    })();

    const render = async (): Promise<{ data: Uint8Array; info: any }> => {
      const src = await bytes();
      const srcFormat = sniffFormat(src);
      if (!resize && (!format || format === srcFormat) && quality === undefined) {
        const bmp = await decode(src);
        const info = { format: srcFormat, width: bmp.width, height: bmp.height, size: src.length, channels: 4 };
        bmp.close?.();
        return { data: src, info };
      }
      const bmp = await decode(src);
      const [w, h] = resize ? targetSize(bmp.width, bmp.height, resize) : [bmp.width, bmp.height];
      const out = format ?? (srcFormat === 'jpeg' ? 'jpeg' : srcFormat === 'webp' ? 'webp' : 'png');
      const data = await encode(bmp, w, h, out, quality ?? (out === 'png' ? undefined : 80));
      bmp.close?.();
      return { data, info: { format: out, width: w, height: h, size: data.length, channels: out === 'jpeg' ? 3 : 4 } };
    };

    const self = () => instance;
    const instance: any = {
      metadata: async () => {
        const src = await bytes();
        const bmp = await decode(src);
        const meta = { format: sniffFormat(src), width: bmp.width, height: bmp.height, size: src.length,
          channels: 4, hasAlpha: sniffFormat(src) !== 'jpeg', space: 'srgb', density: 72, orientation: undefined };
        bmp.close?.();
        return meta;
      },
      resize: (w?: number | ResizeOpts | null, h?: number | null, opts?: ResizeOpts) => {
        if (w && typeof w === 'object') resize = { ...w };
        else resize = { ...opts, width: w ?? undefined, height: h ?? undefined };
        return instance;
      },
      jpeg: (o?: { quality?: number } | number) => { format = 'jpeg'; quality = typeof o === 'number' ? o : o?.quality; return instance; },
      png: () => { format = 'png'; return instance; },
      webp: (o?: { quality?: number } | number) => { format = 'webp'; quality = typeof o === 'number' ? o : o?.quality; return instance; },
      toFormat: (f: string, o?: { quality?: number }) => {
        const name = f === 'jpg' ? 'jpeg' : f;
        if (name === 'jpeg' || name === 'png' || name === 'webp') { format = name; quality = o?.quality; }
        return instance;
      },
      toBuffer: async (opts?: { resolveWithObject?: boolean }) => {
        const { data, info } = await render();
        return opts?.resolveWithObject ? { data: toNodeBuffer(data), info } : toNodeBuffer(data);
      },
      toFile: async (path: string) => {
        const { data, info } = await render();
        await writeFile(path, data);
        return info;
      },
      stats: async () => ({ channels: [], isOpaque: true }),
      clone: () => sharp(input),
      withMetadata: self, rotate: self, flip: self, flop: self, flatten: self, removeAlpha: self,
      ensureAlpha: self, normalize: self, normalise: self, sharpen: self, blur: self, greyscale: self,
      grayscale: self, trim: self, extend: self, extract: self, composite: self, modulate: self, tint: self,
      avif: self, gif: self, tiff: self, timeout: self, toColourspace: self, toColorspace: self,
    };
    return instance;
  };
  sharp.cache = () => {};
  sharp.concurrency = () => 1;
  sharp.counters = () => ({});
  sharp.simd = () => false;
  sharp.format = { jpeg: { id: 'jpeg' }, png: { id: 'png' }, webp: { id: 'webp' } };
  sharp.versions = { sharp: '0.34.5-shiro-browser' };
  sharp.default = sharp;
  return sharp;
}
