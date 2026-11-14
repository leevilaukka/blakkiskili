<script lang="ts">
  import { onMount } from "svelte";
  import type { Config, DrinkItem, FavoriteItem, Favorites, LogDrinkRequest, ProductItem } from "../../../../shared/api.ts";
  import { api, errorText } from "#lib/api.ts";
  import { decimal1 } from "#lib/format.ts";
  import BarcodePanel from "#lib/BarcodePanel.svelte";
  import { dayAndTime } from "#lib/fidate.ts";
  import Icon from "#lib/Icon.svelte";
  import ProductCard from "#lib/ProductCard.svelte";
  import TextField from "#lib/TextField.svelte";

  let config = $state<Config | null>(null);
  let products = $state<ProductItem[]>([]);
  let query = $state("");
  let message = $state("");
  let error = $state("");
  let busy = $state(false);
  /** What "Toista" logs again; null when there is nothing, undefined until known. */
  let last = $state<DrinkItem | null | undefined>(undefined);
  let cl = $state("");
  let percent = $state("");
  let timer: ReturnType<typeof setTimeout> | undefined;

  // When the drink was had: now, some time ago, or a chosen moment (for forgotten drinks).
  let when = $state("0");
  const AGO = [
    { minutes: 0, label: "Nyt" },
    { minutes: 30, label: "30 min sitten" },
    { minutes: 60, label: "1 h sitten" },
    { minutes: 120, label: "2 h sitten" },
    { minutes: 180, label: "3 h sitten" },
    { minutes: 360, label: "6 h sitten" },
    { minutes: 720, label: "12 h sitten" },
    { minutes: 1440, label: "Eilen tähän aikaan" },
  ];
  const WEEK_MS = 7 * 24 * 3_600_000;
  let customDay = $state("");
  let customClock = $state("");
  const today = $derived(dayAndTime(Date.now()).day);
  const weekAgo = $derived(dayAndTime(Date.now() - WEEK_MS).day);

  /** Choosing "Valitse aika…" starts from the present. */
  function startCustom() {
    if (when !== "custom" || customDay) return;
    ({ day: customDay, time: customClock } = dayAndTime(Date.now()));
  }

  /** The time to log at, undefined for now; null if the chosen time is no good. */
  function chosenTime(): number | undefined | null {
    if (when === "custom") {
      const t = customDay && customClock ? new Date(`${customDay}T${customClock}`).getTime() : NaN;
      return Number.isNaN(t) || t > Date.now() + 60_000 || t < Date.now() - WEEK_MS ? null : t;
    }
    const minutes = Number(when);
    return minutes > 0 ? Date.now() - minutes * 60_000 : undefined;
  }

  let favorites = $state<FavoriteItem[]>([]);
  let maxFavorites = $state(8);
  const takeFavorites = (f: Favorites) => {
    favorites = f.favorites;
    maxFavorites = f.max;
  };

  const categories = [
    { id: "miedot", title: "Miedot" },
    { id: "viinit", title: "Viinit" },
    { id: "shotit", title: "Shotit" },
  ] as const;

  async function search() {
    try {
      products = (await api.products(query.trim())).products;
    } catch (e) {
      error = errorText(e);
    }
  }

  async function loadLast() {
    try {
      last = (await api.lastDrink()).drink;
    } catch {
      last = undefined; // the button still works; it just doesn't say what
    }
  }

  onMount(async () => {
    void loadLast();
    void api.favorites().then(takeFavorites, () => {});
    try {
      config = await api.config();
      if (config.catalogue) await search();
    } catch (e) {
      error = errorText(e);
    }
  });

  function onInput() {
    clearTimeout(timer);
    timer = setTimeout(search, 250);
  }

  async function log(drink: LogDrinkRequest) {
    const at = chosenTime();
    if (at === null) {
      error = "Valitse aika, joka on enintään viikon takaa eikä tulevaisuudessa.";
      message = "";
      return;
    }
    busy = true;
    error = "";
    try {
      const added = await api.log(at === undefined ? drink : { ...drink, at });
      message = `Lisätty: ${added.description}${at === undefined ? "" : ` (${new Date(at).toLocaleString("fi-FI", { weekday: "short", hour: "2-digit", minute: "2-digit" })})`}`;
      last = added;
      if (config?.catalogue && drink.kind === "product") await search(); // recents move to the top
    } catch (e) {
      error = errorText(e);
      message = "";
    } finally {
      busy = false;
    }
  }

  async function undo() {
    busy = true;
    error = "";
    try {
      const undone = await api.undo();
      message = `Peruttu: ${undone.description}`;
      await loadLast();
    } catch (e) {
      error = errorText(e);
      message = "";
    } finally {
      busy = false;
    }
  }

  async function pinLast() {
    if (!last) return;
    busy = true;
    error = "";
    try {
      const r = await api.pinFavorite(last.id);
      takeFavorites(r);
      message =
        r.result === "added" ? `Lisätty suosikkeihin: ${last.description}` : r.result === "exists" ? "Tämä on jo suosikeissa." : `Suosikkeja voi olla enintään ${r.max}. Poista ensin joku.`;
    } catch (e) {
      error = errorText(e);
      message = "";
    } finally {
      busy = false;
    }
  }

  async function unpin(f: FavoriteItem) {
    busy = true;
    error = "";
    try {
      takeFavorites(await api.unpinFavorite(f.id));
      message = `Poistettu suosikeista: ${f.description}`;
    } catch (e) {
      error = errorText(e);
      message = "";
    } finally {
      busy = false;
    }
  }

  function custom(e: SubmitEvent) {
    e.preventDefault();
    const c = Number(cl.replace(",", "."));
    const p = Number(percent.replace(",", "."));
    if (!(c > 0) || !(p > 0)) {
      error = "Tarkista määrä ja prosentti.";
      return;
    }
    log({ kind: "custom", cl: c, percent: p });
  }
</script>

<svelte:head><title>Juo · Bläkkiskili</title></svelte:head>

<main class="page">
<div class="mx-auto max-w-[46rem]">
  <div class="mb-5">
    <h1>Lisää juoma</h1>
    <p class="mt-1.5 mb-0 text-lg text-secondary">Hae Alkon valikoimasta nimellä tai viivakoodilla, valitse valmis juoma tai kirjoita oma. Juoma merkitään valitsemaasi aikaan, oletuksena tähän hetkeen.</p>
  </div>

  <div class="flex flex-wrap items-end gap-2">
    <label class="grid w-[12.5rem] gap-1.25">Milloin
      <select bind:value={when} onchange={startCustom}>
        {#each AGO as a (a.minutes)}<option value={String(a.minutes)}>{a.label}</option>{/each}
        <option value="custom">Valitse aika…</option>
      </select>
    </label>
    {#if when === "custom"}
      <div class="grid w-[17rem] gap-1.25">
        <span>Päivä ja aika</span>
        <div class="grid grid-cols-[1fr_5.5rem] gap-1.5">
          <TextField kind="date" bind:value={customDay} min={weekAgo} max={today} label="Päivä (pp.kk.vvvv)" />
          <TextField kind="time" bind:value={customClock} label="Kellonaika (tt.mm)" />
        </div>
      </div>
    {/if}
    <!-- A long drink name is cut short rather than widening the page (the title has it in full). -->
    <button class="btn max-w-full min-w-0" disabled={busy || last === null} onclick={() => log({ kind: "repeat" })} title={last ? `Toista: ${last.description}` : undefined}>
      <Icon name="repeat" /> <span class="truncate">{last ? `Toista: ${last.description}` : "Toista viimeisin"}</span>
    </button>
    <button class="btn" disabled={busy} onclick={undo}><Icon name="undo" /> Kumoa viimeisin</button>
  </div>

  <!-- Takes room only while it has a message; the cards follow at the usual distance. -->
  <div aria-live="polite">
    {#if message}<p class="notice mt-3"><Icon name="check" /> <span>{message} · <a href="/">Näytä etusivu</a></span></p>{/if}
    {#if error}<p class="mt-3 mb-0 text-danger" role="alert">{error}</p>{/if}
  </div>

  <section class="card card-panel mt-4">
    <h2>Suosikit</h2>
    {#if favorites.length}
      <ul class="mb-3 grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-2">
        {#each favorites as f (f.id)}
          <li class="flex items-stretch gap-1">
            <!-- One line: a long name is cut short (the title has it in full). -->
            <button class="btn min-w-0 flex-1 justify-between text-left" disabled={busy} onclick={() => log({ kind: "favorite", id: f.id })} title={f.description}>
              <span class="truncate">{f.description}</span> <span class="text-sm whitespace-nowrap text-secondary">{decimal1(f.standardDrinks)} ann.</span>
            </button>
            <button class="btn btn-ghost btn-sm btn-icon" disabled={busy} onclick={() => unpin(f)} aria-label="Poista suosikeista: {f.description}" title="Poista suosikeista">
              <Icon name="x" />
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="text-secondary">Pikavalintoja: yksi napautus kirjaa saman juoman uudestaan (enintään {maxFavorites}). Lisää suosikki alta tai päiväkirjasta.</p>
    {/if}
    <button class="btn btn-sm" disabled={busy || !last || favorites.length >= maxFavorites} onclick={pinLast}>
      <Icon name="star" /> {last ? `Lisää suosikiksi: ${last.description}` : "Lisää viimeisin suosikiksi"}
    </button>
  </section>

  {#if config}
    {#each categories as cat}
      <section class="card card-panel mt-4">
        <h2>{cat.title}</h2>
        <div class="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-2">
          {#each config.presets.filter((p) => p.category === cat.id) as p (p.id)}
            <button class="btn justify-between text-left whitespace-normal" disabled={busy} onclick={() => log({ kind: "preset", id: p.id })}>
              <span>{p.name}</span> <span class="text-sm whitespace-nowrap text-secondary">{decimal1(p.standardDrinks)} ann.</span>
            </button>
          {/each}
        </div>
      </section>
    {/each}
  {/if}

  {#if config?.catalogue}
    <section class="card card-panel mt-4">
      <h2>Hae Alkon tuotteista</h2>
      <div class="relative flex items-center">
        <Icon name="search" class="pointer-events-none absolute left-2.75 text-muted" />
        <label class="sr-only" for="q">Hae juomaa</label>
        <input id="q" class="pl-8.75" type="search" placeholder="Esim. karhu, jaloviina, prosecco" bind:value={query} oninput={onInput} autocomplete="off" />
      </div>
      {#if products.length}
        <ul class="mt-3 rounded-sm border border-line bg-surface-1">
          {#each products as p (p.id)}
            <li class="border-t border-line-soft px-3.5 py-3 first:border-t-0">
              <ProductCard product={p} {busy} onLog={(serving) => log({ kind: "product", productId: p.id, serving })} />
            </li>
          {/each}
        </ul>
      {:else if query.trim()}
        <p class="text-secondary">Ei tuloksia.</p>
      {/if}
    </section>
  {/if}

  {#if config?.barcodes}
    <section class="card card-panel mt-4">
      <h2>Viivakoodi</h2>
      <BarcodePanel {busy} {log} />
    </section>
  {/if}

  <section class="card card-panel mt-4">
    <h2>Oma juoma</h2>
    <form class="grid grid-cols-[1fr_1fr_auto] items-end gap-3 max-[30rem]:grid-cols-2" onsubmit={custom}>
      <label class="grid gap-1.25">Määrä (cl)<input type="text" inputmode="decimal" bind:value={cl} placeholder="33" required /></label>
      <label class="grid gap-1.25">Alkoholia (%)<input type="text" inputmode="decimal" bind:value={percent} placeholder="5,1" required /></label>
      <button class="btn btn-primary max-[30rem]:col-span-full" disabled={busy} type="submit"><Icon name="plus" /> Lisää</button>
    </form>
  </section>
</div>
</main>
