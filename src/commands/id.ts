
import type { Command } from './index';
import { parseArgs } from './flags';
export const id: Command = {
  name: "id",
  description: "Print user identity",
  async exec(ctx) {
    const args = ctx.args;
    const { positional, flags } = parseArgs(args);

    // `sudo` runs its command in a shell with uid 0 (Shell.uid)
    const root = !positional[0] && ctx.shell?.uid === 0;
    const user = positional[0] || (root ? "root" : ctx.env.USER || "user");
    const showUser = flags.u || flags.user;
    const showGroup = flags.g || flags.group;
    const showGroups = flags.G || flags.groups;
    const showName = flags.n || flags.name;
    const showReal = flags.r || flags.real;

    // In browser environment, we use mock values
    const uid = root ? 0 : 1000;
    const gid = root ? 0 : 1000;
    const groups = [gid];
    const userName = user;
    const groupName = root ? "root" : "users";

    const output: string[] = [];

    if (showUser) {
      if (showName) {
        output.push(userName);
      } else {
        output.push(String(uid));
      }
    } else if (showGroup) {
      if (showName) {
        output.push(groupName);
      } else {
        output.push(String(gid));
      }
    } else if (showGroups) {
      if (showName) {
        output.push(groupName);
      } else {
        output.push(groups.join(" "));
      }
    } else {
      // Default: show all
      const groupsStr = groups.map(g => `${g}(${groupName})`).join(",");
      output.push(`uid=${uid}(${userName}) gid=${gid}(${groupName}) groups=${groupsStr}`);
    }

    ctx.stdout += output.join("\n") + (output.length > 0 ? "\n" : "");
    return 0;
  },
};
