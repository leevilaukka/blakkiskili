<script lang="ts">
  import { onMount } from "svelte";
  import type { Dashboard } from "../../../shared/api.ts";
  import { api, ApiError, errorText } from "#lib/api.ts";
  import { session } from "#lib/session.svelte.ts";
  import Chart from "#lib/Chart.svelte";
  import Icon from "#lib/Icon.svelte";
  import { clock, dayClock, decimal1, permille } from "#lib/format.ts";

  let dash = $state<Dashboard | null>(null);
  let error = $state("");
  let busy = $state(false);

  async function load() {
    try {
      dash = await api.dashboard();
      error = "";
    } catch (e) {
      error = errorText(e);
    }
  }

  onMount(() => {
    load();
    // The server pushes a fresh dashboard whenever something changes (a drink from the bot or
    // another tab) and every 15 s as the estimate falls with the clock. If nothing arrives for a
    // while (a proxy buffering the stream, an old browser), fall back to asking.
    let lastUpdate = Date.now();
    const source = new EventSource("/api/events");
    source.addEventListener("update", (e) => {
      dash = JSON.parse((e as MessageEvent).data);
      error = "";
      lastUpdate = Date.now();
    });
    // The account signed out everywhere (or was deleted): find out which and leave.
    source.addEventListener("end", async () => {
      source.close();
      await api.me().catch((e) => {
        if (e instanceof ApiError && e.status === 401) session.me = null;
      });
    });
    source.onerror = async () => {
      // The browser reconnects by itself; only check whether the session is the reason.
      try {
        await api.me();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          source.close();
          session.me = null;
        }
      }
    };
    const fallback = setInterval(() => {
      if (Date.now() - lastUpdate > 45_000) load();
    }, 15_000);
    return () => {
      source.close();
      clearInterval(fallback);
    };
  });

  async function remove(id: number) {
    busy = true;
    try {
      await api.remove(id);
      await load();
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Etusivu · Bläkkiskili</title></svelte:head>

<main class="page">
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if dash}
    <div class="cols">
      <div>
        <section class="hero" aria-live="polite">
          <div>
            <h1 class="label">Promilleja arviolta</h1>
            <p class="value">{permille(dash.permille)}<span class="unit">‰</span></p>
            <p class="sober">
              {#if dash.soberAt}Selvä {dayClock(dash.soberAt, dash.now)}{:else}Ei alkoholia veressä{/if}
            </p>
          </div>
          <a class="btn add" href="/log"><Icon name="plus" /> Lisää juoma</a>
        </section>

        <section class="card" aria-label="Promillekuvaaja">
          {#if dash.chart.lines.length}
            <Chart data={dash.chart} />
          {:else}
            <p class="muted">Ei juomia viimeisen vuorokauden ajalta. Kuvaaja ilmestyy, kun lisäät juoman.</p>
          {/if}
        </section>
      </div>

      <section class="tonight" aria-labelledby="tonight">
        <h2 id="tonight">Tämä ilta</h2>
        <div class="stats">
          <div class="stat">
            <span class="k">Annoksia</span>
            <span class="v">{decimal1(dash.session.standardDrinks)}</span>
          </div>
          <div class="stat">
            <span class="k">Energia</span>
            <span class="v">{dash.session.kcal} <small>kcal</small></span>
            {#if dash.session.unknownKcal}<span class="sub">+ {dash.session.unknownKcal} ilman tietoa</span>{/if}
          </div>
        </div>

        <div class="card list">
          {#if dash.session.drinks.length}
            <ul class="drinks">
              {#each [...dash.session.drinks].reverse() as d (d.id)}
                <li>
                  <span class="time">{clock(d.createdAt)}</span>
                  <span class="desc">{d.description}</span>
                  <span class="muted num">{decimal1(d.standardDrinks)} ann.</span>
                  <button class="btn ghost small icon" disabled={busy} onclick={() => remove(d.id)} aria-label="Poista {d.description}" title="Poista">
                    <Icon name="trash" />
                  </button>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="muted empty">Ei juomia tänä iltana.</p>
          {/if}
        </div>
        <a class="all" href="/logbook">Kaikki juomat päiväkirjassa <Icon name="chevron-right" /></a>
      </section>
    </div>
  {:else if !error}
    <p class="muted">Ladataan…</p>
  {/if}
</main>

<style>
  /* Alkometriikka's highlight card: brand-4 with white text, the same in light and dark */
  .hero {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    justify-content: space-between;
    gap: 1rem 1.5rem;
    padding: 1.25rem 1.5rem 1.5rem;
    border: 1px solid var(--brand-2);
    border-radius: 4px;
    background: var(--brand-4);
    color: #fff;
  }
  .label {
    margin: 0;
    font-size: 1.07rem;
    font-weight: 500;
    color: rgb(255 255 255 / 80%);
  }
  .value {
    margin: 0.1rem 0 0;
    font-size: clamp(3.6rem, 16vw, 5.5rem);
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums;
  }
  .unit {
    font-size: 0.42em;
    margin-left: 0.12em;
    letter-spacing: 0;
    color: rgb(255 255 255 / 80%);
  }
  .sober {
    margin: 0.5rem 0 0;
    font-size: 1.07rem;
    color: rgb(255 255 255 / 85%);
  }
  .add {
    background: #fff;
    border-color: #fff;
    color: var(--brand-4);
    font-weight: 700;
    font-size: 1.07rem;
    padding: 0.6rem 1.1rem;
  }
  .add:hover {
    background: #f3f4f6;
  }
  @media (max-width: 30rem) {
    .add {
      flex: 1 1 100%;
    }
  }

  .tonight {
    display: grid;
    gap: 0.6rem;
  }
  .list {
    padding: 0.25rem 1rem;
  }
  .empty {
    margin: 0.75rem 0;
  }
  .drinks {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .drinks li {
    display: grid;
    grid-template-columns: 3rem 1fr auto auto;
    gap: 0.6rem;
    align-items: center;
    padding: 0.4rem 0;
    border-top: 1px solid var(--border-soft);
  }
  .drinks li:first-child {
    border-top: 0;
  }
  .time,
  .num {
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .desc {
    overflow-wrap: anywhere;
  }
  .all {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    justify-self: end;
  }
</style>
