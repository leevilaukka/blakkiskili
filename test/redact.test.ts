import { describe, expect, test } from "bun:test";
import { GrammyError, HttpError } from "grammy";
import { describeError, installLogRedaction, redact } from "../src/lib/redact.ts";

const TOKEN = "123456:AAH-secret_token";

describe("keeping the bot token out of logs", () => {
  test("redact replaces the token and its URL-encoded form", () => {
    const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
    expect(redact(url, [TOKEN])).toBe("https://api.telegram.org/bot<redacted>/sendMessage");
    expect(redact(`x=${encodeURIComponent(TOKEN)}`, [TOKEN])).toBe("x=<redacted>");
    expect(redact("a:b", ["a"])).toBe("a:b"); // too short to be a secret
  });

  test("errors are described without their URL", () => {
    const cause = Object.assign(new Error(`connect failed: https://api.telegram.org/bot${TOKEN}/getMe`), { code: "ECONNREFUSED" });
    const http = new HttpError("Network request for 'getMe' failed!", cause);
    expect(describeError(http)).toBe("getMe: network error (Error ECONNREFUSED)");
    const api = new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, "sendMessage", {});
    expect(describeError(api)).toBe("sendMessage: 403 Forbidden: bot was blocked by the user");
  });

  test("every console line has the token replaced, errors and objects too", () => {
    const lines: string[] = [];
    const sink = { log: (...a: unknown[]) => lines.push(a.join(" ")), info() {}, warn() {}, error: (...a: unknown[]) => lines.push(a.join(" ")), debug() {} };
    const restore = installLogRedaction([TOKEN], sink);
    sink.error("Could not reach Telegram:", new Error(`fetch https://api.telegram.org/bot${TOKEN}/getUpdates`));
    sink.log({ url: `https://api.telegram.org/file/bot${TOKEN}/docs/x` });
    restore();
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines.join("\n")).toContain("bot<redacted>/getUpdates");
    sink.log(TOKEN); // restored: the originals again
    expect(lines.at(-1)).toBe(TOKEN);
  });
});
