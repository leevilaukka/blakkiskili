<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import type { GroupSummary } from "../../../../shared/api.ts";
  import { api, errorText } from "#lib/api.ts";
  import Icon from "#lib/Icon.svelte";

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
  <div class="head">
    <h1>Ryhmät</h1>
    <p class="lead">Ryhmässä näet muiden promillet samassa kuvaajassa, ja näyttölinkillä ne saa myös esimerkiksi tv:hen.</p>
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if groups === null}
    <p class="muted">Ladataan…</p>
  {:else if groups.length === 0}
    <p class="card muted">Et ole vielä missään ryhmässä. Luo ryhmä tai liity kutsulinkillä. Telegram-ryhmät ilmestyvät tänne, kun sanot ryhmässä /moro.</p>
  {:else}
    <ul class="groups">
      {#each groups as g (g.id)}
        <li>
          <a href="/groups/{g.id}">
            <span class="badge" aria-hidden="true"><Icon name={g.kind === "telegram" ? "send" : "users"} /></span>
            <span class="text">
              <span class="name">{g.name}</span>
              <span class="muted">{g.memberCount} jäsentä · {g.kind === "telegram" ? "Telegram" : "Verkkoryhmä"}{g.isOwner ? " · perustaja" : ""}</span>
            </span>
            <Icon name="chevron-right" />
          </a>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="forms">
    <section class="card panel">
      <h2>Luo ryhmä</h2>
      <form onsubmit={create}>
        <label class="sr-only" for="gname">Ryhmän nimi</label>
        <input id="gname" type="text" bind:value={name} maxlength="40" placeholder="Esim. Mökkiviikonloppu" required />
        <button class="btn primary" disabled={busy} type="submit"><Icon name="plus" /> Luo</button>
      </form>
    </section>

    <section class="card panel">
      <h2>Liity kutsulla</h2>
      <form onsubmit={join}>
        <label class="sr-only" for="invite">Kutsulinkki tai koodi</label>
        <input id="invite" type="text" bind:value={invite} placeholder="Liitä kutsulinkki tai koodi" required autocomplete="off" />
        <button class="btn" disabled={busy} type="submit">Liity</button>
      </form>
    </section>
  </div>
</div>
</main>

<style>
  .groups {
    list-style: none;
    margin: 0 0 1.5rem;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }
  .groups a {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    padding: 0.8rem 1rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    box-shadow: var(--shadow);
    text-decoration: none;
    color: var(--text-secondary);
    background: var(--surface-1);
    transition: background-color 0.15s;
  }
  .groups a:hover {
    background: var(--surface-2);
  }
  .badge {
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 4px;
    background: var(--brand-4);
    color: #fff;
    flex: none;
  }
  .text {
    display: grid;
    gap: 0.1rem;
    flex: 1;
    min-width: 0;
  }
  .name {
    font-weight: 700;
    font-size: 1.07rem;
    color: var(--text-primary);
    overflow-wrap: anywhere;
  }
  .forms {
    display: grid;
    gap: 1rem;
  }
  @media (min-width: 46rem) {
    .forms {
      grid-template-columns: 1fr 1fr;
    }
  }
  form {
    display: flex;
    gap: 0.5rem;
  }
</style>
