<script lang="ts">
  import { onMount } from "svelte";
  import type { Config, LogDrinkRequest, ProductItem } from "../../../../shared/api.ts";
  import { api, errorText } from "#lib/api.ts";
  import { decimal1 } from "#lib/format.ts";
  import Icon from "#lib/Icon.svelte";

  let config = $state<Config | null>(null);
  let products = $state<ProductItem[]>([]);
  let query = $state("");
  let message = $state("");
  let error = $state("");
  let busy = $state(false);
  let cl = $state("");
  let percent = $state("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Products whose photo failed (none at Alko, or offline): they keep the emoji. */
  let noPhoto = $state<Record<string, true>>({});

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

  onMount(async () => {
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
    <p class="lead">Hae Alkon valikoimasta, valitse valmis juoma tai kirjoita oma. Juoma merkitään tähän hetkeen.</p>
  </div>

  <div class="actions">
    <button class="btn" disabled={busy} onclick={() => log({ kind: "repeat" })}><Icon name="repeat" /> Toista viimeisin</button>
    <button class="btn" disabled={busy} onclick={undo}><Icon name="undo" /> Kumoa viimeisin</button>
  </div>

  <div class="status" aria-live="polite">
    {#if message}<p class="notice"><Icon name="check" /> <span>{message} · <a href="/">Näytä etusivu</a></span></p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>

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
            <li>
              <!-- Through our server, so the browser never contacts Alko (src/web/photos.ts) -->
              <div class="thumb" aria-hidden="true">
                <span class="emoji">{p.emoji}</span>
                {#if !noPhoto[p.id]}
                  <img src="/api/products/{encodeURIComponent(p.id)}/photo" alt="" loading="lazy" decoding="async" width="160" height="192" onerror={() => (noPhoto[p.id] = true)} />
                {/if}
              </div>
              <div class="info">
              <p class="pname">
                <span class="title">{p.name}</span>
                <span class="abv">{p.abv.toString().replace(".", ",")} %</span>
              </p>
              {#if p.maker}<p class="maker">{p.maker}</p>{/if}
              <div class="servings">
                {#each p.servings as s (s.key)}
                  <button class="btn small" disabled={busy} onclick={() => log({ kind: "product", productId: p.id, serving: s.key })}>
                    {s.label} <span class="muted">{decimal1(s.standardDrinks)} ann.</span>
                  </button>
                {/each}
              </div>
              </div>
            </li>
          {/each}
        </ul>
      {:else if query.trim()}
        <p class="muted">Ei tuloksia.</p>
      {/if}
    </section>
  {/if}

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
    display: flex;
    gap: 0.9rem;
    padding: 0.75rem 0.9rem;
    border-top: 1px solid var(--border-soft);
  }
  /* Alko's photos are white-backed bottles; the box stays white in dark mode too, like Alkometriikka's */
  .thumb {
    position: relative;
    flex: none;
    display: grid;
    place-items: center;
    width: 3.5rem;
    height: 4.2rem;
    border-radius: 4px;
    background: #fff;
    overflow: hidden;
  }
  .thumb .emoji {
    font-size: 1.6rem;
  }
  .thumb img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #fff;
  }
  .info {
    flex: 1;
    min-width: 0;
  }
  .maker {
    margin: -0.35rem 0 0.5rem;
    color: var(--text-secondary);
    font-size: 0.93rem;
  }
  .products li:first-child {
    border-top: 0;
  }
  .pname {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    margin: 0 0 0.5rem;
  }
  .title {
    font-weight: 700;
  }
  .abv {
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .servings {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
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
