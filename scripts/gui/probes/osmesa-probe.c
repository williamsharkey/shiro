// OSMesa probe (docs/research/GL.md): context, shader compile, frame times, pixels to check against a
// CPU evaluation of the same shader. Build: gcc -O2 -o osmesa-probe osmesa-probe.c -ldl; in the VM:
// `gui install osmesa-probe`, then `osmesa-probe W H FRAMES` (GALLIUM_DRIVER=softpipe for softpipe).
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
typedef unsigned int GLenum, GLuint, GLbitfield; typedef int GLint, GLsizei; typedef float GLfloat; typedef char GLchar; typedef unsigned char GLubyte;
static double ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
#define GL_COLOR_BUFFER_BIT 0x4000
#define GL_TRIANGLES 4
#define GL_UNSIGNED_BYTE 0x1401
#define GL_FLOAT 0x1406
#define GL_VERTEX_SHADER 0x8B31
#define GL_FRAGMENT_SHADER 0x8B30
#define GL_COMPILE_STATUS 0x8B81
#define GL_LINK_STATUS 0x8B82
#define GL_RENDERER 0x1F01
#define GL_VERSION 0x1F02
static void *(*gpa)(const char *);
#define F(ret, name, ...) static ret (*name)(__VA_ARGS__)
F(void, glClearColor, GLfloat, GLfloat, GLfloat, GLfloat); F(void, glClear, GLbitfield); F(void, glFinish, void);
F(const GLubyte *, glGetString, GLenum); F(GLuint, glCreateShader, GLenum); F(void, glShaderSource, GLuint, GLsizei, const GLchar **, const GLint *);
F(void, glCompileShader, GLuint); F(void, glGetShaderiv, GLuint, GLenum, GLint *); F(GLuint, glCreateProgram, void); F(void, glAttachShader, GLuint, GLuint);
F(void, glLinkProgram, GLuint); F(void, glGetProgramiv, GLuint, GLenum, GLint *); F(void, glUseProgram, GLuint); F(void, glGetShaderInfoLog, GLuint, GLsizei, GLsizei *, GLchar *);
F(void, glVertexAttribPointer, GLuint, GLint, GLenum, unsigned char, GLsizei, const void *); F(void, glEnableVertexAttribArray, GLuint);
F(void, glDrawArrays, GLenum, GLint, GLsizei); F(void, glViewport, GLint, GLint, GLsizei, GLsizei); F(GLint, glGetUniformLocation, GLuint, const GLchar *); F(void, glUniform1f, GLint, GLfloat);
#define L(name) *(void **)&name = gpa(#name)
static const char *vs = "#version 120\nattribute vec2 p; varying vec2 uv; void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }";
static const char *fs = "#version 120\nvarying vec2 uv; uniform float t; void main(){ float r = 0.5 + 0.5 * sin(uv.x * 20.0 + t); float g = 0.5 + 0.5 * cos(uv.y * 15.0 - t); float b = smoothstep(0.2, 0.8, length(uv - 0.5)); gl_FragColor = vec4(r, g, b, 1.0); }";
int main(int argc, char **argv) {
  int W = argc > 1 ? atoi(argv[1]) : 512, H = argc > 2 ? atoi(argv[2]) : 512;
  double t0 = ms();
  void *h = dlopen("libOSMesa.so.8", RTLD_NOW);
  if (!h) { printf("dlopen: %s\n", dlerror()); return 1; }
  double t1 = ms();
  void *(*create)(GLenum, GLint, GLint, GLint, void *) = dlsym(h, "OSMesaCreateContextExt");
  int (*make)(void *, void *, GLenum, GLsizei, GLsizei) = dlsym(h, "OSMesaMakeCurrent");
  gpa = dlsym(h, "OSMesaGetProcAddress");
  void *ctx = create(0x1908 /* OSMESA_RGBA */, 24, 0, 0, NULL);
  unsigned char *buf = calloc(W * H, 4);
  int ok = ctx && make(ctx, buf, GL_UNSIGNED_BYTE, W, H);
  double t2 = ms();
  L(glClearColor); L(glClear); L(glFinish); L(glGetString); L(glCreateShader); L(glShaderSource); L(glCompileShader); L(glGetShaderiv); L(glCreateProgram);
  L(glAttachShader); L(glLinkProgram); L(glGetProgramiv); L(glUseProgram); L(glGetShaderInfoLog); L(glVertexAttribPointer); L(glEnableVertexAttribArray);
  L(glDrawArrays); L(glViewport); L(glGetUniformLocation); L(glUniform1f);
  printf("dlopen %.0f ms, context %.0f ms (ok=%d)\nrenderer: %s\nversion: %s\n", t1 - t0, t2 - t1, ok, glGetString(GL_RENDERER), glGetString(GL_VERSION));
  glViewport(0, 0, W, H);
  double t3 = ms();
  GLuint v = glCreateShader(GL_VERTEX_SHADER), f = glCreateShader(GL_FRAGMENT_SHADER); GLint st = 0;
  glShaderSource(v, 1, &vs, 0); glCompileShader(v); glGetShaderiv(v, GL_COMPILE_STATUS, &st); if (!st) { char log[512]; glGetShaderInfoLog(v, 512, 0, log); printf("vs: %s\n", log); }
  glShaderSource(f, 1, &fs, 0); glCompileShader(f); glGetShaderiv(f, GL_COMPILE_STATUS, &st); if (!st) { char log[512]; glGetShaderInfoLog(f, 512, 0, log); printf("fs: %s\n", log); }
  GLuint pr = glCreateProgram(); glAttachShader(pr, v); glAttachShader(pr, f); glLinkProgram(pr); glGetProgramiv(pr, GL_LINK_STATUS, &st); glUseProgram(pr);
  double t4 = ms();
  printf("compile+link %.0f ms (link=%d)\n", t4 - t3, st);
  static float quad[] = { -1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1 };
  float *tris = malloc(2000 * 6 * sizeof(float));
  for (int i = 0; i < 2000; i++) { float x = (i % 50) / 25.0f - 1, y = (i / 50) / 20.0f - 1; float *q = tris + i * 6; q[0] = x; q[1] = y; q[2] = x + 0.03f; q[3] = y; q[4] = x; q[5] = y + 0.04f; }
  GLint ut = glGetUniformLocation(pr, "t");
  glEnableVertexAttribArray(0);
  int frames = argc > 3 ? atoi(argv[3]) : 5;
  for (int frame = 0; frame < frames; frame++) {
    double a = ms();
    glClearColor(0.1f, 0.1f, 0.1f, 1); glClear(GL_COLOR_BUFFER_BIT); glUniform1f(ut, frame * 0.5f);
    glVertexAttribPointer(0, 2, GL_FLOAT, 0, 0, quad); glDrawArrays(GL_TRIANGLES, 0, 6);
    glVertexAttribPointer(0, 2, GL_FLOAT, 0, 0, tris); glDrawArrays(GL_TRIANGLES, 0, 6000);
    glFinish();
    printf("frame %d (%dx%d, full-screen shaded quad + 2000 triangles): %.0f ms\n", frame, W, H, ms() - a);
  }
  int pts[5][2] = { { W / 2, H / 2 }, { 10, 10 }, { W - 10, 10 }, { 10, H - 10 }, { W / 3, 2 * H / 3 } };
  for (int i = 0; i < 5; i++) { unsigned char *c = buf + 4 * (W * pts[i][1] + pts[i][0]); printf("pixel %d %d rgba %d %d %d %d\n", pts[i][0], pts[i][1], c[0], c[1], c[2], c[3]); }
  return 0;
}
