# Opportunities: what people can't easily do without installing software

Research worker (unix/research), 2026-10-09. The question: which real user
pain points of the kind "how do I do X without installing software" or "the
online tool for Y is paywalled or uploads my files" could tabcomputer solve, and
how well does it solve them **today**?

**How to read this.**
- **Verified** means I ran it in tabcomputer (https://tabcomputer.com,
  production, headless Chromium 141, cross-origin isolated, a fresh browser
  profile per run), and the result and time are quoted.
- **Read** means the claim comes from the web sources linked (fetched
  2026-10-09).
- Times were measured with 4–6 tabcomputer pages sharing one 4-vCPU machine,
  so they are pessimistic, roughly 1.5–3× what one tab on a laptop takes. apt
  installs are the slow part, and they happen once per browser profile.

**Sources and their limits.** Demand evidence comes from Hacker News (Algolia
API, exact dates), Stack Exchange, GitHub issues and discussions, vendor pages
and forums. Reddit could not be fetched from the research environment, so no
Reddit thread is quoted, and consumer demand (HEIC, PDF, ebooks) is probably
understated. I re-fetched the key claims myself:
- Overleaf's 10 s free compile limit (post of 2025-06-16);
- Glitch hosting ending 2025-07-08 (post of 2025-05-22);
- Replit's pricing page listing no free plan;
- CheerpX needing a commercial licence beyond personal, FOSS and evaluation use.

The rest is from three research passes whose notes, with every link, are
summarised in the sections below.

**Classes.**
- **(a)** works in tabcomputer today via `apt`/`pkg` (verified);
- **(b)** worth a polished tabcomputer app, template or install link;
- **(c)** a white-label opportunity: a single-purpose site powered by
  tabcomputer;
- **(d)** already well served; skip.

**Score** = Demand × Gap × Feasibility, each 1–5 (max 125):
- **Demand:** how often and how loudly people ask.
- **Gap:** how badly existing *local, in-browser* tools serve it.
- **Feasibility:** how well tabcomputer does it now, or after a small fix.

## Ranked table

| # | Opportunity | D | G | F | Score | Class | tabcomputer today (verified) | Key evidence |
|---|---|:-:|:-:|:-:|--:|:-:|---|---|
| 1 | **Linux for locked-down Chromebooks and school or work machines** (a real shell, gcc, Python, git with no install and no account) | 5 | 5 | 4 | 100 | b, c | shell, `pkg` python3/git/make in ~6 s; Debian gcc, gfortran, COBOL, Pascal, Ada, Prolog, Lisp, nasm all compile and run (table below) | Crostini off by default on managed Chromebooks ([Chrome Unboxed](https://chromeunboxed.com/enabling-linux-for-your-managed-chromebooks/)); Cloud Shell blocked for Workspace for Education and under-18s ([Google docs](https://docs.cloud.google.com/shell/docs/limitations)); Trinket (2026-08-31), GitHub Classroom (2026-08-28), Replit's free plan (Sep 2026) gone ([replit.com/pricing](https://replit.com/pricing)) |
| 2 | **Odd-language compilers with files, make and a real TTY** (COBOL, Fortran, Ada, Pascal, Prolog, Lisp, asm, OCaml) | 4 | 4 | 4 | 64 | a, c | all seven compile and run, 2–60 s per compile (table below) | OnlineGDB: realtime keystrokes "not really possible" ([Q&A](https://question.onlinegdb.com/18200/advanced-console-control-java)); Fortran Discourse "Online Fortran Compiler" thread ([link](https://fortran-lang.discourse.group/t/online-fortran-compiler/2171)); Godbolt/TIO are server-side, single-file |
| 3 | **Run a Linux CLI from a GitHub README** ("Run in tabcomputer" badge or deep link) | 4 | 5 | 3 | 60 | b | x86-64 glibc binaries run (Debian, static releases); outbound TCP through the relay is verified in [COMPAT.md](../COMPAT.md#agent-clis-unixagent-clis) but couldn't be exercised from this harness | WSL needs admin ([MS FAQ](https://learn.microsoft.com/windows/wsl/faq)); "No Admin Rights Needed" pitch for CLI installers ([HN 2025-03-25](https://news.ycombinator.com/item?id=43468600)); WebVM is 32-bit only and its networking needs Tailscale |
| 4 | **Private binary and firmware inspection** (binwalk, objdump, readelf, strings, xxd) | 3 | 4 | 5 | 60 | a, c | `binwalk` lists a .docx's zip members; `nasm` + `ld` + `objdump -d` work | Dogbolt uploads binaries (2 MB cap); no browser binwalk found; firmware is exactly what shouldn't be uploaded |
| 5 | **A full-stack sandbox that can't be shut down** (Node or Python server plus client, preview window) | 4 | 4 | 3 | 48 | b | [examples/fullstack-notes](../../examples/fullstack-notes/): Node server and Debian Python server each serve a client in a desktop window, and fetch/XHR work. **No WebSocket/EventSource or file watching yet** | Glitch hosting ended 2025-07-08 ([Glitch blog](https://blog.glitch.com/post/changes-are-coming-to-glitch/)); "What are alternatives to Glitch…" ([HN 2025-06-26](https://news.ycombinator.com/item?id=44383402)); WebContainers is Node-only, closed source, licensed. See [SANDBOXES.md](SANDBOXES.md) |
| 6 | **Legacy document rescue** (WordPerfect, MS Works, ClarisWorks/MacWrite, CorelDraw, Visio, Keynote/Pages/Numbers) | 2 | 5 | 4 | 40 | c | `wpd2text` and `wpd2html` convert a WordPerfect 5.1 file in 0.7 s; libmwaw, libcdr, libvisio and libetonyek tools install (`mwaw2html`, `cdr2xhtml`, `vsd2xhtml`, `key2text`, `numbers2csv`, `pages2html`) | libmwaw's in-browser converter last updated ~2018; online converters upload, with "so-so" results ([thread](https://www.secretprojects.co.uk/threads/converting-coreldraw-cdr-and-old-adobe-illustrator-ai-files-to-open-formats.51130/)) |
| 7 | **Full TeX Live, offline** (biber, latexmk, any package; no 10 s limit) | 4 | 3 | 3 | 36 | c | pending: see "Verified in tabcomputer" | Overleaf free compile limit cut to 10 s ([Overleaf, 2025-06-16](https://www.overleaf.com/blog/changes-to-free-compile-timeout)); Git sync is paid; latex.to (CheerpX + Alpine, full TeX Live, [HN 2026-08-03](https://news.ycombinator.com/item?id=49158317)) proves the approach |
| 8 | **Coding agents in a local sandbox** (Claude Code, Codex, Gemini, Grok, aider in the tab) | 4 | 3 | 3 | 36 | b | all reach their APIs ([COMPAT.md](../COMPAT.md#agent-clis-unixagent-clis)); the inner edit-test-commit loop is fast ([AGENT-EXPERIMENTS.md](AGENT-EXPERIMENTS.md)) | E2B Pro has a $150/mo floor; agent sandboxes are all cloud; BrowserCode runs Claude Code and Gemini in-browser but "doesn't yet support native binaries" |
| 9 | **Real databases for teaching** (`apt install postgresql redis-server`) | 3 | 4 | 2 | 24 | b | Redis 8: works with `--maxclients 1000` (PONG in 1.2 s; SET/GET/INCR); crashes without it (Blink epoll cap). PostgreSQL 17: **blocked** ("signalfd() failed") | WebContainers has no raw TCP, so `pg`/Mongo drivers time out; nothing in-browser runs Redis or MySQL; PGlite is Postgres-only |
| 10 | **Ebook conversion** (calibre `ebook-convert`: epub↔azw3/mobi/docx) | 3 | 5 | 2 | 30 | c | pending | no wasm calibre exists; online converters upload; Send-to-Kindle dropped MOBI (Dec 2023) |
| 11 | **Data wrangling pipelines** (sqlite, jq, csvkit, visidata, miller, awk) | 3 | 2 | 5 | 30 | a | `pkg` sqlite and jq; csvkit and visidata from apt | DuckDB-Wasm, play.jqlang.org and Datasette Lite already serve single tools locally |
| 12 | **Crypto chores** (gpg, openssl, ssh-keygen, age) | 2 | 3 | 5 | 30 | a | `pkg` gnupg, openssl and openssh (static builds) | "online PGP decrypt" sites ask for private keys |
| 13 | **Science long tail** (BLAST+, Octave + Forge, R from source, EMBOSS) | 3 | 4 | 2 | 24 | a | pending | webR 0.6 (2026-06) and Pyodide beat emulation on speed; biowasm covers samtools-class tools; JSLinux NumPy matmul measured ~2500× slower ([HN](https://news.ycombinator.com/item?id=47311484)) |
| 14 | **GIS beyond simple conversion** (full ogr2ogr, SpatiaLite, QGIS) | 3 | 3 | 2 | 18 | a | pending | mapshaper and gdal3.js already do simple conversions locally |
| 15 | **CAD batch conversion and repair** (admesh, assimp, freecadcmd) | 4 | 3 | 2 | 24 | a | pending | OpenSCAD Playground is excellent; FreeCAD WASM ports (2026) are ~200 MB, Chrome-only |
| 16 | **OCR to searchable PDF** (ocrmypdf, PDF/A) | 4 | 3 | 1 | 12 | a | pending (Tesseract under emulation will be slow) | browser OCR uses tesseract.js (BentoPDF) without OCRmyPDF's PDF/A |
| 17 | **Office to PDF** (LibreOffice headless) | 4 | 3 | 1 | 12 | a | pending | ZetaOffice is the only local wasm option (~150 MB+ builds) |
| — | PDF merge/split/rotate/compress | 5 | 1 | 5 | — | a, d | `qpdf` merge+rotate, `pdfinfo`, `pdftotext`, `gs` compress all work | BentoPDF (15.9k★, fully local) and dozens more |
| — | Pandoc conversions | 3 | 1 | 5 | — | a, d | md→html/docx/epub and docx→md work (Debian's pandoc 3.1.11) | official pandoc.wasm 3.9 at [pandoc.org/app](https://pandoc.org/app/) |
| — | HEIC→JPG, image compression | 5 | 1 | 4 | — | d | ImageMagick works through `magick` (`convert` needed the argv[0] fix) | dozens of libheif-wasm sites, Squoosh |
| — | Diagrams (graphviz, PlantUML, mermaid) | 2 | 1 | 4 | — | d | `dot` works with `-Kdot` (plain `dot` needed the argv[0] fix) | viz-js, official `@plantuml/core` TeaVM build, mermaid render locally |
| — | Video re-encoding | 5 | 2 | 1 | — | d | pending | ffmpeg.wasm, Mediabunny (WebCodecs) are faster than emulation |
| — | DOS games | 3 | 1 | 2 | — | d | not tried | js-dos v8, archive.org |

## Top recommendations

1. **Make a "class" white-label: a Linux lab for locked-down machines.** This
   is the single strongest signal. Managed Chromebooks can't turn on Linux,
   Google blocks Cloud Shell for students, and the free classroom sandboxes
   closed one after another in 2025–2026 (Trinket, GitHub Classroom,
   Glitch, Replit's free plan, Firebase Studio). WebVM is the closest
   in-browser alternative, and its engine needs a paid licence for
   academia. tabcomputer needs no account and no server compute, and keeps
   student data on the device.

   What to build:
   - a teacher link that boots a preloaded image (packages and an assignment
     folder);
   - a "hand in" that downloads a tarball;
   - an "Install for class" list per course (C, Python, COBOL, Fortran,
     Prolog, Lisp);
   - an allowlist note for school IT (one domain, no public hosting, so no
     proxy-abuse angle).

   Fix first: the storage-quota UX (below) and the time of the first apt
   install. Ship the course toolchains as prebuilt snapshots, not
   `apt-get install` at 2–7 minutes each.
2. **Ship a "compilers" landing page, then the README deep link.**
   `tabcomputer.com/#run=` with a command, a repo or a .deb turns any GitHub
   README into a runnable demo. The language table below is the proof:
   seven languages that online compilers handle poorly (files, multi-file
   projects, interactive stdin, make) all work today.
3. **Use the full-stack sandbox template as the Glitch and StackBlitz
   answer.** It already works for Node and Python. The gaps that matter are
   WebSocket and EventSource from the preview to the in-tab server, and
   `fs.watch` for auto-reload. Both are tractable; see SANDBOXES.md.
4. **Make a private-converter white-label, but pick its niche.** Don't
   compete on PDF merging or HEIC (saturated, gap 1). Compete where no
   wasm port will come: legacy formats (verified working), calibre, full
   TeX Live with biber, and chains of tools. Lead with "nothing is
   uploaded" and a demo like "drop a 1995 .wpd, get .html/.odt".
5. **Fix the platform bugs these workloads hit** (details in "Bugs found"
   below). The worst for users is intermittent dpkg failures that leave apt
   broken for the rest of the session. The argv[0] bug (now fixed) broke
   Redis, graphviz `dot`, ImageMagick `convert` and busybox. signalfd
   blocks PostgreSQL, and the epoll cap crashes Redis.

## Verified in tabcomputer

Debian mode (`debian install`, `sudo apt-get install -y …`), except where
`pkg` is named. "Install" is the apt download plus dpkg, measured under
contention; "Run" is the command shown.

### Languages

| Tool | Install | Run | Result |
|---|--:|--:|---|
| `pkg install git python3 ripgrep make` | 5.8 s | — | all four |
| gfortran 14 | 392 s | `gfortran hello.f90 && ./a`: 12.6 s | `sum= 5050` |
| GnuCOBOL (`gnucobol4`) | 103 s | `cobc -x`: 26.7 s | `HELLO FROM COBOL` |
| Free Pascal (`fp-compiler`) | 150 s | `fpc`: 12.3 s ("10.5 sec") | `hello from pascal` |
| SWI-Prolog (`swi-prolog-core`) | 129 s | `swipl fam.pl`: 7.4 s | `grandchild: ann` |
| SBCL | 103 s | `sbcl --script`: 1.9 s | `lisp: 5050` |
| nasm + binutils | 79 s | assemble + `ld` + run + `objdump -d`: 5.6 s | `hello from nasm`, disassembly |
| GNAT (Ada) | 445 s | `gnatmake`: 59 s | `hello from ada` (the first attempt failed in dpkg, code 2; a retry worked) |
| OCaml (`ocaml-nox`) | 393 s | `ocamlopt`: 15.8 s | pending output (the first attempt failed in dpkg, code 2; a retry worked) |
| GHC | pending | pending | pending |

### Documents and media

| Tool | Install | Run | Result |
|---|--:|--:|---|
| pandoc 3.1.11 | 94–116 s | md→html, md→docx, docx→gfm: 16–26 s for all three | correct output |
| qpdf + poppler-utils | 331 s (alone: 79 s) | merge 2 PDFs, rotate page 1, `pdfinfo`, `pdftotext`: 11.7 s | `Pages: 2`, `Page rot: 90`, text of both pages |
| ghostscript | 399 s | `gs -sDEVICE=pdfwrite -dPDFSETTINGS=/ebook`: 22 s | 2.9 KB PDF |
| graphviz | 332 s | `dot -Kdot -Tsvg`: 3.9 s | SVG (plain `dot` hit the argv[0] bug) |
| ImageMagick 7.1.1 | 522 s (with graphviz) | `magick photo.png -resize 50% -quality 80 photo.jpg`: 8.4 s | 600×400 JPEG (`convert` hit the argv[0] bug) |
| libwpd-tools (+ libmwaw, libcdr, libvisio, libetonyek tools) | — | `wpd2text old.wpd`: 0.67 s | the WordPerfect 5.1 text; `wpd2html` gives styled HTML |
| binwalk | 530 s | `binwalk doc.docx` | lists the zip members with offsets |
| ffmpeg, sox, TeX Live, LibreOffice, calibre, ocrmypdf, GDAL, BLAST+, Octave, R, admesh/assimp | pending | pending | pending |

### Bugs found by these workloads

All reported to the coordinator, who routed them to the owning workers. "Fixed" means fixed on unix/integration.

| Bug | Effect | Status |
|---|---|---|
| A program run through a symlink got the target's path as argv[0] | redis-server ran as redis-check-rdb; `dot` asked for engine "libgvc6-config-update"; `convert` printed magick's usage; busybox links broke | **fixed** (958ecd5, conformance; live on tabcomputer.com: redis-server now starts as itself) |
| `page :PORT` picked a hidden, empty iframe that `serve open` leaves behind | "element not found" in 3 of 4 runs | **fixed** (research; cherry-picked) |
| A deploy deleted the previous build's lazy chunks | apt's preconfigure import 404'd mid-session; dpkg failed and apt stayed broken | **fixed** (release.sh keeps a week of old assets) |
| Blink's `epoll_wait` returns EINVAL for maxevents > 4096 (patch 0011, `ShiroEpollWait`) | Redis 8 crashes at start ("aeApiPoll: epoll_wait, Invalid argument"); so does `redis-benchmark` | reported; workaround `redis-server --maxclients 1000` (then PONG, SET/GET/INCR work) |
| No `signalfd(2)` | PostgreSQL 17: "FATAL: signalfd() failed" in initdb and postgres | reported |
| `su` can't open a PAM session ("su: cannot open session: Permission denied") | postgresql-common can't create the default cluster ("Could not change user id") | reported |
| `clock_gettime(CLOCK_THREAD_CPUTIME_ID)` (or similar) unsupported | GHC 9.6: "getCurrentThreadCPUTime: no supported: Inappropriate ioctl for device"; nothing compiles | reported |
| IPv6 wildcard bind after an IPv4 one on the same port is EADDRINUSE | Redis's default `bind * -::*` aborts; `--bind 127.0.0.1` works around it | reported (conformance) |
| `fs.watch` in tabcomputer's node delivers no events; no `assert.match` | nodemon, vite HMR and `--watch` modes are dead | reported (compat-dev) |
| builtin `ffmpeg` shim | was a cross-origin Worker (fixed by compat-tools); now a second run on the same input fails: "ArrayBuffer at index 0 is already detached" | first part fixed; second reported |
| dpkg "returned an error code (1/2)" or "pre-installation script … exit status 1", intermittently (gnat, ocaml-nox, postgresql-17, ghostscript, gdal-bin) | dpkg left interrupted; every later install in that page fails with "Unmet dependencies"; a retry in a fresh page worked each time | reported (debian); the biggest reliability problem for apt users |
| `git maintenance run --auto --detach`; builtin `wget -qO-` | 3 background processes at 11–18 s CPU each; wget saved to a file | reported (compat-tools) |
| Storage quota | in a private window (Playwright's default context) the quota is ~890 MB, and apt hit ENOSPC after 5 packages; a normal profile had 162 GB | suggested: don't keep downloaded .debs; show storage in Settings |

## The evidence, by opportunity

### 1. Locked-down machines (Chromebooks, school and work PCs)

- **Google's own policy.** Cloud Shell is blocked by default for Google
  Workspace for Education, and unavailable to under-18s
  ([docs](https://docs.cloud.google.com/shell/docs/limitations)). Linux
  (Crostini) is "disabled by default on managed Chrome OS devices"
  ([Chrome Unboxed](https://chromeunboxed.com/enabling-linux-for-your-managed-chromebooks/)).
- **Students and employees:**
  - "administrators have blocked the option to turn on Linux development
    environment" ([Anki forum](https://forums.ankiweb.net/t/anki-download-for-school-chromebook/41134));
  - "the admins have blocked Linux" ([discuss.python.org](https://discuss.python.org/t/how-to-download-python-on-a-school-computer/59270));
  - "we were only allowed to use web apps on our Chromebooks" ([HN 2025-12-28](https://news.ycombinator.com/item?id=46406938));
  - fintech PCs with "no admin rights" ([HN 2025-07-08](https://news.ycombinator.com/item?id=44496902)).
- **The free alternatives keep closing**, as dated in SANDBOXES.md: Trinket
  (2026-08-31), GitHub Classroom with its Codespaces allowance
  (2026-08-28), Replit's free plan (Sep 2026), Glitch (2025-07-08),
  Firebase Studio (no new workspaces since 2026-06-22).
- **Competitors.** WebVM/CheerpX is 32-bit only, and organisations including
  academia need a commercial licence
  ([cheerpx.io/docs/licensing](https://cheerpx.io/docs/licensing)). JSLinux
  added x86-64 in Jan 2026 but has no apt. v86 and LinuxOnTab are 32-bit.
  BrowserPod (Leaning Technologies, $0.01/compute-hour with 1,000 h free) is
  native-wasm and can't run prebuilt binaries yet. It is the strongest
  strategic threat.
- **Risks.** School web filters can block a domain. 4 GB Chromebooks are
  tight. First-install time matters on school bandwidth.

### 2. Compilers for less common languages

- Online compilers are server-side, single-file and batch-stdin: Godbolt,
  TIO/ATO, OnlineGDB ("realtime keystrokes… not really possible").
  GnuCOBOL's Windows build "doesn't work properly… missing some DLLs"
  ([opensource.com](https://opensource.com/life/15/10/open-source-cobol-development)),
  and learners ask which compiler to use
  ([Open Mainframe Project](https://community.openmainframeproject.org/t/how-do-i-get-started-learning-cobol-and-which-compiler-should-i-use/6481)).
- Local wasm options are per-language and partial: GHC in the browser
  (bytecode, no cabal), SWI-Tinker (prototype), and no SBCL or GnuCOBOL
  web build was found.
- tabcomputer: seven languages verified above, with real files, `make` and a
  pty.

### 3. Running a README's CLI

- "Use WSL" needs admin. Tools pitch "no admin rights needed"
  ([HN](https://news.ycombinator.com/item?id=43468600)).
- What it needs is x86-64 glibc plus outbound TCP. WebVM is 32-bit with
  Tailscale-only networking; container2wasm is experimental and "tested
  only on Chrome".
- Product idea: a `Run in tabcomputer` badge
  (`tabcomputer.com/#run=<url-encoded command or repo>`) that opens the
  desktop, clones or installs, and runs the command in a Terminal window.

### 4. Private binary and firmware inspection

- Dogbolt uploads binaries; no in-browser binwalk or readelf was found;
  radare2 and rizin aren't in Debian trixie. Verified here: binwalk and
  binutils' objdump (with nasm and ld); xxd and file are `pkg` packages.

### 5. Full-stack sandbox

See [SANDBOXES.md](SANDBOXES.md).

### 6. Legacy formats

- Online converters upload files and give "so-so" results "with artifacts and
  lost objects" (CorelDraw thread above). Apache OpenOffice dropped
  WordPerfect import. libmwaw's Emscripten converter was last updated
  around 2018.
- Debian trixie has the Document Liberation Project tools. The
  `writerperfect` package with `wpd2odt` isn't in trixie (apt: "Unable to
  locate package"), but `libwpd-tools`, `libmwaw-tools`, `libcdr-tools`,
  `libvisio-tools` and `libetonyek-tools` are. Verified: they install, and
  `wpd2text`/`wpd2html` convert. Output is text, HTML, XHTML or CSV; to get
  .odt or .pdf, chain through pandoc or LibreOffice.

### 7. LaTeX

- Overleaf cut free compiles to 10 s (verified, post of 2025-06-16). tex.SE
  "Alternative to overleaf (with a better free plan)" (2025-09-10,
  [link](https://tex.stackexchange.com/questions/750873/alternative-to-overleaf-with-a-better-free-plan)).
  TeXbrain, a Show HN of 2026-08-25, pitches against Overleaf's Git paywall
  ([link](https://news.ycombinator.com/item?id=49441375)).
- Local wasm options: SwiftLaTeX (2.3k★), TeXlyre (971★, BusyTeX with TeX
  Live 2026), TeXbrain (pdfTeX only). Their gap is biber, LuaLaTeX,
  ConTeXt and arbitrary packages. latex.to already runs full TeX Live under
  CheerpX emulation.

### 8–17

The remaining rows rest on the research notes linked in the table, plus the
pending verifications. The "skip" rows: BentoPDF (15.9k★, fully local PDF
tools), the official pandoc.wasm, viz-js/@plantuml/core/mermaid, Squoosh
and libheif sites, and ffmpeg.wasm/Mediabunny/VERT. Emulated x86 loses to
native wasm or WebCodecs on CPU-bound media work.

## What the research says about competitors

| | Arch | apt / glibc x86-64 | Networking | Licence | Notes |
|---|---|---|---|---|---|
| **tabcomputer** | Blink x86-64 → wasm, own kernel | yes (Debian 13) | WS→TCP relay | (decide) | 298/300 popcon top-300 install |
| WebVM / CheerpX | x86 JIT → wasm | 32-bit Debian i386 | Tailscale only | proprietary engine; orgs need a licence | no release posts since CheerpX 1.0 (2024-12) |
| JSLinux | full-system emulator | x86-64 since 2026-01, Alpine (apk) | throttled proxy | closed, free | "50 times slower than native, but rock solid" |
| v86 / LinuxOnTab | full-system, 32-bit | no | WISP (LinuxOnTab) | OSS | LinuxOnTab's HN launch drew "AI slop" comments |
| BrowserPod / BrowserCode | native-wasm runtimes | no prebuilt binaries yet | — | commercial, $0.01/compute-h, 1,000 h free | the most serious threat as it adds x86 |
| WebContainers | Node in wasm | no | none (outbound) | proprietary, licensed for commercial use | Node only |
| container2wasm | emulator per image | yes (experimental) | fetch proxy / WS | OSS | "tested only on Chrome" |
