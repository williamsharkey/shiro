// sendfile with a NULL offset (the input's file position) and with one
// (*off advances, the position doesn't); systemd's copy_bytes uses NULL.
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/sendfile.h>
#include <unistd.h>

int main(void) {
  int f = open("in.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (write(f, "hello sendfile world\n", 21) != 21) return 1;
  close(f);
  int in = open("in.txt", O_RDONLY), out = open("out.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  lseek(in, 6, SEEK_SET);
  ssize_t n = sendfile(out, in, NULL, 1 << 20);
  printf("null off: %zd pos %ld\n", n, (long)lseek(in, 0, SEEK_CUR));
  off_t off = 0;
  n = sendfile(out, in, &off, 5);
  printf("off: %zd off %ld pos %ld\n", n, (long)off, (long)lseek(in, 0, SEEK_CUR));
  printf("zero: %zd\n", sendfile(out, in, NULL, 0));
  close(out);
  char buf[64] = {0};
  int r = open("out.txt", O_RDONLY);
  if (read(r, buf, sizeof(buf) - 1) < 0) return 1;
  printf("out: %s", buf);
  return 0;
}
