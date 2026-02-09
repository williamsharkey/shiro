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
          // Parse format spec: %[-][\d+][.\d+][sdf]
          let spec = "";
          while (i < format.length && !/[sdf]/.test(format[i])) {
            spec += format[i];
            i++;
          }
          const type = format[i] ?? "s";
          i++;
          const val = params[paramIdx++] ?? "";

          switch (type) {
            case "s": result += val; break;
            case "d": result += String(parseInt(val, 10) || 0); break;
            case "f": {
              const precision = spec.includes(".") ? parseInt(spec.split(".")[1], 10) : 6;
              result += (parseFloat(val) || 0).toFixed(precision);
              break;
            }
          }
        }
      } else {
        result += format[i];
        i++;
      }
    }

    return { stdout: result, stderr: "", exitCode: 0 };
  },
};
