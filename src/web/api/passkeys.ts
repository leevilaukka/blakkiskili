// Passkeys (WebAuthn): signing in without a password or a third party. Only when PASSKEYS is on;
// otherwise these routes don't exist.
//
//   POST /api/auth/passkey/login/options   → options for navigator.credentials.get()
//   POST /api/auth/passkey/login           ← its answer → a session
//   POST /api/auth/passkey/signup/options  ← { name } → options for creating the first passkey;
//                                            the answer goes with the sign-up form (logins.ts)
//   POST /api/auth/passkey/add/options     → options for one more passkey on the signed-in account
//   POST /api/auth/passkey/add             ← its answer
//   DELETE /api/auth/passkeys/:id          removes one (never the last way to sign in)
//
// The challenge waits on the server (authflows.ts) under a random key in an HttpOnly cookie, and
// is used once. Sign-in uses discoverable passkeys (the browser offers the site's passkeys, no
// username), finds the passkey by its credential id and checks the signature, the origin, the
// site's host name and that the person unlocked the device (user verification).

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { NewProfile } from "../../services/accounts.ts";
import { Passkeys, PASSKEYS_PER_ACCOUNT } from "../../services/passkeys.ts";
import { fail, json } from "../http.ts";
import type { Api, Ctx, Routes } from "./context.ts";
import { limitByIp, user } from "./guards.ts";

/** A passkey's answer is larger than other bodies (a public key, and attestation if the device insists). */
export const PASSKEY_BODY_MAX = 16 * 1024;

const RP_NAME = "Bläkkiskili";

const isResponse = (r: unknown): r is { id: string; response: object } =>
  !!r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string" && (r as { id: string }).id.length <= 1024 && typeof (r as { response?: unknown }).response === "object";

/** Checks a new passkey against the challenge; the passkey to store, or null. */
async function verifyNew(api: Api, response: unknown, challenge: string) {
  if (!isResponse(response)) return null;
  try {
    const r = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: api.opts.origin,
      expectedRPID: api.auth.rpId,
      requireUserVerification: true,
    });
    if (!r.verified) return null;
    const { credential } = r.registrationInfo;
    return { id: credential.id, publicKey: credential.publicKey, counter: credential.counter, transports: credential.transports };
  } catch {
    return null;
  }
}

/** A new account with its first passkey (POST /api/auth/signup with `passkey`, see logins.ts). */
export async function finishPasskeySignup(
  api: Api,
  c: Ctx,
  response: unknown,
  profile: NewProfile,
): Promise<{ ok: true; accountId: string; identityId: string } | { ok: false; status: number; error: string }> {
  const { services, auth, cookies } = api;
  const flow = auth.flows.passkey.take(c.req.cookies.get(cookies.passkey));
  if (flow?.kind !== "signup") return { ok: false, status: 401, error: "passkey_expired" };
  const passkey = await verifyNew(api, response, flow.challenge);
  if (!passkey) return { ok: false, status: 400, error: "passkey_failed" };
  if (services.passkeys.get(passkey.id)) return { ok: false, status: 409, error: "passkey_exists" };
  const ref = { platform: "passkey" as const, platformUserId: flow.handle };
  const identityId = services.identities.key(ref);
  const accountId = services.deps.db.transaction(() => {
    const { profile: p } = services.accounts.register(ref, profile);
    services.passkeys.insert(identityId, passkey);
    return p.id;
  })();
  return { ok: true, accountId, identityId };
}

export function passkeyRoutes(api: Api): Routes {
  const { services, auth, cookies, now, opts } = api;
  if (!auth.providers.includes("passkey")) return {};
  const flows = auth.flows.passkey;
  const signInLimit = limitByIp("signIn");
  const signUpLimit = limitByIp("signUp");

  const withChallenge = (options: object, key: string) =>
    json(options, 200, { "set-cookie": cookies.set(cookies.passkey, key, now() + flows.ttlMs) });

  return {
    "/api/auth/passkey/login/options": {
      POST: signInLimit(async () => {
        const options = await generateAuthenticationOptions({ rpID: auth.rpId, userVerification: "required" });
        return withChallenge(options, flows.put({ kind: "login", challenge: options.challenge }));
      }),
    },

    "/api/auth/passkey/login": {
      POST: signInLimit(async (c) => {
        const data = await c.body(PASSKEY_BODY_MAX);
        const flow = flows.take(c.req.cookies.get(cookies.passkey));
        if (flow?.kind !== "login") return fail(401, "passkey_expired");
        const response = data?.response;
        if (!isResponse(response)) return fail(400, "bad_request");
        const passkey = services.passkeys.get(response.id);
        if (!passkey) return fail(401, "unknown_passkey");
        let newCounter: number;
        try {
          const r = await verifyAuthenticationResponse({
            response: response as AuthenticationResponseJSON,
            expectedChallenge: flow.challenge,
            expectedOrigin: opts.origin,
            expectedRPID: auth.rpId,
            credential: {
              id: passkey.id,
              publicKey: passkey.publicKey as Uint8Array<ArrayBuffer>,
              counter: passkey.counter,
              transports: passkey.transports as never,
            },
            requireUserVerification: true,
          });
          if (!r.verified) return fail(401, "passkey_failed");
          newCounter = r.authenticationInfo.newCounter;
        } catch {
          return fail(401, "passkey_failed");
        }
        services.passkeys.used(passkey.id, newCounter);
        const { sessionToken, expiresAt } = services.webSessions.createSession(passkey.accountId, passkey.identityId);
        return json({ ok: true }, 200, { "set-cookie": cookies.set(cookies.session, sessionToken, expiresAt) });
      }),
    },

    "/api/auth/passkey/signup/options": {
      POST: signUpLimit(async (c) => {
        const data = await c.body();
        const name = typeof data?.name === "string" ? data.name.trim().slice(0, 64) : "";
        const handle = Passkeys.newHandle();
        const options = await generateRegistrationOptions({
          rpName: RP_NAME,
          rpID: auth.rpId,
          userName: name || RP_NAME,
          userID: new TextEncoder().encode(handle),
          attestationType: "none",
          authenticatorSelection: { residentKey: "required", userVerification: "required" },
        });
        return withChallenge(options, flows.put({ kind: "signup", challenge: options.challenge, handle }));
      }),
    },

    "/api/auth/passkey/add/options": {
      POST: user(async (c) => {
        const existing = services.passkeys.list(c.user.id);
        if (existing.length >= PASSKEYS_PER_ACCOUNT) return fail(409, "too_many_passkeys");
        const options = await generateRegistrationOptions({
          rpName: RP_NAME,
          rpID: auth.rpId,
          userName: c.user.name,
          // The handle only keeps an account's passkeys apart on a device; sign-in goes by credential id.
          userID: new TextEncoder().encode(Passkeys.newHandle()),
          attestationType: "none",
          // Not a second passkey on a device that has one for this account already.
          excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports as never })),
          authenticatorSelection: { residentKey: "required", userVerification: "required" },
        });
        return withChallenge(options, flows.put({ kind: "add", challenge: options.challenge, accountId: c.user.id }));
      }),
    },

    "/api/auth/passkey/add": {
      POST: user(async (c) => {
        const data = await c.body(PASSKEY_BODY_MAX);
        const flow = flows.take(c.req.cookies.get(cookies.passkey));
        if (flow?.kind !== "add" || flow.accountId !== c.user.id) return fail(401, "passkey_expired");
        const passkey = await verifyNew(api, data?.response, flow.challenge);
        if (!passkey) return fail(400, "passkey_failed");
        if (services.passkeys.get(passkey.id)) return fail(409, "passkey_exists");
        if (!services.passkeys.add(c.user.id, passkey)) return fail(409, "too_many_passkeys");
        return json({ ok: true });
      }),
    },

    "/api/auth/passkeys/:id": {
      DELETE: user((c) => {
        const id = c.param("id", /^[A-Za-z0-9_-]{1,1024}$/);
        if (!id) return fail(404, "not_found");
        const passkey = services.passkeys.get(id);
        if (!passkey || passkey.accountId !== c.user.id) return fail(404, "not_found");
        const all = services.passkeys.list(c.user.id);
        if (all.length === 1) {
          // The last passkey takes the passkey login with it: the same rules as removing a login.
          if (passkey.identityId === c.session.identityId) return fail(409, "current_login");
          const others = services.identities.list(c.user.id).filter((i) => i.id !== passkey.identityId);
          if (!others.some((i) => auth.providers.includes(i.platform as never))) return fail(409, "last_login");
        }
        const r = services.passkeys.remove(c.user.id, id);
        if (r === "last") return fail(409, "last_login");
        if (r === "not_found") return fail(404, "not_found");
        return json({ ok: true });
      }),
    },
  };
}
