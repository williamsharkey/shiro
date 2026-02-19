
import type { Command } from './index';
const trueCmd: Command = {
  name: "true",
  description: "Return success",
  async exec() {
    return 0;
  },
};

export { trueCmd as true };
