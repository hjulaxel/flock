## Your sessions are already here

Canopy reads `claude agents --json` — the Claude Code CLI's own global session
registry. Anything you have ever run `claude` on shows up in the sidebar on its
own.

Nothing to connect. Nothing to sign in to. No configuration.

If the tree is empty but you know sessions are running, the CLI probably is not
on the `PATH` the extension host sees — set `lineage.claudeBinary` to the full
path of your `claude` binary.
