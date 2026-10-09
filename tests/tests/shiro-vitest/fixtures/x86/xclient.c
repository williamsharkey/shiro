/*
 * Minimal X11 client speaking the wire protocol directly (no libX11), for
 * x11.test.ts: connect to /tmp/.X11-unix/X0, create and map a window with
 * a title, fill a red rectangle on Expose, report a button press, resize
 * itself, report the ConfigureNotify, exit 0. Build: gcc -static -O1.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static int fd;

static void wr(const void *b, int n) {
  while (n > 0) { int k = write(fd, b, n); if (k <= 0) exit(3); b = (const char *)b + k; n -= k; }
}
static void rd(void *b, int n) {
  while (n > 0) { int k = read(fd, b, n); if (k <= 0) exit(4); b = (char *)b + k; n -= k; }
}
static void req(const uint32_t *w, int words) { wr(w, words * 4); }
#define HDR(op, data, len) ((uint32_t)(op) | ((uint32_t)(data) << 8) | ((uint32_t)(len) << 16))

int main(void) {
  fd = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un a = { .sun_family = AF_UNIX };
  strcpy(a.sun_path, "/tmp/.X11-unix/X0");
  if (connect(fd, (struct sockaddr *)&a, sizeof a) < 0) { perror("connect"); return 2; }
  uint8_t setup[12] = { 'l', 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0 };
  wr(setup, 12);
  uint8_t hdr[8];
  rd(hdr, 8);
  if (hdr[0] != 1) { fprintf(stderr, "setup failed\n"); return 5; }
  int extra = (hdr[6] | hdr[7] << 8) * 4;
  uint8_t *s = malloc(extra);
  rd(s, extra);
  uint32_t base = *(uint32_t *)(s + 4);
  int vlen = s[16] | s[17] << 8, nformats = s[21];
  uint8_t *scr = s + 32 + ((vlen + 3) & ~3) + 8 * nformats;
  uint32_t root = *(uint32_t *)scr;
  uint32_t wid = base | 1, gc = base | 2;
  printf("connected root=0x%x\n", root);

  /* CreateWindow 200x100 at 10,20: background white, events Exposure|ButtonPress|KeyPress|StructureNotify */
  uint32_t cw[] = { HDR(1, 0, 10), wid, root, 10 | (20 << 16), 200 | (100 << 16), 0 | (1 << 16), 0,
                    0x2 | 0x800, 0xffffff, (1 << 15) | (1 << 2) | (1 << 0) | (1 << 17) };
  req(cw, 10);
  const char *title = "xclient-test";
  uint32_t cp[6 + 4] = { HDR(18, 0, 6 + 3), wid, 39 /* WM_NAME */, 31 /* STRING */, 8, 12 };
  memcpy(&cp[6], title, 12);
  req(cp, 9);
  uint32_t map[] = { HDR(8, 0, 2), wid };
  req(map, 2);
  uint32_t cgc[] = { HDR(55, 0, 5), gc, wid, 0x4 /* GCForeground */, 0xff0000 };
  req(cgc, 5);
  fflush(stdout);

  for (;;) {
    uint8_t ev[32];
    rd(ev, 32);
    int code = ev[0] & 0x7f;
    if (code == 1) { /* reply: skip its extra data */
      int more = *(uint32_t *)(ev + 4) * 4;
      while (more-- > 0) { uint8_t b; rd(&b, 1); }
      continue;
    }
    if (code == 0) { printf("error %d major %d\n", ev[1], ev[10]); fflush(stdout); continue; }
    if (code == 12) { /* Expose */
      uint32_t fill[] = { HDR(70, 0, 5), wid, gc, 10 | (10 << 16), 50 | (30 << 16) };
      req(fill, 5);
      uint32_t sync[] = { HDR(43, 0, 1) }; /* GetInputFocus: round trip so the fill is processed */
      req(sync, 1);
      printf("drawn\n");
      fflush(stdout);
    } else if (code == 4) { /* ButtonPress */
      int16_t ex = *(int16_t *)(ev + 24), ey = *(int16_t *)(ev + 26);
      printf("button %d at %d,%d\n", ev[1], ex, ey);
      uint32_t conf[] = { HDR(12, 0, 5), wid, 0x0c, 300, 150 };
      req(conf, 5);
      fflush(stdout);
    } else if (code == 2) {
      printf("key %d state %d\n", ev[1], *(uint16_t *)(ev + 28));
      fflush(stdout);
    } else if (code == 22) { /* ConfigureNotify */
      int w = *(uint16_t *)(ev + 20), h = *(uint16_t *)(ev + 22);
      printf("configure %dx%d\n", w, h);
      fflush(stdout);
      if (w == 300 && h == 150) return 0;
    }
  }
}
