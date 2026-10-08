# wasi_thread_start(tid, start_arg): load the new thread's stack pointer
# from start_arg->stack_top before running any C code (like wasi-libc).
	.globaltype	__stack_pointer, i32
	.functype	thread_main (i32, i32) -> ()
	.globl	wasi_thread_start
	.export_name	wasi_thread_start, wasi_thread_start
	.type	wasi_thread_start,@function
wasi_thread_start:
	.functype	wasi_thread_start (i32, i32) -> ()
	local.get	1
	i32.load	0
	global.set	__stack_pointer
	local.get	0
	local.get	1
	call	thread_main
	end_function
