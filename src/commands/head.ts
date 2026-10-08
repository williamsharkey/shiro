import type { Command } from './index';
import { headTail } from './headtail';

export const head: Command = {
  name: "head",
  description: "Output the first part of files",
  exec: (ctx) => headTail(ctx, 'head'),
};
