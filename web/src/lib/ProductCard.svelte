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

<div class="flex gap-3.5">
  <!-- Through our server, so the browser never contacts Alko (src/web/photos.ts) -->
  <!-- Alko's photos are white-backed bottles; the box stays white in dark mode too, like Alkometriikka's.
       It fills the card's height; the photo is inset so the bottle doesn't touch the edges. -->
  <div class="relative grid min-h-[4.5rem] w-16 flex-none place-items-center self-stretch overflow-hidden rounded-sm bg-white" aria-hidden="true">
    <span class="text-2xl">{p.emoji}</span>
    {#if p.photo && !noPhoto}
      <img
        class="absolute inset-1.5 h-[calc(100%-0.75rem)] w-[calc(100%-0.75rem)] bg-white object-contain"
        src="/api/products/{encodeURIComponent(p.id)}/photo"
        alt=""
        loading="lazy"
        decoding="async"
        width="160"
        height="192"
        onerror={() => (noPhoto = true)}
      />
    {/if}
  </div>
  <div class="min-w-0 flex-1">
    <p class="mt-0 mb-2 flex items-baseline gap-1.5">
      <span class="font-bold">{p.name}</span>
      <span class="whitespace-nowrap text-secondary">{p.abv.toString().replace(".", ",")} %</span>
    </p>
    {#if p.maker}<p class="-mt-1.5 mb-2 text-sm text-secondary">{p.maker}</p>{/if}
    {@render children?.()}
    <div class="flex flex-wrap gap-1.5">
      {#each p.servings as s (s.key)}
        <button class="btn btn-sm" disabled={busy} onclick={() => onLog(s.key)}>
          {s.label} <span class="text-secondary">{decimal1(s.standardDrinks)} ann.</span>
        </button>
      {/each}
    </div>
  </div>
</div>
