import { Command, CommandContext } from '../index';

const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

/** Compile CODE once: as an expression if it parses as one (so `1 + 2`
 *  prints 3), else as a statement body (`const a = 1; return a + 1`). Only a
 *  SyntaxError at compile time falls through, so the code never runs twice. */
export function compileJsEval(code: string): (shiro: unknown) => Promise<unknown> {
  try {
    // The newline keeps a trailing `// comment` from swallowing the paren;
    // trailing semicolons are dropped so `1 + 2;` is still an expression.
    return new AsyncFunction('shiro', `return (${code.replace(/[\s;]+$/, '')}\n);`);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  return new AsyncFunction('shiro', code);
}

export const jsEvalCmd: Command = {
  name: 'js-eval',
  description: 'Evaluate JavaScript expression in the browser VM',
  async exec(ctx: CommandContext): Promise<number> {
    let code = ctx.args.join(' ');

    // If no args, read from stdin
    if (!code.trim() && ctx.stdin) {
      code = ctx.stdin;
    }

    if (!code.trim()) {
      ctx.stderr += 'js-eval: no code provided\n';
      ctx.stderr += 'Usage: js-eval <expression>   or   js-eval \'stmt; stmt; return value\'\n';
      return 1;
    }

    try {
      // Create a context object that scripts can use
      const shiroCtx = {
        fs: ctx.fs,
        shell: ctx.shell,
        env: ctx.env,
        cwd: ctx.cwd,
      };

      const result = await compileJsEval(code)(shiroCtx);

      if (result !== undefined) {
        const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        ctx.stdout += output + '\n';
      }
      return 0;
    } catch (e: any) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      ctx.stderr += `js-eval: ${msg}\n`;
      return 1;
    }
  },
};
