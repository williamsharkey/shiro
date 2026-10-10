# OpenGL for X11 apps: design note

Status: **decided: option B**, GL forwarded to WebGL2 (approved by the user).
Option A, Mesa's llvmpipe/softpipe in the guest, stays as the slow fallback
for pages without WebGL2. Stage 2 is built: glxinfo and glxgears run in the
page (see the addendum). Blender was the trigger: it starts in Blink and then
stops with "A graphics card and driver with support for OpenGL 3.3 or higher
is required", because Xshiro (`src/x11`) had no GLX.

## What GL apps need

An X11 GL app links libGL (Debian: libglvnd's libGL/libGLX + Mesa's
libGLX_mesa) and calls `glXQueryExtension`, `glXChooseFBConfig`,
`glXCreateContextAttribsARB`, `glXMakeCurrent`, `glXSwapBuffers`. Mesa's GLX
always talks to the server for the extension, its visuals/FBConfigs and an
XID per context, even when it renders on the client side. Where the pixels
come from is the real decision:

## Option A: Mesa renders in the guest (llvmpipe or softpipe), GLX in Xshiro

- **Xshiro**: a GLX extension with the requests Mesa's client side sends when
  rendering directly: QueryVersion, ClientInfo/SetClientInfo*, QueryServerString,
  QueryExtensionsString, GetVisualConfigs, GetFBConfigs, CreateContext /
  CreateNewContext / CreateContextAttribsARB (an XID, no server-side GL),
  DestroyContext, IsDirect (yes), Create/DestroyWindow (GLXWindow),
  Create/DestroyPixmap, GetDrawableAttributes, ChangeDrawableAttributes,
  QueryContext. About 20 small requests; no GL commands cross the wire.
- **Pixels**: Mesa's DRISW loader (`swrast_dri.so`) draws into memory and
  shows each frame with plain `XPutImage` (or MIT-SHM if offered), which
  Xshiro already handles: a GL window is an ordinary window to the desktop.
- **Packages**: libgl1-mesa-dri (7.2 MB .deb, 25 MB installed) + libllvm15
  (23 MB .deb, 114 MB installed) + libz3-4 (7 MB) + the libglvnd stubs. About
  38 MB of download per GL app, cached once and shared.
- **llvmpipe vs softpipe**: llvmpipe compiles every shader with LLVM's JIT at
  run time and rasterizes with SIMD code. That JIT code runs in Blink like any
  other code (Firefox, whose JS engine JITs, now runs), and Blink reports SSE up
  to 4.2, so LLVM would emit SSE4.1 code. softpipe needs no LLVM but
  interprets shaders per pixel: natively ~10× slower than llvmpipe, which
  makes it a fallback for a first light, not something to use.

**Speed (estimate, to be measured).** Native llvmpipe draws Blender's default
screen in tens of milliseconds per frame on 4 cores. Blink runs
SSE-heavy code roughly 10–50× slower than native, and probably on fewer
threads, so expect ~0.5–2 s per full redraw. LLVM itself compiles each shader
in Blink, perhaps seconds each, and Blender compiles dozens at start:
minutes on a first start. Mesa's disk shader cache
(`~/.cache/mesa_shader_cache`, persisted in the VFS) would make later starts
skip that. Usable for viewing and slow editing; not for animation playback.

**Effort**: the GLX extension and its tests ~2–3 days; packaging (gen-apps:
the DRI driver is a plugin, libglvnd's vendor JSON, `__GLX_VENDOR_LIBRARY_NAME`)
~1 day; first-light debugging in Blink (LLVM's JIT: W^X `mprotect`, large
mappings, `madvise`) unknown, likely days. **About a week to Blender's first
frame**, with the risk concentrated in LLVM-under-Blink.

## Option B: GL forwarded to WebGL2 in the page

The guest's GL calls are executed by the page's GPU through WebGL2 (GLES 3.0),
and the result is the GL window's canvas, so displaying it is free.

- **Indirect GLX can't carry it**: the GLX wire protocol for GL commands stops
  at about OpenGL 1.4. Anything modern needs a guest-side libGL of our own
  (or a Mesa driver) that serializes the calls into a command buffer (shared
  memory between the Blink worker and the page), and a page-side executor.
- **Two ways in**: (1) our own libGL/libEGL implementing GL 3.3 core
  entrypoints (~300 functions) and translating GLSL 330 to GLSL ES 300
  (glslang → SPIR-V → SPIRV-Cross, compiled to wasm), or (2) Mesa's `virgl`
  driver in the guest (Gallium state over a virtio-gpu-like protocol) and
  virglrenderer compiled to wasm on top of WebGL2. virglrenderer on a GLES
  3.0 host offers less than GL 3.3, so (1) fits better.
- **Gaps between GL 3.3 core and WebGL2**: geometry shaders (Blender 3.4's
  line drawing uses them), `glMapBuffer`-style persistent access, texture
  buffers, some formats, `glReadPixels` round trips (synchronous: a stall per
  call). Each needs an emulation or a narrower target (GL 3.1/ES 3 apps first).
- **Speed**: rendering at GPU speed. The cost is per call (encoding in the
  guest at Blink's speed, decoding in JS) and every synchronous query. With
  batching, interactive frame rates for UI-heavy apps are realistic.
- **Effort**: 3–6 weeks to Blender, with a long tail of GL features per app.

## What each unlocks

| App | GL it needs | A | B |
|---|---|---|---|
| Blender 3.4 | 3.3 core (geometry shaders) | yes, slow | needs geometry-shader emulation |
| glxgears, glxinfo (mesa-utils) | 1.x | yes | yes |
| KiCad (PCB editor's accelerated canvas, 3D viewer) | 2.1 (it has a Cairo canvas without GL) | yes | yes |
| FreeCAD, OpenSCAD (Coin3D / preview) | 1.x–2.x | yes | yes (fixed-function emulation) |
| SuperTuxKart, Minetest, Xonotic, 0 A.D. | 2.1–3.3 | runs, frame rates too low to play | playable is plausible |
| Qt Quick (QML) apps, e.g. many KDE apps | ES 2 / GL 2 (or `QT_QUICK_BACKEND=software`) | yes | yes |
| Inkscape 1.2, GIMP 2.10, Krita | Cairo / QPainter (Krita's GL canvas is optional) | no change | no change |

## Probe results (2026-10-10)

`scripts/gui/probes/osmesa-probe.c`, run in Blink against Debian's libOSMesa
(manifest entry `osmesa-probe`, 47.9 MB with LLVM 15). It times context
creation, a GLSL 1.20 compile and link, and frames of a full-window quad with
a per-pixel sin/cos/smoothstep shader plus 2000 small triangles. It reads
back five pixels and compares them with the same shader evaluated on the CPU.

| | llvmpipe (LLVM JIT) | softpipe (no JIT) |
|---|---|---|
| dlopen / context | 1.6 s / 0.7 s | same |
| shader compile + link | 1.3–1.4 s | 1.4 s |
| 128×128: first frame, then | 21–25 s, then 0.86 s | 1.0 s, then 0.46 s |
| 512×512 per frame | 2.6–2.8 s | 4.6 s |
| 1280×720 per frame | ~9.5 s (extrapolated) | 16.8–17.5 s |
| pixels | **3 of 5 wrong** | all 5 exact |
| `LP_NUM_THREADS=0` | no change (no parallel gain in Blink) | – |

- LLVM's JIT works under Blink: llvmpipe initialises, compiles and draws.
  But its generated code computes some fragments wrongly (e.g. (181, 85, 0)
  where the shader gives (224, 1, 3)). That's an x86-engine bug in the SSE
  code LLVM emits, reported with this probe as the repro. It's possibly
  related to librsvg's gradients, which fail in the same engine.
- softpipe is correct, and faster than llvmpipe on small frames (no
  per-draw JIT compiles), but slower per pixel.
- A realistic window costs seconds to tens of seconds per full redraw with
  either driver. Blender's UI shaders are cheaper than this probe's, so its
  frames would land somewhat lower, but nowhere near the ~2 s bar.
- Re-run after Blink patch 0114 (gui): llvmpipe's pixels now match
  softpipe's. The first frame takes 26–29 s, then 0.44 s per frame at 512²
  and about 1.3 s at 1280×720.

## Decision

- **B is the GL path**: the user approved forwarding GL to WebGL2, because
  many programs need GL at interactive speed (Blender, KiCad 3D, FreeCAD,
  OpenSCAD, games, mpv, Qt Quick, GTK4 GL). Its design and state are in the
  addendum below.
- **A is the fallback**: llvmpipe is correct since 0114 but takes about a
  second per frame, so it serves pages without WebGL2 and whatever B can't
  draw yet. Xshiro installs its GLX for B only when the page has WebGL2
  (`src/gl/setup.ts`); otherwise GL apps find Mesa as usual.

## Addendum: option B design (unix/gl, 2026-10-10)

Status: proposal, sent to the coordinator before building. Owner: unix/gl.
Xshiro's GLX side and app scoring: unix/gui.

```
 guest (Blink worker)                         page
 ┌──────────────────────────┐   AF_UNIX    ┌────────────────────────────────┐
 │ app → libGL.so.1 (glvnd) │   stream     │ glshiro (kernel process, main) │
 │   → libGLX_tabcomputer   │ ──batches──▶ │   → GL Worker (WebGL2 context, │
 │     encoder, per-thread  │ ◀─replies─── │     OffscreenCanvas)           │
 │     command buffer       │              │   → bitmaprenderer canvas over │
 └──────────────────────────┘              │     the X window (Xshiro)      │
                                           └────────────────────────────────┘
```

### Guest side: a glvnd vendor library

- Debian's apps link libglvnd (`libGL.so.1`, `libGLX.so.0`, `libOpenGL.so.0`),
  which loads a vendor library per screen. Ours is
  `libGLX_tabcomputer.so.0`, picked with `__GLX_VENDOR_LIBRARY_NAME=tabcomputer`
  (set by `gui` for apps). It implements glvnd's vendor ABI (`__glx_Main`,
  ABI 1.x as in bookworm's libglvnd 1.6) and every GLX entry point, and hands
  glvnd a GL function for each name it asks for.
- Why a vendor and not our own `libGL.so.1`: Debian's packages keep their
  files, glvnd's dispatch already covers `libGL`/`libOpenGL`/`libGLX` and
  `dlopen` users (epoxy, Qt), and unsetting the variable falls back to Mesa
  (option A) for comparison. EGL later the same way:
  `libEGL_tabcomputer.so.0` through `__EGL_VENDOR_LIBRARY_FILENAMES`
  (GTK4 and Qt use EGL on X11).
- Built like the text hook: C, gcc on the host, glibc ≤ 2.36 symbols
  checked, shipped in `public/gui/lib/`, source in `scripts/gl/`.
- GLX is answered on the client side. FBConfigs and visuals are computed
  from the server's own visuals (`XGetVisualInfo`: TrueColor 24, ARGB 32),
  each offered with double buffer, depth 24/stencil 8, and 0 or 4 samples.
  GLX drawables are the X window ids. No GL command crosses the X
  connection, so Xshiro needs only `GLX` in QueryExtension (glvnd's own
  `glXQueryExtension` asks the server) and QueryVersion.

### Transport: a socket, not the shared-memory ring

- Each process opens one AF_UNIX stream connection to
  `/tmp/.tabcomputer-gl/0`, served by `glshiro`, a kernel process like
  Xshiro. It's the same path X11 traffic takes, with no new kernel or Blink
  work.
- Every thread encodes into its own buffer (256 KB) in private memory, so
  encoding runs at JIT speed. A flush is one `write()` of the batch, which
  the kernel copies out of guest memory in bulk. Flushes happen when the
  buffer fills, at `glXSwapBuffers`/`glFlush`/`glFinish`, at
  `glXMakeCurrent`, and before any call that needs a reply. A process-wide
  lock covers the socket only.
- Why not a ring in a shmobj mapping (Blink 0112): remote pages are kept
  out of the JIT and the TLB, and every access takes the object's lock
  lease. That's right for semaphores and wrong for megabytes of vertex
  data per second. The ring stays possible later for one thing: a small
  shared word with the page's completed-frame counter, if the swap throttle
  below costs too much as a read.
- Measured in stage 2: bytes/s and flushes/s from Blink through the socket
  to the page. If a socket write turns out to cost more than ~50 µs, batches
  grow.

### Wire format

- Little endian, 4-byte aligned. A command is `u32 op | (words << 16)` and
  its payload; `words` (header included) 0 means a `u32 bytes` length
  follows, for uploads. A batch is `u32 magic, u32 context, u32 bytes` and
  its commands; the context id saves a MakeCurrent per batch for threads.
- The opcode table is generated from one list (`src/gl/commands.ts`):
  name, argument types, and whether the call returns something. The guest
  encoder (C) and the page decoder (TypeScript) are both generated from it,
  so they can't disagree. A test checks the generated C is up to date.
- Client memory is copied into the command where GL reads it at call
  time: `glTexImage*`, `glBufferData`, `glUniform*v`, and client-side vertex
  arrays at draw time (the encoder computes the index range for
  `glDrawElements` with client indices).

### Sync points: as few as possible

| Call | Handling |
|---|---|
| `glGen*`, `glCreateShader/Program` | Names chosen in the guest; the page maps them. No round trip. |
| `glGetError` | Errors the guest can detect are kept there; errors the page hits come back with the next reply. `TABCOMPUTER_GL_SYNC=1` makes every `glGetError` a round trip, for debugging. |
| `glGet*` state, `glIsEnabled` | Shadow state in the guest; limits (`MAX_TEXTURE_SIZE`, ...) fetched once per context. |
| Shader compile/link status, logs, uniform and attribute locations | One round trip per `glLinkProgram`'s first query, returning everything; locations are then answered locally. |
| `glReadPixels`, `glGetTexImage`, `glGetBufferSubData`, `glMapBuffer*` for reading | Round trip (unavoidable). Into a `PIXEL_PACK_BUFFER`: no round trip until mapped. |
| `glMapBuffer*` for writing | Guest-side shadow memory; unmap sends the written (or flushed) range. |
| `glFenceSync`/`glClientWaitSync` | Commands run in order on the page, so a fence is signalled once the page has its batch: `glClientWaitSync` flushes and returns `ALREADY_SIGNALED` without a round trip. Queries (`GL_QUERY_RESULT`) round-trip. |
| `glFinish` | Round trip. |
| `glXSwapBuffers` | Flush. Blocks only when the page is 2 frames behind (the page acks each presented frame on the socket; the guest reads acks without blocking otherwise). |

### Page side

- `glshiro` (`src/gl/server.ts`) accepts connections and reassembles each
  connection's batches for its executor (`src/gl/exec.ts`), which owns one
  WebGL2 context. **Now** the executor runs on the main thread
  (`src/gl/present.ts`). **Planned**: one Worker per connection
  (`src/gl/worker.ts`) with the context on an OffscreenCanvas, batches
  transferred as ArrayBuffers; the main thread stays the fallback.
- One WebGL2 context per connection holds every GL context of that
  process. Share groups are name maps; each GL context's state is shadowed
  and re-applied on a context switch. This makes `glXCreateContext` with
  `shareList` free and avoids WebGL's limit of ~16 live contexts.
- A GL window's buffers are a framebuffer object of the window's size
  (color, depth/stencil, MSAA when the FBConfig asks). `glXSwapBuffers`
  blits (resolving) to the canvas and `transferToImageBitmap()` goes to a
  `bitmaprenderer` canvas that sits over the X window in the desktop window:
  no readback, no copy through Xshiro's pixmaps. Front-buffer drawing, and
  `glReadPixels` from either buffer, work because both are FBOs. The FBO
  follows the window's size at the next swap or MakeCurrent, as DRI does.
  **Now** frames take the fallback below; the bitmap path waits for gui's
  `glSurface`.
- Fallback present (and `XGetImage` on a GL window): read the front FBO
  back into the window's pixmap, so Xshiro composes it like any drawing.
- Frame pacing: the page acks a frame (`MSG_FRAME`) on the next animation
  frame (`pacedSend` in `present.ts`), and the vendor library blocks in
  `glXSwapBuffers` while it is more than two frames ahead. Apps run at the
  display's rate, and a hidden tab (no animation frames) stops them at their
  next swap instead of rendering frames nobody sees.
- Fixed function (GL 1.x/2.1 compat: glxgears, OpenSCAD, FreeCAD/Coin3D,
  KiCad): matrices, lighting (8 lights, materials, color material), texture
  environment, fog, alpha test, clip planes, point size, flat shading, are
  state on the page. Shaders are generated per state key and cached. Immediate
  mode (`glBegin`..`glEnd`, `GL_QUADS`, `GL_POLYGON`) is assembled into
  vertex arrays on the page; display lists are recorded and replayed on the
  page, so glxgears sends a few hundred bytes per frame.

### Shader translation: our own GLSL front end in TypeScript

- **Now** (`src/gl/glsl/translate.ts`) it rewrites tokens: versions and
  qualifiers, renamed built-in functions, fragment outputs, and the
  compatibility built-ins mapped to `_tc_` attributes and uniforms. Every
  shader of the corpus in `tests/tests/shiro-vitest/fixtures/glsl` (Mesa
  demos, glmark2, SuperTuxKart, OpenSCAD) compiles and links after it.
  There is no type checker yet, so desktop-only implicit conversions are
  still compile errors. The full front end below is the plan:
- Desktop GLSL 110–330 to GLSL ES 3.00, in `src/gl/glsl/`: preprocessor,
  parser, a type checker for the built-in function set, and a printer.
  The checker is there for what ES forbids and desktop GLSL ≥ 1.20 allows:
  implicit int→float/vecN conversions, which get explicit constructors.
  The rest is rewriting: `attribute`/`varying`, `texture2D`/`shadow2D`/...,
  `gl_FragColor`/`gl_FragData`, the compatibility built-ins (`gl_Vertex`,
  `gl_ModelViewMatrix`, `gl_LightSource[]`, `ftransform()`) mapped to the
  fixed-function state uniforms the page already keeps, default precision,
  `#extension` lines.
- Why not glslang → SPIR-V → SPIRV-Cross in wasm: ~3 MB to download,
  emsdk in the build, and SPIR-V can't carry the compatibility profile
  (`gl_Vertex` and friends), which GL 2.1 apps use most; loose uniforms
  need relaxed-mode workarounds. The geometry-shader and texture-buffer
  emulation below also need source-level rewriting, which our AST gives.
  If the front end's coverage hits a wall, glslang+SPIRV-Cross is the
  fallback for core-profile shaders only.
- Translated shaders are cached by source hash (IndexedDB), like Mesa's disk
  cache.

### GL 3.3 core gaps on WebGL2

| Gap | Plan |
|---|---|
| Geometry shaders (Blender 3.4: wide lines, overlays) | Two passes. The vertex shader runs with transform feedback into a buffer (rasterizer discarded), copied to a texture. A generated vertex shader then runs the geometry shader's body per output vertex: `gl_VertexID` gives the primitive and the vertex k, it fetches the primitive's inputs with `texelFetch`, runs the body counting `EmitVertex()` and keeps the k-th vertex; strips become triangle lists by index; unemitted slots are culled. Needs a bounded `max_vertices` (Blender's are 4–6). Stage 4. |
| Texture buffers (`samplerBuffer`) | A 2D texture 4096 wide fed from the buffer on the GPU (`PIXEL_UNPACK_BUFFER`) when it changed; `texelFetch(b, i)` rewritten to 2D coordinates. |
| `glPolygonMode(GL_LINE/POINT)` | Index buffer of edges/points built on the page (cached per buffer). |
| `glDrawElementsBaseVertex`, `glDrawArrays` with `first` on client arrays | Re-point attributes by `baseVertex × stride`; the base-vertex extension when present. |
| Persistent mapping (GL 4.4) | Not in 3.3; `glMapBufferRange` as above. |
| `glReadPixels` | Round trip; into a pack buffer, async. |
| `GL_CLAMP_TO_BORDER`, 1D textures, rectangle textures, BGRA uploads, `UNSIGNED_INT_8_8_8_8_REV`, `glGetTexImage` | Emulated: border → edge (approximate), 1D/rect → 2D (+ coordinate rewrite for rect), format conversion on upload, render-and-read for get. |
| Wide lines, `glLineStipple`, `glLogicOp`, `GL_POLYGON_SMOOTH` | Width 1 (WebGL's limit) at first; wide lines as quads later if an app needs it. LogicOp: XOR only, via blending where possible. |
| `gl_ClipDistance`, depth clamp, dual-source blend, S3TC, timer queries, float targets | WebGL2 extensions where the browser has them (`WEBGL_clip_cull_distance`, `EXT_depth_clamp`, `WEBGL_blend_func_extended`, `WEBGL_compressed_texture_s3tc`, `EXT_disjoint_timer_query_webgl2`, `EXT_color_buffer_float`); advertised to the app only when present. |
| Primitive restart with any index | WebGL2 always restarts at the type's max; other indices are rewritten. |

Version strings: a compatibility context reports `2.1` (raised to 3.0 when
it covers it), a core context `3.3`, GLSL `1.20`/`3.30`; renderer
`tabcomputer WebGL2 (<browser's renderer>)`.

### What gui provides (Xshiro)

1. Done in `src/gl/glx-ext.ts`, installed by `src/gl/setup.ts` when the page
   has WebGL2: `GLX` in QueryExtension, QueryVersion (1.4), and what libglvnd
   asks the server: QueryServerString with `GLX_EXT_libglvnd` among the
   extensions and `tabcomputer` as GLX_VENDOR_NAMES_EXT (without the former
   glvnd falls back to `libGLX_indirect`), and GetDrawableAttributes for a
   drawable's screen. Other GLX requests answer `BadRequest`; our vendor
   sends none.
2. An in-page API for a GL window, roughly
   `server.glSurface(xid) → { canvas, width, height, onChange(cb), onDestroy(cb), release() }`:
   a `bitmaprenderer` canvas at the window's position in its toplevel,
   clipped and stacked like the window (child windows included: KiCad's 3D
   canvas, wxGLCanvas), kept in place across moves, resizes, map and unmap.
   Until it lands, `src/gl/present.ts` uses the readback fallback.
3. The vendor library: `src/gl/setup.ts` writes
   `public/gui/lib/libGLX_tabcomputer.so.0` (built by `scripts/gl/build.sh`)
   to `/usr/lib/x86_64-linux-gnu/` before Xshiro serves its first client,
   like the text hooks `src/gui/apps.ts` ships. No environment variable is
   needed: glvnd takes the vendor from the server.

### Tests and measurement

- vitest (`tests/tests/shiro-vitest/`):
  - `gl-wire.test.ts`: the wire format, every argument code, long headers,
    broken streams; `gl-encode.ts` is a TS encoder of the same bytes.
  - `gl-exec.test.ts`: the executor on a recording WebGL2 stand-in
    (contexts, drawables, immediate mode, display lists, shaders, replies,
    frame pacing).
  - `gl-webgl.test.ts`: real WebGL2 in headless Chromium (skipped without
    it): the shader corpus compiled and linked, every kind of
    fixed-function program, and the executor's pixels (clear, immediate
    mode, display lists, textures, lighting, a legacy GLSL program).
  - `gl-server.test.ts`: the socket server (batches split anywhere, one
    backend per connection, broken streams) and `setup.ts`.
  - `x11.test.ts`: the GLX requests glvnd sends.
  - `gl-guest.test.ts`: glxinfo, glxgears and glbench in Blink against a
    recording glshiro, with no vendor forced. Needs `GL_PROBE_ROOT`.
- Browser: `tests/browser/gl-glxgears.mjs` runs glxgears in the page,
  checks the window's pixels and that frames stop without animation
  frames, and prints FPS. Needs `GL_PROBE_ROOT` too.
- `GL_PROBE_ROOT` is an x86-64 rootfs with mesa-utils and libglvnd but not
  Mesa's vendor library: Debian's (`scripts/gui/debfetch.py`, `SKIP=libglx-mesa0,libgl1-mesa-dri`)
  or Ubuntu's (`apt-get download` of mesa-utils, libgl1, libglx0,
  libglvnd0 and their libraries, unpacked with `dpkg -x`).

### Measurements (2026-10-10, unix/gl, 4-core container, Chromium's SwiftShader)

| | |
|---|---|
| glxgears in the page (Blink → glshiro → WebGL2 → Xshiro window, readback present) | 46–47 frames/s, about 1,000 commands/s |
| glxgears in Blink under Node, recording backend (guest and transport only) | 200–229 FPS |
| glxinfo in Blink under Node | 0.7 s |
| Round trip (glFinish) through the socket, Blink under Node | 2,964/s (337 µs) |
| Bulk upload (glBufferSubData) | 210 MB/s |
| Small calls (glVertex3f) | 0.43 M/s |
| Frames rendered in 3 s without animation frames (a hidden tab) | 0 |

The page numbers are SwiftShader's (a CPU renderer); a GPU only makes the
WebGL2 side cheaper.

### Stages (as agreed)

1. This addendum.
2. First light: glxinfo and glxgears on the page; transport numbers.
3. A GL 2.1 app (OpenSCAD or SuperTuxKart) with FPS.
4. GL 3.3 core for Blender, geometry shaders as above.
5. Breadth with gui; a GL column in docs/GUI_SCORE.md.
