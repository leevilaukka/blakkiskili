// Keeps secrets (the bot token) out of logs and admin alerts.
//
// The Bot API's URLs contain the token (https://api.telegram.org/bot<token>/sendMessage), and
// network errors carry the URL they failed on, so logging a raw error could print it. Errors are
// described without the URL where we know their shape (describeError), and as a safety net every
// console line has the secrets replaced (installLogRedaction).

import { GrammyError, HttpError } from "grammy";

const MASK = "<redacted>";

/** `text` with every secret (and its URL-encoded form) replaced. */
export function redact(text: string, secrets: readonly string[]): string {
  for (const s of secrets) {
    if (!s || s.length < 8) continue; // nothing that short is a secret, and it would mangle the text
    text = text.replaceAll(s, MASK);
    const encoded = encodeURIComponent(s);
    if (encoded !== s) text = text.replaceAll(encoded, MASK);
  }
  return text;
}

/**
 * A short, URL-free description of an error: the Bot API method and Telegram's answer, or the
 * kind of network failure. Other errors give their message.
 */
export function describeError(e: unknown): string {
  if (e instanceof GrammyError) return `${e.method}: ${e.error_code} ${e.description}`;
  if (e instanceof HttpError) {
    const cause = e.error;
    const kind = cause instanceof Error ? [cause.name, (cause as { code?: unknown }).code].filter(Boolean).join(" ") : "unknown";
    return `${methodOf(e)}: network error (${kind})`;
  }
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

// grammY's HttpError has no method field; its message is "Network request for 'x' failed!".
const methodOf = (e: HttpError) => /'([A-Za-z]+)'/.exec(e.message)?.[1] ?? "request";

type Method = "log" | "info" | "warn" | "error" | "debug";
const METHODS: Method[] = ["log", "info", "warn", "error", "debug"];

/**
 * Replaces `secrets` in everything written through `target`'s log methods (objects and errors
 * are formatted first). Returns a function that puts the originals back.
 */
export function installLogRedaction(secrets: readonly string[], target: Pick<Console, Method> = console): () => void {
  const live = secrets.filter((s) => s && s.length >= 8);
  if (live.length === 0) return () => {};
  const originals = METHODS.map((m) => [m, target[m]] as const);
  for (const [m, original] of originals) {
    target[m] = (...args: unknown[]) =>
      original.apply(
        target,
        args.map((a) => redact(typeof a === "string" ? a : Bun.inspect(a), live)),
      );
  }
  return () => {
    for (const [m, original] of originals) target[m] = original;
  };
}
