/**
 * Tests for the demos on shiro.computer/about.
 *
 * Each test mirrors a demo on the about page, running the same commands
 * at full speed against an in-memory FluffyFS. If a test fails, the
 * corresponding demo on the page is lying.
 *
 * The "node" demo is not tested here — it uses Shiro's jseval runtime,
 * not fluffycoreutils.
 */
import { describe, it, expect } from "vitest";
import { MemFS } from "./mock-fs.js";
import { echo, printf, sort, grep, wc, awk, sed, uniq, cat, mkdir } from "../src/index.js";
import type { CommandIO } from "../src/types.js";

function io(fs: MemFS, stdin = "", cwd = "/"): CommandIO {
  return { stdin, env: {}, cwd, fs };
}

describe("about page demos", () => {
  // Demo: filesystem
  // mkdir -p /tmp/about-demo
  // echo "persistent data" > /tmp/about-demo/file.txt
  // cat /tmp/about-demo/file.txt  →  persistent data
  // wc -c /tmp/about-demo/file.txt  →  16 /tmp/about-demo/file.txt
  it("demo-fs: mkdir, echo > file, cat, wc -c", async () => {
    const fs = new MemFS();

    // mkdir -p /tmp/about-demo
    const mkdirResult = await mkdir.exec(["-p", "/tmp/about-demo"], io(fs));
    expect(mkdirResult.exitCode).toBe(0);

    // echo "persistent data" > /tmp/about-demo/file.txt
    // The shell handles the redirect: echo writes to stdout, shell writes to file
    const echoResult = await echo.exec(["persistent data"], io(fs));
    await fs.writeFile("/tmp/about-demo/file.txt", echoResult.stdout);

    // cat /tmp/about-demo/file.txt
    const catResult = await cat.exec(["/tmp/about-demo/file.txt"], io(fs));
    expect(catResult.stdout).toBe("persistent data\n");

    // wc -c /tmp/about-demo/file.txt
    const wcResult = await wc.exec(["-c", "/tmp/about-demo/file.txt"], io(fs));
    expect(wcResult.stdout).toContain("16");
    expect(wcResult.stdout).toContain("/tmp/about-demo/file.txt");
  });

  // Demo: pipes
  // printf 'cherry\napple\nbanana\n' | sort
  // →  apple\nbanana\ncherry
  it("demo-pipes: printf | sort", async () => {
    const fs = new MemFS();

    const p = await printf.exec(["cherry\\napple\\nbanana\\n"], io(fs));
    const s = await sort.exec([], io(fs, p.stdout));

    expect(s.stdout).toBe("apple\nbanana\ncherry\n");
  });

  // Demo: grep & wc
  // printf 'error: disk full\ninfo: started\nerror: timeout\ninfo: stopped\n' | grep error | wc -l
  // →  2
  it("demo-grep: printf | grep error | wc -l", async () => {
    const fs = new MemFS();

    const p = await printf.exec(
      ["error: disk full\\ninfo: started\\nerror: timeout\\ninfo: stopped\\n"],
      io(fs),
    );
    const g = await grep.exec(["error"], io(fs, p.stdout));
    const w = await wc.exec(["-l"], io(fs, g.stdout));

    expect(w.stdout.trim()).toBe("2");
  });

  // Demo: awk
  // printf 'alice 90\nbob 85\ncarol 95\n' | awk '{s+=$2} END {printf "avg: %.0f\n", s/NR}'
  // →  avg: 90
  it("demo-awk: printf | awk averaging", async () => {
    const fs = new MemFS();

    const p = await printf.exec(
      ["alice 90\\nbob 85\\ncarol 95\\n"],
      io(fs),
    );
    const a = await awk.exec(
      ['{s+=$2} END {printf "avg: %.0f\\n", s/NR}'],
      io(fs, p.stdout),
    );

    expect(a.stdout.trim()).toBe("avg: 90");
  });

  // Demo: sed
  // echo "Hello World" | sed 's/World/Browser/'
  // →  Hello Browser
  it("demo-sed: echo | sed s/World/Browser/", async () => {
    const fs = new MemFS();

    const e = await echo.exec(["Hello World"], io(fs));
    const s = await sed.exec(["s/World/Browser/"], io(fs, e.stdout));

    expect(s.stdout.trim()).toBe("Hello Browser");
  });

  // Demo: sort | uniq
  // printf 'banana\napple\napple\ncherry\nbanana\n' | sort | uniq
  // →  apple\nbanana\ncherry
  it("demo-uniq: printf | sort | uniq", async () => {
    const fs = new MemFS();

    const p = await printf.exec(
      ["banana\\napple\\napple\\ncherry\\nbanana\\n"],
      io(fs),
    );
    const s = await sort.exec([], io(fs, p.stdout));
    const u = await uniq.exec([], io(fs, s.stdout));

    expect(u.stdout).toBe("apple\nbanana\ncherry\n");
  });
});
