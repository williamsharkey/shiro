# Debian in Shiro (unix/debian)

Shiro can run a real Debian system: Debian 13 "trixie" amd64, Debian's own
dynamically linked binaries (ld-linux-x86-64.so.2, glibc, apt, dpkg) running
in the Blink x86-64 engine as kernel processes, with Shiro's fast builtins
and WASM programs layered over the hot programs. This is the hybrid design:

```
debian install                     # stream the root filesystem in (nothing big is downloaded yet)
sudo apt update
sudo apt install -y hello jq
hello; jq --version; dpkg -l | tail
shiro-alternatives --list          # which programs are Shiro's, which are Debian's
```

Status, numbers and the package scoreboard: [DEBIAN_SCORE.md](DEBIAN_SCORE.md),
[BENCHMARKS.md](BENCHMARKS.md) ("Debian").

## 1. The root filesystem, streamed

`scripts/debian/build-rootfs.sh` (run as root; it chroots) builds the image:

1. `debootstrap --variant=minbase trixie` from a pinned snapshot.debian.org
   timestamp (`SNAPSHOT`, default `20261001T000000Z`), with debootstrap and
   the archive keyring themselves pinned by sha256. debootstrap checks every
   package against the signed Release.
2. Shiro's customization: deb822 sources for trixie, trixie-updates and
   trixie-security (the real archive URLs), apt defaults
   (`/etc/apt/apt.conf.d/90shiro`: no translations, no recommends, downloads
   as root), Docker-slim style `path-exclude`s for docs, man pages and
   locales, `force-unsafe-io`, the `user` account (uid 1000, as the kernel
   runs everything) and the hostname.
3. Reproducibility: file times clamped to `SOURCE_DATE_EPOCH`, logs, caches,
   machine-id and apt lists removed.
4. `scripts/debian/pack-rootfs.mjs` packs it into `public/debian/`:
   - `rootfs.json`: the manifest (Debian version, snapshot, sizes, index name);
   - `index-<id>.json.gz`: every path with type, mode, mtime and size, a
     symlink's target, or the (chunk, offset) holding a file's bytes;
   - `chunks/<sha256>.gz`: gzip chunks of ~768 KB, named by the sha256 of
     their uncompressed bytes. A Debian package's files are packed together
     (from dpkg's `.list` files), so running a program fetches its package's
     chunk and not much else. Identical files are stored once.

Old chunks stay when the image is rebuilt (`--prune` removes them): browsers
that installed an older image still fetch from them.

**Installing** (`debian install`, `src/debian/rootfs.ts`) fetches the
manifest and the index (≈60 KB) and writes every path as a *placeholder*
node (`FSNode.lazy`: mode, size, symlink target, no bytes) in one batch, so
the whole tree is visible at once: `ls`, `stat`, PATH lookups and dpkg's
database all work immediately. The first read of a file (`readFile`, or the
kernel opening it for a program) fetches its chunk, checks the sha256, keeps
the compressed chunk in the Cache API (`shiro-debian-chunks-v1`) and stores
the file's bytes in IndexedDB like any other file. A warm boot needs no
network: everything read before is a normal file, and boot only reads
`/var/lib/shiro/rootfs.json` to re-attach the lazy loader. Conflicts with
Shiro's own files: Debian's replace them (`/etc/passwd`, `/bin/sh`), Shiro
directories that Debian makes symlinks (`/bin` → `usr/bin`) have their
contents moved to the target, and the `/usr/local/bin` shims Shiro writes
for its builtins are removed.

## 2. apt and dpkg

Debian's apt and dpkg run unmodified. What Shiro provides around them:

- **uid 0**: `sudo` (builtin, `src/commands/sudo.ts`) runs its command with
  kernel uid/gid 0 (`SpawnOptions.uid`, `Shell.uid`), which Blink forwards
  for getuid/geteuid/getgid. There is no password: the browser tab is the
  security boundary.
- **`#!` scripts** run as Linux runs them when the interpreter is a real
  program (the kernel's `shebangLoader`): dpkg's maintainer scripts run under
  Debian's dash (`/bin/sh`), perl scripts under Debian's perl.
- **The package mirror.** Browsers can't open TCP connections, so apt's
  http/https transport is Shiro's: `/usr/lib/apt/methods/http` is diverted
  to `http.debian` (see the overlay below) and replaced by a
  `#!/usr/bin/shiro-apt-method` stub, a Shiro kernel program
  (`src/debian/apt-method.ts`) that speaks apt's method protocol and fetches
  `http://HOST/PATH` from the page's own origin as `/debian/mirror/HOST/PATH`.
  apt still verifies InRelease with sqv and every index and .deb hash, so the
  mirror is untrusted. `Acquire::Shiro::Mirror` (apt.conf) or
  `$SHIRO_DEBIAN_MIRROR` point it elsewhere.

### Package mirror: what the operator hosts

`server.mjs` serves `/debian/mirror/<host>/<path>`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `SHIRO_DEBIAN_MIRRORS` | `deb.debian.org=https://deb.debian.org,security.debian.org=https://security.debian.org` | archive host names apt uses → upstream base URL. Only these hosts and only `…/dists/…` and `…/pool/…` paths are served (not an open proxy). Point a host at a local mirror or `https://snapshot.debian.org/archive/debian/<ts>` to pin. |
| `SHIRO_DEBIAN_CACHE` | unset (no disk cache) | directory for a disk cache. `pool/` and `by-hash/` files are immutable and kept forever; other index files for `SHIRO_DEBIAN_INDEX_TTL` seconds (600). |

Responses are same-origin, so no CORS or COEP issues. Traffic per user is
what apt fetches: `apt update` is ≈10 MB (trixie's Packages.xz, plus the
small updates/security indexes; translations are off), and each install is
its .debs. nginx needs no change. An operator who prefers a static mirror
can serve a Debian mirror tree (debmirror/aptly) under `/debian/mirror/`
with the same `<host>/<path>` layout.

## 3. Hybrid overlay

Which implementation runs is recorded in dpkg's own database, as local
diversions, so apt and dpkg stay truthful (`src/debian/overlay.ts`):

- **Shiro's**: `dpkg-divert --local --rename --divert PATH.debian --add PATH`.
  Debian's file lives at `PATH.debian` (upgrades land there too); `PATH`
  itself is absent, and the kernel and the shell resolve an absent
  `/usr/bin/NAME` to the Shiro command of that name. Programs that must exist
  as files (apt's methods) get a `#!/usr/bin/<command>` stub instead.
- **Debian's**: no diversion; `PATH` is the package's own file, and in
  Debian mode a program file in `/usr/{local/,}{s,}bin` takes precedence
  over a Shiro builtin of the same name (`debianShadows`, kept current as
  dpkg adds and removes files).

`dpkg-divert --list`, `dpkg -S /usr/bin/grep` and `dpkg --verify` show what
runs. Switching is `update-alternatives` style:

```
shiro-alternatives --list                 # every overlay-able program: who runs it, auto/manual, default
shiro-alternatives --display grep
shiro-alternatives --set grep debian      # manual choice; defaults never undo it
shiro-alternatives --auto grep            # back to the default policy
shiro-alternatives --auto all             # apply defaults (also run after installs)
```

Defaults are in `src/debian/overlay-policy.json`, one entry per program with
the reason. A program defaults to Shiro's only where Shiro's implementation
passes the same tests as Debian's (see the overlay tests); everything else is
Debian's.

## Known gaps

- Blink (wasm build) places `mmap`s directly above the program break and
  lets `brk` grow over them; glibc's heap then overwrote apt's package cache.
  Until the Blink fix lands, Debian mode exports
  `GLIBC_TUNABLES=glibc.malloc.top_pad=268435456` (the heap reserves ahead),
  and `debian install` writes `/etc/apt/apt.conf.d/91shiro-engine` with
  `APT::Cache-Start "150000000"` because Blink's `mremap(MREMAP_MAYMOVE)` of
  a growing anonymous map fails. Both are reported to the Blink owners with
  repros.
- `getgroups(0, NULL)` returns EINVAL under Blink (`id` warns).
- One guest thread runs at a time (Blink's GIL); apt and dpkg are
  interpreted/JIT-compiled x86 and are 5–20x slower than native.
