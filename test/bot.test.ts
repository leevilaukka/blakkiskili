// End-to-end: real bot + services, fake Telegram API. Every outgoing message is checked to
// be HTML that Telegram would accept (only <b>/<code>, balanced, no stray "<" or "&").

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Update } from "grammy/types";
import { ALLOWED_UPDATES, createBot } from "../src/bot/index.ts";
import { RateLimiter } from "../src/bot/ratelimit.ts";
import type { Announcement } from "../src/announcements.ts";
import { Products } from "../src/services/products.ts";
import { Barcodes } from "../src/services/barcodes.ts";
import type { BarcodeIO } from "../src/bot/barcode.ts";
import { catalogJson } from "./fixtures.ts";
import type { Config } from "../src/config.ts";
import { toCsv } from "../src/lib/csv.ts";
import { legacyHash } from "../src/lib/ids.ts";
import { setup, TEST_SECRET } from "./helpers.ts";

const config: Config = {
  botToken: "123:TEST",
  appSecret: TEST_SECRET,
  dbPath: ":memory:",
  adminIds: [1],
  mode: "polling",
  port: 0,
  inactivity: { deleteAfterDays: 730, warnDaysBefore: 30 },
  backup: { everyMinutes: 60 },
  accountLinking: false,
  web: { enabled: true, origin: "https://kili.test", port: 0, distDir: "./web/build" },
};

interface Call {
  method: string;
  payload: Record<string, any>;
}

function assertTelegramHtml(text: string) {
  const stack: string[] = [];
  const stripped = text.replace(/<(\/?)(b|code|a)(?: href="[^"<>]*")?>/g, (_m, close: string, tag: string) => {
    if (close) expect(stack.pop()).toBe(tag);
    else stack.push(tag);
    return "";
  });
  expect(stack).toEqual([]);
  expect(stripped).not.toMatch(/[<>]/);
  expect(stripped).not.toMatch(/&(?!(amp|lt|gt);)/);
}

function harness(
  limiter = new RateLimiter(10_000, 60_000),
  announcements: Announcement[] = [],
  products?: Products,
  overrides: Partial<Config> = {},
  barcodes?: { service: Barcodes; io: BarcodeIO },
) {
  const env = setup(undefined, announcements, products, barcodes?.service);
  const bot = createBot({ ...config, ...overrides }, env.services, { limiter, feedbackGraceMs: 20, barcodeIO: barcodes?.io });
  bot.botInfo = {
    id: 42, is_bot: true, first_name: "Kili", username: "kili_test_bot",
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false,
  } as typeof bot.botInfo;

  const calls: Call[] = [];
  let messageId = 100;
  bot.api.config.use(async (_prev, method, payload) => {
    const p = payload as Record<string, any>;
    calls.push({ method, payload: p });
    if (typeof p.text === "string" && p.parse_mode === "HTML") assertTelegramHtml(p.text);
    const result: unknown =
      method === "getFile" ? { file_id: p.file_id, file_unique_id: "u", file_path: `docs/${p.file_id}` }
      : method.startsWith("send") || method === "editMessageText"
        ? { message_id: ++messageId, date: 0, chat: { id: p.chat_id ?? 0, type: "private" }, text: p.text ?? "" }
        : true;
    return { ok: true, result } as any;
  });

  // Like Telegram: update types the bot didn't ask for (allowed_updates) are never delivered.
  const realHandle = bot.handleUpdate.bind(bot);
  bot.handleUpdate = async (update: Update) => {
    const type = Object.keys(update).find((k) => k !== "update_id")!;
    if (!(ALLOWED_UPDATES as readonly string[]).includes(type)) return;
    return realHandle(update);
  };

  let updateId = 0;
  const user = (id: number, username: string) => ({ id, is_bot: false, first_name: username, username });
  const chatOf = (id: number, group?: string) =>
    group ? { id, type: "supergroup" as const, title: group } : { id, type: "private" as const, first_name: "x" };

  const send = async (from: number, text: string, group?: { id: number; title: string }) => {
    const isCmd = text.startsWith("/");
    const update = {
      update_id: ++updateId,
      message: {
        message_id: ++messageId, date: 0, text,
        from: user(from, `user${from}`),
        chat: group ? chatOf(group.id, group.title) : chatOf(from),
        entities: isCmd ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] : undefined,
      },
    } as Update;
    const before = calls.length;
    await bot.handleUpdate(update);
    return calls.slice(before);
  };

  const press = async (from: number, data: string) => {
    const update = {
      update_id: ++updateId,
      callback_query: {
        id: String(updateId), chat_instance: "c", data,
        from: user(from, `user${from}`),
        message: { message_id: 1, date: 0, chat: chatOf(from), text: "menu" },
      },
    } as Update;
    const before = calls.length;
    await bot.handleUpdate(update);
    return calls.slice(before);
  };

  const sendDocument = async (from: number, fileId: string) => {
    const update = {
      update_id: ++updateId,
      message: {
        message_id: ++messageId, date: 0, from: user(from, `user${from}`), chat: chatOf(from),
        document: { file_id: fileId, file_unique_id: fileId, file_name: fileId, file_size: 100 },
      },
    } as Update;
    const before = calls.length;
    await bot.handleUpdate(update);
    return calls.slice(before);
  };

  const sendPhoto = async (from: number, fileId: string) => {
    const update = {
      update_id: ++updateId,
      message: {
        message_id: ++messageId, date: 0, from: user(from, `user${from}`), chat: chatOf(from),
        photo: [
          { file_id: `${fileId}-small`, file_unique_id: "s", width: 90, height: 90 },
          { file_id: fileId, file_unique_id: fileId, width: 1280, height: 960 },
        ],
      },
    } as Update;
    const before = calls.length;
    await bot.handleUpdate(update);
    return calls.slice(before);
  };

  const inlineQuery = async (from: number, query: string, chatType = "sender") => {
    const before = calls.length;
    await bot.handleUpdate({
      update_id: ++updateId,
      inline_query: { id: `iq${updateId}`, from: user(from, `user${from}`), query, offset: "", chat_type: chatType },
    } as Update);
    return calls.slice(before);
  };

  const chooseInline = async (from: number, resultId: string) => {
    const before = calls.length;
    await bot.handleUpdate({
      update_id: ++updateId,
      chosen_inline_result: { result_id: resultId, from: user(from, `user${from}`), query: "x" },
    } as Update);
    return calls.slice(before);
  };

  /** The message Telegram posts into the chat when an inline result is picked. */
  const sendViaBot = async (from: number, text: string) => {
    const before = calls.length;
    await bot.handleUpdate({
      update_id: ++updateId,
      message: { message_id: ++messageId, date: 0, text, from: user(from, `user${from}`), chat: chatOf(from), via_bot: bot.botInfo },
    } as Update);
    return calls.slice(before);
  };

  /** Account id of a Telegram user (accounts have random ids; logins point at them). */
  const account = (telegramId: number) =>
    env.services.accounts.byIdentity(env.crypto.identityKey("telegram", telegramId))?.id ?? "none";

  return { ...env, bot, calls, send, press, sendDocument, sendPhoto, inlineQuery, chooseInline, sendViaBot, account };
}

const textOf = (calls: Call[]) => calls.filter((c) => typeof c.payload.text === "string").map((c) => c.payload.text as string).join("\n---\n");
const buttonsOf = (calls: Call[]) =>
  calls.flatMap((c) => (c.payload.reply_markup?.inline_keyboard ?? []).flat()) as { text: string; callback_data: string }[];

// Files served by the fake Telegram file endpoint.
const files = new Map<string, string>();
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const id = url.split("/docs/")[1];
    if (url.startsWith("https://api.telegram.org/file/") && id && files.has(id)) return new Response(files.get(id));
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("bot end-to-end", () => {
  test("registration, drinking, menus, groups, export, delete", async () => {
    const h = harness();
    const A = 1001;

    expect(textOf(await h.send(A, "/start"))).toContain("Luo tunnus");
    expect(textOf(await h.send(A, "/juoma"))).toContain("Rekisteröidy");

    // Registration flow
    await h.press(A, "m:r");
    expect(textOf(await h.send(A, "kymmenen"))).toContain("Syötä paino uudelleen");
    expect(textOf(await h.send(A, "80"))).toContain("pituus");
    const genderStep = await h.send(A, "180");
    expect(buttonsOf(genderStep).map((b) => b.callback_data)).toContain("m:r:g:m");
    expect(textOf(await h.press(A, "m:r:g:m"))).toContain("Käyttöehdot");
    expect(textOf(await h.press(A, "m:r:t:y"))).toContain("Moikka user1001");
    const uid = h.account(A);
    expect(h.services.accounts.get(uid)).toMatchObject({ weight: 80, height: 180, gender: "mies" });
    // Registration stores the Telegram id (encrypted) for inactivity warnings
    expect(h.services.identities.contacts(uid)).toEqual([{ platform: "telegram", address: String(A) }]);
    // The terms shown include the retention rule
    expect(textOf(await h.send(A, "/terms"))).toContain("24 kuukauteen");

    // Preset drink from the menu
    const juo = await h.press(A, "m:j");
    expect(buttonsOf(juo).map((b) => b.callback_data)).toContain("m:jc:miedot");
    const drank = await h.press(A, "m:d:b50");
    // Presets have a typical energy (50 cl × 40 kcal / 100 ml)
    expect(textOf(drank)).toContain("Juoma tallennettu: 🍺 50cl 4.7%\nTämän illan juomissa on noin <b>200</b> kcal.");
    // Quick button for the latest drink appears
    const quick = buttonsOf(drank).find((b) => b.callback_data.startsWith("m:jl:"));
    expect(quick?.text).toContain("50cl");
    await h.press(A, quick!.callback_data);
    expect(h.services.drinks.since(uid, 0).map((d) => d.kcal)).toEqual([200, 200]);

    // Custom drink
    await h.press(A, "m:jo");
    expect(textOf(await h.send(A, "abc"))).toContain("Liian paljon tai vähän sanoja");
    // Custom drinks have no energy data, and the total says so
    expect(textOf(await h.send(A, "33cl 5,1%"))).toContain("Oma juoma - 33cl 5.1%\nTämän illan juomissa on noin <b>400</b> kcal. Energiatieto puuttuu 1 juomalta.");
    expect(textOf(await h.send(A, "4 40"))).toContain("Oma juoma - 4cl 40%"); // stays in flow

    // Late logging
    await h.press(A, "m:jk");
    expect(textOf(await h.send(A, "30"))).toContain("Tunnit väärin");
    await h.send(A, "2");
    const entered = await h.send(A, "33 4.7\n4 40");
    expect(textOf(entered)).toContain("2 juoma(a) syötetty");
    expect(buttonsOf(entered).map((b) => b.callback_data)).toContain("m:jks");
    expect(textOf(await h.press(A, "m:jks"))).toContain("2 juomaa jälkikellotettu");
    expect(h.services.drinks.since(uid, 0)).toHaveLength(6);

    // Navigating away cancels a flow: text is no longer treated as a drink
    await h.press(A, "m:jo");
    await h.press(A, "m:s");
    expect(textOf(await h.send(A, "33 5"))).toContain("Mitä?");

    // Undo (/laatta) asks for confirmation of the exact drink
    const confirm = await h.send(A, "/laatta");
    const yes = buttonsOf(confirm).find((b) => b.callback_data.startsWith("m:juy:"))!;
    expect(textOf(await h.press(A, yes.callback_data))).toContain("Kumoaminen onnistui");
    expect(h.services.drinks.since(uid, 0)).toHaveLength(5);
    // Pressing the same confirmation twice doesn't undo a second drink
    await h.press(A, yes.callback_data);
    expect(h.services.drinks.since(uid, 0)).toHaveLength(5);

    // Personal summaries and stats
    expect(textOf(await h.send(A, "/promillet"))).toMatch(/Nyt:<\/b> \d/);
    expect(textOf(await h.send(A, "/stats 7"))).toContain("Olet 7 päivän aikana");
    expect(textOf(await h.press(A, "m:to"))).toContain("Oma juoma");
    const kulutus = textOf(await h.press(A, "m:tk:30"));
    expect(kulutus).toContain("<b>30</b> päivän");
    // The undo above removed one of the beers: 200 kcal known, the custom and late drinks unknown
    expect(kulutus).toContain("Juomissa oli energiaa noin <b>200</b> kcal. Energiatieto puuttuu 4 juomalta.");
    expect(textOf(await h.press(A, "m:s"))).toContain("Tämän illan juomissa on noin <b>200</b> kcal.");
    // /kalja033 counts too (200 + 132); a 6 h pause starts a new evening
    expect(textOf(await h.send(A, "/kalja033"))).toContain("Tämän illan juomissa on noin <b>330</b> kcal.");
    await h.send(A, "/laatta").then((c) => h.press(A, buttonsOf(c).find((b) => b.callback_data.startsWith("m:juy:"))!.callback_data));
    h.clock.now += 7 * 3_600_000;
    expect(textOf(await h.send(A, "/kalja033"))).toContain("Tämän illan juomissa on noin <b>130</b> kcal.");
    expect(textOf(await h.send(A, "/laatta").then((c) => h.press(A, buttonsOf(c).find((b) => b.callback_data.startsWith("m:juy:"))!.callback_data)))).toContain("Kumoaminen onnistui");
    h.clock.now -= 7 * 3_600_000;

    // Settings
    await h.press(A, "m:amw");
    expect(textOf(await h.send(A, "300"))).toContain("20kg ja 250kg");
    expect(textOf(await h.send(A, "85"))).toContain("Paino muutettu");
    expect(h.services.accounts.get(uid)!.weight).toBe(85);

    // Groups (let the drinks absorb for a while first)
    h.clock.now += 45 * 60_000;
    const G = { id: -100777, title: "Kilta <3 & co" };
    expect(textOf(await h.send(A, "/moro", G))).toContain("Kilta &lt;3 &amp; co");
    expect(h.services.groups.listFor(h.account(A))[0]).toMatchObject({ name: "Kilta <3 & co", kind: "telegram" }); // the website shows it
    expect(textOf(await h.send(A, "/moro"))).toContain("vain ryhmissä");
    const listing = textOf(await h.send(2002, "/promillet@kili_test_bot", G));
    expect(listing).toContain("user1001...");
    expect(textOf(await h.send(A, "/annokset", G))).toMatch(/user1001\.\.\. [\d.]+kpl/);
    expect(textOf(await h.send(A, "/stats2", G))).toContain("Top10 tilastot <b>annoksina</b>");

    // Chart: a PNG photo in the group, and for yourself in private
    const photo = (await h.send(A, "/kuvaaja", G)).find((c) => c.method === "sendPhoto");
    expect(photo?.payload.caption).toContain("Kilta &lt;3 &amp; co");
    expect(textOf(await h.send(2002, "/kuvaaja", { id: -999, title: "Tyhjä" }))).toContain("Ei piirrettävää");
    expect((await h.send(A, "/kuvaaja")).some((c) => c.method === "sendPhoto")).toBe(true);
    expect((await h.press(A, "kg:0")).some((c) => c.method === "editMessageMedia")).toBe(true); // page buttons swap the photo
    expect(textOf(await h.send(2002, "/moro", G))).toContain("Rekisteröidy");

    // Export
    const exported = await h.send(A, "/data");
    expect(exported.filter((c) => c.method === "sendDocument")).toHaveLength(3);

    // Admin only
    expect(textOf(await h.send(2002, "/admin_stats"))).toContain("Ei käyttöoikeutta");
    // Chart paging demo (admin only): overview + groups, buttons swap the photo
    expect(textOf(await h.send(2002, "/admin_kuvaaja"))).toContain("Ei käyttöoikeutta");
    const demo = await h.send(1, "/admin_kuvaaja");
    expect(demo.some((c) => c.method === "sendPhoto")).toBe(true);
    expect(buttonsOf(demo).map((b) => [b.text, b.callback_data])).toEqual([["‹ Edellinen", "kd:2"], ["Kaikki", "kd:0"], ["Seuraava ›", "kd:1"]]);
    expect((await h.press(1, "kd:2")).some((c) => c.method === "editMessageMedia")).toBe(true);

    // Delete account
    await h.press(A, "m:ad");
    await h.press(A, "m:ad1");
    expect(textOf(await h.press(A, "m:ad2"))).toContain("Kaikki tietosi on nyt poistettu");
    expect(h.services.accounts.get(uid)).toBeNull();
    expect(h.services.groups.memberStatuses(G.id)).toEqual([]);
  });

  test("importing the original bot's /data files, drinks.csv first", async () => {
    const h = harness();
    const B = 3003;
    const old = legacyHash(B);
    files.set("drinks-b", toCsv(["id", "userid", "alcohol", "description", "created"], [
      { id: 1, userid: old, alcohol: 12241, description: "🍺 33cl 4.7%", created: new Date(h.clock.now - 3600_000) },
      { id: 2, userid: old, alcohol: 12241, description: "🍺 33cl 4.7%", created: new Date("2023-01-01T20:00:00Z") },
    ]));
    files.set("user-b", toCsv(["userid", "nick", "weight", "gender", "height", "read_terms", "read_announcements", "created"], [
      { userid: old, nick: "vanha", weight: 70, gender: "nainen", height: 165, read_terms: true, read_announcements: 3, created: new Date("2019-02-02T00:00:00Z") },
    ]));
    files.set("groups-b", toCsv(["userid", "groupid"], [{ userid: old, groupid: legacyHash(-100555) }]));
    files.set("user-other", toCsv(["userid", "nick", "weight", "gender", "height"], [
      { userid: legacyHash(1), nick: "x", weight: 70, gender: "mies", height: 170 },
    ]));

    expect(textOf(await h.sendDocument(B, "user-b"))).toContain("/tuo");
    expect(textOf(await h.send(B, "/tuo"))).toContain("Käyttöehdot");
    expect(textOf(await h.press(B, "m:i:y"))).toContain("Lähetä nyt tiedostot");

    expect(textOf(await h.sendDocument(B, "user-other"))).toContain("ei ole sinun");
    expect(textOf(await h.sendDocument(B, "drinks-b"))).toContain("tarvitsen ensin user.csv");
    const afterUser = textOf(await h.sendDocument(B, "user-b"));
    expect(afterUser).toContain("Tunnus luotu");
    expect(afterUser).toContain("2 juomaa lisätty");
    expect(textOf(await h.sendDocument(B, "groups-b"))).toContain("1 ryhmäjäsenyyttä");

    const uid = h.account(B);
    expect(h.services.accounts.get(uid)).toMatchObject({ weight: 70, gender: "nainen", name: "user3003" });

    // The old group starts using the new bot: the imported member shows up without /moro
    const listing = await h.send(9, "/promillet", { id: -100555, title: "Vanha ryhmä" });
    expect(textOf(listing)).toContain("Toin 1 vanhan");
    expect(textOf(listing)).toContain("user3003...");
  });

  test("flooding is rate limited per user", async () => {
    const h = harness(new RateLimiter(5, 60_000));
    for (let i = 0; i < 5; i++) expect(textOf(await h.send(7, "/help"))).toContain("Bläkkiskili");
    expect(textOf(await h.send(7, "/help"))).toContain("Hidasta vähän");
    expect(await h.send(7, "/help")).toEqual([]); // silently dropped
    expect(textOf(await h.send(8, "/help"))).toContain("Bläkkiskili"); // other users unaffected
  });

  test("announcements: shown once in private to existing users, never in groups or to newcomers", async () => {
    const publishedAt = "2026-11-06T21:00:00Z"; // the clock starts at 20:00Z
    const h = harness(undefined, [{ publishedAt, text: "Uutta: <b>/kuvaaja</b> on täällä!" }]);
    const register = async (id: number) => {
      await h.press(id, "m:r");
      await h.send(id, "80");
      await h.send(id, "180");
      await h.press(id, "m:r:g:m");
      await h.press(id, "m:r:t:y");
    };
    await register(1); // registered before the announcement
    expect(textOf(await h.send(1, "/help"))).not.toContain("Tiedote"); // not published yet

    h.clock.now = Date.parse(publishedAt) + 60_000;
    expect(textOf(await h.send(1, "/promillet", { id: -5, title: "G" }))).not.toContain("Tiedote"); // not in groups
    const first = textOf(await h.send(1, "/help"));
    expect(first).toContain("📣 <b>Tiedote 6.11.2026</b>");
    expect(first).toContain("Uutta: <b>/kuvaaja</b> on täällä!");
    expect(textOf(await h.send(1, "/help"))).not.toContain("Tiedote"); // only once

    await register(2); // registered after it
    expect(textOf(await h.send(2, "/help"))).not.toContain("Tiedote");
  });

  test("Alko product search: typed search in the menu, inline mode, and the inline-feedback guard", async () => {
    const products = new Products();
    products.load(catalogJson());
    const h = harness(undefined, [], products);
    const A = 4004;

    // Unregistered: inline search points to registration
    const anon = (await h.inlineQuery(A, "karhu")).find((c) => c.method === "answerInlineQuery")!;
    expect(anon.payload.results).toEqual([]);
    expect(anon.payload.button).toEqual({ text: "Luo ensin tunnus", start_parameter: "tunnus" });
    expect(textOf(await h.send(A, "/start tunnus"))).toContain("Aloita syöttämällä painosi");
    await h.send(A, "80");
    await h.send(A, "180");
    await h.press(A, "m:r:g:m");
    await h.press(A, "m:r:t:y");
    const uid = h.account(A);

    // Juo menu has the search button (typed search, since inline mode is off for this bot)
    const juo = await h.press(A, "m:j");
    expect(buttonsOf(juo).find((b) => b.text === "🔎 Hae Alkosta")?.callback_data).toBe("m:jh");

    await h.press(A, "m:jh");
    const results = await h.send(A, "karhu");
    const resultButtons = buttonsOf(results).map((b) => b.text);
    expect(resultButtons).toContain("🍺 Karhu 5,3 · 33 cl"); // package words dropped
    expect(textOf(await h.send(A, "xyzzy"))).toContain("Ei osumia"); // still in the search flow

    // Product view: amounts only, plus a custom amount
    await h.send(A, "karjala");
    const karjala = await h.press(A, "m:p:700004");
    expect(buttonsOf(karjala).map((b) => b.text)).toEqual(["50 cl · 2.6 annosta · 350 kcal", "✏️ Muu määrä", "🔎 Hae lisää", "« Takaisin"]);
    const karjalaSaved = textOf(await h.press(A, "m:ps:700004:c50"));
    expect(karjalaSaved).toContain("Juoma tallennettu: 🍺 Karjala (50 cl)\nTämän illan juomissa on noin <b>350</b> kcal.");
    expect(h.services.drinks.last(uid)).toMatchObject({ description: "🍺 Karjala (50 cl)", productId: "700004", kcal: 350 });

    // Wine: choose a glass, buttons show standard drinks
    const wine = await h.press(A, "m:p:700010");
    // Maker, country, ABV; energy, the 75 cl bottle's price and the price of one standard drink
    expect(textOf(wine)).toContain("Château Testi · Ranska · 13 %\n80 kcal / 100 ml · Alkossa 14,90 € / 75 cl · 2,32 € / annos");
    expect(textOf(wine)).not.toContain("Alkometriikassa"); // no Alkometriikka URL configured in this test
    expect(textOf(wine)).toContain('<a href="https://www.alko.fi/tuotteet/700010/">Alkon sivulla</a>'); // plain link, no tracking
    expect(buttonsOf(wine).map((b) => b.text)).toEqual(expect.arrayContaining(["37.5 cl · 3.2 annosta · 300 kcal", "75 cl · 6.4 annosta · 600 kcal"]));
    const glass = buttonsOf(wine).find((b) => b.text.startsWith("16 cl"))!;
    expect(glass.text).toBe("16 cl · 1.4 annosta · 128 kcal");
    // The evening's energy adds up across drinks (350 + 128, rounded to 10)
    expect(textOf(await h.press(A, glass.callback_data))).toContain("Château Testi 2022 (16 cl)\nTämän illan juomissa on noin <b>480</b> kcal.");
    expect(h.services.drinks.last(uid)).toMatchObject({ productId: "700010", kcal: 128 });
    // A product without energy data shows no kcal
    expect(buttonsOf(await h.press(A, "m:p:700013")).map((b) => b.text)[0]).toBe("12 cl · 1.3 annosta");

    // Quick-repeat buttons keep the product id
    const quick = buttonsOf(await h.press(A, "m:j")).find((b) => b.text.includes("Château"))!;
    await h.press(A, quick.callback_data);
    expect(h.services.drinks.last(uid)).toMatchObject({ productId: "700010", kcal: 128 });

    // Inline mode: results per serving, only in the private chat with the bot
    const answer = (await h.inlineQuery(A, "jallu")).find((c) => c.method === "answerInlineQuery")!;
    // One drink for all four Jaloviina *** packages (and one for Jaloviina *), one result per serving
    expect(answer.payload.results.map((r: { id: string }) => r.id)).toEqual(["700022:2", "700022:4", "700022:6", "700025:2", "700025:4", "700025:6"]);
    // Second line: energy and the price of this amount (4 cl of the 70 cl bottle at 33,90 €)
    expect(answer.payload.results[1]).toMatchObject({ title: "🥃 Jaloviina ***", description: "4 cl · 38 % · 1.0 annosta\n84 kcal · Alkossa 1,94 €" });
    // each result carries the product photo as a thumbnail
    expect(answer.payload.results[1]).toMatchObject({
      thumbnail_url: "https://images.alko.fi/images/cs_srgb,f_auto,t_products/cdn/700022/kuva.jpg",
      thumbnail_width: 160,
      thumbnail_height: 192,
    });
    expect(answer.payload.is_personal).toBe(true);
    const inGroup = (await h.inlineQuery(A, "jallu", "supergroup")).find((c) => c.method === "answerInlineQuery")!;
    expect(inGroup.payload.results).toEqual([]);
    expect(inGroup.payload.button.start_parameter).toBe("juo");
    // Empty query: your recent products
    const recentAnswer = (await h.inlineQuery(A, "")).find((c) => c.method === "answerInlineQuery")!;
    expect(recentAnswer.payload.results[0].id).toStartWith("700010:");

    // Picking a result logs it and confirms privately; the "via bot" message isn't typed input
    h.clock.now += 60_000;
    const picked = await h.chooseInline(A, "700022:4");
    expect(textOf(picked)).toContain("Juoma tallennettu: 🥃 Jaloviina *** (4 cl)");
    expect(picked[0]!.payload.chat_id).toBe(A);
    expect(h.services.drinks.last(uid)).toMatchObject({ productId: "700022", alcoholMg: Math.round(0.38 * 789.24 * 0.04 * 1000) });
    expect(await h.sendViaBot(A, "🥃 Jaloviina *** (4 cl)")).toEqual([]);
    await Bun.sleep(40);
    expect(textOf(h.calls.slice(-1))).not.toContain("inline-palaute");

    // If BotFather inline feedback is off, no chosen_inline_result comes: tell the user once
    await h.sendViaBot(A, "🍺 Karjala (50 cl)");
    await Bun.sleep(40);
    expect(textOf(h.calls.slice(-1))).toContain("inline-palaute on pois päältä");
  });

  test("typing a drink name in the private chat searches the catalogue", async () => {
    const products = new Products();
    products.load(catalogJson());
    const h = harness(undefined, [], products);
    const A = 5005;
    expect(textOf(await h.send(A, "karhu"))).toContain("Mitä?"); // no account yet
    await h.press(A, "m:r");
    await h.send(A, "80");
    await h.send(A, "180");
    await h.press(A, "m:r:g:m");
    await h.press(A, "m:r:t:y");

    const plain = await h.send(A, "karhu");
    expect(textOf(plain)).toContain("Osumat haulle <b>karhu</b>");
    expect(buttonsOf(plain).some((b) => b.callback_data.startsWith("m:p:"))).toBe(true);
    // The next message refines the search
    expect(textOf(await h.send(A, "karjala"))).toContain("Osumat haulle <b>karjala</b>");
    // "@bot query" sent as a message (instead of picking an inline result) works too
    await h.press(A, "m:s");
    expect(textOf(await h.send(A, "@kili_test_bot jallu"))).toContain("Osumat haulle <b>jallu</b>");
    await h.press(A, "m:s");
    expect(textOf(await h.send(A, "moi mitä kuuluu"))).toContain("Mitä?"); // no matches → not understood
  });

  test("custom amounts: Muu määrä in the menu, amount in a typed search, amount in an inline query", async () => {
    const products = new Products();
    products.load(catalogJson());
    const h = harness(undefined, [], products);
    const A = 6006;
    await h.press(A, "m:r");
    await h.send(A, "80");
    await h.send(A, "180");
    await h.press(A, "m:r:g:m");
    await h.press(A, "m:r:t:y");
    const uid = h.account(A);
    const mg = (abv: number, litres: number) => Math.round((abv / 100) * 789.24 * litres * 1000);

    // ✏️ Muu määrä
    const prompt = await h.press(A, "m:pc:700022");
    expect(textOf(prompt)).toContain("Kirjoita juomasi määrä");
    expect(textOf(await h.send(A, "paljon"))).toContain("En ymmärtänyt määrää");
    expect(textOf(await h.send(A, "1 l"))).toContain("liian suuri");
    expect(textOf(await h.send(A, "3"))).toContain("Juoma tallennettu: 🥃 Jaloviina *** (3 cl)");
    expect(h.services.drinks.last(uid)).toMatchObject({ alcoholMg: mg(38, 0.03), productId: "700022" });
    expect(textOf(await h.send(A, "3"))).toContain("Mitä?"); // the flow ended

    // Amount in a typed search: one tap logs exactly that
    h.clock.now += 60_000;
    await h.press(A, "m:jh");
    const results = await h.send(A, "jallu 2,5 cl");
    expect(textOf(results)).toContain("Osumat haulle <b>jallu (2.5 cl)</b>");
    const hit = buttonsOf(results).find((b) => b.text === "🥃 Jaloviina *** · 2.5 cl")!;
    expect(textOf(await h.press(A, hit.callback_data))).toContain("(2.5 cl)");
    expect(h.services.drinks.last(uid)!.alcoholMg).toBe(mg(38, 0.025));
    expect(textOf(await h.send(A, "jallu 2 l"))).toContain("liian suuri");

    // Amount in an inline query
    h.clock.now += 60_000;
    const answer = (await h.inlineQuery(A, "karhu 4,6 40cl")).find((c) => c.method === "answerInlineQuery")!;
    expect(answer.payload.results[0]).toMatchObject({
      id: "700002:x40",
      title: "🍺 Karhu 4,6",
      description: "40 cl · 4.6 % · 1.2 annosta\n160 kcal · Alkossa 2,78 €",
    });
    expect(textOf(await h.chooseInline(A, "700002:x40"))).toContain("🍺 Karhu 4,6 (40 cl)");
    expect(h.services.drinks.last(uid)).toMatchObject({ alcoholMg: mg(4.6, 0.4), kcal: 160 });
  });

  test("account linking: hidden by default; /yhdista links an account made on another platform", async () => {
    const off = harness();
    await off.press(1, "m:r");
    await off.send(1, "80");
    await off.send(1, "180");
    await off.press(1, "m:r:g:m");
    await off.press(1, "m:r:t:y");
    expect(buttonsOf(await off.press(1, "m:a")).map((b) => b.callback_data)).not.toContain("m:al");
    expect(textOf(await off.send(1, "/yhdista ABCD-EFGH"))).toContain("Mitä?");
    expect(textOf(await off.send(1, "/komennot"))).not.toContain("/yhdista");

    const h = harness(undefined, [], undefined, { accountLinking: true });
    const A = 7007;
    // Someone registered on Discord (no bot yet: straight through the services) and made a code
    const discordAccount = h.services.accounts.register(
      { platform: "discord", platformUserId: "1234567890123456789" },
      { name: "kili_fani", weight: 70, height: 170, gender: "nainen" },
    ).profile;
    h.services.drinks.add(discordAccount.id, 12000, "olut discordissa");
    expect(textOf(await h.send(A, "/yhdista"))).toContain("/yhdista KOODI");
    expect(textOf(await h.send(A, "/yhdista WRONG123"))).toContain("väärä tai vanhentunut");
    const { code } = h.services.identities.createLinkCode(discordAccount.id);

    expect(textOf(await h.send(A, `/yhdista ${code.slice(0, 4)}-${code.slice(4)}`))).toContain("Yhdistetty! Voit nyt käyttää tunnustasi kili_fani");
    expect(h.account(A)).toBe(discordAccount.id);
    // Same account from Telegram: the Discord drink is there, and Telegram drinks go to it
    expect(textOf(await h.send(A, "/promillet"))).toContain("olut discordissa");
    await h.press(A, "m:d:b50");
    expect(h.services.drinks.since(discordAccount.id, 0)).toHaveLength(2);

    // Settings → Yhdistetyt palvelut: lists both, offers to unlink only the other platform
    expect(buttonsOf(await h.press(A, "m:a")).map((b) => b.callback_data)).toContain("m:al");
    const links = await h.press(A, "m:al");
    expect(textOf(links)).toContain("- Discord\n- Telegram (tämä)");
    expect(buttonsOf(links).map((b) => b.callback_data)).toEqual(["m:alc", "m:alu:discord", "m:a"]);
    expect(textOf(await h.press(A, "m:alc"))).toMatch(/<code>\/yhdista [A-Z2-9]{4}-[A-Z2-9]{4}<\/code>/);
    // This login can't be unlinked from here, even with crafted callback data
    await h.press(A, "m:aluy:telegram");
    expect(h.services.identities.list(discordAccount.id)).toHaveLength(2);
    expect(textOf(await h.press(A, "m:alu:discord"))).toContain("Irrotetaanko Discord");
    expect(textOf(await h.press(A, "m:aluy:discord"))).toContain("Discord irrotettu.");
    expect(h.services.identities.list(discordAccount.id).map((i) => i.platform)).toEqual(["telegram"]);

    // A Telegram user with an account of their own can't join another account
    const B = 8008;
    await h.press(B, "m:r");
    await h.send(B, "80");
    await h.send(B, "180");
    await h.press(B, "m:r:g:m");
    await h.press(B, "m:r:t:y");
    const other = h.services.identities.createLinkCode(discordAccount.id).code;
    expect(textOf(await h.send(B, `/yhdista ${other}`))).toContain("on jo oma tunnus");
  });
});

// ---------- Barcodes ----------

const BEER_EAN = "4006381333931"; // Karjala, in the catalogue's EAN column
const WORKER_EAN = "96385074"; // not in the catalogue: the API Worker knows it (Karjala again)
const ALCOHOL_FREE_EAN = "4006381334013"; // Karhu 0,0 (700040), which the bot can't log
const UNKNOWN_EAN = "4006381333948"; // Alko doesn't know it

/** A tiny stand-in for the API Worker's GET /gtin/{ean}. */
function fakeWorker() {
  const requests: { path: string; headers: Headers }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, headers: new Headers(init?.headers) });
    const ean = url.pathname.split("/").pop()!;
    if (ean === ALCOHOL_FREE_EAN) return new Response(JSON.stringify({ id: "700040" }));
    if (ean === WORKER_EAN) return new Response(JSON.stringify({ id: "700004" }));
    if (ean === "4006381333955") return new Response("{}", { status: 429 });
    if (ean === "4006381333962") return new Response("{}", { status: 502 });
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  }) as typeof fetch;
  return { fetchFn, requests };
}

function barcodeHarness(photos: Record<string, string | null> = {}) {
  const products = new Products();
  products.load(catalogJson());
  const worker = fakeWorker();
  const service = new Barcodes({ url: "https://api.test", fetch: worker.fetchFn });
  const io: BarcodeIO = {
    download: async (_ctx, fileId) => new TextEncoder().encode(fileId),
    decode: async (bytes) => photos[new TextDecoder().decode(bytes)] ?? null,
  };
  return { h: harness(undefined, [], products, {}, { service, io }), worker };
}

async function registerUser(h: ReturnType<typeof harness>, id: number) {
  await h.press(id, "m:r");
  await h.send(id, "80");
  await h.send(id, "180");
  await h.press(id, "m:r:g:m");
  await h.press(id, "m:r:t:y");
}

describe("barcodes", () => {
  test("a barcode in the catalogue opens its product without asking the Worker", async () => {
    const { h, worker } = barcodeHarness();
    await registerUser(h, 6001);
    const hit = await h.send(6001, BEER_EAN);
    expect(textOf(hit)).toContain("kuuluu tälle tuotteelle");
    expect(textOf(hit)).toContain("Karjala");
    expect(buttonsOf(hit).some((b) => b.callback_data.startsWith("m:ps:700004"))).toBe(true);
    expect(worker.requests).toEqual([]);
  });

  test("other barcodes are asked from the Worker, which gets only the number", async () => {
    const { h, worker } = barcodeHarness();
    await registerUser(h, 6002);
    const hit = await h.send(6002, WORKER_EAN);
    expect(textOf(hit)).toContain("Karjala");
    expect(worker.requests.map((r) => r.path)).toEqual([`/gtin/${WORKER_EAN}`]);
    expect(worker.requests[0]!.headers.get("authorization")).toBeNull();
    expect(worker.requests[0]!.headers.get("x-voter")).toBeNull();
    // answered from memory the second time
    await h.send(6002, WORKER_EAN);
    expect(worker.requests.length).toBe(1);
  });

  test("an alcohol-free product is named, not reported as missing", async () => {
    const { h } = barcodeHarness();
    await registerUser(h, 6006);
    expect(textOf(await h.send(6006, ALCOHOL_FREE_EAN))).toContain("alkoholiton");
    expect(textOf(await h.send(6006, ALCOHOL_FREE_EAN))).toContain("Karhu 0,0");
  });

  test("unknown barcodes, Worker errors and bad numbers get their own messages", async () => {
    const { h } = barcodeHarness();
    await registerUser(h, 6003);
    expect(textOf(await h.send(6003, UNKNOWN_EAN))).toContain("Alko ei tunne viivakoodia");
    expect(textOf(await h.send(6003, "4006381333955"))).toContain("haettu juuri paljon");
    expect(textOf(await h.send(6003, "4006381333962"))).toContain("haku ei onnistunut");
    expect(textOf(await h.send(6003, "12345"))).toContain("Mitä?");
  });

  test("a photo of a barcode is read and looked up (UPC-A is normalised to 13 digits)", async () => {
    const { h } = barcodeHarness({ photoA: BEER_EAN, photoB: "036000291452", blank: null });
    await registerUser(h, 6004);
    expect(textOf(await h.sendPhoto(6004, "blank"))).toContain("En löytänyt kuvasta viivakoodia");
    expect(textOf(await h.sendPhoto(6004, "photoA"))).toContain("Karjala");
    expect(textOf(await h.sendPhoto(6004, "photoB"))).toContain("Alko ei tunne viivakoodia");
  });

  test("barcodes only work with the catalogue or the Worker", async () => {
    const h = harness();
    await registerUser(h, 6005);
    expect(textOf(await h.send(6005, BEER_EAN))).toContain("Mitä?");
    expect(textOf(await h.sendPhoto(6005, "x"))).toContain("eivät ole käytössä");
  });
});

describe("/web", () => {
  test("gives a login link that signs the account in, once", async () => {
    const h = harness(undefined, [], undefined, { web: { enabled: true, origin: "https://kili.test", port: 0, distDir: "" } });
    expect(textOf(await h.send(7001, "/web"))).toContain("Luo tunnus"); // needs an account
    await registerUser(h, 7001);

    const reply = textOf(await h.send(7001, "/web"));
    const url = /href="(https:\/\/kili\.test\/login#t=[\w-]+)"/.exec(reply)?.[1];
    expect(url).toBeDefined();
    expect(reply).toContain("vanhenee 10 minuutissa");
    const token = url!.split("#t=")[1]!;
    const session = h.services.webSessions.redeemLoginLink(token);
    expect(session).not.toBeNull();
    expect(h.services.webSessions.authenticate(session!.sessionToken)?.accountId).toBe(h.account(7001));
    expect(h.services.webSessions.redeemLoginLink(token)).toBeNull();
  });

  test("on plain http (development) the URL is shown as text, because Telegram drops localhost links", async () => {
    const h = harness(undefined, [], undefined, { web: { enabled: true, origin: "http://localhost:8081", port: 0, distDir: "" } });
    await registerUser(h, 7002);
    const reply = textOf(await h.send(7002, "/web"));
    expect(reply).toMatch(/<code>http:\/\/localhost:8081\/login#t=[\w-]+<\/code>/);
    expect(reply).not.toContain("<a ");
  });

  test("the privacy text describes the website only while it is on", async () => {
    const on = harness(undefined, [], undefined, { web: { enabled: true, origin: "https://kili.test", port: 0, distDir: "" } });
    const privacyOn = textOf(await on.press(7010, "m:hp"));
    expect(privacyOn).toContain("Verkkosivu");
    expect(privacyOn).toContain("näyttölinkin");
    expect(privacyOn).toContain("ryhmien nimet salattuna"); // stored whenever someone says /moro, website or not

    const off = harness(undefined, [], undefined, { web: { enabled: false, origin: "", port: 0, distDir: "" } });
    const privacyOff = textOf(await off.press(7011, "m:hp"));
    expect(privacyOff).not.toContain("Verkkosivu");
    expect(privacyOff).not.toContain("näyttölinkin");
    expect(privacyOff).toContain("ryhmien nimet salattuna");
  });

  test("does not exist while the website is off", async () => {
    const h = harness(undefined, [], undefined, { web: { enabled: false, origin: "", port: 0, distDir: "" } });
    await registerUser(h, 7003);
    expect(textOf(await h.send(7003, "/web"))).not.toContain("login#t=");
    expect(textOf(await h.send(7003, "/komennot"))).not.toContain("/web");
  });
});
