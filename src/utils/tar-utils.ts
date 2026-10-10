/**
 * tar-utils.ts: Browser-native gzip decompression and tar extraction
 *
 * Uses DecompressionStream API (supported in modern browsers) for gzip
 * Implements tar extraction from scratch (tar format is simple)
 */

/**
 * Decompress gzip data using browser-native DecompressionStream
 */
export async function gunzip(compressedData: Uint8Array): Promise<Uint8Array> {
  // Check if DecompressionStream is available
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream not supported in this browser');
  }

  // Create a readable stream from the compressed data
  // Wrap in Blob and use type assertion to work around strict TypeScript types
  const blob = new Blob([compressedData.buffer as ArrayBuffer]);
  const stream = new Response(blob).body;
  if (!stream) {
    throw new Error('Failed to create stream from compressed data');
  }

  // Pipe through decompression stream
  const decompressedStream = stream.pipeThrough(
    new DecompressionStream('gzip')
  );

  // Read all chunks into array
  const reader = decompressedStream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  // Combine chunks into single Uint8Array
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * TAR file header structure (512 bytes)
 */
interface TarHeader {
  name: string;
  mode: string;
  uid: string;
  gid: string;
  size: number;
  mtime: string;
  checksum: string;
  typeflag: string;
  linkname: string;
  ustarIndicator: string;
  ustarVersion: string;
  uname: string;
  gname: string;
  devmajor: string;
  devminor: string;
  prefix: string;
}

/**
 * Extracted file from tar archive
 */
export interface TarEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  mode: number;
  size: number;
  mtime: Date;
  data?: Uint8Array;
  linkname?: string;
}

/**
 * Parse a tar header (512 bytes)
 */
function parseTarHeader(headerBytes: Uint8Array): TarHeader | null {
  // Check if this is a null header (end of archive)
  let isNull = true;
  for (let i = 0; i < 512; i++) {
    if (headerBytes[i] !== 0) {
      isNull = false;
      break;
    }
  }
  if (isNull) return null;

  const decoder = new TextDecoder('ascii');

  // Helper to extract null-terminated string
  const getString = (start: number, length: number): string => {
    const slice = headerBytes.slice(start, start + length);
    const nullIndex = slice.indexOf(0);
    return decoder.decode(nullIndex >= 0 ? slice.slice(0, nullIndex) : slice).trim();
  };

  // Helper to parse octal number
  const getOctal = (start: number, length: number): number => {
    const str = getString(start, length);
    return str ? parseInt(str, 8) : 0;
  };

  return {
    name: getString(0, 100),
    mode: getString(100, 8),
    uid: getString(108, 8),
    gid: getString(116, 8),
    size: getOctal(124, 12),
    mtime: getString(136, 12),
    checksum: getString(148, 8),
    typeflag: getString(156, 1),
    linkname: getString(157, 100),
    ustarIndicator: getString(257, 6),
    ustarVersion: getString(263, 2),
    uname: getString(265, 32),
    gname: getString(297, 32),
    devmajor: getString(329, 8),
    devminor: getString(337, 8),
    prefix: getString(345, 155),
  };
}

/**
 * Extract all files from a tar archive
 */
export async function untar(tarData: Uint8Array): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset < tarData.length) {
    // Read header (512 bytes)
    if (offset + 512 > tarData.length) {
      break; // Incomplete header, end of archive
    }

    const headerBytes = tarData.slice(offset, offset + 512);
    const header = parseTarHeader(headerBytes);

    if (!header) {
      // Null header indicates end of archive
      break;
    }

    offset += 512;

    // Construct full path (prefix + name for long filenames)
    let fullPath = header.prefix ? `${header.prefix}/${header.name}` : header.name;

    // npm tarballs often have a package/ prefix, normalize it
    if (fullPath.startsWith('package/')) {
      fullPath = fullPath.slice(8);
    }

    // Determine file type
    let type: 'file' | 'directory' | 'symlink' = 'file';
    if (header.typeflag === '5') {
      type = 'directory';
    } else if (header.typeflag === '2') {
      type = 'symlink';
    }

    // Read file data if present
    // (an empty file is a file too: @astrojs/markdown-remark ships a 0-byte types.js it imports)
    let data: Uint8Array | undefined = type === 'file' ? new Uint8Array(0) : undefined;
    if (header.size > 0 && type === 'file') {
      if (offset + header.size > tarData.length) {
        throw new Error(`Incomplete tar file: expected ${header.size} bytes at offset ${offset}`);
      }
      data = tarData.slice(offset, offset + header.size);
    }

    // Calculate padding (tar blocks are 512-byte aligned)
    const paddingSize = (512 - (header.size % 512)) % 512;
    offset += header.size + paddingSize;

    // Parse mode
    const mode = header.mode ? parseInt(header.mode, 8) : 0o644;

    // Parse mtime
    const mtime = new Date(parseInt(header.mtime, 8) * 1000);

    entries.push({
      name: fullPath,
      type,
      mode,
      size: header.size,
      mtime,
      data,
      linkname: header.linkname || undefined,
    });
  }

  return entries;
}

/**
 * The files of a .tar.gz that `want` picks, read as the archive streams in:
 * nothing else is copied, and neither the archive nor its decompressed bytes
 * are ever whole in memory. (Claude Code's tarball is 19 MB, 60 MB unpacked,
 * mostly other platforms' binaries; tabcomputer keeps its 14 MB cli.js. The
 * page held all of it while a node guest loaded cli.js.)
 */
export async function extractTarGzFiles(source: ReadableStream<Uint8Array> | Uint8Array, want: (name: string) => boolean): Promise<TarEntry[]> {
  const input = source instanceof Uint8Array ? new Response(new Blob([source.buffer as ArrayBuffer])).body! : source;
  const reader = (input.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)).getReader();
  const chunks: Uint8Array[] = [];
  let have = 0;
  let ended = false;
  const fill = async (n: number) => {
    while (have < n && !ended) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      chunks.push(value); have += value.length;
    }
    return have >= n;
  };
  /** The next n bytes, copied out (or skipped: null) */
  const take = async (n: number, keep: boolean): Promise<Uint8Array | null | undefined> => {
    const out = keep ? new Uint8Array(n) : null;
    let got = 0;
    while (got < n) {
      if (!chunks.length && !(await fill(1))) return undefined;
      const c = chunks[0];
      const k = Math.min(c.length, n - got);
      if (out) out.set(c.subarray(0, k), got);
      got += k; have -= k;
      if (k === c.length) chunks.shift(); else chunks[0] = c.subarray(k);
    }
    return out;
  };
  const entries: TarEntry[] = [];
  try {
    for (;;) {
      const headerBytes = await take(512, true);
      if (!headerBytes) break;
      const header = parseTarHeader(headerBytes);
      if (!header) break;
      let fullPath = header.prefix ? `${header.prefix}/${header.name}` : header.name;
      if (fullPath.startsWith('package/')) fullPath = fullPath.slice(8);
      const type: TarEntry['type'] = header.typeflag === '5' ? 'directory' : header.typeflag === '2' ? 'symlink' : 'file';
      const padded = header.size + ((512 - (header.size % 512)) % 512);
      const keep = want(fullPath);
      const data = await take(header.size, keep && type === 'file');
      if (data === undefined) throw new Error(`Incomplete tar file: ${fullPath}`);
      await take(padded - header.size, false);
      if (!keep) continue;
      entries.push({
        name: fullPath, type, mode: header.mode ? parseInt(header.mode, 8) : 0o644, size: header.size,
        mtime: new Date(parseInt(header.mtime, 8) * 1000), data: type === 'file' ? data ?? new Uint8Array(0) : undefined,
        linkname: header.linkname || undefined,
      });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return entries;
}

/**
 * Extract tar.gz (tgz) archive
 */
export async function extractTarGz(compressedData: Uint8Array): Promise<TarEntry[]> {
  const decompressed = await gunzip(compressedData);
  return untar(decompressed);
}

/**
 * Extract tar.gz to filesystem
 */
export interface FileSystemWriter {
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  symlink?(target: string, path: string): Promise<void>;
}

/**
 * Recursively create directories (like mkdir -p)
 */
async function ensureDirRecursive(path: string, fs: FileSystemWriter): Promise<void> {
  const parts = path.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += '/' + part;
    try {
      await fs.mkdir(current);
    } catch (e: any) {
      if (!e.message?.includes('EEXIST')) throw e;
    }
  }
}

export async function extractTarGzToFS(
  compressedData: Uint8Array,
  baseDir: string,
  fs: FileSystemWriter
): Promise<void> {
  const entries = await extractTarGz(compressedData);

  // Sort entries so directories come before files
  entries.sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return 0;
  });

  for (const entry of entries) {
    if (!entry.name || entry.name === '.') continue;

    const fullPath = `${baseDir}/${entry.name}`;

    if (entry.type === 'directory') {
      try {
        await fs.mkdir(fullPath);
      } catch (e) {
        // Directory might already exist, that's ok
      }
    } else if (entry.type === 'file' && entry.data) {
      // Ensure parent directory exists before writing file
      const parentDir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      if (parentDir && parentDir !== baseDir) {
        try {
          await ensureDirRecursive(parentDir, fs);
        } catch (e) {
          // Ignore if already exists
        }
      }
      await fs.writeFile(fullPath, entry.data);
    } else if (entry.type === 'symlink' && entry.linkname && fs.symlink) {
      await fs.symlink(entry.linkname, fullPath);
    }
  }
}
