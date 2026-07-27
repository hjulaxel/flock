# Lineage for Claude Code

A live tree of your parallel Claude Code sessions — fork lineage, attention
routing, and orchestration verbs, in the sidebar.

> **Not affiliated with, endorsed by, or sponsored by Anthropic.** "Claude" and
> "Claude Code" are trademarks of Anthropic, PBC, used here only to describe
> what this extension works with. This is an independent, community-built tool.

## What it does

- **A tree of sessions, not a list.** See which session was forked from which —
  the branch points every other tool throws away.
- **Attention routing.** Sessions waiting on you sort first, carry a badge on
  the view, and show a status glyph inline.
- **Orchestration verbs.** New, fork, ask-in-a-fork, rename, wrap up, close
  (with an optional summary), copy id, hide/unhide, drag to re-parent.
- **Cross-window focus.** Click a session that lives in another window and that
  window comes forward.
- **Projects, grouped.** Sessions group by working directory; open any project
  in a new window from the group row.

## How it works

Every window independently polls `claude agents --json` — the CLI's own
scriptable, global session registry — and reads session transcripts to recover
parent/child edges for sessions it did not launch itself. Sessions the
extension launches get a pre-minted `--session-id`, so their lineage is exact
by construction rather than inferred.

There is no daemon, no background service, and no Python. Your editorial layer
(titles, summaries, hidden flags) is stored in the extension's own
`globalStorage` directory — nothing else on disk is modified.

**Hooks are optional.** The extension is fully functional without them. If you
opt in, they install as a self-contained skills-directory plugin under
`~/.claude/skills/lineage-events/` and are removed by deleting that directory.
The extension **never** edits `~/.claude/settings.json`.

## Requirements

- The `claude` CLI on your `PATH` (or set `lineage.claudeBinary` to its full
  path).
- VS Code 1.94 or newer.
- A trusted workspace. Restricted Mode blocks terminal creation, which this
  extension needs.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `lineage.pollIntervalMs` | `3000` | How often to poll `claude agents --json`. |
| `lineage.claudeBinary` | `""` | Full path to the `claude` CLI. Empty = search `PATH`. |
| `lineage.groupByFolder` | `true` | Group sessions by working directory. |
| `lineage.sortWaitingFirst` | `true` | Sort sessions waiting on you above the rest. |
| `lineage.showGhosts` | `true` | Show exited ancestor sessions that live sessions were forked from. |
| `lineage.hooks.enabled` | `false` | Opt in to instant updates via Claude Code hooks. |

## Privacy

Nothing leaves your machine. The extension makes no network requests. It reads
the local session roster and local transcript files, and writes only to its own
extension storage (plus, if you explicitly opt in, the hooks plugin directory
and `~/.lineage/events.ndjson`).

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run compile     # esbuild bundle -> dist/extension.js
npm run watch       # rebuild on change
```

`SPEC.md` is the authoritative implementation contract. `src/types.ts` and
`src/log.ts` are frozen — do not edit them.

## License

MIT. See [LICENSE](LICENSE).
