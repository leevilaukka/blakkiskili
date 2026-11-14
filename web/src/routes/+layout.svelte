<script lang="ts">
  import "#lib/polyfills.ts";
  import "../app.css";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import { api, ApiError } from "#lib/api.ts";
  import Icon, { type IconName } from "#lib/Icon.svelte";
  import { rememberReturn, session, takeReturn } from "#lib/session.svelte.ts";

  let { children } = $props();

  const onLogin = $derived(page.url.pathname === "/login");
  // Event screens are opened by a link and need no account.
  const onScreen = $derived(page.url.pathname === "/screen");
  // The help, terms and privacy texts can be read before signing in.
  const onDocs = $derived(["/help", "/terms", "/privacy"].includes(page.url.pathname));

  // The logo is the way home, as on Alkometriikka; these are the header buttons after it.
  const nav: { href: string; label: string; icon: IconName }[] = [
    { href: "/log", label: "Juo", icon: "plus" },
    { href: "/logbook", label: "Päiväkirja", icon: "book" },
    { href: "/groups", label: "Ryhmät", icon: "users" },
    { href: "/settings", label: "Asetukset", icon: "settings" },
  ];
  // Only for admins (ADMIN_IDS); the API answers 404 to everyone else anyway.
  const links = $derived(session.me?.admin ? [...nav, { href: "/admin", label: "Ylläpito", icon: "shield" as IconName }] : nav);
  const current = (href: string) => page.url.pathname === href || page.url.pathname.startsWith(`${href}/`);

  onMount(async () => {
    if (onScreen) {
      session.ready = true;
      return;
    }
    try {
      session.me = await api.me();
    } catch (e) {
      session.me = null;
      // Only a 401 means signed out. A 5xx or 429 (the bot restarting, Cloudflare's 502) must not
      // send a signed-in person to the sign-in page as if they had been logged out.
      session.offline = !(e instanceof ApiError && e.status === 401);
    }
    session.ready = true;
  });

  // Signed out (first load, expired session or logout): the only page is the sign-in.
  $effect(() => {
    if (session.ready && !session.me && !onLogin && !onScreen && !onDocs && !session.offline) {
      rememberReturn(page.url.pathname);
      goto("/login", { replaceState: true });
    }
  });

  async function logout() {
    await api.logout().catch(() => {});
    session.me = null;
    await goto("/login");
    takeReturn(); // the redirect above kept the page logged out from; the next sign-in starts at home
  }
</script>

<svelte:head><title>Bläkkiskili</title></svelte:head>

{#if session.me && !onScreen}
  <header class="top" class:crowded={links.length > nav.length}>
    <a class="brand" href="/" aria-label="Bläkkiskili, etusivu">
      <img src="/kili-head-96.jpg" alt="" width="40" height="40" />
      <span class="word">Bläkkiskili</span>
    </a>
    <nav aria-label="Päävalikko">
      {#each links as item (item.href)}
        <a class="btn" href={item.href} aria-current={current(item.href) ? "page" : undefined} aria-label={item.label}>
          <span class="label">{item.label}</span><Icon name={item.icon} />
        </a>
      {/each}
      <button class="btn" onclick={logout} aria-label="Kirjaudu ulos" title="Kirjaudu ulos">
        <Icon name="logout" />
      </button>
    </nav>
  </header>
{/if}

{#if session.ready && !session.me && onDocs}
  <!-- Signed out on a public text: the way back to the sign-in. -->
  <header class="top">
    <a class="brand" href="/login" aria-label="Bläkkiskili, kirjautuminen">
      <img src="/kili-head-96.jpg" alt="" width="40" height="40" />
      <span class="word">Bläkkiskili</span>
    </a>
    <nav aria-label="Päävalikko">
      <a class="btn" href="/login"><span class="label">Kirjaudu</span><Icon name="login" /></a>
    </nav>
  </header>
{/if}

{#if !session.ready}
  <p class="page muted">Ladataan…</p>
{:else if session.offline && !session.me && !onLogin && !onScreen && !onDocs}
  <p class="page error">Yhteys palvelimeen ei toimi. Päivitä sivu hetken päästä.</p>
{:else}
  {@render children()}
{/if}

{#if !onScreen && session.ready}
  <footer class="foot">
    <span>Promillet ovat laskennallisia arvioita, eivät mittaustulos.</span>
    <span class="links">
      <a href="/help">Ohje</a>
      <a href="/terms">Käyttöehdot</a>
      <a href="/privacy">Yksityisyys</a>
      <span>Tuotetiedot: <a href="https://alkometriikka.fi" rel="noopener">Alkometriikka</a></span>
    </span>
  </footer>
{/if}

<style>
  .top {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-shrink: 0;
    text-decoration: none;
    margin-right: auto;
  }
  .brand img {
    display: block;
    width: 40px;
    height: 40px;
    border-radius: 6px;
  }
  .word {
    color: var(--wordmark);
    font-size: 1.75rem;
    line-height: 1;
    letter-spacing: -0.01em;
  }
  nav {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  nav .btn {
    gap: 0.45rem;
    padding-inline: 0.6rem;
  }
  nav .btn :global(.icon) {
    font-size: 1.3rem;
    width: 1.3rem;
    height: 1.3rem;
  }
  /* phones: icons only, and the wordmark only where it still fits beside them */
  @media (max-width: 40rem) {
    .label {
      display: none;
    }
    nav {
      gap: 0.4rem;
    }
    .word {
      font-size: 1.45rem;
    }
  }
  /* Where the wordmark no longer fits beside the buttons (one more of them for admins). */
  @media (max-width: 25rem) {
    .word {
      display: none;
    }
  }
  @media (max-width: 28rem) {
    .crowded .word {
      display: none;
    }
  }

  .foot {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.25rem 1.5rem;
    width: calc(100% - 2rem);
    max-width: 74rem;
    margin: 0 auto;
    padding: 1.25rem 0 1.5rem;
    border-top: 1px solid var(--border-soft);
    color: var(--text-muted);
    font-size: 0.86rem;
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1.5rem;
  }
  .foot a {
    color: inherit;
  }
</style>
