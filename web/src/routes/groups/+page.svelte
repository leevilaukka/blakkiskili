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
<div class="mx-auto max-w-[46rem]">
  <div class="mb-5">
    <h1>Ryhmät</h1>
    <p class="mt-1.5 mb-0 text-lg text-secondary">Ryhmässä näet muiden promillet samassa kuvaajassa, ja näyttölinkillä ne saa myös esimerkiksi tv:hen.</p>
  </div>
  {#if error}<p class="text-danger" role="alert">{error}</p>{/if}

  {#if groups === null}
    <p class="text-secondary">Ladataan…</p>
  {:else if groups.length === 0}
    <p class="card text-secondary">Et ole vielä missään ryhmässä. Luo ryhmä tai liity kutsulinkillä. Telegram-ryhmät ilmestyvät tänne, kun sanot ryhmässä /moro.</p>
  {:else}
    <ul class="mb-6 grid gap-2">
      {#each groups as g (g.id)}
        <li>
          <a
            class="flex items-center gap-3.5 rounded-sm border border-line bg-surface-1 px-4 py-3.25 text-secondary no-underline shadow-edge transition-colors hover:bg-surface-2"
            href="/groups/{g.id}"
          >
            <span class="grid size-10 flex-none place-items-center rounded-sm bg-brand-4 text-white" aria-hidden="true"><Icon name={g.kind === "telegram" ? "send" : "users"} /></span>
            <span class="grid min-w-0 flex-1 gap-0.5">
              <span class="text-lg font-bold wrap-anywhere text-fg">{g.name}</span>
              <span>{g.memberCount} jäsentä · {g.kind === "telegram" ? "Telegram" : "Verkkoryhmä"}{g.isOwner ? " · perustaja" : ""}</span>
            </span>
            <Icon name="chevron-right" />
          </a>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="grid gap-4 min-[46rem]:grid-cols-2">
    <section class="card card-panel">
      <h2>Luo ryhmä</h2>
      <form class="flex gap-2" onsubmit={create}>
        <label class="sr-only" for="gname">Ryhmän nimi</label>
        <input id="gname" type="text" bind:value={name} maxlength="40" placeholder="Esim. Mökkiviikonloppu" required />
        <button class="btn btn-primary" disabled={busy} type="submit"><Icon name="plus" /> Luo</button>
      </form>
    </section>

    <section class="card card-panel">
      <h2>Liity kutsulla</h2>
      <form class="flex gap-2" onsubmit={join}>
        <label class="sr-only" for="invite">Kutsulinkki tai koodi</label>
        <input id="invite" type="text" bind:value={invite} placeholder="Liitä kutsulinkki tai koodi" required autocomplete="off" />
        <button class="btn" disabled={busy} type="submit">Liity</button>
      </form>
    </section>
  </div>
</div>
</main>
