# Contributing

Flock is a one-person side project. Issues and pull requests are welcome, but
please open an issue before starting anything large — it may already be decided
one way or the other, and I would rather say so before you write the code than
after.

## Build and test

```sh
npm install
npm run typecheck   # tsc --noEmit, source and tests
npm test            # vitest run
npm run compile     # esbuild bundle -> dist/extension.js
npm run watch       # rebuild on change
```

Press **F5** in VS Code for an Extension Development Host with Flock loaded
(the `npm: compile` task runs first). Reload that window with `Cmd+R` to pick up
a rebuild. Flock's diagnostics go to the **Flock** output channel — `View →
Output → Flock` — never to `console`.

For anything to appear in the tree, `claude` must be on `PATH` (or
`lineage.claudeBinary` set) and at least one Claude Code session must be running
somewhere on the machine. The session roster is machine-wide, not per-workspace.

`npm run typecheck` and `npm test` must both be green before a pull request.

## Things that are deliberate

A few constraints look like oversights and are not:

- **No runtime dependencies.** Node builtins plus the `vscode` API, and
  `devDependencies` for the toolchain. A pull request adding a runtime dependency
  needs a reason in the description.
- **Configuration keys, command ids and the workspace filename keep the
  `lineage.` prefix.** The extension was called Lineage before 0.1.0. Renaming
  those keys would silently discard everyone's existing settings and break their
  keybindings, so the old prefix stays. New user-visible strings say Flock.
- **The extension id `hjulaxel.flock` is frozen** and asserted by
  `test/identity.test.ts`. A published id cannot be changed.
- **No proposed APIs.** Flock has to run in Cursor, Windsurf and VSCodium, so
  `enabledApiProposals` stays empty.
- **Read-only where it counts.** The only CLI call is `claude agents --json`; the
  only git call is `git worktree list --porcelain`. Flock makes no network
  requests, and writes nothing to your repository or to
  `~/.claude/settings.json`. Please keep it that way.
- **Failures degrade, they do not throw.** A missing file, malformed JSON or a
  dead process returns nothing and the row renders plainly. For session ancestry
  in particular, a wrong edge is worse than no edge.

## Releasing

`npm run release` is the release path. It refuses to package a dirty tree or a
non-`main` branch, refuses a version that has already been tagged, runs the
typecheck and the tests, builds the VSIX, and tags the commit locally. Nothing
leaves the machine: it prints the upload and `git push --tags` steps for you to
run deliberately.
