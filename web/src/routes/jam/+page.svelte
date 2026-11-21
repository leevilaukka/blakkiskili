<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import type { Gender, JamPreview } from "../../../../shared/api.ts";
  import { api, ApiError, errorText } from "#lib/api.ts";
  import { dayClock } from "#lib/format.ts";
  import Icon from "#lib/Icon.svelte";
  import { moveToAccount } from "#lib/local/migrate.ts";
  import { loadLocal } from "#lib/local/store.ts";
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
  // Signed in on the server: one button. Otherwise (signed out or a local account): the guest form.
  const signedIn = $derived(!!session.me && !session.local);

  let name = $state("");
  let weight = $state("");
  let height = $state("");
  let gender = $state<Gender | "">("");
  let accept = $state(false);

  onMount(async () => {
    const fromLink = new URLSearchParams(location.hash.slice(1)).get("j");
    if (fromLink) {
      keep(fromLink);
      history.replaceState(null, "", location.pathname);
    }
    code = fromLink ?? kept();
    if (!code) return goto("/groups", { replaceState: true });
    // A local account joins with its own details, and its drinks come along.
    if (session.local) {
      const local = await loadLocal();
      if (local) {
        name = local.profile.name;
        weight = String(local.profile.weight);
        height = String(local.profile.height);
        gender = local.profile.gender;
      }
    }
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

  async function joinAsGuest(e: SubmitEvent) {
    e.preventDefault();
    if (!code || !gender) return;
    busy = true;
    error = "";
    try {
      const local = session.local ? await loadLocal() : null;
      const { id } = await api.jamGuest({ code, name: name.trim(), weight: Number(weight), height: Number(height), gender, acceptTerms: true });
      session.local = false;
      if (local) {
        const r = await moveToAccount(local).catch(() => null);
        if (r) session.notice = `Tämän laitteen tiedot siirrettiin tunnukseesi: ${r.inserted} juomaa.`;
      }
      session.me = await api.me();
      await joined(id);
    } catch (err) {
      error = errorText(err);
      busy = false;
    }
  }

  function signInFirst() {
    rememberReturn("/jam");
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
        <form class="card card-panel mt-4 grid gap-4" onsubmit={joinAsGuest}>
          <h2 class="m-0">Liity {session.local ? "" : "vieraana"}</h2>
          <p class="m-0 text-secondary">
            {#if session.local}
              Liityt tämän laitteen tiedoilla: juomasi siirretään tunnukseen, jonka voit myöhemmin yhdistää Googleen, Telegramiin tai pääsyavaimeen asetuksista.
            {:else}
              Ei kirjautumista: tunnus toimii tällä selaimella. Asetuksista voit myöhemmin lisätä kirjautumistavan, niin pääset siihen muualtakin.
            {/if}
          </p>
          <label class="grid gap-1.25">Nimimerkki
            <input type="text" bind:value={name} minlength="2" maxlength="32" autocomplete="nickname" required />
          </label>
          <div class="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-3">
            <label class="grid gap-1.25">Paino (kg)<input type="number" inputmode="numeric" bind:value={weight} min="20" max="250" required /></label>
            <label class="grid gap-1.25">Pituus (cm)<input type="number" inputmode="numeric" bind:value={height} min="120" max="240" required /></label>
            <label class="grid gap-1.25">Sukupuoli
              <select bind:value={gender} required>
                <option value="" disabled>Valitse</option>
                <option value="mies">Mies</option>
                <option value="nainen">Nainen</option>
              </select>
            </label>
          </div>
          <label class="flex items-start gap-2.5">
            <input class="mt-1" type="checkbox" bind:checked={accept} required />
            <span>Hyväksyn <a href="/terms" target="_blank">käyttöehdot</a> ja <a href="/privacy" target="_blank">tietosuojaselosteen</a>.</span>
          </label>
          <button class="btn btn-primary justify-center" type="submit" disabled={busy || !accept}><Icon name="plus" /> Liity ryhmään</button>
        </form>
        {#if !session.local}
          <p class="mt-4 text-center text-secondary">
            Onko sinulla jo tunnus? <button class="btn btn-ghost btn-sm" onclick={signInFirst}>Kirjaudu ja liity</button>
          </p>
        {/if}
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
