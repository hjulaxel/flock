// src/shim.ts — how a launch reaches `createTerminal` on every platform: the
// executable and its arguments, and on Windows the command processor a `.cmd`
// shim has to ride in on.
//
// Pure: no vscode, no node builtins. Lifted out of terminals.ts so that the two
// places that hand a CLI to a pty — the session launch in terminals.ts and the
// account sign-in in commands.ts — spell a Windows launch the same way.
// commands.ts deliberately never imports terminals (see its header): the
// registry there is side effects end to end, and this is the one piece of it a
// verb needs. terminals.ts re-exports everything here, so its callers and its
// tests are unchanged.

/** How a launch reaches `createTerminal`: the executable and its arguments,
 *  the latter an array everywhere except through a Windows shim, where VS Code
 *  takes a single command-line string (`TerminalOptions.shellArgs` allows a
 *  string on Windows only, for exactly this). */
export interface SpawnableLaunch {
  shellPath: string;
  shellArgs: string[] | string;
}

/**
 * Pure. A launch made spawnable on this platform.
 *
 * THE WINDOWS SHIM. An npm install puts `claude.cmd` on PATH, a batch file
 * that runs the real CLI. A batch file is not an executable: CreateProcess
 * cannot start one, and only pretends to by silently prepending `cmd.exe` —
 * the behaviour Node closed for CVE-2024-27980, which is why `fetchRoster`
 * (roster.ts) already wraps the same shim in `cmd /d /s /c` for the `agents`
 * call. The terminal launch handed the shim straight to the pty as
 * `shellPath`, so it rode that implicit `cmd.exe`, with an argument vector
 * nobody had quoted for it: a session name with `&` in it was two commands.
 * This puts the command processor there explicitly and quotes for it.
 *
 * `/d` skips AutoRun, `/s` says the first and last quote of what follows `/c`
 * are ours and everything between is the command — which is what makes a
 * quoted executable path AND quoted arguments legal on one line. The shim's
 * own path is spelled by `quoteCmdCommand`, each argument by `quoteForCmd`;
 * they differ because cmd reads the command token once and the arguments
 * twice (quoteForCmd explains the second read).
 *
 * WHAT THIS CANNOT DO: `%` is cmd's expansion character and there is no
 * escape for it on a command line (`%%` works only inside a batch file), so
 * an argument containing `%NAME%` for a set variable may be expanded before
 * the CLI sees it. quoteForCmd puts a caret on the `%` because cross-spawn
 * does, but nothing here has watched that survive a live shim, so a prompt
 * that quotes an environment variable by name stays the one input this path
 * is not trusted to carry — and only through the shim. The native installer's
 * `claude.exe` has none of this, which is why discovery prefers it and the
 * README says to install that way.
 *
 * A terminal launched this way has `cmd.exe` as its process, so its
 * `Terminal.processId` is not the CLI's — the same shape as a tmux client,
 * and the same consequence: pid-keyed re-association after an app restart
 * does not fire for it.
 *
 * Off the Windows-shim path this is the identity, so every other launch is
 * untouched.
 */
export function shimLaunch(
  binary: string,
  args: readonly string[],
  platform: string,
  comSpec: string | undefined,
): SpawnableLaunch {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(binary)) {
    return { shellPath: binary, shellArgs: [...args] };
  }
  const line = [quoteCmdCommand(binary), ...args.map(quoteForCmd)].join(' ');
  return {
    shellPath: typeof comSpec === 'string' && comSpec !== '' ? comSpec : 'cmd.exe',
    shellArgs: `/d /s /c "${line}"`,
  };
}

/**
 * Pure. The shim's own path, spelled as the COMMAND of the `/c` line: real
 * quotes, not carets. cmd reads the command token once and in quote mode, so
 * a space in the npm prefix (`C:\Users\a b\AppData\Roaming\npm\claude.cmd`)
 * stays inside the token and a `&` in a user name is protected the ordinary
 * way; a Windows path cannot contain `"`, so there is nothing for the quotes
 * to trip over. The arguments' spelling would be WRONG here — a caret-quoted
 * token is not in quote mode at its space, so cmd would end the command
 * there — and one quote pair opened and closed before any argument leaves
 * cmd's quote state exactly where the arguments need it: off.
 */
function quoteCmdCommand(binary: string): string {
  return `"${binary}"`;
}

/** A word both parsers read as itself: no whitespace, no quote, none of cmd's
 *  syntax. Flags, uuids and paths without spaces — most of a launch line. A
 *  trailing backslash is literal when no quote follows it. */
const PLAIN_CMD_ARG = /^[A-Za-z0-9_\-./:\\@+]+$/;
/** What cmd reads as syntax on a command line. `%` and `!` are its two
 *  expansion characters, the rest are its operators and its quote. */
const CMD_META = /[()%!^"<>&|]/g;

/**
 * Pure. One argument, spelled for the `cmd /d /s /c "…"` line that runs a
 * `.cmd` shim. Modelled on cross-spawn's `escape.argument` with double
 * escaping on — the spelling npm, yarn and execa run every Windows shim
 * through.
 *
 * TWO PARSERS READ THIS TEXT, and they disagree about quotes. cmd.exe has no
 * escape character inside a quoted string: every `"` it meets toggles its
 * quote state, and once the count is odd the rest of the line is outside
 * quotes, where `&` or `|` starts a second command. The previous spelling
 * here (`\"` for an embedded quote) escaped for the OTHER parser — the C
 * runtime's argv splitter on the far side of the shim — and left cmd counting
 * the very quotes it was meant to hide, so a prompt with one `"` in it and a
 * `& del x` after it ran the `del`. The CRT parser, meanwhile, reads a
 * backslash before a quote as an escape, so a value ending in `\` had that
 * backslash eaten by the closing quote.
 *
 * So the argument is spelled for both, in layers, innermost first:
 *
 *   1. For the CRT: a run of backslashes before a `"` is doubled and the
 *      quote gets a `\`; a run of trailing backslashes is doubled, because
 *      the closing quote comes next. Every other backslash is literal.
 *   2. Wrapped in double quotes.
 *   3. For cmd: every character it reads as syntax — CMD_META, the wrapping
 *      quotes included — gets a caret. cmd strips the caret and takes the
 *      next character literally, and an escaped `"` does not toggle its
 *      quote state, so nothing on the line is ever syntax to it and there is
 *      no quote state left to unbalance.
 *   4. Step 3 AGAIN. cmd parses the `/c` line once, which consumes one layer
 *      of carets, and hands the shim its arguments with that layer gone; the
 *      batch file then expands `%*` into its own command line and cmd parses
 *      THAT — the second read, needing the second layer. (The batch gotcha
 *      where a `%1` holding `a&b` runs `b` is the same mechanism.)
 *
 * Only what needs it is touched: a PLAIN_CMD_ARG passes untouched, which
 * keeps the line readable in a log. An empty argument is spelled `""` and
 * then escaped like the rest.
 *
 * `%` gets the caret too, which splits `%NAME%` into a name cmd cannot look
 * up, and cross-spawn relies on that. It is NOT relied on here: what phase-one
 * expansion does with a caret inside a variable name has not been checked
 * against a live shim, and the README's caveat stands until it has.
 */
export function quoteForCmd(arg: string): string {
  if (PLAIN_CMD_ARG.test(arg)) return arg;
  let out = arg.replace(/(\\*)"/g, '$1$1\\"');
  out = out.replace(/(\\+)$/, '$1$1');
  out = `"${out}"`;
  out = out.replace(CMD_META, '^$&');
  return out.replace(CMD_META, '^$&');
}
