<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { api, errorText } from "#lib/api.ts";
  import { session } from "#lib/session.svelte.ts";

  let error = $state("");
  let working = $state(false);
  let botUsername = $state("");
  let widget: HTMLDivElement | undefined = $state();

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

  // /web in the bot gives /login#t=TOKEN. The token is in the fragment so it never reaches
  // a server log; remove it from the address bar and history right away.
  function takeToken(): string | null {
    const token = new URLSearchParams(location.hash.slice(1)).get("t");
    if (token) history.replaceState(null, "", location.pathname);
    return token;
  }

  // A link opened in a tab already showing this page only changes the fragment: the browser
  // doesn't load the page again, so the token arrives here instead of in onMount.
  function onHashChange() {
    const token = takeToken();
    if (token && !working) withLink(token);
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

    const token = takeToken();
    if (token) return withLink(token);

    // Telegram's login button (needs the site's domain registered with BotFather: /setdomain).
    try {
      const config = await api.config();
      botUsername = config.botUsername;
      (window as any).onTelegramAuth = async (user: unknown) => {
        working = true;
        try {
          await api.signInWithTelegram(user);
          await done();
        } catch (e) {
          error = errorText(e);
          working = false;
        }
      };
      const script = document.createElement("script");
      script.async = true;
      script.src = "https://telegram.org/js/telegram-widget.js?22";
      script.dataset.telegramLogin = config.botUsername;
      script.dataset.size = "large";
      script.dataset.onauth = "onTelegramAuth(user)";
      script.dataset.requestAccess = "write";
      widget?.appendChild(script);
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
        <div class="widget" bind:this={widget}></div>
        <p class="muted hint">
          Jos Telegram-painiketta ei näy tai se ei toimi, lähetä botille <code>/web</code>, niin saat kertakäyttöisen kirjautumislinkin.
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
    min-height: 40px;
  }
  .hint {
    font-size: 0.93rem;
    margin-bottom: 0;
  }
</style>
