/**
 * Blink x86-64 engine (public/engines/blink, src/x86-engine): static Linux
 * ELF binaries run through the shell's normal `./binary` exec path.
 *
 * Fixtures: fixtures/x86/hello-musl is committed (38 KB). The Go and static
 * glibc builds of the same programs are made in beforeAll when `go` / `gcc`
 * are available, and those cases are skipped otherwise.
 */
import { describe, it, expect, onTestFinished, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';
import { createTestShell, run } from './helpers';
import * as Abi from '@shiro/kernel/abi';

// fixtures/x86/strops.c on an x86-64 host
const NATIVE_STROPS = 'size 1 4255477d8be3a17c\nsize 2 5ec6f1695a3da52b\nsize 4 98b24faa8cdc2e47\nsize 8 0ecf036ebe70d8d0\n';
// fixtures/x86/sse4.c on an x86-64 host (Intel)
const NATIVE_SSE4 = 'blendv     e4abc65e766ee19d\nptest      7ba00a6efd7a4874\npmovx      b625e06221fbec95\nint        9681ac88d1b48510\nround      15342966be7d2f10\nblend      1772b0668d5f0605\ninsext     1ed641595d55738e\ninsertps   07a824bc4eee852a\ndp         b92c2b618267d645\nmpsadbw    732e9d86324c3735\ncrc32      ed946d3299e3b67d\npcmpestr   f9d8e2fd9893018c\npcmpistr   97a98d5fb234df8d\npcmpstr64  1141d2a07ff9295d\npinsrq 1\npcmpestri 5\ncrc32 0x1900b8ca\n';
// fixtures/x86/sse2d.c on an x86-64 host
const NATIVE_SSE2D = "addsd      bc96350c210f6409\nsubsd      d917cbb966d42e7b\nmulsd      3fc132eaff3380e7\ndivsd      da92576571a8713f\nminsd      f9edb2f454baccc7\nmaxsd      00c42aefef0516ad\nsqrtsd     c58c80ca8efb5c23\nandpd      570233f7972d8c9e\nandnpd     e37627f65999c92e\norpd       1b152a8da83eee96\nxorpd      943724281f612f63\nunpcklpd   1a7e5547a45b561f\nunpckhpd   3b83ee4d02793243\ncmpeqsd    1659b97b6dc7d134\ncmpltsd    83e72d67db829775\ncmplesd    1a1fc4724cd7db2a\ncmpunordsd 3606b7dc1538bd86\ncmpneqsd   4f877dd0634ebd94\ncmpnltsd   6b74f23ca2872331\ncmpnlesd   e31769f1d4309796\ncmpordsd   3e45ed274a09c94a\naddpd      bc96350c210f6409\nmulpd      3fc132eaff3380e7\nminpd      f9edb2f454baccc7\nmaxpd      00c42aefef0516ad\ndivpd      da92576571a8713f\nsubpd      d917cbb966d42e7b\nsqrtpd     c58c80ca8efb5c23\nshufpd     3b83ee4d02793243\nucomisd    7ac10c2aa4d7c9ba\ncomisd     7ac10c2aa4d7c9ba\ncvt        a59b8a8c4454cb60\n";
// fixtures/x86/bitscan.c on an x86-64 host
const NATIVE_BITSCAN = 'bsf  zero64   reg dst=0x1122334455667788 zf=1\nbsf  zero64   mem dst=0x1122334455667788 zf=1\nbsr  zero64   reg dst=0x1122334455667788 zf=1\nbsr  zero64   mem dst=0x1122334455667788 zf=1\nbsf  val64    reg dst=0x8 zf=0\nbsf  val64    mem dst=0x8 zf=0\nbsr  val64    reg dst=0x34 zf=0\nbsr  val64    mem dst=0x34 zf=0\nbsf  zero32   reg dst=0x1122334455667788 zf=1\nbsf  zero32   mem dst=0x1122334455667788 zf=1\nbsr  zero32   reg dst=0x1122334455667788 zf=1\nbsr  zero32   mem dst=0x1122334455667788 zf=1\nbsf  val32    reg dst=0x8 zf=0\nbsf  val32    mem dst=0x8 zf=0\nbsr  val32    reg dst=0x14 zf=0\nbsr  val32    mem dst=0x14 zf=0\nbsf  zero16   reg dst=0x1122334455667788 zf=1\nbsf  zero16   mem dst=0x1122334455667788 zf=1\nbsr  zero16   reg dst=0x1122334455667788 zf=1\nbsr  zero16   mem dst=0x1122334455667788 zf=1\nbsf  val16    reg dst=0x1122334455660004 zf=0\nbsf  val16    mem dst=0x1122334455660004 zf=0\nbsr  val16    reg dst=0x1122334455660008 zf=0\nbsr  val16    mem dst=0x1122334455660008 zf=0\nclz64(0)=64 clz64(1)=63 clz64(1<<40)=23\nloop sum=5953906\n';

const FIX = resolve(__dirname, 'fixtures/x86');

function tryBuild(cmd: string, args: string[], env: Record<string, string> = {}): boolean {
  try {
    execFileSync(cmd, args, { cwd: FIX, env: { ...process.env, ...env }, stdio: 'pipe', timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

const out = mkdtempSync(join(tmpdir(), 'shiro-x86-engine-'));
// the fixture builds (~160 MB with Go's cache) go with the file's last test
afterAll(() => rmSync(out, { recursive: true, force: true }));
const goBin = join(out, 'hello-go');
const httpBin = join(out, 'nethttp');
const glibcBin = join(out, 'hello-glibc');
const goExe = existsSync('/usr/local/go/bin/go') ? '/usr/local/go/bin/go' : 'go';
const haveGo = tryBuild(goExe, ['build', '-ldflags=-s', '-o', goBin, 'hello.go'], { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GOCACHE: join(out, 'gocache') });
const goV2Bin = join(out, 'hello-go-v2');
const haveGoV2 = haveGo && tryBuild(goExe, ['build', '-ldflags=-s', '-o', goV2Bin, 'hello.go'], { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GOAMD64: 'v2', GOCACHE: join(out, 'gocache') });
const haveHttp = haveGo && tryBuild(goExe, ['build', '-ldflags=-s', '-o', httpBin, 'nethttp.go'], { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GOCACHE: join(out, 'gocache') });
const tcpBin = join(out, 'tcpecho');
const haveTcp = haveGo && tryBuild(goExe, ['build', '-ldflags=-s', '-o', tcpBin, 'tcpecho.go'], { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GOCACHE: join(out, 'gocache') });
const gorunBin = join(out, 'gorun');
const haveGorun = haveHttp && tryBuild(goExe, ['build', '-ldflags=-s', '-o', gorunBin, 'gorun.go'], { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GOCACHE: join(out, 'gocache') });
const execerrBin = join(out, 'execerr');
const haveExecerr = tryBuild('musl-gcc', ['-static', '-O1', '-o', execerrBin, 'execerr.c']);
const dynBin = join(out, 'hello-dyn');
const haveDyn = tryBuild('gcc', ['-O1', '-o', dynBin, 'hello.c']);
const gowaitBin = join(out, 'gowait');
const haveGowait = haveGo && tryBuild(goExe, ['build', '-ldflags=-s', '-o', gowaitBin, 'gowait.go'], { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GOCACHE: join(out, 'gocache') });
const ttyBin = join(out, 'tty');
const haveTty = haveGo && tryBuild(goExe, ['build', '-ldflags=-s', '-o', ttyBin, 'tty.go'], { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GOCACHE: join(out, 'gocache') });
const haveGlibc = tryBuild('gcc', ['-static', '-Os', '-o', glibcBin, 'hello.c']);
const jitBin = join(out, 'jit');
const haveJit = tryBuild('gcc', ['-static', '-O1', '-pthread', '-o', jitBin, 'jit.c']);
const forkBin = join(out, 'forkcopy');
const haveFork = tryBuild('gcc', ['-static', '-O1', '-o', forkBin, 'forkcopy.c']);
const mtchildBin = join(out, 'mtchild');
const haveMtchild = tryBuild('gcc', ['-static', '-O1', '-pthread', '-o', mtchildBin, 'mtchild.c']);
const psemBin = join(out, 'psem');
const havePsem = tryBuild('gcc', ['-static', '-O1', '-pthread', '-o', psemBin, 'psem.c']);
const shmobjBin = join(out, 'shmobj');
const haveShmobj = tryBuild('gcc', ['-static', '-O1', '-pthread', '-o', shmobjBin, 'shmobj.c']);
const shmoddBin = join(out, 'shmodd');
const haveShmodd = tryBuild('gcc', ['-static', '-O1', '-o', shmoddBin, 'shmodd.c']);
const shmpreadBin = join(out, 'shmpread');
const haveShmpread = tryBuild('gcc', ['-static', '-O1', '-o', shmpreadBin, 'shmpread.c']);
const fsidentBin = join(out, 'fsident');
const haveFsident = tryBuild('gcc', ['-static', '-O1', '-pthread', '-o', fsidentBin, 'fsident.c']);
// musl's libc (native Claude Code's) resolves paths and stats files its own way
const fsidentMuslBin = join(out, 'fsident-musl');
const haveFsidentMusl = tryBuild('musl-gcc', ['-static', '-O1', '-o', fsidentMuslBin, 'fsident.c']);
const statnullBin = join(out, 'statnull');
const haveStatnull = tryBuild('gcc', ['-static', '-O1', '-o', statnullBin, 'statnull.c']);
const futexwakeBin = join(out, 'futexwake');
const haveFutexwake = tryBuild('gcc', ['-static', '-O1', '-pthread', '-o', futexwakeBin, 'futexwake.c']);
const shfutexBin = join(out, 'shfutex');
const haveShfutex = tryBuild('gcc', ['-static', '-O1', '-o', shfutexBin, 'shfutex.c']);
const orphanBin = join(out, 'orphan');
const haveOrphan = tryBuild('gcc', ['-static', '-O1', '-o', orphanBin, 'orphan.c']);
const futexintrBin = join(out, 'futexintr');
const haveFutexintr = tryBuild('gcc', ['-static', '-O1', '-o', futexintrBin, 'futexintr.c']);
const alarmforkBin = join(out, 'alarmfork');
const haveAlarmfork = tryBuild('gcc', ['-static', '-O1', '-o', alarmforkBin, 'alarmfork.c']);
const forkSharedBin = join(out, 'forkshared');
const haveForkShared = tryBuild('gcc', ['-static', '-O1', '-o', forkSharedBin, 'forkshared.c']);
const mremapBin = join(out, 'mremap');
const haveMremap = tryBuild('gcc', ['-static', '-O1', '-o', mremapBin, 'mremap.c']);
const popmemBin = join(out, 'popmem');
const havePopmem = tryBuild('gcc', ['-static', '-O1', '-o', popmemBin, 'popmem.c']);
const segvBin = join(out, 'segv');
const haveSegv = tryBuild('gcc', ['-static', '-O1', '-o', segvBin, 'segv.c']);
const timerfdBin = join(out, 'timerfd');
const haveTimerfd = tryBuild('gcc', ['-static', '-O1', '-o', timerfdBin, 'timerfd.c']);
const sleepstateBin = join(out, 'sleepstate');
const haveSleepstate = tryBuild('gcc', ['-static', '-O1', '-o', sleepstateBin, 'sleepstate.c']);
const blockedkidsBin = join(out, 'blockedkids');
const haveBlockedkids = tryBuild('gcc', ['-static', '-O1', '-o', blockedkidsBin, 'blockedkids.c']);
const pingpongBin = join(out, 'futexpingpong');
const havePingpong = tryBuild('gcc', ['-static', '-O1', '-pthread', '-o', pingpongBin, 'futexpingpong.c']);
const sockaddrsBin = join(out, 'sockaddrs');
const haveSockaddrs = tryBuild('gcc', ['-static', '-O1', '-o', sockaddrsBin, 'sockaddrs.c']);
const sleepintrBin = join(out, 'sleepintr');
const haveSleepintr = tryBuild('gcc', ['-static', '-O1', '-pthread', '-o', sleepintrBin, 'sleepintr.c']);
const unameBin = join(out, 'uname');
const haveUname = tryBuild('gcc', ['-static', '-O1', '-o', unameBin, 'uname.c']);
const cpuclockBin = join(out, 'cpuclock');
const haveCpuclock = tryBuild('gcc', ['-static', '-O1', '-pthread', '-o', cpuclockBin, 'cpuclock.c']);
const niceBin = join(out, 'nice');
const haveNice = tryBuild('gcc', ['-static', '-O1', '-o', niceBin, 'nice.c']);
const idsBin = join(out, 'ids');
const haveIds = 'SYS_setresuid' in Abi && tryBuild('gcc', ['-static', '-O1', '-o', idsBin, 'ids.c']);
const sigchldBin = join(out, 'sigchldwait');
const haveSigchld = tryBuild('gcc', ['-static', '-O1', '-o', sigchldBin, 'sigchldwait.c']);
const getcpuBin = join(out, 'getcpu');
const haveGetcpu = tryBuild('gcc', ['-static', '-O1', '-o', getcpuBin, 'getcpu.c']);
const sysvshmBin = join(out, 'sysvshm');
const haveSysvshm = 'SYS_shmget' in Abi && tryBuild('gcc', ['-static', '-O1', '-o', sysvshmBin, 'sysvshm.c']);
const sse2dBin = join(out, 'sse2d');
const haveSse2d = tryBuild('gcc', ['-static', '-O1', '-o', sse2dBin, 'sse2d.c']);
const futexckptBin = join(out, 'futexckpt');
const haveFutexckpt = tryBuild('gcc', ['-static', '-O1', '-o', futexckptBin, 'futexckpt.c']);
const sysvsemBin = join(out, 'sysvsem');
const haveSysvsem = 'SYS_semget' in Abi && tryBuild('gcc', ['-static', '-O1', '-o', sysvsemBin, 'sysvsem.c']);
const sysvmsgBin = join(out, 'sysvmsg');
const haveSysvmsg = 'SYS_msgget' in Abi && tryBuild('gcc', ['-static', '-O1', '-o', sysvmsgBin, 'sysvmsg.c']);
const sigwaitBin = join(out, 'sigwait');
const haveSigwait = 'SYS_rt_sigtimedwait' in Abi && tryBuild('gcc', ['-static', '-O1', '-pthread', '-o', sigwaitBin, 'sigwait.c']);
const futexrequeueBin = join(out, 'futexrequeue');
const haveFutexrequeue = tryBuild('gcc', ['-static', '-O1', '-pthread', '-o', futexrequeueBin, 'futexrequeue.c']);
const futexpiBin = join(out, 'futexpi');
const haveFutexpi = tryBuild('gcc', ['-static', '-O1', '-pthread', '-o', futexpiBin, 'futexpi.c']);
const siginfoBin = join(out, 'siginfo');
const haveSiginfo = tryBuild('gcc', ['-static', '-O1', '-o', siginfoBin, 'siginfo.c']);
const hugetlbBin = join(out, 'hugetlb');
const haveHugetlb = tryBuild('gcc', ['-static', '-O1', '-o', hugetlbBin, 'hugetlb.c']);
const rotatesBin = join(out, 'rotates');
const haveRotates = tryBuild('gcc', ['-static', '-O1', '-o', rotatesBin, 'rotates.c']);
const sseiBin = join(out, 'ssei');
const haveSsei = tryBuild('gcc', ['-static', '-O1', '-mssse3', '-o', sseiBin, 'ssei.c']);
const fpjitBin = join(out, 'fpjit');
const haveFpjit = tryBuild('gcc', ['-static', '-O2', '-msse2', '-o', fpjitBin, 'fpjit.c', '-lm']);
const sse41bBin = join(out, 'sse41b');
const haveSse41b = tryBuild('gcc', ['-static', '-O1', '-msse4.1', '-o', sse41bBin, 'sse41b.c']);
const ssefloatBin = join(out, 'ssefloat');
const haveSsefloat = tryBuild('gcc', ['-static', '-O1', '-msse4.1', '-o', ssefloatBin, 'ssefloat.c', '-lm']);
const freewhilewriteBin = join(out, 'freewhilewrite');
const haveFreewhilewrite = tryBuild('gcc', ['-static', '-O1', '-pthread', '-o', freewhilewriteBin, 'freewhilewrite.c']);
const shmunlinkedBin = join(out, 'shmunlinked');
const haveShmunlinked = tryBuild('gcc', ['-static', '-O1', '-o', shmunlinkedBin, 'shmunlinked.c']);
const shmremoteBin = join(out, 'shmremote');
const haveShmremote = tryBuild('gcc', ['-static', '-O1', '-o', shmremoteBin, 'shmremote.c']);
const sharedmapBin = join(out, 'sharedmap');
const haveSharedmap = tryBuild('gcc', ['-static', '-O1', '-o', sharedmapBin, 'sharedmap.c']);
const roundingBin = join(out, 'rounding');
const haveRounding = tryBuild('gcc', ['-static', '-O1', '-frounding-math', '-o', roundingBin, 'rounding.c', '-lm']);
const cowforkBin = join(out, 'cowfork');
const haveCowfork = tryBuild('gcc', ['-static', '-O1', '-o', cowforkBin, 'cowfork.c']);
const siginfochildBin = join(out, 'siginfochild');
const haveSiginfochild = tryBuild('gcc', ['-static', '-O1', '-o', siginfochildBin, 'siginfochild.c']);
const memfdBin = join(out, 'memfd');
const haveMemfd = tryBuild('gcc', ['-static', '-O1', '-o', memfdBin, 'memfd.c']);
const memfdsealBin = join(out, 'memfdseal');
const haveMemfdseal = tryBuild('gcc', ['-static', '-O1', '-o', memfdsealBin, 'memfdseal.c']);
const realtimeBin = join(out, 'realtime');
const haveRealtime = tryBuild('gcc', ['-static', '-O1', '-o', realtimeBin, 'realtime.c']);
const mapsBin = join(out, 'maps');
const haveMaps = tryBuild('gcc', ['-static', '-O1', '-o', mapsBin, 'maps.c']);
const mmsgBin = join(out, 'mmsg');
const haveMmsg = tryBuild('gcc', ['-static', '-O1', '-o', mmsgBin, 'mmsg.c']);
const sendfileBin = join(out, 'sendfile');
const haveSendfile = tryBuild('gcc', ['-static', '-O1', '-o', sendfileBin, 'sendfile.c']);
const stropsBin = join(out, 'strops');
const haveStrops = tryBuild('gcc', ['-static', '-O1', '-o', stropsBin, 'strops.c']);
const sse4Bin = join(out, 'sse4');
const haveSse4 = tryBuild('gcc', ['-static', '-O1', '-msse4.2', '-o', sse4Bin, 'sse4.c']);
const bitscanBin = join(out, 'bitscan');
const haveBitscan = tryBuild('gcc', ['-static', '-O1', '-o', bitscanBin, 'bitscan.c']);
const mkfifoBin = join(out, 'mkfifo');
const haveMkfifo = tryBuild('gcc', ['-static', '-O1', '-o', mkfifoBin, 'mkfifo.c']);
const prctlcapBin = join(out, 'prctlcap');
const havePrctlcap = tryBuild('gcc', ['-static', '-O1', '-o', prctlcapBin, 'prctlcap.c']);
const lchownBin = join(out, 'lchown');
const haveLchown = tryBuild('gcc', ['-static', '-O1', '-o', lchownBin, 'lchown.c']);
const ssecmpBin = join(out, 'ssecmp');
const haveSsecmp = tryBuild('gcc', ['-static', '-O1', '-o', ssecmpBin, 'ssecmp.c', '-lm']);
const brkmapBin = join(out, 'brkmap');
const haveBrkmap = tryBuild('gcc', ['-static', '-O1', '-o', brkmapBin, 'brkmap.c']);
const rawepollBin = join(out, 'rawepoll');
const haveRawepoll = tryBuild('gcc', ['-static', '-O1', '-pthread', '-o', rawepollBin, 'rawepoll.c']);
const bigfileBin = join(out, 'bigfile');
const haveBigfile = tryBuild('gcc', ['-static', '-O1', '-o', bigfileBin, 'bigfile.c']);
const getgroupsBin = join(out, 'getgroups');
const haveGetgroups = tryBuild('gcc', ['-static', '-O1', '-o', getgroupsBin, 'getgroups.c']);
const fionbioBin = join(out, 'fionbio');
const haveFionbio = tryBuild('gcc', ['-static', '-O1', '-o', fionbioBin, 'fionbio.c']);
const fuzzBin = join(out, 'jitfuzz');
const haveFuzz = tryBuild('gcc', ['-static', '-O1', '-o', fuzzBin, 'jitfuzz.c']);

// signalfd needs Blink to forward signalfd/signalfd4 and the signal mask to the kernel (a patch named for it)
const signalfdBin = join(out, 'signalfd');
const blinkForwardsSignalfd = readdirSync(resolve(__dirname, '../../../vendor/blink/patches')).some((f) => /signalfd/i.test(f));
const haveSignalfd = blinkForwardsSignalfd && tryBuild('gcc', ['-static', '-O1', '-o', signalfdBin, 'signalfd.c']);
// LTP conformance (Blink 0080/0081): errnos, clocks, personality, and locks/pipe sizes/RLIMIT_NOFILE from the kernel
const ltpErrnosBin = join(out, 'ltp-errnos');
// (the built engine, not the patch file: perf-blink folds the patches in and rebuilds; 0081 exports blink_shiro_conformance)
const blinkHasLtpErrnos = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_conformance');
const haveLtpErrnos = blinkHasLtpErrnos && tryBuild('gcc', ['-static', '-O1', '-w', '-o', ltpErrnosBin, 'ltp-errnos.c']);
// Blink 0083: raise(SIGKILL) is the kernel's (the parent's wait returned never)
const raiseKillBin = join(out, 'raise-kill');
const blinkHasRaiseKill = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_raise_kill');
const haveRaiseKill = blinkHasRaiseKill && tryBuild('gcc', ['-static', '-O1', '-w', '-o', raiseKillBin, 'raise-kill.c']);
// Blink 0084: rt_sigqueueinfo is the kernel's (POSIX AIO's completion notice, sigqueue)
const aioSigqueueBin = join(out, 'aio-sigqueue');
const blinkHasSigqueue = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_sigqueue');
const haveAioSigqueue = blinkHasSigqueue && tryBuild('gcc', ['-static', '-O1', '-w', '-o', aioSigqueueBin, 'aio-sigqueue.c', '-lrt', '-pthread']);
// Blink 0086: POSIX message queues are the kernel's
const mqueueBin = join(out, 'mqueue');
const blinkHasMqueue = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_mqueue');
const haveMqueue = blinkHasMqueue && tryBuild('gcc', ['-static', '-O1', '-w', '-o', mqueueBin, 'mqueue.c', '-lrt', '-pthread']);
// Blink 0089: POSIX timers are the kernel's (0087 sigtimedwait); sched_* as Linux answers
const timersBin = join(out, 'timers');
const blinkHasTimers = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_timers');
const haveTimers = blinkHasTimers && tryBuild('gcc', ['-static', '-O1', '-w', '-o', timersBin, 'timers.c', '-lrt']);
// Blink 0096: a blocked real-time raise queues in the kernel; sigprocmask and sigaltstack modes as Linux
const sigmodesBin = join(out, 'sigmodes');
const blinkHasSigmodes = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_sigmodes');
const haveSigmodes = blinkHasSigmodes && tryBuild('gcc', ['-static', '-O1', '-w', '-o', sigmodesBin, 'sigmodes.c']);
// Blink 0097/0098: write-only shared pages, and shared kernel-file maps written back before a new map and at exit
const sharedmapsBin = join(out, 'sharedmaps');
const blinkHasSharedmaps = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_sharedmaps');
const haveSharedmaps = blinkHasSharedmaps && tryBuild('gcc', ['-static', '-O1', '-w', '-o', sharedmapsBin, 'sharedmaps.c']);
// The same with a big file (the kernel holds it as pages: FileSystem.BLOB_MIN)
const bigsharedBin = join(out, 'bigshared');
const haveBigshared = blinkHasSharedmaps && tryBuild('gcc', ['-static', '-O1', '-w', '-o', bigsharedBin, 'bigshared.c']);
// Blink 0099: mlock/munlock/mlockall and mmap errors as Linux's
const memerrsBin = join(out, 'memerrs');
const blinkHasMemerrs = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_memerrs');
const haveMemerrs = blinkHasMemerrs && tryBuild('gcc', ['-static', '-O1', '-w', '-o', memerrsBin, 'memerrs.c']);
// Blink 0501: a thread's tkill is SI_TKILL from this process, and the signal frame is Linux's (pthread_cancel)
const cancelBin = join(out, 'cancel');
const blinkHasTkillinfo = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_tkillinfo');
const haveCancel = blinkHasTkillinfo && tryBuild('gcc', ['-static', '-O1', '-w', '-o', cancelBin, 'cancel.c', '-lpthread']);
// Blink 0502: CPU clock ids naming no process or thread of ours are EINVAL
const cpuclockidsBin = join(out, 'cpuclockids');
const blinkHasCpuclockids = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_cpuclockids');
const haveCpuclockids = blinkHasCpuclockids && tryBuild('gcc', ['-static', '-O1', '-w', '-o', cpuclockidsBin, 'cpuclockids.c', '-lpthread']);
// Blink 0503: tkill/tgkill of signal 0 to the calling thread
const tkill0Bin = join(out, 'tkill0');
const blinkHasTkill0 = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_tkill0');
const haveTkill0 = blinkHasTkill0 && tryBuild('gcc', ['-static', '-O1', '-w', '-o', tkill0Bin, 'tkill0.c', '-lpthread']);
// Blink 0504: setting another user's process's scheduling is EPERM
const schedpermBin = join(out, 'schedperm');
const blinkHasSchedperm = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_schedperm');
const haveSchedperm = blinkHasSchedperm && tryBuild('gcc', ['-static', '-O1', '-w', '-o', schedpermBin, 'schedperm.c']);
// Blink 0505: ITIMER_VIRTUAL/PROF are the kernel's, per process
const itimersBin = join(out, 'itimers');
const blinkHasItimers = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_itimers');
const haveItimers = blinkHasItimers && tryBuild('gcc', ['-static', '-O1', '-w', '-o', itimersBin, 'itimers.c']);
// Blink 0506: another existing process's CPU clock reads
const othercpuclockBin = join(out, 'othercpuclock');
const blinkHasOthercpuclock = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_othercpuclock');
const haveOthercpuclock = blinkHasOthercpuclock && tryBuild('gcc', ['-static', '-O1', '-w', '-o', othercpuclockBin, 'othercpuclock.c']);
// Blink 0507: pthread_kill of a thread blocked in a kernel call interrupts it; a process
// signal the main thread blocks reaches a thread that doesn't (the kernel's mask is what all block)
const threadintrBin = join(out, 'threadintr');
const blinkHasThreadintr = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_threadintr');
const haveThreadintr = blinkHasThreadintr && tryBuild('gcc', ['-static', '-O1', '-w', '-o', threadintrBin, 'threadintr.c', '-lpthread', '-lrt']);
// Blink 0508: a page of a file mapping past the file's end is SIGBUS
const sigbusBin = join(out, 'sigbus');
const blinkHasSigbus = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_sigbus');
const haveSigbus = blinkHasSigbus && tryBuild('gcc', ['-static', '-O1', '-w', '-o', sigbusBin, 'sigbus.c', '-lrt']);
// Blink 0509: CPU-time clocks and times() start again in a fork child; children's CPU from the kernel
const forkcpuBin = join(out, 'forkcpu');
const blinkHasForkcpu = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_forkcpu');
const haveForkcpu = blinkHasForkcpu && tryBuild('gcc', ['-static', '-O1', '-w', '-o', forkcpuBin, 'forkcpu.c', '-lpthread']);
// Blink 0510: a SIGEV_THREAD_ID timer's signal goes to its thread (SIGEV_THREAD timers)
const timerthreadBin = join(out, 'timerthread');
const blinkHasTimerthread = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_timerthread');
const haveTimerthread = blinkHasTimerthread && tryBuild('gcc', ['-static', '-O1', '-w', '-o', timerthreadBin, 'timerthread.c', '-lpthread', '-lrt']);
// Blink 0511: a file mapping's last page is the file's to its end
const mmaptailBin = join(out, 'mmaptail');
const blinkHasMmaptail = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_mmaptail');
const haveMmaptail = blinkHasMmaptail && tryBuild('gcc', ['-static', '-O1', '-w', '-o', mmaptailBin, 'mmaptail.c']);
const argv0Bin = join(out, 'argv0');
const haveArgv0 = tryBuild('gcc', ['-static', '-nostdlib', '-fno-builtin', '-Os', '-fno-pie', '-no-pie', '-o', argv0Bin, 'argv0.c']);

async function setup(bin: Uint8Array) {
  const { fs, shell } = await createTestShell();
  await fs.mkdir('/home/user/work', { recursive: true });
  await fs.writeFile('/home/user/work/prog', bin, { mode: 0o755 });
  await fs.writeFile('/home/user/work/input.txt', 'hi from shiro\n');
  await shell.execute('cd /home/user/work', () => {});
  return { fs, shell };
}

describe('x86 engine selection', () => {
  it('chooses blink in Node (SharedArrayBuffer available)', async () => {
    const { chooseX86Engine } = await import('@shiro/x86-engine');
    expect(await chooseX86Engine({})).toBe('blink');
    expect(await chooseX86Engine({ TABCOMPUTER_X86_ENGINE: 'x86' })).toBe('x86');
  });

  it('chooseElfRunner falls back when the old engine is forced', async () => {
    const { chooseElfRunner } = await import('@shiro/x86-engine');
    const fallback = async () => 7;
    expect(await chooseElfRunner('/bin/x', { TABCOMPUTER_X86_ENGINE: 'x86' }, () => fallback)).toBe(fallback);
    expect(await chooseElfRunner('/bin/x', {}, () => fallback)).not.toBe(fallback);
  });
});

describe('Blink engine: static C (musl)', () => {
  it('runs via ./prog with args, env, files, stdin and stderr', async () => {
    const { fs, shell } = await setup(readFileSync(join(FIX, 'hello-musl')));
    const r = await run(shell, 'echo "piped line" | FIXTURE_VAR=yes ./prog a "b c"');
    expect(r.output).toContain('hello from c');
    expect(r.output).toContain('arg1=a');
    expect(r.output).toContain('arg2=b c');
    expect(r.output).toContain('env=yes');
    expect(r.output).toContain('read=hi from shiro');
    expect(r.output).toContain('stdin=piped line');
    expect(r.exitCode).toBe(0);
    expect(await fs.readFile('/home/user/work/out-c.txt', 'utf8')).toBe('written by c\n');
  }, 60_000);

  it('returns the exit status', async () => {
    const { shell } = await setup(readFileSync(join(FIX, 'hello-musl')));
    const r = await run(shell, './prog fail < /dev/null; echo "status=$?"');
    expect(r.output).toContain('status=7');
  }, 60_000);

  // The shell's executeScript path (a builtin Debian's program shadows): the
  // guest's stdout/stderr are OutputSinks, whose writes Blink's direct
  // channels (patch 0065, opt-in) serve synchronously, not through write()
  it('runElf delivers stdout and stderr to the callbacks', async () => {
    const { fs, shell } = await setup(readFileSync(join(FIX, 'hello-musl')));
    const { runElf } = await import('@shiro/x86-engine');
    let out = '', err = '';
    const code = await runElf('/home/user/work/prog', ['a'], {
      fs, cwd: '/home/user/work', args: ['a'], env: { ...shell.env, TABCOMPUTER_BLINK_DIRECT: '1' }, shell, stdin: 'in\n',
      writeStdout: (s: string) => { out += s; }, writeStderr: (s: string) => { err += s; },
    });
    expect(code).toBe(0);
    expect(out).toContain('hello from c\narg1=a\n');
    expect(out).toContain('stdin=in\n');
    expect(err).toBe('to stderr\n');
  }, 60_000);
});

describe.skipIf(!haveGlibc)('Blink engine: static C (glibc)', () => {
  it('runs a static glibc binary', async () => {
    const { shell } = await setup(readFileSync(glibcBin));
    const r = await run(shell, 'echo x | ./prog q');
    expect(r.output).toContain('hello from c');
    expect(r.output).toContain('arg1=q');
    expect(r.exitCode).toBe(0);
  }, 60_000);
});

// The wasm JIT (vendor/blink patch 0012) against the interpreter (BLINK_WJIT=0).
describe.skipIf(!haveJit || !haveFuzz)('Blink engine: wasm JIT', () => {
  it('computes the same results and flags as the interpreter', async () => {
    const { shell } = await setup(readFileSync(fuzzBin));
    const jit = await run(shell, './prog 3000');
    const interp = await run(shell, 'BLINK_WJIT=0 ./prog 3000');
    expect(jit.exitCode).toBe(0);
    expect(interp.exitCode).toBe(0);
    expect(jit.output.split('\n').length).toBeGreaterThan(100);
    expect(jit.output).toBe(interp.output);
  }, 120_000);

  it('sees code rewritten after mprotect, in RWX pages and after munmap', async () => {
    const { shell } = await setup(readFileSync(jitBin));
    const r = await run(shell, './prog smc');
    expect(r.output).toContain('smc 100350000 200350000 300350000 400350000 500350000');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  it('runs signal handlers while a compiled loop spins', async () => {
    const { shell } = await setup(readFileSync(jitBin));
    const r = await run(shell, './prog signal');
    expect(r.output).toContain('signal ticks=5 spun=yes');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  it('resumes a compiled loop after a SIGSEGV handler fixes the page', async () => {
    const { shell } = await setup(readFileSync(jitBin));
    const r = await run(shell, './prog fault; BLINK_WJIT=0 ./prog fault');
    const lines = r.output.trim().split(/\r?\n/);
    expect(lines[0]).toMatch(/^fault faults=3 sum=\d+$/);
    expect(lines[1]).toBe(lines[0]);
  }, 60_000);

  it('runs compiled code on four threads', async () => {
    const { shell } = await setup(readFileSync(jitBin));
    const r = await run(shell, './prog threads');
    expect(r.output).toContain('threads counter=800000 plain=300000,300000,300000,300000 locked=784');
    expect(r.exitCode).toBe(0);
  }, 60_000);
});

// fork() makes a copy of the guest in a new Blink (patch 0014); it used to
// run the child on the parent's thread with vfork semantics.
describe.skipIf(!haveFork)('Blink engine: fork', () => {
  it('gives the child its own memory; a child that never execs exits with its status', async () => {
    const { shell } = await setup(readFileSync(forkBin));
    const r = await run(shell, './prog copy');
    expect(r.output).toContain('child sees 100 c child');
    expect(r.output).toContain('parent sees 1 p parent status 7');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  it('pipe + fork + dup2 + exec in the child (perl open STDOUT ">&W"; exec)', async () => {
    const { shell } = await setup(readFileSync(forkBin));
    const r = await run(shell, './prog pipe');
    expect(r.output).toContain('pipe got: from-exec');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  it('a fork child forks again', async () => {
    const { shell } = await setup(readFileSync(forkBin));
    const r = await run(shell, './prog nested');
    expect(r.output).toContain('nested status 44 counter 1');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  // LTP keeps its results and checkpoint futexes in MAP_SHARED pages
  it.skipIf(!haveForkShared)('MAP_SHARED memory stays shared with the child; unmapped, fork copies again', async () => {
    const { shell } = await setup(readFileSync(forkSharedBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('anon shared 42\nfile shared 7\nprivate after unmap 100\n');
    expect(r.exitCode).toBe(0);
  }, 60_000);
});

// Same-instance fork (patch 0031, the default since 0048; =1 spelled out
// here, =0 the opt-out): the child is a System in the parent's Blink
// instance, sharing MAP_SHARED pages and running alongside
describe.skipIf(!haveFork || !haveForkShared || !haveShfutex || !haveOrphan || !haveAlarmfork)('Blink engine: same-instance fork', () => {
  const sif = 'BLINK_SAME_INSTANCE_FORK=1 ./prog';
  const old = 'BLINK_SAME_INSTANCE_FORK=0 ./prog';  // the opt-out: a worker per child
  it('copies private memory; pipes, exec and nested forks work', async () => {
    const { shell } = await setup(readFileSync(forkBin));
    expect((await run(shell, `${sif} copy`)).output).toContain('parent sees 1 p parent status 7');
    expect((await run(shell, `${sif} pipe`)).output).toContain('pipe got: from-exec');
    expect((await run(shell, `${sif} nested`)).output).toContain('nested status 44 counter 1');
  }, 60_000);

  it('shares MAP_SHARED memory and its futexes with a child running alongside', async () => {
    const { shell } = await setup(readFileSync(forkSharedBin));
    expect((await run(shell, sif)).output.replace(/\r\n/g, '\n')).toBe('anon shared 42\nfile shared 7\nprivate after unmap 100\n');
    const f = await setup(readFileSync(shfutexBin));
    expect((await run(f.shell, sif)).output).toContain('futex across fork: child wrote 2, exit 3');
  }, 60_000);

  it('kills children, and a child outlives its parent', async () => {
    const { shell } = await setup(readFileSync(orphanBin));
    expect((await run(shell, sif)).output.replace(/\r\n/g, '\n')).toBe(
      'killed spinning child: signaled=1 sig=9\nSIGTERM to pausing child: signaled=1 sig=15\n');
    await run(shell, 'rm -f /tmp/orphan.out');
    await run(shell, `${sif} x`);
    await run(shell, 'sleep 1');
    expect((await run(shell, 'cat /tmp/orphan.out')).output).toContain('child outlived parent');
  }, 60_000);

  it.skipIf(!haveMtchild)("ends a child's other threads with it", async () => {
    const { shell } = await setup(readFileSync(mtchildBin));
    expect((await run(shell, sif)).output.replace(/\r\n/g, '\n')).toBe(
      'round 0: child exit 10, its threads stopped 1\nround 1: child exit 11, its threads stopped 1\n');
  }, 60_000);

  it('keeps alarms per process (here and with the opt-out fork)', async () => {
    const { shell } = await setup(readFileSync(alarmforkBin));
    const want = "first alarm 0, child ok 1, parent's alarm still set 1";
    expect((await run(shell, sif)).output).toContain(want);
    expect((await run(shell, old)).output).toContain(want);
  }, 60_000);

  // LTP futex_wait07
  it.skipIf(!haveFutexintr)('a caught signal interrupts a futex wait (here and with the opt-out fork)', async () => {
    const { shell } = await setup(readFileSync(futexintrBin));
    const want = 'main tid is pid 1\nalarm: Interrupted system call\nchild tid is pid 1\nchild state S\nkill: Interrupted system call\nchild exit 0\n';
    expect((await run(shell, sif)).output.replace(/\r\n/g, '\n')).toBe(want);
    expect((await run(shell, `${sif} nested`)).output.replace(/\r\n/g, '\n')).toBe(want);
    // the opt-out fork runs a child sharing memory on the parent's thread:
    // the parent can't signal it before it's done
    const r = (await run(shell, old)).output.replace(/\r\n/g, '\n');
    expect(r).toMatch(/^main tid is pid 1\nalarm: Interrupted system call\nchild tid is pid 1\n/);
    expect(r).toContain('child exit 0\n');
  }, 60_000);
});

describe.skipIf(!haveGo)('Blink engine: static Go', () => {
  it('runs a Go binary with goroutines, file I/O and args', async () => {
    const { fs, shell } = await setup(readFileSync(goBin));
    const r = await run(shell, './prog one two');
    expect(r.output).toContain('hello from go');
    expect(r.output).toContain('args: [one two]');
    expect(r.output).toContain('read=hi from shiro');
    expect(r.output).toContain('goroutines=344015.127');
    expect(r.exitCode).toBe(0);
    expect(await fs.readFile('/home/user/work/out-go.txt', 'utf8')).toBe('written by go\n');
  }, 120_000);

  it('returns os.Exit status', async () => {
    const { shell } = await setup(readFileSync(goBin));
    const r = await run(shell, './prog fail; echo "status=$?"');
    expect(r.output).toContain('status=5');
  }, 120_000);
});

describe.skipIf(!haveHttp)('Blink engine: Go net/http over loopback', () => {
  it('serves and fetches 4 concurrent requests in one process', async () => {
    const { shell } = await setup(readFileSync(httpBin));
    const r = await run(shell, './prog');
    for (let i = 0; i < 4; i++) expect(r.output).toContain(`pong /${i}`);
    expect(r.exitCode).toBe(0);
  }, 120_000);
});

describe('Blink engine: kernel processes', () => {
  it('kernel.spawn() runs an ELF through the Blink loader', async () => {
    // Browsers refuse to decode views of a SharedArrayBuffer (Node doesn't);
    // make the page side behave like a browser here.
    const decode = TextDecoder.prototype.decode;
    TextDecoder.prototype.decode = function (input?: any, opts?: any) {
      if (input && input.buffer instanceof SharedArrayBuffer) throw new TypeError('The provided ArrayBufferView value must not be shared.');
      return decode.call(this, input, opts);
    };
    onTestFinished(() => { TextDecoder.prototype.decode = decode; });
    const { fs } = await setup(readFileSync(join(FIX, 'hello-musl')));
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { BufferFile } = await import('@shiro/kernel/fd');
    const { registerBlinkLoader } = await import('@shiro/x86-engine/blink');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    registerBlinkLoader(kernel);
    const out = new BufferFile(null);
    const p = kernel.spawn({ path: './prog', argv: ['prog', 'k'], cwd: '/home/user/work', fds: { 0: new BufferFile('from kernel\n'), 1: out, 2: out } });
    const status = await p.wait();
    expect(status).toBe(0);
    expect(out.text()).toContain('arg1=k');
    expect(out.text()).toContain('stdin=from kernel');
  }, 60_000);

  it('blocks on a pipe for stdin until input arrives', async () => {
    const { fs } = await setup(readFileSync(join(FIX, 'hello-musl')));
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { BufferFile } = await import('@shiro/kernel/fd');
    const { createPipe } = await import('@shiro/kernel/pipe');
    const { blinkRunner } = await import('@shiro/x86-engine/blink');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const [r, w] = createPipe();
    const out = new BufferFile(null);
    const p = kernel.spawn({ path: '/home/user/work/prog', argv: ['prog'], cwd: '/home/user/work', fds: { 0: r, 1: out, 2: out }, run: blinkRunner('/home/user/work/prog') });
    await new Promise((res) => setTimeout(res, 1500));
    expect(p.exitStatus).toBeUndefined();          // still waiting on stdin
    await w.write(new TextEncoder().encode('late line\n'));
    await w.close();
    expect(await p.wait()).toBe(0);
    expect(out.text()).toContain('stdin=late line');
  }, 60_000);
});

describe.skipIf(!haveTcp)('Blink engine: real TCP through the kernel relay', () => {
  let harness: ChildProcess;
  let ports: { echoPort: number; relayA: number; origin: string };
  let restore: () => void = () => {};
  let doh: Server;

  beforeAll(async () => {
    const path = new URL('./fixtures/tcp-relay-harness.mjs', import.meta.url).pathname;
    harness = spawn('node', [path], { stdio: ['pipe', 'pipe', 'inherit'] });
    ports = await new Promise((resolve, reject) => {
      let buf = '';
      harness.stdout!.on('data', (d) => {
        buf += d;
        const line = buf.split('\n').find((l) => l.startsWith('{'));
        if (line) resolve(JSON.parse(line));
      });
      harness.once('exit', (c) => reject(new Error(`harness exited ${c}`)));
    });
    // Point the kernel's network stack at relay A (which may dial 127.0.0.1),
    // talking like a page on the allowed origin.
    const { netStack } = await import('@shiro/kernel/net');
    const origin = ports.origin;
    class OriginWebSocket extends WebSocket {
      constructor(url: string | URL) { super(url, { headers: { origin } } as any); }
    }
    // A DNS-over-HTTPS endpoint that answers A queries for echo.test.
    // node:http is polyfilled for the browser build in this config; use Node's.
    const { createServer } = (process as any).getBuiltinModule('http') as typeof import('node:http');
    doh = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (d) => parts.push(d));
      req.on('end', () => {
        const q = Buffer.concat(parts);
        let off = 12;
        while (q[off]) off += q[off] + 1;
        const qtype = q.readUInt16BE(off + 1);
        const question = q.subarray(12, off + 5);
        const name = q.subarray(12, off).toString('latin1');
        const hit = qtype === 1 && /echo.test$/.test(name.replace(/[\x00-\x1f]/g, '.'));
        const head = Buffer.from([q[0], q[1], 0x81, hit ? 0x80 : 0x83, 0, 1, 0, hit ? 1 : 0, 0, 0, 0, 0]);
        const answer = hit ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1]) : Buffer.alloc(0);
        res.writeHead(200, { 'content-type': 'application/dns-message' });
        res.end(Buffer.concat([head, question, answer]));
      });
    });
    const dohPort = await new Promise<number>((r) => doh.listen(0, '127.0.0.1', () => r((doh.address() as any).port)));
    const saved = { ...(netStack as any).config };
    netStack.configure({
      relayUrl: `ws://127.0.0.1:${ports.relayA}/tcp`,
      tokenUrl: `http://127.0.0.1:${ports.relayA}/tcp/token`,
      fetch: ((u: any, init: any = {}) => fetch(u, { ...init, headers: { ...(init.headers || {}), origin } })) as typeof fetch,
      WebSocket: OriginWebSocket as unknown as typeof WebSocket,
      relayLoopback: true,
      portHost: null,
      dohUrl: `http://127.0.0.1:${dohPort}/dns-query`,
    });
    restore = () => netStack.configure(saved);
  }, 30_000);

  afterAll(() => { restore(); harness?.kill(); doh?.close(); });

  it('a Go client reaches a TCP server outside the page', async () => {
    const { shell } = await setup(readFileSync(tcpBin));
    const r = await run(shell, `./prog 127.0.0.1:${ports.echoPort}`);
    expect(r.output).toContain('echo: ping from go');
    expect(r.output).toContain(`remote 127.0.0.1:${ports.echoPort}`);
    expect(r.exitCode).toBe(0);
  }, 120_000);

  // glibc's resolver sends its A and AAAA queries with sendmmsg (pip, apt)
  it.skipIf(!haveMmsg)('sendmmsg/recvmmsg on a kernel UDP socket (DNS over DoH)', async () => {
    const { shell } = await setup(readFileSync(mmsgBin));
    const r = await run(shell, './prog');
    const out = r.output.replace(/\r\n/g, '\n');
    expect(out).toContain('sendmmsg=2 lens 27 27');
    expect(out).toContain('answer 0x11 rcode 0 answers 1 len>12 1');
    expect(out).toContain('answer 0x22 rcode 3 answers 0 len>12 1');
    expect(out).toContain('got 2 ids 3');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  it('resolves a name over UDP 53 (kernel DoH) and dials it', async () => {
    const { shell } = await setup(readFileSync(tcpBin));
    const r = await run(shell, `./prog echo.test:${ports.echoPort}`);
    expect(r.output).toContain('echo: ping from go');
    expect(r.exitCode).toBe(0);
  }, 120_000);
});


// A glibc program before `debian install`: no /lib64/ld-linux-x86-64.so.2.
// Linux's execve fails with ENOENT and bash says "required file not found";
// here the shell adds how to get glibc, instead of a silent 127.
describe.skipIf(!haveDyn || !haveExecerr)('Blink engine: dynamic executable without its loader', () => {
  it('the shell prints bash\'s message and a hint, exit 127', async () => {
    const { shell } = await setup(readFileSync(dynBin));
    const r = await run(shell, './prog');
    expect(r.output).toContain('tabcomputer: ./prog: cannot execute: required file not found');
    expect(r.output).toContain('(this program needs glibc: run `debian install`)');
    expect(r.exitCode).toBe(127);
  });

  it('execve fails with ENOENT', async () => {
    const { fs, shell } = await setup(readFileSync(execerrBin));
    await fs.writeFile('/home/user/work/dyn', readFileSync(dynBin), { mode: 0o755 });
    const r = await run(shell, './prog ./dyn');
    expect(r.output).toContain('execv: errno 2 (ENOENT)');
    expect(r.exitCode).toBe(1);
  }, 60_000);
});

// cmd/go's build loop: parallel children that exit close together, each
// waited for by os/exec in its own goroutine. Under load a SIGURG (Go's
// preemption signal) for the forking thread can arrive while Blink runs the
// vfork child on it; the child then dies with "signal received during fork"
// and the parent hangs with its other children unreaped (toolchains' `go run`
// hang). BLINK_FORK_STRESS=1 runs the stress (about half its runs hit it).
describe.skipIf(!haveGowait)('Blink engine: parallel fork/exec/wait (Go os/exec)', () => {
  const runGowait = async (args: string, ms: number) => {
    const { shell } = await setup(readFileSync(gowaitBin));
    let out = '';
    const r = await Promise.race([
      shell.execute(`./prog ${args}`, (s) => { out += s; }, (s) => { out += s; }),
      new Promise((res) => setTimeout(() => res('timeout'), ms)),
    ]);
    return { r, out: out.replace(/\r\n/g, '\n') };
  };
  it('rounds of 4 children, every exit status collected', async () => {
    const { r, out } = await runGowait('4 4', 60_000);
    expect(out).toBe('done 4 4\n');
    expect(r).toBe(0);
  }, 90_000);
  it.skipIf(!process.env.BLINK_FORK_STRESS)('stress: 60 rounds of 8', async () => {
    const { r, out } = await runGowait('60 8', 200_000);
    expect(out).not.toContain('signal received during fork');
    expect(out).toBe('done 60 8\n');
    expect(r).toBe(0);
  }, 240_000);
});

describe.skipIf(!haveTty)('Blink engine: interactive program on a kernel pty', () => {
  it('sees a tty, its size, raw keys without echo, SIGWINCH and Ctrl-C', async () => {
    const { fs } = await setup(readFileSync(ttyBin));
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { TtySession, attachKernelTty } = await import('@shiro/kernel/pty');
    const { JobControl } = await import('@shiro/kernel/signals');
    const { blinkRunner } = await import('@shiro/x86-engine/blink');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const jc = new JobControl();
    attachKernelTty(kernel, jc);
    const tty = new TtySession({ jc });
    let screen = '';
    tty.pty.onOutput((b: Uint8Array) => { screen += new TextDecoder().decode(b); });
    tty.resize(33, 101);
    const until = async (re: RegExp, ms = 30_000) => {
      const t0 = Date.now();
      while (!re.test(screen)) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${re}; screen: ${JSON.stringify(screen)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const p = tty.spawnJob(kernel, { path: '/home/user/work/prog', argv: ['prog'], cwd: '/home/user/work', run: blinkRunner('/home/user/work/prog') });
    const done = tty.foreground({ pgid: p.pgid });
    await until(/raw: press a key/);
    expect(screen).toContain('tty rows=33 cols=101');
    tty.pty.input('x');
    await until(/key='x'/);
    expect(screen).not.toMatch(/key\r?\nx|^x/m);       // raw mode: no echo
    await until(/waiting for signals/);
    tty.resize(40, 120);
    await until(/got window changed/);
    tty.pty.input('\x03');
    await until(/got interrupt/);
    expect(await done).toEqual({ type: 'exited', status: 0 });
  }, 120_000);

  // Bun's and libuv's input loop (native Claude Code): raw, O_NONBLOCK stdin
  // waited on with epoll, SIGWINCH through a self-pipe
  it.skipIf(!haveRawepoll).each(['', 'threads', 'offmain', 'reopen'])('raw non-blocking epoll reads of the tty see keys; a resize wakes it with the new size (%s)', async (mode) => {
    const { fs } = await setup(readFileSync(rawepollBin));
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { TtySession, attachKernelTty } = await import('@shiro/kernel/pty');
    const { JobControl } = await import('@shiro/kernel/signals');
    const { blinkRunner } = await import('@shiro/x86-engine/blink');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const jc = new JobControl();
    attachKernelTty(kernel, jc);
    const tty = new TtySession({ jc });
    let screen = '';
    tty.pty.onOutput((b: Uint8Array) => { screen += new TextDecoder().decode(b); });
    tty.resize(30, 90);
    const until = async (re: RegExp, ms = 30_000) => {
      const t0 = Date.now();
      while (!re.test(screen)) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${re}; screen: ${JSON.stringify(screen)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const p = tty.spawnJob(kernel, { path: '/home/user/work/prog', argv: mode ? ['prog', mode] : ['prog'], cwd: '/home/user/work', run: blinkRunner('/home/user/work/prog') });
    const done = tty.foreground({ pgid: p.pgid });
    await until(/ready/);
    expect(screen).toContain('size 30x90');
    await new Promise((r) => setTimeout(r, 200)); // blocked in epoll_wait
    tty.pty.input('a');
    await until(/key 97/);
    await new Promise((r) => setTimeout(r, 200));
    tty.pty.input('bc');
    await until(/key 99/);
    tty.resize(41, 132);
    await until(/winch 41x132/);
    tty.pty.input('q');
    await until(/bye/);
    expect(await done).toEqual({ type: 'exited', status: 0 });
  }, 120_000);

  // `go run srv.go` with stdout on the terminal (toolchains bench): cmd/go
  // runs the binary as a child sharing the tty; the child's net/http uses
  // epoll on loopback sockets. With the terminal's description left
  // non-blocking, Go's runtime puts stdout in its edge-triggered netpoller too.
  it.skipIf(!haveGorun).each(['', 'nonblock'])('a go-run-like parent, its net/http child writing to the shared tty (%s)', async (mode) => {
    const { fs } = await setup(readFileSync(gorunBin));
    await fs.writeFile('/home/user/work/nethttp', readFileSync(httpBin), { mode: 0o755 });
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { TtySession, attachKernelTty } = await import('@shiro/kernel/pty');
    const { JobControl } = await import('@shiro/kernel/signals');
    const { blinkRunner } = await import('@shiro/x86-engine/blink');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const jc = new JobControl();
    attachKernelTty(kernel, jc);
    const tty = new TtySession({ jc });
    let screen = '';
    tty.pty.onOutput((b: Uint8Array) => { screen += new TextDecoder().decode(b); });
    const p = tty.spawnJob(kernel, {
      path: '/home/user/work/prog', argv: ['prog', '/home/user/work/nethttp'], cwd: '/tmp',
      env: mode ? { GORUN_NONBLOCK: '1' } : {}, run: blinkRunner('/home/user/work/prog'),
    });
    expect(await tty.foreground({ pgid: p.pgid })).toEqual({ type: 'exited', status: 0 });
    expect(screen).toBe('pong /0\r\npong /1\r\npong /2\r\npong /3\r\n');
  }, 120_000);

  it('Ctrl-C ends a C program blocked reading the tty (no handler)', async () => {
    const { fs } = await setup(readFileSync(join(FIX, 'hello-musl')));
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { TtySession, attachKernelTty } = await import('@shiro/kernel/pty');
    const { JobControl } = await import('@shiro/kernel/signals');
    const { shellExitCode } = await import('@shiro/kernel/abi');
    const { blinkRunner } = await import('@shiro/x86-engine/blink');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const jc = new JobControl();
    attachKernelTty(kernel, jc);
    const tty = new TtySession({ jc });
    let screen = '';
    tty.pty.onOutput((b: Uint8Array) => { screen += new TextDecoder().decode(b); });
    const p = tty.spawnJob(kernel, { path: '/home/user/work/prog', argv: ['prog'], cwd: '/home/user/work', run: blinkRunner('/home/user/work/prog') });
    const done = tty.foreground({ pgid: p.pgid });
    const t0 = Date.now();
    while (!/read=/.test(screen) && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 300)); // now blocked in fgets(stdin)
    tty.pty.input('\x03');
    const r = await done;
    expect(r.type).toBe('exited');
    expect(shellExitCode((r as any).status)).toBe(130);
  }, 120_000);
});

// Blink patch 0011: the guest's fds and processes are the kernel's.
// PostgreSQL 17's latch: blocked SIGUSR1 and SIGURG (ignored by default) read from a signalfd
it.skipIf(!haveSignalfd)('signalfd reads blocked signals; poll sees it readable', async () => {
  const { shell } = await setup(readFileSync(signalfdBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe('empty 1 poll 1 read 256 signo 10 23 pid-ok 1 again-empty 1\n');
}, 60_000);

// LTP getrlimit02, writev01, fcntl30/37, epoll_wait03, waitid02, clock_gettime04, uname04, vfork02, fcntl14/15
it.skipIf(!haveLtpErrnos)('errnos Linux gives; record locks, pipe sizes and RLIMIT_NOFILE are the kernel\'s', async () => {
  const { shell } = await setup(readFileSync(ltpErrnosBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toContain('rlimit-bad 1 nofile 1024/1048576 writev-len 1 pipe-sz 1 read-ro 1 waitid-opts 1 clocks 1 uname26 1 1 pending 1 locks 3\n');
}, 60_000);

// Open POSIX sigaction_4-*: a child's raise(SIGKILL), plain or from a handler whose mask names SIGKILL
it.skipIf(!haveRaiseKill)('raise(SIGKILL) ends the child and its parent\'s wait returns', async () => {
  const { shell } = await setup(readFileSync(raiseKillBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe('-1:11 0:11 1:11 \n');
}, 60_000);

// Open POSIX aio_*, sigqueue: an AIO write completes (not ENOSYS), sigqueue delivers, signal 0 probes
it.skipIf(!haveAioSigqueue)('POSIX AIO completes and sigqueue delivers', async () => {
  const { shell } = await setup(readFileSync(aioSigqueueBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe('aio 0 9 sigqueue 0 1 probe 0\n');
}, 60_000);

// Open POSIX mq_*: priority order, a full queue, a receive blocked across processes, unlink
it.skipIf(!haveMqueue)('POSIX message queues', async () => {
  const { shell } = await setup(readFileSync(mqueueBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe('full 1 first high/7 second low/1 blocked 1 unlink 1\n');
}, 60_000);

// Open POSIX timer_*, sigtimedwait, sched_* (as an unprivileged process)
it.skipIf(!haveTimers)('POSIX timers signal into sigtimedwait; sched_* answers as Linux\'s', async () => {
  const { shell } = await setup(readFileSync(timersBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe('timer 1 overruns 1 timeout 1 sched 1 1 1 1\n');
}, 60_000);

it.skipIf(!haveSigmodes)('raise of a blocked real-time signal queues each instance; SIGKILL/SIGSTOP stay unblocked; sigaltstack modes (Open POSIX)', async () => {
  const { shell } = await setup(readFileSync(sigmodesBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe('rt 1 1 pending 1 signo 1 third -1 EAGAIN\nmask 0 kill 0 stop 0 usr1 1\nboth -1 EINVAL\ndisable 0 sp 1 size 0 flags 2\n');
}, 60_000);

it.skipIf(!haveSharedmaps)('MAP_SHARED /dev/shm mappings: write-only pages, a second mapping and a child\'s exit see the bytes (Open POSIX shm_open)', async () => {
  const { shell } = await setup(readFileSync(sharedmapsBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe('second qwerty\nchild from child\n');
}, 60_000);

it.skipIf(!haveBigshared)('a 6 MiB file mapped MAP_SHARED, written through the mapping and pwrite, reads back whole after munmap', async () => {
  const { fs, shell } = await setup(readFileSync(bigsharedBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe(
    'big.bin size 6291456 read 6291456 pread-sees-map 1 bad 0 first -1\n');
  // And in the FileSystem, stored as blocks
  await fs.sync();
  const back = await fs.readFile('/home/user/work/big.bin') as Uint8Array;
  expect(back.length).toBe(6 << 20);
  expect([back[0], back[4096 * 5], back[(3 << 20) + 200], back[(6 << 20) - 1], back[1]]).toEqual([0, 5, 80, 69, 0]);
  expect(fs.blobOf('/home/user/work/big.bin')).toBeTruthy();
}, 120_000);

it.skipIf(!haveMemerrs)('mlock, munlock, mlockall and mmap refuse bad arguments with Linux\'s errors (Open POSIX)', async () => {
  const { shell } = await setup(readFileSync(memerrsBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe('mlock far ENOMEM mine ok\nmunlock far ENOMEM mine ok\nmlockall 0 EINVAL onfault EINVAL current ok\nmmap flags ~0 EINVAL pipe ENODEV huge ENOMEM\n');
}, 60_000);

it.skipIf(!haveCancel)('pthread_cancel, deferred and asynchronous, runs the cleanup handlers; a thread\'s tkill is SI_TKILL from this process (Open POSIX)', async () => {
  const { shell } = await setup(readFileSync(cancelBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe('deferred cleaned 1 canceled 1\nasync cleaned 11 canceled 1\ntkill code -6 self 1 frame 1\n');
}, 60_000);

it.skipIf(!haveCpuclockids)('CPU clock ids: the process\'s and the thread\'s read; one naming no process is EINVAL (Open POSIX)', async () => {
  const { shell } = await setup(readFileSync(cpuclockidsBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe('process ok self ok thread ok\nbogus EINVAL EINVAL EINVAL\n');
}, 60_000);

it.skipIf(!haveTkill0)('pthread_kill(self, 0) and tgkill/tkill of signal 0 probe the thread (Open POSIX pthread_kill_2-1)', async () => {
  const { shell } = await setup(readFileSync(tkill0Bin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe('pthread_kill 0 tgkill 0 tkill 0\n');
}, 60_000);

it.skipIf(!haveSchedperm)('sched_setparam of another user\'s process (init) is EPERM; reading it is allowed (Open POSIX sched_setparam_26-1)', async () => {
  const { shell } = await setup(readFileSync(schedpermBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe('get ok getscheduler ok set EPERM setscheduler EPERM self ok\n');
}, 60_000);

it.skipIf(!haveItimers)('ITIMER_VIRTUAL and ITIMER_PROF are per process: a fork child has none (Open POSIX fork_13-1)', async () => {
  const { shell } = await setup(readFileSync(itimersBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe('set 0 0 parent armed 1\nchild virtual 0 prof 0\n');
}, 60_000);

it.skipIf(!haveOthercpuclock)('clock_getcpuclockid of another existing process (init) reads; of no process is ESRCH (Open POSIX clock_getcpuclockid_1-2)', async () => {
  const { shell } = await setup(readFileSync(othercpuclockBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe('init 0 read 0 none No such process\n');
}, 60_000);

it.skipIf(!haveThreadintr)('pthread_kill of a thread blocked in read, mq_timedsend or nanosleep ends the call with EINTR; a process signal the main thread blocks reaches one that does not (Open POSIX mq_timedsend_12-1, pthread_kill_8-1)', async () => {
  const { shell } = await setup(readFileSync(threadintrBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe('read EINTR handled 1\nmq_timedsend EINTR handled 1\nnanosleep EINTR handled 1\nprocess signal blocked by main reached a thread\n');
}, 60_000);

it.skipIf(!haveSigbus)('a page of a shared file mapping past the end of a file or /dev/shm object is SIGBUS (SIGSEGV if PROT_NONE), until the file grows over it; writes within the file go back (Open POSIX mmap_11-2, mmap_11-3, mmap_6-3)', async () => {
  const { shell } = await setup(readFileSync(sigbusBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe(
    'PROT_NONE SIGSEGV\nfile SIGBUS code 2 at page 1\nfile SIGBUS on read\nfile grown: 0 122\nfile wrote back a\n' +
    'shm SIGBUS code 2 at page 1\nshm SIGBUS on read\nshm grown: 0 0\n');
}, 60_000);

it.skipIf(!haveForkcpu)('a fork child\'s and a new thread\'s CPU-time clocks, and the child\'s times(), start at 0 and move; the parent counts reaped children\'s CPU, not their sleep (Open POSIX fork_22-1, fork_8-1)', async () => {
  const { shell } = await setup(readFileSync(forkcpuBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe('parent process 1 thread 1 utime 1\nnew thread 1\nchild process 1 thread 1 utime 1\nchild moves\n' +
    'wait4 1\nchildren utime 1 cutime 1\nsleeping child 1\n');
}, 60_000);

it.skipIf(!haveTimerthread)('a SIGEV_THREAD timer runs its function in another thread with its value at each expiry; a fork child does not inherit it (Open POSIX fork_18-1)', async () => {
  const { shell } = await setup(readFileSync(timerthreadBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe('runs 1 value 42 other thread 1\nchild runs 0\nparent runs 1\n');
}, 60_000);

it.skipIf(!haveMmaptail)('a file mapping whose length ends mid-page shows the file to the end of the page; MAP_FIXED over it shows the new file (Open POSIX mmap_3-1)', async () => {
  const { shell } = await setup(readFileSync(mmaptailBin));
  const r = await run(shell, './prog');
  expect(r.output.replace(/\r\n/g, '\n')).toBe('tail a\nreplaced 1 tail b\n');
}, 60_000);

// Linux keeps argv[0] as the caller gave it; only the binary is found through the symlink
// (busybox picks its applet by it; Debian's redis-server -> redis-check-rdb)
describe('argv[0] through a symlink', () => {
  for (const engine of ['blink', 'x86']) {
    it.skipIf(!haveArgv0)(`is the link's name, not the target's (${engine})`, async () => {
      const { shell } = await setup(readFileSync(argv0Bin));
      const env = engine === 'x86' ? 'TABCOMPUTER_X86_ENGINE=x86 ' : '';
      // (and through a hard link: dpkg links graphviz's libgvc6-config-update to dot, which picks its layout by argv[0])
      const r = await run(shell, `ln -sf prog echo2; mkdir -p bin; ln -sf ../prog bin/redis-server; rm -f dot; ln prog dot; ${env}./echo2; ${env}./prog; PATH=$PWD/bin:$PATH ${env}redis-server; ${env}./dot`);
      expect(r.output.replace(/\r\n/g, '\n')).toBe('argv0=./echo2\nargv0=./prog\nargv0=redis-server\nargv0=./dot\n');
    }, 60_000);
  }
});

describe('Blink engine: kernel processes (fork, exec, pipes)', () => {
  it('fork+exec+wait, posix_spawn over a pipe, popen and system through /bin/sh', async () => {
    const { shell } = await setup(readFileSync(join(FIX, 'proc-musl')));
    const r = await run(shell, './prog');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/child pid=\d+ ppid=\d+ arg=forked/);
    expect(r.output).toContain('fork: pid>0=1 exit=7');
    expect(r.output).toMatch(/spawn read: child pid=\d+ ppid=\d+ arg=spawned\r?\nspawn exit=7/);
    expect(r.output).toContain('popen: HELLO FROM SH');
    expect(r.output).toContain('pclose=0');
    expect(r.output).toContain('system=3');
    expect(r.output).toContain('execfail exit=42');
  }, 60_000);

  it('a writev is one write on a pipe; the guest sees kernel files and /dev/null', async () => {
    const { shell, fs } = await setup(readFileSync(join(FIX, 'proc-musl')));
    expect((await run(shell, './prog child x | od -c | head -3')).output).toContain('a   r   g   =   x  \\n');
    expect((await run(shell, './prog child y > out.txt 2>/dev/null; echo $?')).output.trim()).toBe('7');
    expect(await fs.readFile('/home/user/work/out.txt', 'utf8')).toMatch(/^child pid=\d+ ppid=\d+ arg=y\n$/);
  }, 60_000);
});

// Blink patch 0014: fork() copies the process into a new worker.
describe('Blink engine: fork() without exec', () => {
  it('the child gets a copy of memory and runs alongside the parent', async () => {
    const { shell } = await setup(readFileSync(join(FIX, 'fork-musl')));
    const r = await run(shell, './prog');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/child: pid=\d+ ppid=\d+ counter=101 heap=heap data/);
    expect(r.output).toContain('parent: counter=100 heap=heap data child exit=5');
    expect(r.output).toContain('echo child: HELLO');
  }, 60_000);
});

// Blink patches 0016-0018 (jemalloc, Rust's miniz_oxide and std need them).
describe('Blink engine: CPU and syscall fixes', () => {
  it('pextrw zero-extends, MADV_DONTNEED zeroes, FUTEX_WAIT_BITSET times out, GRND_INSECURE works', async () => {
    const { shell } = await setup(readFileSync(join(FIX, 'cpu-musl')));
    const r = await run(shell, './prog');
    expect(r.exitCode).toBe(0);
    expect(r.output.replace(/\r\n/g, '\n')).toBe('pextrw 0xfffe\nmadvise 0 0 0\nfutex_wait_bitset timedout on time\nfutex_wake_bitset 0\ngetrandom 16\n');
  }, 60_000);

  // apt's DynamicMMap grows its package cache with mremap(MREMAP_MAYMOVE)
  it.skipIf(!haveMremap)('mremap grows (in place or moving), shrinks and moves to a fixed place', async () => {
    const { shell } = await setup(readFileSync(mremapBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'no MAYMOVE: Cannot allocate memory\nmoved=1 first=7 mid=7 last=9\nold range free=1\n' +
      'shrunk same=1 tail free=1 last=7\nfixed at=1 first=7\nreadonly moved=1 byte=42\n');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  // SHIROFS reads and maps big files through pread instead of loading them whole
  it.skipIf(!haveBigfile)('reads, maps and writes a 3 MiB file (pread, SEEK_END, private/shared mmap, sequential read)', async () => {
    const { fs, shell } = await setup(readFileSync(bigfileBin));
    const size = 3 * 1048576 + 77;
    const big = new Uint8Array(size);
    for (let i = 0; i < size; i++) big[i] = (i * 7 + (i >> 12)) & 255;
    await fs.writeFile('/home/user/work/big.bin', big);
    await fs.writeFile('/home/user/work/trunc.bin', new Uint8Array(2_000_000).fill(0x71));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'size 3145805\npread 16 1225\ntail 10 6623\nprivate 2258754268\nshared 238244316\nread 3145805 4238872649\n');
    expect(r.exitCode).toBe(0);
    const after = await fs.readFile('/home/user/work/big.bin') as Uint8Array;
    expect(after.length).toBe(size);
    expect(new TextDecoder().decode(after.subarray(size - 4))).toBe('WXYZ');
    expect(Buffer.compare(after.subarray(0, size - 4), big.subarray(0, size - 4))).toBe(0);
    expect((await fs.readFile('/home/user/work/trunc.bin') as Uint8Array).length).toBe(1);
  }, 60_000);

  // LTP futex_wake02, futex_wait_bitset01
  it.skipIf(!haveFutexwake)('FUTEX_WAKE wakes at most count waiters; bitset timeouts end by their own clock', async () => {
    const { shell } = await setup(readFileSync(futexwakeBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'wake(2)=2 woken=2\nwake(1)=1 woken=3\nwake(100)=3 woken=6\nwake(none)=0\n' +
      'monotonic bitset wait=-1 timedout=1 early=0\nrealtime bitset wait=-1 timedout=1 early=0\n');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  // musl's memcpy/memset (rep movsq/stosq) go a page at a time (patch 0041)
  it.skipIf(!haveStrops)('rep movs/stos of every size match native: overlaps, page straddles, DF=1', async () => {
    const { shell } = await setup(readFileSync(stropsBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(NATIVE_STROPS);
  }, 120_000);

  // x86-64-v2: Bun (Claude Code's native build, opencode), GOAMD64=v2 Go
  it.skipIf(!haveSse4)('SSE4.1 and SSE4.2 match native', async () => {
    const { shell } = await setup(readFileSync(sse4Bin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(NATIVE_SSE4);
    expect(r.exitCode).toBe(0);
  }, 120_000);

  it.skipIf(!haveGoV2)('runs Go built for x86-64-v2 (GOAMD64=v2)', async () => {
    const { shell } = await setup(readFileSync(goV2Bin));
    const r = await run(shell, './prog a b');
    expect(r.output).toContain('args: [a b]');
    expect(r.output).toContain('goroutines=344015.127');
    expect(r.exitCode).toBe(0);
  }, 120_000);

  // Rust's leading_zeros (LLVM: mov $127,%r8; bsr %rax,%r8): xAI's grok CLI
  it.skipIf(!haveBitscan)('bsf/bsr with a zero source leave the destination unchanged', async () => {
    const { shell } = await setup(readFileSync(bitscanBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(NATIVE_BITSCAN);
  }, 60_000);

  // V8's builtins (Debian's nodejs crashed on every script): pop 0x88(%rsp)
  it.skipIf(!havePopmem)('pop to memory addressed through rsp uses the popped rsp', async () => {
    const { shell } = await setup(readFileSync(popmemBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'pop 8(%rsp): rsp at s+16, s[1..3] = 0x11 0x22 0x11\npop (%rsp): s[2..3] = 0x55 0x55\npopw 2(%rsp): w[6..7] = 0x1234 0x7777\n');
  }, 60_000);

  it.skipIf(!haveSegv)('SHIRO_BLINK_CRASH=1 reports a fatal signal on stderr', async () => {
    const { shell } = await setup(readFileSync(segvBin));
    const quiet = await run(shell, './prog; echo status=$?');
    expect(quiet.output).not.toContain('blink:');
    expect(quiet.output).toContain('status=139');
    const r = await run(shell, 'SHIRO_BLINK_CRASH=1 ./prog; echo status=$?');
    expect(r.output).toMatch(/blink: pid \d+ tid \d+: SIGSEGV .* fault address 0x8/);
    expect(r.output).toMatch(/blink: rax [0-9a-f]{16}/);
    expect(r.output).toContain('status=139');
  }, 60_000);

  // uSockets' us_create_timer (Bun: opencode)
  it.skipIf(!haveTimerfd)('timerfd: relative, interval and absolute timers, poll and epoll', async () => {
    const { shell } = await setup(readFileSync(timerfdBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('create 1\nunarmed read EAGAIN 1\nsettime 1\ngettime armed 1 interval 1\npoll 1 after>=45ms 1\nread 1 count>=1 1\ninterval count>=3 1\ndisarmed 1\nabs epoll 1 after>=20ms 1 read 1 1\npast expires 1\nbad nsec EINVAL 1\n');
  }, 60_000);

  // LTP's TST_PROCESS_STATE_WAIT(pid, 'S') before signalling a child (pause01, signal01)
  it.skipIf(!haveSleepstate)('a child in pause(), nanosleep or a read shows as sleeping in /proc', async () => {
    const { shell } = await setup(readFileSync(sleepstateBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('pause S\nnanosleep S\nclock_nanosleep S\nread S\n');
  }, 60_000);

  // epoll_wait15/16: children blocked in the kernel held every kernel channel
  it.skipIf(!haveBlockedkids)('more blocked fork children than kernel channels: the parent still runs', async () => {
    const { shell } = await setup(readFileSync(blockedkidsBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('woken 12/12\n');
  }, 60_000);

  // LTP checkpoints (fork04, waitpid13): wake the peer, then wait on the same word
  it.skipIf(!havePingpong)('futex wake-then-wait ping-pong: a wake goes to the waiter, not the waker', async () => {
    const { shell } = await setup(readFileSync(pingpongBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('fork: parent bad 0 child bad 0\nthreads: main bad 0 thread bad 0\n');
  }, 120_000);

  // LTP bind04 (abstract names), nft/getifaddrs (netlink), uv venvs ($ORIGIN), go link (fallocate)
  it.skipIf(!haveSockaddrs)('socket address lengths, /proc/self/exe through a symlink, fallocate', async () => {
    const { shell } = await setup(readFileSync(sockaddrsBin));
    const r = await run(shell, 'ln -s prog link; ./link');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('abstract bound 1 len 110 connect 1\nnetlink len 12 family 16\n' +
      'exe /home/user/work/prog\nfallocate -1 EOPNOTSUPP\n');
  }, 60_000);

  // LTP nanosleep02; exit_group with threads parked in a futex, a sleep and a read (patch 0053)
  it.skipIf(!haveSleepintr)('signals end sleeps with the time left; exit with parked threads', async () => {
    const { shell } = await setup(readFileSync(sleepintrBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('invalid timespec EINVAL 6/6\nnanosleep eintr 1 early 1 rem>3s 1\nclock_nanosleep eintr 1 early 1 rem>3s 1\n' +
      'threads parked: exit 7 within 3s 1\n');
  }, 60_000);

  // Node's os.release() in native Claude Code; glibc's minimum-kernel check
  it.skipIf(!haveUname)("uname has the kernel's release and version, Blink's sysname and machine", async () => {
    const { shell } = await setup(readFileSync(unameBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('sysname Linux machine x86_64 release-6.1 1 version-SMP 1 nodename-in-release 1\n');
  }, 60_000);

  // GHC's runtime (getCurrentThreadCPUTime), Redis 8 (epoll_wait with maxclients + 128)
  it.skipIf(!haveCpuclock)('CPU-time clocks, including getcpuclockid ids; epoll_wait maxevents 10000', async () => {
    const { shell } = await setup(readFileSync(cpuclockBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('process 1 thread 1 getcpuclockid 0 0 pid-clock 1 thread-clock 1\n' +
      'epoll_wait maxevents 10000: 0\n');
  }, 60_000);

  // pam_limits (su, runuser) calls setpriority for every session
  it.skipIf(!haveNice)('getpriority/setpriority keep a nice value per process, inherited on fork', async () => {
    const { shell } = await setup(readFileSync(niceBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('get 0 errno 0 raw 20 set0 0 set5 0 get 5 child 5 lower-as-user EACCES\n');
  }, 60_000);

  // su, runuser, PostgreSQL's initdb (the kernel's set*id; skipped on a kernel without them)
  it.skipIf(!haveIds)('uids and gids are the kernel\'s: real, effective and saved ids, groups', async () => {
    const { shell } = await setup(readFileSync(idsBin));
    const r = await run(shell, './prog; sudo ./prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('user 1: setuid(0) -1 EPERM\n' +
      'root: setgroups 0 getgroups 2 {100,65534} 1\n' +
      'setresgid 0 setresuid 0: uid 65534 euid 65534 saved 0 gid 65534 egid 65534\n' +
      'seteuid(0) via saved 0: euid 0 uid 65534\n' +
      'dropped 0: setuid(0) -1 EPERM\n');
  }, 60_000);

  // cmake hung in epoll_wait: SIGCHLD reached the kernel before the call did
  it.skipIf(!haveSigchld)('a SIGCHLD that races epoll_wait still ends the wait', async () => {
    const { shell } = await setup(readFileSync(sigchldBin));
    const r = await run(shell, 'TABCOMPUTER_BLINK_DIRECT=1 ./prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('rounds 60 timeouts 0\n');
  }, 120_000);

  // HotSpot's sched_getcpu fallback calls the vsyscall page (java -version)
  it.skipIf(!haveGetcpu)('getcpu, the vsyscall page and a family 6 CPUID signature', async () => {
    const { shell } = await setup(readFileSync(getcpuBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('sched_getcpu 0\nvsyscall getcpu 0 cpu 0 node 0\nvsyscall time ok 1\n' +
      'vsyscall gettimeofday 0 ok 1\ncpuid family 6 sse2 1\n');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  // LibreOffice's soffice.bin: Blink took *.bin for a flat binary
  it('an ELF named *.bin runs as an ELF', async () => {
    const { fs, shell } = await setup(readFileSync(join(FIX, 'hello-musl')));
    await fs.writeFile('/home/user/work/prog.bin', readFileSync(join(FIX, 'hello-musl')), { mode: 0o755 });
    const r = await run(shell, './prog.bin x < /dev/null');
    expect(r.output).toContain('hello from c');
    expect(r.output).toContain('arg1=x');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  // PostgreSQL's initdb: a SysV segment shared across fork, shm_nattch, IPC_RMID
  it.skipIf(!haveSysvshm)('System V shared memory across fork, and POSIX shm', async () => {
    const { shell } = await setup(readFileSync(sysvshmBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('shmget ok\nshmat ok\nnattch 1 size 56\n' +
      'child sees "parent" nattch 2\nchild second attach sees "child"\nparent sees "child" nattch 1\n' +
      'shmdt 0\nshmdt again -1 Invalid argument\nrmid 0\nattach after rmid Invalid argument\nposix shm "from child"\n');
  }, 60_000);

  // librsvg's gradients came out transparent: sqrtpd and float -> int conversions
  it.skipIf(!haveSse2d)('SSE2 double ops match native, in the JIT and the interpreter', async () => {
    const { shell } = await setup(readFileSync(sse2dBin));
    for (const cmd of ['./prog', 'BLINK_WJIT=0 ./prog']) {
      const r = await run(shell, cmd);
      expect(r.output.replace(/\r\n/g, '\n')).toBe(NATIVE_SSE2D);
    }
  }, 60_000);

  // LTP waitpid08/10: one of 8 forked children never woke from its checkpoint
  it.skipIf(!haveFutexckpt)('every wake a waker counts reaches a waiter (futex in shared memory, 8 children)', async () => {
    const { shell } = await setup(readFileSync(futexckptBin));
    const r = await run(shell, './prog a 10; ./prog f 10');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('anon: 0 of 10 rounds bad\nfile: 0 of 10 rounds bad\n');
  }, 120_000);

  // Audacity's single-instance lock: System V semaphores (the kernel's, forwarded)
  it.skipIf(!haveSysvsem)('System V semaphores: values, blocking semop, SEM_UNDO at exit, timeouts, IPC_RMID', async () => {
    const { shell } = await setup(readFileSync(sysvsemBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe("semget ok\nsetval 0 getval 1\ngetall 1 0 nsems 2\nnowait while held -1 Resource temporarily unavailable\nblocking semop 0 after child exit 1\nsemtimedop -1 Resource temporarily unavailable waited 1\nrmid 0\nsemop after rmid -1 Invalid argument\n");
  }, 60_000);

  // System V message queues (the kernel's, forwarded)
  it.skipIf(!haveSysvmsg)('System V message queues: typed receive, IPC_NOWAIT, a blocked receiver, IPC_RMID', async () => {
    const { shell } = await setup(readFileSync(sysvmsgBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe("msgget ok\nsend 0 0\nqnum 2\nrcv type 2: 6 2 world\nrcv any: 6 1 hello\nrcv empty nowait: -1 No message of desired type\nchild got 5 7 late\nrmid 0\nsend after rmid -1 Invalid argument\n");
  }, 60_000);

  // Firefox, Mesa, Wayland and PulseAudio make shared memory with memfd_create (0111)
  it.skipIf(!haveMemfd)('memfd_create: read/write, MAP_SHARED, CLOEXEC, /proc/self/fd name', async () => {
    const { shell } = await setup(readFileSync(memfdBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe("write 11 trunc 0 read 11 'hello memfd' map 'hello' cloexec 1 name ok\n");
  }, 60_000);

  // Firefox seals its shared memory (F_SEAL_GROW|F_SEAL_SHRINK): the kernel's
  // memfds keep the seals, Blink passes the fcntl through (0118)
  it.skipIf(!haveMemfdseal)('memfd seals: F_ADD_SEALS/F_GET_SEALS, enforced on truncate and write', async () => {
    const { shell } = await setup(readFileSync(memfdsealBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'seals 0 add 0 seals 6 truncate -1 EPERM grow -1 EPERM overwrite 1 seal 0 again -1 EPERM \n' +
      'plain seals 1 add -1 EPERM pipe -1 EINVAL \n');
  }, 60_000);

  // Open POSIX sigqueue_1-1: a same-instance child's handler gets the queued value (0110)
  it.skipIf(!haveSiginfochild)('a forked child\'s SA_SIGINFO handler gets sigqueue\'s value (standard and real-time)', async () => {
    const { shell } = await setup(readFileSync(siginfochildBin));
    const r = await run(shell, './prog 0; ./prog 1');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('sig 10: child exit 12\nsig 34: child exit 13\n');
  }, 60_000);

  // Blink 0109: fork shares private pages copy-on-write; each side keeps its own view
  it.skipIf(!haveCowfork)('fork copy-on-write: heap, brk, .data, mmap, stack views stay apart; mprotect/madvise/mremap/signals after fork', async () => {
    const { shell } = await setup(readFileSync(cowforkBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('child view y, parent view 1, children 1, after 1, exec 0\n');
  }, 60_000);

  // scalar SSE double ops over NaN/inf/zeros/denormals/limits; comisd/ucomisd clear AF (Blink left it)
  it.skipIf(!haveSsefloat)('scalar SSE double ops on special values: results, comisd/ucomisd flags, conversions as native', async () => {
    const { shell } = await setup(readFileSync(ssefloatBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('arith eed21c69e00391d6 flags 26e847fc95974f53 conv 591355aeff2dce87\narith eed21c69e00391d6 flags 26e847fc95974f53 conv 591355aeff2dce87\narith eed21c69e00391d6 flags 26e847fc95974f53 conv 591355aeff2dce87\n');
  }, 60_000);

  // free() of a buffer another thread is writing to a pipe: munmap waited
  // for the write's page locks holding the GIL the reader needed (0122)
  it.skipIf(!haveFreewhilewrite)('munmap of a buffer another thread is still writing doesn\'t deadlock, JIT on and off', async () => {
    const { shell } = await setup(readFileSync(freewhilewriteBin));
    const r = await run(shell, 'timeout 20 ./prog; echo rc $?; BLINK_WJIT=0 timeout 20 ./prog; echo rc $?');
    const ok = 'writer and reader done: read what was written\nrc 0\n';
    expect(r.output.replace(/\r\n/g, '\n')).toBe(ok + ok);
  }, 90_000);

  // Open POSIX mmap_7-4: the object is unlinked before it's mapped, so its
  // fd's inode is no longer the path's; the fd still reads the mapping
  it.skipIf(!haveShmunlinked)('an unlinked /dev/shm object: a fork child\'s private map and pread see the parent\'s shared store', async () => {
    const { shell } = await setup(readFileSync(shmunlinkedBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe("child private map 'a' pread 'a'\n");
  }, 60_000);

  // a /dev/shm object as remote pages (0112): stores to more pages than a
  // thread keeps leased all land (0121), and a pwrite through the fd is what
  // the mapping sees (the kernel's inode uses the object's buffer)
  it.skipIf(!haveShmremote)('a /dev/shm mapping keeps every store and agrees with pwrite and read, JIT on and off', async () => {
    const { shell } = await setup(readFileSync(shmremoteBin));
    const r = await run(shell, './prog 65536 6291456; BLINK_WJIT=0 ./prog 65536 6291456');
    const ok = '65536: read 65536 map-and-fd-agree 1 bad 0 first -1\n6291456: read 6291456 map-and-fd-agree 1 bad 0 first -1\n';
    expect(r.output.replace(/\r\n/g, '\n')).toBe(ok + ok);
  }, 180_000);

  // apt's pkgcache.bin: a 27 MB writable MAP_SHARED file mapping; msync and
  // munmap write back only this process's changes, so a child's writes
  // through its own mapping stay (0098; a hash per 128 bytes since 0120)
  it.skipIf(!haveSharedmap)('a big writable shared file mapping writes back only what changed', async () => {
    const { shell } = await setup(readFileSync(sharedmapBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe("msync 0 file 'header' child 'child' parent 'P' sum dc7153090c0f509a\n");
  }, 120_000);

  // fesetround's directed modes (MXCSR.RC), as CGAL checks at startup:
  // SSE add/sub/mul/div/sqrt and conversions as native, compiled and not (0119)
  it.skipIf(!haveRounding)('SSE arithmetic follows MXCSR rounding (FE_UPWARD, FE_DOWNWARD, FE_TOWARDZERO) as native', async () => {
    const { shell } = await setup(readFileSync(roundingBin));
    const r = await run(shell, './prog; BLINK_WJIT=0 ./prog');
    const ok =
      'near add 3ff0000000000000 sub 3ff0000000000000 nsub bff0000000000000 mul 3ff0000000000000 div 3fd5555555555555 ndiv bfd5555555555555 sqrt 3ff6a09e667f3bcd cvt 43b0000000000000 fadd 3f800000 fdiv 3eaaaaab fcvt 3eaaaaab rint 2 pd 3fd5555555555555 bfd5555555555555\n' +
      'up add 3ff0000000000001 sub 3ff0000000000000 nsub bff0000000000000 mul 3ff0000000000001 div 3fd5555555555556 ndiv bfd5555555555555 sqrt 3ff6a09e667f3bcd cvt 43b0000000000001 fadd 3f800001 fdiv 3eaaaaab fcvt 3eaaaaab rint 3 pd 3fd5555555555556 bfd5555555555555\n' +
      'down add 3ff0000000000000 sub 3fefffffffffffff nsub bff0000000000001 mul 3fefffffffffffff div 3fd5555555555555 ndiv bfd5555555555556 sqrt 3ff6a09e667f3bcc cvt 43b0000000000000 fadd 3f800000 fdiv 3eaaaaaa fcvt 3eaaaaaa rint 2 pd 3fd5555555555555 bfd5555555555556\n' +
      'zero add 3ff0000000000000 sub 3fefffffffffffff nsub bff0000000000000 mul 3fefffffffffffff div 3fd5555555555555 ndiv bfd5555555555555 sqrt 3ff6a09e667f3bcc cvt 43b0000000000000 fadd 3f800000 fdiv 3eaaaaaa fcvt 3eaaaaaa rint 2 pd 3fd5555555555555 bfd5555555555555\n' +
      'near hash 6287a25af9cb224d\n' +
      'up hash d0ec0b5e73e6adc1\n' +
      'down hash cd2fd56d81e8f50f\n' +
      'zero hash 7706c01324077d65\n';
    expect(r.output.replace(/\r\n/g, '\n')).toBe(ok + ok);
  }, 120_000);

  // compiled rol/ror by constants (SHA-1, hashes): values and flags as native (OF masked where undefined)
  it.skipIf(!haveRotates)('rol/ror by constants in compiled code: values and CF/OF/ZF/SF as native', async () => {
    const { shell } = await setup(readFileSync(rotatesBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('264f883ef48b6082 8b442bf2ddfdc970 14896776f64e11fa a59f6813927c4b87 8f67ccf91bd7d2c7\n28812440d3ea14ea 6374e9275901902a 987e01781fe71d73 52f8b67ac299aa7f\n7e64dbe8e066cf2a 54783cbf17eb4ce7 5dace5e6b81b1638 e2e5855b7ecb3df6\nmem 74cca3ae32bd6133\n');
  }, 60_000);

  // SSE2/SSSE3 integer ops compiled to wasm SIMD (OpenSSL SHA-1, glibc string functions), misaligned movdqa is #GP
  it.skipIf(!haveSsei)('SSE2/SSSE3 integer ops in compiled code (wasm SIMD) match native, aligned forms fault when misaligned', async () => {
    const { shell } = await setup(readFileSync(sseiBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('misaligned faults 200\nmoves 5022a87e047adf0a\n00 7ee345218afcb239\n01 a391afcb2fab11d7\n02 96a4eae743305de5\n03 4f1fdbab20276a60\n04 2dd5c5e6b7d3e4c1\n05 1ea1f24828c932b8\n06 7252ee31cd46eac9\n07 a7d2613e2dbb0e13\n08 a8113f5bdd1f72c3\n09 07148d3151ffb9b6\n10 524e60ed9625a69b\n11 cf7ff38f3eef12f3\n12 7e7f27c94b126a65\n13 cb3818cf16c8e140\n14 cb3818cf16c8e140\n15 8e0e6be8bc8c6a2d\n16 4bcc7f190e24bd97\n17 1203fb1b726bbd12\n18 ab189b3fd9f24c9e\n19 950527b9d4f0dabc\n20 78c257c240f6f10d\n21 cf1ade267c265c1d\n22 c973936bed53b154\n23 aea16f40d5405a05\n24 eaf4afc255a34129\n25 17685060ffef0b34\n26 65d590d7ead5f7cf\n27 fd54d777ca69c642\n28 c00277b74ad06d8a\n29 5641aadecea618a1\n30 e3c2aed0e370a373\n31 2b57dc7aff029b1d\n32 d0aadbb892e4986b\n33 ec7115c07c008552\n34 3cb357330446786f\n35 92d70ae93be3a4a1\n36 0000000000000000\n37 1e890edd978855e7\n38 c7a0d592de6396ef\n39 f6cb7bac6e55409e\n40 0000000000000000\n41 9ce8b41d4b876de3\n42 25b1756106f5daf1\n43 8000000000000000\n44 0000000000000000\n45 e572344fc39ee05a\n46 c598c655170411b1\n47 c01044d0040f6876\n48 0000000000000000\n49 0000000000000000\n50 014a2157c3be93e2\nstrings 52edaac7a097348e\nall 6691258bf5fa7cfc\n');
  }, 60_000);

  // llvmpipe's shader code (LLVM 15): pblendvb, ptest, pinsrd/extractps with memory, cvtsi2ss,
  // movshdup, pminud/pmaxud, every cmpps predicate, unpckhpd (its low half was wrong: 0114), REX registers
  it.skipIf(!haveSse41b)('LLVM\'s SSE4.1 forms (llvmpipe) match native, interpreted and compiled', async () => {
    const { shell } = await setup(readFileSync(sse41bBin));
    const r = await run(shell, './prog; BLINK_WJIT=0 ./prog');
    const native = "pblendvb   40000000 bf800000 c0490fdb 00000000\nblendvps   40000000 bf800000 c0490fdb 00000000\nptest0 zf=1 cf=1 a=0\nptest1 zf=1 cf=1 a=0\nptest2 zf=0 cf=1 a=0\nptest3 zf=0 cf=0 a=1\nptest4 zf=0 cf=1 a=0\nptest5 zf=0 cf=0 a=1\npinsrd     3f800000 00000021 40490fdb 00000042\nextractps  3f000000 c0490fdb 80000000 00000000\ncvtsi2ss   c0e00000 bf800000 40490fdb 00000000\ncvtsi2ssq  51e5f4c9 bf800000 40490fdb 00000000\ncvtsi2ssm  42040000 bf800000 40490fdb 00000000\nmovshdup   bf800000 bf800000 00000000 00000000\nmovshdupm  3f000000 3f000000 80000000 80000000\nmovsldup   40000000 40000000 c0490fdb c0490fdb\npminud     3f800000 3f000000 40490fdb 00000000\npmaxud     40000000 bf800000 c0490fdb 80000000\npminsd     3f800000 bf800000 c0490fdb 80000000\npmulld     00000000 00000000 0be16559 00000000\ncmpps0     00000000 00000000 00000000 ffffffff\ncmpps1     ffffffff ffffffff 00000000 00000000\ncmpps2     ffffffff ffffffff 00000000 ffffffff\ncmpps3     00000000 00000000 00000000 00000000\ncmpps4     ffffffff ffffffff ffffffff 00000000\ncmpps5     00000000 00000000 ffffffff ffffffff\ncmpps6     00000000 00000000 ffffffff 00000000\ncmpps7     ffffffff ffffffff ffffffff ffffffff\ncmpnlepsm  00000000 00000000 ffffffff 00000000\nunpckhpd   40490fdb 00000000 c0490fdb 80000000\nunpcklpd   3f800000 bf800000 40000000 3f000000\npunpckhqdq 40490fdb 00000000 c0490fdb 80000000\npextrd     c0490fdb 80000000 00000000 00000000\ninsertps   00000000 c0490fdb 00000000 00000000\ninsertpsm  3f800000 bf800000 00000016 00000000\npacks      ff000000 2c21160b ff000000 2c21160b\n";
    expect(r.output.replace(/\r\n/g, '\n')).toBe(native + native);
  }, 60_000);

  // compiled float arithmetic (ss/sd/ps/pd), ucomis/comis, movd/movq, leave (0116): special values
  // through loops long enough to compile, against native's hash (NaN results counted as one value)
  it.skipIf(!haveFpjit)('SSE float ops, ucomis/comis, movd/movq and leave in compiled code match native', async () => {
    const { shell } = await setup(readFileSync(fpjitBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('hash 5b92588104fd1863 acc 19814400\n');
  }, 120_000);

  // PostgreSQL's huge_pages=try maps MAP_HUGETLB first and falls back on ENOMEM
  it.skipIf(!haveHugetlb)('MAP_HUGETLB is ENOMEM (no huge pages reserved), an ordinary map works', async () => {
    const { shell } = await setup(readFileSync(hugetlbBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('hugetlb failed 12\nplain mapped\n');
  }, 60_000);

  // Open POSIX sigqueue 4-1..8-1: real-time signals were delivered as SIGINT (1ul << 33 in wasm32)
  it.skipIf(!haveSiginfo)('SA_SIGINFO handlers get sigqueue values, si_code and the sender; queued real-time signals all arrive, in order', async () => {
    const { shell } = await setup(readFileSync(siginfoBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'sigqueue: n 1 value 42 code -1 pid 1\nkill: n 1 code 0 pid 1\nblocked: n 0\n' +
      'unblocked: n 5 values 100 101 102 103 104 codes -1\n');
  }, 60_000);

  // Blender (TBB, OpenEXR) locks PTHREAD_PRIO_INHERIT mutexes: glibc aborted on EINVAL
  it.skipIf(!haveFutexpi)('PI futexes (LOCK_PI, TRYLOCK_PI, UNLOCK_PI, a contended PI mutex, a timed lock) and FUTEX_WAKE_OP', async () => {
    const { shell } = await setup(readFileSync(futexpiBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'WAKE_OP 0 0\nu2 5\nLOCK_PI 0 0\nowner is me 1\nLOCK_PI again -1 35\nUNLOCK_PI 0 0\nword 0\n' +
      'UNLOCK_PI unowned -1 1\nTRYLOCK_PI 0 0\nUNLOCK_PI 0 0\ncounter 8000\ntimedlock 110\n');
  }, 60_000);

  // LTP futex_cmp_requeue01-03: requeued waiters are found at the target at once
  it.skipIf(!haveFutexrequeue)('FUTEX_CMP_REQUEUE and FUTEX_REQUEUE wake some waiters and move the rest', async () => {
    const { shell } = await setup(readFileSync(futexrequeueBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'cmp mismatch -1 1\ncmp_requeue 5 woken 2\nleft on f1 1 woken 3\nrequeue 3 then wake 2 woken 6\n');
  }, 60_000);

  // VLC's main thread sigwaits for SIGINT/HUP/QUIT/TERM and quits when it returns
  it.skipIf(!haveSigwait)('sigwait, sigwaitinfo and sigtimedwait: process and thread signals, timeout, poll', async () => {
    const { shell } = await setup(readFileSync(sigwaitBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'sigwait 0 14 waited 1\npthread_kill 0 15\nsigwaitinfo 10 signo 10 code 0\ntimeout -1 EAGAIN 1\npoll -1 EAGAIN\n');
  }, 60_000);

  // vim's typeahead check blocked for a key when two reads straddled a ms tick
  it.skipIf(!haveRealtime)('CLOCK_REALTIME and gettimeofday have sub-ms resolution', async () => {
    const { shell } = await setup(readFileSync(realtimeBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'valid 1 subms clock_gettime 1 gettimeofday 1 backwards 0 near time() 1 1\n');
  }, 60_000);

  // glibc's pthread_getattr_np reads the main stack from here (glibc Bun: Claude Code, opencode)
  it.skipIf(!haveMaps)('/proc/self/maps lists the guest mappings', async () => {
    const { shell } = await setup(readFileSync(mapsBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'lines>4 1 well-formed 1 stack 2 text-x 1 mprotect-split 1 getattr 0 inside 1\n');
  }, 60_000);

  // systemd's copy_bytes (sysusers backing up /etc/group): sendfile(out, in, NULL, n)
  it.skipIf(!haveSendfile)('sendfile with a NULL offset uses the file position', async () => {
    const { shell } = await setup(readFileSync(sendfileBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'null off: 15 pos 21\noff: 5 off 5 pos 21\nzero: 0\nout: sendfile world\nhello');
  }, 60_000);

  // mkfifo for shell-stdio; needs the kernel's FIFOs (mknodat, unix/perf-kernel)
  it.skipIf(!haveMkfifo || !('SYS_mknodat' in Abi))('mkfifo and mknod(at) create kernel FIFOs; devices are EPERM', async () => {
    const { shell } = await setup(readFileSync(mkfifoBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'mkfifo=0  fifo=1\nmknod=0  fifo=1\nmknodat=0  fifo=1\n' +
      'chardev=-1 Operation not permitted\nagain=-1 File exists\n');
  }, 60_000);

  // LTP fstat03
  // Claude Code's atomic writes and its task-output swap check (docs/COMPAT.md "Agent CLIs")
  it.each([['glibc', fsidentBin, haveFsident, ''], ['musl', fsidentMuslBin, haveFsidentMusl, ''], ['glibc-thread', fsidentBin, haveFsident, '--thread '], ['musl-thread', fsidentMuslBin, haveFsidentMusl, '--thread ']] as const)(
    'O_CREAT|O_EXCL, mkdir -p + openat(dirfd), O_PATH dirs, one dev/ino from stat, lstat, fstat and statx (%s)', async (_libc, bin, have, flag) => {
      if (!have) return;
      const { shell } = await setup(readFileSync(bin));
      const r = await run(shell, `./prog ${flag}/tmp/claude-1000/-home-user-${_libc}`);
      expect(r.output.replace(/\r\n/g, '\n')).toBe('fsident: ok\n');
      expect(r.exitCode).toBe(0);
    }, 60_000);

  it.skipIf(!haveFsident)('a path has one dev:ino in every process (the kernel\'s), whatever order they look it up in', async () => {
    const { shell, fs } = await setup(readFileSync(fsidentBin));
    await fs.mkdir('/tmp/inod/sub', { recursive: true });
    await fs.writeFile('/tmp/inod/f', 'x');
    const paths = ['/tmp/inod', '/tmp/inod/f', '/tmp/inod/sub', '/home/user/work', '/tmp'];
    const ids = async (ps: string[]) => (await run(shell, `./prog --ino ${ps.join(' ')}`)).output.trim().split(/\r?\n/);
    const a = await ids(paths);
    const b = (await ids([...paths].reverse())).reverse();
    expect(b).toEqual(a);
    expect(new Set(a).size).toBe(paths.length);
    // what the kernel (and WASM programs) report
    const { kernelForContext } = await import('@shiro/wasi/run-command');
    const kernel = kernelForContext({ fs, shell } as any);
    const proc = { pid: 1, cwd: '/', uid: 1000 } as any;
    for (const [i, p] of paths.entries()) {
      const st = await kernel.statPath(proc, p, false);
      expect(typeof st).not.toBe('number');
      expect(a[i]).toBe(`${(st as any).dev}:${(st as any).ino}`);
    }
  }, 60_000);

  // The acceptance test of docs/research/SHARED_MAPPINGS.md: within a process,
  // across fork, and with a process it exec'd (another Blink instance: the
  // semaphore's page is remote, Blink 0112)
  it.skipIf(!havePsem)('POSIX named semaphores across exec (sem_open, /dev/shm)', async () => {
    const { shell } = await setup(readFileSync(psemBin));
    const r = await run(shell, './prog');
    const out = r.output.replace(/\r\n/g, '\n');
    expect(out).toContain('initial 1\nafter wait 0\n');
    expect(out).toContain('after fork child post 1\n');
    expect(out).toContain("exec'd process post seen: yes\n");
  }, 60_000);

  // Firefox's font list: a memfd passed to a process it exec'd, mapped there
  // afresh; lock-prefixed adds, a process-shared mutex and semaphores (0112)
  it.skipIf(!haveShmobj)('a memfd mapped MAP_SHARED by an exec\'d process: atomics, mutex, semaphores across instances', async () => {
    const { shell } = await setup(readFileSync(shmobjBin));
    const r = await run(shell, './prog 2>/dev/null; BLINK_WJIT=0 ./prog 2>/dev/null');
    const ok = 'child sees "written by the parent"\npongs 50 atomic 4000 locked 4000 text "written by the child" exit 0\n';
    expect(r.output.replace(/\r\n/g, '\n')).toBe(ok + ok);
  }, 120_000);

  // Firefox's 242,716-byte memfd:mozilla-ipc region: the last page is partial;
  // unmapped whole, rounded, in parts and at exit (0117); a /dev/shm object
  // keeps what was written through its mapping (Open POSIX shm_open_28-1)
  it.skipIf(!haveShmodd)('shared mappings of a length that isn\'t whole pages unmap and exit; /dev/shm keeps the bytes', async () => {
    const { shell } = await setup(readFileSync(shmoddBin));
    const r = await run(shell, './prog; echo rc $?; BLINK_WJIT=0 ./prog; echo rc $?');
    const ok = "memfd munmap 0\nmemfd sees 'y' munmap rounded 0\nmemfd munmap tail 0 head 0\nanon munmap 0\n" +
      "anon after fork 'c' munmap rounded 0\nshm after close 'qwerty' mapped 'qwerty'\ndone\nrc 0\n";
    expect(r.output.replace(/\r\n/g, '\n')).toBe(ok + ok);
  }, 120_000);

  // The fd and the mapping of a /dev/shm object are one file (conformance's report, Open POSIX shm_open)
  it.skipIf(!haveShmpread)('a /dev/shm object: pread sees the mapping, the mapping sees pwrite, an fd opened while mapped too', async () => {
    const { shell } = await setup(readFileSync(shmpreadBin));
    const r = await run(shell, './prog; echo rc $?; BLINK_WJIT=0 ./prog; echo rc $?');
    const ok = 'mapped pread a\nmapping sees pwrite w\nreopened while mapped aq\nafter munmap pread a z w q\nreopened pread awq\nrc 0\n';
    expect(r.output.replace(/\r\n/g, '\n')).toBe(ok + ok);
  }, 120_000);

  it.skipIf(!haveStatnull)('the stat family with a NULL buffer is EFAULT once the file is found', async () => {
    const { shell } = await setup(readFileSync(statnullBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'fstat(fd, NULL)=-1 Bad address\nfstat(-1, NULL)=-1 Bad file descriptor\nstat(file, NULL)=-1 Bad address\n' +
      'stat(missing, NULL)=-1 No such file or directory\nlstat(file, NULL)=-1 Bad address\nnewfstatat(file, NULL)=-1 Bad address\n');
  }, 60_000);

  // perl's $0 = ... (Debian's addgroup); libcap's cap_get_proc and iputils' PR_SET_KEEPCAPS (ping)
  it.skipIf(!havePrctlcap)('prctl PR_SET_NAME/PR_GET_NAME/PR_CAPBSET_READ, capget/capset', async () => {
    const { shell } = await setup(readFileSync(prctlcapBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'default name prog\nset 0 name renamed-thread-\ncapbset_read(0)=1 capbset_read(40)=1\n' +
      'capbset_read(64)=-1 Invalid argument\ncapget(version 0)=0 , version 0x20080522\n' +
      'capget=0 full=0\ncapset=0\n' +
      'keepcaps 0 set=0 now 1, set(2)=-1 Invalid argument\npdeathsig set=0 now 15\ndumpable 1 set=0\n' +
      'subreaper set=0 now 1\nno_new_privs 0 set=0 now 1\nambient is_set=0\n');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  // dpkg lchowns NAME.dpkg-new symlinks before their targets exist
  it.skipIf(!haveLchown)('lchown and fchownat(AT_SYMLINK_NOFOLLOW) act on a dangling symlink', async () => {
    const { shell } = await setup(readFileSync(lchownBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'lchown(dangling)=0 \nfchownat(dangling, NOFOLLOW)=0 \nchown(dangling)=-1 No such file or directory\n' +
      'fchownat(dangling)=-1 No such file or directory\nlchown(missing)=-1 No such file or directory\n' +
      'fchownat(missing)=-1 No such file or directory\nfchownat(dirfd, dangling, NOFOLLOW)=0 \n' +
      'fchownat(fd, "", EMPTY_PATH)=0 \n');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  // GTK's cubic-bezier easing selects with cmpltsd masks (Blink wrote -1.0)
  it.skipIf(!haveSsecmp)('cmpps/cmppd/cmpss/cmpsd write all-ones masks, NaN included', async () => {
    const { shell } = await setup(readFileSync(ssecmpBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('ssecmp 288 cases, 0 wrong\n');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  // apt's cache was mmapped at the break and malloc's brk overwrote it
  it.skipIf(!haveBrkmap)('brk never grows over a mapping; mmap(0) leaves the heap room', async () => {
    const { shell } = await setup(readFileSync(brkmapBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe(
      'mmap(0) clear of the break: 1\nmapping intact: 1\nsbrk over a mapping refused: 1, mapping kept: 1\n');
    expect(r.exitCode).toBe(0);
  }, 60_000);

  // coreutils id: "failed to get groups for the current process"
  it.skipIf(!haveGetgroups)('getgroups reports the process gid, and its count for size 0', async () => {
    const { shell } = await setup(readFileSync(getgroupsBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('getgroups(0)=1 getgroups(64)=1 is-gid=1\n');
    expect(r.exitCode).toBe(0);
  }, 60_000);
});

// libuv makes every fd non-blocking with ioctl(FIONBIO); on /dev/null the
// kernel answered ENOTTY and cmake died (exit 139) in its uname probes.
describe.skipIf(!haveFionbio)('Blink engine: FIONBIO', () => {
  it('sets O_NONBLOCK on /dev/null, a pipe and a file', async () => {
    const { shell } = await setup(readFileSync(fionbioBin));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('devnull 0 1 0 0\npipe 0 1 0 0\nfile 0 1 0 0\n');
    expect(r.exitCode).toBe(0);
  }, 60_000);
});

// AF_UNIX path sockets with SCM_RIGHTS through Blink's sendmsg/recvmsg (tmux, screen).
describe('Blink engine: AF_UNIX sockets', () => {
  it('a server and a forked client talk over a path socket and pass an fd', async () => {
    const { shell } = await setup(readFileSync(join(FIX, 'unix-musl')));
    const r = await run(shell, './prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe("server: 2 bytes 'hi' fd ok peercred ok socket file ok\nclient: via the passed fd\n");
    expect(r.exitCode).toBe(0);
  }, 60_000);
});
