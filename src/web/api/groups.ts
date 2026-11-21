// Groups: listing, creating and joining them, and everything under /api/groups/<id>, which only
// members reach.

import { cleanGroupName, type GroupInfo } from "../../services/groups.ts";
import { fail, json } from "../http.ts";
import { memberRef } from "../boards.ts";
import type { Api, Ctx, Handler, Routes } from "./context.ts";
import type { Services } from "../../services/index.ts";
import { user, userOrVisitor } from "./guards.ts";
import { chartLabel } from "../../services/accounts.ts";
import { HOUR_MS } from "../../lib/units.ts";
import type { JamPreview } from "../../../shared/api.ts";
import { lifetime } from "./screens.ts";

interface Group {
  id: string;
  info: GroupInfo;
  isOwner: boolean;
}
type GroupHandler = (c: Ctx, g: Group) => Response | Promise<Response>;

export function groupRoutes({ services, views, live, groupAdmins }: Api): Routes {
  const { groups, screens } = services;

  /** A signed-in member of :group. Others get the same answer as for a group that doesn't exist. */
  const member = (h: GroupHandler): Handler =>
    user((c) => {
      const id = c.param("group", /^[0-9a-f]{32,64}$/);
      const info = id ? groups.get(id) : undefined;
      if (!id || !info || !groups.isMemberOf(c.user.id, id)) return fail(404, "not_found");
      return h(c, { id, info, isOwner: groups.ownerOf(id) === c.user.id });
    });
  const owner = (h: GroupHandler): Handler => member((c, g) => (g.isOwner ? h(c, g) : fail(403, "not_owner")));
  // Telegram groups are joined by saying /moro in the chat, so they have no invites.
  const webOwner = (h: GroupHandler): Handler => member((c, g) => (g.info.kind !== "web" ? fail(409, "telegram_group") : g.isOwner ? h(c, g) : fail(403, "not_owner")));
  const view = (c: Ctx, g: Group) => json(views.groupView(c.user, g.id));

  return {
    "/api/groups": {
      GET: user((c) => json({ groups: groups.listFor(c.user.id).map((g) => views.summary(g, c.user, g.hideOnScreen)) })),

      POST: user(async (c) => {
        const name = cleanGroupName((await c.body())?.name);
        if (!name) return fail(422, "invalid_name");
        const made = groups.createWeb(c.user.id, name);
        if (made === "limit") return fail(409, "too_many_groups");
        return json(views.summary(made, c.user, false), 201);
      }),
    },

    // ---------- Jams: the evening's join link of a web group ----------

    // What the link shows before joining. Anyone with the link: it is the invitation.
    "/api/jam/preview": {
      POST: userOrVisitor(true)(async (c) => {
        const code = jamCode(await c.body());
        const p = code ? pikakutsu(services, code) : null;
        if (!p) return fail(404, "invalid_jam");
        const member = c.hasUser && groups.isMemberOf(c.user.id, p.groupId);
        return json({ ...p.public, member, groupId: member ? p.groupId : null } satisfies JamPreview);
      }),
    },

    "/api/jam/join": {
      POST: user(async (c) => {
        const code = jamCode(await c.body());
        if (!code) return fail(400, "bad_request");
        return joined(groups.joinJam(code, c.user.id));
      }),
    },

    "/api/groups/join": {
      POST: user(async (c) => {
        const data = await c.body();
        if (!data || typeof data.code !== "string" || data.code.length > 100) return fail(400, "bad_request");
        const r = groups.redeemInvite(data.code, c.user.id);
        if (r.ok) return json({ id: r.groupId });
        if (r.reason === "invalid") return fail(404, "invalid_invite");
        return fail(409, r.reason === "full" ? "group_full" : "already_member");
      }),
    },

    "/api/groups/:group": {
      // A Telegram group's admins are asked first (cached), so the page knows whether to offer stopping any screen link.
      GET: member(async (c, g) => {
        if (g.info.kind === "telegram") await groupAdmins.isAdmin(g.id, c.user.id);
        return view(c, g);
      }),

      PATCH: owner(async (c, g) => {
        const name = (await c.body())?.name;
        if (!cleanGroupName(name)) return fail(422, "invalid_name");
        groups.rename(g.id, name as string);
        return view(c, g);
      }),

      DELETE: owner((_c, g) => (groups.deleteWeb(g.id) ? json({ ok: true }) : fail(409, "telegram_group"))),
    },

    "/api/groups/:group/me": {
      PATCH: member(async (c, g) => {
        const data = await c.body();
        if (typeof data?.hideOnScreen !== "boolean") return fail(400, "bad_request");
        groups.setHidden(c.user.id, g.id, data.hideOnScreen);
        return view(c, g);
      }),
    },

    "/api/groups/:group/leave": {
      POST: member((c, g) => {
        groups.leaveGroup(c.user.id, g.id);
        return json({ ok: true });
      }),
    },

    "/api/groups/:group/members/:member": {
      DELETE: owner((c, g) => {
        const ref = c.param("member", /^[0-9a-f]{1,64}$/);
        const target = groups.members(g.id).find((m) => memberRef(services, g.id, m.userId) === ref);
        if (!target) return fail(404, "not_found");
        if (target.userId === c.user.id) return fail(400, "use_leave");
        groups.leaveGroup(target.userId, g.id);
        return json({ ok: true });
      }),
    },

    "/api/groups/:group/jam": {
      // Any member starts it; while one is going, starting again gives the same link.
      POST: member(async (c, g) => {
        if (g.info.kind !== "web") return fail(409, "telegram_group");
        const hours = (await c.body())?.hours;
        if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0) return fail(400, "bad_request");
        groups.startJam(g.id, c.user.id, hours * HOUR_MS);
        services.bus.emit({ groupId: g.id });
        return view(c, g);
      }),
      DELETE: member((c, g) => {
        const jam = groups.jam(g.id);
        if (!jam) return fail(404, "not_found");
        if (!g.isOwner && jam.startedBy !== c.user.id) return fail(403, "not_owner");
        groups.endJam(g.id);
        services.bus.emit({ groupId: g.id });
        return view(c, g);
      }),
    },

    "/api/groups/:group/invite": {
      POST: webOwner((c, g) => json(groups.createInvite(g.id, c.user.id))),

      DELETE: webOwner((_c, g) => {
        groups.revokeInvite(g.id);
        return json({ ok: true });
      }),
    },

    "/api/groups/:group/screens": {
      POST: member(async (c, g) => {
        const made = screens.create({ groupId: g.id }, c.user.id, lifetime((await c.body())?.hours));
        return made === "limit" ? fail(409, "too_many_screens") : json(made, 201);
      }),
    },

    // Any member may stop a screen they made; a web group's owner or a Telegram group's admin may stop any.
    "/api/groups/:group/screens/:ref": {
      DELETE: member(async (c, g) => {
        const ref = c.param("ref", /^[0-9a-f]{1,64}$/);
        const link = screens.list({ groupId: g.id }).find((l) => l.ref === ref);
        if (!ref || !link) return fail(404, "not_found");
        const allowed = g.isOwner || link.createdBy === c.user.id || (g.info.kind === "telegram" && (await groupAdmins.isAdmin(g.id, c.user.id)));
        if (!allowed) return fail(403, "not_owner");
        screens.revoke({ groupId: g.id }, ref);
        return json({ ok: true });
      }),
    },

    "/api/groups/:group/events": {
      GET: member((c, g) => live.stream(c, `g:${g.id}:${c.user.id}`, c.user.id)),
    },
  };
}

const JAM_CODE = /^[A-Za-z0-9_-]{16,64}$/;
export const isJamCode = (code: unknown): code is string => typeof code === "string" && JAM_CODE.test(code);

/** A jam link's code from a request body, or null. */
function jamCode(data: Record<string, unknown> | null): string | null {
  return isJamCode(data?.code) ? data.code : null;
}

/**
 * What a pikakutsu link shows anyone who has it: its /liity page, and its link preview (og.ts).
 * Null when the code is unknown or the jam is over.
 */
export function pikakutsu(services: Services, code: string): { groupId: string; public: Omit<JamPreview, "member" | "groupId"> } | null {
  const jam = services.groups.jamByCode(code);
  const info = jam ? services.groups.get(jam.groupId) : null;
  if (!jam || !info) return null;
  const starter = services.groups.members(jam.groupId).find((m) => m.userId === jam.startedBy);
  return {
    groupId: jam.groupId,
    public: {
      groupName: info.name ?? "Ryhmä",
      // Someone who appears anonymously on screens isn't named to people outside the group either.
      startedBy: starter && !starter.hideOnScreen ? chartLabel(starter) : "Ryhmän jäsen",
      memberCount: info.memberCount,
      expiresAt: jam.expiresAt,
    },
  };
}

/** The answer to joining a group. */
function joined(r: ReturnType<Services["groups"]["joinJam"]>): Response {
  if (r.ok) return json({ id: r.groupId });
  if (r.reason === "invalid") return fail(404, "invalid_jam");
  return fail(409, r.reason === "full" ? "group_full" : "already_member");
}
