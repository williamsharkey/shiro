import { Command } from './index';

const values: Record<string, () => string> = {
  'NPROCESSORS_ONLN': () => String(navigator.hardwareConcurrency || 4),
  'NPROCESSORS_CONF': () => String(navigator.hardwareConcurrency || 4),
  '_NPROCESSORS_ONLN': () => String(navigator.hardwareConcurrency || 4),
  'PAGE_SIZE': () => '4096',
  'PAGESIZE': () => '4096',
  'PATH_MAX': () => '4096',
  'NAME_MAX': () => '255',
  'LONG_BIT': () => '64',
  'INT_MAX': () => '2147483647',
  'INT_MIN': () => '-2147483648',
  'OPEN_MAX': () => '1024',
  'ARG_MAX': () => '2097152',
  'CLK_TCK': () => '100',
  'HOST_NAME_MAX': () => '64',
  'LOGIN_NAME_MAX': () => '256',
  'CHAR_BIT': () => '8',
  'WORD_BIT': () => '32',
};

export const getconfCmd: Command = {
  name: 'getconf',
  description: 'Get system configuration values',
  async exec(ctx) {
    const name = ctx.args[0];
    if (!name) {
      ctx.stderr = 'getconf: missing operand\n';
      return 1;
    }
    const fn = values[name];
    if (fn) {
      ctx.stdout = fn() + '\n';
      return 0;
    }
    ctx.stderr = `getconf: unrecognized variable '${name}'\n`;
    return 1;
  },
};
