import { describe, it, expect } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
import { Kernel } from '@shiro/kernel/kernel';
import { TtySession, attachKernelTty } from '@shiro/kernel/pty';
import { JobControl } from '@shiro/kernel/signals';

// hygiene.panes10: every closed pane stayed alive because the kernel's device
// table kept its pty's /dev/pts/N opener, whose pty kept the output callback
// into the terminal (and through it the shell and the pane's DOM).
describe('closing a terminal session releases its pty', () => {
  it('removes /dev/pts/N from the kernel and drops the output callback', async () => {
    const fs = new FileSystem();
    await fs.init();
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const jc = new JobControl();
    attachKernelTty(kernel, jc);
    let out = '';
    const tty = new TtySession({ jc, onOutput: (b) => { out += new TextDecoder().decode(b); } });
    const devices = (kernel as any).devices as Map<string, unknown>;
    const name = tty.pty.name;
    expect(devices.has(name)).toBe(true);

    tty.dispose();
    await new Promise((r) => setTimeout(r, 0));

    expect(devices.has(name)).toBe(false);
    expect((tty.pty as any).outListener).toBeNull();
    expect(devices.has('/dev/ptmx')).toBe(true); // the shared multiplexer stays
    expect(out).toBe('');
  });

  it('leaves other sessions\' devices alone', async () => {
    const fs = new FileSystem();
    await fs.init();
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const jc = new JobControl();
    attachKernelTty(kernel, jc);
    const a = new TtySession({ jc });
    const b = new TtySession({ jc });
    a.dispose();
    await new Promise((r) => setTimeout(r, 0));
    const devices = (kernel as any).devices as Map<string, unknown>;
    expect(devices.has(a.pty.name)).toBe(false);
    expect(devices.has(b.pty.name)).toBe(true);
    b.dispose();
  });
});
