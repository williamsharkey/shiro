/**
 * splice(2), tee(2) and copy_file_range(2) between open files, as Linux
 * checks and moves them (no page sharing: the bytes are copied).
 *
 * - splice moves up to `len` bytes between two fds, one of them a pipe: it
 *   waits for data in an input pipe and room in an output pipe (unless
 *   SPLICE_F_NONBLOCK), and reads a file at `off` (then advanced) or its
 *   position.
 * - tee copies up to `len` bytes from one pipe to another without taking
 *   them from the first.
 * - copy_file_range copies between two regular files.
 *
 * ABI (data area as in kernel.ts): offsets go in and out as i64 in data:
 *   splice 275 (fdIn, hasOffIn, fdOut, hasOffOut, len, flags); data =
 *          offIn i64, offOut i64 → bytes moved; data out = the new offsets
 *   tee 276 (fdIn, fdOut, len, flags) → bytes copied
 *   vmsplice 278 (fd, len, flags); data = the bytes for a pipe's write end,
 *          or room for them from its read end → bytes moved
 *   copy_file_range 326 (fdIn, hasOffIn, fdOut, hasOffOut, len, flags);
 *          data as splice
 */
import * as A from './abi';
import { type OpenFile, EventFile, TimerFile } from './fd';
import { PipeEnd } from './pipe';
import { SignalFile } from './signalfd';
import { MqFile } from './mqueue';

const SPLICE_F_NONBLOCK = 2;
const CHUNK = 64 * 1024;

// (a socket is open for reading and writing)
const readable = (f: OpenFile) => f.kind === 'socket' || (f.flags & A.O_ACCMODE) !== A.O_WRONLY;
const writable = (f: OpenFile) => f.kind === 'socket' || (f.flags & A.O_ACCMODE) !== A.O_RDONLY;
/**
 * What splice can read from besides a pipe: files, sockets, devices
 * (/dev/zero, /proc files), not a directory, epoll, eventfd, timerfd,
 * signalfd or message queue; and write to: files and sockets. Anything
 * else is EINVAL, before any wait (LTP splice07).
 */
const spliceIn = (f: OpenFile) => f.kind === 'file' || f.kind === 'socket' || (f.kind === 'dev' &&
  !(f instanceof EventFile || f instanceof TimerFile || f instanceof SignalFile || f instanceof MqFile));
const spliceOut = (f: OpenFile) => f.kind === 'file' || f.kind === 'socket';

/** Read at `off` (or the file's position when null) */
function readAt(f: OpenFile, buf: Uint8Array, off: number | null, signal?: AbortSignal): Promise<number> {
  if (off === null) return f.read(buf, signal);
  return f.pread ? f.pread(buf, off) : Promise.resolve(-A.ESPIPE);
}

/** Write all of `buf` at `off` (or the file's position when null) */
async function writeAt(f: OpenFile, buf: Uint8Array, off: number | null, signal?: AbortSignal): Promise<number> {
  let done = 0;
  while (done < buf.length) {
    const n = off === null ? await f.write(buf.subarray(done), signal)
      : f.pwrite ? await f.pwrite(buf.subarray(done), off + done) : -A.ESPIPE;
    if (n < 0) return done > 0 ? done : n;
    if (n === 0) break;
    done += n;
  }
  return done;
}

export interface Moved { n: number; offIn: number | null; offOut: number | null }

export async function splice(fin: OpenFile | undefined, offIn: number | null, fout: OpenFile | undefined,
  offOut: number | null, len: number, flags: number, signal?: AbortSignal): Promise<Moved | number> {
  if (!fin || !fout || !readable(fin) || !writable(fout)) return -A.EBADF;
  const pin = fin instanceof PipeEnd ? fin.pipe : null;
  const pout = fout instanceof PipeEnd ? fout.pipe : null;
  if (!pin && !pout) return -A.EINVAL;
  if ((!pin && !spliceIn(fin)) || (!pout && !spliceOut(fout))) return -A.EINVAL;
  if ((pin && offIn !== null) || (pout && offOut !== null)) return -A.ESPIPE;
  if (pin && pin === pout) return -A.EINVAL;
  if (fout.flags & A.O_APPEND) return -A.EINVAL;
  if ((offIn !== null && offIn < 0) || (offOut !== null && offOut < 0)) return -A.EINVAL;
  if (len === 0) return { n: 0, offIn, offOut };
  const nonblock = !!(flags & SPLICE_F_NONBLOCK);
  // into a pipe: as much as it has room for, so that nothing read is lost
  let want = Math.min(len, CHUNK);
  if (pout) {
    const r = await pout.waitSpace(nonblock || !!(fout.flags & A.O_NONBLOCK), signal);
    if (r < 0) return r;
    want = Math.min(want, pout.space);
  }
  if (pin) {
    const r = await pin.waitData(nonblock || !!(fin.flags & A.O_NONBLOCK), signal);
    if (typeof r === 'number') return r;
    if (!r) return { n: 0, offIn, offOut };
  }
  const buf = new Uint8Array(want);
  const got = pin ? pin.tryRead(buf) ?? 0 : await readAt(fin, buf, offIn, signal);
  if (got <= 0) return got < 0 ? got : { n: 0, offIn, offOut };
  const put = await writeAt(fout, buf.subarray(0, got), offOut, signal);
  if (put < 0) return put;
  return { n: put, offIn: offIn === null ? null : offIn + got, offOut: offOut === null ? null : offOut + put };
}

export async function tee(fin: OpenFile | undefined, fout: OpenFile | undefined, len: number, flags: number,
  signal?: AbortSignal): Promise<number> {
  if (!fin || !fout || !readable(fin) || !writable(fout)) return -A.EBADF;
  if (!(fin instanceof PipeEnd) || !(fout instanceof PipeEnd) || fin.pipe === fout.pipe) return -A.EINVAL;
  if (len === 0) return 0;
  const nonblock = !!(flags & SPLICE_F_NONBLOCK);
  const r = await fin.pipe.waitData(nonblock || !!(fin.flags & A.O_NONBLOCK), signal);
  if (typeof r === 'number') return r;
  if (!r) return 0;
  const s = await fout.pipe.waitSpace(nonblock || !!(fout.flags & A.O_NONBLOCK), signal);
  if (s < 0) return s;
  const buf = new Uint8Array(Math.min(len, fin.pipe.available, fout.pipe.space));
  const n = fin.pipe.peek(buf);
  return fout.pipe.tryWrite(buf.subarray(0, n)) ?? 0;
}

export async function copyFileRange(fin: OpenFile | undefined, offIn: number | null, fout: OpenFile | undefined,
  offOut: number | null, len: number, flags: number): Promise<Moved | number> {
  if (flags !== 0) return -A.EINVAL;
  if (!fin || !fout || !readable(fin) || !writable(fout) || (fout.flags & A.O_APPEND)) return -A.EBADF;
  if (fin.kind === 'dir' || fout.kind === 'dir') return -A.EISDIR;
  if (fin.kind !== 'file' || fout.kind !== 'file') return -A.EINVAL;
  if ((offIn !== null && offIn < 0) || (offOut !== null && offOut < 0)) return -A.EINVAL;
  // (the same file: the ranges mustn't overlap)
  let posIn = offIn ?? fin.seek?.(0, A.SEEK_CUR) ?? 0;
  let posOut = offOut ?? fout.seek?.(0, A.SEEK_CUR) ?? 0;
  if (fin.path && fin.path === fout.path && posIn < posOut + len && posOut < posIn + len) return -A.EINVAL;
  let done = 0;
  const buf = new Uint8Array(Math.min(len, CHUNK) || 1);
  while (done < len) {
    const want = Math.min(len - done, buf.length);
    const got = fin.pread ? await fin.pread(buf.subarray(0, want), posIn) : -A.EINVAL;
    if (got < 0) return done > 0 ? { n: done, offIn, offOut } : got;
    if (got === 0) break;
    const put = fout.pwrite ? await writeAt(fout, buf.subarray(0, got), posOut) : -A.EINVAL;
    if (put < 0) return done > 0 ? { n: done, offIn, offOut } : put;
    done += put, posIn += got, posOut += put;
    if (put < got) break;
  }
  // without an offset, the file's own position moves
  if (offIn === null) fin.seek?.(posIn, A.SEEK_SET);
  if (offOut === null) fout.seek?.(posOut, A.SEEK_SET);
  return { n: done, offIn: offIn === null ? null : posIn, offOut: offOut === null ? null : posOut };
}

/**
 * vmsplice: the caller's bytes into a pipe's write end, or a pipe's read end
 * into its memory; as much as there is room or data for, waiting only while
 * there is none (a 128 KiB vmsplice into a 64 KiB pipe moves 64 KiB: LTP
 * vmsplice01). Not a pipe: EBADF.
 */
export async function vmsplice(f: OpenFile | undefined, data: Uint8Array, flags: number, signal?: AbortSignal): Promise<number> {
  if (!(f instanceof PipeEnd)) return -A.EBADF;
  if (data.length === 0) return 0;
  const nonblock = !!(flags & SPLICE_F_NONBLOCK) || !!(f.flags & A.O_NONBLOCK);
  if (f.end === 'w') {
    const r = await f.pipe.waitSpace(nonblock, signal);
    if (r < 0) return r;
    return f.pipe.tryWrite(data.subarray(0, Math.min(data.length, f.pipe.space))) ?? 0;
  }
  const r = await f.pipe.waitData(nonblock, signal);
  if (typeof r === 'number') return r;
  return r ? f.pipe.tryRead(data) ?? 0 : 0;
}
