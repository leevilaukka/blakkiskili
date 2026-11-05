import type { Announcement } from "../announcements.ts";
import type { Profile } from "./accounts.ts";
import type { Deps } from "./index.ts";

export interface DatedAnnouncement {
  publishedAt: number;
  text: string;
}

export class Announcements {
  private readonly list: DatedAnnouncement[];

  constructor(
    private readonly deps: Deps,
    list: readonly Announcement[],
  ) {
    this.list = list
      .map((a) => {
        const publishedAt = Date.parse(a.publishedAt);
        if (!Number.isFinite(publishedAt)) throw new Error(`Bad announcement date: ${a.publishedAt}`);
        return { publishedAt, text: a.text };
      })
      .sort((a, b) => a.publishedAt - b.publishedAt);
  }

  /** Published (not future-dated) announcements the user hasn't seen, oldest first. */
  unseen(profile: Profile): DatedAnnouncement[] {
    const now = this.deps.now();
    return this.list.filter((a) => a.publishedAt > profile.announcementsSeenAt && a.publishedAt <= now);
  }

  markSeen(userId: string) {
    this.deps.db.query("UPDATE users SET announcements_seen_at = ? WHERE id = ?").run(this.deps.now(), userId);
  }
}
