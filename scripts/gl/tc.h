/* libGLX_tabcomputer internals shared with the generated encoders (gen/tc_gen.c). */
#ifndef TC_H
#define TC_H
#include <stdint.h>
#include <stddef.h>

/* Room for a command of `argwords` 32-bit words after its header, in the
 * calling thread's batch; NULL when no context is current (GL calls are then
 * no-ops). The header is written; the caller fills the arguments and calls
 * tc_end(). */
uint32_t *tc_begin(size_t argwords, unsigned op);
void tc_end(void);
/* An array argument: u32 byte length (0xffffffff for NULL), bytes, padding. */
uint32_t *tc_put_array(uint32_t *w, const void *p, size_t n);
void tc_unimplemented(const char *name);
int tc_pname_count(const char *fn, unsigned pname);

#endif
