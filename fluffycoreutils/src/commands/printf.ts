import type { FluffyCommand } from "../types.js";

export const printf: FluffyCommand = {
  name: "printf",
  description: "Format and print data",
  async exec(args) {
    if (args.length === 0) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    const format = args[0];
    const params = args.slice(1);
    let paramIdx = 0;
    let result = "";
    let i = 0;

    while (i < format.length) {
      if (format[i] === "\\") {
        i++;
        switch (format[i]) {
          case "n": result += "\n"; break;
          case "t": result += "\t"; break;
          case "\\": result += "\\"; break;
          case "\"": result += "\""; break;
          default: result += "\\" + (format[i] ?? ""); break;
        }
        i++;
      } else if (format[i] === "%") {
        i++;
        if (format[i] === "%") {
          result += "%";
          i++;
        } else {
          // Parse format spec: %[-][0][\d+][.\d+][sdfx]
          let spec = "";
          while (i < format.length && !/[sdfxX]/.test(format[i])) {
            spec += format[i];
            i++;
          }
          const type = format[i] ?? "s";
          i++;
          const val = params[paramIdx++] ?? "";

          // Parse width/alignment from spec
          const leftAlign = spec.startsWith("-");
          const zeroPad = spec.startsWith("0") || (leftAlign && spec[1] === "0");
          const specClean = spec.replace(/^-?0?/, "");
          const dotIdx = specClean.indexOf(".");
          const width = dotIdx >= 0 ? parseInt(specClean.slice(0, dotIdx), 10) || 0 : parseInt(specClean, 10) || 0;

          let formatted: string;
          switch (type) {
            case "s": formatted = val; break;
            case "d": formatted = String(parseInt(val, 10) || 0); break;
            case "x": formatted = (parseInt(val, 10) || 0).toString(16); break;
            case "X": formatted = (parseInt(val, 10) || 0).toString(16).toUpperCase(); break;
            case "f": {
              const precision = spec.includes(".") ? parseInt(spec.split(".")[1], 10) : 6;
              formatted = (parseFloat(val) || 0).toFixed(precision);
              break;
            }
            default: formatted = val;
          }

          if (width > 0 && formatted.length < width) {
            const fill = (zeroPad && !leftAlign && type !== "s") ? "0" : " ";
            if (leftAlign) {
              formatted = formatted.padEnd(width, " ");
            } else {
              formatted = formatted.padStart(width, fill);
            }
          }
          result += formatted;
        }
      } else {
        result += format[i];
        i++;
      }
    }

    return { stdout: result, stderr: "", exitCode: 0 };
  },
};
