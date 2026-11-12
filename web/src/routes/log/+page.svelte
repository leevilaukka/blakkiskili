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
<div class="col">
  <div class="head">
    <h1>Lisää juoma</h1>
    <p class="lead">Hae Alkon valikoimasta nimellä tai viivakoodilla, valitse valmis juoma tai kirjoita oma. Juoma merkitään valitsemaasi aikaan, oletuksena tähän hetkeen.</p>
  </div>

  <div class="toolbar">
    <label class="field when">Milloin
      <select bind:value={when} onchange={startCustom}>
        {#each AGO as a (a.minutes)}<option value={String(a.minutes)}>{a.label}</option>{/each}
        <option value="custom">Valitse aika…</option>
      </select>
    </label>
    {#if when === "custom"}
      <div class="field when">
        <span>Päivä ja aika</span>
        <div class="dt">
          <TextField kind="date" bind:value={customDay} min={weekAgo} max={today} label="Päivä (pp.kk.vvvv)" />
          <TextField kind="time" bind:value={customClock} label="Kellonaika (tt.mm)" />
        </div>
      </div>
    {/if}
    <button class="btn repeat" disabled={busy || last === null} onclick={() => log({ kind: "repeat" })} title={last ? `Toista: ${last.description}` : undefined}>
      <Icon name="repeat" /> <span class="label">{last ? `Toista: ${last.description}` : "Toista viimeisin"}</span>
    </button>
    <button class="btn" disabled={busy} onclick={undo}><Icon name="undo" /> Kumoa viimeisin</button>
  </div>

  <div class="status" aria-live="polite">
    {#if message}<p class="notice"><Icon name="check" /> <span>{message} · <a href="/">Näytä etusivu</a></span></p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>

  <section class="card panel favorites">
    <h2>Suosikit</h2>
    {#if favorites.length}
      <ul>
        {#each favorites as f (f.id)}
          <li>
            <button class="btn preset fav" disabled={busy} onclick={() => log({ kind: "favorite", id: f.id })} title={f.description}>
              <span class="name">{f.description}</span> <span class="muted">{decimal1(f.standardDrinks)} ann.</span>
            </button>
            <button class="btn ghost small icon" disabled={busy} onclick={() => unpin(f)} aria-label="Poista suosikeista: {f.description}" title="Poista suosikeista">
              <Icon name="x" />
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted">Pikavalintoja: yksi napautus kirjaa saman juoman uudestaan (enintään {maxFavorites}). Lisää suosikki alta tai päiväkirjasta.</p>
    {/if}
    <button class="btn small" disabled={busy || !last || favorites.length >= maxFavorites} onclick={pinLast}>
      <Icon name="star" /> {last ? `Lisää suosikiksi: ${last.description}` : "Lisää viimeisin suosikiksi"}
    </button>
  </section>

  {#if config}
    {#each categories as cat}
      <section class="card panel">
        <h2>{cat.title}</h2>
        <div class="presets">
          {#each config.presets.filter((p) => p.category === cat.id) as p (p.id)}
            <button class="btn preset" disabled={busy} onclick={() => log({ kind: "preset", id: p.id })}>
              <span>{p.name}</span> <span class="muted">{decimal1(p.standardDrinks)} ann.</span>
            </button>
          {/each}
        </div>
      </section>
    {/each}
  {/if}

  {#if config?.catalogue}
    <section class="card panel">
      <h2>Hae Alkon tuotteista</h2>
      <div class="search">
        <Icon name="search" />
        <label class="sr-only" for="q">Hae juomaa</label>
        <input id="q" type="search" placeholder="Esim. karhu, jaloviina, prosecco" bind:value={query} oninput={onInput} autocomplete="off" />
      </div>
      {#if products.length}
        <ul class="products">
          {#each products as p (p.id)}
            <li><ProductCard product={p} {busy} onLog={(serving) => log({ kind: "product", productId: p.id, serving })} /></li>
          {/each}
        </ul>
      {:else if query.trim()}
        <p class="muted">Ei tuloksia.</p>
      {/if}
    </section>
  {/if}

  {#if config?.barcodes}
    <section class="card panel">
      <h2>Viivakoodi</h2>
      <BarcodePanel {busy} {log} />
    </section>
  {/if}

  <section class="card panel">
    <h2>Oma juoma</h2>
    <form onsubmit={custom}>
      <label class="field">Määrä (cl)<input type="text" inputmode="decimal" bind:value={cl} placeholder="33" required /></label>
      <label class="field">Alkoholia (%)<input type="text" inputmode="decimal" bind:value={percent} placeholder="5,1" required /></label>
      <button class="btn primary" disabled={busy} type="submit"><Icon name="plus" /> Lisää</button>
    </form>
  </section>
</div>
</main>

<style>
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: end;
  }
  .toolbar .when {
    width: 12.5rem;
  }
  .toolbar .dt {
    display: grid;
    grid-template-columns: 1fr 5.5rem;
    gap: 0.4rem;
  }
  .toolbar div.when {
    width: 17rem;
  }
  .favorites ul {
    list-style: none;
    margin: 0 0 0.75rem;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 19rem), 1fr));
    gap: 0.5rem;
  }
  .favorites li {
    display: flex;
    gap: 0.25rem;
    align-items: stretch;
  }
  .favorites li .preset {
    flex: 1;
    min-width: 0;
  }
  /* One line: a long name is cut short (the title has it in full). */
  .fav {
    white-space: nowrap;
  }
  .fav .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* A long drink name is cut short rather than widening the page (the title has it in full). */
  .repeat {
    min-width: 0;
    max-width: 100%;
  }
  .repeat .label {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Takes room only while it has a message; the cards follow at the usual distance. */
  .status p {
    margin: 0.75rem 0 0;
  }
  .toolbar + .status + .card {
    margin-top: 1rem;
  }
  .card + .card {
    margin-top: 1rem;
  }
  .search {
    position: relative;
    display: flex;
    align-items: center;
  }
  .search > :global(.icon) {
    position: absolute;
    left: 0.7rem;
    color: var(--text-muted);
    pointer-events: none;
  }
  .search input {
    padding-left: 2.2rem;
  }
  .products {
    list-style: none;
    margin: 0.75rem 0 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface-1);
  }
  .products li {
    padding: 0.75rem 0.9rem;
    border-top: 1px solid var(--border-soft);
  }
  .products li:first-child {
    border-top: 0;
  }
  .presets {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(10.5rem, 1fr));
    gap: 0.5rem;
  }
  .preset {
    justify-content: space-between;
    white-space: normal;
    text-align: left;
  }
  .preset .muted {
    white-space: nowrap;
    font-size: 0.93rem;
  }
  form {
    display: grid;
    grid-template-columns: 1fr 1fr auto;
    gap: 0.75rem;
    align-items: end;
  }
  @media (max-width: 30rem) {
    form {
      grid-template-columns: 1fr 1fr;
    }
    form .btn {
      grid-column: 1 / -1;
    }
  }
</style>
