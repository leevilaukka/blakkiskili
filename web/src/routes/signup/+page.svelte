<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import type { Gender, LoginPlatform } from "../../../../shared/api.ts";
  import { api, ApiError, errorText } from "#lib/api.ts";
  import Icon from "#lib/Icon.svelte";
  import { createSignupPasskey, LOGIN_NAMES, passkeysSupported } from "#lib/logins.ts";
  import { session, takeReturn } from "#lib/session.svelte.ts";

  // Two ways here: back from Google or Microsoft with a login that has no account yet (the server
  // holds it for the form, see GET /api/auth/signup), or "Luo tunnus pääsyavaimella" (?passkey),
  // where the passkey is made when the form is sent.
  const withPasskey = page.url.searchParams.has("passkey");
  let method = $state<LoginPlatform | null>(null);
  let loading = $state(true);
  let missing = $state(false);

  let name = $state("");
  let weight = $state("");
  let height = $state("");
  let gender = $state<Gender | "">("");
  let accept = $state(false);
  let busy = $state(false);
  let error = $state("");

  onMount(async () => {
    if (session.me) return goto("/", { replaceState: true });
    try {
      if (withPasskey) {
        const config = await api.config();
        if (!config.loginProviders.includes("passkey") || !passkeysSupported()) missing = true;
        else method = "passkey";
      } else {
        method = (await api.signupInfo()).method;
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) missing = true;
      else error = errorText(e);
    }
    loading = false;
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!gender) return;
    busy = true;
    error = "";
    const profile = { name: name.trim(), weight: Number(weight), height: Number(height), gender, acceptTerms: true as const };
    try {
      if (method === "passkey") {
        const passkey = await createSignupPasskey(profile.name);
        if (!passkey) {
          busy = false; // closed the browser's dialog
          return;
        }
        await api.signup({ ...profile, passkey });
      } else {
        await api.signup(profile);
      }
      session.me = await api.me();
      let pendingInvite = false;
      try {
        pendingInvite = !!sessionStorage.getItem("kili-invite");
      } catch {}
      const back = takeReturn();
      goto(pendingInvite ? "/join" : (back ?? "/"), { replaceState: true });
    } catch (err) {
      error = errorText(err);
      busy = false;
      // The login this form was for is gone (expired or used): only signing in again helps.
      if (err instanceof ApiError && err.code === "no_signup") missing = true;
    }
  }
</script>

<svelte:head><title>Luo tunnus · Bläkkiskili</title></svelte:head>

<main class="page">
  <div class="mx-auto max-w-[30rem] pt-8">
    <h1>Luo tunnus</h1>
    {#if loading}
      <p class="text-secondary">Ladataan…</p>
    {:else if missing}
      <section class="card card-panel mt-4">
        <p>Aloita kirjautumalla: tunnus luodaan sille kirjautumistavalle, jolla tulit.</p>
        <a class="btn btn-primary" href="/login">Kirjautumiseen</a>
        {#if error}<p class="text-danger" role="alert">{error}</p>{/if}
      </section>
    {:else}
      <p class="mt-1.5 text-lg text-secondary">
        {#if method === "passkey"}
          Tunnukseen kirjaudutaan pääsyavaimella, jonka laitteesi luo, kun lähetät lomakkeen.
        {:else if method}
          Kirjauduit palvelulla {LOGIN_NAMES[method]}, mutta sillä ei ole vielä tunnusta. Täytä tiedot, niin tunnus luodaan.
        {/if}
        Painon, pituuden ja sukupuolen perusteella arvioidaan promillet.
      </p>

      <form class="card card-panel mt-4 grid gap-4" onsubmit={submit}>
        <label class="grid gap-1.25">Nimimerkki
          <input type="text" bind:value={name} minlength="2" maxlength="32" autocomplete="nickname" required />
          <span class="text-sm text-secondary">Näkyy ryhmissä ja kuvaajissa muille. Ei @-merkkiä alkuun.</span>
        </label>
        <div class="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-3">
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
          <span>Olen lukenut ja hyväksyn <a href="/terms" target="_blank">käyttöehdot</a> ja <a href="/privacy" target="_blank">tietosuojaselosteen</a>.</span>
        </label>
        <div class="flex flex-wrap items-center gap-4">
          <button class="btn btn-primary" type="submit" disabled={busy || !accept}>
            {#if method === "passkey"}<Icon name="key" />{:else}<Icon name="check" />{/if} Luo tunnus
          </button>
          <a href="/login">Peruuta</a>
        </div>
        {#if error}<p class="m-0 text-danger" role="alert">{error}</p>{/if}
      </form>
    {/if}
  </div>
</main>
