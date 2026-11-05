// Periodic job: warn inactive users by private message, then delete their accounts.

import { GrammyError, type Api } from "grammy";
import type { Config } from "../config.ts";
import type { Services } from "../services/index.ts";
import { fmt } from "../lib/format.ts";
import { S } from "../strings.ts";
import { retentionParams } from "./context.ts";

const SEND_INTERVAL_MS = 50; // stay well under Telegram's ~30 messages/second limit

export interface JobResult {
  warned: number;
  undeliverable: number;
  failed: number;
  deleted: number;
}

export async function runInactivityJob(
  api: Api,
  services: Services,
  config: Config,
  sleep: (ms: number) => Promise<unknown> = Bun.sleep,
): Promise<JobResult> {
  const policy = config.inactivity;
  const result: JobResult = { warned: 0, undeliverable: 0, failed: 0, deleted: 0 };
  if (policy.deleteAfterDays <= 0) return result;

  const text = fmt(S.inactivity_warning, retentionParams(config));
  for (const target of services.inactivity.dueForWarning(policy)) {
    // Only Telegram can deliver for now. An account whose logins are all on platforms without a
    // running bot can never be warned, so it's handled like an undeliverable warning.
    // When another platform gets a bot, try its contact here too.
    const telegram = target.contacts.find((c) => c.platform === "telegram");
    if (!telegram) {
      services.inactivity.markWarned(target.userId);
      result.undeliverable += 1;
      continue;
    }
    try {
      await api.sendMessage(Number(telegram.address), text, { parse_mode: "HTML" });
      services.inactivity.markWarned(target.userId);
      result.warned += 1;
    } catch (err) {
      // 403: blocked the bot / deactivated; 400: chat not found. The message can never be
      // delivered, so count the warning as given. Anything else (network, 429) retries next run.
      if (err instanceof GrammyError && (err.error_code === 403 || err.error_code === 400)) {
        services.inactivity.markWarned(target.userId);
        result.undeliverable += 1;
      } else {
        result.failed += 1;
      }
    }
    await sleep(SEND_INTERVAL_MS);
  }

  result.deleted = services.inactivity.purge(policy);
  return result;
}
