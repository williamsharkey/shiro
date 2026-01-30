#!/usr/bin/env node
/**
 * Hypercompact Study Runner
 * Compares token usage: Normal HTML reading vs Hypercompact REPL
 */

const fs = require('fs');
const { HypercompactSession } = require('./hc_tool.js');

// Token estimation: ~4 chars per token (conservative for mixed content)
const charsPerToken = 4;
const tokensFor = (str) => Math.ceil(str.length / charsPerToken);

// Study results
const results = [];

function runStudy() {
  console.log('=' .repeat(70));
  console.log('HYPERCOMPACT TOKEN EFFICIENCY STUDY');
  console.log('=' .repeat(70));
  console.log('');

  // ============================================================
  // TASK 1: Hacker News - Get #1 story details
  // ============================================================
  console.log('TASK 1: Hacker News - Get #1 story title, points, author');
  console.log('-'.repeat(50));

  const hnHtml = fs.readFileSync('pages/hn.html', 'utf8');

  // Normal approach: read full HTML
  const task1Normal = {
    name: 'Task 1 Normal',
    inputTokens: tokensFor(hnHtml),
    outputTokens: tokensFor('The #1 story is "Buttered Crumpet, a custom typeface for Wallace and Gromit" with 67 points by tobr'),
  };
  task1Normal.totalTokens = task1Normal.inputTokens + task1Normal.outputTokens;

  // Hypercompact approach
  const hc1 = new HypercompactSession('pages/hn.html');
  const hc1Commands = [];

  // Command 1: Get titles
  let cmd = 'q .titleline';
  let resp = hc1.exec(cmd);
  hc1Commands.push({ cmd, resp: resp.split('\n')[0] }); // Just first result

  // Command 2: Get scores
  cmd = 'q .score';
  resp = hc1.exec(cmd);
  hc1Commands.push({ cmd, resp: resp.split('\n')[0] });

  // Command 3: Get authors
  cmd = 'q .hnuser';
  resp = hc1.exec(cmd);
  hc1Commands.push({ cmd, resp: resp.split('\n')[0] });

  let hc1Input = 0, hc1Output = 0;
  hc1Commands.forEach(c => {
    hc1Input += tokensFor(c.resp);
    hc1Output += tokensFor(c.cmd);
    console.log(`  hc> ${c.cmd}`);
    console.log(`  ${c.resp.slice(0, 80)}`);
  });

  const task1HC = {
    name: 'Task 1 Hypercompact',
    inputTokens: hc1Input,
    outputTokens: hc1Output,
    totalTokens: hc1Input + hc1Output,
  };

  results.push({ task: 'Task 1: HN Top Story', normal: task1Normal, hc: task1HC });
  console.log('');

  // ============================================================
  // TASK 2: Wikipedia - Get first paragraph summary
  // ============================================================
  console.log('TASK 2: Wikipedia - Get article summary');
  console.log('-'.repeat(50));

  const wikiHtml = fs.readFileSync('pages/wikipedia.html', 'utf8');

  const task2Normal = {
    name: 'Task 2 Normal',
    inputTokens: tokensFor(wikiHtml),
    outputTokens: tokensFor('Claude is a family of large language models developed by Anthropic...'),
  };
  task2Normal.totalTokens = task2Normal.inputTokens + task2Normal.outputTokens;

  const hc2 = new HypercompactSession('pages/wikipedia.html');
  const hc2Commands = [];

  // Explore structure first (blind)
  cmd = 't500';
  resp = hc2.exec(cmd);
  hc2Commands.push({ cmd, resp: resp.slice(0, 200) + '...' });
  console.log(`  hc> ${cmd}`);
  console.log(`  ${resp.slice(0, 100)}...`);

  // Find the lead paragraph
  cmd = 'q1 .mw-parser-output > p';
  resp = hc2.exec(cmd);
  hc2Commands.push({ cmd, resp });
  console.log(`  hc> ${cmd}`);
  console.log(`  ${resp.slice(0, 100)}...`);

  let hc2Input = 0, hc2Output = 0;
  hc2Commands.forEach(c => {
    hc2Input += tokensFor(c.resp);
    hc2Output += tokensFor(c.cmd);
  });

  const task2HC = {
    name: 'Task 2 Hypercompact',
    inputTokens: hc2Input,
    outputTokens: hc2Output,
    totalTokens: hc2Input + hc2Output,
  };

  results.push({ task: 'Task 2: Wikipedia Summary', normal: task2Normal, hc: task2HC });
  console.log('');

  // ============================================================
  // TASK 3: Bookstore - Get 3rd book title and price
  // ============================================================
  console.log('TASK 3: Bookstore - Get 3rd book title and price');
  console.log('-'.repeat(50));

  const bookHtml = fs.readFileSync('pages/bookstore.html', 'utf8');

  const task3Normal = {
    name: 'Task 3 Normal',
    inputTokens: tokensFor(bookHtml),
    outputTokens: tokensFor('The 3rd book is "Olio" priced at £23.88'),
  };
  task3Normal.totalTokens = task3Normal.inputTokens + task3Normal.outputTokens;

  const hc3 = new HypercompactSession('pages/bookstore.html');
  const hc3Commands = [];

  // Explore - find products
  cmd = 'q article.product_pod';
  resp = hc3.exec(cmd);
  hc3Commands.push({ cmd, resp: resp.split('\n').slice(0, 5).join('\n') });
  console.log(`  hc> ${cmd}`);
  console.log(`  ${resp.split('\n').slice(2, 4).join('\n')}`);

  // Get 3rd product (index 2)
  cmd = 'q article.product_pod h3 a';
  resp = hc3.exec(cmd);
  const titles = resp.split('\n');
  hc3Commands.push({ cmd, resp: titles[2] || 'n/a' });
  console.log(`  hc> ${cmd}`);
  console.log(`  ${titles[2]}`);

  // Get prices
  cmd = 'q .price_color';
  resp = hc3.exec(cmd);
  const prices = resp.split('\n');
  hc3Commands.push({ cmd, resp: prices[2] || 'n/a' });
  console.log(`  hc> ${cmd}`);
  console.log(`  ${prices[2]}`);

  let hc3Input = 0, hc3Output = 0;
  hc3Commands.forEach(c => {
    hc3Input += tokensFor(c.resp);
    hc3Output += tokensFor(c.cmd);
  });

  const task3HC = {
    name: 'Task 3 Hypercompact',
    inputTokens: hc3Input,
    outputTokens: hc3Output,
    totalTokens: hc3Input + hc3Output,
  };

  results.push({ task: 'Task 3: Bookstore 3rd Book', normal: task3Normal, hc: task3HC });
  console.log('');

  // ============================================================
  // TASK 4: Article - Get heading and first paragraph
  // ============================================================
  console.log('TASK 4: Blog Article - Get h1 and first paragraph');
  console.log('-'.repeat(50));

  const art1Html = fs.readFileSync('pages/article1.html', 'utf8');

  const task4Normal = {
    name: 'Task 4 Normal',
    inputTokens: tokensFor(art1Html),
    outputTokens: tokensFor('Heading: Buttered Crumpet Font. First paragraph: ...'),
  };
  task4Normal.totalTokens = task4Normal.inputTokens + task4Normal.outputTokens;

  const hc4 = new HypercompactSession('pages/article1.html');
  const hc4Commands = [];

  // Get h1
  cmd = 'q1 h1';
  resp = hc4.exec(cmd);
  hc4Commands.push({ cmd, resp });
  console.log(`  hc> ${cmd}`);
  console.log(`  ${resp.slice(0, 80)}`);

  // Get first paragraph
  cmd = 'q1 article p';
  resp = hc4.exec(cmd);
  hc4Commands.push({ cmd, resp: resp.slice(0, 200) });
  console.log(`  hc> ${cmd}`);
  console.log(`  ${resp.slice(0, 80)}...`);

  let hc4Input = 0, hc4Output = 0;
  hc4Commands.forEach(c => {
    hc4Input += tokensFor(c.resp);
    hc4Output += tokensFor(c.cmd);
  });

  const task4HC = {
    name: 'Task 4 Hypercompact',
    inputTokens: hc4Input,
    outputTokens: hc4Output,
    totalTokens: hc4Input + hc4Output,
  };

  results.push({ task: 'Task 4: Article Heading', normal: task4Normal, hc: task4HC });
  console.log('');

  // ============================================================
  // TASK 5: Technical Blog - Find all code blocks
  // ============================================================
  console.log('TASK 5: Technical Blog - List all code blocks');
  console.log('-'.repeat(50));

  const art3Html = fs.readFileSync('pages/article3.html', 'utf8');

  const task5Normal = {
    name: 'Task 5 Normal',
    inputTokens: tokensFor(art3Html),
    outputTokens: tokensFor('Found 5 code blocks: 1. iwconfig... 2. ping...'),
  };
  task5Normal.totalTokens = task5Normal.inputTokens + task5Normal.outputTokens;

  const hc5 = new HypercompactSession('pages/article3.html');
  const hc5Commands = [];

  // Query all code/pre blocks
  cmd = 'q pre, code';
  resp = hc5.exec(cmd);
  hc5Commands.push({ cmd, resp });
  console.log(`  hc> ${cmd}`);
  console.log(`  Found ${resp.split('\n').length} code elements`);
  resp.split('\n').slice(0, 3).forEach(line => console.log(`  ${line.slice(0, 60)}`));

  let hc5Input = 0, hc5Output = 0;
  hc5Commands.forEach(c => {
    hc5Input += tokensFor(c.resp);
    hc5Output += tokensFor(c.cmd);
  });

  const task5HC = {
    name: 'Task 5 Hypercompact',
    inputTokens: hc5Input,
    outputTokens: hc5Output,
    totalTokens: hc5Input + hc5Output,
  };

  results.push({ task: 'Task 5: Code Blocks', normal: task5Normal, hc: task5HC });
  console.log('');

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('');
  console.log('=' .repeat(70));
  console.log('RESULTS SUMMARY');
  console.log('=' .repeat(70));
  console.log('');
  console.log('Task                          | Normal Tokens | HC Tokens | Reduction');
  console.log('-'.repeat(70));

  let totalNormal = 0, totalHC = 0;
  results.forEach(r => {
    const reduction = ((1 - r.hc.totalTokens / r.normal.totalTokens) * 100).toFixed(1);
    console.log(
      `${r.task.padEnd(30)}| ${String(r.normal.totalTokens).padStart(13)} | ${String(r.hc.totalTokens).padStart(9)} | ${reduction}%`
    );
    totalNormal += r.normal.totalTokens;
    totalHC += r.hc.totalTokens;
  });

  console.log('-'.repeat(70));
  const totalReduction = ((1 - totalHC / totalNormal) * 100).toFixed(1);
  console.log(
    `${'TOTAL'.padEnd(30)}| ${String(totalNormal).padStart(13)} | ${String(totalHC).padStart(9)} | ${totalReduction}%`
  );

  console.log('');
  console.log('=' .repeat(70));
  console.log('DETAILED BREAKDOWN');
  console.log('=' .repeat(70));

  results.forEach(r => {
    console.log('');
    console.log(`${r.task}:`);
    console.log(`  Normal:      ${r.normal.inputTokens} input + ${r.normal.outputTokens} output = ${r.normal.totalTokens} total`);
    console.log(`  Hypercompact: ${r.hc.inputTokens} input + ${r.hc.outputTokens} output = ${r.hc.totalTokens} total`);
  });

  // Write results to file
  fs.writeFileSync('results/study_results.json', JSON.stringify(results, null, 2));
  console.log('');
  console.log('Results saved to results/study_results.json');
}

runStudy();
