<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import type { AdminProduct, AdminView } from "../../../../shared/api.ts";
  import { api, ApiError, errorText } from "#lib/api.ts";
  import { clock } from "#lib/format.ts";
  import Icon from "#lib/Icon.svelte";
  import { session } from "#lib/session.svelte.ts";

  let view = $state<AdminView | null>(null);
  let error = $state("");
  let busy = $state(false);
  let filter = $state("");

  const KINDS: Record<AdminProduct["kind"], string> = { olut: "Olut", viini: "Viini", kuohu: "Kuohuviini", vakeva: "Väkevä" };
  const n = new Intl.NumberFormat("fi-FI");
  const date = (ms: number) => new Date(ms).toLocaleDateString("fi-FI", { day: "numeric", month: "numeric", year: "numeric" });

  const products = $derived.by(() => {
    const items = view?.customProducts.items ?? [];
    const q = filter.trim().toLowerCase();
    return q ? items.filter((p) => p.name.toLowerCase().includes(q) || p.ean.includes(q)) : items;
  });

  async function load() {
    try {
      view = await api.admin();
      error = "";
    } catch (e) {
      // 404: not an admin (the API hides the page from everyone else).
      if (e instanceof ApiError && e.status === 404) return goto("/", { replaceState: true });
      error = errorText(e);
    }
  }

  onMount(() => {
    if (!session.me?.admin) {
      goto("/", { replaceState: true });
      return;
    }
    load();
  });

  /** The reports are handled: the product was fixed, or nothing was wrong. */
  async function clearReports(p: AdminProduct) {
    busy = true;
    try {
      await api.adminClearReports(p.ean);
      await load();
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  async function removeProduct(p: AdminProduct) {
    if (!confirm(`Poistetaanko tuote ${p.name} (${p.ean}) kaikilta? Jo kirjatut juomat säilyvät.`)) return;
    busy = true;
    try {
      await api.adminDeleteProduct(p.ean);
      await load();
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Ylläpito · Bläkkiskili</title></svelte:head>

<main class="page">
  <div class="head">
    <h1>Ylläpito</h1>
    <p class="lead">
      Näkyy vain ADMIN_IDS-listan Telegram-tunnuksille.
      {#if view}Tilanne {clock(view.now)}.{/if}
      <button class="btn ghost small" disabled={busy} onclick={load}><Icon name="repeat" /> Päivitä</button>
    </p>
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if view}
    <div class="cols">
      <div>
        {#if view.reported.length}
          <section class="card reported">
            <h2>Virheilmoitukset <span class="count">{n.format(view.reported.length)}</span></h2>
            <p class="muted small">
              Korjaa tuote lukemalla sen viivakoodi botille tai Juo-sivulla, ja kuittaa sitten. Ilmoittajia ei näytetä.
            </p>
            <ul class="products">
              {#each view.reported as p (p.ean)}
                <li>
                  <span class="what">
                    <strong>{p.name}</strong>
                    <span class="muted small">
                      {KINDS[p.kind]} · {n.format(Math.round(p.sizeL * 1000) / 10)} cl · {n.format(p.abv)} %{#if p.kcal100 !== null} · {n.format(p.kcal100)} kcal/100 ml{/if}
                      · <code>{p.ean}</code>
                    </span>
                    <ul class="reports">
                      {#each p.reports as r, i (i)}
                        <li><q>{r.message}</q> <span class="muted small">{date(r.createdAt)}</span></li>
                      {/each}
                    </ul>
                  </span>
                  <span class="actions">
                    <button class="btn small" disabled={busy} onclick={() => clearReports(p)} title="Merkitse käsitellyksi"><Icon name="check" /> Kuittaa</button>
                    <button class="btn ghost small icon" disabled={busy} onclick={() => removeProduct(p)} aria-label="Poista {p.name}" title="Poista tuote"><Icon name="trash" /></button>
                  </span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <section class="card">
          <h2>Botti</h2>
          <div class="stats">
            <div class="stat"><span class="k">Käyttäjiä</span><span class="v">{n.format(view.bot.users)}</span></div>
            <div class="stat">
              <span class="k">Aktiivisia 7 pv</span><span class="v">{n.format(view.bot.activeUsers7)}</span>
              <span class="sub">14 pv: {n.format(view.bot.activeUsers14)}</span>
            </div>
            <div class="stat"><span class="k">Ryhmiä</span><span class="v">{n.format(view.bot.groups)}</span></div>
            <div class="stat">
              <span class="k">Aktiivisia ryhmiä 7 pv</span><span class="v">{n.format(view.bot.activeGroups7)}</span>
              <span class="sub">14 pv: {n.format(view.bot.activeGroups14)}</span>
            </div>
            <div class="stat"><span class="k">Juomia</span><span class="v">{n.format(view.bot.drinks)}</span></div>
            <div class="stat"><span class="k">Juomia 24 h</span><span class="v">{n.format(view.bot.drinks24h)}</span></div>
          </div>
        </section>

        <section class="card">
          <h2>Verkkosivu</h2>
          <div class="stats">
            <div class="stat">
              <span class="k">Istuntoja</span><span class="v">{n.format(view.web.sessions)}</span>
              <span class="sub">{n.format(view.web.accounts)} tunnusta</span>
            </div>
            <div class="stat"><span class="k">Käyttäjiä 24 h</span><span class="v">{n.format(view.web.activeAccounts1)}</span></div>
            <div class="stat"><span class="k">Avoimia live-yhteyksiä</span><span class="v">{n.format(view.web.liveViewers)}</span></div>
            <div class="stat"><span class="k">Verkkoryhmiä</span><span class="v">{n.format(view.web.webGroups)}</span></div>
            <div class="stat"><span class="k">Voimassa olevia näyttölinkkejä</span><span class="v">{n.format(view.web.screenLinks)}</span></div>
            <div class="stat">
              <span class="k">Alkon katalogi</span>
              <span class="v">{view.catalogue.ready ? n.format(view.catalogue.drinks) : "–"}</span>
              <span class="sub">{view.catalogue.ready ? "juomaa haettavissa" : "ei ladattu"}</span>
            </div>
          </div>
        </section>

        <section class="card">
          <h2>Käyttäjien lisäämät tuotteet <span class="count">{n.format(view.customProducts.total)}</span></h2>
          {#if view.customProducts.total === 0}
            <p class="muted">Kukaan ei ole vielä lisännyt tuotetta viivakoodilla.</p>
          {:else}
            <label class="field">Rajaa nimellä tai viivakoodilla
              <input type="search" bind:value={filter} placeholder="esim. lager tai 6415…" />
            </label>
            {#if view.customProducts.total > view.customProducts.items.length}
              <p class="muted small">Näytetään {view.customProducts.items.length} viimeksi muutettua.</p>
            {/if}
            <ul class="products">
              {#each products as p (p.ean)}
                <li>
                  <span class="what">
                    <strong>{p.name}</strong>
                    <span class="muted small">
                      {KINDS[p.kind]} · {n.format(Math.round(p.sizeL * 1000) / 10)} cl · {n.format(p.abv)} %{#if p.kcal100 !== null} · {n.format(p.kcal100)} kcal/100 ml{/if}
                    </span>
                    <span class="muted small">
                      <code>{p.ean}</code> · lisätty {date(p.createdAt)}{#if p.updatedAt !== p.createdAt} · muutettu {date(p.updatedAt)}{/if}{#if p.orphan} · lisääjä poistanut tunnuksensa{/if}
                    </span>
                  </span>
                  <button class="btn ghost small icon" disabled={busy} onclick={() => removeProduct(p)} aria-label="Poista {p.name}" title="Poista tuote"><Icon name="trash" /></button>
                </li>
              {:else}
                <li class="muted">Ei osumia.</li>
              {/each}
            </ul>
          {/if}
        </section>
      </div>

      <div>
        <section class="card">
          <h2>Eniten juomia</h2>
          {#if view.bot.top.length}
            <ol class="top">
              {#each view.bot.top as t, i (i)}
                <li><span class="rank">{i + 1}.</span><span class="who">{t.name}</span><span class="num">{n.format(t.value)}</span></li>
              {/each}
            </ol>
          {:else}
            <p class="muted">Ei vielä juomia.</p>
          {/if}
        </section>
        <section class="card panel">
          <h2>Muualla</h2>
          <p class="muted">
            Botin puolella: <code>/admin_stats</code> ja <code>/admin_kuvaaja</code>. Tuotteita voi korjata myös botissa skannaamalla viivakoodin.
            Varmuuskopiot, palvelin ja häiriöt: <code>deploy/RUNBOOK.md</code>.
          </p>
        </section>
      </div>
    </div>
  {:else if !error}
    <p class="muted">Ladataan…</p>
  {/if}
</main>

<style>
  .lead {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.75rem;
  }
  h2 {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .count {
    padding: 0 0.4rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 0.93rem;
    font-weight: 500;
    color: var(--text-secondary);
  }
  .small {
    font-size: 0.9rem;
  }
  .field {
    margin-bottom: 0.75rem;
  }
  .products,
  .top {
    margin: 0;
    padding: 0;
  }
  .products,
  .top {
    list-style: none;
  }
  .products > li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    padding: 0.55rem 0;
    border-top: 1px solid var(--border-soft);
  }
  .what {
    display: grid;
    gap: 0.1rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .reported .products > li {
    align-items: flex-start;
  }
  .reports {
    margin: 0.3rem 0 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.25rem;
  }
  .reports q {
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    flex: none;
    gap: 0.25rem;
  }
  .top li {
    display: grid;
    grid-template-columns: 2rem 1fr auto;
    gap: 0.5rem;
    padding: 0.3rem 0;
    border-top: 1px solid var(--border-soft);
  }
  .top li:first-child {
    border-top: 0;
  }
  .rank {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .top .who {
    overflow-wrap: anywhere;
  }
  .top .num {
    font-variant-numeric: tabular-nums;
  }
  code {
    font-size: 0.9em;
  }
</style>
