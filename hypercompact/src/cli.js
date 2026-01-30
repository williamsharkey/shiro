#!/usr/bin/env node
/**
 * Hypercompact CLI
 *
 * Usage:
 *   hc <file.html> "<command>"
 *   hc <file.html> -i              # Interactive mode
 */

const fs = require('fs');
const { fromHTML, VERSION, COMMANDS } = require('./index.js');

function printHelp() {
  console.log(`Hypercompact v${VERSION} - Token-efficient DOM navigation

Usage:
  hc <file.html> "<command>"        Execute single command
  hc <file.html> -i                 Interactive REPL mode

Commands:
${Object.entries(COMMANDS).map(([k, v]) => `  ${k.padEnd(4)} ${v}`).join('\n')}

Examples:
  hc page.html "t100"               Get first 100 chars of text
  hc page.html "q .price"           Find all elements with class "price"
  hc page.html "q .price; n0; a"    Find prices, select first, show attrs
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    printHelp();
    process.exit(0);
  }

  const [htmlFile, ...rest] = args;

  // Check file exists
  if (!fs.existsSync(htmlFile)) {
    console.error(`✗ File not found: ${htmlFile}`);
    process.exit(1);
  }

  // Load linkedom
  let parseHTML;
  try {
    parseHTML = require('linkedom').parseHTML;
  } catch (e) {
    console.error('✗ linkedom not installed. Run: npm install linkedom');
    process.exit(1);
  }

  // Load HTML
  const html = fs.readFileSync(htmlFile, 'utf8');
  const session = fromHTML(html, htmlFile, { parseHTML });

  // Interactive mode
  if (rest[0] === '-i') {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'hc> '
    });

    console.log(`Hypercompact v${VERSION}`);
    console.log(`Loaded: ${htmlFile} (${html.length} chars)`);
    console.log('Type "help" for commands, Ctrl+C to exit\n');

    rl.prompt();

    rl.on('line', (line) => {
      const cmd = line.trim();

      if (!cmd) {
        rl.prompt();
        return;
      }

      if (cmd === 'help') {
        Object.entries(COMMANDS).forEach(([k, v]) => {
          console.log(`  ${k.padEnd(4)} ${v}`);
        });
      } else if (cmd === 'exit' || cmd === 'quit') {
        rl.close();
        return;
      } else {
        console.log(session.exec(cmd));
      }

      rl.prompt();
    });

    rl.on('close', () => {
      console.log('\nBye!');
      process.exit(0);
    });

    return;
  }

  // Single command mode
  const cmd = rest.join(' ');
  if (!cmd) {
    console.error('✗ No command provided');
    printHelp();
    process.exit(1);
  }

  console.log(session.exec(cmd));
}

main().catch(e => {
  console.error('✗', e.message);
  process.exit(1);
});
