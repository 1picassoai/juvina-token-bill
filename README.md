# ⚡ Juvina Token Bill

**See how much of your AI coding usage is re-sent history — and what that repetition would cost at API rates.**

Every time your assistant answers, the whole conversation so far — files it read, commands it ran, everything — goes back up with the request. By turn 40 of a long session the same context is processed over and over. This tiny CLI reads your own local Claude Code logs and shows you the share of your usage that is re-sent history (true on every plan), plus what that usage would cost at published pay-as-you-go API rates.

> **On a subscription?** Most Claude Code users pay a flat monthly fee (Claude Pro/Max). The dollar figures this tool shows are **not your bill** — they're the estimated API-rate value of the same usage on pay-as-you-go. The re-sent-history percentage is plan-independent.

## Run it

```
npx juvina-token-bill
```

That's it. No install, no config, no account. **Runs locally; reads only your own log files; makes no network calls.** Zero dependencies, Node 18+.

One command gives you two things: the terminal summary below, **and a report card** — a single self-contained `juvina-token-bill-report.html` written to the current directory and opened in your default browser. Dark theme, screenshot-ready, no server, no external assets. Use `--no-open` to skip the browser, `--no-html` to skip the file.

## What you'll see

```
⚡ Juvina Token Bill

This month with Claude Code · 61 sessions · 41.2M tokens

  76% of your AI usage was re-sent history (~31.5M tokens)

What this usage would cost on pay-as-you-go:
  Est. API-rate value: $83.70   of which re-sent history: ~$61.20 (est.)
  Same period with flat recalls (~1,300 tok/turn): ~$24.10 — you'd keep ~$59.60 (est., API-rate terms)

On a Claude Pro/Max subscription you pay a flat monthly fee — the figures
above are what the same usage would cost at published API rates. Either
way, the share at the top is what's re-sent history.

Method: input tokens beyond each session's first turn ≈ re-sent context;
flat-recall model = first-turn size + 1,300 tokens/turn. Full formula: --explain
Curable → https://juvina.ai
```

## Flags

| Flag | What it does |
|---|---|
| `--days N` | Look at the last N days (default: current calendar month) |
| `--json` | Machine-readable output |
| `--explain` | Print the full estimation formula |
| `--dir PATH` | Read transcripts from a different directory |
| `--no-open` | Write the HTML report card but don't open the browser |
| `--no-html` | Skip the HTML report card entirely |

## How the estimate works (honestly)

- **Data source:** the JSONL transcripts Claude Code already writes under `~/.claude/projects/`. Each assistant turn records its token usage (input, output, cache writes, cache reads). Nothing else is read; lines that don't parse are skipped.
- **Re-sent history:** per session, the first turn's context size is the baseline (system prompt, tools, your first message). Context above that baseline on later turns is counted as re-sent history.
- **Pricing:** a small static table of published pay-as-you-go per-million-token API rates for common Claude model ids, with cache reads priced at the cheap cache-read rate and cache writes at 1.25× input. Unknown models get a default rate and a note. **Every money figure is an estimate of API-rate value, not your actual bill** — on a Claude Pro/Max subscription you pay a flat monthly fee regardless.
- **The "flat recall" line:** the same sessions re-priced in API-rate terms as if each later turn carried the baseline plus ~1,300 tokens of targeted recall instead of the full history. That's the model a memory engine works on: fetch what's relevant, not everything.

Run `npx juvina-token-bill --explain` for the full formula.

## Why "curable"?

Because re-sent history is an architecture choice, not a law of nature. A memory layer that recalls only what each turn needs keeps context flat — that's what we build at **[juvina.ai](https://juvina.ai)**.

## License

[MIT](LICENSE)
