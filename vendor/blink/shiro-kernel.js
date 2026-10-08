/**
 * Shiro kernel passthrough for the Blink wasm build (an emscripten --js-library).
 *
 * blink/shiro.inc (patch 0011) forwards the guest's fd, filesystem and
 * process syscalls to the Shiro kernel through shiro_ksys(). Guest threads
 * are pthreads; the call is proxied to the module's main thread (the Worker
 * host.mjs runs in), which returns a Promise, so the calling thread blocks
 * while the main thread stays free to serve every other thread's calls.
 * host.mjs implements Module.shiroKernel.call() over a pool of kernel
 * channels: a blocked read on one channel doesn't stall the others.
 *
 *   shiroKernel.call(nr, args: Int32Array(12), as, input: Uint8Array, outCap)
 *     -> Promise<{ r, hi, out: Uint8Array | null }>
 */

var ShiroKernelLibrary = {
  shiro_ksys__proxy: 'sync',
  shiro_ksys__async: 'auto',
  shiro_ksys: (nr, argsPtr, as, dataPtr, inLen, outCap) => {
    var K = Module['shiroKernel'];
    if (!K) return -38; // ENOSYS
    var args = HEAP32.slice(argsPtr >> 2, (argsPtr >> 2) + 12);
    var input = inLen ? HEAPU8.slice(dataPtr, dataPtr + inLen) : new Uint8Array(0);
    return K.call(nr, args, as, input, outCap).then((res) => {
      if (res.out && res.out.length) HEAPU8.set(res.out, dataPtr);
      HEAP32[argsPtr >> 2] = res.hi;
      return res.r;
    });
  },

  // fork(): hand the guest's image (Blink patch 0013) to the page, which
  // makes the child process and starts a Blink that loads it. Returns the
  // child's pid or -errno.
  shiro_fork__proxy: 'sync',
  shiro_fork__async: 'auto',
  shiro_fork: (ptr, len) => {
    var K = Module['shiroKernel'];
    if (!K || !K.fork) return -38; // ENOSYS
    return K.fork(HEAPU8.slice(ptr, ptr + len));
  },
};

addToLibrary(ShiroKernelLibrary);
