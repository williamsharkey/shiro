# Debian in tabcomputer (unix/debian)

tabcomputer can run a real Debian system: Debian 13 "trixie" amd64, Debian's own
dynamically linked binaries (ld-linux-x86-64.so.2, glibc, apt, dpkg) running
in the Blink x86-64 engine as kernel processes, with tabcomputer's fast builtins
and WASM programs layered over the hot programs. This is the hybrid design:

```
debian install                     # stream the root filesystem in (nothing big is downloaded yet)
sudo apt update
sudo apt install -y hello jq
hello; jq --version; dpkg -l | tail
tabcomputer-alternatives --list          # which programs are tabcomputer's, which are Debian's
```

Status, numbers and the package scoreboard: [DEBIAN_SCORE.md](DEBIAN_SCORE.md),
[BENCHMARKS.md](BENCHMARKS.md) ("Debian").

## 1. The root filesystem, streamed

`scripts/debian/build-rootfs.sh` (run as root; it chroots) builds the image:

1. `debootstrap --variant=minbase trixie` from a pinned snapshot.debian.org
   timestamp (`SNAPSHOT`, default `20261001T000000Z`), with debootstrap and
   the archive keyring themselves pinned by sha256. debootstrap checks every
   package against the signed Release.
2. tabcomputer's customization: deb822 sources for trixie, trixie-updates and
   trixie-security (the real archive URLs), apt defaults
   (`/etc/apt/apt.conf.d/90shiro`: no translations, no recommends, downloads
   as root), Docker-slim style `path-exclude`s for docs, translated man
   pages and locales (English man pages are kept), `force-unsafe-io`, the
   `user` account (uid 1000, as the kernel runs everything), the hostname,
   and `/usr/sbin/policy-rc.d` exiting 101 so maintainer scripts don't start
   services, as in Debian's containers (`service NAME start` still does).
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
the compressed chunk in the Cache API (`tabcomputer-debian-chunks-v1`) and stores
the file's bytes in IndexedDB like any other file. A warm boot needs no
network: everything read before is a normal file, and boot only reads
`/var/lib/shiro/rootfs.json` to re-attach the lazy loader. Conflicts with
tabcomputer's own files: Debian's replace them (`/etc/passwd`, `/bin/sh`), tabcomputer
directories that Debian makes symlinks (`/bin` → `usr/bin`) have their
contents moved to the target, and the `/usr/local/bin` shims tabcomputer writes
for its builtins are removed.

## 2. apt and dpkg

Debian's apt and dpkg run unmodified. What tabcomputer provides around them:

- **uid 0**: `sudo` (builtin, `src/commands/sudo.ts`) runs its command with
  kernel uid/gid 0 (`SpawnOptions.uid`, `Shell.uid`), which Blink forwards
  for getuid/geteuid/getgid. There is no password: the browser tab is the
  security boundary.
- **`#!` scripts** run as Linux runs them when the interpreter is a real
  program (the kernel's `shebangLoader`): dpkg's maintainer scripts run under
  Debian's dash (`/bin/sh`), perl scripts under Debian's perl.
- **The package mirror.** Browsers can't open TCP connections, so apt's
  http/https transport is tabcomputer's: `/usr/lib/apt/methods/http` is diverted
  to `http.debian` (see the overlay below) and replaced by a
  `#!/usr/bin/shiro-apt-method` stub, a tabcomputer kernel program
  (`src/debian/apt-method.ts`) that speaks apt's method protocol and fetches
  `http://HOST/PATH` from the page's own origin as `/debian/mirror/HOST/PATH`.
  apt still verifies InRelease with sqv and every index and .deb hash, so the
  mirror is untrusted. `Acquire::tabcomputer::Mirror` (apt.conf) or
  `$TABCOMPUTER_DEBIAN_MIRROR` point it elsewhere.
- **Index decompression.** apt's `store` method (it turns each downloaded
  `Packages.xz` into `Packages` and hashes it) is diverted the same way to
  `#!/usr/bin/shiro-apt-store` (`src/debian/apt-store.ts`): the xz/gz/bz2/
  zstd codecs and hashes run in the page. Under the x86 engine the original
  spent ~33 s of a ~72 s `apt-get update` decoding trixie's 56 MB index.
  apt checks the result's hashes against the signed Release file as before;
  `tabcomputer-alternatives --set /usr/lib/apt/methods/store debian` restores it.

### Package mirror: what the operator hosts

`server.mjs` serves `/debian/mirror/<host>/<path>`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `TABCOMPUTER_DEBIAN_MIRRORS` | `deb.debian.org=https://deb.debian.org,security.debian.org=https://security.debian.org` | archive host names apt uses → upstream base URL. Only these hosts and only `…/dists/…` and `…/pool/…` paths are served (not an open proxy). Point a host at a local mirror or `https://snapshot.debian.org/archive/debian/<ts>` to pin. |
| `TABCOMPUTER_DEBIAN_CACHE` | `$TMPDIR/shiro-debian` | disk cache (`TABCOMPUTER_DEB_CACHE` is the old name). `pool/` and `by-hash/` files are immutable and kept forever; other index files for `TABCOMPUTER_DEBIAN_INDEX_TTL` seconds (600). |
| `TABCOMPUTER_DEBIAN_SNAPSHOT` | `https://snapshot.debian.org/archive/debian/20260712T000000Z/` | where a `deb.debian.org` pool file the mirror no longer has (removed by a point release) is fetched from instead |

The GUI apps (src/gui/apps.ts, docs/GUI.md) fetch their pinned .debs as
`/debian/pool/PATH`, which is the same mirror (`/debian/mirror/deb.debian.org/debian/pool/PATH`)
and the same cache; they check each file's sha256 themselves.

Responses are same-origin, so no CORS or COEP issues. Traffic per user is
what apt fetches: `apt update` is ≈10 MB (trixie's Packages.xz, plus the
small updates/security indexes; translations are off), and each install is
its .debs. nginx needs no change. An operator who prefers a static mirror
can serve a Debian mirror tree (debmirror/aptly) under `/debian/mirror/`
with the same `<host>/<path>` layout.

## 3. Hybrid overlay

Which implementation runs is recorded in dpkg's own database, as local
diversions, so apt and dpkg stay truthful (`src/debian/overlay.ts`):

- **tabcomputer's**: `dpkg-divert --local --rename --divert PATH.debian --add PATH`.
  Debian's file lives at `PATH.debian` (upgrades land there too); `PATH`
  itself is absent, and the kernel and the shell resolve an absent
  `/usr/bin/NAME` to the tabcomputer command of that name. Programs that must exist
  as files (apt's methods) get a `#!/usr/bin/<command>` stub instead.
- **Debian's**: no diversion; `PATH` is the package's own file, and in
  Debian mode a program file in `/usr/{local/,}{s,}bin` takes precedence
  over a tabcomputer builtin of the same name (`debianShadows`, kept current as
  dpkg adds and removes files).

`dpkg-divert --list`, `dpkg -S /usr/bin/grep` and `dpkg --verify` show what
runs. Switching is `update-alternatives` style:

```
tabcomputer-alternatives --list                 # every overlay-able program: who runs it, auto/manual, default
tabcomputer-alternatives --display grep
tabcomputer-alternatives --set grep debian      # manual choice; defaults never undo it
tabcomputer-alternatives --auto grep            # back to the default policy
tabcomputer-alternatives --auto all             # apply defaults (also run after installs)
```

Defaults are in `src/debian/overlay-policy.json`, one entry per program with
the reason. A program defaults to tabcomputer's only where tabcomputer's implementation
passes the same tests as Debian's (see the overlay tests); everything else is
Debian's.

## 4. Toolchain layers

`toolchain install c` installs a whole Debian toolchain in seconds instead of
apt's minutes. The packages are still Debian's, and dpkg knows them, so apt
keeps working afterwards:

```
toolchain list                   # the sets, their size, which are installed
toolchain install c              # build-essential, gdb, make, cmake, pkg-config
toolchain install python tex     # several at once; `debian install` runs first if needed
toolchain install java --check   # then run the set's smoke test
toolchain install c --apt        # the same packages through apt instead
```

| id | packages asked for | Debian packages | compressed |
| --- | --- | ---: | ---: |
| `c` | build-essential, gdb, make, cmake, pkg-config | 115 | 146 MB (419 MB unpacked) |
| `python` | python3, python3-pip, python3-venv, python3-dev, python3-setuptools, python3-wheel, python3-requests, python3-numpy, python3-yaml | 60 | 55 MB (173 MB unpacked) |
| `node` | nodejs, npm | 383 | 69 MB (242 MB unpacked) |
| `java` | default-jdk-headless | 11 | 156 MB (306 MB unpacked) |
| `classic` | gfortran, gnucobol, fp-compiler, fp-units-rtl, gnat | 61 | 142 MB (415 MB unpacked) |
| `tex` | texlive-latex-recommended, latexmk | 65 | 86 MB (235 MB unpacked) |

Sizes are from `.toolchain-build/layers/index.json` (build of 2026-10-09). Nothing is
downloaded at install time beyond the layer's index. A program's chunks are
fetched the first time it runs.

**What a layer is.** `scripts/debian/build-layers.sh` (root, any Linux host)
rebuilds the exact base rootfs users install from `public/debian`
(`unpack-rootfs.mjs`) and chroots into it. It points apt at the base's
snapshot.debian.org timestamp (trixie, trixie-updates and trixie-security),
runs `apt-get install` for the set, restores the base's apt sources and the
overlay's stubs, and clamps times to `SOURCE_DATE_EPOCH`. `pack-layer.mjs`
then diffs the tree against the base and writes `OUT/<id>/layer.json` and an
index, plus `OUT/chunks/<sha256>.gz` and the catalog `OUT/index.json`. The
index holds:

- the packages that are new or changed, each with its dpkg status stanza;
- every new or changed path, with the package that owns it (from dpkg's
  `.list` files; dpkg's `info/` files count as their package's). Paths no
  package owns (alternatives, `ld.so.cache`, `__pycache__`, TeX's formats)
  are always applied;
- the text databases maintainer scripts edited, stored whole and merged
  entry by entry on apply: `/var/lib/apt/extended_states` (apt's
  auto-installed marks), debconf's `*.dat`, `/var/lib/dpkg/diversions`,
  `statoverride` and `triggers/*`, and `/etc/passwd`, `group`, `shadow`,
  `gshadow` and `shells`.

Chunks are the base rootfs's format (gzip, named by the sha256 of their
bytes). Each package gets its own chunks, so a package two sets share (gcc-14
in `c` and `classic`) is stored and fetched once.

**Applying** (`src/debian/layers.ts`, `toolchain` in `src/commands/toolchain.ts`)
works like dpkg, without running anything. A package is written when this
machine doesn't have it, or has an older version (dpkg's version
comparison). Otherwise it is kept as it is. Its paths become lazy
placeholders (`FSNode.lazy`, source = the layer id) in one batch, and a path
diverted on this machine lands where the diversion points. Its status stanza
replaces or joins dpkg's `status`, the merged databases gain the entries
they lack, and files an upgraded package no longer ships are removed.
`/var/lib/shiro/layers.json` records what was applied, and boot re-attaches
those layers' chunk loaders (`bootLayers`). The overlay's defaults run
afterwards, as after `debian install`. Then `apt install` of anything in the
layer says it is already the newest version, and other packages install on
top as usual (`toolchain-layers.test.ts`).

A layer is built on one base rootfs id and refuses others. When the server
has no layer for this machine's base, `toolchain install` uses apt instead,
and says so.

**Upgrades.** Layers are pinned to the base's snapshot, like the base
itself. `sudo apt update && sudo apt upgrade` brings their packages up to
the archive's current versions, as on any Debian system. To move layers to
a new snapshot, rebuild the base (`build-rootfs.sh` with a new `SNAPSHOT`)
and then the layers. `build-layers.sh` rebuilds a set only when its recipe
changes. The recipe is the hash of the base id, the snapshot, the package list
and the builder scripts; `FORCE=1` rebuilds anyway. Each set keeps its
current index and the one before it, because machines that applied the
older layer still fetch its chunks. With `PRUNE=1`, chunks that neither
names are deleted.

**Serving.** `server.mjs` serves `TABCOMPUTER_DEBIAN_LAYERS` (a directory) at
`/debian/layers/`. Chunks and indexes are served immutable and the catalog
`no-cache`. Unset, `/debian/layers/` is whatever `STATIC_DIR` has there. Layers
are never committed (about 650 MB of chunks for all six sets). On
tabcomputer.com, `deploy/tabcomputer/release.sh` starts the builder in the
background after each deploy (systemd unit `tabcomputer-layers`: nice 19,
idle I/O, `CPUQuota=50%`, `PRUNE=1`) with `OUT=/opt/tabcomputer/layers`,
which `server.env` serves. It never fails or delays the deploy, and it
refuses to start with less than 6 GB free (`MIN_FREE_GB`). The
first build fetches the packages from snapshot.debian.org. Later deploys
rebuild only sets whose recipe changed. Downloaded `.deb`s stay in
`/opt/tabcomputer/layer-build/debs` for rebuilds. Until a set is built,
`toolchain install` falls back to apt. Locally:

```
sudo bash scripts/debian/build-layers.sh            # all sets → .toolchain-build/layers
sudo bash scripts/debian/build-layers.sh c python   # some
TABCOMPUTER_DEBIAN_LAYERS=$PWD/.toolchain-build/layers PORT=5299 STATIC_DIR=$PWD/dist node server.mjs
```

Behind a TLS-intercepting proxy, pass its CA as `CA_BUNDLE=...`
(`HTTPS_PROXY` is passed on to apt).

**Measured:** BENCHMARKS.md "Toolchain layers" (`node bench/run.mjs --suites
toolchains`).

## Known gaps

- systemd's postinst (systemd-sysusers, pulled in by cron, udev, logrotate)
  fails with "Failed to backup /etc/group: Bad address": Blink's `sendfile`
  rejects a NULL offset (reported to unix/perf-blink).
- `open(dir, O_TMPFILE)` fails (EISDIR); programs that try it fall back to a
  named temporary file.
- One guest thread runs at a time (Blink's GIL); apt and dpkg are
  interpreted/JIT-compiled x86. `apt-get update` takes about 45 s
  (BENCHMARKS.md "Real workloads": 43 s), installing a small package about a minute.
- dpkg-deb's `.xz` decompression occasionally crashes or reports corrupt data
  under Blink (X86_ENGINES.md item 57); rerunning the install gets past it.
- How Debian packages coexist with `pkg`'s prebuilt ones (who owns `/usr/bin/NAME`,
  switching back and forth): README.md, "How prebuilt, Debian and built-in commands coexist".
