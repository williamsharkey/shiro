# Upstream draft: vim's inchar_loop() can block with a key pending

A draft for the project owner to file at https://github.com/vim/vim (issue,
then the patch as a PR). tabcomputer carries the fix in
`scripts/pkgbuild/x86/vim/inchar-negative-wait.patch` (vim package
`9.2.0000-1`).

---

**Title:** inchar_loop(): a negative wait_time on the first loop blocks until the next key

**Body:**

### Steps to reproduce

The bug shows when the clock moves by a millisecond between the start of
`inchar_loop()` and its `wait_time -= elapsed_time;`. It is rare on a native
machine and frequent on a slow or emulated one. We see it under an x86-64
emulator in the browser (Blink), where about one session in thirty is hit:

1. `vim` (no vimrc needed), type `ihello` quickly.
2. Sometimes the last characters are not drawn, and `Esc` doesn't leave
   insert mode, until another key is typed. Then everything typed so far is
   handled at once.

### What happens

In `src/ui.c`, `inchar_loop()`:

```c
	    if (wtime >= 0)
		wait_time = wtime;
	    else
		wait_time = p_ut;
	    elapsed_time = ELAPSED_FUNC(start_tv);
	    wait_time -= elapsed_time;

	    if (wait_time <= 0 && did_call_wait_func)
	    {
		if (wtime >= 0)
		    return 0;
		...
	    }
	}
	...
	did_call_wait_func = TRUE;
	if (wait_func(wait_time, &interrupted, FALSE))
```

When `wtime` is 0 (vim checks for typeahead without waiting, as it does after
each key) and 1 ms has elapsed, `wait_time` becomes -1. On the first time
through the loop `did_call_wait_func` is still FALSE, so the early return is
skipped, and `wait_func(-1, ...)` (`mch_inchar()` → `WaitForChar()`) waits
with no timeout, until the next key. The caller asked for a 0 ms poll, and
the redraw for the key just typed is left pending.

The same happens with `wtime < 0` when more than `'updatetime'` has elapsed
before the first wait: it blocks instead of timing out and firing
CursorHold.

### Fix

`wait_time` should never be negative after the subtraction: zero means
"check once and don't wait", which is what the loop's comment says it wants
("loop at least once to check for characters and events. Matters when
"wtime" is zero"). The negative value only means "block" in the other branch
(`did_start_blocking`), which this one doesn't touch.

```diff
--- a/src/ui.c
+++ b/src/ui.c
@@ -315,6 +315,12 @@ inchar_loop(
 	    elapsed_time = ELAPSED_FUNC(start_tv);
 # endif
 	    wait_time -= elapsed_time;
+	    // Never below zero here: a negative time makes "wait_func" block
+	    // until input arrives.  With "wtime" zero and a millisecond elapsed
+	    // this happened on the first loop, which waits whatever "wait_time"
+	    // is, and a typed character was left unhandled until the next one.
+	    if (wait_time < 0)
+		wait_time = 0;
 
 	    // If the waiting time is now zero or less, we timed out.  However,
 	    // loop at least once to check for characters and events.  Matters
```

With it, the stall no longer occurs: 0 in 60 sessions under the emulator,
against 2 in 60 without it on the same emulator build (see below).

### Environment

Vim 9.2.0000 (huge, no GUI), static x86-64 musl build, run under the Blink
x86-64 emulator compiled to WebAssembly (tabcomputer, https://tabcomputer.com).
Checked with tabcomputer's `tests/browser/vim-keys.mjs --runs 60`, which opens vim,
types `ihello` and counts the sessions where the text isn't on screen within
8 s.
