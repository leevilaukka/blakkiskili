<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import type { GroupSummary } from "../../../../shared/api.ts";
  import { api, errorText } from "#lib/api.ts";

  let groups = $state<GroupSummary[] | null>(null);
  let error = $state("");
  let name = $state("");
  let invite = $state("");
  let busy = $state(false);

  async function load() {
    try {
      groups = (await api.groups()).groups;
    } catch (e) {
      error = errorText(e);
    }
  }
  onMount(load);

  async function create(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    try {
      const g = await api.createGroup(name);
      goto(`/groups/${g.id}`);
    } catch (err) {
      error = errorText(err);
      busy = false;
    }
  }

  async function join(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    // Accepts the whole link or just the code.
    const code = invite.includes("#c=") ? invite.split("#c=")[1]! : invite.trim();
    try {
      const { id } = await api.joinGroup(code.trim());
      goto(`/groups/${id}`);
    } catch (err) {
      error = errorText(err);
      busy = false;
    }
  }
</script>

<svelte:head><title>Ryhmät · Bläkkiskili</title></svelte:head>

<main class="page">
<div class="col">
  <h1>Ryhmät</h1>
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if groups === null}
    <p class="muted">Ladataan…</p>
  {:else if groups.length === 0}
    <p class="muted">Et ole vielä missään ryhmässä. Luo ryhmä tai liity kutsulinkillä. Telegram-ryhmät ilmestyvät tänne, kun sanot ryhmässä /moro.</p>
  {:else}
    <ul class="groups">
      {#each groups as g (g.id)}
        <li>
          <a href="/groups/{g.id}">
            <span class="name">{g.name}</span>
            <span class="muted">{g.memberCount} jäsentä · {g.kind === "telegram" ? "Telegram" : "Verkkoryhmä"}{g.isOwner ? " · perustaja" : ""}</span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}

  <section class="card">
    <h2>Luo ryhmä</h2>
    <form onsubmit={create}>
      <label class="sr-only" for="gname">Ryhmän nimi</label>
      <input id="gname" type="text" bind:value={name} maxlength="40" placeholder="Esim. Mökkiviikonloppu" required />
      <button class="btn primary" disabled={busy} type="submit">Luo</button>
    </form>
  </section>

  <section class="card">
    <h2>Liity kutsulla</h2>
    <form onsubmit={join}>
      <label class="sr-only" for="invite">Kutsulinkki tai koodi</label>
      <input id="invite" type="text" bind:value={invite} placeholder="Liitä kutsulinkki tai koodi" required autocomplete="off" />
      <button class="btn" disabled={busy} type="submit">Liity</button>
    </form>
  </section>
</div>
</main>

<style>
  h1 {
    font-size: 1.4rem;
    margin-bottom: 0.75rem;
  }
  h2 {
    font-size: 1.05rem;
    margin-bottom: 0.6rem;
  }
  .groups {
    list-style: none;
    margin: 0 0 1rem;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }
  .groups a {
    display: grid;
    gap: 0.15rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--border);
    border-radius: 12px;
    text-decoration: none;
    color: var(--text-primary);
  }
  .groups a:hover {
    border-color: var(--axis);
  }
  .name {
    font-weight: 600;
  }
  .card {
    margin-top: 1rem;
  }
  form {
    display: flex;
    gap: 0.5rem;
  }
</style>
