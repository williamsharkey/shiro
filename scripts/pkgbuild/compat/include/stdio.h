/* wasi-libc's <stdio.h> plus the process calls compat/wasi-proc.c provides. */
#include_next <stdio.h>
#include "shiro-proc.h"
#ifndef L_tmpnam
#define L_tmpnam 20
#endif
