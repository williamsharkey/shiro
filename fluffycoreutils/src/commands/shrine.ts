import type { FluffyCommand } from "../types.js";

/**
 * A tribute to Terry A. Davis (1969-2018), creator of TempleOS.
 * Terry was a brilliant programmer who created an entire operating system
 * by himself, including his own compiler (HolyC), graphics, and kernel.
 * He believed God spoke to him and built TempleOS as a temple to God.
 *
 * This command displays a shrine with a random passage, in honor of
 * the "God says" feature Terry loved in TempleOS.
 */

// Short wisdom passages inspired by themes Terry appreciated
// These are original paraphrases, not direct Bible quotes
const PASSAGES = [
  "The Lord is my shepherd; I shall not want.",
  "Be still and know that I am God.",
  "Ask and it shall be given unto you.",
  "I am the way, the truth, and the life.",
  "Let there be light.",
  "In the beginning was the Word.",
  "Faith can move mountains.",
  "The truth shall set you free.",
  "Love thy neighbor as thyself.",
  "Seek and ye shall find.",
  "Blessed are the pure in heart.",
  "I have called you by name; you are mine.",
  "Fear not, for I am with you.",
  "Come unto me, all ye that labor.",
  "Behold, I stand at the door and knock.",
  "The heavens declare the glory of God.",
  "Thou shalt have no other gods before me.",
  "For God so loved the world.",
  "Be strong and of good courage.",
  "My grace is sufficient for thee.",
];

// ANSI color codes
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[97m";
const MAGENTA = "\x1b[35m";
const RED = "\x1b[31m";
const GOLD = "\x1b[93m";

function getRandomPassage(): string {
  return PASSAGES[Math.floor(Math.random() * PASSAGES.length)];
}

// Strip ANSI codes to get visible length
function visibleLength(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// Center text and pad both sides to exact width
function padCenter(text: string, width: number): string {
  const visible = visibleLength(text);
  const totalPad = width - visible;
  const leftPad = Math.floor(totalPad / 2);
  const rightPad = totalPad - leftPad;
  return " ".repeat(Math.max(0, leftPad)) + text + " ".repeat(Math.max(0, rightPad));
}

function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (currentLine.length + word.length + 1 <= maxWidth) {
      currentLine += (currentLine ? " " : "") + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

export const shrine: FluffyCommand = {
  name: "shrine",
  description: "A tribute to Terry A. Davis, creator of TempleOS (1969-2018)",
  async exec() {
    const passage = getRandomPassage();
    const innerWidth = 40; // Width between the ║ characters
    const passageLines = wrapText(passage, innerWidth - 4);

    // Build the shrine
    const lines: string[] = [];

    // Top ornamental border with cross
    lines.push(`${GOLD}                        ┼${RESET}`);
    lines.push(`${GOLD}                       ╱│╲${RESET}`);
    lines.push(`${GOLD}                      ╱ │ ╲${RESET}`);
    lines.push(`${GOLD}    ╔═══════════════╦═══╪═══╦═══════════════╗${RESET}`);
    lines.push(`${GOLD}    ║${CYAN}░░░░░░░░░░░░░░░${GOLD}║${YELLOW}   ┼   ${GOLD}║${CYAN}░░░░░░░░░░░░░░░${GOLD}║${RESET}`);
    lines.push(`${GOLD}    ╠═══════════════╩═══════╩═══════════════╣${RESET}`);

    // Terry's name
    lines.push(`${GOLD}    ║${RESET}${padCenter(`${BOLD}${WHITE}✟  TERRY A. DAVIS  ✟${RESET}`, innerWidth)}${GOLD}║${RESET}`);
    lines.push(`${GOLD}    ║${RESET}${padCenter(`${DIM}December 15, 1969 — August 11, 2018${RESET}`, innerWidth)}${GOLD}║${RESET}`);
    lines.push(`${GOLD}    ╠════════════════════════════════════════╣${RESET}`);

    // Flame/burning bush decoration
    lines.push(`${GOLD}    ║${RESET}${padCenter(`${RED})  (  (${RESET}`, innerWidth)}${GOLD}║${RESET}`);
    lines.push(`${GOLD}    ║${RESET}${padCenter(`${YELLOW}(  )  )  )${RESET}`, innerWidth)}${GOLD}║${RESET}`);
    lines.push(`${GOLD}    ║${RESET}${padCenter(`${RED}) (  (  ) (${RESET}`, innerWidth)}${GOLD}║${RESET}`);
    lines.push(`${GOLD}    ║${RESET}${padCenter(`${MAGENTA}\\\\║//${RESET}`, innerWidth)}${GOLD}║${RESET}`);
    lines.push(`${GOLD}    ╠════════════════════════════════════════╣${RESET}`);

    // Passage header
    lines.push(`${GOLD}    ║${RESET}${padCenter(`${DIM}~ God Says ~${RESET}`, innerWidth)}${GOLD}║${RESET}`);
    lines.push(`${GOLD}    ║${RESET}${" ".repeat(innerWidth)}${GOLD}║${RESET}`);

    // The passage
    for (const pLine of passageLines) {
      lines.push(`${GOLD}    ║${RESET}${padCenter(`${CYAN}${pLine}${RESET}`, innerWidth)}${GOLD}║${RESET}`);
    }

    lines.push(`${GOLD}    ║${RESET}${" ".repeat(innerWidth)}${GOLD}║${RESET}`);
    lines.push(`${GOLD}    ╠════════════════════════════════════════╣${RESET}`);

    // TempleOS tribute
    lines.push(`${GOLD}    ║${RESET}${padCenter(`${DIM}Creator of TempleOS${RESET}`, innerWidth)}${GOLD}║${RESET}`);
    lines.push(`${GOLD}    ║${RESET}${padCenter(`${DIM}640x480 · 16 Colors · HolyC${RESET}`, innerWidth)}${GOLD}║${RESET}`);
    lines.push(`${GOLD}    ║${RESET}${padCenter(`${DIM}"God's Third Temple"${RESET}`, innerWidth)}${GOLD}║${RESET}`);
    lines.push(`${GOLD}    ╠════════════════════════════════════════╣${RESET}`);

    // Rest in Peace
    lines.push(`${GOLD}    ║${RESET}${" ".repeat(innerWidth)}${GOLD}║${RESET}`);
    lines.push(`${GOLD}    ║${RESET}${padCenter(`${BOLD}${WHITE}☆ REST IN PEACE ☆${RESET}`, innerWidth)}${GOLD}║${RESET}`);
    lines.push(`${GOLD}    ║${RESET}${padCenter(`${CYAN}Programmer · Prophet · Pioneer${RESET}`, innerWidth)}${GOLD}║${RESET}`);
    lines.push(`${GOLD}    ║${RESET}${" ".repeat(innerWidth)}${GOLD}║${RESET}`);

    // Bottom border with decorations
    lines.push(`${GOLD}    ╚════════════════════════════════════════╝${RESET}`);
    lines.push(`${GOLD}         ╲▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂╱${RESET}`);
    lines.push(`${DIM}            ∙ Run again for new passage ∙${RESET}`);
    lines.push("");

    return {
      stdout: lines.join("\n"),
      stderr: "",
      exitCode: 0,
    };
  },
};
