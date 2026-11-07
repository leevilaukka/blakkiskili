// Server-sent events: pushes fresh data to open pages without them asking.
//
// A channel is one thing people watch ("u:<account>" now; group screens later). Each channel
// is rendered once per push and the same text is sent to all its viewers, so the cost grows
// with the number of watched channels, not viewers (the VPS has one CPU).
//
// A push happens (a) when the ChangeBus says something in the channel changed, at most once per
// `minGapMs`, and (b) every `tickMs` while anyone is watching, because the estimate falls with
// the clock even when nothing is logged. The tick also keeps idle connections alive.

import type { Change, ChangeBus } from "../services/changebus.ts";

export interface HubOptions {
  bus: ChangeBus;
  /** The data to send for a channel; null when it no longer exists (viewers are told to stop). */
  render: (channel: string) => unknown | null;
  /** Which of the channels people are watching right now a change affects. */
  channelsFor: (change: Change, watched: readonly string[]) => string[];
  tickMs?: number;
  /** A comment line sent to every viewer this often, so a quiet stream is never idle for long. */
  keepAliveMs?: number;
  minGapMs?: number;
  /** Open streams in total, and per owner (an account, or a screen token). */
  maxTotal?: number;
  maxPerOwner?: number;
}

interface Viewer {
  owner: string;
  send: (text: string) => void;
}

interface Channel {
  viewers: Set<Viewer>;
  lastPush: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class Hub {
  private readonly channels = new Map<string, Channel>();
  private readonly perOwner = new Map<string, number>();
  private total = 0;
  private ticker?: ReturnType<typeof setInterval>;
  private keeper?: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  private readonly tickMs: number;
  private readonly keepAliveMs: number;
  private readonly minGapMs: number;
  private readonly maxTotal: number;
  private readonly maxPerOwner: number;

  constructor(private readonly opts: HubOptions) {
    this.tickMs = opts.tickMs ?? 15_000;
    this.keepAliveMs = opts.keepAliveMs ?? 5_000;
    this.minGapMs = opts.minGapMs ?? 1_000;
    this.maxTotal = opts.maxTotal ?? 500;
    this.maxPerOwner = opts.maxPerOwner ?? 5;
    this.unsubscribe = opts.bus.subscribe((change) => {
      if (this.channels.size === 0) return;
      for (const channel of opts.channelsFor(change, [...this.channels.keys()])) this.notify(channel);
    });
  }

  get viewers() {
    return this.total;
  }

  hasRoom(owner: string): boolean {
    return this.total < this.maxTotal && (this.perOwner.get(owner) ?? 0) < this.maxPerOwner;
  }

  /** Starts sending to `send`, beginning with the current data. Returns how to stop, or null when full. */
  subscribe(channel: string, owner: string, send: (text: string) => void): (() => void) | null {
    if (!this.hasRoom(owner)) return null;
    const viewer: Viewer = { owner, send };
    let ch = this.channels.get(channel);
    if (!ch) this.channels.set(channel, (ch = { viewers: new Set(), lastPush: 0 }));
    ch.viewers.add(viewer);
    this.total += 1;
    this.perOwner.set(owner, (this.perOwner.get(owner) ?? 0) + 1);
    if (!this.ticker) this.ticker = setInterval(() => this.tick(), this.tickMs);
    if (!this.keeper) this.keeper = setInterval(() => this.keepAlive(), this.keepAliveMs);

    this.deliver(channel, viewer);
    return () => this.remove(channel, viewer);
  }

  /** Stops everything (timers and the bus listener). */
  close() {
    this.unsubscribe();
    if (this.ticker) clearInterval(this.ticker);
    if (this.keeper) clearInterval(this.keeper);
    this.ticker = undefined;
    this.keeper = undefined;
    for (const ch of this.channels.values()) if (ch.timer) clearTimeout(ch.timer);
    this.channels.clear();
    this.perOwner.clear();
    this.total = 0;
  }

  private remove(channel: string, viewer: Viewer) {
    const ch = this.channels.get(channel);
    if (!ch?.viewers.delete(viewer)) return;
    this.total -= 1;
    const left = (this.perOwner.get(viewer.owner) ?? 1) - 1;
    if (left <= 0) this.perOwner.delete(viewer.owner);
    else this.perOwner.set(viewer.owner, left);
    if (ch.viewers.size === 0) {
      if (ch.timer) clearTimeout(ch.timer);
      this.channels.delete(channel);
    }
    if (this.total === 0) {
      if (this.ticker) clearInterval(this.ticker);
      if (this.keeper) clearInterval(this.keeper);
      this.ticker = undefined;
      this.keeper = undefined;
    }
  }

  private message(channel: string): string | null {
    let data: unknown;
    try {
      data = this.opts.render(channel);
    } catch (e) {
      console.error("SSE render failed:", e);
      return ": render failed\n\n"; // keeps the connection alive; the next push tries again
    }
    return data === null ? null : `event: update\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private deliver(channel: string, only?: Viewer) {
    const ch = this.channels.get(channel);
    if (!ch) return;
    const text = this.message(channel);
    ch.lastPush = Date.now();
    for (const v of only ? [only] : [...ch.viewers]) {
      try {
        // null: the channel is gone (account deleted, screen link revoked). Tell the page to stop.
        v.send(text ?? "event: end\ndata: {}\n\n");
      } catch {
        this.remove(channel, v); // the connection is already closed
      }
    }
  }

  /** Something in the channel changed: push soon, but not more than once per minGapMs. */
  private notify(channel: string) {
    const ch = this.channels.get(channel);
    if (!ch || ch.timer) return;
    const wait = Math.max(0, ch.lastPush + this.minGapMs - Date.now());
    ch.timer = setTimeout(() => {
      ch.timer = undefined;
      this.deliver(channel);
    }, wait);
  }

  /** SSE comment lines are ignored by the browser; they only keep the connection from looking idle. */
  private keepAlive() {
    for (const [channel, ch] of this.channels) {
      for (const v of [...ch.viewers]) {
        try {
          v.send(": keepalive\n\n");
        } catch {
          this.remove(channel, v);
        }
      }
    }
  }

  private tick() {
    for (const channel of [...this.channels.keys()]) this.deliver(channel);
  }
}
