// Photos the website shows from elsewhere, fetched by the server so a visitor's browser never
// contacts those services: Alko's product photos (search results) and a Telegram group's photo
// (event screens). The outside service sees only this server, never a visitor's address,
// browser, cookies or the page they came from.
//
// Photos are small and the same for everyone, so they are kept in memory only, up to a byte
// budget, least recently used dropped first. Concurrent requests for one photo share a fetch, and
// "there is no photo" is remembered for a while.

export type Photo = { bytes: Uint8Array; type: string };
export type PhotoResult = Photo | "missing" | "unavailable";

const TIMEOUT_MS = 8000;
const MAX_PHOTO_BYTES = 512 * 1024;
const MISSING_TTL_MS = 3600_000;

interface CacheOptions {
  now?: () => number;
  maxBytes?: number;
  /** How long a found photo is kept; Infinity = until memory runs out. */
  foundTtlMs?: number;
}

class PhotoCache {
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly foundTtlMs: number;
  private readonly found = new Map<string, Photo & { until: number }>(); // insertion order = LRU first
  private bytes = 0;
  private readonly missing = new Map<string, number>(); // key → until
  private readonly inFlight = new Map<string, Promise<PhotoResult>>();

  constructor(opts: CacheOptions) {
    this.now = opts.now ?? Date.now;
    this.maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
    this.foundTtlMs = opts.foundTtlMs ?? Infinity;
  }

  get(key: string, load: () => Promise<PhotoResult>): Promise<PhotoResult> {
    const hit = this.found.get(key);
    if (hit) {
      this.forget(key);
      if (hit.until > this.now()) {
        this.keep(key, hit);
        return Promise.resolve({ bytes: hit.bytes, type: hit.type });
      }
    }
    const until = this.missing.get(key);
    if (until !== undefined) {
      if (until > this.now()) return Promise.resolve("missing");
      this.missing.delete(key);
    }
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = load()
        .catch((): PhotoResult => "unavailable")
        .then((result) => {
          if (result === "missing") this.missing.set(key, this.now() + MISSING_TTL_MS);
          else if (result !== "unavailable") this.keep(key, { ...result, until: this.now() + this.foundTtlMs });
          return result;
        })
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  private keep(key: string, photo: Photo & { until: number }) {
    this.found.set(key, photo);
    this.bytes += photo.bytes.byteLength;
    for (const [oldKey] of this.found) {
      if (this.bytes <= this.maxBytes) break;
      this.forget(oldKey);
    }
  }

  private forget(key: string) {
    const old = this.found.get(key);
    if (!old) return;
    this.found.delete(key);
    this.bytes -= old.bytes.byteLength;
  }
}

/** Only what any client sends; nothing that came from the visitor. */
export const fetchInit = (accept: string, timeoutMs = TIMEOUT_MS): RequestInit => ({
  headers: { accept, "user-agent": "Blakkiskili" },
  credentials: "omit",
  referrerPolicy: "no-referrer",
  redirect: "error",
  signal: AbortSignal.timeout(timeoutMs),
});

async function readBody(res: Response): Promise<Uint8Array | null> {
  if (Number(res.headers.get("content-length") ?? 0) > MAX_PHOTO_BYTES) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return bytes.byteLength > 0 && bytes.byteLength <= MAX_PHOTO_BYTES ? bytes : null;
}

/** The image type from the file's first bytes, for sources that don't say (Telegram's files). */
export function sniffImageType(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

// ---------- Alko ----------

const ALKO_IMAGES = "https://images.alko.fi/images/t_products/cdn";
const ALKO_TYPES = new Set(["image/webp", "image/jpeg", "image/png", "image/avif"]);

export interface ProductPhotosOptions {
  fetch?: typeof fetch;
  now?: () => number;
  maxBytes?: number;
}

/** Alko's 160×192 product thumbnails (~5 KB WebP). The request carries the product number only. */
export class ProductPhotos {
  private readonly fetchFn: typeof fetch;
  private readonly cache: PhotoCache;

  constructor(opts: ProductPhotosOptions = {}) {
    this.fetchFn = opts.fetch ?? fetch;
    this.cache = new PhotoCache(opts);
  }

  /** `id` must already be a known catalogue product number. */
  get(id: string): Promise<PhotoResult> {
    return this.cache.get(id, async () => {
      const res = await this.fetchFn(`${ALKO_IMAGES}/${encodeURIComponent(id)}/kuva.webp`, fetchInit("image/webp,image/*"));
      if (res.status >= 400 && res.status < 500) return "missing"; // Alko answers 400 for a product without a photo
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!res.ok || !ALKO_TYPES.has(type)) {
        await res.body?.cancel().catch(() => {});
        return "unavailable";
      }
      const bytes = await readBody(res);
      return bytes ? { bytes, type } : "unavailable";
    });
  }
}

// ---------- Telegram ----------

export interface GroupPhotosOptions {
  botToken: string;
  /** Bot API base, for tests. */
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * A Telegram group's photo (its small 160×160 version) through the Bot API: getChat, getFile,
 * download. Kept an hour, so a changed photo shows up. URLs carry the bot token: never log them.
 */
export class GroupPhotos {
  private readonly fetchFn: typeof fetch;
  private readonly api: string;
  private readonly cache: PhotoCache;

  constructor(private readonly opts: GroupPhotosOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.api = (opts.apiUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.cache = new PhotoCache({ now: opts.now, maxBytes: 4 * 1024 * 1024, foundTtlMs: 3600_000 });
  }

  /** `key` names the group in the cache (its derived id); `chatId` is what Telegram needs. */
  get(key: string, chatId: number): Promise<PhotoResult> {
    return this.cache.get(key, async () => {
      const chat = await this.call<{ photo?: { small_file_id?: string } }>("getChat", { chat_id: String(chatId) });
      if (chat === "unavailable") return chat;
      const fileId = chat?.photo?.small_file_id;
      if (!fileId) return "missing"; // no photo, or the bot is no longer in the chat
      const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
      if (file === "unavailable") return file;
      if (!file?.file_path) return "missing";
      const res = await this.fetchFn(`${this.api}/file/bot${this.opts.botToken}/${file.file_path}`, fetchInit("image/*"));
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return "unavailable";
      }
      const bytes = await readBody(res);
      const type = bytes && sniffImageType(bytes);
      return bytes && type ? { bytes, type } : "unavailable";
    });
  }

  /** The result, null when Telegram refuses (chat gone, bot removed), "unavailable" when it can't be asked. */
  private async call<T>(method: string, params: Record<string, string>): Promise<T | null | "unavailable"> {
    const res = await this.fetchFn(`${this.api}/bot${this.opts.botToken}/${method}?${new URLSearchParams(params)}`, fetchInit("application/json"));
    if (res.status >= 500 || res.status === 429) {
      await res.body?.cancel().catch(() => {});
      return "unavailable";
    }
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: T } | null;
    return body?.ok ? (body.result ?? null) : null;
  }
}
