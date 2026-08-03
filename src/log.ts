// src/log.ts — the logging sink, deliberately vscode-free so every module can
// log without depending on the editor. extension.ts routes this into an
// OutputChannel; under vitest it stays a no-op unless a test installs a sink.

export type LogSink = (line: string) => void;

let sink: LogSink | null = null;

export function setLogSink(s: LogSink | null): void {
  sink = s;
}

function emit(level: string, parts: unknown[]): void {
  if (!sink) return;
  const ts = new Date().toISOString().slice(11, 19);
  const text = parts
    .map((p) => (typeof p === 'string' ? p : safeStringify(p)))
    .join(' ');
  sink(`[${ts}] [${level}] ${text}`);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function log(...parts: unknown[]): void {
  emit('info', parts);
}

export function logError(context: string, err: unknown): void {
  const msg = err instanceof Error ? `${err.message}` : safeStringify(err);
  emit('error', [context + ':', msg]);
}
