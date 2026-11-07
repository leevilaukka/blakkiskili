<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { api, errorText } from "#lib/api.ts";
  import { session } from "#lib/session.svelte.ts";

  let error = $state("");
  let working = $state(false);
  let widget: HTMLDivElement | undefined = $state();

  async function done() {
    session.me = await api.me();
    goto("/", { replaceState: true });
  }

  async function withLink(token: string) {
    working = true;
    try {
      await api.signInWithLink(token);
      await done();
    } catch (e) {
      error = errorText(e);
      working = false;
    }
  }

  onMount(async () => {
    if (session.me) return goto("/", { replaceState: true });

    // /web in the bot gives /login#t=TOKEN. The token is in the fragment so it never reaches
    // a server log; remove it from the address bar and history right away.
    const token = new URLSearchParams(location.hash.slice(1)).get("t");
    if (token) {
      history.replaceState(null, "", location.pathname);
      return withLink(token);
    }

    // Telegram's login button (needs the site's domain registered with BotFather: /setdomain).
    try {
      const config = await api.config();
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

<main class="page narrow">
  <h1>Bläkkiskili</h1>
  <p class="muted">Kirjaudu Telegram-tunnuksellasi. Tunnus luodaan Telegramissa botin kanssa: sivusto käyttää samoja tietoja.</p>

  {#if working}
    <p>Kirjaudutaan…</p>
  {:else}
    <div class="widget" bind:this={widget}></div>
    <p class="muted hint">
      Jos Telegram-painiketta ei näy tai se ei toimi, lähetä botille <code>/web</code>, niin saat kertakäyttöisen kirjautumislinkin.
    </p>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</main>

<style>
  .narrow {
    max-width: 28rem;
    padding-top: 3rem;
  }
  .widget {
    margin: 1.5rem 0;
    min-height: 40px;
  }
  .hint {
    font-size: 0.9rem;
  }
</style>
