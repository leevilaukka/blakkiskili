<script lang="ts">
  import { onMount } from "svelte";
  import type { Dashboard } from "../../../shared/api.ts";
  import { api, ApiError, errorText } from "#lib/api.ts";
  import { session } from "#lib/session.svelte.ts";
  import Chart from "#lib/Chart.svelte";
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
    source.addEventListener("end", () => source.close());
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
    <section class="hero" aria-live="polite">
      <p class="label">Promilleja arviolta</p>
      <p class="value">{permille(dash.permille)}<span class="unit">‰</span></p>
      <p class="muted">
        {#if dash.soberAt}Selvä {dayClock(dash.soberAt, dash.now)}{:else}Ei alkoholia veressä{/if}
      </p>
    </section>

    <a class="btn primary add" href="/log">Lisää juoma</a>

    <section class="card chartcard" aria-label="Promillekuvaaja">
      {#if dash.chart.lines.length}
        <Chart data={dash.chart} />
      {:else}
        <p class="muted">Ei juomia viimeisen vuorokauden ajalta. Kuvaaja ilmestyy, kun lisäät juoman.</p>
      {/if}
    </section>

    <section class="card">
      <h2>Tämä ilta</h2>
      {#if dash.session.drinks.length}
        <p class="muted stats">
          {decimal1(dash.session.standardDrinks)} annosta ·
          {dash.session.kcal} kcal{dash.session.unknownKcal ? ` (+ ${dash.session.unknownKcal} ilman tietoa)` : ""}
        </p>
        <ul class="drinks">
          {#each [...dash.session.drinks].reverse() as d (d.id)}
            <li>
              <span class="time">{clock(d.createdAt)}</span>
              <span class="desc">{d.description}</span>
              <span class="muted">{decimal1(d.standardDrinks)} ann.</span>
              <button class="btn small" disabled={busy} onclick={() => remove(d.id)} aria-label="Poista {d.description}">Poista</button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted">Ei juomia tänä iltana.</p>
      {/if}
    </section>
  {:else if !error}
    <p class="muted">Ladataan…</p>
  {/if}
</main>

<style>
  .hero {
    text-align: center;
    padding: 1rem 0 0.5rem;
  }
  .label {
    margin: 0;
    color: var(--text-secondary);
  }
  .value {
    margin: 0;
    font-size: clamp(3.2rem, 14vw, 5rem);
    font-weight: 700;
    line-height: 1.1;
  }
  .unit {
    font-size: 0.45em;
    margin-left: 0.15em;
    color: var(--text-secondary);
  }
  .hero .muted {
    margin: 0;
  }
  .add {
    display: block;
    text-align: center;
    text-decoration: none;
    margin: 0.75rem 0 1rem;
    line-height: 1.8;
  }
  .chartcard {
    margin-bottom: 1rem;
  }
  h2 {
    font-size: 1.1rem;
  }
  .stats {
    margin: 0.25rem 0 0.5rem;
  }
  .drinks {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .drinks li {
    display: grid;
    grid-template-columns: 3.2rem 1fr auto auto;
    gap: 0.6rem;
    align-items: center;
    padding: 0.4rem 0;
    border-top: 1px solid var(--border);
  }
  .time {
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .small {
    padding: 0.2rem 0.6rem;
    min-height: 36px;
    font-size: 0.85rem;
  }
</style>
