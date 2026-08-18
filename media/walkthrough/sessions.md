## The tree starts empty

Flock reads `claude agents --json` — the Claude Code CLI's own session registry
— and that registry is **machine-wide**. It knows about every `claude` anyone
has ever run on this computer.

Drawing all of it was the old behaviour, and it meant your first launch opened
onto somebody else's history: a folder row per directory, sessions you did not
recognise, and a bell ringing for something in a plain terminal tab.

So the tree now holds **what you told Flock about** — sessions you launched
here, sessions bound to one of its terminals, and sessions you added by hand.
Nothing else appears, and nothing else can ring the bell.

Two doors bring the rest in:

- **Add Existing Session…** on a project's right-click — the sessions that
  already ran in its directories, one at a time or all at once.
- **Import Previous Sessions…** — everything this machine knows that has no
  row, grouped by folder, newest first.

`lineage.showForeignSessions` turns the old behaviour back on wholesale if you
would rather see everything.

If sessions you started *here* are missing, the CLI is probably not on the
`PATH` the extension host sees — set `lineage.claudeBinary` to the full path of
your `claude` binary.
