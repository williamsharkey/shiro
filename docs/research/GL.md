# OpenGL for X11 apps: design note

Status: proposal, nothing built. Blender is the trigger: it now starts in Blink
(the CPUID and PI-futex fixes) and then stops with "A graphics card and driver
with support for OpenGL 3.3 or higher is required": Xshiro (`src/x11`) has no
GLX extension, so no X11 app can make a GL context.

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

## Recommendation

1. **Measure before building**: Debian's `libosmesa6` renders with llvmpipe
   into memory with no X server or GLX at all. A one-hour probe (gears or a
   Blender-like shader into an OSMesa buffer, timed in Blink) tells whether
   LLVM's JIT runs under Blink and what a frame costs. That decides A.
2. If the probe is acceptable, **do A**: the GLX extension in Xshiro plus
   Mesa packaging, about a week. It unlocks every GL app at once, correctly,
   just slowly, and stays useful as the fallback for anything B can't do.
3. **B later**, as the speed path for the apps people actually use with GL.
   It's a separate, larger project whose GL-feature coverage grows per app.
