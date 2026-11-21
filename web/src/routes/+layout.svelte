<script lang="ts">
  import "#lib/polyfills.ts";
  import "../app.css";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import { api, ApiError } from "#lib/api.ts";
  import Icon, { type IconName } from "#lib/Icon.svelte";
  import { rememberReturn, session, takeReturn } from "#lib/session.svelte.ts";
  import { me as localMe } from "#lib/local/core.ts";
  import { loadLocal } from "#lib/local/store.ts";

  let { children } = $props();

  // Signing in and signing up happen signed out.
  const onLogin = $derived(["/login", "/signup", "/jam"].includes(page.url.pathname));
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
  const navButton = "btn gap-1.75 px-2.5 [&_svg]:size-[1.3rem]";
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
      // Not signed in on the server (or it can't be reached): a local account on this device is
      // used as it is. It works offline too, except for the catalogue search.
      const local = await loadLocal();
      if (local) {
        session.local = true;
        session.me = localMe(local);
      } else {
        // Only a 401 means signed out. A 5xx or 429 (the bot restarting, Cloudflare's 502) must not
        // send a signed-in person to the sign-in page as if they had been logged out.
        session.offline = !(e instanceof ApiError && e.status === 401);
      }
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
    if (session.local) return;
    await api.logout().catch(() => {});
    session.me = null;
    await goto("/login");
    takeReturn(); // the redirect above kept the page logged out from; the next sign-in starts at home
  }
</script>

<svelte:head><title>Bläkkiskili</title></svelte:head>

{#snippet brand(href: string, label: string, crowded: boolean)}
  <a class="mr-auto flex shrink-0 items-center gap-3 no-underline" {href} aria-label={label}>
    <img class="block size-[40px] rounded-md" src="/kili-head-96.jpg" alt="" width="40" height="40" />
    <!-- the wordmark only where it still fits beside the buttons (one more of them for admins) -->
    <span class={["text-[1.75rem] leading-none tracking-tight text-wordmark max-[40rem]:text-[1.45rem] max-[25rem]:hidden", crowded && "max-[28rem]:hidden"]}>Bläkkiskili</span>
  </a>
{/snippet}

{#if session.me && !onScreen}
  <header class="flex items-center gap-3 border-b border-line bg-surface-1 px-4 py-2">
    {@render brand("/", "Bläkkiskili, etusivu", links.length > nav.length)}
    <!-- phones: icons only -->
    <nav class="flex items-center gap-2 max-[40rem]:gap-1.5" aria-label="Päävalikko">
      {#each links as item (item.href)}
        <a class={navButton} href={item.href} aria-current={current(item.href) ? "page" : undefined} aria-label={item.label}>
          <span class="max-[40rem]:hidden">{item.label}</span><Icon name={item.icon} />
        </a>
      {/each}
      <!-- A local account has nothing to sign out of (Settings can delete it or move it online). -->
      {#if !session.local}
        <button class={navButton} onclick={logout} aria-label="Kirjaudu ulos" title="Kirjaudu ulos">
          <Icon name="logout" />
        </button>
      {/if}
    </nav>
  </header>
{/if}

{#if session.ready && !session.me && onDocs}
  <!-- Signed out on a public text: the way back to the sign-in. -->
  <header class="flex items-center gap-3 border-b border-line bg-surface-1 px-4 py-2">
    {@render brand("/login", "Bläkkiskili, kirjautuminen", false)}
    <nav class="flex items-center gap-2 max-[40rem]:gap-1.5" aria-label="Päävalikko">
      <a class={navButton} href="/login"><span class="max-[40rem]:hidden">Kirjaudu</span><Icon name="login" /></a>
    </nav>
  </header>
{/if}

{#if session.notice}
  <div class="notice mx-auto mt-4 w-[calc(100%-2rem)] max-w-[74rem]" role="status">
    <span>{session.notice}</span>
    <button class="btn btn-ghost btn-sm ml-auto" onclick={() => (session.notice = "")} aria-label="Sulje"><Icon name="x" /></button>
  </div>
{/if}

{#if !session.ready}
  <p class="page text-secondary">Ladataan…</p>
{:else if session.offline && !session.me && !onLogin && !onScreen && !onDocs}
  <p class="page text-danger">Yhteys palvelimeen ei toimi. Päivitä sivu hetken päästä.</p>
{:else}
  {@render children()}
{/if}

{#if !onScreen && session.ready}
  <footer class="mx-auto flex w-[calc(100%-2rem)] max-w-[74rem] flex-wrap justify-between gap-x-6 gap-y-1 border-t border-line-soft pt-5 pb-6 text-xs text-muted [&_a]:text-inherit">
    <span>Promillet ovat laskennallisia arvioita, eivät mittaustulos.</span>
    <span class="flex flex-wrap gap-x-6 gap-y-1">
      <a href="/help">Ohje</a>
      <a href="/terms">Käyttöehdot</a>
      <a href="/privacy">Yksityisyys</a>
      <span>Tuotetiedot: <a href="https://alkometriikka.fi" rel="noopener">Alkometriikka</a></span>
    </span>
  </footer>
{/if}
