<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { api, errorText } from "#lib/api.ts";
  import { session } from "#lib/session.svelte.ts";

  let error = $state("");
  let working = $state(false);
  let botUsername = $state("");
  let botId = $state(0);

  async function done() {
    session.me = await api.me();
    // An invite link opened while signed out is waiting in sessionStorage (see /join).
    let pendingInvite = false;
    try {
      pendingInvite = !!sessionStorage.getItem("kili-invite");
    } catch {}
    goto(pendingInvite ? "/join" : "/", { replaceState: true });
  }

  async function withLink(token: string) {
    working = true;
    error = "";
    try {
      await api.signInWithLink(token);
      await done();
    } catch (e) {
      error = errorText(e);
      working = false;
    }
  }

  async function withTelegram(user: unknown) {
    working = true;
    error = "";
    try {
      await api.signInWithTelegram(user);
      await done();
    } catch (e) {
      error = errorText(e);
      working = false;
    }
  }

  // Telegram sign-in is a redirect, not Telegram's widget script (it needs eval(), which our CSP
  // forbids): oauth.telegram.org asks the user to confirm, then sends them back to
  // /login#tgAuthResult=<base64url JSON>, the same signed fields the widget would give.
  function signInWithTelegram() {
    const q = new URLSearchParams({
      bot_id: String(botId),
      origin: location.origin,
      request_access: "write",
      return_to: `${location.origin}/login`,
    });
    location.href = `https://oauth.telegram.org/auth?${q}`;
  }

  function decodeTelegramResult(data: string): unknown {
    const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64 + "===".slice((b64.length + 3) % 4)), (c) => c.charCodeAt(0)));
    const user = JSON.parse(json);
    if (!user || typeof user !== "object") throw new Error("cancelled");
    return user;
  }

  // /web in the bot gives /login#t=TOKEN, and Telegram's sign-in comes back as
  // /login#tgAuthResult=…. Both are in the fragment so they never reach a server log; remove
  // them from the address bar and history right away.
  function takeFragment(): { token?: string; telegram?: string } {
    const params = new URLSearchParams(location.hash.slice(1));
    const token = params.get("t") ?? undefined;
    const telegram = params.get("tgAuthResult") ?? undefined;
    if (token || telegram !== undefined) history.replaceState(null, "", location.pathname);
    return { token, telegram };
  }

  function handleFragment(): boolean {
    const { token, telegram } = takeFragment();
    if (token) {
      withLink(token);
      return true;
    }
    if (telegram !== undefined) {
      let user: unknown;
      try {
        user = decodeTelegramResult(telegram);
      } catch {
        error = "Telegram-kirjautuminen keskeytyi. Yritä uudelleen.";
        return false;
      }
      withTelegram(user);
      return true;
    }
    return false;
  }

  // A link opened in a tab already showing this page only changes the fragment: the browser
  // doesn't load the page again, so the token arrives here instead of in onMount.
  function onHashChange() {
    if (!working) handleFragment();
  }

  // Signed in in another tab (or with the link in a new tab): move on when this one is looked at.
  async function onVisible() {
    if (document.visibilityState !== "visible" || working || session.me) return;
    try {
      session.me = await api.me();
    } catch {
      return; // still signed out
    }
    await done();
  }

  onMount(async () => {
    if (session.me) return goto("/", { replaceState: true });
    // (a signed-in visitor never sees this page)

    if (handleFragment()) return;

    // The Telegram button needs the bot's id, and the site's domain registered with BotFather
    // (/setdomain), or Telegram's page says "Bot domain invalid".
    try {
      const config = await api.config();
      botUsername = config.botUsername;
      botId = config.botId;
    } catch (e) {
      error = errorText(e);
    }
  });
</script>

<svelte:head><title>Kirjaudu · Bläkkiskili</title></svelte:head>
<svelte:window onhashchange={onHashChange} />
<svelte:document onvisibilitychange={onVisible} />

<main class="page">
  <div class="box">
    <img class="logo" src="/kili-256.jpg" alt="" width="128" height="128" />
    <h1>Bläkkiskili</h1>
    <p class="lead">Promillearviot, illan juomat ja ryhmän kuvaaja selaimessa.</p>

    <section class="card panel">
      {#if working}
        <p>Kirjaudutaan…</p>
      {:else}
        <h2>Kirjaudu Telegramilla</h2>
        <p class="muted">
          Tunnus luodaan Telegramissa botin kanssa: sivusto käyttää samoja tietoja.
          {#if botUsername}
            <a href="https://t.me/{botUsername}" target="_blank" rel="noopener">Avaa botti Telegramissa (@{botUsername})</a>
          {/if}
        </p>
        <div class="widget">
          <button class="btn primary" disabled={!botId} onclick={signInWithTelegram}>Kirjaudu Telegramilla</button>
        </div>
        <p class="muted hint">
          Jos Telegram-kirjautuminen ei toimi, lähetä botille <code>/web</code>, niin saat kertakäyttöisen kirjautumislinkin.
        </p>
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </section>
  </div>
</main>

<style>
  .box {
    max-width: 28rem;
    margin: 0 auto;
    padding-top: 2.5rem;
    text-align: center;
  }
  .logo {
    display: block;
    width: 128px;
    height: 128px;
    margin: 0 auto 1rem;
    border-radius: 12px;
  }
  h1 {
    font-size: 2.25rem;
    color: var(--wordmark);
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  .lead {
    color: var(--text-secondary);
    font-size: 1.07rem;
    margin: 0.4rem 0 1.5rem;
  }
  .card {
    text-align: left;
  }
  .widget {
    margin: 1rem 0;
  }
  .hint {
    font-size: 0.93rem;
    margin-bottom: 0;
  }
</style>
