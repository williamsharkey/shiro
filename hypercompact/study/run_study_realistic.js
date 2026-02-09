#!/usr/bin/env node
/**
 * Hypercompact Study Runner - REALISTIC VERSION
 * Includes MCP/tool call overhead in calculations
 */

const fs = require('fs');
const { HypercompactSession } = require('./hc_tool.js');

// Token estimation: ~4 chars per token
const charsPerToken = 4;
const tokensFor = (str) => Math.ceil(str.length / charsPerToken);

// MCP OVERHEAD CONSTANTS (based on real JSON-RPC structure)
// Request: {"jsonrpc":"2.0","id":N,"method":"tools/call","params":{"name":"hc","arguments":{"c":"CMD"}}}
// Response: {"jsonrpc":"2.0","id":N,"result":{"content":[{"type":"text","text":"RESULT"}]}}
const MCP_REQUEST_OVERHEAD = 23;   // ~90 chars of JSON wrapper
const MCP_RESPONSE_OVERHEAD = 22;  // ~88 chars of JSON wrapper
const MCP_OVERHEAD_PER_CALL = MCP_REQUEST_OVERHEAD + MCP_RESPONSE_OVERHEAD; // 45 tokens

// For "normal" approach - one read tool call
const READ_TOOL_OVERHEAD = 30;  // Tool definition + call overhead

const results = [];

function runStudy() {
  console.log('=' .repeat(70));
  console.log('HYPERCOMPACT TOKEN EFFICIENCY STUDY (REALISTIC)');
  console.log('Includes MCP/JSON-RPC overhead per tool call');
  console.log('=' .repeat(70));
  console.log('');
  console.log(`MCP overhead per command: ~${MCP_OVERHEAD_PER_CALL} tokens`);
  console.log('');

  // ============================================================
  // TASK 1: Hacker News - Get #1 story details
  // ============================================================
  console.log('TASK 1: Hacker News - Get #1 story title, points, author');
  console.log('-'.repeat(50));

  const hnHtml = fs.readFileSync('pages/hn.html', 'utf8');

  // Normal approach: read full HTML (1 tool call)
  const task1Normal = {
    name: 'Task 1 Normal',
    toolCalls: 1,
    inputTokens: tokensFor(hnHtml) + READ_TOOL_OVERHEAD,
    outputTokens: tokensFor('The #1 story is "Buttered Crumpet, a custom typeface for Wallace and Gromit" with 67 points by tobr'),
  };
  task1Normal.totalTokens = task1Normal.inputTokens + task1Normal.outputTokens;

  // Hypercompact approach (3 commands)
  const hc1 = new HypercompactSession('pages/hn.html');
  const hc1Commands = [
    { cmd: 'q .titleline', resp: hc1.exec('q .titleline').split('\n')[0] },
    { cmd: 'q .score', resp: hc1.exec('q .score').split('\n')[0] },
    { cmd: 'q .hnuser', resp: hc1.exec('q .hnuser').split('\n')[0] },
  ];

  let hc1Content = 0;
  hc1Commands.forEach(c => {
    hc1Content += tokensFor(c.cmd) + tokensFor(c.resp);
    console.log(`  hc> ${c.cmd} → ${c.resp.slice(0, 50)}`);
  });

  const task1HC = {
    name: 'Task 1 Hypercompact',
    toolCalls: hc1Commands.length,
    contentTokens: hc1Content,
    overheadTokens: hc1Commands.length * MCP_OVERHEAD_PER_CALL,
    totalTokens: hc1Content + (hc1Commands.length * MCP_OVERHEAD_PER_CALL),
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
    toolCalls: 1,
    inputTokens: tokensFor(wikiHtml) + READ_TOOL_OVERHEAD,
    outputTokens: tokensFor('Claude is a family of large language models developed by Anthropic...'),
  };
  task2Normal.totalTokens = task2Normal.inputTokens + task2Normal.outputTokens;

  const hc2 = new HypercompactSession('pages/wikipedia.html');
  const hc2Commands = [
    { cmd: 't500', resp: hc2.exec('t500').slice(0, 200) },
    { cmd: 'q1 .mw-parser-output > p', resp: hc2.exec('q1 .mw-parser-output > p').slice(0, 200) },
  ];

  let hc2Content = 0;
  hc2Commands.forEach(c => {
    hc2Content += tokensFor(c.cmd) + tokensFor(c.resp);
    console.log(`  hc> ${c.cmd} → ${c.resp.slice(0, 50)}...`);
  });

  const task2HC = {
    name: 'Task 2 Hypercompact',
    toolCalls: hc2Commands.length,
    contentTokens: hc2Content,
    overheadTokens: hc2Commands.length * MCP_OVERHEAD_PER_CALL,
    totalTokens: hc2Content + (hc2Commands.length * MCP_OVERHEAD_PER_CALL),
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
    toolCalls: 1,
    inputTokens: tokensFor(bookHtml) + READ_TOOL_OVERHEAD,
    outputTokens: tokensFor('The 3rd book is "Soumission" priced at £50.10'),
  };
  task3Normal.totalTokens = task3Normal.inputTokens + task3Normal.outputTokens;

  const hc3 = new HypercompactSession('pages/bookstore.html');
  const hc3Commands = [
    { cmd: 'q article.product_pod h3 a', resp: hc3.exec('q article.product_pod h3 a').split('\n')[2] },
    { cmd: 'q .price_color', resp: hc3.exec('q .price_color').split('\n')[2] },
  ];

  let hc3Content = 0;
  hc3Commands.forEach(c => {
    hc3Content += tokensFor(c.cmd) + tokensFor(c.resp);
    console.log(`  hc> ${c.cmd} → ${c.resp}`);
  });

  const task3HC = {
    name: 'Task 3 Hypercompact',
    toolCalls: hc3Commands.length,
    contentTokens: hc3Content,
    overheadTokens: hc3Commands.length * MCP_OVERHEAD_PER_CALL,
    totalTokens: hc3Content + (hc3Commands.length * MCP_OVERHEAD_PER_CALL),
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
    toolCalls: 1,
    inputTokens: tokensFor(art1Html) + READ_TOOL_OVERHEAD,
    outputTokens: tokensFor('Heading: Wallace and Gromit Font. First paragraph: ...'),
  };
  task4Normal.totalTokens = task4Normal.inputTokens + task4Normal.outputTokens;

  const hc4 = new HypercompactSession('pages/article1.html');

  // Need to discover structure first
  const hc4Commands = [
    { cmd: 't200', resp: hc4.exec('t200').slice(0, 100) },
    { cmd: 'q1 h1', resp: hc4.exec('q1 h1') },
    { cmd: 'q1 main p, q1 .content p', resp: hc4.exec('q1 main p').slice(0, 150) || 'searching...' },
  ];

  let hc4Content = 0;
  hc4Commands.forEach(c => {
    hc4Content += tokensFor(c.cmd) + tokensFor(c.resp);
    console.log(`  hc> ${c.cmd} → ${c.resp.slice(0, 50)}...`);
  });

  const task4HC = {
    name: 'Task 4 Hypercompact',
    toolCalls: hc4Commands.length,
    contentTokens: hc4Content,
    overheadTokens: hc4Commands.length * MCP_OVERHEAD_PER_CALL,
    totalTokens: hc4Content + (hc4Commands.length * MCP_OVERHEAD_PER_CALL),
  };

  results.push({ task: 'Task 4: Article Heading', normal: task4Normal, hc: task4HC });
  console.log('');

  // ============================================================
  // TASK 5: Technical Blog - Find code blocks
  // ============================================================
  console.log('TASK 5: Technical Blog - List all code blocks');
  console.log('-'.repeat(50));

  const art3Html = fs.readFileSync('pages/article3.html', 'utf8');

  const task5Normal = {
    name: 'Task 5 Normal',
    toolCalls: 1,
    inputTokens: tokensFor(art3Html) + READ_TOOL_OVERHEAD,
    outputTokens: tokensFor('Found 5 code blocks with commands...'),
  };
  task5Normal.totalTokens = task5Normal.inputTokens + task5Normal.outputTokens;

  const hc5 = new HypercompactSession('pages/article3.html');
  const codeResp = hc5.exec('q pre, q code');
  const hc5Commands = [
    { cmd: 'q pre, code', resp: codeResp },
  ];

  let hc5Content = 0;
  hc5Commands.forEach(c => {
    hc5Content += tokensFor(c.cmd) + tokensFor(c.resp);
    console.log(`  hc> ${c.cmd} → Found ${c.resp.split('\n').length} elements`);
  });

  const task5HC = {
    name: 'Task 5 Hypercompact',
    toolCalls: hc5Commands.length,
    contentTokens: hc5Content,
    overheadTokens: hc5Commands.length * MCP_OVERHEAD_PER_CALL,
    totalTokens: hc5Content + (hc5Commands.length * MCP_OVERHEAD_PER_CALL),
  };

  results.push({ task: 'Task 5: Code Blocks', normal: task5Normal, hc: task5HC });
  console.log('');

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('');
  console.log('=' .repeat(80));
  console.log('RESULTS SUMMARY (WITH MCP OVERHEAD)');
  console.log('=' .repeat(80));
  console.log('');
  console.log('Task                          | Normal    | HC (content) | HC (w/overhead) | Reduction');
  console.log('-'.repeat(80));

  let totalNormal = 0, totalHCContent = 0, totalHC = 0;
  results.forEach(r => {
    const reduction = ((1 - r.hc.totalTokens / r.normal.totalTokens) * 100).toFixed(1);
    console.log(
      `${r.task.padEnd(30)}| ${String(r.normal.totalTokens).padStart(9)} | ${String(r.hc.contentTokens).padStart(12)} | ${String(r.hc.totalTokens).padStart(15)} | ${reduction}%`
    );
    totalNormal += r.normal.totalTokens;
    totalHCContent += r.hc.contentTokens;
    totalHC += r.hc.totalTokens;
  });

  console.log('-'.repeat(80));
  const totalReduction = ((1 - totalHC / totalNormal) * 100).toFixed(1);
  console.log(
    `${'TOTAL'.padEnd(30)}| ${String(totalNormal).padStart(9)} | ${String(totalHCContent).padStart(12)} | ${String(totalHC).padStart(15)} | ${totalReduction}%`
  );

  console.log('');
  console.log('=' .repeat(80));
  console.log('BREAKDOWN BY COMPONENT');
  console.log('=' .repeat(80));
  console.log('');

  let totalCalls = 0;
  results.forEach(r => {
    totalCalls += r.hc.toolCalls;
    console.log(`${r.task}:`);
    console.log(`  Normal: ${r.normal.inputTokens} (HTML) + ${r.normal.outputTokens} (response) = ${r.normal.totalTokens}`);
    console.log(`  HC: ${r.hc.contentTokens} (content) + ${r.hc.overheadTokens} (${r.hc.toolCalls} calls × ${MCP_OVERHEAD_PER_CALL}) = ${r.hc.totalTokens}`);
    console.log('');
  });

  console.log('=' .repeat(80));
  console.log('KEY INSIGHTS');
  console.log('=' .repeat(80));
  console.log(`Total tool calls in HC approach: ${totalCalls}`);
  console.log(`Total MCP overhead: ${totalCalls * MCP_OVERHEAD_PER_CALL} tokens`);
  console.log(`Content-only reduction: ${((1 - totalHCContent / totalNormal) * 100).toFixed(1)}%`);
  console.log(`With overhead reduction: ${totalReduction}%`);
  console.log('');

  // BATCHED VERSION
  console.log('=' .repeat(80));
  console.log('IF BATCHED (all commands in 1 call per task):');
  console.log('=' .repeat(80));
  const batchedOverhead = results.length * MCP_OVERHEAD_PER_CALL;  // 5 tasks = 5 calls
  const batchedTotal = totalHCContent + batchedOverhead;
  const batchedReduction = ((1 - batchedTotal / totalNormal) * 100).toFixed(1);
  console.log(`Batched HC total: ${totalHCContent} (content) + ${batchedOverhead} (5 calls) = ${batchedTotal}`);
  console.log(`Batched reduction: ${batchedReduction}%`);

  // Save results
  fs.writeFileSync('results/study_results_realistic.json', JSON.stringify({
    results,
    totals: { normal: totalNormal, hcContent: totalHCContent, hcTotal: totalHC, batchedTotal },
    mcpOverhead: MCP_OVERHEAD_PER_CALL,
  }, null, 2));

  console.log('');
  console.log('Results saved to results/study_results_realistic.json');
}

runStudy();
