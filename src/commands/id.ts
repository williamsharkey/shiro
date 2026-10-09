
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

    // From /etc/passwd and /etc/group, like getpwnam/getgrouplist
    const { passwdEntries, userGroups } = await import('./base-utils');
    const pw = (await passwdEntries(ctx)).find((p) => p.name === user);
    if (positional[0] && !pw) {
      ctx.stderr += `id: '${positional[0]}': no such user\n`;
      return 1;
    }
    const grs = (await userGroups(ctx, user)) ?? [];
    const uid = pw?.uid ?? (root ? 0 : 1000);
    const gid = pw?.gid ?? (root ? 0 : 1000);
    const groups = grs.length ? grs.map((g) => g.gid) : [gid];
    const userName = user;
    const groupName = grs[0]?.name ?? (root ? "root" : "user");
    const groupNames = grs.length ? grs.map((g) => g.name) : [groupName];

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
        output.push(groupNames.join(" "));
      } else {
        output.push(groups.join(" "));
      }
    } else {
      // Default: show all
      const groupsStr = groups.map((g, k) => `${g}(${groupNames[k]})`).join(",");
      output.push(`uid=${uid}(${userName}) gid=${gid}(${groupName}) groups=${groupsStr}`);
    }

    ctx.stdout += output.join("\n") + (output.length > 0 ? "\n" : "");
    return 0;
  },
};
