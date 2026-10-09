/*
 * libshiro-text-hook.so: lets GTK 2/3 apps (Pango + cairo) tell Xshiro what
 * text they draw, without changing what they draw (docs/DOM-RENDERING.md).
 *
 * Loaded with LD_PRELOAD (src/gui/apps.ts) when the display's text mode
 * isn't "pixels". Two cairo functions that libpangocairo calls are
 * interposed:
 *   - cairo_surface_has_show_text_glyphs answers yes, so Pango passes the
 *     UTF-8 text along with its glyphs (as it does for PDF output);
 *   - cairo_show_text_glyphs records the text, its position in device
 *     space, size and colour, then draws exactly as before.
 * GDK's draw-frame/paint calls say which native window is being painted.
 * GTK 2 draws most text with gdk_draw_layout, also interposed: its lines
 * come from the PangoLayout.
 * When a frame ends (after its pixels went to the server), the runs drawn in
 * it are appended to the window's _SHIRO_TEXT property, one line each:
 *   "x baseline width ascent descent rrggbb\ttext\n"   (device pixels)
 * Xshiro consumes the property instead of storing it (server.ts).
 *
 * Built by build.sh against nothing but libc's dlsym: every other function
 * is looked up at run time, so it works with GTK 2 or 3 and any cairo.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { unsigned long index; double x, y; } cairo_glyph_t;
typedef struct { int num_bytes, num_glyphs; } cairo_text_cluster_t;
typedef struct { double x_bearing, y_bearing, width, height, x_advance, y_advance; } cairo_text_extents_t;
typedef struct { double ascent, descent, height, max_x_advance, max_y_advance; } cairo_font_extents_t;
typedef void cairo_t, cairo_surface_t, cairo_scaled_font_t, cairo_pattern_t, GdkWindow, GdkDisplay, Display;

#define SYM(name) static __typeof__(name##_t) *p_##name
#define LOOKUP(name, h) ({ if (!p_##name) p_##name = (__typeof__(p_##name))dlsym(h, #name); p_##name; })

typedef void cairo_show_text_glyphs_t(cairo_t *, const char *, int, const cairo_glyph_t *, int, const cairo_text_cluster_t *, int, int);
typedef void cairo_user_to_device_t(cairo_t *, double *, double *);
typedef void cairo_user_to_device_distance_t(cairo_t *, double *, double *);
typedef cairo_scaled_font_t *cairo_get_scaled_font_t(cairo_t *);
typedef void cairo_scaled_font_extents_t(cairo_scaled_font_t *, cairo_font_extents_t *);
typedef void cairo_scaled_font_glyph_extents_t(cairo_scaled_font_t *, const cairo_glyph_t *, int, cairo_text_extents_t *);
typedef cairo_pattern_t *cairo_get_source_t(cairo_t *);
typedef int cairo_pattern_get_rgba_t(cairo_pattern_t *, double *, double *, double *, double *);
typedef void *gdk_window_begin_draw_frame_t(GdkWindow *, const void *);
typedef void gdk_window_end_draw_frame_t(GdkWindow *, void *);
typedef void gdk_window_begin_paint_region_t(GdkWindow *, const void *);
typedef void gdk_window_end_paint_t(GdkWindow *);
typedef GdkDisplay *gdk_window_get_display_t(GdkWindow *);
typedef Display *gdk_x11_display_get_xdisplay_t(GdkDisplay *);
typedef unsigned long gdk_x11_window_get_xid_t(GdkWindow *);
typedef unsigned long gdk_x11_drawable_get_xid_t(GdkWindow *);
typedef Display *gdk_x11_drawable_get_xdisplay_t(GdkWindow *);
typedef int gdk_window_get_scale_factor_t(GdkWindow *);
typedef void PangoLayout, PangoLayoutIter, GdkGC;
typedef struct { int x, y, width, height; } PangoRectangle;
typedef struct { void *layout; int start_index, length; } PangoLayoutLineHead;
typedef void gdk_draw_layout_t(GdkWindow *, GdkGC *, int, int, PangoLayout *);
typedef void gdk_draw_layout_with_colors_t(GdkWindow *, GdkGC *, int, int, PangoLayout *, const void *, const void *);
typedef PangoLayoutIter *pango_layout_get_iter_t(PangoLayout *);
typedef PangoLayoutLineHead *pango_layout_iter_get_line_readonly_t(PangoLayoutIter *);
typedef void pango_layout_iter_get_line_extents_t(PangoLayoutIter *, PangoRectangle *, PangoRectangle *);
typedef int pango_layout_iter_get_baseline_t(PangoLayoutIter *);
typedef int pango_layout_iter_next_line_t(PangoLayoutIter *);
typedef void pango_layout_iter_free_t(PangoLayoutIter *);
typedef const char *pango_layout_get_text_t(PangoLayout *);
typedef unsigned long XInternAtom_t(Display *, const char *, int);
typedef int XChangeProperty_t(Display *, unsigned long, unsigned long, unsigned long, int, int, const unsigned char *, int);

SYM(cairo_show_text_glyphs); SYM(cairo_user_to_device);
SYM(cairo_user_to_device_distance); SYM(cairo_get_scaled_font); SYM(cairo_scaled_font_extents);
SYM(cairo_scaled_font_glyph_extents); SYM(cairo_get_source); SYM(cairo_pattern_get_rgba);
SYM(gdk_window_begin_draw_frame); SYM(gdk_window_end_draw_frame); SYM(gdk_window_begin_paint_region);
SYM(gdk_window_end_paint); SYM(gdk_window_get_display); SYM(gdk_x11_display_get_xdisplay);
SYM(gdk_x11_window_get_xid); SYM(gdk_x11_drawable_get_xid); SYM(gdk_x11_drawable_get_xdisplay);
SYM(XInternAtom); SYM(XChangeProperty); SYM(gdk_window_get_scale_factor);
SYM(gdk_draw_layout); SYM(gdk_draw_layout_with_colors); SYM(pango_layout_get_iter); SYM(pango_layout_iter_get_line_readonly);
SYM(pango_layout_iter_get_line_extents); SYM(pango_layout_iter_get_baseline); SYM(pango_layout_iter_next_line);
SYM(pango_layout_iter_free); SYM(pango_layout_get_text);

/* The frames being painted (nested paints are rare but allowed) */
#define MAXDEPTH 8
static GdkWindow *frames[MAXDEPTH];
static int depth;
static char *buf;
static size_t len, cap;

/* SHIRO_TEXT_DEBUG=1: say what was intercepted on stderr */
static int dbg = -1;
#define DBG(...) do { if (dbg < 0) dbg = getenv("SHIRO_TEXT_DEBUG") != NULL; if (dbg) fprintf(stderr, "[text-hook] " __VA_ARGS__); } while (0)

static void append(const char *s, size_t n) {
  if (len + n + 1 > cap) {
    size_t c = cap ? cap * 2 : 4096;
    while (c < len + n + 1) c *= 2;
    char *b = realloc(buf, c);
    if (!b) return;
    buf = b; cap = c;
  }
  memcpy(buf + len, s, n);
  len += n;
}

int cairo_surface_has_show_text_glyphs(cairo_surface_t *s) {
  (void)s;
  return 1; /* cairo falls back to plain glyphs on surfaces without text support */
}

void cairo_show_text_glyphs(cairo_t *cr, const char *utf8, int utf8_len, const cairo_glyph_t *glyphs, int num_glyphs,
                            const cairo_text_cluster_t *clusters, int num_clusters, int flags) {
  LOOKUP(cairo_show_text_glyphs, RTLD_NEXT)(cr, utf8, utf8_len, glyphs, num_glyphs, clusters, num_clusters, flags);
  DBG("cairo_show_text_glyphs %d bytes depth %d\n", utf8_len, depth);
  if (!depth || !utf8 || num_glyphs <= 0) return;
  if (utf8_len < 0) utf8_len = (int)strlen(utf8);
  if (!utf8_len) return;
  cairo_scaled_font_t *sf = LOOKUP(cairo_get_scaled_font, RTLD_DEFAULT)(cr);
  cairo_font_extents_t fe;
  cairo_text_extents_t te;
  LOOKUP(cairo_scaled_font_extents, RTLD_DEFAULT)(sf, &fe);
  LOOKUP(cairo_scaled_font_glyph_extents, RTLD_DEFAULT)(sf, &glyphs[num_glyphs - 1], 1, &te);
  double x0 = glyphs[0].x, y0 = glyphs[0].y, x1 = glyphs[num_glyphs - 1].x + te.x_advance, y1 = glyphs[num_glyphs - 1].y;
  LOOKUP(cairo_user_to_device, RTLD_DEFAULT)(cr, &x0, &y0);
  LOOKUP(cairo_user_to_device, RTLD_DEFAULT)(cr, &x1, &y1);
  double ax = 0, ay = fe.ascent, dx = 0, dy = fe.descent;
  LOOKUP(cairo_user_to_device_distance, RTLD_DEFAULT)(cr, &ax, &ay);
  LOOKUP(cairo_user_to_device_distance, RTLD_DEFAULT)(cr, &dx, &dy);
  /* GTK 3's window scale (GDK_SCALE) is the surface's device scale, outside the CTM */
  int k = LOOKUP(gdk_window_get_scale_factor, RTLD_DEFAULT) && frames[0] ? p_gdk_window_get_scale_factor(frames[0]) : 1;
  if (k > 1) { x0 *= k; y0 *= k; x1 *= k; y1 *= k; ay *= k; dy *= k; }
  double r = 0, g = 0, b = 0, a = 1;
  LOOKUP(cairo_pattern_get_rgba, RTLD_DEFAULT)(LOOKUP(cairo_get_source, RTLD_DEFAULT)(cr), &r, &g, &b, &a);
  char head[160];
  int n = snprintf(head, sizeof head, "%d %d %d %d %d %02x%02x%02x\t", (int)(x0 + 0.5), (int)(y0 + 0.5), (int)(x1 - x0 + 0.5),
                   (int)(ay + 0.5), (int)(dy + 0.5), (int)(r * 255 + 0.5), (int)(g * 255 + 0.5), (int)(b * 255 + 0.5));
  if (n <= 0) return;
  size_t start = len;
  append(head, (size_t)n);
  append(utf8, (size_t)utf8_len);
  for (size_t i = start + (size_t)n; i < len; i++) if (buf[i] == '\n' || buf[i] == '\t') buf[i] = ' ';
  append("\n", 1);
}

static void push(GdkWindow *w) {
  if (depth < MAXDEPTH) frames[depth] = w;
  if (depth++ == 0) len = 0;
}

/* Append `data` to window w's _SHIRO_TEXT, on the window's own X connection (so it follows its pixels) */
static void send(GdkWindow *w, const char *data, size_t n) {
  Display *dpy = NULL;
  unsigned long xid = 0;
  if (LOOKUP(gdk_x11_window_get_xid, RTLD_DEFAULT)) {                 /* GTK 3 */
    xid = p_gdk_x11_window_get_xid(w);
    if (LOOKUP(gdk_window_get_display, RTLD_DEFAULT) && LOOKUP(gdk_x11_display_get_xdisplay, RTLD_DEFAULT))
      dpy = p_gdk_x11_display_get_xdisplay(p_gdk_window_get_display(w));
  } else if (LOOKUP(gdk_x11_drawable_get_xid, RTLD_DEFAULT) && LOOKUP(gdk_x11_drawable_get_xdisplay, RTLD_DEFAULT)) { /* GTK 2 */
    xid = p_gdk_x11_drawable_get_xid(w);
    dpy = p_gdk_x11_drawable_get_xdisplay(w);
  }
  DBG("send %lu bytes to window 0x%lx (display %p)\n", (unsigned long)n, xid, (void *)dpy);
  if (dpy && xid && n && LOOKUP(XInternAtom, RTLD_DEFAULT) && LOOKUP(XChangeProperty, RTLD_DEFAULT)) {
    unsigned long prop = p_XInternAtom(dpy, "_SHIRO_TEXT", 0), utf8 = p_XInternAtom(dpy, "UTF8_STRING", 0);
    p_XChangeProperty(dpy, xid, prop, utf8, 8, 2 /* PropModeAppend */, (const unsigned char *)data, (int)n);
  }
}

/* After the frame's pixels: hand its runs to the server */
static void pop(GdkWindow *w) {
  if (depth <= 0) return;
  if (--depth > 0 || !len) return;
  send(w, buf, len);
  len = 0;
}

/*
 * GTK 2 draws most text (labels, menus, entries) with gdk_draw_layout, whose
 * renderer passes Pango glyphs without their text: take the lines from the
 * layout itself. x, y are in the drawable's (window's) coordinates.
 */
static int in_layout;

static void layout_text(GdkWindow *w, int x, int y, PangoLayout *layout) {
  DBG("gdk_draw_layout at %d,%d depth %d\n", x, y, depth);
  if (!LOOKUP(pango_layout_get_iter, RTLD_DEFAULT) || !LOOKUP(pango_layout_get_text, RTLD_DEFAULT)) return;
  const char *text = p_pango_layout_get_text(layout);
  PangoLayoutIter *it = p_pango_layout_get_iter(layout);
  if (!text || !it) return;
  char *line_buf = NULL;
  size_t line_len = 0, line_cap = 0;
  do {
    PangoLayoutLineHead *line = LOOKUP(pango_layout_iter_get_line_readonly, RTLD_DEFAULT)(it);
    PangoRectangle logical;
    LOOKUP(pango_layout_iter_get_line_extents, RTLD_DEFAULT)(it, NULL, &logical);
    int base = LOOKUP(pango_layout_iter_get_baseline, RTLD_DEFAULT)(it);
    if (!line || line->length <= 0 || logical.width <= 0) continue;
    int n = line->length;
    while (n > 0 && (text[line->start_index + n - 1] == '\n' || text[line->start_index + n - 1] == '\r')) n--;
    if (!n) continue;
    char head[160];
    int h = snprintf(head, sizeof head, "%d %d %d %d %d 000000\t", x + logical.x / 1024, y + base / 1024, logical.width / 1024,
                     (base - logical.y) / 1024, (logical.y + logical.height - base) / 1024);
    if (h <= 0) continue;
    size_t need = line_len + (size_t)h + (size_t)n + 2;
    if (need > line_cap) { char *b = realloc(line_buf, need * 2); if (!b) break; line_buf = b; line_cap = need * 2; }
    memcpy(line_buf + line_len, head, (size_t)h); line_len += (size_t)h;
    for (int i = 0; i < n; i++) { char c = text[line->start_index + i]; line_buf[line_len++] = c == '\t' || c == '\n' ? ' ' : c; }
    line_buf[line_len++] = '\n';
  } while (LOOKUP(pango_layout_iter_next_line, RTLD_DEFAULT)(it));
  LOOKUP(pango_layout_iter_free, RTLD_DEFAULT)(it);
  if (line_len) {
    /* inside a paint of this window: with the frame's runs, after its pixels; else at once */
    if (depth > 0 && frames[0] == w) append(line_buf, line_len);
    else send(w, line_buf, line_len);
  }
  free(line_buf);
}

void gdk_draw_layout_with_colors(GdkWindow *w, GdkGC *gc, int x, int y, PangoLayout *layout, const void *fg, const void *bg) {
  int outer = !in_layout++;
  LOOKUP(gdk_draw_layout_with_colors, RTLD_NEXT)(w, gc, x, y, layout, fg, bg);
  in_layout--;
  if (outer) layout_text(w, x, y, layout);
}

void gdk_draw_layout(GdkWindow *w, GdkGC *gc, int x, int y, PangoLayout *layout) {
  int outer = !in_layout++;
  LOOKUP(gdk_draw_layout, RTLD_NEXT)(w, gc, x, y, layout);
  in_layout--;
  if (outer) layout_text(w, x, y, layout);
}

void *gdk_window_begin_draw_frame(GdkWindow *w, const void *region) {
  void *ctx = LOOKUP(gdk_window_begin_draw_frame, RTLD_NEXT)(w, region);
  push(w);
  return ctx;
}

void gdk_window_end_draw_frame(GdkWindow *w, void *ctx) {
  LOOKUP(gdk_window_end_draw_frame, RTLD_NEXT)(w, ctx);
  pop(w);
}

void gdk_window_begin_paint_region(GdkWindow *w, const void *region) {
  LOOKUP(gdk_window_begin_paint_region, RTLD_NEXT)(w, region);
  push(w);
}

void gdk_window_end_paint(GdkWindow *w) {
  LOOKUP(gdk_window_end_paint, RTLD_NEXT)(w);
  pop(w);
}
