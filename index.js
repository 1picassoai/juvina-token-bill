#!/usr/bin/env node
'use strict';

/*
 * Juvina Token Bill - estimate your AI coding-assistant spend from local logs.
 * Runs locally; reads only your own log files; makes no network calls.
 * MIT License - https://juvina.ai
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const FLAT_RECALL_TOKENS = 1300; // modelled flat-recall context per later turn

// ---------------------------------------------------------------------------
// Pricing (Est.) - USD per million tokens. Static table; matched by substring,
// first hit wins. cacheRead defaults to 10% of input, cacheWrite to 125%.
// All figures are estimates; your actual billing may differ.
// ---------------------------------------------------------------------------
const PRICING = [
  //  [substring,      $/MTok in, $/MTok out, $/MTok cache-read (optional)]
  ['fable-5-1', 10, 50, 0.25],
  ['fable', 10, 50],
  ['mythos', 10, 50],
  ['opus-4-1', 15, 75],
  ['opus-4-0', 15, 75],
  ['opus-4-5', 5, 25],
  ['opus-4-6', 5, 25],
  ['opus-4-7', 5, 25],
  ['opus-4-8', 5, 25],
  ['opus-5', 5, 25],
  ['opus-4', 15, 75],
  ['opus-3', 15, 75],
  ['opus', 5, 25],
  ['sonnet-4-6', 3, 15],
  ['sonnet-5', 2, 10],
  ['sonnet', 3, 15],
  ['haiku-4-5', 1, 5],
  ['haiku-3-5', 0.8, 4],
  ['haiku-3', 0.25, 1.25],
  ['haiku', 1, 5],
];
const FALLBACK_RATE = { input: 3, output: 15, cacheRead: 0.3 }; // unknown-model default

function ratesFor(model) {
  const m = String(model || '').toLowerCase();
  for (const [sub, inRate, outRate, crRate] of PRICING) {
    if (m.includes(sub)) {
      return {
        input: inRate,
        output: outRate,
        cacheRead: crRate !== undefined ? crRate : inRate * 0.1,
        cacheWrite: inRate * 1.25,
        known: true,
      };
    }
  }
  return {
    input: FALLBACK_RATE.input,
    output: FALLBACK_RATE.output,
    cacheRead: FALLBACK_RATE.cacheRead,
    cacheWrite: FALLBACK_RATE.input * 1.25,
    known: false,
  };
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { days: null, json: false, explain: false, help: false, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') {
      opts.days = Number(argv[++i]);
      if (!Number.isFinite(opts.days) || opts.days <= 0) {
        console.error('juvina-token-bill: --days needs a positive number');
        process.exit(1);
      }
    } else if (a.startsWith('--days=')) {
      opts.days = Number(a.slice(7));
      if (!Number.isFinite(opts.days) || opts.days <= 0) {
        console.error('juvina-token-bill: --days needs a positive number');
        process.exit(1);
      }
    } else if (a === '--json') opts.json = true;
    else if (a === '--explain') opts.explain = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--dir') opts.dir = argv[++i];
    else if (a.startsWith('--dir=')) opts.dir = a.slice(6);
  }
  return opts;
}

const HELP = `
Juvina Token Bill - estimate your AI coding-assistant spend from local logs.

Usage: npx juvina-token-bill [options]

Options:
  --days N     Look at the last N days (default: current calendar month)
  --json       Machine-readable output
  --explain    Print the full estimation formula
  --dir PATH   Transcript directory (default: ~/.claude/projects)
  -h, --help   This help

Data source: Claude Code local transcripts (~/.claude/projects/**/*.jsonl).
Runs locally; reads only your own log files; makes no network calls.
All money figures are estimates.
`;

const EXPLAIN = `
How the estimate works
----------------------
1. Every assistant turn in your local Claude Code transcripts carries token
   usage: input_tokens, output_tokens, cache_creation_input_tokens and
   cache_read_input_tokens. Turns are de-duplicated by message id.

2. A turn's "context" = input + cache-creation + cache-read tokens. That is
   everything the model was sent for that turn, including the whole
   conversation history so far.

3. Per session, the first turn's context is the baseline (system prompt,
   tools, your first message). On every later turn, context above that
   baseline is counted as re-sent history.

4. Costing (Est.): input tokens at the model's input rate, cache writes at
   1.25x input, cache reads at the cache-read rate, output at the output
   rate. Re-sent history is priced at each turn's blended context rate, so
   cheap cache-read tokens stay cheap in the estimate.

5. The "flat recall" line re-prices each later turn as if its context were
   baseline + ${FLAT_RECALL_TOKENS} tokens (a targeted memory recall instead of the full
   history), at the same blended rate. Output tokens are unchanged.

Everything is an estimate: rates are a static table, cache pricing is
approximated, and your billing plan may differ.
`;

// ---------------------------------------------------------------------------
// Transcript scanning
// ---------------------------------------------------------------------------
function findTranscripts(root) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) out.push(...findTranscripts(p));
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

async function scanFile(file, since, turnsBySession, seenIds) {
  let stream;
  try {
    stream = fs.createReadStream(file, { encoding: 'utf8' });
  } catch {
    return;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line || line.length < 2) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // skip unparseable lines silently
      }
      if (!obj || obj.type !== 'assistant' || !obj.message) continue;
      const usage = obj.message.usage;
      if (!usage || typeof usage !== 'object') continue;

      const id = obj.message.id || obj.requestId;
      if (id) {
        if (seenIds.has(id)) continue; // one API response = many lines; count once
        seenIds.add(id);
      }

      const ts = Date.parse(obj.timestamp || '');
      if (!Number.isFinite(ts) || ts < since) continue;

      const input = Number(usage.input_tokens) || 0;
      const output = Number(usage.output_tokens) || 0;
      const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
      const cacheRead = Number(usage.cache_read_input_tokens) || 0;
      if (input + output + cacheWrite + cacheRead === 0) continue;

      const sessionKey = obj.sessionId || file;
      let turns = turnsBySession.get(sessionKey);
      if (!turns) {
        turns = [];
        turnsBySession.set(sessionKey, turns);
      }
      turns.push({ ts, model: obj.message.model, input, output, cacheWrite, cacheRead });
    }
  } catch {
    /* unreadable tail of a live file etc. - keep what we have */
  }
}

// ---------------------------------------------------------------------------
// The estimate
// ---------------------------------------------------------------------------
function analyze(turnsBySession) {
  const totals = {
    sessions: 0,
    turns: 0,
    tokens: 0,
    cost: 0,
    resentTokens: 0,
    resentCost: 0,
    flatCost: 0,
    unknownModels: new Set(),
  };

  for (const turns of turnsBySession.values()) {
    if (turns.length === 0) continue;
    turns.sort((a, b) => a.ts - b.ts);
    totals.sessions++;

    const baseline = turns[0].input + turns[0].cacheWrite + turns[0].cacheRead;

    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const r = ratesFor(t.model);
      if (!r.known && t.model) totals.unknownModels.add(t.model);

      const ctx = t.input + t.cacheWrite + t.cacheRead;
      const ctxCost =
        (t.input * r.input + t.cacheWrite * r.cacheWrite + t.cacheRead * r.cacheRead) / 1e6;
      const outCost = (t.output * r.output) / 1e6;
      const turnCost = ctxCost + outCost;

      totals.turns++;
      totals.tokens += ctx + t.output;
      totals.cost += turnCost;

      if (i === 0 || ctx === 0) {
        totals.flatCost += turnCost;
        continue;
      }

      const blended = ctxCost / ctx; // $ per context token this turn, cache-aware
      const resent = Math.max(0, ctx - baseline);
      totals.resentTokens += resent;
      totals.resentCost += resent * blended;

      const modelledCtx = Math.min(ctx, baseline + FLAT_RECALL_TOKENS);
      totals.flatCost += modelledCtx * blended + outCost;
    }
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
function fmtMoney(n) {
  return '$' + n.toFixed(2);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP.trim());
    return;
  }

  const root = opts.dir || path.join(os.homedir(), '.claude', 'projects');

  const now = new Date();
  let since, windowLabel;
  if (opts.days != null) {
    since = now.getTime() - opts.days * 24 * 60 * 60 * 1000;
    windowLabel = `last ${opts.days} day${opts.days === 1 ? '' : 's'}`;
  } else {
    since = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    windowLabel = 'this month';
  }

  const files = findTranscripts(root);
  if (files.length === 0) {
    console.error(`juvina-token-bill: no Claude Code transcripts found under ${root}`);
    console.error('Nothing to report. (This tool reads only your own local log files.)');
    process.exit(2);
  }

  const turnsBySession = new Map();
  const seenIds = new Set();
  for (const f of files) await scanFile(f, since, turnsBySession, seenIds);

  const t = analyze(turnsBySession);
  const keep = Math.max(0, t.cost - t.flatCost);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          window: windowLabel,
          since: new Date(since).toISOString(),
          source: root,
          sessions: t.sessions,
          turns: t.turns,
          tokens: t.tokens,
          estCostUsd: +t.cost.toFixed(2),
          resentHistoryTokens: t.resentTokens,
          estResentCostUsd: +t.resentCost.toFixed(2),
          estFlatRecallCostUsd: +t.flatCost.toFixed(2),
          estKeepUsd: +keep.toFixed(2),
          flatRecallTokensPerTurn: FLAT_RECALL_TOKENS,
          unknownModels: [...t.unknownModels],
          note: 'All money figures are estimates. Runs locally; reads only your own log files; makes no network calls.',
        },
        null,
        2
      )
    );
    return;
  }

  console.log('');
  console.log('⚡ Juvina Token Bill');
  console.log('');
  console.log(`${windowLabel[0].toUpperCase() + windowLabel.slice(1)} with Claude Code:`);
  console.log(
    `  Sessions: ${t.sessions}   Tokens: ${fmtTokens(t.tokens)}   Est. cost: ${fmtMoney(t.cost)}`
  );
  console.log(
    `  Of which re-sent history: ~${fmtTokens(t.resentTokens)} (~${fmtMoney(t.resentCost)})`
  );
  console.log('');
  console.log(
    `Same period if history were flat recalls (~${FLAT_RECALL_TOKENS.toLocaleString()} tok/turn): ~${fmtMoney(t.flatCost)}`
  );
  console.log(`${' '.repeat(42)}You'd keep: ~${fmtMoney(keep)}`);
  console.log('');
  if (t.unknownModels.size > 0) {
    console.log(
      `Note: unrecognised model id(s) priced at a default rate: ${[...t.unknownModels].join(', ')}`
    );
  }
  console.log('Method: input tokens beyond each session’s first turn ≈ re-sent context;');
  console.log(
    `flat-recall model = first-turn size + ${FLAT_RECALL_TOKENS.toLocaleString()} tokens/turn. Full formula: --explain`
  );
  console.log('Curable → https://juvina.ai');
  console.log('');

  if (opts.explain) console.log(EXPLAIN.trim() + '\n');
}

main().catch((err) => {
  console.error('juvina-token-bill: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
