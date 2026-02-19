
import type { Command } from './index';
const falseCmd: Command = {
  name: "false",
  description: "Return failure",
  async exec() {
    return 1;
  },
};

export { falseCmd as false };
