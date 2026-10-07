/**
 * kernel.ts — the one place src/wasi/ imports kernel types from.
 *
 * Today this re-exports the temporary shim (./kernel-shim.ts). When the
 * unix/kernel branch lands src/kernel/{fd,pipe,process,kernel}.ts, point
 * these exports there and delete the shim.
 */
export {
  Kernel, Process, FdTable, Pipe, PipeEnd, FsFile, FsDir, TtyFile, BufferSource,
  CallbackSink, DevFile, Inode, InodeTable, kernelFor, writeAll, shellQuote, statPath, fsErrno,
} from './kernel-shim';
export type { OpenFile, DirEntry, Binfmt, SpawnOptions, TtyHost } from './kernel-shim';
