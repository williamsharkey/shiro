#!/usr/bin/env node
/**
 * Hypercompact v2 Study
 * Tests real-world tasks with new terse syntax
 */

const fs = require('fs');
const { HypercompactSession } = require('./hc_tool_v2.js');

const charsPerToken = 4;
const tokensFor = (str) => Math.ceil(str.length / charsPerToken);
const MCP_OVERHEAD = 45;

function runStudy() {
  console.log('═'.repeat(70));
  console.log('HYPERCOMPACT V2 STUDY - Real Tasks on Real Pages');
  console.log('═'.repeat(70));
  console.log('');

  const results = [];

  // ============================================================
  // TASK 1: Hacker News - Top story details
  // ============================================================
  console.log('TASK 1: HN - Get #1 story title, points, author');
  console.log('─'.repeat(50));

  const hn = new HypercompactSession('pages/hn.html');
  const hnCmds = [];

  // Discover structure first (blind)
  let cmd = 's';
  let resp = hn.exec(cmd);
  hnCmds.push({ cmd, resp });
  console.log(`  hc> ${cmd}`);
  console.log(`  ${resp}`);

  // Get titles
  cmd = 'q .titleline';
  resp = hn.exec(cmd).split('\n')[0];
  hnCmds.push({ cmd, resp });
  console.log(`  hc> ${cmd}`);
  console.log(`  ${resp}`);

  // Get scores
  cmd = 'q .score';
  resp = hn.exec(cmd).split('\n')[0];
  hnCmds.push({ cmd, resp });
  console.log(`  hc> ${cmd}`);
  console.log(`  ${resp}`);

  // Get authors
  cmd = 'q .hnuser';
  resp = hn.exec(cmd).split('\n')[0];
  hnCmds.push({ cmd, resp });
  console.log(`  hc> ${cmd}`);
  console.log(`  ${resp}`);

  let contentTokens = hnCmds.reduce((sum, c) => sum + tokensFor(c.cmd) + tokensFor(c.resp), 0);
  results.push({
    task: 'HN Top Story',
    commands: hnCmds.length,
    contentTokens,
    totalTokens: contentTokens + hnCmds.length * MCP_OVERHEAD
  });
  console.log('');

  // ============================================================
  // TASK 2: Bookstore - Find 3rd book title and price
  // ============================================================
  console.log('TASK 2: Bookstore - Get 3rd book title and price');
  console.log('─'.repeat(50));

  const book = new HypercompactSession('pages/bookstore.html');
  const bookCmds = [];

  cmd = 'q article h3 a';
  resp = book.exec(cmd).split('\n')[2]; // 3rd item
  bookCmds.push({ cmd, resp });
  console.log(`  hc> ${cmd}`);
  console.log(`  [2]${resp.replace('[2]', '')}`);

  cmd = 'q .price_color';
  resp = book.exec(cmd).split('\n')[2];
  bookCmds.push({ cmd, resp });
  console.log(`  hc> ${cmd}`);
  console.log(`  [2]${resp.replace('[2]', '')}`);

  contentTokens = bookCmds.reduce((sum, c) => sum + tokensFor(c.cmd) + tokensFor(c.resp), 0);
  results.push({
    task: 'Book 3rd Price',
    commands: bookCmds.length,
    contentTokens,
    totalTokens: contentTokens + bookCmds.length * MCP_OVERHEAD
  });
  console.log('');

  // ============================================================
  // TASK 3: Wikipedia - Get article summary
  // ============================================================
  console.log('TASK 3: Wikipedia - Get article summary');
  console.log('─'.repeat(50));

  const wiki = new HypercompactSession('pages/wikipedia.html');
  const wikiCmds = [];

  cmd = 't200';
  resp = wiki.exec(cmd);
  wikiCmds.push({ cmd, resp });
  console.log(`  hc> ${cmd}`);
  console.log(`  ${resp.slice(0, 80)}...`);

  cmd = 'q1 #firstHeading';
  resp = wiki.exec(cmd);
  wikiCmds.push({ cmd, resp });
  console.log(`  hc> ${cmd}`);
  console.log(`  ${resp}`);

  contentTokens = wikiCmds.reduce((sum, c) => sum + tokensFor(c.cmd) + tokensFor(c.resp), 0);
  results.push({
    task: 'Wiki Summary',
    commands: wikiCmds.length,
    contentTokens,
    totalTokens: contentTokens + wikiCmds.length * MCP_OVERHEAD
  });
  console.log('');

  // ============================================================
  // TASK 4: Article - Find heading and look for links
  // ============================================================
  console.log('TASK 4: Article - Get heading and list links');
  console.log('─'.repeat(50));

  const art = new HypercompactSession('pages/article1.html');
  const artCmds = [];

  cmd = 'q1 h1';
  resp = art.exec(cmd);
  artCmds.push({ cmd, resp });
  console.log(`  hc> ${cmd}`);
  console.log(`  ${resp}`);

  cmd = 'look';
  resp = art.exec(cmd).split('\n').slice(0, 6).join('\n');
  artCmds.push({ cmd, resp });
  console.log(`  hc> ${cmd}`);
  console.log(`  ${resp.split('\n').slice(0, 4).join('\n')}`);

  contentTokens = artCmds.reduce((sum, c) => sum + tokensFor(c.cmd) + tokensFor(c.resp), 0);
  results.push({
    task: 'Article Nav',
    commands: artCmds.length,
    contentTokens,
    totalTokens: contentTokens + artCmds.length * MCP_OVERHEAD
  });
  console.log('');

  // ============================================================
  // TASK 5: Quotes - Grep for author
  // ============================================================
  console.log('TASK 5: Quotes - Find Einstein quotes');
  console.log('─'.repeat(50));

  const quotes = new HypercompactSession('pages/quotes.html');
  const quotesCmds = [];

  cmd = 'g Einstein';
  resp = quotes.exec(cmd);
  quotesCmds.push({ cmd, resp });
  console.log(`  hc> ${cmd}`);
  resp.split('\n').slice(0, 3).forEach(l => console.log(`  ${l}`));

  contentTokens = quotesCmds.reduce((sum, c) => sum + tokensFor(c.cmd) + tokensFor(c.resp), 0);
  results.push({
    task: 'Quotes Grep',
    commands: quotesCmds.length,
    contentTokens,
    totalTokens: contentTokens + quotesCmds.length * MCP_OVERHEAD
  });
  console.log('');

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('═'.repeat(70));
  console.log('RESULTS SUMMARY');
  console.log('═'.repeat(70));
  console.log('');
  console.log('Task                | Cmds | Content | +Overhead | Total');
  console.log('─'.repeat(60));

  let totalCmds = 0, totalContent = 0, totalTotal = 0;
  results.forEach(r => {
    console.log(
      `${r.task.padEnd(20)}| ${String(r.commands).padStart(4)} | ${String(r.contentTokens).padStart(7)} | ${String(r.commands * MCP_OVERHEAD).padStart(9)} | ${String(r.totalTokens).padStart(5)}`
    );
    totalCmds += r.commands;
    totalContent += r.contentTokens;
    totalTotal += r.totalTokens;
  });

  console.log('─'.repeat(60));
  console.log(
    `${'TOTAL'.padEnd(20)}| ${String(totalCmds).padStart(4)} | ${String(totalContent).padStart(7)} | ${String(totalCmds * MCP_OVERHEAD).padStart(9)} | ${String(totalTotal).padStart(5)}`
  );

  console.log('');
  console.log('═'.repeat(70));
  console.log('COMPARISON: Normal HTML Read vs Hypercompact v2');
  console.log('═'.repeat(70));

  const normalTokens = {
    'hn.html': tokensFor(fs.readFileSync('pages/hn.html', 'utf8')),
    'bookstore.html': tokensFor(fs.readFileSync('pages/bookstore.html', 'utf8')),
    'wikipedia.html': tokensFor(fs.readFileSync('pages/wikipedia.html', 'utf8')),
    'article1.html': tokensFor(fs.readFileSync('pages/article1.html', 'utf8')),
    'quotes.html': tokensFor(fs.readFileSync('pages/quotes.html', 'utf8'))
  };

  const totalNormal = Object.values(normalTokens).reduce((a, b) => a + b, 0);

  console.log(`Normal (read all HTML): ${totalNormal.toLocaleString()} tokens`);
  console.log(`Hypercompact v2:        ${totalTotal.toLocaleString()} tokens`);
  console.log(`Reduction:              ${((1 - totalTotal / totalNormal) * 100).toFixed(1)}%`);
  console.log('');

  // Write results
  fs.writeFileSync('results/study_v2.json', JSON.stringify({ results, totalNormal, totalTotal }, null, 2));
  console.log('Results saved to results/study_v2.json');
}

runStudy();
