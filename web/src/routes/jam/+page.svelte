<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import type { JamPreview } from "../../../../shared/api.ts";
  import { api, ApiError, errorText } from "#lib/api.ts";
  import { dayClock } from "#lib/format.ts";
  import Icon from "#lib/Icon.svelte";
  import { setMoving } from "#lib/local/migrate.ts";
  import { rememberReturn, session } from "#lib/session.svelte.ts";

  // A jam link is /jam#j=CODE (in the fragment, so never in a server log). The code waits in
  // sessionStorage while someone signs in first, and the sign-in page sends them back here.
  const KEY = "kili-jam";
  const keep = (code: string | null) => {
    try {
      if (code) sessionStorage.setItem(KEY, code);
      else sessionStorage.removeItem(KEY);
    } catch {}
  };
  const kept = () => {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  };

  let code = $state<string | null>(null);
  let preview = $state<JamPreview | null>(null);
  let error = $state("");
  let busy = $state(false);
  // Groups always need an account: signed in on the server, one button; otherwise sign in or sign
  // up first (a local account is moved online on the way) and come back here to join.
  const signedIn = $derived(!!session.me && !session.local);

  onMount(async () => {
    const fromLink = new URLSearchParams(location.hash.slice(1)).get("j");
    if (fromLink) {
      keep(fromLink);
      history.replaceState(null, "", location.pathname);
    }
    code = fromLink ?? kept();
    if (!code) return goto("/groups", { replaceState: true });
    try {
      preview = await api.jamPreview(code);
    } catch (e) {
      keep(null);
      error = errorText(e);
    }
  });

  async function joined(id: string) {
    keep(null);
    goto(`/groups/${id}`, { replaceState: true });
  }

  async function join() {
    if (!code) return;
    busy = true;
    error = "";
    try {
      await joined((await api.jamJoin(code)).id);
    } catch (e) {
      if (e instanceof ApiError && e.code === "already_member" && preview?.groupId) return joined(preview.groupId);
      error = errorText(e);
      busy = false;
    }
  }

  function signInFirst() {
    rememberReturn("/jam");
    if (session.local) setMoving(true);
    goto("/login");
  }
</script>

<svelte:head><title>Jami · Bläkkiskili</title></svelte:head>

<main class="page">
  <div class="mx-auto max-w-[30rem] pt-6">
    {#if preview}
      <section class="card card-panel text-center">
        <span class="mx-auto mb-3 grid size-14 place-items-center rounded-full bg-brand-4 text-white [&_svg]:size-7" aria-hidden="true"><Icon name="users" /></span>
        <p class="m-0 text-secondary">{preview.startedBy} kutsuu sinut ryhmään</p>
        <h1 class="my-1.5 wrap-anywhere">{preview.groupName}</h1>
        <p class="m-0 text-secondary">{preview.memberCount} jäsentä · jami {dayClock(preview.expiresAt, Date.now())} asti</p>
        <p class="mt-3 mb-0 text-sm text-secondary">Ryhmässä näette toistenne promillearviot ja juotujen annosten määrät.</p>
      </section>

      {#if preview.member}
        <div class="mt-4 grid">
          <a class="btn btn-primary justify-center" href="/groups/{preview.groupId}">Olet jo ryhmässä: avaa se</a>
        </div>
      {:else if signedIn}
        <div class="mt-4 grid">
          <button class="btn btn-primary justify-center" disabled={busy} onclick={join}><Icon name="plus" /> Liity ryhmään</button>
        </div>
      {:else}
        <section class="card card-panel mt-4">
          <h2 class="mt-0">Liity tunnuksella</h2>
          <p class="text-secondary">
            {#if session.local}
              Ryhmät tarvitsevat tunnuksen. Kirjaudu tai luo tunnus, niin tämän laitteen juomat siirretään siihen ja pääset liittymään.
            {:else}
              Ryhmät tarvitsevat tunnuksen. Kirjaudu tai luo tunnus, niin palaat tähän liittymään.
            {/if}
          </p>
          <button class="btn btn-primary w-full justify-center" onclick={signInFirst}><Icon name="login" /> Kirjaudu tai luo tunnus</button>
        </section>
      {/if}
    {:else if !error}
      <p class="text-secondary">Ladataan…</p>
    {/if}
    {#if error}
      <p class="text-danger" role="alert">{error}</p>
      <a class="btn" href="/">Etusivulle</a>
    {/if}
  </div>
</main>
