#!/usr/bin/env bash
# GNU make 4.4.1 (GPL-3.0-or-later) -> make.wasm
#
# Recipes run through posix_spawn (compat/wasi-proc.c: the kernel's WASIX
# proc_spawn3), so `sh -c` and every program a Makefile calls are real
# kernel processes. No jobserver (-j runs jobs one at a time), no load
# average, no guile, no loadable modules.
. "$(dirname "$0")/common.sh"
SRC=$(unpack "$(fetch https://ftp.gnu.org/gnu/make/make-4.4.1.tar.gz dd16fb1d67bfab79a72f5e8390735c49e3e8e70b4945a15ab1f81ddb78658fb3)" make-4.4.1)
setup_wasi_sdk
setup_proc
cd "$SRC"
# wasi-libc's struct dirent ends in a flexible d_name[]
sed -i 's/sizeof (\*d) - sizeof (d->d_name) + len/offsetof (struct dirent, d_name) + len/' src/dir.c
# wasi-libc's start code calls main(argc, argv) only: take envp from environ
sed -i 's/^main (int argc, char \*\*argv, char \*\*envp)$/main (int argc, char **argv)/; s/^  int makefile_status = MAKE_SUCCESS;$/  char **envp = environ;\n  int makefile_status = MAKE_SUCCESS;/' src/main.c
CFLAGS="-O2 $EMU_CFLAGS $PROC_CFLAGS" LIBS="$PROC_LIBS $EMU_LIBS" \
ac_cv_func_posix_spawn=yes ac_cv_func_fork=no ac_cv_func_vfork=no ac_cv_func_getloadavg=no \
ac_cv_func_umask=yes ac_cv_func_pipe=yes ac_cv_func_dup=yes ac_cv_func_dup2=yes ac_cv_func_waitpid=yes \
  ./configure -q --host=wasm32-wasip1 --build="$(./build-aux/config.guess)" \
    --disable-nls --without-guile --disable-load --disable-job-server --without-libintl-prefix
make -j"$(nproc)" >/dev/null
install_wasm make make/bin/make
