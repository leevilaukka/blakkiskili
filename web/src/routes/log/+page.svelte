<script lang="ts">
  import { onMount } from "svelte";
  import type { Config, DrinkItem, LogDrinkRequest, ProductItem } from "../../../../shared/api.ts";
  import { api, errorText } from "#lib/api.ts";
  import { decimal1 } from "#lib/format.ts";
  import BarcodePanel from "#lib/BarcodePanel.svelte";
  import Icon from "#lib/Icon.svelte";
  import ProductCard from "#lib/ProductCard.svelte";

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
    busy = true;
    error = "";
    try {
      const added = await api.log(drink);
      message = `Lisätty: ${added.description}`;
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
    <p class="lead">Hae Alkon valikoimasta nimellä tai viivakoodilla, valitse valmis juoma tai kirjoita oma. Juoma merkitään tähän hetkeen.</p>
  </div>

  <div class="actions">
    <button class="btn repeat" disabled={busy || last === null} onclick={() => log({ kind: "repeat" })} title={last ? `Toista: ${last.description}` : undefined}>
      <Icon name="repeat" /> <span class="label">{last ? `Toista: ${last.description}` : "Toista viimeisin"}</span>
    </button>
    <button class="btn" disabled={busy} onclick={undo}><Icon name="undo" /> Kumoa viimeisin</button>
  </div>

  <div class="status" aria-live="polite">
    {#if message}<p class="notice"><Icon name="check" /> <span>{message} · <a href="/">Näytä etusivu</a></span></p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>

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
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
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
  .status {
    min-height: 1rem;
    margin: 0.75rem 0;
  }
  .status p {
    margin: 0;
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
