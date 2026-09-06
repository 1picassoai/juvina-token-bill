# ⚡ Juvina Token Bill

**Most of your AI coding-assistant bill isn't your questions. It's your history, re-sent on every turn.**

Every time your assistant answers, the whole conversation so far — files it read, commands it ran, everything — goes back up with the request. By turn 40 of a long session you're paying for the same context over and over. This tiny CLI reads your own local Claude Code logs and shows you what that costs.

## Run it

```
npx juvina-token-bill
```

That's it. No install, no config, no account. **Runs locally; reads only your own log files; makes no network calls.** Zero dependencies, Node 18+.

One command gives you two things: the terminal summary below, **and a report card** — a single self-contained `juvina-token-bill-report.html` written to the current directory and opened in your default browser. Dark theme, screenshot-ready, no server, no external assets. Use `--no-open` to skip the browser, `--no-html` to skip the file.

## What you'll see

```
⚡ Juvina Token Bill

This month with Claude Code:
  Sessions: 61   Tokens: 41.2M   Est. cost: $83.70
  Of which re-sent history: ~31.5M (~$61.20)

Same period if history were flat recalls (~1,300 tok/turn): ~$24.10
                                          You'd keep: ~$59.60

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
- **Pricing:** a small static table of per-million-token rates for common Claude model ids, with cache reads priced at the cheap cache-read rate and cache writes at 1.25× input. Unknown models get a default rate and a note. **Every money figure is an estimate** — your plan and rates may differ.
- **The "flat recall" line:** what the same sessions would cost if each later turn carried the baseline plus ~1,300 tokens of targeted recall instead of the full history. That's the model a memory engine works on: fetch what's relevant, not everything.

Run `npx juvina-token-bill --explain` for the full formula.

## Why "curable"?

Because re-sent history is an architecture choice, not a law of nature. A memory layer that recalls only what each turn needs keeps context flat — that's what we build at **[juvina.ai](https://juvina.ai)**.

## License

[MIT](LICENSE)
