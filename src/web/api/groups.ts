// Groups: listing, creating and joining them, and everything under /api/groups/<id>, which only
// members reach.

import { cleanGroupName, type GroupInfo } from "../../services/groups.ts";
import { fail, json } from "../http.ts";
import { memberRef } from "../boards.ts";
import type { Api, Ctx, Handler, Routes } from "./context.ts";
import { user } from "./guards.ts";
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
