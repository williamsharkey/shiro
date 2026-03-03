import type { CommandContext } from '../../commands/index';

export function createOsModule(ctx: CommandContext): any {
  return {
    platform: () => 'linux',
    arch: () => 'x64',
    homedir: () => ctx.env['HOME'] || '/home/user',
    tmpdir: () => '/tmp',
    hostname: () => 'shiro',
    type: () => 'Shiro',
    release: () => '0.1.0',
    cpus: () => {
      const count = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4;
      const cpu = { model: 'Browser vCPU', speed: 2400, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } };
      return Array.from({ length: count }, () => ({ ...cpu }));
    },
    totalmem: () => {
      const dm = typeof navigator !== 'undefined' ? (navigator as any).deviceMemory : undefined;
      return dm ? dm * 1024 * 1024 * 1024 : 8 * 1024 * 1024 * 1024; // default 8GB
    },
    freemem: () => 4 * 1024 * 1024 * 1024, // 4GB default
    EOL: '\n',
    userInfo: () => ({ username: 'user', homedir: ctx.env['HOME'] || '/home/user', shell: '/bin/sh', uid: 1000, gid: 1000 }),
    networkInterfaces: () => ({}),
    endianness: () => 'LE',
    loadavg: () => [0, 0, 0],
    uptime: () => performance.now() / 1000,
    machine: () => 'x86_64',
    availableParallelism: () => (navigator?.hardwareConcurrency || 4),
    version: () => 'Shiro 0.1.0',
    devNull: '/dev/null',
    constants: {
      signals: {
        SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
        SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
        SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19,
        SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25,
        SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGINFO: 29, SIGSYS: 31,
      },
      errno: {},
      priority: { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 },
    },
  };
}
