// Announcements shown once to every user, on their next private interaction with the bot
// after publishedAt. Users who register later never see older ones.
//
// To announce something: append an entry (newest last) and deploy. `text` is Telegram HTML:
// only <b>, <i>, <code> and <a href="..."> tags; escape & < > as &amp; &lt; &gt;.
//
// Example:
//   { publishedAt: "2026-12-01T12:00:00+02:00", text: "Uutta: /kuvaaja piirtää nyt myös ennusteen!" },

export interface Announcement {
  publishedAt: string; // ISO 8601 with offset
  text: string;
}

export const ANNOUNCEMENTS: Announcement[] = [];
