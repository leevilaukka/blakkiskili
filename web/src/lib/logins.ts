// The browser's side of signing in: Telegram's and the OAuth providers' redirects, and passkeys.
// The server decides which methods exist (Config.loginProviders); see src/web/api/logins.ts.

import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import type { LoginPlatform } from "../../../shared/api.ts";
import { api, ApiError } from "./api.ts";

export const LOGIN_NAMES: Record<LoginPlatform, string> = {
  telegram: "Telegram",
  discord: "Discord",
  google: "Google",
  microsoft: "Microsoft",
  passkey: "Pääsyavain",
};

/**
 * Telegram sign-in is a redirect, not Telegram's widget script (it needs eval(), which our CSP
 * forbids): oauth.telegram.org asks the person to confirm, then sends them back to
 * `<returnPath>#tgAuthResult=<base64url JSON>`, the same signed fields the widget would give.
 */
export function goToTelegram(botId: number, returnPath: string) {
  const q = new URLSearchParams({
    bot_id: String(botId),
    origin: location.origin,
    request_access: "write",
    return_to: `${location.origin}${returnPath}`,
  });
  location.href = `https://oauth.telegram.org/auth?${q}`;
}

export function decodeTelegramResult(data: string): unknown {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const json = new TextDecoder().decode(Uint8Array.from(atob(b64 + "===".slice((b64.length + 3) % 4)), (c) => c.charCodeAt(0)));
  const user = JSON.parse(json);
  if (!user || typeof user !== "object") throw new Error("cancelled");
  return user;
}

/** Google or Microsoft: the server gives the provider's address, and the browser goes there. */
export async function goToProvider(platform: "google" | "microsoft", link: boolean) {
  const { url } = await api.oauthStart(platform, link);
  location.href = url;
}

export const passkeysSupported = () => typeof window !== "undefined" && browserSupportsWebAuthn();

/**
 * The person closed the browser's passkey dialog (or it timed out): not an error worth a message.
 * Anything else from the browser becomes an ApiError for errorText.
 */
async function browserStep<T>(step: () => Promise<T>): Promise<T | null> {
  if (!passkeysSupported()) throw new ApiError(0, "passkey_unsupported");
  try {
    return await step();
  } catch (e) {
    if (e instanceof WebAuthnError && e.code === "ERROR_CEREMONY_ABORTED") return null;
    if (e instanceof Error && e.name === "NotAllowedError") return null;
    if (e instanceof WebAuthnError && e.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") throw new ApiError(0, "passkey_exists");
    throw new ApiError(0, "passkey_failed");
  }
}

/** Signs in with a passkey; false if the person cancelled. */
export async function signInWithPasskey(): Promise<boolean> {
  const options = (await api.passkeyLoginOptions()) as unknown as PublicKeyCredentialRequestOptionsJSON;
  const response = await browserStep(() => startAuthentication({ optionsJSON: options }));
  if (!response) return false;
  await api.passkeyLogin(response);
  return true;
}

/** Makes the first passkey of a new account; its answer goes with the sign-up form. Null if cancelled. */
export async function createSignupPasskey(name: string): Promise<unknown | null> {
  const options = (await api.passkeySignupOptions(name)) as unknown as PublicKeyCredentialCreationOptionsJSON;
  return browserStep(() => startRegistration({ optionsJSON: options }));
}

/** Adds a passkey to the signed-in account; false if the person cancelled. */
export async function addPasskey(): Promise<boolean> {
  const options = (await api.passkeyAddOptions()) as unknown as PublicKeyCredentialCreationOptionsJSON;
  const response = await browserStep(() => startRegistration({ optionsJSON: options }));
  if (!response) return false;
  await api.passkeyAdd(response);
  return true;
}
