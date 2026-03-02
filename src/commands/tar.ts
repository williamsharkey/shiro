
import type { Command } from './index';
import { parseArgs, readFileText, readdirEntries, statEntry } from './flags';

// POSIX ustar 512-byte block format
const BLOCK_SIZE = 512;

function makeUstarHeader(
  name: string, size: number, mtime: number, isDir: boolean, prefix?: string,
): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE);
  const enc = new TextEncoder();

  // Handle long names via prefix field (ustar)
  let fileName = name;
  let filePrefix = prefix || '';
  if (fileName.length > 100 && !filePrefix) {
    const slash = fileName.lastIndexOf('/', 155);
    if (slash > 0) {
      filePrefix = fileName.slice(0, slash);
      fileName = fileName.slice(slash + 1);
    }
  }

  // name (100 bytes)
  const nameBytes = enc.encode(fileName.slice(0, 100));
  header.set(nameBytes, 0);

  // mode (8 bytes octal)
  const mode = isDir ? '0000755' : '0000644';
  header.set(enc.encode(mode.padStart(7, '0') + '\0'), 100);

  // uid (8 bytes)
  header.set(enc.encode('0001000\0'), 108);

  // gid (8 bytes)
  header.set(enc.encode('0001000\0'), 116);

  // size (12 bytes octal)
  const sizeOctal = isDir ? '00000000000' : size.toString(8).padStart(11, '0');
  header.set(enc.encode(sizeOctal + '\0'), 124);

  // mtime (12 bytes octal)
  const mtimeOctal = Math.floor(mtime / 1000).toString(8).padStart(11, '0');
  header.set(enc.encode(mtimeOctal + '\0'), 136);

  // Initially fill checksum with spaces for calculation
  for (let i = 148; i < 156; i++) header[i] = 0x20;

  // typeflag (1 byte): '5' = directory, '0' = regular file
  header[156] = isDir ? 0x35 : 0x30;

  // magic (6 bytes) "ustar\0"
  header.set(enc.encode('ustar\0'), 257);

  // version (2 bytes) "00"
  header.set(enc.encode('00'), 263);

  // uname (32 bytes)
  header.set(enc.encode('user'), 265);

  // gname (32 bytes)
  header.set(enc.encode('user'), 297);

  // prefix (155 bytes)
  if (filePrefix) {
    header.set(enc.encode(filePrefix.slice(0, 155)), 345);
  }

  // Calculate checksum (sum of all bytes, treating checksum field as spaces)
  let cksum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) cksum += header[i];
  const cksumStr = cksum.toString(8).padStart(6, '0') + '\0 ';
  header.set(enc.encode(cksumStr), 148);

  return header;
}

function parseUstarHeader(block: Uint8Array): {
  name: string; size: number; mtime: number; isDir: boolean; isEnd: boolean;
} {
  // Check for end-of-archive (two zero blocks)
  let allZero = true;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    if (block[i] !== 0) { allZero = false; break; }
  }
  if (allZero) return { name: '', size: 0, mtime: 0, isDir: false, isEnd: true };

  const dec = new TextDecoder();
  const readField = (off: number, len: number) => {
    const slice = block.slice(off, off + len);
    const nullIdx = slice.indexOf(0);
    return dec.decode(nullIdx >= 0 ? slice.slice(0, nullIdx) : slice);
  };

  const prefix = readField(345, 155);
  const name = (prefix ? prefix + '/' : '') + readField(0, 100);
  const size = parseInt(readField(124, 12), 8) || 0;
  const mtime = (parseInt(readField(136, 12), 8) || 0) * 1000;
  const typeflag = block[156];
  const isDir = typeflag === 0x35 || name.endsWith('/');

  return { name, size, mtime, isDir, isEnd: false };
}

function padToBlock(data: Uint8Array): Uint8Array {
  const remainder = data.length % BLOCK_SIZE;
  if (remainder === 0) return data;
  const padded = new Uint8Array(data.length + (BLOCK_SIZE - remainder));
  padded.set(data);
  return padded;
}

export const tar: Command = {
  name: "tar",
  description: "Archive utility (ustar format)",
  async exec(ctx) {
    const args = ctx.args;
    // Support combined flags without leading dash: tar czf → tar -czf
    let processedArgs = args;
    if (args.length > 0 && /^[a-zA-Z]{2,}$/.test(args[0]) && !args[0].startsWith('-')) {
      processedArgs = ['-' + args[0], ...args.slice(1)];
    }
    const { flags, values, positional } = parseArgs(processedArgs, ["f", "C"]);

    const create = flags.c || flags.create;
    const extract = flags.x || flags.extract;
    const list = flags.t || flags.list;
    const verbose = flags.v || flags.verbose;
    const gzip = flags.z;
    const file = values.f;
    const changeDir = values.C;

    let workingDir = ctx.cwd;
    if (changeDir) {
      workingDir = ctx.fs.resolvePath(changeDir, ctx.cwd);
    }

    const modes = [create, extract, list].filter(Boolean).length;
    if (modes === 0) {
      ctx.stderr += "tar: You must specify one of -c, -x, or -t\n";
      return 1;
    }
    if (modes > 1) {
      ctx.stderr += "tar: You may not specify more than one -c, -x, or -t\n";
      return 1;
    }

    try {
      if (create) {
        if (!file) {
          ctx.stderr += "tar: Refusing to write archive to terminal (missing -f option?)\n";
          return 1;
        }

        const filesToArchive = positional;
        if (filesToArchive.length === 0) {
          ctx.stderr += "tar: Cowardly refusing to create an empty archive\n";
          return 1;
        }

        const blocks: Uint8Array[] = [];
        const encoder = new TextEncoder();

        async function collectFiles(path: string, archivePath: string) {
          const resolved = ctx.fs.resolvePath(path, workingDir);
          const stat = await statEntry(ctx.fs, resolved);

          if (stat.type === "dir") {
            const dirPath = archivePath.endsWith('/') ? archivePath : archivePath + '/';
            blocks.push(makeUstarHeader(dirPath, 0, stat.mtime || Date.now(), true));
            if (verbose) ctx.stdout += dirPath + '\n';

            const items = await readdirEntries(ctx.fs, resolved);
            for (const item of items) {
              await collectFiles(resolved + "/" + item.name, archivePath + "/" + item.name);
            }
          } else {
            const content = await readFileText(ctx.fs, resolved);
            const contentBytes = encoder.encode(content);
            blocks.push(makeUstarHeader(archivePath, contentBytes.length, stat.mtime || Date.now(), false));
            blocks.push(padToBlock(contentBytes));
            if (verbose) ctx.stdout += archivePath + '\n';
          }
        }

        for (const f of filesToArchive) {
          await collectFiles(f, f);
        }

        // Two zero blocks at end
        blocks.push(new Uint8Array(BLOCK_SIZE));
        blocks.push(new Uint8Array(BLOCK_SIZE));

        // Concatenate all blocks
        const totalSize = blocks.reduce((s, b) => s + b.length, 0);
        let archiveData = new Uint8Array(totalSize);
        let offset = 0;
        for (const block of blocks) {
          archiveData.set(block, offset);
          offset += block.length;
        }

        // Gzip if requested
        if (gzip && typeof CompressionStream !== 'undefined') {
          const cs = new CompressionStream('gzip');
          const writer = cs.writable.getWriter();
          const reader = cs.readable.getReader();
          const chunks: Uint8Array[] = [];
          writer.write(archiveData as any);
          writer.close();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          const compressedSize = chunks.reduce((s, c) => s + c.length, 0);
          archiveData = new Uint8Array(compressedSize);
          let off = 0;
          for (const chunk of chunks) {
            archiveData.set(chunk, off);
            off += chunk.length;
          }
        }

        const archivePath = ctx.fs.resolvePath(file, ctx.cwd);
        await ctx.fs.writeFile(archivePath, archiveData);
        return 0;
      }

      if (extract || list) {
        if (!file) {
          ctx.stderr += `tar: Refusing to read archive from terminal (missing -f option?)\n`;
          return 1;
        }

        const archivePath = ctx.fs.resolvePath(file, ctx.cwd);
        let rawData: Uint8Array;
        const rawContent = await ctx.fs.readFile(archivePath);
        if (rawContent instanceof Uint8Array) {
          rawData = rawContent;
        } else {
          // Check for old FLUFFY-TAR-V1 format
          const strContent = rawContent as string;
          if (strContent.startsWith('FLUFFY-TAR-V1')) {
            return extract
              ? await extractOldFormat(strContent, ctx, workingDir, verbose)
              : listOldFormat(strContent, ctx);
          }
          rawData = new TextEncoder().encode(strContent);
        }

        // Decompress gzip if needed
        let archiveData = rawData;
        if (gzip || (rawData[0] === 0x1f && rawData[1] === 0x8b)) {
          if (typeof DecompressionStream !== 'undefined') {
            const ds = new DecompressionStream('gzip');
            const writer = ds.writable.getWriter();
            const reader = ds.readable.getReader();
            const chunks: Uint8Array[] = [];
            writer.write(rawData as any);
            writer.close();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
            const size = chunks.reduce((s, c) => s + c.length, 0);
            archiveData = new Uint8Array(size);
            let off = 0;
            for (const chunk of chunks) {
              archiveData.set(chunk, off);
              off += chunk.length;
            }
          }
        }

        // Also check if it's old format in binary form
        const dec = new TextDecoder();
        const firstLine = dec.decode(archiveData.slice(0, 14));
        if (firstLine === 'FLUFFY-TAR-V1\n' || firstLine.startsWith('FLUFFY-TAR-V1')) {
          const strContent = dec.decode(archiveData);
          return extract
            ? await extractOldFormat(strContent, ctx, workingDir, verbose)
            : listOldFormat(strContent, ctx);
        }

        // Parse ustar blocks
        let pos = 0;
        const extracted: string[] = [];

        while (pos + BLOCK_SIZE <= archiveData.length) {
          const headerBlock = archiveData.slice(pos, pos + BLOCK_SIZE);
          const hdr = parseUstarHeader(headerBlock);
          if (hdr.isEnd) break;
          pos += BLOCK_SIZE;

          if (list) {
            if (verbose) {
              const typeChar = hdr.isDir ? 'd' : '-';
              const sizeStr = String(hdr.size).padStart(8);
              const d = new Date(hdr.mtime);
              const dateStr = d.toISOString().slice(0, 16).replace('T', ' ');
              ctx.stdout += `${typeChar}rw-r--r-- user/user ${sizeStr} ${dateStr} ${hdr.name}\n`;
            } else {
              ctx.stdout += hdr.name + '\n';
            }
          }

          if (extract) {
            const targetPath = ctx.fs.resolvePath(hdr.name, workingDir);

            if (hdr.isDir) {
              await ctx.fs.mkdir(targetPath, { recursive: true });
            } else {
              // Ensure parent exists
              const lastSlash = targetPath.lastIndexOf('/');
              if (lastSlash > 0) {
                try { await ctx.fs.mkdir(targetPath.slice(0, lastSlash), { recursive: true }); } catch {}
              }
              const content = archiveData.slice(pos, pos + hdr.size);
              await ctx.fs.writeFile(targetPath, new TextDecoder().decode(content));
            }
            extracted.push(hdr.name);
            if (verbose) ctx.stdout += hdr.name + '\n';
          }

          // Skip content blocks
          if (hdr.size > 0) {
            const contentBlocks = Math.ceil(hdr.size / BLOCK_SIZE);
            pos += contentBlocks * BLOCK_SIZE;
          }
        }

        return 0;
      }

      ctx.stderr += "tar: Unknown error\n";
      return 1;
    } catch (e: unknown) {
      ctx.stderr += `tar: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};

// Backward compatibility: old FLUFFY-TAR-V1 format
async function extractOldFormat(content: string, ctx: any, workingDir: string, verbose: boolean): Promise<number> {
  const lines = content.split('\n');
  let i = 1;
  const extracted: string[] = [];
  while (i < lines.length) {
    if (!lines[i].startsWith('FILE:')) break;
    const filePath = lines[i].slice(5);
    const type = lines[i + 2].slice(5);
    i += 4; // Skip FILE:, SIZE:, TYPE:, DATA-START
    const contentLines: string[] = [];
    while (i < lines.length && lines[i] !== 'DATA-END') {
      contentLines.push(lines[i]);
      i++;
    }
    const fileContent = contentLines.join('\n');
    i++; // Skip DATA-END
    const targetPath = ctx.fs.resolvePath(filePath, workingDir);
    if (type === 'dir') {
      await ctx.fs.mkdir(targetPath, { recursive: true });
    } else {
      const lastSlash = targetPath.lastIndexOf('/');
      if (lastSlash > 0) {
        try { await ctx.fs.mkdir(targetPath.slice(0, lastSlash), { recursive: true }); } catch {}
      }
      await ctx.fs.writeFile(targetPath, fileContent);
    }
    extracted.push(filePath);
  }
  if (verbose) ctx.stdout += extracted.join('\n') + '\n';
  return 0;
}

function listOldFormat(content: string, ctx: any): number {
  const lines = content.split('\n');
  const fileList: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith('FILE:')) fileList.push(lines[i].slice(5));
  }
  ctx.stdout += fileList.join('\n') + '\n';
  return 0;
}
