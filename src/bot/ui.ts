import { InputFile } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import type { BotContext } from "./context.ts";
import { S } from "../strings.ts";

export interface View {
  text: string;
  keyboard: InlineKeyboardButton[][];
}

export const CB_MENU = "m:";

export const btn = (text: string, node: string): InlineKeyboardButton => ({
  text,
  callback_data: CB_MENU + node,
});
export const back = (node: string) => [btn(S.back, node)];

const MAX_LEN = 4000; // Telegram limit is 4096 characters

/** Cuts overly long texts (e.g. a big drink list) at a line boundary. */
export function clip(text: string): string {
  if (text.length <= MAX_LEN) return text;
  const cut = text.lastIndexOf("\n", MAX_LEN - 2);
  return text.slice(0, cut > 0 ? cut : MAX_LEN - 2) + "\n…";
}

export function sendHtml(ctx: BotContext, text: string, keyboard?: InlineKeyboardButton[][]) {
  return ctx.reply(clip(text), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: keyboard && keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
  });
}

export const sendView = (ctx: BotContext, view: View) => sendHtml(ctx, view.text, view.keyboard);

/** Replaces the menu message in place; falls back to a new message if it can't be edited. */
export async function editView(ctx: BotContext, view: View) {
  try {
    await ctx.editMessageText(clip(view.text), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: view.keyboard },
    });
  } catch (err) {
    const description = (err as { description?: string }).description ?? "";
    if (description.includes("message is not modified")) return;
    await sendView(ctx, view);
  }
}

/** /data: sends the user's data as CSV files (private chat only). */
export async function sendExport(ctx: BotContext, telegramUserId: number): Promise<boolean> {
  const { userId, services } = ctx.kili;
  const files = userId ? services.accounts.exportCsv(userId, telegramUserId) : null;
  if (!files) {
    await sendHtml(ctx, S.commands.data_none);
    return false;
  }
  await sendHtml(ctx, S.commands.data_reply);
  for (const f of files) {
    await ctx.replyWithDocument(new InputFile(new TextEncoder().encode(f.csv), f.filename));
  }
  return true;
}
