// Live updates over server-sent events (see ../sse.ts for the Hub).
//
// Channels: "u:<account>" a person's dashboard, "g:<group>:<account>" a group page as one of its
// members sees it, "s:<token hash>" an event screen.

import type { Services } from "../../services/index.ts";
import { fail } from "../http.ts";
import { Hub, type HubOptions } from "../sse.ts";
import type { Ctx } from "./context.ts";
import type { Views } from "./views.ts";

export function createLive(services: Services, views: Views, timing?: Pick<HubOptions, "tickMs" | "minGapMs" | "maxTotal" | "maxPerOwner">) {
  const hub = new Hub({
    bus: services.bus,
    ...timing,
    channelsFor(change, watched) {
      const groupIds = new Set<string>(change.groupId ? [change.groupId] : []);
      if (change.accountId && watched.some((w) => !w.startsWith("u:"))) for (const g of services.groups.groupIdsOf(change.accountId)) groupIds.add(g);
      const out: string[] = [];
      for (const w of watched) {
        if (w.startsWith("u:")) {
          if (w === `u:${change.accountId}`) out.push(w);
        } else if (w.startsWith("g:")) {
          const [, groupId, accountId] = w.split(":");
          if (groupIds.has(groupId!) || accountId === change.accountId) out.push(w);
        } else if (w.startsWith("s:")) {
          if (w === `s:${change.screenHash}`) {
            out.push(w);
            continue;
          }
          const access = services.screens.byHash(w.slice(2));
          if (access && ((access.groupId && groupIds.has(access.groupId)) || (access.accountId && access.accountId === change.accountId))) out.push(w);
        }
      }
      return out;
    },
    render(channel) {
      if (channel.startsWith("u:")) {
        const p = services.accounts.get(channel.slice(2));
        return p ? views.dashboard(p) : null;
      }
      if (channel.startsWith("g:")) {
        const [, groupId, accountId] = channel.split(":");
        const p = accountId ? services.accounts.get(accountId) : null;
        return p && groupId ? views.groupView(p, groupId) : null;
      }
      if (channel.startsWith("s:")) {
        const access = services.screens.byHash(channel.slice(2));
        return access ? views.screenView(access) : null;
      }
      return null;
    },
  });

  /** An event stream of `channel`; `owner` (an account or a screen) has a limit on open streams. */
  function stream(c: Ctx, channel: string, owner: string): Response {
    if (!hub.hasRoom(owner)) return fail(429, "too_many_streams");
    // Streams stay open for hours; Bun would close them after its idle timeout.
    c.server.timeout(c.req, 0);
    const encoder = new TextEncoder();
    let stop: (() => void) | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stop = hub.subscribe(
          channel,
          owner,
          (text) => controller.enqueue(encoder.encode(text)),
          () => controller.close(),
        );
      },
      cancel() {
        stop?.();
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
    });
  }

  return {
    stream,
    /** Tells the owner's open pages to stop (signed out everywhere). */
    endOwner: (owner: string) => hub.endOwner(owner),
    viewers: () => hub.viewers,
    close: () => hub.close(),
  };
}

export type Live = ReturnType<typeof createLive>;
