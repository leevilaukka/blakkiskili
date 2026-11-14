// The admins of a Telegram group, from the Bot API (getChatAdministrators). On the website they may
// stop any of the group's screen links, as a web group's owner may. Only the group's chat id goes
// to Telegram, which already knows its own admins; the answer (Telegram user ids) is compared with
// the account's own Telegram login here and kept in memory only.
//
// The chat id is known once a bot command has been used in the group (Groups.rememberChat); until
// then the group has no admins here, and only a link's maker can stop it.

import type { Services } from "../services/index.ts";
import { fetchInit } from "./photos.ts";

/** How old an answer may be when it decides something (stopping a link). */
export const ADMINS_FRESH_MS = 5 * 60_000;
/** After Telegram couldn't be asked, it isn't asked again about that group for this long. */
const RETRY_MS = 30_000;
/** The group page waits for the answer, so not for long. */
const TIMEOUT_MS = 3000;
const MAX_GROUPS = 2000;

export interface GroupAdminsOptions {
  botToken: string;
  /** Bot API base, for tests. */
  apiUrl?: string;
  fetch?: typeof fetch;
}

/** URLs carry the bot token: never log them. */
export class GroupAdmins {
  private readonly fetchFn: typeof fetch;
  private readonly api: string;
  /** Group id → the last answer; insertion order = oldest first. */
  private readonly known = new Map<string, { ids: ReadonlySet<number>; at: number }>();
  private readonly failedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<ReadonlySet<number> | null>>();

  constructor(
    private readonly services: Services,
    private readonly opts: GroupAdminsOptions,
  ) {
    this.fetchFn = opts.fetch ?? fetch;
    this.api = (opts.apiUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
  }

  /** Whether the account is an admin of the Telegram group, by an answer at most ADMINS_FRESH_MS old. False when it can't be found out. */
  async isAdmin(groupId: string, accountId: string): Promise<boolean> {
    const ids = this.telegramIds(accountId);
    if (ids.length === 0) return false;
    const admins = await this.fresh(groupId);
    return !!admins && ids.some((id) => admins.has(id));
  }

  /** By the last answer however old, without asking Telegram: for drawing pages (live updates can't wait). */
  wasAdmin(groupId: string, accountId: string): boolean {
    const admins = this.known.get(groupId)?.ids;
    return !!admins && this.telegramIds(accountId).some((id) => admins.has(id));
  }

  private telegramIds(accountId: string): number[] {
    return this.services.identities
      .contacts(accountId)
      .filter((c) => c.platform === "telegram")
      .map((c) => Number(c.address))
      .filter(Number.isSafeInteger);
  }

  private fresh(groupId: string): Promise<ReadonlySet<number> | null> {
    const chatId = this.services.groups.telegramChatId(groupId);
    if (chatId === null) return Promise.resolve(null);
    const now = this.services.deps.now();
    const hit = this.known.get(groupId);
    if (hit && now - hit.at < ADMINS_FRESH_MS) return Promise.resolve(hit.ids);
    const failed = this.failedAt.get(groupId);
    if (failed !== undefined && now - failed < RETRY_MS) return Promise.resolve(null);
    let pending = this.inFlight.get(groupId);
    if (!pending) {
      pending = this.ask(chatId)
        .catch(() => "unavailable" as const)
        .then((result) => {
          if (result === "unavailable") {
            this.failedAt.set(groupId, this.services.deps.now());
            return null;
          }
          this.failedAt.delete(groupId);
          this.known.delete(groupId);
          this.known.set(groupId, { ids: result, at: this.services.deps.now() });
          if (this.known.size > MAX_GROUPS) this.known.delete(this.known.keys().next().value!);
          return result;
        })
        .finally(() => this.inFlight.delete(groupId));
      this.inFlight.set(groupId, pending);
    }
    return pending;
  }

  /** The admins' Telegram ids; none when Telegram refuses (the bot was removed, the chat is gone). */
  private async ask(chatId: number): Promise<ReadonlySet<number> | "unavailable"> {
    const res = await this.fetchFn(`${this.api}/bot${this.opts.botToken}/getChatAdministrators?chat_id=${chatId}`, fetchInit("application/json", TIMEOUT_MS));
    if (res.status >= 500 || res.status === 429) {
      await res.body?.cancel().catch(() => {});
      return "unavailable";
    }
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: { user?: { id?: unknown } }[] } | null;
    if (!body?.ok || !Array.isArray(body.result)) return new Set();
    return new Set(body.result.map((m) => m.user?.id).filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id)));
  }
}
