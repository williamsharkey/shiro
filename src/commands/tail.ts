import type { Command } from './index';
import { headTail } from './headtail';

export const tail: Command = {
  name: "tail",
  description: "Output the last part of files",
  exec: (ctx) => headTail(ctx, 'tail'),
};
