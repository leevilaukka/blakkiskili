<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ProductItem } from "../../../shared/api.ts";
  import { decimal1 } from "#lib/format.ts";

  let {
    product: p,
    busy,
    onLog,
    children,
  }: { product: ProductItem; busy: boolean; onLog: (serving: string) => void; children?: Snippet } = $props();

  /** The photo failed (none at Alko, or offline): the emoji stays. */
  let noPhoto = $state(false);
</script>

<div class="product">
  <!-- Through our server, so the browser never contacts Alko (src/web/photos.ts) -->
  <div class="thumb" aria-hidden="true">
    <span class="emoji">{p.emoji}</span>
    {#if p.photo && !noPhoto}
      <img src="/api/products/{encodeURIComponent(p.id)}/photo" alt="" loading="lazy" decoding="async" width="160" height="192" onerror={() => (noPhoto = true)} />
    {/if}
  </div>
  <div class="info">
    <p class="pname">
      <span class="title">{p.name}</span>
      <span class="abv">{p.abv.toString().replace(".", ",")} %</span>
    </p>
    {#if p.maker}<p class="maker">{p.maker}</p>{/if}
    {@render children?.()}
    <div class="servings">
      {#each p.servings as s (s.key)}
        <button class="btn small" disabled={busy} onclick={() => onLog(s.key)}>
          {s.label} <span class="muted">{decimal1(s.standardDrinks)} ann.</span>
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .product {
    display: flex;
    gap: 0.9rem;
  }
  /* Alko's photos are white-backed bottles; the box stays white in dark mode too, like Alkometriikka's */
  /* Fills the card's height (stretch); the photo is inset so the bottle doesn't touch the edges */
  .thumb {
    position: relative;
    flex: none;
    align-self: stretch;
    display: grid;
    place-items: center;
    width: 4rem;
    min-height: 4.5rem;
    border-radius: 4px;
    background: #fff;
    overflow: hidden;
  }
  .thumb .emoji {
    font-size: 1.6rem;
  }
  .thumb img {
    position: absolute;
    inset: 0.4rem;
    width: calc(100% - 0.8rem);
    height: calc(100% - 0.8rem);
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
</style>
