import { afterEach, describe, expect, test } from "bun:test";
import { contactExtras } from "../src/bot/context.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { fmt } from "../src/lib/format.ts";
import { S } from "../src/strings.ts";

const base = { botToken: "1:x", appSecret: "x".repeat(32) } as Config;
const render = (c: Partial<Config>) => {
  const extras = contactExtras({ ...base, ...c });
  return { about: fmt(S.about, extras), faq: fmt(S.help.faq.koodi.text, extras) };
};

describe("maintainer contact", () => {
  test("name and Telegram handle", () => {
    const r = render({ maintainer: "leevilaukka", maintainerTelegram: "leevi_l", sourceUrl: "https://example.test/src" });
    expect(r.faq).toContain("Ylläpitäjä: leevilaukka (@leevi_l). Kysymykset, ideat ja bugiraportit voi lähettää suoraan Telegramissa.");
    expect(r.faq).toContain("Lähdekoodi: https://example.test/src.");
    expect(r.about).toContain("Ylläpitäjä: leevilaukka (@leevi_l).");
    expect(r.about).toContain("Lähdekoodi: https://example.test/src.");
    expect(r.about).toContain("Käyttöehdot: /terms");
  });

  test("only one of them, or neither", () => {
    expect(render({ maintainerTelegram: "leevi_l" }).faq).toContain("Ylläpitäjä: @leevi_l.");
    expect(render({ maintainer: "leevilaukka" }).faq).toContain("Ylläpitäjä: leevilaukka.");
    expect(render({ maintainer: "leevilaukka" }).faq).not.toContain("Telegramissa");
    expect(render({}).faq).not.toContain("Ylläpitäjä");
    expect(render({ maintainer: "<b>x</b>" }).faq).toContain("&lt;b&gt;x&lt;/b&gt;"); // escaped
  });
});

describe("MAINTAINER_TELEGRAM", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  const load = (handle: string) => {
    process.env = { ...saved, BOT_TOKEN: "1:x", APP_SECRET: "x".repeat(32), MAINTAINER_TELEGRAM: handle };
    return loadConfig().maintainerTelegram;
  };

  test("accepts a handle with or without @, rejects anything else", () => {
    expect(load("@leevi_l")).toBe("leevi_l");
    expect(load("leevi_l")).toBe("leevi_l");
    expect(load("")).toBeUndefined();
    expect(() => load("ab")).toThrow(/Telegram username/);
    expect(() => load("<script>")).toThrow(/Telegram username/);
  });
});
