#!/usr/bin/env node
'use strict';

/*
 * Juvina Token Bill - see how much of your AI coding usage is re-sent history,
 * and what that repetition would cost at published API rates.
 * Runs locally; reads only your own log files; makes no network calls.
 * MIT License - https://juvina.ai
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');

const FLAT_RECALL_TOKENS = 1300; // modelled flat-recall context per later turn

// ---------------------------------------------------------------------------
// Pricing (Est.) - USD per million tokens. Static table; matched by substring,
// first hit wins. cacheRead defaults to 10% of input, cacheWrite to 125%.
// All figures are estimates; your actual billing may differ.
// ---------------------------------------------------------------------------
const PRICING = [
  //  [substring,      $/MTok in, $/MTok out, $/MTok cache-read (optional)]
  ['fable-5-1', 10, 50, 0.25],
  ['mythos-5-1', 10, 50, 0.25],
  ['fable', 10, 50],
  ['mythos', 10, 50],
  ['opus-4-1', 15, 75],
  ['opus-4-0', 15, 75],
  ['opus-4-5', 5, 25],
  ['opus-4-6', 5, 25],
  ['opus-4-7', 5, 25],
  ['opus-4-8', 5, 25],
  ['opus-5', 5, 25],
  ['3-opus', 15, 75], // legacy id form: claude-3-opus-YYYYMMDD
  ['opus-4', 15, 75],
  ['opus', 5, 25],
  ['sonnet-4-6', 3, 15],
  ['sonnet-5', 2, 10],
  ['sonnet', 3, 15],
  ['haiku-4-5', 1, 5],
  ['3-5-haiku', 0.8, 4], // legacy id form: claude-3-5-haiku-YYYYMMDD
  ['3-haiku', 0.25, 1.25], // legacy id form: claude-3-haiku-YYYYMMDD
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
  const opts = {
    days: null,
    json: false,
    explain: false,
    help: false,
    dir: null,
    noOpen: false,
    noHtml: false,
  };
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
    else if (a === '--no-open') opts.noOpen = true;
    else if (a === '--no-html') opts.noHtml = true;
  }
  return opts;
}

const HELP = `
Juvina Token Bill - see how much of your AI coding usage is re-sent history,
and what that repetition would cost at published pay-as-you-go API rates.

Usage: npx juvina-token-bill [options]

Options:
  --days N     Look at the last N days (default: current calendar month)
  --json       Machine-readable output
  --explain    Print the full estimation formula
  --dir PATH   Transcript directory (default: ~/.claude/projects)
  --no-open    Write the HTML report card but don't open the browser
  --no-html    Skip the HTML report card entirely
  -h, --help   This help

Besides the terminal summary, a self-contained report card is written to
./juvina-token-bill-report.html and opened in your default browser.

Data source: Claude Code local transcripts (~/.claude/projects/**/*.jsonl).
Runs locally; reads only your own log files; makes no network calls.
All money figures are estimates of API-rate value, not your actual bill:
on a Claude Pro/Max subscription you pay a flat monthly fee.
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

4. API-rate value (Est.): input tokens at the model's published API input rate, cache writes at
   1.25x input, cache reads at the cache-read rate, output at the output
   rate. Re-sent history is priced at each turn's blended context rate, so
   cheap cache-read tokens stay cheap in the estimate.

5. The "flat recall" line re-prices each later turn as if its context were
   baseline + ${FLAT_RECALL_TOKENS} tokens (a targeted memory recall instead of the full
   history), at the same blended rate. Output tokens are unchanged.

Everything is an estimate, and every money figure is API-rate value - what
this usage would cost on pay-as-you-go at published API rates - not your
actual bill. On a Claude Pro/Max subscription you pay a flat monthly fee.
The re-sent-history percentage is plan-independent.
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
// HTML report card
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtmlReport(t, keep, windowLabel) {
  const resentPct = t.tokens > 0 ? (t.resentTokens / t.tokens) * 100 : 0;
  const uniquePct = 100 - resentPct;
  const resentPctLabel = resentPct.toFixed(0) + '%';
  const uniquePctLabel = uniquePct.toFixed(0) + '%';
  const generated = new Date().toLocaleString();
  const unknownNote =
    t.unknownModels.size > 0
      ? `<p class="note">Unrecognised model id(s) priced at a default rate: ${escapeHtml([...t.unknownModels].join(', '))}</p>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Juvina Token Bill</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0d1117;
    color: #e6edf3;
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px 16px;
  }
  .card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 16px;
    padding: 40px 44px;
    max-width: 680px;
    width: 100%;
    box-shadow: 0 8px 32px rgba(0,0,0,.45);
  }
  h1 { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; }
  .range { color: #8b949e; font-size: 14px; margin-top: 6px; }
  .hero { margin: 34px 0 10px; }
  .hero .heropct {
    font-size: 84px;
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1;
    background: linear-gradient(90deg, #d1242f, #e8942a);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .hero .herolabel { font-size: 20px; font-weight: 600; margin-top: 8px; }
  .subhead { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; margin-top: 30px; }
  .bignums { display: flex; gap: 48px; margin: 10px 0 6px; flex-wrap: wrap; }
  .bignum .label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
  .bignum .value { font-size: 30px; font-weight: 700; margin-top: 4px; letter-spacing: -0.02em; }
  .framing { color: #c9d1d9; font-size: 13px; line-height: 1.6; margin-top: 12px; }
  .bar {
    display: flex;
    height: 34px;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid #30363d;
    font-size: 12px;
    font-weight: 600;
  }
  .bar .seg { display: flex; align-items: center; justify-content: center; white-space: nowrap; overflow: hidden; }
  .bar .resent { background: linear-gradient(90deg, #d1242f, #e8942a); color: #fff; }
  .bar .unique { background: #30363d; color: #c9d1d9; }
  .legend { display: flex; gap: 20px; margin-top: 10px; font-size: 13px; color: #8b949e; }
  .legend .dot { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: baseline; }
  .dot.red { background: linear-gradient(90deg, #d1242f, #e8942a); }
  .dot.grey { background: #30363d; }
  .counterfactual {
    margin: 30px 0 8px;
    padding: 18px 20px;
    background: rgba(46,160,67,.12);
    border: 1px solid rgba(46,160,67,.4);
    border-radius: 10px;
    color: #3fb950;
    font-size: 20px;
    font-weight: 600;
    line-height: 1.5;
  }
  .counterfactual .keep { font-size: 26px; font-weight: 700; }
  .method { color: #8b949e; font-size: 12px; line-height: 1.6; margin-top: 26px; }
  .method a { color: #58a6ff; text-decoration: none; }
  .note { color: #8b949e; font-size: 12px; margin-top: 12px; }
  .footer {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid #30363d;
    color: #6e7681;
    font-size: 12px;
  }
</style>
</head>
<body>
  <div class="card">
    <h1>⚡ Juvina Token Bill</h1>
    <div class="range">${escapeHtml(windowLabel[0].toUpperCase() + windowLabel.slice(1))} with Claude Code · ${t.sessions} session${t.sessions === 1 ? '' : 's'} · ${escapeHtml(fmtTokens(t.tokens))} tokens · generated ${escapeHtml(generated)}</div>

    <div class="hero">
      <div class="heropct">${resentPctLabel}</div>
      <div class="herolabel">of your AI usage was re-sent history (~${escapeHtml(fmtTokens(t.resentTokens))} tokens)</div>
    </div>

    <div class="bar">
      <div class="seg resent" style="width:${resentPct.toFixed(1)}%">${resentPct >= 12 ? 'Re-sent history ' + resentPctLabel : ''}</div>
      <div class="seg unique" style="width:${uniquePct.toFixed(1)}%">${uniquePct >= 12 ? 'Unique content ' + uniquePctLabel : ''}</div>
    </div>
    <div class="legend">
      <span><span class="dot red"></span>Re-sent history ~${escapeHtml(fmtTokens(t.resentTokens))} (${resentPctLabel})</span>
      <span><span class="dot grey"></span>Unique content (${uniquePctLabel})</span>
    </div>

    <div class="subhead">What this usage would cost on pay-as-you-go</div>
    <div class="bignums">
      <div class="bignum">
        <div class="label">Est. API-rate value</div>
        <div class="value">${escapeHtml(fmtMoney(t.cost))}</div>
      </div>
      <div class="bignum">
        <div class="label">Of which re-sent history</div>
        <div class="value">~${escapeHtml(fmtMoney(t.resentCost))}</div>
      </div>
    </div>
    <p class="framing">
      On a Claude Pro/Max subscription you pay a flat monthly fee — the figure
      above is what the same usage would cost at published API rates. Either
      way, the share above is what's re-sent history.
    </p>

    <div class="counterfactual">
      Same period with flat recalls: ${resentPctLabel} of tokens not re-sent — ~${escapeHtml(fmtMoney(t.flatCost))} in API-rate terms (est.)<br>
      Est. API-rate value kept: <span class="keep">~${escapeHtml(fmtMoney(keep))}</span>
    </div>
    ${unknownNote}
    <p class="method">
      Method: input tokens beyond each session’s first turn ≈ re-sent context;
      flat-recall model = first-turn size + ${FLAT_RECALL_TOKENS.toLocaleString()} tokens/turn.
      Estimates at published API rates — your plan and rates may differ.
      Full formula: <code>npx juvina-token-bill --explain</code>.
      Curable → <a href="https://juvina.ai">juvina.ai</a>
    </p>
    <div class="footer">Generated locally · reads only your own log files · makes no network calls</div>
  </div>
</body>
</html>
`;
}

function openInBrowser(file) {
  try {
    let cmd, args;
    if (process.platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', file];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = [file];
    } else {
      cmd = 'xdg-open';
      args = [file];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // headless / no browser - fail silently
    child.unref();
  } catch {
    /* fail silently */
  }
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
          resentHistoryPct: +(t.tokens > 0 ? (t.resentTokens / t.tokens) * 100 : 0).toFixed(1),
          estCostUsd: +t.cost.toFixed(2),
          resentHistoryTokens: t.resentTokens,
          estResentCostUsd: +t.resentCost.toFixed(2),
          estFlatRecallCostUsd: +t.flatCost.toFixed(2),
          estKeepUsd: +keep.toFixed(2),
          flatRecallTokensPerTurn: FLAT_RECALL_TOKENS,
          unknownModels: [...t.unknownModels],
          costBasis:
            'Est. API-rate value: what this usage would cost on pay-as-you-go at published API rates. Not your actual bill - on a Claude Pro/Max subscription you pay a flat monthly fee. resentHistoryPct is plan-independent.',
          note: 'All money figures are estimates. Runs locally; reads only your own log files; makes no network calls.',
        },
        null,
        2
      )
    );
    emitHtmlReport(opts, t, keep, windowLabel);
    return;
  }

  console.log('');
  console.log('⚡ Juvina Token Bill');
  console.log('');
  const resentPct = t.tokens > 0 ? (t.resentTokens / t.tokens) * 100 : 0;
  console.log(
    `${windowLabel[0].toUpperCase() + windowLabel.slice(1)} with Claude Code · ${t.sessions} session${t.sessions === 1 ? '' : 's'} · ${fmtTokens(t.tokens)} tokens`
  );
  console.log('');
  console.log(
    `  ${resentPct.toFixed(0)}% of your AI usage was re-sent history (~${fmtTokens(t.resentTokens)} tokens)`
  );
  console.log('');
  console.log('What this usage would cost on pay-as-you-go:');
  console.log(
    `  Est. API-rate value: ${fmtMoney(t.cost)}   of which re-sent history: ~${fmtMoney(t.resentCost)} (est.)`
  );
  console.log(
    `  Same period with flat recalls (~${FLAT_RECALL_TOKENS.toLocaleString()} tok/turn): ~${fmtMoney(t.flatCost)} — you'd keep ~${fmtMoney(keep)} (est., API-rate terms)`
  );
  console.log('');
  console.log('On a Claude Pro/Max subscription you pay a flat monthly fee — the figures');
  console.log('above are what the same usage would cost at published API rates. Either');
  console.log("way, the share at the top is what's re-sent history.");
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

  emitHtmlReport(opts, t, keep, windowLabel);
}

function emitHtmlReport(opts, t, keep, windowLabel) {
  if (opts.noHtml) return;
  const reportPath = path.join(process.cwd(), 'juvina-token-bill-report.html');
  try {
    fs.writeFileSync(reportPath, buildHtmlReport(t, keep, windowLabel), 'utf8');
  } catch {
    return; // can't write here - the terminal summary already ran
  }
  if (!opts.noOpen) openInBrowser(reportPath);
}

main().catch((err) => {
  console.error('juvina-token-bill: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
