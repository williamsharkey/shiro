import type { FluffyCommand } from "../types.js";
import { parseArgs } from "../flags.js";

export const date: FluffyCommand = {
  name: "date",
  description: "Display date and time",
  async exec(args, io) {
    const { flags, positional, values } = parseArgs(args, ["d", "date", "r", "reference", "u"]);

    let targetDate: Date;

    if (values.d || values.date) {
      // Parse date string
      const dateStr = values.d || values.date;
      targetDate = new Date(dateStr);
      if (isNaN(targetDate.getTime())) {
        return {
          stdout: "",
          stderr: `date: invalid date '${dateStr}'\n`,
          exitCode: 1
        };
      }
    } else if (values.r || values.reference) {
      // Reference file date (would need filesystem stat)
      return {
        stdout: "",
        stderr: "date: -r/--reference not supported in browser environment\n",
        exitCode: 1
      };
    } else {
      targetDate = new Date();
    }

    // UTC mode
    const utc = flags.u || flags.utc;

    if (positional.length > 0 && positional[0].startsWith("+")) {
      const fmt = positional[0].slice(1);
      const result = formatDate(targetDate, fmt, utc);
      return { stdout: result + "\n", stderr: "", exitCode: 0 };
    }

    // Default format
    const result = utc ? targetDate.toUTCString() : targetDate.toString();
    return { stdout: result + "\n", stderr: "", exitCode: 0 };
  },
};

function formatDate(d: Date, fmt: string, utc: boolean = false): string {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");

  const get = (method: string) => utc
    ? (d as any)[`getUTC${method}`]()
    : (d as any)[`get${method}`]();

  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const weekdaysShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monthsShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const year = get("FullYear");
  const month = get("Month");
  const day = get("Date");
  const hours = get("Hours");
  const minutes = get("Minutes");
  const seconds = get("Seconds");
  const ms = get("Milliseconds");
  const dayOfWeek = get("Day");

  return fmt
    // Date formats
    .replace(/%Y/g, String(year))
    .replace(/%y/g, String(year).slice(-2))
    .replace(/%m/g, pad2(month + 1))
    .replace(/%d/g, pad2(day))
    .replace(/%e/g, String(day).padStart(2, " "))
    // Time formats
    .replace(/%H/g, pad2(hours))
    .replace(/%I/g, pad2(hours % 12 || 12))
    .replace(/%M/g, pad2(minutes))
    .replace(/%S/g, pad2(seconds))
    .replace(/%N/g, pad3(ms) + "000000") // nanoseconds (fake)
    .replace(/%p/g, hours >= 12 ? "PM" : "AM")
    .replace(/%P/g, hours >= 12 ? "pm" : "am")
    // Unix timestamp
    .replace(/%s/g, String(Math.floor(d.getTime() / 1000)))
    // Weekday
    .replace(/%A/g, weekdays[dayOfWeek])
    .replace(/%a/g, weekdaysShort[dayOfWeek])
    .replace(/%w/g, String(dayOfWeek))
    .replace(/%u/g, String(dayOfWeek || 7)) // Monday = 1
    // Month
    .replace(/%B/g, months[month])
    .replace(/%b/g, monthsShort[month])
    .replace(/%h/g, monthsShort[month])
    // Compound formats
    .replace(/%F/g, `${year}-${pad2(month + 1)}-${pad2(day)}`) // ISO date
    .replace(/%T/g, `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`) // ISO time
    .replace(/%R/g, `${pad2(hours)}:${pad2(minutes)}`) // Hour:minute
    // Literal characters
    .replace(/%n/g, "\n")
    .replace(/%t/g, "\t")
    .replace(/%%/g, "%");
}
