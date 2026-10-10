# Shared mappings between unrelated Blink processes (design, not built)

Status: approved 2026-10-10 (coordinator). Kernel half in progress (perf-kernel); Blink half queued behind perf-blink's regressions.

## The gap

Every Blink process runs in its own worker with its own wasm linear memory.
`MAP_SHARED` works inside one Blink instance: same-instance fork children
share host pages with their parent (X86_ENGINES.md §31), and futexes there are
keyed by host address. Across instances it doesn't:

- A file `mmap(MAP_SHARED)` is a private copy of the file, written back on
  `msync`/`munmap` (X86_ENGINES.md §11).
- glibc's `sem_open` maps `/dev/shm/sem.NAME` this way. A process that execs
  a helper, or two programs started from different shells, each get their
  own copy. Measured: an exec'd process's `sem_post` is never seen; the
  waiter's `sem_timedwait` times out.
- SysV `shmat` between unrelated processes has the same limit, assuming
  Blink maps a segment per instance.
- Not affected: SysV semaphores and message queues (the kernel holds their
  state: sysvsem.ts, sysvmsg.ts), pipes, sockets, and files read or written
  with syscalls.

Who needs it:
- POSIX named semaphores (`sem_open`) between processes that aren't
  same-instance forks.
- POSIX shm (`shm_open` + `mmap`) between such processes: Chromium-style IPC,
  some test suites, pulseaudio.
- SysV shm between unrelated programs (rare: PostgreSQL's backends are
  forked children, so they share an instance).

### Real programs that need it (sets the priority)

- **Multi-process browsers** (Firefox content and GPU processes, Chromium):
  their IPC moves shared-memory handles between processes that the parent
  forks *and execs*. Firefox doesn't run without it.
- **pulseaudio / PipeWire clients:** shm ring buffers per stream (memfd or
  /dev/shm) between client and server. Without it, clients fall back
  (pulseaudio `--disable-shm`) or play no audio.
- **Test suites and tools that `sem_open` across exec** (LTP's sem tests,
  some Python `multiprocessing` start methods: `spawn` execs and uses
  named semaphores for locks).
- **Not needed:**
  - X11 clients: Shiro's X server doesn't offer MIT-SHM, so they use
    `PutImage`.
  - PostgreSQL: its backends are fork children in one instance.
  - Audacity's single-instance lock: SysV semaphores, held in the kernel.

## The constraint

A wasm module compiled the way Blink is has exactly one linear memory. It can
neither map a second SharedArrayBuffer into its address space nor alias pages
of one memory into another. So no design can make two instances' guest
addresses refer to the same bytes in place. Some code has to run at access
time. That leaves two families.

### A. Copy on sync (rejected as the general mechanism)

Each instance keeps its private copy and exchanges bytes with a kernel-owned
copy at "sync points": futex wait/wake on an address in the mapping,
`msync`/`munmap`, and syscalls in general.

This is not correct for the main user. `sem_post` and `sem_wait` are
lock-prefixed read-modify-write instructions on the shared word, followed by a
futex wake *only if* a waiter flag is set; an uncontended `sem_post` makes no
syscall at all. Two instances that each `lock xadd` their own copy lose updates
however often they sync, and an uncontended post never reaches the other side.
The same goes for pthread mutexes with `PTHREAD_PROCESS_SHARED` and for any
lock-free structure in shared memory. Copy-on-sync would only be right for data
that's always protected by a lock living somewhere else, such as a SysV
semaphore. That's a convention, not something the kernel can check.

### B. Slow-path pages backed by a kernel SharedArrayBuffer (proposed)

The bytes of a cross-instance shared object live in one place: a
SharedArrayBuffer the kernel owns. Each instance maps the object with its
pages marked *remote*. Blink's MMU sends every guest access to a remote page
through a helper instead of the host-memory fast path:

- a plain load or store copies bytes to or from the SAB (`DataView` /
  `Uint8Array` on it);
- a lock-prefixed RMW, `xchg` or `cmpxchg` becomes the matching `Atomics.*`
  call on an `Int32Array`/`BigInt64Array` view (aligned; an unaligned locked
  access takes a per-object lock word in the SAB, as Linux would split-lock);
- `FUTEX_WAIT`/`FUTEX_WAKE` on an address in a remote page become
  `Atomics.wait`/`Atomics.notify` on the SAB word (from a guest thread's
  worker, so the wait blocks only that thread). Workers sharing the SAB see
  each other's notifies, so a wake crosses instances.

That is correct: every instance's accesses hit the same bytes, with the
atomicity the instructions require. The cost is per access to remote pages
only. A semaphore or mutex op is a handful of accesses (microseconds); a large
hot segment would be slow. Large hot segments are the fork-shared case,
which keeps the fast path.

#### When a page is remote

Remote mode is per object, chosen at map time:

- `/dev/shm/*`, files on tmpfs-like paths (`/dev/shm`, `/run/shm`), and SysV
  shm segments are *shareable objects*. Other files keep today's
  copy-plus-writeback behaviour: shared writable mmaps of ordinary files
  between unrelated processes are rare, and Linux's coherence there (via the
  page cache) is a smaller need.
- The kernel tracks which instances map each shareable object. The first
  instance to map it gets an ordinary fast mapping, plus a note that it holds
  object N.
- When a second instance maps it, the object must become remote everywhere:
  1. The kernel allocates the SAB, if it doesn't exist yet.
  2. It asks the first instance to *publish*: copy its pages into the SAB and
     flip its PTEs to remote, at its next safe point. That's a flag each guest
     thread checks where it checks for signals (syscall return, interrupt
     poll), as Blink's signal delivery already does.
  3. Only then does it complete the second mapping. A same-instance fork child
     shares the first instance's host pages, so it flips with them.
- Once remote, an object stays remote until no instance maps it. Then the
  kernel drops the SAB, or for `/dev/shm` files keeps the bytes as the file's
  contents.

#### Kernel side (src/kernel)

- `SharedObjects`: key = (dev, ino) for files, shmid for SysV, giving
  `{ sab: SharedArrayBuffer | null, size, mappers: Map<instanceId, count> }`.
  The file's contents are written into the SAB when it's created, and read
  back from it when the last mapper goes (so `read()` of `/dev/shm/x` sees
  what was mapped and stored). While an object is remote, `read`/`write`
  syscalls on that file go to the SAB too, so a mapping and `write()` stay
  coherent.
- New calls: 1020 map, 1021 unmap, 1022 published (1023 spare). perf-blink
  agreed these on 2026-10-10; Blink keeps its own calls to 1015–1019.
  - `shiro_shmobj_map(fd|shmid, kind, len)`. Result: 0 for a fast mapping,
    or 1 for remote, with the SAB handed over once per instance by message
    (`{type: 'blink-shmobj', id, sab}`). The caller waits for it like
    `blink-channel`.
  - `shiro_shmobj_unmap(id)`.
  - `shiro_shmobj_published(id)`: the first instance's reply to a publish
    request, sent as a message `{type: 'blink-publish', id}`.
- Growth: `ftruncate` of a mapped `/dev/shm` file beyond the SAB allocates a
  new, bigger SAB only while unmapped. While mapped, the mapping's length is
  what the guest can touch (Linux SIGBUSes past EOF), so no growth is needed.
  A SAB is created with its final size at first remote map. A growable SAB
  (`new SharedArrayBuffer(n, { maxByteLength })`) can cover `ftruncate`
  later; Chromium has it.

#### Blink side (perf-blink's patches)

- A PTE kind for remote pages: bit 48, `PAGE_REMOTE 0x0001000000000000`,
  agreed with perf-blink. It sits between PAGE_TA (bits 12–47) and
  PAGE_GROW (bit 52); bits 49–51 are still free, e.g. for a publish marker.
  It's handled in the MMU's slow path. Every access path has to check it:
  the TLB fast paths, LookupAddress, CopyFromUser/CopyToUser, wjit.c's
  inline loads and stores, and ShiroWalkTable's fork snapshot. A remote
  page must never be cached in a TLB entry as a plain host pointer. The JIT emits no fast-path
  accesses for them: they fault into the interpreter path, the same way
  pages without host memory are handled.
- Load, store and RMW helpers that call into JS (`EM_JS`) on the SAB view
  for object `id`. Alternatively, put one SAB per object into the wasm
  module's import table, if the toolchain allows multi-memory later.
- Publish at a safe point, and futexes on remote addresses through
  `Atomics.wait`/`Atomics.notify` on the SAB.

#### Cost estimate

- Kernel: ~300 lines (`SharedObjects`, three calls, read/write coherence,
  tests with two Node workers).
- Blink: the slow path, helpers and publish: probably the larger half; it's
  perf-blink's call.
- Tests: `fixtures/x86/psem.c` (sem_open across exec; written, currently
  times out), plus a `shm_open` + `pthread_mutex PROCESS_SHARED` fixture
  across exec, and SysV shm across two unrelated programs.

## Cheaper alternatives considered

- **Run every process of a session in one Blink instance** (exec in the same
  instance). It would make sharing between descendants of one shell free, but
  programs started from different terminals still wouldn't share. It also
  gives up the per-process wasm memory release at exit, and makes one crash
  take down every process. Not proposed.
- **Copy on sync, limited to objects only accessed under SysV semaphores.**
  Correct for that convention only, and undetectable. Not proposed.
- **Intercepting `sem_*` in libc.** Static binaries carry their own libc, so
  there's nothing to intercept. Not possible.

## Recommendation

Build B, kernel side first. Its tests run without Blink: two Node workers on
one SAB, plus the publish handshake with a fake instance. Then the Blink half,
with perf-blink's agreement on the PTE bit and the call numbers. Until then,
document the limit in COMPAT.md: POSIX shared memory and named semaphores
work within a process tree that shares an instance (fork), not across exec
or between unrelated programs.
