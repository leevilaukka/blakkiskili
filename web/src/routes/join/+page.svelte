<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { api, ApiError, errorText } from "#lib/api.ts";
  import { session } from "#lib/session.svelte.ts";

  let error = $state("");
  let working = $state(true);

  // An invite link is /join#c=CODE. The code is in the fragment (never in a server log). If the
  // visitor isn't signed in, keep it for the sign-in page to hand back here.
  const KEY = "kili-invite";
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

  onMount(async () => {
    const fromLink = new URLSearchParams(location.hash.slice(1)).get("c");
    if (fromLink) {
      keep(fromLink);
      history.replaceState(null, "", location.pathname);
    }
    const code = fromLink ?? kept();
    if (!code) return goto("/groups", { replaceState: true });
    if (!session.me) return goto("/login", { replaceState: true });
    try {
      const { id } = await api.joinGroup(code);
      keep(null);
      goto(`/groups/${id}`, { replaceState: true });
    } catch (e) {
      keep(null);
      if (e instanceof ApiError && e.code === "already_member") return goto("/groups", { replaceState: true });
      error = errorText(e);
      working = false;
    }
  });
</script>

<svelte:head><title>Liity ryhmään · Bläkkiskili</title></svelte:head>
<!-- An invite opened in a tab already on /join only changes the fragment: start over with it -->
<svelte:window onhashchange={() => new URLSearchParams(location.hash.slice(1)).has("c") && location.reload()} />

<main class="page">
<div class="mx-auto max-w-[46rem]">
  <div class="mb-5"><h1>Liity ryhmään</h1></div>
  {#if working}<p class="text-secondary">Liitytään…</p>{/if}
  {#if error}
    <p class="text-danger" role="alert">{error}</p>
    <a class="btn" href="/groups">Omat ryhmät</a>
  {/if}
</div>
</main>
