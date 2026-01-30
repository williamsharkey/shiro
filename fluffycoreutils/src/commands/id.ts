import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const id: FluffyCommand = {
  name: "id",
  description: "Print user identity",
  async exec(args, io) {
    const { positional, flags } = parseArgs(args);

    const user = positional[0] || io.env.USER || "user";
    const showUser = flags.u || flags.user;
    const showGroup = flags.g || flags.group;
    const showGroups = flags.G || flags.groups;
    const showName = flags.n || flags.name;
    const showReal = flags.r || flags.real;

    // In browser environment, we use mock values
    const uid = 1000;
    const gid = 1000;
    const groups = [1000];
    const userName = user;
    const groupName = "users";

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

    return {
      stdout: output.join("\n") + (output.length > 0 ? "\n" : ""),
      stderr: "",
      exitCode: 0
    };
  },
};
