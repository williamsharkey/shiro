#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';

// Read current build number
const buildNum = parseInt(readFileSync('build-number.txt', 'utf8').trim()) || 0;
const newBuildNum = buildNum + 1;

// Write new build number
writeFileSync('build-number.txt', `${newBuildNum}\n`);

// Update terminal.ts to include build number
const terminalPath = 'src/terminal.ts';
const terminalContent = readFileSync(terminalPath, 'utf8');
const updated = terminalContent.replace(
  /this\.term\.writeln\('\\x1b\[36m║\\x1b\[0m   \\x1b\[1;97mShiro OS\\x1b\[0m v[\d.]+.*?\\x1b\[36m║\\x1b\[0m'\);/,
  `this.term.writeln('\\x1b[36m║\\x1b[0m   \\x1b[1;97mShiro OS\\x1b[0m v0.1.0 (build ${newBuildNum})      \\x1b[36m║\\x1b[0m');`
);

writeFileSync(terminalPath, updated);

console.log(`Build number incremented to ${newBuildNum}`);
