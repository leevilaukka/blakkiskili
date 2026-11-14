<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { ChartData, DrinkItem, DrinkLog } from "../../../../shared/api.ts";
  import { api, errorText } from "#lib/api.ts";
  import { clock, decimal1 } from "#lib/format.ts";
  import Chart from "#lib/Chart.svelte";
  import Icon from "#lib/Icon.svelte";
  import Stat from "#lib/Stat.svelte";
  import TextField from "#lib/TextField.svelte";

  // The filters live in the address (?range=&from=&to=&q=), so a view can be bookmarked and
  // survives a reload. Days are the browser's: the API takes plain timestamps.

  const RANGES = [
    { id: "7", label: "7 päivää" },
    { id: "30", label: "30 päivää" },
    { id: "365", label: "Vuosi" },
    { id: "all", label: "Kaikki" },
    { id: "custom", label: "Oma väli" },
  ] as const;
  type Range = (typeof RANGES)[number]["id"];
  const DEFAULT_RANGE: Range = "30";
  /** A pause this long starts a new session, as on the front page (SESSION_GAP_MS). */
  const SESSION_GAP_MS = 6 * 3_600_000;

  const pad = (n: number) => String(n).padStart(2, "0");
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const isoDay = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  function addDays(ms: number, days: number) {
    const d = new Date(ms);
    d.setDate(d.getDate() + days);
    return midnight(d);
  }
  function parseDay(s: string | null): number | undefined {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : undefined;
  }

  const params = $derived(page.url.searchParams);
  const range = $derived<Range>(RANGES.find((r) => r.id === params.get("range"))?.id ?? DEFAULT_RANGE);
  const fromDay = $derived(params.get("from") ?? "");
  const toDay = $derived(params.get("to") ?? "");
  const q = $derived((params.get("q") ?? "").trim());

  /** What to ask the API for; a string when the chosen dates don't make a range. */
  const filter = $derived.by((): { from?: number; to?: number; q?: string } | string => {
    const today = midnight(new Date());
    const base = { q: q || undefined };
    if (range === "all") return base;
    if (range !== "custom") return { ...base, from: addDays(today, 1 - Number(range)) };
    const from = parseDay(fromDay);
    const to = parseDay(toDay);
    if (from !== undefined && to !== undefined && from > to) return "Alkupäivä on loppupäivän jälkeen.";
    return { ...base, from, to: to === undefined ? undefined : addDays(to, 1) };
  });

  let search = $state(page.url.searchParams.get("q") ?? "");
  let drinks = $state<DrinkItem[]>([]);
  let totals = $state<DrinkLog["totals"] | null>(null);
  let next = $state<string | null>(null);
  let loading = $state(false);
  let loadingMore = $state(false);
  let busy = $state(false);
  let error = $state("");
  // Answers to an older filter are dropped when they come back late.
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function setParams(changes: Record<string, string | undefined>) {
    const url = new URL(page.url.href);
    for (const [k, v] of Object.entries(changes)) {
      if (v) url.searchParams.set(k, v);
      else url.searchParams.delete(k);
    }
    // No scrolling or focus reset: the search box keeps the cursor while typing.
    if (url.search !== page.url.search) goto(url, { replace: true, reset: false });
  }

  function chooseRange(id: Range) {
    if (id === "custom") {
      // Start from what was shown, so switching to "Oma väli" changes nothing until a date does.
      const shown = typeof filter === "string" ? undefined : filter.from;
      const today = midnight(new Date());
      setParams({ range: id, from: fromDay || isoDay(shown ?? addDays(today, -29)), to: toDay || isoDay(today) });
    } else {
      setParams({ range: id === DEFAULT_RANGE ? undefined : id, from: undefined, to: undefined });
    }
  }

  function onSearch() {
    clearTimeout(timer);
    timer = setTimeout(() => setParams({ q: search.trim() || undefined }), 300);
  }

  async function load(f: typeof filter) {
    const mine = ++generation;
    clearTimeout(timer);
    if (typeof f === "string") {
      error = f;
      drinks = [];
      totals = null;
      next = null;
      return;
    }
    loading = true;
    try {
      const log = await api.drinks(f);
      if (mine !== generation) return;
      drinks = log.drinks;
      totals = log.totals;
      next = log.next;
      error = "";
    } catch (e) {
      if (mine === generation) error = errorText(e);
    } finally {
      if (mine === generation) loading = false;
    }
  }

  $effect(() => {
    void load(filter);
  });

  async function more() {
    if (!next || typeof filter === "string") return;
    const mine = generation;
    loadingMore = true;
    try {
      const log = await api.drinks({ ...filter, before: next });
      if (mine !== generation) return;
      drinks = [...drinks, ...log.drinks];
      totals = log.totals;
      next = log.next;
    } catch (e) {
      if (mine === generation) error = errorText(e);
    } finally {
      loadingMore = false;
    }
  }

  let notice = $state("");

  async function pin(d: DrinkItem) {
    busy = true;
    error = "";
    try {
      const r = await api.pinFavorite(d.id);
      notice =
        r.result === "added" ? `Lisätty suosikkeihin: ${d.description}` : r.result === "exists" ? "Tämä on jo suosikeissa." : `Suosikkeja voi olla enintään ${r.max}. Poista ensin joku Juo-sivulla.`;
    } catch (e) {
      error = errorText(e);
      notice = "";
    } finally {
      busy = false;
    }
  }

  async function remove(d: DrinkItem) {
    if (!confirm(`Poistetaanko ${d.description} (${dateLabel(d.createdAt)} klo ${clock(d.createdAt)})?`)) return;
    busy = true;
    try {
      await api.remove(d.id);
      drinks = drinks.filter((x) => x.id !== d.id);
      // The totals cover more than the loaded pages; ask for them again.
      if (typeof filter !== "string") totals = (await api.drinks({ ...filter, limit: 1 })).totals;
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  interface Session {
    key: number;
    start: number;
    end: number;
    drinks: DrinkItem[]; // oldest first
    standardDrinks: number;
    kcal: number;
    unknownKcal: number;
  }

  // Newest session first, each one's drinks in the order they were drunk.
  const sessions = $derived.by(() => {
    const out: Session[] = [];
    let cur: Session | undefined;
    for (const d of drinks) {
      if (!cur || cur.start - d.createdAt > SESSION_GAP_MS) {
        cur = { key: d.id, start: d.createdAt, end: d.createdAt, drinks: [], standardDrinks: 0, kcal: 0, unknownKcal: 0 };
        out.push(cur);
      }
      cur.drinks.unshift(d);
      cur.start = d.createdAt;
      cur.standardDrinks += d.standardDrinks;
      if (d.kcal === null) cur.unknownKcal += 1;
      else cur.kcal += d.kcal;
    }
    return out;
  });

  // A session's curve is fetched when its "Promillekäyrä" is opened, and kept while the page lives.
  // `null` is a failed fetch (shown as a message); a drink added or removed elsewhere is not
  // reflected until the page is reloaded.
  let charts = $state<Record<number, ChartData | null | "loading">>({});
  async function openChart(s: Session, open: boolean) {
    if (!open || (charts[s.key] !== undefined && charts[s.key] !== null)) return;
    charts[s.key] = "loading";
    try {
      charts[s.key] = await api.sessionChart(s.start, s.end);
    } catch {
      charts[s.key] = null;
    }
  }

  function dateLabel(ms: number) {
    const d = new Date(ms);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString("fi-FI", { weekday: "short", day: "numeric", month: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
  }
  const count = (n: number) => (n === 1 ? "1 juoma" : `${n} juomaa`);
</script>

<svelte:head><title>Päiväkirja · Bläkkiskili</title></svelte:head>

<main class="page">
  <div class="mx-auto max-w-[46rem]">
    <div class="mb-5">
      <h1>Juomapäiväkirja</h1>
      <p class="mt-1.5 mb-0 text-lg text-secondary">Kaikki merkitsemäsi juomat illoittain. Rajaa ajan tai juoman nimen mukaan.</p>
    </div>

    <section class="card card-panel grid gap-3" aria-label="Rajaukset">
      <div class="flex flex-wrap gap-1.5" role="group" aria-label="Aikaväli">
        {#each RANGES as r (r.id)}
          <button
            class="btn btn-sm aria-pressed:border-brand-4 aria-pressed:bg-brand-4 aria-pressed:font-bold aria-pressed:text-white"
            aria-pressed={range === r.id}
            onclick={() => chooseRange(r.id)}>{r.label}</button
          >
        {/each}
      </div>
      {#if range === "custom"}
        <div class="grid grid-cols-2 gap-3">
          <label class="grid gap-1.25">Alkaen
            <TextField kind="date" value={fromDay} max={toDay || undefined} label="Alkaen (pp.kk.vvvv)" onchange={(v) => setParams({ from: v || undefined })} />
          </label>
          <label class="grid gap-1.25">Asti
            <TextField kind="date" value={toDay} min={fromDay || undefined} label="Asti (pp.kk.vvvv)" onchange={(v) => setParams({ to: v || undefined })} />
          </label>
        </div>
      {/if}
      <div class="relative flex items-center">
        <Icon name="search" class="pointer-events-none absolute left-2.75 text-muted" />
        <label class="sr-only" for="q">Hae juoman nimellä</label>
        <input id="q" class="pl-8.75" type="search" placeholder="Hae juoman nimellä, esim. karhu" bind:value={search} oninput={onSearch} autocomplete="off" maxlength="80" />
      </div>
    </section>

    {#if error}<p class="text-danger" role="alert">{error}</p>{/if}
    {#if notice}<p class="notice" role="status"><Icon name="check" /> <span>{notice}</span></p>{/if}

    {#if totals}
      <div class="my-4 grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-2.5" aria-live="polite">
        <Stat label="Juomia" value={totals.count} />
        <Stat label="Annoksia" value={decimal1(totals.standardDrinks)} sub={totals.sessions > 1 ? `${decimal1(totals.standardDrinks / totals.sessions)} / kerta` : undefined} />
        <Stat label="Juomakertoja" value={totals.sessions} />
        <Stat label="Energia" value={totals.kcal} unit="kcal" sub={totals.unknownKcal ? `+ ${totals.unknownKcal} ilman tietoa` : undefined} />
      </div>
    {/if}

    <div class={["grid gap-3 transition-opacity", loading && totals && "opacity-55"]}>
      {#each sessions as s (s.key)}
        <section class="card px-4 pt-3 pb-1" aria-labelledby="s{s.key}">
          <header class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pb-1.5">
            <h2 class="text-lg first-letter:uppercase" id="s{s.key}">
              {dateLabel(s.start)}
              <span class="ml-1.5 font-medium text-secondary tabular-nums">klo {clock(s.start)}{#if s.end !== s.start}–{clock(s.end)}{/if}</span>
            </h2>
            <span class="whitespace-nowrap text-secondary tabular-nums">
              {[count(s.drinks.length), `${decimal1(s.standardDrinks)} ann.`, s.kcal ? `${s.kcal} kcal` : ""].filter(Boolean).join(" · ")}
            </span>
          </header>
          <ul>
            {#each s.drinks as d (d.id)}
              <li class="grid grid-cols-[3rem_1fr_auto_auto_auto] items-center gap-2.5 border-t border-line-soft py-1.5">
                <span class="whitespace-nowrap text-secondary tabular-nums">{clock(d.createdAt)}</span>
                <span class="wrap-anywhere">{d.description}</span>
                <span class="whitespace-nowrap text-secondary tabular-nums">{decimal1(d.standardDrinks)} ann.</span>
                <button class="btn btn-ghost btn-sm btn-icon" disabled={busy} onclick={() => pin(d)} aria-label="Lisää suosikiksi: {d.description}" title="Lisää suosikiksi">
                  <Icon name="star" />
                </button>
                <button class="btn btn-ghost btn-sm btn-icon" disabled={busy} onclick={() => remove(d)} aria-label="Poista {d.description}" title="Poista">
                  <Icon name="trash" />
                </button>
              </li>
            {/each}
          </ul>
          <details class="border-t border-line-soft pt-2 pb-3" ontoggle={(e) => openChart(s, e.currentTarget.open)}>
            <summary class="cursor-pointer font-semibold">Promillekäyrä</summary>
            {#if charts[s.key] === "loading" || charts[s.key] === undefined}
              <p class="text-secondary">Ladataan…</p>
            {:else if charts[s.key] === null}
              <p class="text-danger">Käyrää ei voitu ladata.</p>
            {:else if (charts[s.key] as ChartData).lines.length}
              <p class="my-1.5 text-[0.9rem] text-secondary">Arvio nykyisillä paino- ja pituustiedoillasi.</p>
              <Chart data={charts[s.key] as ChartData} legend={false} />
            {:else}
              <p class="text-secondary">Arvio ei nouse tällä kerralla mitattavaksi.</p>
            {/if}
          </details>
        </section>
      {:else}
        {#if totals}
          <p class="my-2 text-secondary">
            {#if q}Ei juomia haulla ”{q}” tällä aikavälillä.{:else}Ei juomia tällä aikavälillä.{/if}
          </p>
        {:else if loading}
          <p class="text-secondary">Ladataan…</p>
        {/if}
      {/each}

      {#if next}
        <button class="btn justify-self-center" disabled={loadingMore} onclick={more}>{loadingMore ? "Ladataan…" : "Näytä vanhemmat"}</button>
      {/if}
    </div>
  </div>
</main>
