<script lang="ts">
  import { onMount } from "svelte";
  import type { Dashboard } from "../../../shared/api.ts";
  import { api, ApiError, errorText } from "#lib/api.ts";
  import { session } from "#lib/session.svelte.ts";
  import Chart from "#lib/Chart.svelte";
  import Icon from "#lib/Icon.svelte";
  import Stat from "#lib/Stat.svelte";
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
  {#if error}<p class="text-danger" role="alert">{error}</p>{/if}

  {#if dash}
    <div class="grid items-start gap-4 min-[62rem]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] min-[62rem]:gap-6">
      <div class="grid min-w-0 gap-4">
        <!-- Alkometriikka's highlight card: brand-4 with white text, the same in light and dark -->
        <section class="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 rounded-sm border border-brand-2 bg-brand-4 px-6 pt-5 pb-6 text-white" aria-live="polite">
          <div>
            <h1 class="m-0 text-lg font-medium tracking-normal text-white/80">Promilleja arviolta</h1>
            <p class="mt-0.5 mb-0 text-[clamp(3.6rem,16vw,5.5rem)] leading-none font-bold tracking-tighter tabular-nums">
              {permille(dash.permille)}<span class="ml-[0.12em] text-[0.42em] tracking-normal text-white/80">‰</span>
            </p>
            <p class="mt-2 mb-0 text-lg text-white/85">
              {#if dash.soberAt}Selvä {dayClock(dash.soberAt, dash.now)}{:else}Ei alkoholia veressä{/if}
            </p>
          </div>
          <a class="btn border-white bg-white px-4.5 py-2.5 text-lg font-bold text-brand-4 hover:bg-[#f3f4f6] max-[30rem]:flex-[1_1_100%]" href="/log"
            ><Icon name="plus" /> Lisää juoma</a
          >
        </section>

        <section class="card" aria-label="Promillekuvaaja">
          {#if dash.chart.lines.length}
            <Chart data={dash.chart} />
          {:else}
            <p class="text-secondary">Ei juomia viimeisen vuorokauden ajalta. Kuvaaja ilmestyy, kun lisäät juoman.</p>
          {/if}
        </section>
      </div>

      <section class="grid min-w-0 gap-2.5" aria-labelledby="tonight">
        <h2 id="tonight">Tämä ilta</h2>
        <div class="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-2.5">
          <Stat label="Annoksia" value={decimal1(dash.session.standardDrinks)} />
          <Stat label="Energia" value={dash.session.kcal} unit="kcal" sub={dash.session.unknownKcal ? `+ ${dash.session.unknownKcal} ilman tietoa` : undefined} />
        </div>

        <div class="card px-4 py-1">
          {#if dash.session.drinks.length}
            <ul>
              {#each [...dash.session.drinks].reverse() as d (d.id)}
                <li class="grid grid-cols-[3rem_1fr_auto_auto] items-center gap-2.5 border-t border-line-soft py-1.5 first:border-t-0">
                  <span class="whitespace-nowrap text-secondary tabular-nums">{clock(d.createdAt)}</span>
                  <span class="wrap-anywhere">{d.description}</span>
                  <span class="whitespace-nowrap text-secondary tabular-nums">{decimal1(d.standardDrinks)} ann.</span>
                  <button class="btn btn-ghost btn-sm btn-icon" disabled={busy} onclick={() => remove(d.id)} aria-label="Poista {d.description}" title="Poista">
                    <Icon name="trash" />
                  </button>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="my-3 text-secondary">Ei juomia tänä iltana.</p>
          {/if}
        </div>
        <a class="inline-flex items-center gap-0.75 justify-self-end" href="/logbook">Kaikki juomat päiväkirjassa <Icon name="chevron-right" /></a>
      </section>
    </div>
  {:else if !error}
    <p class="text-secondary">Ladataan…</p>
  {/if}
</main>
