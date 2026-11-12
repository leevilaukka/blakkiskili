<script lang="ts">
  import { onMount } from "svelte";
  import type { DocBlock, DocPage } from "../../../shared/api.ts";
  import { api, errorText } from "#lib/api.ts";

  let { page, title }: { page: DocPage; title: string } = $props();

  let blocks = $state<DocBlock[]>([]);
  let error = $state("");
  let loaded = $state(false);

  onMount(async () => {
    try {
      blocks = (await api.docs(page)).blocks;
    } catch (e) {
      error = errorText(e);
    }
    loaded = true;
  });

  type Group = { type: "section" | "heading" | "paragraph"; block: DocBlock } | { type: "list"; items: DocBlock[] };

  // Consecutive "item" blocks form one list.
  const groups = $derived(
    blocks.reduce<Group[]>((out, b) => {
      const last = out[out.length - 1];
      if (b.type !== "item") out.push({ type: b.type, block: b });
      else if (last?.type === "list") last.items.push(b);
      else out.push({ type: "list", items: [b] });
      return out;
    }, []),
  );
  // Headings under sections are one level down; without sections they are the page's sections.
  const nested = $derived(blocks.some((b) => b.type === "section"));
</script>

<svelte:head><title>{title} · Bläkkiskili</title></svelte:head>

{#snippet text(block: DocBlock)}
  {#each block.inline as i}
    {#if i.href}<a href={i.href} rel="noopener">{i.text}</a>{:else if i.code}<code>{i.text}</code>{:else if i.bold}<strong>{i.text}</strong>{:else}{i.text}{/if}
  {/each}
{/snippet}

<main class="page">
  <article class="col doc">
    <h1>{title}</h1>
    {#if error}
      <p class="error" role="alert">{error}</p>
    {:else if !loaded}
      <p class="muted">Ladataan…</p>
    {/if}
    {#each groups as g}
      {#if g.type === "section"}
        <h2>{@render text(g.block)}</h2>
      {:else if g.type === "heading"}
        {#if nested}<h3>{@render text(g.block)}</h3>{:else}<h2>{@render text(g.block)}</h2>{/if}
      {:else if g.type === "paragraph"}
        <p>{@render text(g.block)}</p>
      {:else if g.type === "list"}
        <ul>
          {#each g.items as item}<li>{@render text(item)}</li>{/each}
        </ul>
      {/if}
    {/each}
  </article>
</main>

<style>
  .doc h2 {
    margin-top: 2rem;
  }
  .doc h3 {
    margin: 1.4rem 0 0.4rem;
    font-size: 1.07rem;
  }
  .doc ul {
    padding-left: 1.25rem;
  }
  .doc li {
    margin: 0.35rem 0;
  }
</style>
