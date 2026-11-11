<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import type { GroupView } from "../../../../../shared/api.ts";
  import { api, ApiError, errorText } from "#lib/api.ts";
  import { canCast, castEnabled, castFailed, castScreen, castUnsupported } from "#lib/cast.ts";
  import Chart from "#lib/Chart.svelte";
  import Icon from "#lib/Icon.svelte";
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
  /** Makes a screen link and casts it straight to a display; the link is not shown. */
  const castNow = () =>
    run(async () => {
      if (!canCast) {
        error = castUnsupported;
        return;
      }
      const r = await api.createGroupScreen(id, Number(hours));
      view = await api.group(id);
      if (!(await castScreen(r.token, () => {}))) error = castFailed;
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
  <nav class="crumbs" aria-label="Murupolku">
    <a href="/groups"><Icon name="users" /> Ryhmät</a>
    {#if view}<Icon name="chevron-right" /><span aria-current="page">{view.group.name}</span>{/if}
  </nav>
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if view}
    <div class="head">
      <h1>{view.group.name}</h1>
      <p class="lead">{view.group.memberCount} jäsentä · {view.group.kind === "telegram" ? "Telegram-ryhmä" : "Verkkoryhmä"} · päivittyy automaattisesti ({clock(view.now)})</p>
    </div>

    <div class="cols">
      <div>
        <section class="card" aria-label="Ryhmän promillekuvaaja">
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
                <span class="who">{m.name}{#if m.isMe} <span class="tag">sinä</span>{/if}{#if m.hidden} <span class="tag">nimetön näytöillä</span>{/if}</span>
                <span class="num strong">{permille(m.permille)}‰</span>
                <span class="num muted">{decimal1(m.standardDrinks12h)} ann. / 12 h</span>
                {#if view.group.isOwner && !m.isMe}
                  <button class="btn ghost small icon" disabled={busy} onclick={() => remove(m.ref, m.name)} aria-label="Poista {m.name} ryhmästä" title="Poista ryhmästä"><Icon name="trash" /></button>
                {:else}
                  <span></span>
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      </div>

      <div>
        <section class="card panel">
          <h2><Icon name="monitor" /> Näytä ruudulla</h2>
          <p class="muted">
            Luo linkki, jonka voi avata esimerkiksi tapahtuman tv:ssä ilman kirjautumista. Linkin haltija näkee ryhmän jäsenten nimet ja promillet, joten jaa se vain näytölle.
          </p>
          <div class="row">
            <label class="field">Voimassa
              <select bind:value={hours}>
                <option value="6">6 tuntia</option>
                <option value="24">24 tuntia</option>
                <option value="72">3 päivää</option>
                <option value="168">7 päivää</option>
              </select>
            </label>
            <div class="buttons">
              <button class="btn primary" disabled={busy} onclick={makeScreen}><Icon name="link" /> Luo näyttölinkki</button>
              {#if castEnabled}
              <button class="btn" disabled={busy} onclick={castNow} title="Luo linkin ja lähettää sen suoraan tv:hen tai muulle näytölle.">
                <Icon name="cast" /> Lähetä näytölle
              </button>
              {/if}
            </div>
          </div>

          {#if fresh?.kind === "screen"}
            <div class="fresh">
              <p>Linkki näkyy vain nyt. Kopioi se ja avaa näytöllä:</p>
              <div class="copyrow">
                <input type="text" readonly value={fresh.url} onfocus={(e) => e.currentTarget.select()} aria-label="Näyttölinkki" />
                <button class="btn" onclick={() => copy(fresh!.url)}><Icon name={copied ? "check" : "copy"} /> {copied ? "Kopioitu" : "Kopioi"}</button>
              </div>
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
          <section class="card panel">
            <h2><Icon name="link" /> Kutsu</h2>
            <p class="muted">
              Kutsulinkillä pääsee ryhmään.
              {#if view.inviteExpiresAt}Nykyinen kutsu on voimassa {dayClock(view.inviteExpiresAt, view.now)} asti.{/if}
              Uusi linkki korvaa vanhan.
            </p>
            <div class="row">
              <button class="btn primary" disabled={busy} onclick={makeInvite}><Icon name="plus" /> Luo kutsulinkki</button>
              {#if view.inviteExpiresAt}<button class="btn" disabled={busy} onclick={revokeInvite}>Peru kutsu</button>{/if}
            </div>
            {#if fresh?.kind === "invite"}
              <div class="fresh">
                <p>Linkki näkyy vain nyt:</p>
                <div class="copyrow">
                  <input type="text" readonly value={fresh.url} onfocus={(e) => e.currentTarget.select()} aria-label="Kutsulinkki" />
                  <button class="btn" onclick={() => copy(fresh!.url)}><Icon name={copied ? "check" : "copy"} /> {copied ? "Kopioitu" : "Kopioi"}</button>
                </div>
              </div>
            {/if}
            <form class="rename" onsubmit={saveName}>
              <label class="field" for="rn">Ryhmän nimi</label>
              <div class="copyrow">
                <input id="rn" type="text" bind:value={rename} maxlength="40" required />
                <button class="btn" disabled={busy} type="submit">Nimeä uudelleen</button>
              </div>
            </form>
          </section>
        {/if}

        <section class="exit">
          <button class="btn" disabled={busy} onclick={leave}><Icon name="door" /> Poistu ryhmästä</button>
          {#if view.group.kind === "web" && view.group.isOwner}
            <button class="btn danger" disabled={busy} onclick={destroy}><Icon name="trash" /> Poista ryhmä</button>
          {/if}
        </section>
      </div>
    </div>
  {:else if !error}
    <p class="muted">Ladataan…</p>
  {/if}
</main>

<style>
  h2 {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .members,
  .links {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .members li {
    display: grid;
    grid-template-columns: 1fr auto auto 2.5rem;
    gap: 0.75rem;
    align-items: center;
    padding: 0.45rem 0;
    border-top: 1px solid var(--border-soft);
  }
  .members li:first-child {
    border-top: 0;
  }
  .who {
    overflow-wrap: anywhere;
  }
  .tag {
    display: inline-block;
    margin-left: 0.35rem;
    padding: 0 0.35rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 0.86rem;
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .num {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    text-align: right;
  }
  .strong {
    font-weight: 700;
  }
  .links {
    margin-top: 0.75rem;
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
    margin-top: 0.75rem;
  }
  .row .field {
    min-width: 9rem;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  @media (max-width: 480px) {
    .row .field,
    .buttons {
      flex: 1 1 100%;
    }
    .buttons .btn {
      flex: 1 1 0;
    }
  }
  .fresh {
    margin-top: 0.75rem;
    padding: 0.75rem;
    border: 1px dashed var(--axis);
    border-radius: 4px;
    background: var(--surface-1);
    display: grid;
    gap: 0.5rem;
  }
  .fresh p {
    margin: 0;
  }
  .copyrow {
    display: flex;
    gap: 0.5rem;
  }
  .check {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    margin-top: 1rem;
  }
  .rename {
    display: grid;
    gap: 0.3rem;
    margin-top: 1rem;
  }
  .exit {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
</style>
