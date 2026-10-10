// System V message queues: typed send and receive, IPC_NOWAIT, a receiver
// blocking until another process sends, IPC_STAT and IPC_RMID
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/msg.h>
#include <sys/wait.h>
#include <unistd.h>
struct m { long type; char text[32]; };
int main(void) {
  int id = msgget(IPC_PRIVATE, IPC_CREAT | 0600);
  printf("msgget %s\n", id >= 0 ? "ok" : strerror(errno));
  struct m a = {1, "hello"}, b = {2, "world"}, got;
  printf("send %d %d\n", msgsnd(id, &a, 6, 0), msgsnd(id, &b, 6, 0));
  struct msqid_ds ds;
  msgctl(id, IPC_STAT, &ds);
  printf("qnum %lu\n", (unsigned long)ds.msg_qnum);
  long n = msgrcv(id, &got, sizeof got.text, 2, 0);
  printf("rcv type 2: %ld %ld %s\n", n, got.type, got.text);
  n = msgrcv(id, &got, sizeof got.text, 0, 0);
  printf("rcv any: %ld %ld %s\n", n, got.type, got.text);
  n = msgrcv(id, &got, sizeof got.text, 0, IPC_NOWAIT);
  printf("rcv empty nowait: %ld %s\n", n, strerror(errno));
  fflush(stdout);
  pid_t pid = fork();
  if (!pid) {
    struct m c;
    long k = msgrcv(id, &c, sizeof c.text, 7, 0);  // blocks until the parent sends
    printf("child got %ld %ld %s\n", k, c.type, c.text);
    fflush(stdout);
    _exit(0);
  }
  usleep(50000);
  struct m s = {7, "late"};
  msgsnd(id, &s, 5, 0);
  waitpid(pid, 0, 0);
  printf("rmid %d\n", msgctl(id, IPC_RMID, 0));
  int r = msgsnd(id, &a, 6, 0);
  printf("send after rmid %d %s\n", r, strerror(errno));
  return 0;
}
