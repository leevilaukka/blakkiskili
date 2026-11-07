<script lang="ts">
  import { onMount } from "svelte";
  import type { Config, LogDrinkRequest, ProductItem } from "../../../../shared/api.ts";
  import { api, errorText } from "#lib/api.ts";
  import { decimal1 } from "#lib/format.ts";

  let config = $state<Config | null>(null);
  let products = $state<ProductItem[]>([]);
  let query = $state("");
  let message = $state("");
  let error = $state("");
  let busy = $state(false);
  let cl = $state("");
  let percent = $state("");
  let timer: ReturnType<typeof setTimeout> | undefined;

  const categories = [
    { id: "miedot", title: "Oluet ja siiderit" },
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
  <h1>Lisää juoma</h1>

  <div class="status" aria-live="polite">
    {#if message}<p class="ok">{message} · <a href="/">Näytä etusivu</a></p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>

  <div class="row">
    <button class="btn" disabled={busy} onclick={() => log({ kind: "repeat" })}>Toista viimeisin</button>
    <button class="btn" disabled={busy} onclick={undo}>Kumoa viimeisin</button>
  </div>

  {#if config?.catalogue}
    <section class="card">
      <h2>Hae Alkon tuotteista</h2>
      <label class="sr-only" for="q">Hae juomaa</label>
      <input id="q" type="search" placeholder="Esim. karhu, jaloviina, prosecco" bind:value={query} oninput={onInput} autocomplete="off" />
      {#if products.length}
        <ul class="products">
          {#each products as p (p.id)}
            <li>
              <p class="pname"><span aria-hidden="true">{p.emoji}</span> {p.name} <span class="muted">{p.abv.toString().replace(".", ",")} %</span></p>
              <div class="servings">
                {#each p.servings as s (s.key)}
                  <button class="btn" disabled={busy} onclick={() => log({ kind: "product", productId: p.id, serving: s.key })}>
                    {s.label} <span class="muted">· {decimal1(s.standardDrinks)} ann.</span>
                  </button>
                {/each}
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
      <section class="card">
        <h2>{cat.title}</h2>
        <div class="servings">
          {#each config.presets.filter((p) => p.category === cat.id) as p (p.id)}
            <button class="btn" disabled={busy} onclick={() => log({ kind: "preset", id: p.id })}>
              {p.name} <span class="muted">· {decimal1(p.standardDrinks)} ann.</span>
            </button>
          {/each}
        </div>
      </section>
    {/each}
  {/if}

  <section class="card">
    <h2>Oma juoma</h2>
    <form onsubmit={custom}>
      <div class="fields">
        <label>Määrä (cl)<input type="text" inputmode="decimal" bind:value={cl} placeholder="33" required /></label>
        <label>Prosentti (%)<input type="text" inputmode="decimal" bind:value={percent} placeholder="5,1" required /></label>
      </div>
      <button class="btn primary" disabled={busy} type="submit">Lisää</button>
    </form>
  </section>
</main>

<style>
  h1 {
    font-size: 1.4rem;
    margin-bottom: 0.5rem;
  }
  h2 {
    font-size: 1.05rem;
    margin-bottom: 0.6rem;
  }
  .status {
    min-height: 2.5rem;
  }
  .status p {
    margin: 0.25rem 0;
  }
  .ok {
    color: var(--text-primary);
  }
  .row,
  .servings {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .card {
    margin-top: 1rem;
  }
  .products {
    list-style: none;
    margin: 0.75rem 0 0;
    padding: 0;
  }
  .products li {
    padding: 0.6rem 0;
    border-top: 1px solid var(--border);
  }
  .pname {
    margin: 0 0 0.4rem;
  }
  .fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }
  label {
    display: grid;
    gap: 0.25rem;
    font-size: 0.9rem;
    color: var(--text-secondary);
  }
</style>
