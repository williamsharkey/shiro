/*
 * GL transport benchmark for libGLX_tabcomputer (docs/research/GL.md):
 * bulk upload MB/s (glBufferSubData), small calls per second (glVertex3f in
 * immediate mode), and round trips per second (glFinish). Prints one line per
 * measurement. Built with scripts/gl/probes/build.sh; GL through libGL.so.1.
 */
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>

typedef void *GLXContext;
typedef unsigned int GLenum;
typedef float GLfloat;
#define GLX_RGBA 4
#define GLX_DOUBLEBUFFER 5
#define GLX_DEPTH_SIZE 12
#define GL_ARRAY_BUFFER 0x8892
#define GL_STREAM_DRAW 0x88E0
#define GL_POINTS 0

static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }

int main(int argc, char **argv) {
  double seconds = argc > 1 ? atof(argv[1]) : 2.0;
  void *gl = dlopen("libGL.so.1", RTLD_NOW | RTLD_GLOBAL);
  if (!gl) { fprintf(stderr, "no libGL.so.1: %s\n", dlerror()); return 1; }
#define F(ret, name, ...) ret (*name)(__VA_ARGS__) = (ret (*)(__VA_ARGS__))dlsym(gl, #name)
  F(XVisualInfo *, glXChooseVisual, Display *, int, int *);
  F(GLXContext, glXCreateContext, Display *, XVisualInfo *, GLXContext, int);
  F(int, glXMakeCurrent, Display *, unsigned long, GLXContext);
  F(void, glXSwapBuffers, Display *, unsigned long);
  F(void, glGenBuffers, int, unsigned *);
  F(void, glBindBuffer, GLenum, unsigned);
  F(void, glBufferData, GLenum, long, const void *, GLenum);
  F(void, glBufferSubData, GLenum, long, long, const void *);
  F(void, glFinish, void);
  F(void, glBegin, GLenum);
  F(void, glEnd, void);
  F(void, glVertex3f, GLfloat, GLfloat, GLfloat);
  Display *dpy = XOpenDisplay(NULL);
  if (!dpy) { fprintf(stderr, "no display\n"); return 1; }
  int attrs[] = { GLX_RGBA, GLX_DOUBLEBUFFER, GLX_DEPTH_SIZE, 16, 0 };
  XVisualInfo *vi = glXChooseVisual(dpy, DefaultScreen(dpy), attrs);
  if (!vi) { fprintf(stderr, "no visual\n"); return 1; }
  XSetWindowAttributes swa = { .colormap = XCreateColormap(dpy, RootWindow(dpy, vi->screen), vi->visual, AllocNone) };
  Window win = XCreateWindow(dpy, RootWindow(dpy, vi->screen), 0, 0, 256, 256, 0, vi->depth, InputOutput, vi->visual, CWColormap, &swa);
  XMapWindow(dpy, win);
  GLXContext ctx = glXCreateContext(dpy, vi, NULL, 1);
  glXMakeCurrent(dpy, win, ctx);

  /* round trips */
  glFinish();
  int n = 0; double t0 = now();
  while (now() - t0 < seconds) { glFinish(); n++; }
  double dt = now() - t0;
  printf("roundtrip %.0f/s %.1f us\n", n / dt, dt / n * 1e6);

  /* bulk upload */
  unsigned buf; glGenBuffers(1, &buf); glBindBuffer(GL_ARRAY_BUFFER, buf);
  size_t chunk = 1 << 20;
  char *data = calloc(1, chunk);
  glBufferData(GL_ARRAY_BUFFER, (long)chunk, NULL, GL_STREAM_DRAW);
  glFinish();
  n = 0; t0 = now();
  while (now() - t0 < seconds) { data[n & 1023]++; glBufferSubData(GL_ARRAY_BUFFER, 0, (long)chunk, data); n++; if ((n & 7) == 0) glFinish(); }
  glFinish();
  dt = now() - t0;
  printf("upload %.1f MB/s (%d MB in %.2f s)\n", n * (chunk / 1048576.0) / dt, (int)(n * chunk >> 20), dt);

  /* small calls */
  long calls = 0; t0 = now();
  while (now() - t0 < seconds) {
    glBegin(GL_POINTS);
    for (int i = 0; i < 10000; i++) glVertex3f((float)i, 0.f, 0.f);
    glEnd();
    calls += 10002;
    glXSwapBuffers(dpy, win);
  }
  glFinish();
  dt = now() - t0;
  printf("calls %.2f M/s (%ld calls in %.2f s)\n", calls / dt / 1e6, calls, dt);
  return 0;
}
