/*
 * libGLX_tabcomputer.so.0: a libglvnd GLX vendor library that forwards GL to
 * the page's WebGL2 (docs/research/GL.md, "Addendum: option B design").
 *
 * GL calls are encoded into a per-thread batch (gen/tc_gen.c, generated from
 * gl.xml by scripts/gl/gen.mjs) and written to glshiro, the page's GL server,
 * over the AF_UNIX socket /tmp/.tabcomputer-gl/0 (TABCOMPUTER_GL_SOCKET
 * overrides). GLX is answered here: FBConfigs come from the X server's own
 * visuals, GLX drawables are X window ids. Calls that need an answer from
 * the page flush and wait for a reply; the rest never wait.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <GL/glxtokens.h>
#include "gen/tc_gen.h"
#include "tc.h"

#ifndef GLX_SAMPLE_BUFFERS
#define GLX_SAMPLE_BUFFERS 100000
#define GLX_SAMPLES 100001
#endif
#ifndef GLX_CONTEXT_MINOR_VERSION_ARB
#define GLX_CONTEXT_MINOR_VERSION_ARB 0x2092
#endif
#ifndef GLX_CONTEXT_COMPATIBILITY_PROFILE_BIT_ARB
#define GLX_CONTEXT_COMPATIBILITY_PROFILE_BIT_ARB 0x0002
#endif
#ifndef GLX_CONTEXT_ES2_PROFILE_BIT_EXT
#define GLX_CONTEXT_ES2_PROFILE_BIT_EXT 0x0004
#endif
#ifndef GLX_RENDER_TYPE
#define GLX_RENDER_TYPE 0x8011
#endif
#ifndef GLX_SWAP_INTERVAL_EXT
#define GLX_SWAP_INTERVAL_EXT 0x20F1
#define GLX_MAX_SWAP_INTERVAL_EXT 0x20F2
#endif
#ifndef GLX_RGBA_TYPE
#define GLX_RGBA_TYPE 0x8014
#endif

#define EXPORT __attribute__((visibility("default")))
#define BATCH_MAGIC 0x4c474354u /* "TCGL" */
#define BATCH_WORDS (64 * 1024)  /* 256 KB */
#define MSG_REPLY 1
#define MSG_FRAME 2
#define MSG_ERROR 3
#define MAX_FRAMES_AHEAD 2

typedef struct __GLXcontextRec *GLXContext;
typedef struct __GLXFBConfigRec *GLXFBConfig;
typedef XID GLXDrawable, GLXWindow, GLXPixmap, GLXPbuffer, GLXContextID;
typedef void (*__GLXextFuncPtr)(void);

/* ── glvnd ABI (libglxabi.h, ABI 1.x) ── */
typedef struct __GLXvendorInfoRec __GLXvendorInfo;
typedef struct {
  __GLXvendorInfo *(*getDynDispatch)(Display *dpy, const int screen);
  __GLXvendorInfo *(*getCurrentDynDispatch)(void);
  __GLXextFuncPtr (*fetchDispatchEntry)(__GLXvendorInfo *dynDispatch, int index);
  GLXContext (*getCurrentContext)(void);
  int (*addVendorContextMapping)(Display *dpy, GLXContext context, __GLXvendorInfo *vendor);
  void (*removeVendorContextMapping)(Display *dpy, GLXContext context);
  __GLXvendorInfo *(*vendorFromContext)(GLXContext context);
  int (*addVendorFBConfigMapping)(Display *dpy, GLXFBConfig config, __GLXvendorInfo *vendor);
  void (*removeVendorFBConfigMapping)(Display *dpy, GLXFBConfig config);
  __GLXvendorInfo *(*vendorFromFBConfig)(Display *dpy, GLXFBConfig config);
  int (*addVendorDrawableMapping)(Display *dpy, GLXDrawable drawable, __GLXvendorInfo *vendor);
  void (*removeVendorDrawableMapping)(Display *dpy, GLXDrawable drawable);
  __GLXvendorInfo *(*vendorFromDrawable)(Display *dpy, GLXDrawable drawable);
} __GLXapiExports;
typedef struct {
  Bool (*isScreenSupported)(Display *dpy, int screen);
  void *(*getProcAddress)(const GLubyte *procName);
  void *(*getDispatchAddress)(const GLubyte *procName);
  void (*setDispatchIndex)(const GLubyte *procName, int index);
  Bool (*notifyError)(Display *dpy, unsigned char error, XID resid, unsigned char opcode, Bool coreX11error);
  GLboolean (*isPatchSupported)(int type, int stubSize);
  GLboolean (*initiatePatch)(int type, int stubSize, void *lookupStubOffset);
  void (*releasePatch)(void);
  void (*patchThreadAttach)(void);
} __GLXapiImports;

static const __GLXapiExports *glvnd;
static __GLXvendorInfo *our_vendor;

/* ── logging ── */
static int debug_level = -1;
static int dbg(void) {
  if (debug_level < 0) { const char *e = getenv("TABCOMPUTER_GL_DEBUG"); debug_level = e && *e >= '1' && *e <= '9' ? *e - '0' : 0; }
  return debug_level;
}
static void logf_(const char *fmt, ...) {
  va_list ap; va_start(ap, fmt);
  fprintf(stderr, "libGLX_tabcomputer: ");
  vfprintf(stderr, fmt, ap);
  fputc('\n', stderr);
  va_end(ap);
}

/* ── connection ── */
static pthread_mutex_t sock_lock = PTHREAD_MUTEX_INITIALIZER;
static int sock_fd = -1;
static int sock_failed;
static int sync_errors = -1;
static uint32_t frames_sent, frames_acked;

static int write_all(const void *p, size_t n) {
  const uint8_t *b = p;
  while (n) {
    ssize_t r = write(sock_fd, b, n);
    if (r < 0) { if (errno == EINTR) continue; return -1; }
    b += r; n -= (size_t)r;
  }
  return 0;
}
static int read_all(void *p, size_t n) {
  uint8_t *b = p;
  while (n) {
    ssize_t r = read(sock_fd, b, n);
    if (r < 0) { if (errno == EINTR) continue; return -1; }
    if (r == 0) return -1;
    b += r; n -= (size_t)r;
  }
  return 0;
}

static void lost_connection(void) {
  if (sock_fd >= 0) { logf_("lost the connection to the page's GL server"); close(sock_fd); }
  sock_fd = -1;
  sock_failed = 1;
}

struct tc_ctx;
static struct tc_ctx *ctx_by_id(uint32_t id);
static void record_error(struct tc_ctx *c, GLenum e);

/* Reads one message from the page; frame acks and errors are handled here.
 * Returns the message kind with *payload malloc'd, or -1. Caller holds sock_lock. */
static int read_message(uint8_t **payload, uint32_t *len) {
  uint32_t h[2];
  if (sock_fd < 0 || read_all(h, 8) < 0) { lost_connection(); return -1; }
  uint8_t *p = malloc(h[1] ? h[1] : 1);
  if (!p || read_all(p, h[1]) < 0) { free(p); lost_connection(); return -1; }
  if (h[0] == MSG_FRAME && h[1] >= 4) { memcpy(&frames_acked, p, 4); free(p); return MSG_FRAME; }
  if (h[0] == MSG_ERROR && h[1] >= 8) {
    uint32_t id, e; memcpy(&id, p, 4); memcpy(&e, p + 4, 4);
    struct tc_ctx *c = ctx_by_id(id);
    if (c) record_error(c, e);
    if (dbg()) logf_("GL error 0x%x in context %u", e, id);
    free(p); return MSG_ERROR;
  }
  *payload = p; *len = h[1];
  return (int)h[0];
}

static int connect_server(void) {
  if (sock_fd >= 0) return 0;
  if (sock_failed) return -1;
  const char *path = getenv("TABCOMPUTER_GL_SOCKET");
  if (!path || !*path) path = "/tmp/.tabcomputer-gl/0";
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  struct sockaddr_un a = { .sun_family = AF_UNIX };
  strncpy(a.sun_path, path, sizeof a.sun_path - 1);
  if (fd < 0 || connect(fd, (struct sockaddr *)&a, sizeof a) < 0) {
    logf_("can't reach the page's GL server at %s: %s", path, strerror(errno));
    if (fd >= 0) close(fd);
    sock_failed = 1;
    return -1;
  }
  sock_fd = fd;
  /* hello: protocol, pid, program name (control batch, context 0) */
  char name[256] = "";
  ssize_t n = readlink("/proc/self/exe", name, sizeof name - 1);
  if (n > 0) name[n] = 0;
  size_t nl = strlen(name) + 1, aw = (nl + 3) / 4;
  uint32_t *b = calloc(3 + 1 + 2 + 1 + aw, 4);
  b[0] = BATCH_MAGIC; b[1] = 0; b[2] = (uint32_t)((3 + 1 + 2 + 1 + aw) * 4);
  b[3] = OP_tcHello | (uint32_t)((1 + 2 + 1 + aw) << 16);
  b[4] = TC_PROTOCOL; b[5] = (uint32_t)getpid(); b[6] = (uint32_t)nl;
  memcpy(b + 7, name, nl);
  int ok = write_all(b, b[2]) == 0;
  free(b);
  uint8_t *p = NULL; uint32_t len = 0; int k;
  while (ok && (k = read_message(&p, &len)) != MSG_REPLY) if (k < 0) ok = 0;
  if (!ok || len < 4 || *(uint32_t *)p != 1) {
    logf_("the page's GL server refused the connection (protocol %08x)", TC_PROTOCOL);
    free(p); lost_connection(); return -1;
  }
  free(p);
  return 0;
}

/* ── share groups, contexts, objects ── */
enum { NS_TEXTURE, NS_BUFFER, NS_FRAMEBUFFER, NS_RENDERBUFFER, NS_QUERY, NS_VERTEX_ARRAY, NS_SAMPLER,
       NS_TRANSFORM_FEEDBACK, NS_PIPELINE, NS_PROGRAM, NS_LIST, NS_SYNC, NS_COUNT };
struct tc_uniform { char *name; uint32_t type; int32_t size, loc; };
struct tc_object { /* a shader or program, by name */
  int kind; /* 0 none, 1 shader, 2 program */
  GLenum type;
  int info_valid; int status; char *log; char *source;
  int validate_status;
  struct tc_uniform *attribs, *uniforms, *blocks;
  uint32_t nattribs, nuniforms, nblocks;
  uint32_t attached[8]; int nattached;
  uint32_t tf_mode, tf_count; char *tf_names;
};
struct tc_share {
  int refs;
  uint32_t next[NS_COUNT];
  struct tc_object *objs; uint32_t nobjs;
};
#define NLIMITS 128
struct tc_ctx {
  uint32_t id;
  Display *dpy;
  struct tc_share *share;
  int major, minor, profile, flags;
  int fbconfig;
  GLXDrawable draw, read;
  int bound; /* current in some thread */
  int destroyed;
  int info_valid;
  char *strings[5]; /* vendor renderer version glsl extensions */
  char **ext_list; uint32_t next_list;
  uint32_t limit_pname[NLIMITS]; uint8_t limit_n[NLIMITS]; double *limit_val[NLIMITS]; int nlimits;
  GLenum error;
  int swap_interval;
  /* client state the guest needs */
  struct tc_carray { uint8_t enabled, client; GLint size; GLenum type; GLsizei stride; const uint8_t *ptr; } arrays[29];
  GLuint client_unit, vao;
  int in_begin;
  uint32_t list_mode;
  GLsync next_sync;
  struct tc_ctx *next_ctx;
};
static pthread_mutex_t ctx_lock = PTHREAD_MUTEX_INITIALIZER;
static struct tc_ctx *contexts;
static uint32_t next_ctx_id = 1;

static struct tc_ctx *ctx_by_id(uint32_t id) {
  for (struct tc_ctx *c = contexts; c; c = c->next_ctx) if (c->id == id) return c;
  return NULL;
}
static void record_error(struct tc_ctx *c, GLenum e) { if (!c->error) c->error = e; }

static struct tc_object *object(struct tc_share *s, uint32_t name, int create) {
  if (name >= s->nobjs) {
    if (!create) return NULL;
    uint32_t n = s->nobjs ? s->nobjs : 64;
    while (n <= name) n *= 2;
    s->objs = realloc(s->objs, n * sizeof *s->objs);
    memset(s->objs + s->nobjs, 0, (n - s->nobjs) * sizeof *s->objs);
    s->nobjs = n;
  }
  struct tc_object *o = &s->objs[name];
  return o->kind || create ? o : NULL;
}
static void free_info(struct tc_object *o) {
  free(o->log); o->log = NULL;
  for (uint32_t i = 0; i < o->nattribs; i++) free(o->attribs[i].name);
  for (uint32_t i = 0; i < o->nuniforms; i++) free(o->uniforms[i].name);
  for (uint32_t i = 0; i < o->nblocks; i++) free(o->blocks[i].name);
  free(o->attribs); free(o->uniforms); free(o->blocks);
  o->attribs = o->uniforms = o->blocks = NULL; o->nattribs = o->nuniforms = o->nblocks = 0;
  o->info_valid = 0;
}

/* ── per-thread batches ── */
struct tc_thread {
  struct tc_ctx *ctx;
  uint32_t *buf; size_t used; /* words, after the 3-word batch header */
  uint32_t *big; size_t big_words;
};
static __thread struct tc_thread T;

static int send_batch(uint32_t ctxid, uint32_t *b, size_t words) {
  b[0] = BATCH_MAGIC; b[1] = ctxid; b[2] = (uint32_t)(words * 4);
  if (sock_fd < 0) return -1;
  if (write_all(b, words * 4) < 0) { lost_connection(); return -1; }
  return 0;
}
/* Sends the thread's batch. Caller holds sock_lock or passes locked=0. */
static void flush_locked(void) {
  if (!T.buf || !T.used) return;
  send_batch(T.ctx ? T.ctx->id : 0, T.buf, 3 + T.used);
  T.used = 0;
}
static void flush(void) {
  if (!T.buf || !T.used) return;
  pthread_mutex_lock(&sock_lock);
  flush_locked();
  pthread_mutex_unlock(&sock_lock);
}

uint32_t *tc_begin(size_t argwords, unsigned op) {
  if (!T.ctx || sock_fd < 0) return NULL;
  size_t hw = argwords + 1 < 0x10000 ? 1 : 2, need = hw + argwords;
  if (!T.buf) { T.buf = malloc((3 + BATCH_WORDS) * 4); T.used = 0; if (!T.buf) return NULL; }
  uint32_t *w;
  if (T.used + need > BATCH_WORDS) {
    flush();
    if (need > BATCH_WORDS) {
      T.big = malloc((3 + need) * 4);
      if (!T.big) return NULL;
      T.big_words = 3 + need;
      w = T.big + 3;
      goto header;
    }
  }
  w = T.buf + 3 + T.used;
  T.used += need;
header:
  if (hw == 1) w[0] = op | (uint32_t)(need << 16);
  else { w[0] = op; w[1] = (uint32_t)need; }
  return w + hw;
}
void tc_end(void) {
  if (!T.big) return;
  pthread_mutex_lock(&sock_lock);
  send_batch(T.ctx ? T.ctx->id : 0, T.big, T.big_words);
  pthread_mutex_unlock(&sock_lock);
  free(T.big); T.big = NULL;
}
uint32_t *tc_put_array(uint32_t *w, const void *p, size_t n) {
  if (!p) { *w++ = 0xffffffffu; return w; }
  *w++ = (uint32_t)n;
  if (n) { memcpy(w, p, n); if (n & 3) memset((uint8_t *)w + n, 0, 4 - (n & 3)); }
  return w + ((n + 3) >> 2);
}
void tc_unimplemented(const char *name) {
  static const char *seen[64]; static int nseen;
  for (int i = 0; i < nseen; i++) if (seen[i] == name) return;
  if (nseen < 64) seen[nseen++] = name;
  logf_("%s is not implemented", name);
}

/* A command whose answer the page sends back: flushes the batch (ending
 * with the command just encoded) and waits for the reply. Returns a malloc'd
 * payload (free it) or NULL. */
static uint8_t *call_reply(uint32_t *len) {
  uint8_t *p = NULL; uint32_t n = 0;
  pthread_mutex_lock(&sock_lock);
  flush_locked();
  int k;
  while ((k = read_message(&p, &n)) != MSG_REPLY) if (k < 0) { pthread_mutex_unlock(&sock_lock); *len = 0; return NULL; }
  pthread_mutex_unlock(&sock_lock);
  *len = n;
  return p;
}
/* control batch (context 0 or a given context), outside any thread's buffer */
static void control(uint32_t ctxid, unsigned op, const uint32_t *args, size_t nargs) {
  uint32_t b[16];
  b[3] = op | (uint32_t)((nargs + 1) << 16);
  memcpy(b + 4, args, nargs * 4);
  pthread_mutex_lock(&sock_lock);
  send_batch(ctxid, b, 4 + nargs);
  pthread_mutex_unlock(&sock_lock);
}

/* reply readers */
struct rd { const uint8_t *p, *end; };
static uint32_t rd_u32(struct rd *r) { uint32_t v = 0; if (r->p + 4 <= r->end) memcpy(&v, r->p, 4); r->p += 4; return v; }
static double rd_f64(struct rd *r) { double v = 0; if (r->p + 8 <= r->end) memcpy(&v, r->p, 8); r->p += 8; return v; }
static char *rd_str(struct rd *r) {
  uint32_t n = rd_u32(r);
  if (r->p + n > r->end) n = 0;
  char *s = malloc(n + 1);
  memcpy(s, r->p, n); s[n] = 0;
  r->p += (n + 3) & ~3u;
  return s;
}

static GLenum local_error(GLenum e) { if (T.ctx) record_error(T.ctx, e); return e; }

/* ── context info: strings and limits, once per context ── */
static void fetch_info(struct tc_ctx *c) {
  if (c->info_valid || T.ctx != c) return;
  uint32_t *w = tc_begin(0, OP_tcContextInfo);
  if (!w) return;
  tc_end();
  uint32_t len; uint8_t *p = call_reply(&len);
  if (!p) return;
  struct rd r = { p, p + len };
  for (int i = 0; i < 5; i++) c->strings[i] = rd_str(&r);
  uint32_t n = rd_u32(&r);
  for (uint32_t i = 0; i < n && c->nlimits < NLIMITS; i++) {
    uint32_t pname = rd_u32(&r), k = rd_u32(&r);
    double *v = malloc((k ? k : 1) * sizeof *v);
    for (uint32_t j = 0; j < k; j++) v[j] = rd_f64(&r);
    c->limit_pname[c->nlimits] = pname; c->limit_n[c->nlimits] = (uint8_t)k; c->limit_val[c->nlimits] = v; c->nlimits++;
  }
  /* extensions as a list for glGetStringi */
  uint32_t count = 0;
  for (char *s = c->strings[4]; *s; s++) if (*s != ' ' && (s == c->strings[4] || s[-1] == ' ')) count++;
  c->ext_list = calloc(count + 1, sizeof *c->ext_list);
  char *dup = strdup(c->strings[4]), *save = NULL; uint32_t i = 0;
  for (char *t = strtok_r(dup, " ", &save); t && i < count; t = strtok_r(NULL, " ", &save)) c->ext_list[i++] = strdup(t);
  free(dup);
  free(p);
  c->info_valid = 1;
}
static int find_limit(struct tc_ctx *c, GLenum pname) {
  for (int i = 0; i < c->nlimits; i++) if (c->limit_pname[i] == pname) return i;
  return -1;
}

/* ── GL calls done by hand ── */
#define CUR() struct tc_ctx *c = T.ctx; if (!c) return
#define CUR0() struct tc_ctx *c = T.ctx; if (!c) return 0

const GLubyte *tc_glGetString(GLenum name) {
  CUR0();
  fetch_info(c);
  if (!c->info_valid) return NULL;
  switch (name) {
  case GL_VENDOR: return (const GLubyte *)c->strings[0];
  case GL_RENDERER: return (const GLubyte *)c->strings[1];
  case GL_VERSION: return (const GLubyte *)c->strings[2];
  case GL_SHADING_LANGUAGE_VERSION: return (const GLubyte *)c->strings[3];
  case GL_EXTENSIONS: return c->profile & GLX_CONTEXT_CORE_PROFILE_BIT_ARB ? (local_error(GL_INVALID_ENUM), NULL) : (const GLubyte *)c->strings[4];
  }
  local_error(GL_INVALID_ENUM);
  return NULL;
}
const GLubyte *tc_glGetStringi(GLenum name, GLuint index) {
  CUR0();
  fetch_info(c);
  if (name != GL_EXTENSIONS || !c->ext_list) { local_error(GL_INVALID_ENUM); return NULL; }
  for (GLuint i = 0; c->ext_list[i]; i++) if (i == index) return (const GLubyte *)c->ext_list[i];
  local_error(GL_INVALID_VALUE);
  return NULL;
}

GLenum tc_glGetError(void) {
  CUR0();
  if (sync_errors < 0) { const char *e = getenv("TABCOMPUTER_GL_SYNC"); sync_errors = e && *e == '1'; }
  if (sync_errors) {
    uint32_t *w = tc_begin(0, OP_glGetError);
    if (w) { tc_end(); uint32_t len; uint8_t *p = call_reply(&len); if (p) { uint32_t e = len >= 4 ? *(uint32_t *)p : 0; free(p); if (e) record_error(c, e); } }
  }
  GLenum e = c->error;
  c->error = GL_NO_ERROR;
  return e;
}

/* glGet*: limits from the context's table, else a round trip; values come back as doubles */
static int get_values(GLenum op, GLenum pname, const uint32_t *extra, int nextra, double *out, int max) {
  struct tc_ctx *c = T.ctx;
  if (!c) return 0;
  fetch_info(c);
  if (nextra == 0) {
    int i = find_limit(c, pname);
    if (i >= 0) { int n = c->limit_n[i] < max ? c->limit_n[i] : max; memcpy(out, c->limit_val[i], (size_t)n * sizeof *out); return n; }
  }
  uint32_t *w = tc_begin(1 + (size_t)nextra, op);
  if (!w) return 0;
  w[0] = pname;
  for (int i = 0; i < nextra; i++) w[1 + i] = extra[i];
  tc_end();
  uint32_t len; uint8_t *p = call_reply(&len);
  if (!p) return 0;
  int n = (int)(len / 8);
  if (n > max) n = max;
  memcpy(out, p, (size_t)n * 8);
  free(p);
  return n;
}
#define GETV(fn, T_, op, conv) void tc_##fn(GLenum pname, T_ *data) { \
  double v[64]; int n = get_values(op, pname, NULL, 0, v, 64); \
  for (int i = 0; i < n; i++) data[i] = conv; }
GETV(glGetIntegerv, GLint, OP_glGetIntegerv, (GLint)(v[i] < -2147483648.0 ? -2147483647 - 1 : v[i] > 2147483647.0 ? (GLint)(int64_t)v[i] : (GLint)v[i]))
GETV(glGetFloatv, GLfloat, OP_glGetFloatv, (GLfloat)v[i])
GETV(glGetDoublev, GLdouble, OP_glGetDoublev, v[i])
GETV(glGetBooleanv, GLboolean, OP_glGetBooleanv, (GLboolean)(v[i] != 0))
GETV(glGetInteger64v, GLint64, OP_glGetInteger64v, (GLint64)v[i])
#define GETIV(fn, T_, op, conv) void tc_##fn(GLenum pname, GLuint index, T_ *data) { \
  double v[16]; uint32_t x = index; int n = get_values(op, pname, &x, 1, v, 16); \
  for (int i = 0; i < n; i++) data[i] = conv; }
GETIV(glGetIntegeri_v, GLint, OP_glGetIntegeri_v, (GLint)v[i])
GETIV(glGetBooleani_v, GLboolean, OP_glGetBooleani_v, (GLboolean)(v[i] != 0))
GETIV(glGetInteger64i_v, GLint64, OP_glGetInteger64i_v, (GLint64)v[i])
/* two-argument getters (target, pname) → values */
#define GET2(fn, A, T_, op, conv) void tc_##fn(A target, GLenum pname, T_ *params) { \
  double v[16]; uint32_t x = pname; int n = get_values(op, (GLenum)target, &x, 1, v, 16); \
  for (int i = 0; i < n; i++) params[i] = conv; }
GET2(glGetTexParameteriv, GLenum, GLint, OP_glGetTexParameteriv, (GLint)v[i])
GET2(glGetTexParameterfv, GLenum, GLfloat, OP_glGetTexParameterfv, (GLfloat)v[i])
GET2(glGetRenderbufferParameteriv, GLenum, GLint, OP_glGetRenderbufferParameteriv, (GLint)v[i])
GET2(glGetBufferParameteriv, GLenum, GLint, OP_glGetBufferParameteriv, (GLint)v[i])
GET2(glGetBufferParameteri64v, GLenum, GLint64, OP_glGetBufferParameteri64v, (GLint64)v[i])
GET2(glGetQueryiv, GLenum, GLint, OP_glGetQueryiv, (GLint)v[i])
GET2(glGetQueryObjectiv, GLuint, GLint, OP_glGetQueryObjectiv, (GLint)v[i])
GET2(glGetQueryObjectuiv, GLuint, GLuint, OP_glGetQueryObjectuiv, (GLuint)v[i])
GET2(glGetQueryObjecti64v, GLuint, GLint64, OP_glGetQueryObjecti64v, (GLint64)v[i])
GET2(glGetQueryObjectui64v, GLuint, GLuint64, OP_glGetQueryObjectui64v, (GLuint64)v[i])
GET2(glGetVertexAttribiv, GLuint, GLint, OP_glGetVertexAttribiv, (GLint)v[i])
GET2(glGetVertexAttribfv, GLuint, GLfloat, OP_glGetVertexAttribfv, (GLfloat)v[i])
GET2(glGetVertexAttribdv, GLuint, GLdouble, OP_glGetVertexAttribdv, v[i])
GET2(glGetVertexAttribIiv, GLuint, GLint, OP_glGetVertexAttribIiv, (GLint)v[i])
GET2(glGetVertexAttribIuiv, GLuint, GLuint, OP_glGetVertexAttribIuiv, (GLuint)v[i])
GET2(glGetLightfv, GLenum, GLfloat, OP_glGetLightfv, (GLfloat)v[i])
GET2(glGetLightiv, GLenum, GLint, OP_glGetLightiv, (GLint)v[i])
GET2(glGetMaterialfv, GLenum, GLfloat, OP_glGetMaterialfv, (GLfloat)v[i])
GET2(glGetMaterialiv, GLenum, GLint, OP_glGetMaterialiv, (GLint)v[i])
GET2(glGetTexEnvfv, GLenum, GLfloat, OP_glGetTexEnvfv, (GLfloat)v[i])
GET2(glGetTexEnviv, GLenum, GLint, OP_glGetTexEnviv, (GLint)v[i])
GET2(glGetSamplerParameteriv, GLuint, GLint, OP_glGetSamplerParameteriv, (GLint)v[i])
GET2(glGetSamplerParameterfv, GLuint, GLfloat, OP_glGetSamplerParameterfv, (GLfloat)v[i])
GET2(glGetMultisamplefv, GLenum, GLfloat, OP_glGetMultisamplefv, (GLfloat)v[i])
void tc_glGetTexLevelParameteriv(GLenum target, GLint level, GLenum pname, GLint *params) {
  double v[4]; uint32_t x[2] = { (uint32_t)level, pname }; int n = get_values(OP_glGetTexLevelParameteriv, target, x, 2, v, 4);
  for (int i = 0; i < n; i++) params[i] = (GLint)v[i];
}
void tc_glGetTexLevelParameterfv(GLenum target, GLint level, GLenum pname, GLfloat *params) {
  double v[4]; uint32_t x[2] = { (uint32_t)level, pname }; int n = get_values(OP_glGetTexLevelParameterfv, target, x, 2, v, 4);
  for (int i = 0; i < n; i++) params[i] = (GLfloat)v[i];
}
void tc_glGetFramebufferAttachmentParameteriv(GLenum target, GLenum attachment, GLenum pname, GLint *params) {
  double v[4]; uint32_t x[2] = { attachment, pname }; int n = get_values(OP_glGetFramebufferAttachmentParameteriv, target, x, 2, v, 4);
  for (int i = 0; i < n; i++) params[i] = (GLint)v[i];
}
static uint32_t ask_u32(unsigned op, const uint32_t *args, int nargs) {
  uint32_t *w = tc_begin((size_t)nargs, op);
  if (!w) return 0;
  memcpy(w, args, (size_t)nargs * 4);
  tc_end();
  uint32_t len; uint8_t *p = call_reply(&len);
  uint32_t v = p && len >= 4 ? *(uint32_t *)p : 0;
  free(p);
  return v;
}
#define ASK1(fn, A, R, op) R tc_##fn(A x) { uint32_t a = (uint32_t)x; return (R)ask_u32(op, &a, 1); }
ASK1(glIsEnabled, GLenum, GLboolean, OP_glIsEnabled)
ASK1(glIsTexture, GLuint, GLboolean, OP_glIsTexture)
ASK1(glIsBuffer, GLuint, GLboolean, OP_glIsBuffer)
ASK1(glIsFramebuffer, GLuint, GLboolean, OP_glIsFramebuffer)
ASK1(glIsRenderbuffer, GLuint, GLboolean, OP_glIsRenderbuffer)
ASK1(glIsList, GLuint, GLboolean, OP_glIsList)
ASK1(glIsQuery, GLuint, GLboolean, OP_glIsQuery)
ASK1(glIsVertexArray, GLuint, GLboolean, OP_glIsVertexArray)
ASK1(glIsSampler, GLuint, GLboolean, OP_glIsSampler)
ASK1(glCheckFramebufferStatus, GLenum, GLenum, OP_glCheckFramebufferStatus)
ASK1(glRenderMode, GLenum, GLint, OP_glRenderMode)
GLboolean tc_glIsEnabledi(GLenum cap, GLuint i) { uint32_t a[2] = { cap, i }; return (GLboolean)ask_u32(OP_glIsEnabledi, a, 2); }
GLboolean tc_glIsProgram(GLuint p) { CUR0(); struct tc_object *o = object(c->share, p, 0); return o && o->kind == 2; }
GLboolean tc_glIsShader(GLuint s) { CUR0(); struct tc_object *o = object(c->share, s, 0); return o && o->kind == 1; }

void tc_glFinish(void) {
  if (!tc_begin(0, OP_glFinish)) return;
  tc_end();
  uint32_t len; free(call_reply(&len));
}
void tc_glFlush(void) {
  if (!tc_begin(0, OP_glFlush)) return;
  tc_end();
  flush();
}

/* names chosen here: no round trip */
static void gen_names(int ns, unsigned op, GLsizei n, GLuint *names) {
  CUR();
  if (n < 0) { local_error(GL_INVALID_VALUE); return; }
  for (GLsizei i = 0; i < n; i++) names[i] = ++c->share->next[ns];
  uint32_t *w = tc_begin(1 + (size_t)n, op);
  if (!w) return;
  tc_put_array(w, names, (size_t)n * 4);
  tc_end();
}
void tc_glGenTextures(GLsizei n, GLuint *t) { gen_names(NS_TEXTURE, OP_glGenTextures, n, t); }
void tc_glGenBuffers(GLsizei n, GLuint *t) { gen_names(NS_BUFFER, OP_glGenBuffers, n, t); }
void tc_glGenFramebuffers(GLsizei n, GLuint *t) { gen_names(NS_FRAMEBUFFER, OP_glGenFramebuffers, n, t); }
void tc_glGenRenderbuffers(GLsizei n, GLuint *t) { gen_names(NS_RENDERBUFFER, OP_glGenRenderbuffers, n, t); }
void tc_glGenQueries(GLsizei n, GLuint *t) { gen_names(NS_QUERY, OP_glGenQueries, n, t); }
void tc_glGenVertexArrays(GLsizei n, GLuint *t) { gen_names(NS_VERTEX_ARRAY, OP_glGenVertexArrays, n, t); }
void tc_glGenSamplers(GLsizei n, GLuint *t) { gen_names(NS_SAMPLER, OP_glGenSamplers, n, t); }
#ifdef OP_glGenProgramPipelines_
#endif
void tc_glGenProgramPipelines(GLsizei n, GLuint *t) { gen_names(NS_PIPELINE, OP_glGenProgramPipelines, n, t); }
GLuint tc_glGenLists(GLsizei range) {
  CUR0();
  if (range <= 0) { local_error(GL_INVALID_VALUE); return 0; }
  GLuint first = c->share->next[NS_LIST] + 1;
  c->share->next[NS_LIST] += (uint32_t)range;
  uint32_t *w = tc_begin(2, OP_glGenLists);
  if (!w) return 0;
  w[0] = (uint32_t)range; w[1] = first;
  tc_end();
  return first;
}
GLuint tc_glCreateShader(GLenum type) {
  CUR0();
  GLuint name = ++c->share->next[NS_PROGRAM];
  struct tc_object *o = object(c->share, name, 1);
  memset(o, 0, sizeof *o);
  o->kind = 1; o->type = type;
  uint32_t *w = tc_begin(2, OP_glCreateShader);
  if (!w) return 0;
  w[0] = type; w[1] = name;
  tc_end();
  return name;
}
GLuint tc_glCreateProgram(void) {
  CUR0();
  GLuint name = ++c->share->next[NS_PROGRAM];
  struct tc_object *o = object(c->share, name, 1);
  memset(o, 0, sizeof *o);
  o->kind = 2;
  uint32_t *w = tc_begin(1, OP_glCreateProgram);
  if (!w) return 0;
  w[0] = name;
  tc_end();
  return name;
}
static void simple1(unsigned op, uint32_t a) { uint32_t *w = tc_begin(1, op); if (w) { w[0] = a; tc_end(); } }
static void simple2(unsigned op, uint32_t a, uint32_t b) { uint32_t *w = tc_begin(2, op); if (w) { w[0] = a; w[1] = b; tc_end(); } }
void tc_glDeleteShader(GLuint s) {
  CUR();
  struct tc_object *o = object(c->share, s, 0);
  if (o && o->kind == 1) { free_info(o); free(o->source); memset(o, 0, sizeof *o); }
  simple1(OP_glDeleteShader, s);
}
void tc_glDeleteProgram(GLuint p) {
  CUR();
  struct tc_object *o = object(c->share, p, 0);
  if (o && o->kind == 2) { free_info(o); free(o->tf_names); memset(o, 0, sizeof *o); }
  simple1(OP_glDeleteProgram, p);
}
void tc_glAttachShader(GLuint p, GLuint s) {
  CUR();
  struct tc_object *o = object(c->share, p, 0);
  if (o && o->kind == 2 && o->nattached < 8) o->attached[o->nattached++] = s;
  simple2(OP_glAttachShader, p, s);
}
void tc_glDetachShader(GLuint p, GLuint s) {
  CUR();
  struct tc_object *o = object(c->share, p, 0);
  if (o) for (int i = 0; i < o->nattached; i++) if (o->attached[i] == s) { o->attached[i] = o->attached[--o->nattached]; break; }
  simple2(OP_glDetachShader, p, s);
}
void tc_glShaderSource(GLuint shader, GLsizei count, const GLchar *const *string, const GLint *length) {
  CUR();
  size_t total = 0;
  for (GLsizei i = 0; i < count; i++) total += length && length[i] >= 0 ? (size_t)length[i] : strlen(string[i]);
  char *src = malloc(total + 1), *q = src;
  for (GLsizei i = 0; i < count; i++) {
    size_t n = length && length[i] >= 0 ? (size_t)length[i] : strlen(string[i]);
    memcpy(q, string[i], n); q += n;
  }
  *q = 0;
  struct tc_object *o = object(c->share, shader, 0);
  if (o) { free(o->source); o->source = src; }
  uint32_t *w = tc_begin(1 + 1 + (total + 3) / 4, OP_glShaderSource);
  if (w) { w[0] = shader; tc_put_array(w + 1, src, total); tc_end(); }
  if (!o) free(src);
}
void tc_glCompileShader(GLuint s) {
  CUR();
  struct tc_object *o = object(c->share, s, 0);
  if (o) free_info(o);
  simple1(OP_glCompileShader, s);
}
void tc_glLinkProgram(GLuint p) {
  CUR();
  struct tc_object *o = object(c->share, p, 0);
  if (o) free_info(o);
  simple1(OP_glLinkProgram, p);
}
void tc_glValidateProgram(GLuint p) {
  CUR();
  struct tc_object *o = object(c->share, p, 0);
  if (o) o->validate_status = 1;
  simple1(OP_glValidateProgram, p);
}
void tc_glUseProgram(GLuint p) { simple1(OP_glUseProgram, p); }

static void fetch_shader_info(struct tc_object *o, GLuint s) {
  if (o->info_valid) return;
  uint32_t *w = tc_begin(1, OP_glGetShaderInfo);
  if (!w) return;
  w[0] = s; tc_end();
  uint32_t len; uint8_t *p = call_reply(&len);
  if (!p) return;
  struct rd r = { p, p + len };
  o->status = (int)rd_u32(&r);
  o->log = rd_str(&r);
  o->info_valid = 1;
  free(p);
}
static void read_vars(struct rd *r, struct tc_uniform **out, uint32_t *n) {
  *n = rd_u32(r);
  *out = calloc(*n ? *n : 1, sizeof **out);
  for (uint32_t i = 0; i < *n; i++) {
    (*out)[i].type = rd_u32(r); (*out)[i].size = (int32_t)rd_u32(r); (*out)[i].loc = (int32_t)rd_u32(r);
    (*out)[i].name = rd_str(r);
  }
}
static void fetch_program_info(struct tc_object *o, GLuint prog) {
  if (o->info_valid) return;
  uint32_t *w = tc_begin(1, OP_glGetProgramInfo);
  if (!w) return;
  w[0] = prog; tc_end();
  uint32_t len; uint8_t *p = call_reply(&len);
  if (!p) return;
  struct rd r = { p, p + len };
  o->status = (int)rd_u32(&r);
  o->log = rd_str(&r);
  read_vars(&r, &o->attribs, &o->nattribs);
  read_vars(&r, &o->uniforms, &o->nuniforms);
  read_vars(&r, &o->blocks, &o->nblocks);
  o->info_valid = 1;
  free(p);
}
static size_t maxlen(struct tc_uniform *v, uint32_t n) {
  size_t m = 0;
  for (uint32_t i = 0; i < n; i++) { size_t l = strlen(v[i].name) + 1; if (l > m) m = l; }
  return m;
}
void tc_glGetShaderiv(GLuint shader, GLenum pname, GLint *params) {
  CUR();
  struct tc_object *o = object(c->share, shader, 0);
  if (!o || o->kind != 1) { local_error(GL_INVALID_VALUE); return; }
  switch (pname) {
  case GL_SHADER_TYPE: *params = (GLint)o->type; return;
  case GL_DELETE_STATUS: *params = 0; return;
  case GL_SHADER_SOURCE_LENGTH: *params = o->source ? (GLint)strlen(o->source) + 1 : 0; return;
  }
  fetch_shader_info(o, shader);
  switch (pname) {
  case GL_COMPILE_STATUS: *params = o->status; return;
  case GL_INFO_LOG_LENGTH: *params = o->log && *o->log ? (GLint)strlen(o->log) + 1 : 0; return;
  }
  local_error(GL_INVALID_ENUM);
}
static void copy_log(const char *log, GLsizei bufSize, GLsizei *length, GLchar *out) {
  if (!log) log = "";
  size_t n = strlen(log);
  if (bufSize <= 0) { if (length) *length = 0; return; }
  if (n > (size_t)bufSize - 1) n = (size_t)bufSize - 1;
  memcpy(out, log, n); out[n] = 0;
  if (length) *length = (GLsizei)n;
}
void tc_glGetShaderInfoLog(GLuint shader, GLsizei bufSize, GLsizei *length, GLchar *infoLog) {
  CUR();
  struct tc_object *o = object(c->share, shader, 0);
  if (!o || o->kind != 1) { local_error(GL_INVALID_VALUE); return; }
  fetch_shader_info(o, shader);
  copy_log(o->log, bufSize, length, infoLog);
}
void tc_glGetShaderSource(GLuint shader, GLsizei bufSize, GLsizei *length, GLchar *source) {
  CUR();
  struct tc_object *o = object(c->share, shader, 0);
  if (!o || o->kind != 1) { local_error(GL_INVALID_VALUE); return; }
  copy_log(o->source, bufSize, length, source);
}
void tc_glGetProgramiv(GLuint program, GLenum pname, GLint *params) {
  CUR();
  struct tc_object *o = object(c->share, program, 0);
  if (!o || o->kind != 2) { local_error(GL_INVALID_VALUE); return; }
  if (pname == GL_DELETE_STATUS) { *params = 0; return; }
  if (pname == GL_ATTACHED_SHADERS) { *params = o->nattached; return; }
  if (pname == GL_TRANSFORM_FEEDBACK_BUFFER_MODE) { *params = (GLint)(o->tf_mode ? o->tf_mode : GL_INTERLEAVED_ATTRIBS); return; }
  if (pname == GL_TRANSFORM_FEEDBACK_VARYINGS) { *params = (GLint)o->tf_count; return; }
  fetch_program_info(o, program);
  switch (pname) {
  case GL_LINK_STATUS: *params = o->status; return;
  case GL_VALIDATE_STATUS: *params = o->status && o->validate_status; return;
  case GL_INFO_LOG_LENGTH: *params = o->log && *o->log ? (GLint)strlen(o->log) + 1 : 0; return;
  case GL_ACTIVE_ATTRIBUTES: *params = (GLint)o->nattribs; return;
  case GL_ACTIVE_ATTRIBUTE_MAX_LENGTH: *params = (GLint)maxlen(o->attribs, o->nattribs); return;
  case GL_ACTIVE_UNIFORMS: *params = (GLint)o->nuniforms; return;
  case GL_ACTIVE_UNIFORM_MAX_LENGTH: *params = (GLint)maxlen(o->uniforms, o->nuniforms); return;
  case GL_ACTIVE_UNIFORM_BLOCKS: *params = (GLint)o->nblocks; return;
  case GL_ACTIVE_UNIFORM_BLOCK_MAX_NAME_LENGTH: *params = (GLint)maxlen(o->blocks, o->nblocks); return;
  }
  local_error(GL_INVALID_ENUM);
}
void tc_glGetProgramInfoLog(GLuint program, GLsizei bufSize, GLsizei *length, GLchar *infoLog) {
  CUR();
  struct tc_object *o = object(c->share, program, 0);
  if (!o || o->kind != 2) { local_error(GL_INVALID_VALUE); return; }
  fetch_program_info(o, program);
  copy_log(o->log, bufSize, length, infoLog);
}
static void active_var(struct tc_uniform *v, uint32_t n, GLuint index, GLsizei bufSize, GLsizei *length, GLint *size, GLenum *type, GLchar *name) {
  if (index >= n) { local_error(GL_INVALID_VALUE); return; }
  if (size) *size = v[index].size;
  if (type) *type = v[index].type;
  copy_log(v[index].name, bufSize, length, name);
}
void tc_glGetActiveAttrib(GLuint program, GLuint index, GLsizei bufSize, GLsizei *length, GLint *size, GLenum *type, GLchar *name) {
  CUR();
  struct tc_object *o = object(c->share, program, 0);
  if (!o || o->kind != 2) { local_error(GL_INVALID_VALUE); return; }
  fetch_program_info(o, program);
  active_var(o->attribs, o->nattribs, index, bufSize, length, size, type, name);
}
void tc_glGetActiveUniform(GLuint program, GLuint index, GLsizei bufSize, GLsizei *length, GLint *size, GLenum *type, GLchar *name) {
  CUR();
  struct tc_object *o = object(c->share, program, 0);
  if (!o || o->kind != 2) { local_error(GL_INVALID_VALUE); return; }
  fetch_program_info(o, program);
  active_var(o->uniforms, o->nuniforms, index, bufSize, length, size, type, name);
}
/* "a", "a[0]" and "a[3]" find the uniform the page listed as "a[0]" (size n). */
static GLint find_location(struct tc_uniform *v, uint32_t n, const char *name) {
  for (uint32_t i = 0; i < n; i++) if (!strcmp(v[i].name, name)) return v[i].loc;
  size_t len = strlen(name);
  long idx = 0;
  size_t base = len;
  if (len && name[len - 1] == ']') {
    const char *lb = strrchr(name, '[');
    if (!lb) return -1;
    idx = 0; for (const char *q = lb + 1; *q >= '0' && *q <= '9'; q++) idx = idx * 10 + (*q - '0');
    base = (size_t)(lb - name);
  }
  for (uint32_t i = 0; i < n; i++) {
    size_t l = strlen(v[i].name);
    if (l == base + 3 && !strncmp(v[i].name, name, base) && !strcmp(v[i].name + base, "[0]") && idx >= 0 && idx < v[i].size)
      return v[i].loc < 0 ? -1 : v[i].loc + (GLint)idx;
  }
  return -1;
}
GLint tc_glGetUniformLocation(GLuint program, const GLchar *name) {
  CUR0();
  struct tc_object *o = object(c->share, program, 0);
  if (!o || o->kind != 2) { local_error(GL_INVALID_VALUE); return -1; }
  fetch_program_info(o, program);
  if (!o->status) { local_error(GL_INVALID_OPERATION); return -1; }
  return find_location(o->uniforms, o->nuniforms, name);
}
GLint tc_glGetAttribLocation(GLuint program, const GLchar *name) {
  CUR0();
  struct tc_object *o = object(c->share, program, 0);
  if (!o || o->kind != 2) { local_error(GL_INVALID_VALUE); return -1; }
  fetch_program_info(o, program);
  for (uint32_t i = 0; i < o->nattribs; i++) if (!strcmp(o->attribs[i].name, name)) return o->attribs[i].loc;
  return -1;
}
GLuint tc_glGetUniformBlockIndex(GLuint program, const GLchar *name) {
  CUR0();
  struct tc_object *o = object(c->share, program, 0);
  if (!o || o->kind != 2) { local_error(GL_INVALID_VALUE); return GL_INVALID_INDEX; }
  fetch_program_info(o, program);
  for (uint32_t i = 0; i < o->nblocks; i++) if (!strcmp(o->blocks[i].name, name)) return i;
  return GL_INVALID_INDEX;
}
void tc_glGetAttachedShaders(GLuint program, GLsizei maxCount, GLsizei *count, GLuint *shaders) {
  CUR();
  struct tc_object *o = object(c->share, program, 0);
  if (!o || o->kind != 2) { local_error(GL_INVALID_VALUE); return; }
  GLsizei n = 0;
  for (int i = 0; i < o->nattached && n < maxCount; i++) shaders[n++] = o->attached[i];
  if (count) *count = n;
}
void tc_glBindAttribLocation(GLuint program, GLuint index, const GLchar *name) {
  size_t n = strlen(name) + 1;
  uint32_t *w = tc_begin(2 + 1 + (n + 3) / 4, OP_glBindAttribLocation);
  if (!w) return;
  w[0] = program; w[1] = index; tc_put_array(w + 2, name, n);
  tc_end();
}
void tc_glBindFragDataLocation(GLuint program, GLuint color, const GLchar *name) {
  size_t n = strlen(name) + 1;
  uint32_t *w = tc_begin(2 + 1 + (n + 3) / 4, OP_glBindFragDataLocation);
  if (!w) return;
  w[0] = program; w[1] = color; tc_put_array(w + 2, name, n);
  tc_end();
}
void tc_glTransformFeedbackVaryings(GLuint program, GLsizei count, const GLchar *const *varyings, GLenum bufferMode) {
  CUR();
  size_t total = 0;
  for (GLsizei i = 0; i < count; i++) total += strlen(varyings[i]) + 1;
  char *names = malloc(total ? total : 1), *q = names;
  for (GLsizei i = 0; i < count; i++) { size_t n = strlen(varyings[i]) + 1; memcpy(q, varyings[i], n); q += n; }
  struct tc_object *o = object(c->share, program, 0);
  if (o) { free(o->tf_names); o->tf_names = names; o->tf_count = (uint32_t)count; o->tf_mode = bufferMode; }
  uint32_t *w = tc_begin(2 + 1 + (total + 3) / 4 + 1, OP_glTransformFeedbackVaryings);
  if (w) { w[0] = program; w[1] = (uint32_t)count; w = tc_put_array(w + 2, names, total); *w = bufferMode; tc_end(); }
  if (!o) free(names);
}

/* begin/end: nothing to do here but remember (GL errors for glGet inside) */
void tc_glBegin(GLenum mode) { CUR(); c->in_begin = 1; simple1(OP_glBegin, mode); }
void tc_glEnd(void) { CUR(); c->in_begin = 0; if (tc_begin(0, OP_glEnd)) tc_end(); }
void tc_glNewList(GLuint list, GLenum mode) { CUR(); c->list_mode = mode; simple2(OP_glNewList, list, mode); }
void tc_glEndList(void) { CUR(); c->list_mode = 0; if (tc_begin(0, OP_glEndList)) tc_end(); }
void tc_glCallLists(GLsizei n, GLenum type, const void *lists) {
  size_t sz = type == GL_BYTE || type == GL_UNSIGNED_BYTE ? 1 : type == GL_SHORT || type == GL_UNSIGNED_SHORT || type == GL_2_BYTES ? 2 :
    type == GL_3_BYTES ? 3 : 4;
  size_t bytes = n > 0 ? (size_t)n * sz : 0;
  uint32_t *w = tc_begin(2 + 1 + (bytes + 3) / 4, OP_glCallLists);
  if (!w) return;
  w[0] = (uint32_t)n; w[1] = type; tc_put_array(w + 2, lists, bytes);
  tc_end();
}

/* array-argument setters whose length depends on pname */
#define PV(fn, A, ET, sz) void tc_##fn(A a, GLenum pname, const ET *params) { \
  size_t n = (size_t)tc_pname_count(#fn, pname) * sz; uint32_t *w = tc_begin(2 + 1 + (n + 3) / 4, OP_##fn); \
  if (!w) return; w[0] = (uint32_t)a; w[1] = pname; tc_put_array(w + 2, params, n); tc_end(); }
PV(glLightfv, GLenum, GLfloat, 4) PV(glLightiv, GLenum, GLint, 4) PV(glMaterialfv, GLenum, GLfloat, 4) PV(glMaterialiv, GLenum, GLint, 4)
PV(glTexEnvfv, GLenum, GLfloat, 4) PV(glTexEnviv, GLenum, GLint, 4) PV(glTexGenfv, GLenum, GLfloat, 4) PV(glTexGeniv, GLenum, GLint, 4)
PV(glTexGendv, GLenum, GLdouble, 8)
PV(glTexParameterfv, GLenum, GLfloat, 4) PV(glTexParameteriv, GLenum, GLint, 4) PV(glTexParameterIiv, GLenum, GLint, 4) PV(glTexParameterIuiv, GLenum, GLuint, 4)
PV(glSamplerParameterfv, GLuint, GLfloat, 4) PV(glSamplerParameteriv, GLuint, GLint, 4) PV(glSamplerParameterIiv, GLuint, GLint, 4) PV(glSamplerParameterIuiv, GLuint, GLuint, 4)
#define PV1(fn, ET, sz) void tc_##fn(GLenum pname, const ET *params) { \
  size_t n = (size_t)tc_pname_count(#fn, pname) * sz; uint32_t *w = tc_begin(1 + 1 + (n + 3) / 4, OP_##fn); \
  if (!w) return; w[0] = pname; tc_put_array(w + 1, params, n); tc_end(); }
PV1(glLightModelfv, GLfloat, 4) PV1(glLightModeliv, GLint, 4) PV1(glFogfv, GLfloat, 4) PV1(glFogiv, GLint, 4)
PV1(glPointParameterfv, GLfloat, 4) PV1(glPointParameteriv, GLint, 4)
#define CB(fn, ET) void tc_##fn(GLenum buffer, GLint drawbuffer, const ET *value) { \
  size_t n = (buffer == GL_COLOR ? 4 : 1) * 4; uint32_t *w = tc_begin(2 + 1 + n / 4, OP_##fn); \
  if (!w) return; w[0] = buffer; w[1] = (uint32_t)drawbuffer; tc_put_array(w + 2, value, n); tc_end(); }
CB(glClearBufferfv, GLfloat) CB(glClearBufferiv, GLint) CB(glClearBufferuiv, GLuint)

/* pixel store: the guest needs the unpack state to size uploads, the page needs both */
struct pixel_store { GLint row_length, image_height, skip_pixels, skip_rows, skip_images, alignment; };
static __thread struct pixel_store unpack = { 0, 0, 0, 0, 0, 4 }, pack = { 0, 0, 0, 0, 0, 4 };
static __thread GLuint unpack_buffer, pack_buffer, array_buffer, element_buffer;
void tc_glPixelStorei(GLenum pname, GLint v) {
  switch (pname) {
  case GL_UNPACK_ROW_LENGTH: unpack.row_length = v; break;
  case GL_UNPACK_IMAGE_HEIGHT: unpack.image_height = v; break;
  case GL_UNPACK_SKIP_PIXELS: unpack.skip_pixels = v; break;
  case GL_UNPACK_SKIP_ROWS: unpack.skip_rows = v; break;
  case GL_UNPACK_SKIP_IMAGES: unpack.skip_images = v; break;
  case GL_UNPACK_ALIGNMENT: unpack.alignment = v; break;
  case GL_PACK_ROW_LENGTH: pack.row_length = v; break;
  case GL_PACK_IMAGE_HEIGHT: pack.image_height = v; break;
  case GL_PACK_SKIP_PIXELS: pack.skip_pixels = v; break;
  case GL_PACK_SKIP_ROWS: pack.skip_rows = v; break;
  case GL_PACK_SKIP_IMAGES: pack.skip_images = v; break;
  case GL_PACK_ALIGNMENT: pack.alignment = v; break;
  }
  simple2(OP_glPixelStorei, pname, (uint32_t)v);
}
void tc_glPixelStoref(GLenum pname, GLfloat v) { tc_glPixelStorei(pname, (GLint)v); }

static int components(GLenum format) {
  switch (format) {
  case GL_RED: case GL_GREEN: case GL_BLUE: case GL_ALPHA: case GL_LUMINANCE: case GL_DEPTH_COMPONENT: case GL_STENCIL_INDEX:
  case GL_RED_INTEGER: case GL_GREEN_INTEGER: case GL_BLUE_INTEGER: case GL_ALPHA_INTEGER: case GL_COLOR_INDEX: case GL_INTENSITY: return 1;
  case GL_RG: case GL_LUMINANCE_ALPHA: case GL_RG_INTEGER: case GL_DEPTH_STENCIL: return 2;
  case GL_RGB: case GL_BGR: case GL_RGB_INTEGER: case GL_BGR_INTEGER: return 3;
  default: return 4;
  }
}
static int type_size(GLenum type, int *packed) {
  *packed = 0;
  switch (type) {
  case GL_UNSIGNED_BYTE: case GL_BYTE: return 1;
  case GL_UNSIGNED_SHORT: case GL_SHORT: case GL_HALF_FLOAT: return 2;
  case GL_UNSIGNED_INT: case GL_INT: case GL_FLOAT: return 4;
  case GL_UNSIGNED_BYTE_3_3_2: case GL_UNSIGNED_BYTE_2_3_3_REV: *packed = 1; return 1;
  case GL_UNSIGNED_SHORT_5_6_5: case GL_UNSIGNED_SHORT_5_6_5_REV: case GL_UNSIGNED_SHORT_4_4_4_4: case GL_UNSIGNED_SHORT_4_4_4_4_REV:
  case GL_UNSIGNED_SHORT_5_5_5_1: case GL_UNSIGNED_SHORT_1_5_5_5_REV: *packed = 1; return 2;
  case GL_FLOAT_32_UNSIGNED_INT_24_8_REV: *packed = 1; return 8;
  default: *packed = 1; return 4; /* 8_8_8_8, 10_10_10_2, 24_8, 10F_11F_11F, 5_9_9_9 */
  }
}
/* Bytes GL reads from client memory for an image (the unpack/pack rules), from its start. */
static size_t image_bytes(const struct pixel_store *ps, GLsizei w, GLsizei h, GLsizei d, GLenum format, GLenum type) {
  if (w <= 0 || h <= 0 || d <= 0) return 0;
  int packed, ts = type_size(type, &packed);
  size_t group = packed ? (size_t)ts : (size_t)ts * (size_t)components(format);
  if (type == GL_BITMAP) {
    size_t row = ((size_t)(ps->row_length > 0 ? ps->row_length : w) + 7) / 8;
    size_t a = (size_t)ps->alignment; row = (row + a - 1) / a * a;
    return row * (size_t)(h + ps->skip_rows);
  }
  size_t rowlen = (size_t)(ps->row_length > 0 ? ps->row_length : w);
  size_t row = rowlen * group;
  size_t a = (size_t)ps->alignment;
  if (ts < (int)a) row = (row + a - 1) / a * a;
  size_t imgh = (size_t)(ps->image_height > 0 ? ps->image_height : h);
  size_t last = ((size_t)ps->skip_images + (size_t)d - 1) * imgh * row + ((size_t)ps->skip_rows + (size_t)h - 1) * row +
    ((size_t)ps->skip_pixels + (size_t)w) * group;
  return last;
}
/* An image argument: inline bytes, or (with an unpack buffer bound) the offset as a NULL-array marker + offset. */
static uint32_t *put_image(uint32_t *w, const void *pixels, size_t bytes) {
  if (unpack_buffer) { *w++ = 0xfffffffeu; int64_t off = (int64_t)(intptr_t)pixels; memcpy(w, &off, 8); return w + 2; }
  return tc_put_array(w, pixels, bytes);
}
static size_t image_words(const void *pixels, size_t bytes) { return unpack_buffer ? 3 : 1 + (pixels ? (bytes + 3) / 4 : 0); }

void tc_glTexImage1D(GLenum target, GLint level, GLint ifmt, GLsizei width, GLint border, GLenum format, GLenum type, const void *pixels) {
  size_t n = pixels ? image_bytes(&unpack, width, 1, 1, format, type) : 0;
  uint32_t *w = tc_begin(7 + image_words(pixels, n), OP_glTexImage1D);
  if (!w) return;
  w[0] = target; w[1] = (uint32_t)level; w[2] = (uint32_t)ifmt; w[3] = (uint32_t)width; w[4] = (uint32_t)border; w[5] = format; w[6] = type;
  put_image(w + 7, pixels, n); tc_end();
}
void tc_glTexImage2D(GLenum target, GLint level, GLint ifmt, GLsizei width, GLsizei height, GLint border, GLenum format, GLenum type, const void *pixels) {
  size_t n = pixels ? image_bytes(&unpack, width, height, 1, format, type) : 0;
  uint32_t *w = tc_begin(8 + image_words(pixels, n), OP_glTexImage2D);
  if (!w) return;
  w[0] = target; w[1] = (uint32_t)level; w[2] = (uint32_t)ifmt; w[3] = (uint32_t)width; w[4] = (uint32_t)height; w[5] = (uint32_t)border;
  w[6] = format; w[7] = type;
  put_image(w + 8, pixels, n); tc_end();
}
void tc_glTexImage3D(GLenum target, GLint level, GLint ifmt, GLsizei width, GLsizei height, GLsizei depth, GLint border, GLenum format, GLenum type, const void *pixels) {
  size_t n = pixels ? image_bytes(&unpack, width, height, depth, format, type) : 0;
  uint32_t *w = tc_begin(9 + image_words(pixels, n), OP_glTexImage3D);
  if (!w) return;
  w[0] = target; w[1] = (uint32_t)level; w[2] = (uint32_t)ifmt; w[3] = (uint32_t)width; w[4] = (uint32_t)height; w[5] = (uint32_t)depth;
  w[6] = (uint32_t)border; w[7] = format; w[8] = type;
  put_image(w + 9, pixels, n); tc_end();
}
void tc_glTexSubImage1D(GLenum target, GLint level, GLint x, GLsizei width, GLenum format, GLenum type, const void *pixels) {
  size_t n = image_bytes(&unpack, width, 1, 1, format, type);
  uint32_t *w = tc_begin(6 + image_words(pixels, n), OP_glTexSubImage1D);
  if (!w) return;
  w[0] = target; w[1] = (uint32_t)level; w[2] = (uint32_t)x; w[3] = (uint32_t)width; w[4] = format; w[5] = type;
  put_image(w + 6, pixels, n); tc_end();
}
void tc_glTexSubImage2D(GLenum target, GLint level, GLint x, GLint y, GLsizei width, GLsizei height, GLenum format, GLenum type, const void *pixels) {
  size_t n = image_bytes(&unpack, width, height, 1, format, type);
  uint32_t *w = tc_begin(8 + image_words(pixels, n), OP_glTexSubImage2D);
  if (!w) return;
  w[0] = target; w[1] = (uint32_t)level; w[2] = (uint32_t)x; w[3] = (uint32_t)y; w[4] = (uint32_t)width; w[5] = (uint32_t)height; w[6] = format; w[7] = type;
  put_image(w + 8, pixels, n); tc_end();
}
void tc_glTexSubImage3D(GLenum target, GLint level, GLint x, GLint y, GLint z, GLsizei width, GLsizei height, GLsizei depth, GLenum format, GLenum type, const void *pixels) {
  size_t n = image_bytes(&unpack, width, height, depth, format, type);
  uint32_t *w = tc_begin(10 + image_words(pixels, n), OP_glTexSubImage3D);
  if (!w) return;
  w[0] = target; w[1] = (uint32_t)level; w[2] = (uint32_t)x; w[3] = (uint32_t)y; w[4] = (uint32_t)z; w[5] = (uint32_t)width; w[6] = (uint32_t)height;
  w[7] = (uint32_t)depth; w[8] = format; w[9] = type;
  put_image(w + 10, pixels, n); tc_end();
}
void tc_glCompressedTexImage2D(GLenum target, GLint level, GLenum ifmt, GLsizei width, GLsizei height, GLint border, GLsizei imageSize, const void *data) {
  uint32_t *w = tc_begin(7 + image_words(data, (size_t)imageSize), OP_glCompressedTexImage2D);
  if (!w) return;
  w[0] = target; w[1] = (uint32_t)level; w[2] = ifmt; w[3] = (uint32_t)width; w[4] = (uint32_t)height; w[5] = (uint32_t)border; w[6] = (uint32_t)imageSize;
  put_image(w + 7, data, (size_t)imageSize); tc_end();
}
void tc_glCompressedTexSubImage2D(GLenum target, GLint level, GLint x, GLint y, GLsizei width, GLsizei height, GLenum format, GLsizei imageSize, const void *data) {
  uint32_t *w = tc_begin(8 + image_words(data, (size_t)imageSize), OP_glCompressedTexSubImage2D);
  if (!w) return;
  w[0] = target; w[1] = (uint32_t)level; w[2] = (uint32_t)x; w[3] = (uint32_t)y; w[4] = (uint32_t)width; w[5] = (uint32_t)height; w[6] = format; w[7] = (uint32_t)imageSize;
  put_image(w + 8, data, (size_t)imageSize); tc_end();
}
void tc_glDrawPixels(GLsizei width, GLsizei height, GLenum format, GLenum type, const void *pixels) {
  size_t n = image_bytes(&unpack, width, height, 1, format, type);
  uint32_t *w = tc_begin(4 + image_words(pixels, n), OP_glDrawPixels);
  if (!w) return;
  w[0] = (uint32_t)width; w[1] = (uint32_t)height; w[2] = format; w[3] = type;
  put_image(w + 4, pixels, n); tc_end();
}
void tc_glBitmap(GLsizei width, GLsizei height, GLfloat xorig, GLfloat yorig, GLfloat xmove, GLfloat ymove, const GLubyte *bitmap) {
  size_t n = bitmap ? image_bytes(&unpack, width, height, 1, GL_COLOR_INDEX, GL_BITMAP) : 0;
  uint32_t *w = tc_begin(6 + image_words(bitmap, n), OP_glBitmap);
  if (!w) return;
  w[0] = (uint32_t)width; w[1] = (uint32_t)height; memcpy(w + 2, &xorig, 4); memcpy(w + 3, &yorig, 4); memcpy(w + 4, &xmove, 4); memcpy(w + 5, &ymove, 4);
  put_image(w + 6, bitmap, n); tc_end();
}
void tc_glPolygonStipple(const GLubyte *mask) {
  uint32_t *w = tc_begin(1 + 32, OP_glPolygonStipple);
  if (!w) return;
  tc_put_array(w, mask, 128); tc_end();
}

/* buffers */
void tc_glBindBuffer(GLenum target, GLuint buffer) {
  switch (target) {
  case GL_PIXEL_UNPACK_BUFFER: unpack_buffer = buffer; break;
  case GL_PIXEL_PACK_BUFFER: pack_buffer = buffer; break;
  case GL_ARRAY_BUFFER: array_buffer = buffer; break;
  case GL_ELEMENT_ARRAY_BUFFER: element_buffer = buffer; break;
  }
  simple2(OP_glBindBuffer, target, buffer);
}
void tc_glBufferData(GLenum target, GLsizeiptr size, const void *data, GLenum usage) {
  size_t n = data && size > 0 ? (size_t)size : 0;
  uint32_t *w = tc_begin(1 + 2 + 1 + (n + 3) / 4 + 1, OP_glBufferData);
  if (!w) return;
  w[0] = target; int64_t s = size; memcpy(w + 1, &s, 8);
  w = tc_put_array(w + 3, data, n);
  *w = usage;
  tc_end();
}
void tc_glBufferSubData(GLenum target, GLintptr offset, GLsizeiptr size, const void *data) {
  size_t n = data && size > 0 ? (size_t)size : 0;
  uint32_t *w = tc_begin(1 + 2 + 2 + 1 + (n + 3) / 4, OP_glBufferSubData);
  if (!w) return;
  w[0] = target; int64_t o = offset, s = size; memcpy(w + 1, &o, 8); memcpy(w + 3, &s, 8);
  tc_put_array(w + 5, data, n);
  tc_end();
}

/* Mapping: the guest keeps the bytes; unmap sends what was written. */
struct mapping { GLenum target; GLuint buffer; void *ptr; int64_t offset, length; GLbitfield access; struct mapping *next; };
static struct mapping *mappings;
static pthread_mutex_t map_lock = PTHREAD_MUTEX_INITIALIZER;
static GLuint bound_buffer(GLenum target) {
  GLint b = 0;
  switch (target) {
  case GL_ARRAY_BUFFER: return array_buffer;
  case GL_ELEMENT_ARRAY_BUFFER: return element_buffer;
  case GL_PIXEL_PACK_BUFFER: return pack_buffer;
  case GL_PIXEL_UNPACK_BUFFER: return unpack_buffer;
  case GL_UNIFORM_BUFFER: tc_glGetIntegerv(GL_UNIFORM_BUFFER_BINDING, &b); return (GLuint)b;
  case GL_COPY_READ_BUFFER: tc_glGetIntegerv(GL_COPY_READ_BUFFER_BINDING, &b); return (GLuint)b;
  case GL_COPY_WRITE_BUFFER: tc_glGetIntegerv(GL_COPY_WRITE_BUFFER_BINDING, &b); return (GLuint)b;
  case GL_TRANSFORM_FEEDBACK_BUFFER: tc_glGetIntegerv(GL_TRANSFORM_FEEDBACK_BUFFER_BINDING, &b); return (GLuint)b;
  case GL_TEXTURE_BUFFER: tc_glGetIntegerv(GL_TEXTURE_BINDING_BUFFER, &b); return (GLuint)b;
  }
  return 0;
}
void *tc_glMapBufferRange(GLenum target, GLintptr offset, GLsizeiptr length, GLbitfield access) {
  CUR0();
  if (length <= 0) { local_error(GL_INVALID_VALUE); return NULL; }
  struct mapping *m = calloc(1, sizeof *m);
  m->target = target; m->buffer = bound_buffer(target); m->offset = offset; m->length = length; m->access = access;
  m->ptr = malloc((size_t)length);
  if (!m->ptr) { free(m); local_error(GL_OUT_OF_MEMORY); return NULL; }
  if ((access & GL_MAP_READ_BIT) || !(access & (GL_MAP_INVALIDATE_RANGE_BIT | GL_MAP_INVALIDATE_BUFFER_BIT))) {
    /* the current contents are needed: a round trip */
    uint32_t *w = tc_begin(5, OP_glGetBufferSubData);
    if (w) {
      w[0] = target; int64_t o = offset, l = length; memcpy(w + 1, &o, 8); memcpy(w + 3, &l, 8); tc_end();
      uint32_t len; uint8_t *p = call_reply(&len);
      if (p) { memcpy(m->ptr, p, len < (uint32_t)length ? len : (size_t)length); free(p); }
    }
  }
  pthread_mutex_lock(&map_lock);
  m->next = mappings; mappings = m;
  pthread_mutex_unlock(&map_lock);
  return m->ptr;
}
void *tc_glMapBuffer(GLenum target, GLenum access) {
  GLint64 size = 0;
  tc_glGetBufferParameteri64v(target, GL_BUFFER_SIZE, &size);
  GLbitfield a = access == GL_READ_ONLY ? GL_MAP_READ_BIT : access == GL_WRITE_ONLY ? GL_MAP_WRITE_BIT : GL_MAP_READ_BIT | GL_MAP_WRITE_BIT;
  return tc_glMapBufferRange(target, 0, (GLsizeiptr)size, a);
}
static struct mapping *take_mapping(GLenum target, int remove) {
  GLuint b = bound_buffer(target);
  pthread_mutex_lock(&map_lock);
  struct mapping **pp = &mappings, *m = NULL;
  for (; *pp; pp = &(*pp)->next) if ((*pp)->buffer == b && (*pp)->target == target) { m = *pp; if (remove) *pp = m->next; break; }
  pthread_mutex_unlock(&map_lock);
  return m;
}
void tc_glFlushMappedBufferRange(GLenum target, GLintptr offset, GLsizeiptr length) {
  struct mapping *m = take_mapping(target, 0);
  if (!m || offset < 0 || offset + length > m->length) { local_error(GL_INVALID_VALUE); return; }
  tc_glBufferSubData(target, m->offset + offset, length, (uint8_t *)m->ptr + offset);
}
GLboolean tc_glUnmapBuffer(GLenum target) {
  struct mapping *m = take_mapping(target, 1);
  if (!m) { local_error(GL_INVALID_OPERATION); return GL_FALSE; }
  if ((m->access & GL_MAP_WRITE_BIT) && !(m->access & GL_MAP_FLUSH_EXPLICIT_BIT))
    tc_glBufferSubData(target, m->offset, m->length, m->ptr);
  free(m->ptr); free(m);
  return GL_TRUE;
}
void tc_glGetBufferSubData(GLenum target, GLintptr offset, GLsizeiptr size, void *data) {
  uint32_t *w = tc_begin(5, OP_glGetBufferSubData);
  if (!w) return;
  w[0] = target; int64_t o = offset, l = size; memcpy(w + 1, &o, 8); memcpy(w + 3, &l, 8); tc_end();
  uint32_t len; uint8_t *p = call_reply(&len);
  if (p) { memcpy(data, p, len < (uint32_t)size ? len : (size_t)size); free(p); }
}
void tc_glReadPixels(GLint x, GLint y, GLsizei width, GLsizei height, GLenum format, GLenum type, void *pixels) {
  uint32_t *w = tc_begin(8, OP_glReadPixels);
  if (!w) return;
  w[0] = (uint32_t)x; w[1] = (uint32_t)y; w[2] = (uint32_t)width; w[3] = (uint32_t)height; w[4] = format; w[5] = type;
  int64_t off = (int64_t)(intptr_t)pixels; memcpy(w + 6, &off, 8);
  tc_end();
  if (pack_buffer) { flush(); return; } /* lands in the buffer on the page */
  size_t n = image_bytes(&pack, width, height, 1, format, type);
  uint32_t len; uint8_t *p = call_reply(&len);
  if (p) { memcpy(pixels, p, len < n ? len : n); free(p); }
}
void tc_glGetTexImage(GLenum target, GLint level, GLenum format, GLenum type, void *pixels) {
  uint32_t *w = tc_begin(6, OP_glGetTexImage);
  if (!w) return;
  w[0] = target; w[1] = (uint32_t)level; w[2] = format; w[3] = type;
  int64_t off = (int64_t)(intptr_t)pixels; memcpy(w + 4, &off, 8);
  tc_end();
  if (pack_buffer) { flush(); return; }
  uint32_t len; uint8_t *p = call_reply(&len);
  if (p) { memcpy(pixels, p, len); free(p); }
}

/* sync objects: commands run in order on the page, so a fence is done once sent */
GLsync tc_glFenceSync(GLenum condition, GLbitfield flags) {
  CUR0();
  uintptr_t id = ++c->share->next[NS_SYNC];
  uint32_t *w = tc_begin(4, OP_glFenceSync);
  if (w) { int64_t v = (int64_t)id; memcpy(w, &v, 8); w[2] = condition; w[3] = flags; tc_end(); }
  return (GLsync)id;
}
GLenum tc_glClientWaitSync(GLsync sync, GLbitfield flags, GLuint64 timeout) {
  (void)sync; (void)flags; (void)timeout;
  flush();
  return GL_ALREADY_SIGNALED;
}
void tc_glWaitSync(GLsync sync, GLbitfield flags, GLuint64 timeout) { (void)sync; (void)flags; (void)timeout; }
void tc_glDeleteSync(GLsync sync) { uint32_t *w = tc_begin(2, OP_glDeleteSync); if (w) { int64_t v = (int64_t)(uintptr_t)sync; memcpy(w, &v, 8); tc_end(); } }
GLboolean tc_glIsSync(GLsync sync) { return sync != NULL; }
void tc_glGetSynciv(GLsync sync, GLenum pname, GLsizei count, GLsizei *length, GLint *values) {
  (void)sync;
  if (count < 1) return;
  GLint v = pname == GL_OBJECT_TYPE ? GL_SYNC_FENCE : pname == GL_SYNC_STATUS ? GL_SIGNALED : pname == GL_SYNC_CONDITION ? GL_SYNC_GPU_COMMANDS_COMPLETE : 0;
  values[0] = v;
  if (length) *length = 1;
}

/* debug output: accepted, nothing is reported */
void tc_glDebugMessageCallback(GLDEBUGPROC callback, const void *userParam) { (void)callback; (void)userParam; }
void tc_glDebugMessageControl(GLenum source, GLenum type, GLenum severity, GLsizei count, const GLuint *ids, GLboolean enabled) {
  (void)source; (void)type; (void)severity; (void)count; (void)ids; (void)enabled;
}
void tc_glDebugMessageInsert(GLenum source, GLenum type, GLuint id, GLenum severity, GLsizei length, const GLchar *buf) {
  (void)source; (void)type; (void)id; (void)severity; (void)length; (void)buf;
}
void tc_glPushDebugGroup(GLenum source, GLuint id, GLsizei length, const GLchar *message) { (void)source; (void)id; (void)length; (void)message; }
void tc_glPopDebugGroup(void) {}
void tc_glObjectLabel(GLenum identifier, GLuint name, GLsizei length, const GLchar *label) { (void)identifier; (void)name; (void)length; (void)label; }
void tc_glObjectPtrLabel(const void *ptr, GLsizei length, const GLchar *label) { (void)ptr; (void)length; (void)label; }
GLuint tc_glGetDebugMessageLog(GLuint count, GLsizei bufSize, GLenum *sources, GLenum *types, GLuint *ids, GLenum *severities, GLsizei *lengths, GLchar *messageLog) {
  (void)count; (void)bufSize; (void)sources; (void)types; (void)ids; (void)severities; (void)lengths; (void)messageLog;
  return 0;
}
void tc_glGetPointerv(GLenum pname, void **params) { (void)pname; *params = NULL; }

/*
 * Vertex arrays. Buffer offsets go to the page as they are. Client memory
 * (no GL_ARRAY_BUFFER bound, VAO 0) is copied at each draw: the vertices the
 * draw reads, from every enabled client array, go up with
 * glClientUploadArray(which, unit, byte offset, bytes) just before it, and the
 * page points that attribute at its copy. Client indices go up the same way.
 * Arrays: 0-15 generic attributes, then vertex, normal, color, secondary
 * color, fog coordinate and texture coordinates 0-7.
 */
enum { CA_VERTEX = 16, CA_NORMAL, CA_COLOR, CA_SECONDARY, CA_FOG, CA_TEXCOORD, CA_N = CA_TEXCOORD + 8 };
static int client_array_of(struct tc_ctx *c, GLenum a) {
  switch (a) {
  case GL_VERTEX_ARRAY: return CA_VERTEX;
  case GL_NORMAL_ARRAY: return CA_NORMAL;
  case GL_COLOR_ARRAY: return CA_COLOR;
  case GL_SECONDARY_COLOR_ARRAY: return CA_SECONDARY;
  case GL_FOG_COORD_ARRAY: return CA_FOG;
  case GL_TEXTURE_COORD_ARRAY: return CA_TEXCOORD + (int)(c->client_unit & 7);
  }
  return -1;
}
static void set_array(int i, GLint size, GLenum type, GLsizei stride, const void *pointer) {
  struct tc_ctx *c = T.ctx;
  if (!c || i < 0 || i >= CA_N) return;
  struct tc_carray *a = &c->arrays[i];
  a->size = size; a->type = type; a->stride = stride; a->ptr = pointer;
  a->client = !array_buffer && pointer;
}
static size_t attrib_type_size(GLenum t) {
  switch (t) {
  case GL_BYTE: case GL_UNSIGNED_BYTE: return 1;
  case GL_SHORT: case GL_UNSIGNED_SHORT: case GL_HALF_FLOAT: return 2;
  case GL_DOUBLE: return 8;
  default: return 4;
  }
}
static size_t element_size(const struct tc_carray *a) {
  if (a->type == GL_INT_2_10_10_10_REV || a->type == GL_UNSIGNED_INT_2_10_10_10_REV || a->type == GL_UNSIGNED_INT_10F_11F_11F_REV) return 4;
  return (size_t)(a->size == GL_BGRA ? 4 : a->size) * attrib_type_size(a->type);
}
static int client_arrays_on(struct tc_ctx *c) {
  if (c->vao) return 0;
  for (int i = 0; i < CA_N; i++) if (c->arrays[i].enabled && c->arrays[i].client) return 1;
  return 0;
}
static void upload(uint32_t which, uint32_t unit, int64_t offset, const void *p, size_t n) {
  uint32_t *w = tc_begin(5 + ((n + 3) >> 2), OP_glClientUploadArray);
  if (!w) return;
  w[0] = which; w[1] = unit; memcpy(w + 2, &offset, 8); tc_put_array(w + 4, p, n); tc_end();
}
/* Copies vertices first .. first + count - 1 of every enabled client array to the page. */
static void upload_arrays(struct tc_ctx *c, int64_t first, int64_t count) {
  static const GLenum ff[] = { GL_VERTEX_ARRAY, GL_NORMAL_ARRAY, GL_COLOR_ARRAY, GL_SECONDARY_COLOR_ARRAY, GL_FOG_COORD_ARRAY };
  if (first < 0 || count <= 0) return;
  for (int i = 0; i < CA_N; i++) {
    struct tc_carray *a = &c->arrays[i];
    if (!a->enabled || !a->client) continue;
    size_t elem = element_size(a), stride = a->stride ? (size_t)a->stride : elem;
    int64_t off = first * (int64_t)stride;
    size_t n = (size_t)(count - 1) * stride + elem;
    uint32_t which = i < 16 ? (uint32_t)i : i < CA_TEXCOORD ? ff[i - CA_VERTEX] : GL_TEXTURE_COORD_ARRAY;
    upload(which, i >= CA_TEXCOORD ? (uint32_t)(i - CA_TEXCOORD) : 0, off, a->ptr + off, n);
  }
}
void tc_glVertexAttribPointer(GLuint index, GLint size, GLenum type, GLboolean normalized, GLsizei stride, const void *pointer) {
  set_array(index < 16 ? (int)index : -1, size, type, stride, pointer);
  uint32_t *w = tc_begin(7, OP_glVertexAttribPointer);
  if (!w) return;
  w[0] = index; w[1] = (uint32_t)size; w[2] = type; w[3] = normalized; w[4] = (uint32_t)stride;
  int64_t off = (int64_t)(intptr_t)pointer; memcpy(w + 5, &off, 8); tc_end();
}
void tc_glVertexAttribIPointer(GLuint index, GLint size, GLenum type, GLsizei stride, const void *pointer) {
  set_array(index < 16 ? (int)index : -1, size, type, stride, pointer);
  uint32_t *w = tc_begin(6, OP_glVertexAttribIPointer);
  if (!w) return;
  w[0] = index; w[1] = (uint32_t)size; w[2] = type; w[3] = (uint32_t)stride;
  int64_t off = (int64_t)(intptr_t)pointer; memcpy(w + 4, &off, 8); tc_end();
}
#define PTR4(fn, slot) void tc_##fn(GLint size, GLenum type, GLsizei stride, const void *pointer) { \
  if (T.ctx) set_array(slot, size, type, stride, pointer); uint32_t *w = tc_begin(5, OP_##fn); if (!w) return; \
  w[0] = (uint32_t)size; w[1] = type; w[2] = (uint32_t)stride; int64_t off = (int64_t)(intptr_t)pointer; memcpy(w + 3, &off, 8); tc_end(); }
PTR4(glVertexPointer, CA_VERTEX) PTR4(glColorPointer, CA_COLOR) PTR4(glSecondaryColorPointer, CA_SECONDARY)
PTR4(glTexCoordPointer, CA_TEXCOORD + (int)(T.ctx->client_unit & 7))
#define PTR3(fn, slot, n) void tc_##fn(GLenum type, GLsizei stride, const void *pointer) { \
  if (T.ctx) set_array(slot, n, type, stride, pointer); uint32_t *w = tc_begin(4, OP_##fn); if (!w) return; \
  w[0] = type; w[1] = (uint32_t)stride; int64_t off = (int64_t)(intptr_t)pointer; memcpy(w + 2, &off, 8); tc_end(); }
PTR3(glNormalPointer, CA_NORMAL, 3) PTR3(glFogCoordPointer, CA_FOG, 1) PTR3(glIndexPointer, -1, 1)
static void enable_array(int i, int on) { struct tc_ctx *c = T.ctx; if (c && i >= 0 && i < CA_N) c->arrays[i].enabled = (uint8_t)on; }
void tc_glEnableClientState(GLenum a) { if (T.ctx) enable_array(client_array_of(T.ctx, a), 1); simple1(OP_glEnableClientState, a); }
void tc_glDisableClientState(GLenum a) { if (T.ctx) enable_array(client_array_of(T.ctx, a), 0); simple1(OP_glDisableClientState, a); }
void tc_glClientActiveTexture(GLenum a) { if (T.ctx) T.ctx->client_unit = a - GL_TEXTURE0; simple1(OP_glClientActiveTexture, a); }
void tc_glEnableVertexAttribArray(GLuint a) { enable_array(a < 16 ? (int)a : -1, 1); simple1(OP_glEnableVertexAttribArray, a); }
void tc_glDisableVertexAttribArray(GLuint a) { enable_array(a < 16 ? (int)a : -1, 0); simple1(OP_glDisableVertexAttribArray, a); }
void tc_glBindVertexArray(GLuint a) { if (T.ctx) T.ctx->vao = a; simple1(OP_glBindVertexArray, a); }
/* glInterleavedArrays: the GL 1.1 table, as pointer and enable calls */
void tc_glInterleavedArrays(GLenum format, GLsizei stride, const void *pointer) {
  static const struct { GLenum f; int t, c, n, v; GLenum ct; int pc, pn, pv, s; } k[] = {
    { GL_V2F, 0, 0, 0, 2, 0, 0, 0, 0, 8 }, { GL_V3F, 0, 0, 0, 3, 0, 0, 0, 0, 12 },
    { GL_C4UB_V2F, 0, 4, 0, 2, GL_UNSIGNED_BYTE, 0, 0, 4, 12 }, { GL_C4UB_V3F, 0, 4, 0, 3, GL_UNSIGNED_BYTE, 0, 0, 4, 16 },
    { GL_C3F_V3F, 0, 3, 0, 3, GL_FLOAT, 0, 0, 12, 24 }, { GL_N3F_V3F, 0, 0, 1, 3, 0, 0, 0, 12, 24 },
    { GL_C4F_N3F_V3F, 0, 4, 1, 3, GL_FLOAT, 0, 16, 28, 40 }, { GL_T2F_V3F, 2, 0, 0, 3, 0, 0, 0, 8, 20 },
    { GL_T4F_V4F, 4, 0, 0, 4, 0, 0, 0, 16, 32 }, { GL_T2F_C4UB_V3F, 2, 4, 0, 3, GL_UNSIGNED_BYTE, 8, 0, 12, 24 },
    { GL_T2F_C3F_V3F, 2, 3, 0, 3, GL_FLOAT, 8, 0, 20, 32 }, { GL_T2F_N3F_V3F, 2, 0, 1, 3, 0, 0, 8, 20, 32 },
    { GL_T2F_C4F_N3F_V3F, 2, 4, 1, 3, GL_FLOAT, 8, 24, 36, 48 }, { GL_T4F_C4F_N3F_V4F, 4, 4, 1, 4, GL_FLOAT, 16, 32, 44, 60 },
  };
  for (size_t i = 0; i < sizeof k / sizeof k[0]; i++) {
    if (k[i].f != format) continue;
    const uint8_t *p = pointer;
    GLsizei st = stride ? stride : k[i].s;
    tc_glDisableClientState(GL_EDGE_FLAG_ARRAY); tc_glDisableClientState(GL_INDEX_ARRAY);
    tc_glDisableClientState(GL_FOG_COORD_ARRAY); tc_glDisableClientState(GL_SECONDARY_COLOR_ARRAY);
    if (k[i].t) { tc_glEnableClientState(GL_TEXTURE_COORD_ARRAY); tc_glTexCoordPointer(k[i].t, GL_FLOAT, st, p); }
    else tc_glDisableClientState(GL_TEXTURE_COORD_ARRAY);
    if (k[i].c) { tc_glEnableClientState(GL_COLOR_ARRAY); tc_glColorPointer(k[i].c, k[i].ct, st, p + k[i].pc); }
    else tc_glDisableClientState(GL_COLOR_ARRAY);
    if (k[i].n) { tc_glEnableClientState(GL_NORMAL_ARRAY); tc_glNormalPointer(GL_FLOAT, st, p + k[i].pn); }
    else tc_glDisableClientState(GL_NORMAL_ARRAY);
    tc_glEnableClientState(GL_VERTEX_ARRAY); tc_glVertexPointer(k[i].v, GL_FLOAT, st, p + k[i].pv);
    return;
  }
  local_error(GL_INVALID_ENUM);
}
void tc_glDeleteBuffers(GLsizei n, const GLuint *b) { uint32_t *w = tc_begin(1 + (size_t)(n > 0 ? n : 0), OP_glDeleteBuffers); if (w) { tc_put_array(w, b, (size_t)(n > 0 ? n : 0) * 4); tc_end(); } }
void tc_glDeleteVertexArrays(GLsizei n, const GLuint *b) { uint32_t *w = tc_begin(1 + (size_t)(n > 0 ? n : 0), OP_glDeleteVertexArrays); if (w) { tc_put_array(w, b, (size_t)(n > 0 ? n : 0) * 4); tc_end(); } }
void tc_glDrawArrays(GLenum mode, GLint first, GLsizei count) {
  if (T.ctx && client_arrays_on(T.ctx)) upload_arrays(T.ctx, first, count);
  uint32_t *w = tc_begin(3, OP_glDrawArrays); if (w) { w[0] = mode; w[1] = (uint32_t)first; w[2] = (uint32_t)count; tc_end(); }
}
void tc_glDrawArraysInstanced(GLenum mode, GLint first, GLsizei count, GLsizei inst) {
  if (T.ctx && client_arrays_on(T.ctx)) upload_arrays(T.ctx, first, count);
  uint32_t *w = tc_begin(4, OP_glDrawArraysInstanced); if (w) { w[0] = mode; w[1] = (uint32_t)first; w[2] = (uint32_t)count; w[3] = (uint32_t)inst; tc_end(); }
}
static void index_range(const void *p, GLsizei count, GLenum type, uint32_t *lo, uint32_t *hi) {
  uint32_t a = 0xffffffffu, b = 0;
  for (GLsizei i = 0; i < count; i++) {
    uint32_t v = type == GL_UNSIGNED_BYTE ? ((const uint8_t *)p)[i] : type == GL_UNSIGNED_SHORT ? ((const uint16_t *)p)[i] : ((const uint32_t *)p)[i];
    if (v == (type == GL_UNSIGNED_BYTE ? 0xffu : type == GL_UNSIGNED_SHORT ? 0xffffu : 0xffffffffu)) continue; /* a restart index */
    if (v < a) a = v;
    if (v > b) b = v;
  }
  *lo = a; *hi = b;
}
/* range: the vertices the draw reads when the app said (glDrawRangeElements), else NULL */
static void draw_elements(unsigned op, GLenum mode, GLsizei count, GLenum type, const void *indices, const uint32_t *extra, int nextra,
                          const uint32_t *range, GLint base) {
  struct tc_ctx *c = T.ctx;
  if (!c || count <= 0) return;
  size_t isize = type == GL_UNSIGNED_BYTE ? 1 : type == GL_UNSIGNED_SHORT ? 2 : 4;
  size_t n = (size_t)count * isize;
  int client_indices = !element_buffer && !c->vao;
  if (client_indices && !indices) { local_error(GL_INVALID_OPERATION); return; }
  if (client_arrays_on(c)) {
    uint32_t lo, hi;
    if (range) { lo = range[0]; hi = range[1]; }
    else if (client_indices) index_range(indices, count, type, &lo, &hi);
    else {
      /* indices in a buffer the page has: ask for them (rare: client vertices with buffer indices) */
      void *tmp = malloc(n);
      if (!tmp) return;
      tc_glGetBufferSubData(GL_ELEMENT_ARRAY_BUFFER, (GLintptr)indices, (GLsizeiptr)n, tmp);
      index_range(tmp, count, type, &lo, &hi);
      free(tmp);
    }
    if (lo <= hi) upload_arrays(c, (int64_t)lo + base, (int64_t)hi - lo + 1);
  }
  if (client_indices) { upload(GL_ELEMENT_ARRAY_BUFFER, 0, 0, indices, n); indices = NULL; }
  uint32_t *w = tc_begin(5 + (size_t)nextra, op);
  if (!w) return;
  w[0] = mode; w[1] = (uint32_t)count; w[2] = type; int64_t off = (int64_t)(intptr_t)indices; memcpy(w + 3, &off, 8);
  for (int i = 0; i < nextra; i++) w[5 + i] = extra[i];
  tc_end();
}
void tc_glDrawElements(GLenum mode, GLsizei count, GLenum type, const void *indices) { draw_elements(OP_glDrawElements, mode, count, type, indices, NULL, 0, NULL, 0); }
void tc_glDrawElementsInstanced(GLenum mode, GLsizei count, GLenum type, const void *indices, GLsizei inst) {
  uint32_t x = (uint32_t)inst; draw_elements(OP_glDrawElementsInstanced, mode, count, type, indices, &x, 1, NULL, 0);
}
void tc_glDrawElementsBaseVertex(GLenum mode, GLsizei count, GLenum type, const void *indices, GLint base) {
  uint32_t x = (uint32_t)base; draw_elements(OP_glDrawElementsBaseVertex, mode, count, type, indices, &x, 1, NULL, base);
}
void tc_glDrawElementsInstancedBaseVertex(GLenum mode, GLsizei count, GLenum type, const void *indices, GLsizei inst, GLint base) {
  uint32_t x[2] = { (uint32_t)inst, (uint32_t)base }; draw_elements(OP_glDrawElementsInstancedBaseVertex, mode, count, type, indices, x, 2, NULL, base);
}
void tc_glDrawRangeElements(GLenum mode, GLuint start, GLuint end, GLsizei count, GLenum type, const void *indices) {
  uint32_t r[2] = { start, end }; draw_elements(OP_glDrawElements, mode, count, type, indices, NULL, 0, r, 0);
}
void tc_glDrawRangeElementsBaseVertex(GLenum mode, GLuint start, GLuint end, GLsizei count, GLenum type, const void *indices, GLint base) {
  uint32_t r[2] = { start, end }, x = (uint32_t)base; draw_elements(OP_glDrawElementsBaseVertex, mode, count, type, indices, &x, 1, r, base);
}
void tc_glMultiDrawArrays(GLenum mode, const GLint *first, const GLsizei *count, GLsizei n) {
  for (GLsizei i = 0; i < n; i++) tc_glDrawArrays(mode, first[i], count[i]);
}
void tc_glMultiDrawElements(GLenum mode, const GLsizei *count, GLenum type, const void *const *indices, GLsizei n) {
  for (GLsizei i = 0; i < n; i++) tc_glDrawElements(mode, count[i], type, indices[i]);
}
void tc_glMultiDrawElementsBaseVertex(GLenum mode, const GLsizei *count, GLenum type, const void *const *indices, GLsizei n, const GLint *base) {
  for (GLsizei i = 0; i < n; i++) tc_glDrawElementsBaseVertex(mode, count[i], type, indices[i], base[i]);
}

/* ── GLX ── */
#define CFG_MAX 64
struct tc_fbconfig {
  int id; VisualID visual; int depth; int alpha; int doublebuffer; int depth_bits; int stencil_bits; int samples;
};
struct tc_display {
  Display *dpy; int screen;
  struct tc_fbconfig cfg[CFG_MAX]; int ncfg;
  struct tc_display *next;
};
static struct tc_display *displays;
static pthread_mutex_t dpy_lock = PTHREAD_MUTEX_INITIALIZER;

static struct tc_display *display_info(Display *dpy, int screen) {
  pthread_mutex_lock(&dpy_lock);
  struct tc_display *d;
  for (d = displays; d; d = d->next) if (d->dpy == dpy && d->screen == screen) break;
  if (!d) {
    d = calloc(1, sizeof *d);
    d->dpy = dpy; d->screen = screen;
    XVisualInfo tmpl = { .screen = screen, .class = TrueColor }; int n = 0;
    XVisualInfo *vis = XGetVisualInfo(dpy, VisualScreenMask | VisualClassMask, &tmpl, &n);
    /* per visual: double buffered with depth/stencil (the default), then 4× MSAA, single buffered, no depth */
    static const int variants[][4] = { { 1, 24, 8, 0 }, { 1, 24, 8, 4 }, { 0, 24, 8, 0 }, { 1, 0, 0, 0 }, { 1, 16, 0, 0 } };
    for (int i = 0; i < n; i++) {
      if (vis[i].depth != 24 && vis[i].depth != 32) continue;
      if (vis[i].bits_per_rgb != 8) continue;
      int dup = 0;
      for (int k = 0; k < d->ncfg; k++) if (d->cfg[k].visual == vis[i].visualid) dup = 1;
      if (dup) continue;
      for (size_t v = 0; v < sizeof variants / sizeof *variants && d->ncfg < CFG_MAX; v++) {
        struct tc_fbconfig *c = &d->cfg[d->ncfg];
        c->id = 0x100 + d->ncfg; c->visual = vis[i].visualid; c->depth = vis[i].depth; c->alpha = vis[i].depth == 32 ? 8 : 0;
        c->doublebuffer = variants[v][0]; c->depth_bits = variants[v][1]; c->stencil_bits = variants[v][2]; c->samples = variants[v][3];
        d->ncfg++;
      }
    }
    if (vis) XFree(vis);
    d->next = displays; displays = d;
  }
  pthread_mutex_unlock(&dpy_lock);
  return d;
}
static struct tc_fbconfig *config_of(GLXFBConfig f) { return (struct tc_fbconfig *)f; }
static struct tc_display *display_of_config(struct tc_fbconfig *f) {
  for (struct tc_display *d = displays; d; d = d->next) if (f >= d->cfg && f < d->cfg + d->ncfg) return d;
  return NULL;
}

static int config_attrib(struct tc_fbconfig *c, int attrib, int *value) {
  switch (attrib) {
  case GLX_USE_GL: *value = 1; break;
  case GLX_BUFFER_SIZE: *value = c->depth == 32 ? 32 : 24; break;
  case GLX_LEVEL: *value = 0; break;
  case GLX_RGBA: *value = 1; break;
  case GLX_DOUBLEBUFFER: *value = c->doublebuffer; break;
  case GLX_STEREO: *value = 0; break;
  case GLX_AUX_BUFFERS: *value = 0; break;
  case GLX_RED_SIZE: case GLX_GREEN_SIZE: case GLX_BLUE_SIZE: *value = 8; break;
  case GLX_ALPHA_SIZE: *value = c->alpha; break;
  case GLX_DEPTH_SIZE: *value = c->depth_bits; break;
  case GLX_STENCIL_SIZE: *value = c->stencil_bits; break;
  case GLX_ACCUM_RED_SIZE: case GLX_ACCUM_GREEN_SIZE: case GLX_ACCUM_BLUE_SIZE: case GLX_ACCUM_ALPHA_SIZE: *value = 0; break;
  case GLX_SAMPLE_BUFFERS: *value = c->samples ? 1 : 0; break;
  case GLX_SAMPLES: *value = c->samples; break;
  case GLX_X_VISUAL_TYPE: *value = GLX_TRUE_COLOR; break;
  case GLX_CONFIG_CAVEAT: *value = GLX_NONE; break;
  case GLX_TRANSPARENT_TYPE: *value = GLX_NONE; break;
  case GLX_TRANSPARENT_INDEX_VALUE: case GLX_TRANSPARENT_RED_VALUE: case GLX_TRANSPARENT_GREEN_VALUE:
  case GLX_TRANSPARENT_BLUE_VALUE: case GLX_TRANSPARENT_ALPHA_VALUE: *value = 0; break;
  case GLX_VISUAL_ID: *value = (int)c->visual; break;
  case GLX_DRAWABLE_TYPE: *value = GLX_WINDOW_BIT | GLX_PIXMAP_BIT | GLX_PBUFFER_BIT; break;
  case GLX_RENDER_TYPE: *value = GLX_RGBA_BIT; break;
  case GLX_X_RENDERABLE: *value = 1; break;
  case GLX_FBCONFIG_ID: *value = c->id; break;
  case GLX_MAX_PBUFFER_WIDTH: case GLX_MAX_PBUFFER_HEIGHT: *value = 8192; break;
  case GLX_MAX_PBUFFER_PIXELS: *value = 8192 * 8192; break;
  case GLX_FRAMEBUFFER_SRGB_CAPABLE_EXT: *value = 1; break;
  default: return GLX_BAD_ATTRIBUTE;
  }
  return Success;
}

/* GLX 1.3 matching (glXChooseFBConfig): minimums, exact matches, then the spec's sort order. */
struct want { int attr, value; };
static int config_matches(struct tc_fbconfig *c, const struct want *w, int nw) {
  for (int i = 0; i < nw; i++) {
    int v = 0, a = w[i].attr, x = w[i].value;
    if (x == (int)GLX_DONT_CARE) continue;
    if (config_attrib(c, a, &v) != Success) continue;
    switch (a) {
    case GLX_BUFFER_SIZE: case GLX_RED_SIZE: case GLX_GREEN_SIZE: case GLX_BLUE_SIZE: case GLX_ALPHA_SIZE: case GLX_DEPTH_SIZE:
    case GLX_STENCIL_SIZE: case GLX_ACCUM_RED_SIZE: case GLX_ACCUM_GREEN_SIZE: case GLX_ACCUM_BLUE_SIZE: case GLX_ACCUM_ALPHA_SIZE:
    case GLX_SAMPLE_BUFFERS: case GLX_SAMPLES: case GLX_AUX_BUFFERS:
      if (v < x) return 0; break;
    case GLX_DRAWABLE_TYPE: case GLX_RENDER_TYPE: if ((v & x) != x) return 0; break;
    case GLX_FRAMEBUFFER_SRGB_CAPABLE_EXT: if (x && !v) return 0; break;
    case GLX_CONFIG_CAVEAT: case GLX_X_VISUAL_TYPE: case GLX_TRANSPARENT_TYPE: if (v != x) return 0; break;
    case GLX_DOUBLEBUFFER: case GLX_STEREO: case GLX_X_RENDERABLE: case GLX_FBCONFIG_ID: case GLX_LEVEL: case GLX_VISUAL_ID:
      if (v != x) return 0; break;
    }
  }
  return 1;
}
static const struct want *sort_wants; static int sort_nw;
static int want_of(int attr) { for (int i = 0; i < sort_nw; i++) if (sort_wants[i].attr == attr) return sort_wants[i].value; return 0; }
static int cmp_config(const void *a, const void *b) {
  struct tc_fbconfig *x = *(struct tc_fbconfig *const *)a, *y = *(struct tc_fbconfig *const *)b;
  /* color bits: larger first when asked for, 32-bit visuals after 24 when alpha isn't asked for */
  int wa = want_of(GLX_ALPHA_SIZE);
  if (x->alpha != y->alpha) return wa > 0 ? y->alpha - x->alpha : x->alpha - y->alpha;
  if (x->doublebuffer != y->doublebuffer) return x->doublebuffer ? -1 : 1;
  if (x->samples != y->samples) return x->samples - y->samples;
  if (x->depth_bits != y->depth_bits) return want_of(GLX_DEPTH_SIZE) > 0 ? y->depth_bits - x->depth_bits : x->depth_bits - y->depth_bits;
  if (x->stencil_bits != y->stencil_bits) return x->stencil_bits - y->stencil_bits;
  return x->id - y->id;
}
static struct tc_fbconfig **choose(struct tc_display *d, const struct want *w, int nw, int *n) {
  struct tc_fbconfig **out = malloc(sizeof *out * (size_t)(d->ncfg ? d->ncfg : 1));
  int k = 0;
  for (int i = 0; i < d->ncfg; i++) if (config_matches(&d->cfg[i], w, nw)) out[k++] = &d->cfg[i];
  sort_wants = w; sort_nw = nw;
  qsort(out, (size_t)k, sizeof *out, cmp_config);
  *n = k;
  return out;
}

static XVisualInfo *visual_info(Display *dpy, int screen, VisualID id) {
  XVisualInfo tmpl = { .screen = screen, .visualid = id }; int n = 0;
  return XGetVisualInfo(dpy, VisualScreenMask | VisualIDMask, &tmpl, &n);
}

static GLXFBConfig *tc_glXChooseFBConfig(Display *dpy, int screen, const int *attribs, int *nelements) {
  struct tc_display *d = display_info(dpy, screen);
  struct want w[64]; int nw = 0;
  /* defaults that differ from "don't care" (GLX 1.4 table 3.4) */
  w[nw++] = (struct want){ GLX_DRAWABLE_TYPE, GLX_WINDOW_BIT };
  w[nw++] = (struct want){ GLX_RENDER_TYPE, GLX_RGBA_BIT };
  w[nw++] = (struct want){ GLX_X_RENDERABLE, (int)GLX_DONT_CARE };
  for (const int *a = attribs; a && *a && nw < 64; a += 2) {
    int found = 0;
    for (int i = 0; i < nw; i++) if (w[i].attr == a[0]) { w[i].value = a[1]; found = 1; }
    if (!found) w[nw++] = (struct want){ a[0], a[1] };
  }
  int n;
  struct tc_fbconfig **c = choose(d, w, nw, &n);
  *nelements = n;
  if (!n) { free(c); return NULL; }
  return (GLXFBConfig *)c;
}
static GLXFBConfig *tc_glXGetFBConfigs(Display *dpy, int screen, int *nelements) {
  struct tc_display *d = display_info(dpy, screen);
  GLXFBConfig *out = malloc(sizeof *out * (size_t)(d->ncfg ? d->ncfg : 1));
  for (int i = 0; i < d->ncfg; i++) out[i] = (GLXFBConfig)&d->cfg[i];
  *nelements = d->ncfg;
  return out;
}
static int tc_glXGetFBConfigAttrib(Display *dpy, GLXFBConfig config, int attribute, int *value) {
  (void)dpy;
  return config ? config_attrib(config_of(config), attribute, value) : GLX_BAD_ATTRIBUTE;
}
static XVisualInfo *tc_glXGetVisualFromFBConfig(Display *dpy, GLXFBConfig config) {
  struct tc_fbconfig *c = config_of(config);
  struct tc_display *d = display_of_config(c);
  return d ? visual_info(dpy, d->screen, c->visual) : NULL;
}
static XVisualInfo *tc_glXChooseVisual(Display *dpy, int screen, int *attribList) {
  struct tc_display *d = display_info(dpy, screen);
  struct want w[64]; int nw = 0, rgba = 0;
  w[nw++] = (struct want){ GLX_DOUBLEBUFFER, 0 };
  for (int *a = attribList; a && *a && nw < 60; a++) {
    switch (*a) {
    case GLX_RGBA: rgba = 1; break;
    case GLX_DOUBLEBUFFER: w[0].value = 1; break;
    case GLX_STEREO: return NULL;
    case GLX_USE_GL: break;
    default: w[nw++] = (struct want){ a[0], a[1] }; a++; break;
    }
  }
  (void)rgba; /* color-index visuals don't exist here; treat every request as RGBA */
  int n;
  struct tc_fbconfig **c = choose(d, w, nw, &n);
  XVisualInfo *vi = n ? visual_info(dpy, screen, c[0]->visual) : NULL;
  free(c);
  return vi;
}
static int tc_glXGetConfig(Display *dpy, XVisualInfo *vis, int attrib, int *value) {
  struct tc_display *d = display_info(dpy, vis->screen);
  for (int i = 0; i < d->ncfg; i++) if (d->cfg[i].visual == vis->visualid) return config_attrib(&d->cfg[i], attrib, value);
  if (attrib == GLX_USE_GL) { *value = 0; return Success; }
  return GLX_BAD_VISUAL;
}

static struct tc_ctx *create_context(Display *dpy, struct tc_fbconfig *cfg, struct tc_ctx *share, int major, int minor, int profile, int flags) {
  if (connect_server() < 0) return NULL;
  struct tc_ctx *c = calloc(1, sizeof *c);
  c->dpy = dpy; c->major = major; c->minor = minor; c->profile = profile; c->flags = flags;
  c->fbconfig = cfg ? cfg->id : 0;
  pthread_mutex_lock(&ctx_lock);
  c->id = next_ctx_id++;
  if (share) { c->share = share->share; c->share->refs++; }
  else { c->share = calloc(1, sizeof *c->share); c->share->refs = 1; }
  c->next_ctx = contexts; contexts = c;
  pthread_mutex_unlock(&ctx_lock);
  uint32_t a[5] = { c->id, share ? share->id : 0, (uint32_t)major, (uint32_t)minor, (uint32_t)profile | ((uint32_t)flags << 8) };
  control(0, OP_tcCreateContext, a, 5);
  if (dbg()) logf_("context %u: %d.%d profile %d flags %d share %u", c->id, major, minor, profile, flags, share ? share->id : 0);
  return c;
}
static GLXContext tc_glXCreateNewContext(Display *dpy, GLXFBConfig config, int renderType, GLXContext shareList, Bool direct) {
  (void)renderType; (void)direct;
  return (GLXContext)create_context(dpy, config_of(config), (struct tc_ctx *)shareList, 2, 1, GLX_CONTEXT_COMPATIBILITY_PROFILE_BIT_ARB, 0);
}
static GLXContext tc_glXCreateContext(Display *dpy, XVisualInfo *vis, GLXContext shareList, Bool direct) {
  (void)direct;
  struct tc_display *d = display_info(dpy, vis->screen);
  struct tc_fbconfig *cfg = NULL;
  for (int i = 0; i < d->ncfg; i++) if (d->cfg[i].visual == vis->visualid) { cfg = &d->cfg[i]; break; }
  return (GLXContext)create_context(dpy, cfg, (struct tc_ctx *)shareList, 2, 1, GLX_CONTEXT_COMPATIBILITY_PROFILE_BIT_ARB, 0);
}
static GLXContext tc_glXCreateContextAttribsARB(Display *dpy, GLXFBConfig config, GLXContext share, Bool direct, const int *attribs) {
  (void)direct;
  int major = 1, minor = 0, profile = GLX_CONTEXT_CORE_PROFILE_BIT_ARB, flags = 0;
  for (const int *a = attribs; a && *a; a += 2) {
    switch (a[0]) {
    case GLX_CONTEXT_MAJOR_VERSION_ARB: major = a[1]; break;
    case GLX_CONTEXT_MINOR_VERSION_ARB: minor = a[1]; break;
    case GLX_CONTEXT_PROFILE_MASK_ARB: profile = a[1]; break;
    case GLX_CONTEXT_FLAGS_ARB: flags = a[1]; break;
    }
  }
  if (major * 10 + minor > 33 || (profile & GLX_CONTEXT_ES2_PROFILE_BIT_EXT)) {
    /* GL 4.x isn't offered: BadMatch, as a driver without it does */
    if (dbg()) logf_("refusing a %d.%d context (profile %d)", major, minor, profile);
    return NULL;
  }
  if (major * 10 + minor < 32) profile = GLX_CONTEXT_COMPATIBILITY_PROFILE_BIT_ARB;
  if (major * 10 + minor <= 21) { major = 2; minor = 1; }
  struct tc_ctx *c = create_context(dpy, config_of(config), (struct tc_ctx *)share, major, minor, profile, flags);
  if (c && glvnd) glvnd->addVendorContextMapping(dpy, (GLXContext)c, our_vendor);
  return (GLXContext)c;
}
static void release_context(struct tc_ctx *c) {
  if (c->bound || !c->destroyed) return;
  pthread_mutex_lock(&ctx_lock);
  for (struct tc_ctx **pp = &contexts; *pp; pp = &(*pp)->next_ctx) if (*pp == c) { *pp = c->next_ctx; break; }
  pthread_mutex_unlock(&ctx_lock);
  uint32_t a = c->id;
  control(0, OP_tcDestroyContext, &a, 1);
  if (--c->share->refs == 0) {
    for (uint32_t i = 0; i < c->share->nobjs; i++) { free_info(&c->share->objs[i]); free(c->share->objs[i].source); free(c->share->objs[i].tf_names); }
    free(c->share->objs); free(c->share);
  }
  for (int i = 0; i < 5; i++) free(c->strings[i]);
  if (c->ext_list) { for (int i = 0; c->ext_list[i]; i++) free(c->ext_list[i]); free(c->ext_list); }
  for (int i = 0; i < c->nlimits; i++) free(c->limit_val[i]);
  free(c);
}
static void tc_glXDestroyContext(Display *dpy, GLXContext ctx) {
  (void)dpy;
  struct tc_ctx *c = (struct tc_ctx *)ctx;
  if (!c) return;
  c->destroyed = 1;
  release_context(c);
}
static Bool make_current(Display *dpy, GLXDrawable draw, GLXDrawable read, GLXContext ctx) {
  (void)dpy;
  struct tc_ctx *c = (struct tc_ctx *)ctx, *old = T.ctx;
  if (old) {
    flush();
    if (old != c) { old->bound = 0; T.ctx = NULL; release_context(old); }
  }
  if (!c) { T.ctx = NULL; return True; }
  if (c->bound && old != c) return False; /* current in another thread: BadAccess */
  c->bound = 1;
  c->draw = draw; c->read = read;
  T.ctx = c;
  uint32_t *w = tc_begin(4, OP_tcMakeCurrent);
  if (w) { w[0] = c->id; w[1] = (uint32_t)draw; w[2] = (uint32_t)read; w[3] = (uint32_t)c->fbconfig; tc_end(); }
  flush();
  return True;
}
static Bool tc_glXMakeCurrent(Display *dpy, GLXDrawable drawable, GLXContext ctx) { return make_current(dpy, drawable, drawable, ctx); }
static Bool tc_glXMakeContextCurrent(Display *dpy, GLXDrawable draw, GLXDrawable read, GLXContext ctx) { return make_current(dpy, draw, read, ctx); }
static void tc_glXSwapBuffers(Display *dpy, GLXDrawable drawable) {
  (void)dpy;
  uint32_t a[2] = { (uint32_t)drawable, ++frames_sent };
  struct tc_ctx *c = T.ctx;
  uint32_t *w = c ? tc_begin(2, OP_tcSwapBuffers) : NULL;
  if (w) { w[0] = a[0]; w[1] = a[1]; tc_end(); flush(); }
  else control(0, OP_tcSwapBuffers, a, 2);
  /* throttle: never more than MAX_FRAMES_AHEAD frames ahead of the page */
  pthread_mutex_lock(&sock_lock);
  while (sock_fd >= 0 && (int32_t)(frames_sent - frames_acked) > MAX_FRAMES_AHEAD) {
    uint8_t *p = NULL; uint32_t len;
    int k = read_message(&p, &len);
    if (k < 0) break;
    free(p);
  }
  pthread_mutex_unlock(&sock_lock);
}
static Bool tc_glXIsDirect(Display *dpy, GLXContext ctx) { (void)dpy; (void)ctx; return True; }
static void tc_glXCopyContext(Display *dpy, GLXContext src, GLXContext dst, unsigned long mask) { (void)dpy; (void)src; (void)dst; (void)mask; tc_unimplemented("glXCopyContext"); }
static GLXPixmap tc_glXCreateGLXPixmap(Display *dpy, XVisualInfo *vis, Pixmap pixmap) { (void)dpy; (void)vis; tc_unimplemented("glXCreateGLXPixmap"); return pixmap; }
static void tc_glXDestroyGLXPixmap(Display *dpy, GLXPixmap pix) { (void)dpy; (void)pix; }
static void tc_glXUseXFont(Font font, int first, int count, int list) { (void)font; (void)first; (void)count; (void)list; tc_unimplemented("glXUseXFont"); }
static void tc_glXWaitGL(void) { tc_glFinish(); }
static void tc_glXWaitX(void) {}
static const char glx_extensions[] =
  "GLX_ARB_create_context GLX_ARB_create_context_profile GLX_ARB_get_proc_address GLX_ARB_multisample "
  "GLX_EXT_framebuffer_sRGB GLX_ARB_framebuffer_sRGB GLX_EXT_swap_control GLX_MESA_swap_control GLX_SGI_swap_control "
  "GLX_EXT_visual_info GLX_SGIX_fbconfig GLX_EXT_create_context_es2_profile";
static const char *tc_glXQueryServerString(Display *dpy, int screen, int name) {
  (void)dpy; (void)screen;
  return name == GLX_VENDOR ? "tabcomputer" : name == GLX_VERSION ? "1.4" : name == GLX_EXTENSIONS ? glx_extensions : NULL;
}
static const char *tc_glXGetClientString(Display *dpy, int name) { return tc_glXQueryServerString(dpy, 0, name); }
static const char *tc_glXQueryExtensionsString(Display *dpy, int screen) { (void)dpy; (void)screen; return glx_extensions; }
static GLXWindow tc_glXCreateWindow(Display *dpy, GLXFBConfig config, Window win, const int *attribs) {
  (void)config; (void)attribs;
  if (glvnd) glvnd->addVendorDrawableMapping(dpy, win, our_vendor);
  return win;
}
static void tc_glXDestroyWindow(Display *dpy, GLXWindow win) {
  if (glvnd) glvnd->removeVendorDrawableMapping(dpy, win);
}
static GLXPixmap tc_glXCreatePixmap(Display *dpy, GLXFBConfig config, Pixmap pixmap, const int *attribs) {
  (void)dpy; (void)config; (void)attribs; tc_unimplemented("glXCreatePixmap"); return pixmap;
}
static void tc_glXDestroyPixmap(Display *dpy, GLXPixmap pixmap) { (void)dpy; (void)pixmap; }
static GLXPbuffer tc_glXCreatePbuffer(Display *dpy, GLXFBConfig config, const int *attribs) {
  (void)dpy; (void)config; (void)attribs; tc_unimplemented("glXCreatePbuffer"); return 0;
}
static void tc_glXDestroyPbuffer(Display *dpy, GLXPbuffer pbuf) { (void)dpy; (void)pbuf; }
static int tc_glXQueryContext(Display *dpy, GLXContext ctx, int attribute, int *value) {
  (void)dpy;
  struct tc_ctx *c = (struct tc_ctx *)ctx;
  switch (attribute) {
  case GLX_FBCONFIG_ID: *value = c->fbconfig; return Success;
  case GLX_RENDER_TYPE: *value = GLX_RGBA_TYPE; return Success;
  case GLX_SCREEN: *value = 0; return Success;
  }
  return GLX_BAD_ATTRIBUTE;
}
static void tc_glXQueryDrawable(Display *dpy, GLXDrawable draw, int attribute, unsigned int *value) {
  Window root; int x, y; unsigned w = 0, h = 0, bw, depth;
  switch (attribute) {
  case GLX_WIDTH: case GLX_HEIGHT:
    if (XGetGeometry(dpy, draw, &root, &x, &y, &w, &h, &bw, &depth)) *value = attribute == GLX_WIDTH ? w : h;
    return;
  case GLX_SWAP_INTERVAL_EXT: *value = T.ctx ? (unsigned)T.ctx->swap_interval : 1; return;
  case GLX_MAX_SWAP_INTERVAL_EXT: *value = 1; return;
  case GLX_FBCONFIG_ID: *value = T.ctx ? (unsigned)T.ctx->fbconfig : 0; return;
  }
  *value = 0;
}
static void tc_glXSelectEvent(Display *dpy, GLXDrawable draw, unsigned long mask) { (void)dpy; (void)draw; (void)mask; }
static void tc_glXGetSelectedEvent(Display *dpy, GLXDrawable draw, unsigned long *mask) { (void)dpy; (void)draw; *mask = 0; }
static void tc_glXSwapIntervalEXT(Display *dpy, GLXDrawable drawable, int interval) { (void)dpy; (void)drawable; if (T.ctx) T.ctx->swap_interval = interval; }
static int tc_glXSwapIntervalMESA(unsigned int interval) { if (T.ctx) T.ctx->swap_interval = (int)interval; return 0; }
static int tc_glXGetSwapIntervalMESA(void) { return T.ctx ? T.ctx->swap_interval : 0; }
static int tc_glXSwapIntervalSGI(int interval) { if (T.ctx) T.ctx->swap_interval = interval; return 0; }

static const struct tc_proc glx_procs[] = {
#define P(n) { #n, (void *)tc_##n }
  P(glXChooseFBConfig), P(glXChooseVisual), P(glXCopyContext), P(glXCreateContext), P(glXCreateGLXPixmap), P(glXCreateNewContext),
  P(glXCreatePbuffer), P(glXCreatePixmap), P(glXCreateWindow), P(glXDestroyContext), P(glXDestroyGLXPixmap), P(glXDestroyPbuffer),
  P(glXDestroyPixmap), P(glXDestroyWindow), P(glXGetClientString), P(glXGetConfig), P(glXGetFBConfigAttrib), P(glXGetFBConfigs),
  P(glXGetSelectedEvent), P(glXGetVisualFromFBConfig), P(glXIsDirect), P(glXMakeContextCurrent), P(glXMakeCurrent),
  P(glXQueryContext), P(glXQueryDrawable), P(glXQueryExtensionsString), P(glXQueryServerString), P(glXSelectEvent),
  P(glXSwapBuffers), P(glXUseXFont), P(glXWaitGL), P(glXWaitX),
#undef P
};
/* GLX extension functions: glvnd asks for a dispatch function; with one vendor ours is it. */
static const struct tc_proc glx_ext_procs[] = {
  { "glXCreateContextAttribsARB", (void *)tc_glXCreateContextAttribsARB },
  { "glXSwapIntervalEXT", (void *)tc_glXSwapIntervalEXT },
  { "glXSwapIntervalMESA", (void *)tc_glXSwapIntervalMESA },
  { "glXGetSwapIntervalMESA", (void *)tc_glXGetSwapIntervalMESA },
  { "glXSwapIntervalSGI", (void *)tc_glXSwapIntervalSGI },
};

static void *lookup(const struct tc_proc *t, unsigned n, const char *name) {
  for (unsigned i = 0; i < n; i++) if (!strcmp(t[i].name, name)) return t[i].fn;
  return NULL;
}
static void *gl_proc(const char *name) {
  unsigned lo = 0, hi = tc_nprocs;
  while (lo < hi) {
    unsigned mid = (lo + hi) / 2;
    int r = strcmp(tc_procs[mid].name, name);
    if (!r) return tc_procs[mid].fn;
    if (r < 0) lo = mid + 1; else hi = mid;
  }
  return NULL;
}
static void *v_getProcAddress(const GLubyte *n) {
  const char *name = (const char *)n;
  void *f = lookup(glx_procs, sizeof glx_procs / sizeof *glx_procs, name);
  if (!f) f = lookup(glx_ext_procs, sizeof glx_ext_procs / sizeof *glx_ext_procs, name);
  if (!f) f = gl_proc(name);
  return f;
}
static void *v_getDispatchAddress(const GLubyte *n) {
  return lookup(glx_ext_procs, sizeof glx_ext_procs / sizeof *glx_ext_procs, (const char *)n);
}
static void v_setDispatchIndex(const GLubyte *n, int index) { (void)n; (void)index; }
static Bool v_isScreenSupported(Display *dpy, int screen) { (void)dpy; (void)screen; return connect_server() == 0; }

EXPORT Bool __glx_Main(uint32_t version, const __GLXapiExports *exports, __GLXvendorInfo *vendor, __GLXapiImports *imports) {
  if ((version >> 16) != 1) { logf_("glvnd vendor ABI %u.%u isn't 1.x", version >> 16, version & 0xffff); return False; }
  glvnd = exports; our_vendor = vendor;
  imports->isScreenSupported = v_isScreenSupported;
  imports->getProcAddress = v_getProcAddress;
  imports->getDispatchAddress = v_getDispatchAddress;
  imports->setDispatchIndex = v_setDispatchIndex;
  return True;
}
