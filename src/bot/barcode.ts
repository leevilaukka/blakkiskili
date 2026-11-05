// Barcodes in the private chat: typed digits and photos of a barcode.

import type { BotContext } from "./context.ts";
import { barcodeView, linkBarcode } from "./menu.ts";
import { back, sendHtml, sendView } from "./ui.ts";
import { S } from "../strings.ts";
import { normalizeEan } from "../lib/ean.ts";

/** Photo plumbing, replaceable in tests. */
export interface BarcodeIO {
  /** The bytes of a Telegram file. */
  download(ctx: BotContext, fileId: string): Promise<Uint8Array>;
  /** The barcode number in an image, or null if there is none. */
  decode(image: Uint8Array): Promise<string | null>;
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export function defaultBarcodeIO(): BarcodeIO {
  return {
    async download(ctx, fileId) {
      const file = await ctx.api.getFile(fileId);
      if (!file.file_path || (file.file_size ?? 0) > MAX_PHOTO_BYTES) throw new Error("Photo unavailable");
      const res = await fetch(`https://api.telegram.org/file/bot${ctx.kili.config.botToken}/${file.file_path}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Photo download failed: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async decode(image) {
      // Loaded on first use: the decoder is a WebAssembly module the bot rarely needs.
      const { readBarcodes } = await import("zxing-wasm/reader");
      const found = await readBarcodes(image, {
        formats: ["EAN-13", "EAN-8", "UPC-A"],
        tryHarder: true,
        maxNumberOfSymbols: 1,
      });
      return found.find((b) => b.isValid && normalizeEan(b.text))?.text ?? null;
    },
  };
}

/** A typed message that is a valid barcode number. False for anything else. */
export async function barcodeFromText(ctx: BotContext, text: string): Promise<boolean> {
  const { profile } = ctx.kili;
  if (!profile || !ctx.kili.services.barcodes.enabled || !normalizeEan(text)) return false;
  await sendView(ctx, await barcodeView(ctx, profile, text));
  return true;
}

/** A photo of a barcode: read it, then link it to the product being asked about or look it up. */
export async function handleBarcodePhoto(ctx: BotContext, io: BarcodeIO): Promise<void> {
  const { profile, userId, services } = ctx.kili;
  if (!profile || !userId) {
    await sendHtml(ctx, S.user404);
    return;
  }
  if (!services.barcodes.enabled) {
    await sendHtml(ctx, S.barcode.off);
    return;
  }
  const photos = ctx.message?.photo;
  const largest = photos?.[photos.length - 1];
  if (!largest) return;

  let ean: string | null;
  try {
    ean = await io.decode(await io.download(ctx, largest.file_id));
  } catch (e) {
    console.error("Barcode photo failed:", e);
    await sendHtml(ctx, S.barcode.photo_failed, [back("j")]);
    return;
  }
  if (!ean) {
    await sendHtml(ctx, S.barcode.no_code_in_photo, [back("j")]);
    return;
  }

  const state = services.pending.get(userId);
  if (state?.kind === "eanFor" && normalizeEan(ean)) {
    services.pending.clear(userId);
    await sendView(ctx, await linkBarcode(ctx, ean, state.productId));
    return;
  }
  await sendView(ctx, await barcodeView(ctx, profile, ean));
}
