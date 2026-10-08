/* wasi-libc's <fcntl.h> plus record-lock constants (locks fail with EINVAL). */
#include_next <fcntl.h>
#ifndef F_SETLKW
#define F_GETLK 5
#define F_SETLK 6
#define F_SETLKW 7
#endif
#ifndef F_RDLCK
#define F_RDLCK 0
#define F_WRLCK 1
#define F_UNLCK 2
#endif
