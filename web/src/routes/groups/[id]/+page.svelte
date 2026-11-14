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
  /** Large groups: only the top of the list until asked, and a name filter. */
  const MEMBERS_SHOWN = 12;
  let allMembers = $state(false);
  let query = $state("");
  const shownMembers = $derived.by(() => {
    const all = view?.members ?? [];
    const q = query.trim().toLocaleLowerCase("fi");
    if (q) return all.filter((m) => m.name.toLocaleLowerCase("fi").includes(q));
    if (allMembers || all.length <= MEMBERS_SHOWN + 2) return all;
    return all.filter((m, i) => i < MEMBERS_SHOWN || m.isMe);
  });

  const tag = "ml-1.5 inline-block rounded-sm border border-line px-1.5 text-xs whitespace-nowrap text-secondary";

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
  <nav class="mb-3.5 flex items-center gap-1.5 text-base text-secondary" aria-label="Murupolku">
    <a class="inline-flex items-center gap-1.25 text-inherit no-underline hover:text-fg hover:underline" href="/groups"><Icon name="users" /> Ryhmät</a>
    {#if view}<Icon name="chevron-right" /><span class="text-fg" aria-current="page">{view.group.name}</span>{/if}
  </nav>
  {#if error}<p class="text-danger" role="alert">{error}</p>{/if}

  {#if view}
    <div class="mb-5">
      <h1>{view.group.name}</h1>
      <p class="mt-1.5 mb-0 text-lg text-secondary">{view.group.memberCount} jäsentä · {view.group.kind === "telegram" ? "Telegram-ryhmä" : "Verkkoryhmä"} · päivittyy automaattisesti ({clock(view.now)})</p>
    </div>

    <div class="grid items-start gap-4 min-[62rem]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] min-[62rem]:gap-6">
      <div class="grid min-w-0 gap-4">
        <section class="card" aria-label="Ryhmän promillekuvaaja">
          {#if view.chart.lines.length}
            <Chart data={view.chart} />
          {:else}
            <p class="text-secondary">Kukaan ei ole juonut viimeisen vuorokauden aikana.</p>
          {/if}
        </section>

        <section class="card">
          <h2>Jäsenet</h2>
          {#if view.members.length > MEMBERS_SHOWN + 2}
            <input class="mb-2" type="search" bind:value={query} placeholder="Hae jäsentä" aria-label="Hae jäsentä" />
          {/if}
          <ul>
            {#each shownMembers as m (m.ref)}
              <li class="grid grid-cols-[1fr_auto_auto_2.5rem] items-center gap-3 border-t border-line-soft py-1.75 first:border-t-0">
                <span class="wrap-anywhere">{m.name}{#if m.isMe} <span class={tag}>sinä</span>{/if}{#if m.hidden && m.isMe} <span class={tag}>nimetön näytöillä</span>{/if}</span>
                <span class="text-right font-bold whitespace-nowrap tabular-nums">{permille(m.permille)}‰</span>
                <span class="text-right whitespace-nowrap text-secondary tabular-nums">{decimal1(m.standardDrinks12h)} ann. / 12 h</span>
                {#if view.group.isOwner && !m.isMe}
                  <button class="btn btn-ghost btn-sm btn-icon" disabled={busy} onclick={() => remove(m.ref, m.name)} aria-label="Poista {m.name} ryhmästä" title="Poista ryhmästä"><Icon name="trash" /></button>
                {:else}
                  <span></span>
                {/if}
              </li>
            {/each}
          </ul>
          {#if query.trim() && !shownMembers.length}
            <p class="text-secondary">Ei hakutuloksia.</p>
          {/if}
          {#if !query.trim() && view.members.length > MEMBERS_SHOWN + 2}
            <button class="btn btn-ghost btn-sm mt-2" onclick={() => (allMembers = !allMembers)}>
              {allMembers ? "Näytä vain parhaat" : `Näytä kaikki (${view.members.length})`}
            </button>
          {/if}
        </section>
      </div>

      <div class="grid min-w-0 gap-4">
        <section class="card card-panel">
          <h2 class="flex items-center gap-2"><Icon name="monitor" /> Näytä ruudulla</h2>
          <p class="text-secondary">
            Luo linkki, jonka voi avata ilman kirjautumista esimerkiksi tv:ssä tai muulla yhteisellä näytöllä. Linkin haltija näkee ryhmän jäsenten nimet ja promillet, joten jaa se vain näytölle.
          </p>
          <div class="mt-3 flex flex-wrap items-end gap-3">
            <label class="grid min-w-[9rem] gap-1.25 max-[480px]:flex-[1_1_100%]">Voimassa
              <select bind:value={hours}>
                <option value="6">6 tuntia</option>
                <option value="24">24 tuntia</option>
                <option value="72">3 päivää</option>
                <option value="168">7 päivää</option>
              </select>
            </label>
            <div class="flex flex-wrap gap-2 max-[480px]:flex-[1_1_100%] max-[480px]:*:flex-[1_1_0]">
              <button class="btn btn-primary" disabled={busy} onclick={makeScreen}><Icon name="link" /> Luo näyttölinkki</button>
              {#if castEnabled}
              <button class="btn" disabled={busy} onclick={castNow} title="Luo linkin ja lähettää sen suoraan tv:hen tai muulle näytölle.">
                <Icon name="cast" /> Lähetä näytölle
              </button>
              {/if}
            </div>
          </div>

          {#if fresh?.kind === "screen"}
            {@render freshLink("Linkki näkyy vain nyt. Kopioi se ja avaa näytöllä:", "Näyttölinkki", fresh.url)}
          {/if}

          {#if view.screens.length}
            <ul class="mt-3">
              {#each view.screens as s (s.ref)}
                <li class="flex items-center justify-between gap-2 border-t border-line py-1.5">
                  <span>Näyttölinkki · {s.mine ? "oma" : (s.createdBy ?? "entinen jäsen")} · voimassa {dayClock(s.expiresAt, view.now)}</span>
                  {#if s.mine || view.group.isOwner || view.isTelegramAdmin}
                    <button class="btn btn-sm" disabled={busy} onclick={() => revokeScreen(s.ref)}>Peru</button>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}

          <label class="mt-4 flex items-center gap-2.5">
            <input type="checkbox" checked={view.group.hideOnScreen} disabled={busy} onchange={(e) => toggleHide(e.currentTarget.checked)} />
            Näytä minut näytöillä nimettömänä (Nimetön 1, 2, …)
          </label>
        </section>

        {#if view.group.kind === "web" && view.group.isOwner}
          <section class="card card-panel">
            <h2 class="flex items-center gap-2"><Icon name="link" /> Kutsu</h2>
            <p class="text-secondary">
              Kutsulinkillä pääsee ryhmään.
              {#if view.inviteExpiresAt}Nykyinen kutsu on voimassa {dayClock(view.inviteExpiresAt, view.now)} asti.{/if}
              Uusi linkki korvaa vanhan.
            </p>
            <div class="mt-3 flex flex-wrap items-end gap-3">
              <button class="btn btn-primary" disabled={busy} onclick={makeInvite}><Icon name="plus" /> Luo kutsulinkki</button>
              {#if view.inviteExpiresAt}<button class="btn" disabled={busy} onclick={revokeInvite}>Peru kutsu</button>{/if}
            </div>
            {#if fresh?.kind === "invite"}
              {@render freshLink("Linkki näkyy vain nyt:", "Kutsulinkki", fresh.url)}
            {/if}
            <form class="mt-4 grid gap-1.25" onsubmit={saveName}>
              <label for="rn">Ryhmän nimi</label>
              <div class="flex gap-2">
                <input id="rn" type="text" bind:value={rename} maxlength="40" required />
                <button class="btn" disabled={busy} type="submit">Nimeä uudelleen</button>
              </div>
            </form>
          </section>
        {/if}

        <section class="flex flex-wrap justify-end gap-2">
          <button class="btn" disabled={busy} onclick={leave}><Icon name="door" /> Poistu ryhmästä</button>
          {#if view.group.kind === "web" && view.group.isOwner}
            <button class="btn btn-danger" disabled={busy} onclick={destroy}><Icon name="trash" /> Poista ryhmä</button>
          {/if}
        </section>
      </div>
    </div>
  {:else if !error}
    <p class="text-secondary">Ladataan…</p>
  {/if}
</main>

{#snippet freshLink(intro: string, label: string, url: string)}
  <div class="mt-3 grid gap-2 rounded-sm border border-dashed border-axis bg-surface-1 p-3">
    <p class="m-0">{intro}</p>
    <div class="flex gap-2">
      <input type="text" readonly value={url} onfocus={(e) => e.currentTarget.select()} aria-label={label} />
      <button class="btn" onclick={() => copy(url)}><Icon name={copied ? "check" : "copy"} /> {copied ? "Kopioitu" : "Kopioi"}</button>
    </div>
  </div>
{/snippet}
