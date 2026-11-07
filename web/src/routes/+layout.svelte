<script lang="ts">
  import "../app.css";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import { api, ApiError } from "#lib/api.ts";
  import { session } from "#lib/session.svelte.ts";

  let { children } = $props();

  const onLogin = $derived(page.url.pathname === "/login");
  // Event screens are opened by a link and need no account.
  const onScreen = $derived(page.url.pathname === "/screen");

  onMount(async () => {
    if (onScreen) {
      session.ready = true;
      return;
    }
    try {
      session.me = await api.me();
    } catch (e) {
      session.me = null;
      session.offline = !(e instanceof ApiError);
    }
    session.ready = true;
  });

  // Signed out (first load, expired session or logout): the only page is the sign-in.
  $effect(() => {
    if (session.ready && !session.me && !onLogin && !onScreen && !session.offline) goto("/login", { replaceState: true });
  });

  async function logout() {
    await api.logout().catch(() => {});
    session.me = null;
    goto("/login");
  }
</script>

<svelte:head><title>Bläkkiskili</title></svelte:head>

{#if session.me && !onScreen}
  <header>
    <a class="brand" href="/">Bläkkiskili</a>
    <nav aria-label="Päävalikko">
      <a href="/" aria-current={page.url.pathname === "/" ? "page" : undefined}>Etusivu</a>
      <a href="/log" aria-current={page.url.pathname === "/log" ? "page" : undefined}>Juo</a>
      <a href="/groups" aria-current={page.url.pathname.startsWith("/groups") ? "page" : undefined}>Ryhmät</a>
      <a href="/settings" aria-current={page.url.pathname === "/settings" ? "page" : undefined}>Asetukset</a>
    </nav>
    <button class="link" onclick={logout}>Kirjaudu ulos</button>
  </header>
{/if}

{#if !session.ready}
  <p class="page muted">Ladataan…</p>
{:else if session.offline && !session.me && !onLogin && !onScreen}
  <p class="page error">Yhteys palvelimeen ei toimi. Päivitä sivu hetken päästä.</p>
{:else}
  {@render children()}
{/if}

<style>
  header {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .brand {
    font-weight: 700;
    color: var(--text-primary);
    text-decoration: none;
  }
  nav {
    display: flex;
    gap: 0.25rem;
    flex: 1;
  }
  nav a {
    padding: 0.5rem 0.7rem;
    border-radius: 8px;
    color: var(--text-secondary);
    text-decoration: none;
  }
  nav a[aria-current="page"] {
    background: var(--surface-2);
    color: var(--text-primary);
    font-weight: 600;
  }
  .link {
    background: none;
    border: 0;
    color: var(--text-secondary);
    padding: 0.5rem;
    text-decoration: underline;
  }
</style>
