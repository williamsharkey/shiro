/**
 * dc — RPN desk calculator
 */

import type { Command } from './index';

export const dcCmd: Command = {
  name: 'dc',
  description: 'RPN desk calculator',
  async exec(ctx) {
    try {
      const stack: number[] = [];
      const registers: Record<string, number> = {};
      let precision = 0;
      const output: string[] = [];

      // Collect input from args (-e expr) or stdin
      let input = '';
      for (let i = 0; i < ctx.args.length; i++) {
        if (ctx.args[i] === '-e' && i + 1 < ctx.args.length) {
          input += ctx.args[++i] + '\n';
        } else if (ctx.args[i] === '-f' && i + 1 < ctx.args.length) {
          const path = ctx.fs.resolvePath(ctx.args[++i], ctx.cwd);
          input += await ctx.fs.readFile(path, 'utf8') as string + '\n';
        }
      }
      if (!input) input = ctx.stdin;
      if (!input) return 0;

      // Tokenize
      const tokens: string[] = [];
      let j = 0;
      while (j < input.length) {
        const ch = input[j];

        // Skip whitespace
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { j++; continue; }

        // Numbers (with optional leading underscore for negative)
        if ((ch >= '0' && ch <= '9') || ch === '.' || ch === '_') {
          let num = '';
          if (ch === '_') { num = '-'; j++; }
          while (j < input.length && ((input[j] >= '0' && input[j] <= '9') || input[j] === '.')) {
            num += input[j++];
          }
          tokens.push(num);
          continue;
        }

        // Strings in square brackets
        if (ch === '[') {
          let depth = 1;
          let str = '';
          j++; // skip opening bracket
          while (j < input.length && depth > 0) {
            if (input[j] === '[') depth++;
            else if (input[j] === ']') { depth--; if (depth === 0) { j++; break; } }
            str += input[j++];
          }
          tokens.push('[' + str + ']');
          continue;
        }

        // Register operations (s/l followed by register name)
        if ((ch === 's' || ch === 'l' || ch === 'S' || ch === 'L') && j + 1 < input.length) {
          tokens.push(ch + input[j + 1]);
          j += 2;
          continue;
        }

        tokens.push(ch);
        j++;
      }

      // Execute tokens
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];

        // Number
        if (/^-?[\d.]+$/.test(tok)) {
          stack.push(parseFloat(tok));
          continue;
        }

        // String literal
        if (tok.startsWith('[') && tok.endsWith(']')) {
          // Push string as a "macro" — for now just store length or ignore
          continue;
        }

        // Store to register: sX
        if (tok.length === 2 && tok[0] === 's') {
          if (stack.length < 1) { ctx.stderr += 'dc: stack empty\n'; return 1; }
          registers[tok[1]] = stack.pop()!;
          continue;
        }

        // Load from register: lX
        if (tok.length === 2 && tok[0] === 'l') {
          const val = registers[tok[1]];
          if (val === undefined) { ctx.stderr += `dc: register '${tok[1]}' is empty\n`; return 1; }
          stack.push(val);
          continue;
        }

        switch (tok) {
          case '+': case '-': case '*': case '/': case '%': case '^': {
            if (stack.length < 2) { ctx.stderr += 'dc: stack empty\n'; return 1; }
            const b = stack.pop()!;
            const a = stack.pop()!;
            switch (tok) {
              case '+': stack.push(a + b); break;
              case '-': stack.push(a - b); break;
              case '*': stack.push(a * b); break;
              case '/':
                if (b === 0) { ctx.stderr += 'dc: divide by zero\n'; return 1; }
                stack.push(precision === 0 ? Math.trunc(a / b) : a / b);
                break;
              case '%':
                if (b === 0) { ctx.stderr += 'dc: divide by zero\n'; return 1; }
                stack.push(a % b);
                break;
              case '^': stack.push(Math.pow(a, b)); break;
            }
            break;
          }
          case 'v': { // square root
            if (stack.length < 1) { ctx.stderr += 'dc: stack empty\n'; return 1; }
            stack.push(Math.sqrt(stack.pop()!));
            break;
          }
          case 'p': { // print top
            if (stack.length < 1) { ctx.stderr += 'dc: stack empty\n'; return 1; }
            const val = stack[stack.length - 1];
            output.push(precision === 0 ? String(Math.trunc(val)) : val.toFixed(precision));
            break;
          }
          case 'n': { // print and pop, no newline
            if (stack.length < 1) { ctx.stderr += 'dc: stack empty\n'; return 1; }
            const val = stack.pop()!;
            output.push(precision === 0 ? String(Math.trunc(val)) : val.toFixed(precision));
            break;
          }
          case 'f': { // print entire stack
            for (let s = stack.length - 1; s >= 0; s--) {
              const val = stack[s];
              output.push(precision === 0 ? String(Math.trunc(val)) : val.toFixed(precision));
            }
            break;
          }
          case 'c': stack.length = 0; break; // clear stack
          case 'd': { // duplicate top
            if (stack.length < 1) { ctx.stderr += 'dc: stack empty\n'; return 1; }
            stack.push(stack[stack.length - 1]);
            break;
          }
          case 'r': { // swap top two
            if (stack.length < 2) { ctx.stderr += 'dc: stack empty\n'; return 1; }
            const t = stack[stack.length - 1];
            stack[stack.length - 1] = stack[stack.length - 2];
            stack[stack.length - 2] = t;
            break;
          }
          case 'z': { // push stack depth
            stack.push(stack.length);
            break;
          }
          case 'k': { // set precision
            if (stack.length < 1) { ctx.stderr += 'dc: stack empty\n'; return 1; }
            precision = Math.max(0, Math.trunc(stack.pop()!));
            break;
          }
          case 'K': { // push current precision
            stack.push(precision);
            break;
          }
          case 'q': return 0; // quit
          default: break; // ignore unknown
        }
      }

      if (output.length > 0) {
        ctx.stdout += output.join('\n') + '\n';
      }
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `dc: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
