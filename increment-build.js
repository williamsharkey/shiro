#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';

// Read current build number
const buildNum = parseInt(readFileSync('build-number.txt', 'utf8').trim()) || 0;
const newBuildNum = buildNum + 1;

// Write new build number (terminal.ts imports this via Vite ?raw)
writeFileSync('build-number.txt', `${newBuildNum}\n`);

console.log(`Build #${String(newBuildNum).padStart(4, '0')}`);
