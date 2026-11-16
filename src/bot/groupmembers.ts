// Keeps group memberships in step with who is actually in the Telegram chat.
//
// Joining: memberships imported from the original bot's groups.csv are adopted when the bot is
// next used in that chat, but only for people Telegram says are in it. The file only proves who
// uploaded it: anyone who knows a chat's id can write its hash into one.
//
// Leaving: someone who leaves or is removed from the chat is taken off its listings and website
// group. Telegram sends the bot a "left the chat" service message (except in large groups, which
// may hide them) and, when the bot is an admin, a chat_member update for every change.

import { GrammyError, type Bot } from "grammy";
import type { ChatMember, User } from "grammy/types";
import { describeError } from "../lib/redact.ts";
import type { BotContext } from "./context.ts";

const inChat = (m: ChatMember) =>
  m.status === "creator" || m.status === "administrator" || m.status === "member" || (m.status === "restricted" && m.is_member);

// Chats whose imported members are being checked right now: two commands at once check only once.
const adopting = new Set<number>();

/**
 * Adopts the imported members of this chat whom Telegram confirms are in it, and forgets those it
 * says aren't. Returns how many were added. The sender is in the chat (they just wrote in it).
 */
export async function adoptLegacyMembers(ctx: BotContext): Promise<number> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return 0;
  const { services, profile } = ctx.kili;
  const pending = services.groups.legacyMembers(chatId);
  if (pending.length === 0 || adopting.has(chatId)) return 0;
  adopting.add(chatId);
  let adopted = 0;
  try {
    for (const accountId of pending) {
      const where = accountId === profile?.id ? "in" : await membership(ctx, chatId, accountId);
      if (where === "in") {
        services.groups.adoptLegacyMember(accountId, chatId);
        adopted += 1;
      } else if (where === "out") {
        services.groups.dropLegacyMember(accountId, chatId);
      }
      // "unknown": kept, and asked again the next time the bot is used in the chat.
    }
  } finally {
    adopting.delete(chatId);
  }
  return adopted;
}

async function membership(ctx: BotContext, chatId: number, accountId: string): Promise<"in" | "out" | "unknown"> {
  const contact = ctx.kili.services.identities.contacts(accountId).find((c) => c.platform === "telegram");
  const telegramId = Number(contact?.address);
  // No stored contact (yet): they are adopted when they use the bot in the chat themselves.
  if (!contact || !Number.isSafeInteger(telegramId)) return "unknown";
  try {
    return inChat(await ctx.api.getChatMember(chatId, telegramId)) ? "in" : "out";
  } catch (e) {
    if (e instanceof GrammyError && e.error_code === 400) return "out"; // not a participant of this chat
    console.error("Could not check a group member:", describeError(e));
    return "unknown";
  }
}

/** Takes the Telegram user off the chat's group, if they have an account. Silent: nothing is said in the group. */
function removeFromGroup(ctx: BotContext, user: User) {
  const chatId = ctx.chat?.id;
  if (user.is_bot || chatId === undefined) return;
  const { identities, groups } = ctx.kili.services;
  const accountId = identities.accountOf(identities.key({ platform: "telegram", platformUserId: user.id }));
  if (accountId) groups.leave(accountId, chatId);
}

export function registerMembershipUpdates(bot: Bot<BotContext>) {
  bot.on("message:left_chat_member", (ctx) => removeFromGroup(ctx, ctx.message.left_chat_member));
  bot.on("chat_member", (ctx) => {
    const { old_chat_member: before, new_chat_member: after } = ctx.chatMember;
    if (inChat(before) && !inChat(after)) removeFromGroup(ctx, after.user);
  });
}
