import { Command } from './index';

export const nprocCmd: Command = {
  name: 'nproc',
  description: 'Print number of processing units',
  async exec(ctx) {
    ctx.stdout = (navigator.hardwareConcurrency || 4) + '\n';
    return 0;
  },
};
