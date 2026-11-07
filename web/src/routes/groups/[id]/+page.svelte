<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import type { GroupView } from "../../../../../shared/api.ts";
  import { api, ApiError, errorText } from "#lib/api.ts";
  import Chart from "#lib/Chart.svelte";
  import { clock, dayClock, decimal1, permille } from "#lib/format.ts";
  import { session } from "#lib/session.svelte.ts";

  const id = page.params.id!;
  let view = $state<GroupView | null>(null);
  let error = $state("");
  let busy = $state(false);
  let rename = $state("");
  let hours = $state("24");
  /** Links are only shown right after they are made: the server keeps just a hash. */
  let fresh = $state<{ kind: "invite" | "screen"; url: string } | null>(null);
  let copied = $state(false);

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    busy = true;
    error = "";
    try {
      return await action();
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    const source = new EventSource(`/api/groups/${id}/events`);
    source.addEventListener("update", (e) => {
      view = JSON.parse((e as MessageEvent).data);
      rename ||= view!.group.name;
      error = "";
    });
    // Deleted, or you were removed: back to the list.
    source.addEventListener("end", () => {
      source.close();
      goto("/groups", { replaceState: true });
    });
    source.onerror = async () => {
      try {
        await api.group(id);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          source.close();
          goto("/groups", { replaceState: true });
        } else if (e instanceof ApiError && e.status === 401) {
          source.close();
          session.me = null;
        }
      }
    };
    return () => source.close();
  });

  const origin = () => location.origin;

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      error = "Kopiointi ei onnistunut. Valitse linkki ja kopioi se käsin.";
    }
  }

  const makeInvite = () =>
    run(async () => {
      const r = await api.createInvite(id);
      fresh = { kind: "invite", url: `${origin()}/join#c=${r.code}` };
      view = await api.group(id);
    });
  const revokeInvite = () =>
    run(async () => {
      await api.revokeInvite(id);
      fresh = null;
      view = await api.group(id);
    });
  const makeScreen = () =>
    run(async () => {
      const r = await api.createGroupScreen(id, Number(hours));
      fresh = { kind: "screen", url: `${origin()}/screen#t=${r.token}` };
      view = await api.group(id);
    });
  const revokeScreen = (ref: string) =>
    run(async () => {
      await api.revokeGroupScreen(id, ref);
      view = await api.group(id);
    });
  const saveName = (e: SubmitEvent) => {
    e.preventDefault();
    return run(async () => (view = await api.renameGroup(id, rename)));
  };
  const toggleHide = (hidden: boolean) => run(async () => (view = await api.hideOnScreens(id, hidden)));
  const remove = (ref: string, name: string) => {
    if (!confirm(`Poistetaanko ${name} ryhmästä?`)) return;
    return run(async () => {
      await api.removeMember(id, ref);
      view = await api.group(id);
    });
  };
  const leave = async () => {
    if (!confirm("Poistutaanko ryhmästä?")) return;
    if (await run(() => api.leaveGroup(id))) goto("/groups");
  };
  const destroy = async () => {
    if (!confirm("Poistetaanko ryhmä kaikilta? Tätä ei voi perua.")) return;
    if (await run(() => api.deleteGroup(id))) goto("/groups");
  };
</script>

<svelte:head><title>{view?.group.name ?? "Ryhmä"} · Bläkkiskili</title></svelte:head>

<main class="page">
  <p class="back"><a href="/groups">← Ryhmät</a></p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if view}
    <h1>{view.group.name}</h1>
    <p class="muted">{view.group.memberCount} jäsentä · {view.group.kind === "telegram" ? "Telegram-ryhmä" : "Verkkoryhmä"}</p>

    <div class="cols">
     <div class="left">
    <section class="card">
      {#if view.chart.lines.length}
        <Chart data={view.chart} />
      {:else}
        <p class="muted">Kukaan ei ole juonut viimeisen vuorokauden aikana.</p>
      {/if}
    </section>

    <section class="card">
      <h2>Jäsenet</h2>
      <ul class="members">
        {#each view.members as m (m.ref)}
          <li>
            <span class="who">{m.name}{m.isMe ? " (sinä)" : ""}{m.hidden ? " · nimetön näytöillä" : ""}</span>
            <span class="num">{permille(m.permille)}‰</span>
            <span class="muted num">{decimal1(m.standardDrinks12h)} ann. / 12 h</span>
            {#if view.group.isOwner && !m.isMe}
              <button class="btn small" disabled={busy} onclick={() => remove(m.ref, m.name)}>Poista</button>
            {:else}
              <span></span>
            {/if}
          </li>
        {/each}
      </ul>
    </section>

     </div>
     <div class="right">
    <section class="card">
      <h2>Näytä ruudulla</h2>
      <p class="muted">
        Luo linkki, jonka voi avata esimerkiksi tapahtuman tv:ssä ilman kirjautumista. Linkin haltija näkee ryhmän jäsenten nimet ja promillet, joten jaa se vain näytölle.
      </p>
      <div class="row">
        <label class="inline">Voimassa
          <select bind:value={hours}>
            <option value="6">6 tuntia</option>
            <option value="24">24 tuntia</option>
            <option value="72">3 päivää</option>
            <option value="168">7 päivää</option>
          </select>
        </label>
        <button class="btn primary" disabled={busy} onclick={makeScreen}>Luo näyttölinkki</button>
      </div>

      {#if fresh?.kind === "screen"}
        <div class="fresh">
          <p>Linkki näkyy vain nyt. Kopioi se ja avaa näytöllä:</p>
          <input type="text" readonly value={fresh.url} onfocus={(e) => e.currentTarget.select()} aria-label="Näyttölinkki" />
          <button class="btn" onclick={() => copy(fresh!.url)}>{copied ? "Kopioitu" : "Kopioi"}</button>
        </div>
      {/if}

      {#if view.screens.length}
        <ul class="links">
          {#each view.screens as s (s.ref)}
            <li>
              <span>Näyttölinkki{s.mine ? " (oma)" : ""} · voimassa {dayClock(s.expiresAt, view.now)}</span>
              {#if s.mine || view.group.isOwner}
                <button class="btn small" disabled={busy} onclick={() => revokeScreen(s.ref)}>Peru</button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      <label class="check">
        <input type="checkbox" checked={view.group.hideOnScreen} disabled={busy} onchange={(e) => toggleHide(e.currentTarget.checked)} />
        Näytä minut näytöillä nimettömänä (Nimetön 1, 2, …)
      </label>
    </section>

    {#if view.group.kind === "web" && view.group.isOwner}
      <section class="card">
        <h2>Kutsu</h2>
        <p class="muted">
          Kutsulinkillä pääsee ryhmään.
          {#if view.inviteExpiresAt}Nykyinen kutsu on voimassa {dayClock(view.inviteExpiresAt, view.now)} asti.{/if}
          Uusi linkki korvaa vanhan.
        </p>
        <div class="row">
          <button class="btn primary" disabled={busy} onclick={makeInvite}>Luo kutsulinkki</button>
          {#if view.inviteExpiresAt}<button class="btn" disabled={busy} onclick={revokeInvite}>Peru kutsu</button>{/if}
        </div>
        {#if fresh?.kind === "invite"}
          <div class="fresh">
            <p>Linkki näkyy vain nyt:</p>
            <input type="text" readonly value={fresh.url} onfocus={(e) => e.currentTarget.select()} aria-label="Kutsulinkki" />
            <button class="btn" onclick={() => copy(fresh!.url)}>{copied ? "Kopioitu" : "Kopioi"}</button>
          </div>
        {/if}
        <form class="rename" onsubmit={saveName}>
          <label class="sr-only" for="rn">Ryhmän nimi</label>
          <input id="rn" type="text" bind:value={rename} maxlength="40" required />
          <button class="btn" disabled={busy} type="submit">Nimeä uudelleen</button>
        </form>
      </section>
    {/if}

    <section class="card danger-zone">
      <button class="btn" disabled={busy} onclick={leave}>Poistu ryhmästä</button>
      {#if view.group.kind === "web" && view.group.isOwner}
        <button class="btn danger" disabled={busy} onclick={destroy}>Poista ryhmä</button>
      {/if}
    </section>
     </div>
    </div>
    <p class="muted updated">Päivittyy automaattisesti · {clock(view.now)}</p>
  {:else if !error}
    <p class="muted">Ladataan…</p>
  {/if}
</main>

<style>
  h1 {
    font-size: 1.5rem;
  }
  h2 {
    font-size: 1.05rem;
    margin-bottom: 0.5rem;
  }
  .back {
    margin: 0 0 0.5rem;
  }
  .card {
    margin-top: 1rem;
  }
  .members,
  .links {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .members li {
    display: grid;
    grid-template-columns: 1fr auto auto 4.6rem;
    gap: 0.75rem;
    align-items: center;
    padding: 0.4rem 0;
    border-top: 1px solid var(--border);
  }
  .members li:first-child {
    border-top: 0;
  }
  .who {
    overflow-wrap: anywhere;
  }
  .num {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .links li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0;
    border-top: 1px solid var(--border);
  }
  .row {
    display: flex;
    gap: 0.75rem;
    align-items: end;
    flex-wrap: wrap;
  }
  .inline {
    display: grid;
    gap: 0.2rem;
    font-size: 0.9rem;
    color: var(--text-secondary);
  }
  .fresh {
    margin-top: 0.75rem;
    padding: 0.75rem;
    border: 1px dashed var(--axis);
    border-radius: 10px;
    display: grid;
    gap: 0.5rem;
  }
  .fresh p {
    margin: 0;
  }
  .check {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-top: 1rem;
    color: var(--text-secondary);
  }
  .small {
    padding: 0.2rem 0.6rem;
    min-height: 36px;
    font-size: 0.85rem;
  }
  .rename {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  .danger-zone {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .danger {
    border-color: var(--danger);
    color: var(--danger);
  }
  .updated {
    font-size: 0.85rem;
    margin-top: 1rem;
  }
</style>
