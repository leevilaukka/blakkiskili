<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import type { AdminProduct, AdminView } from "../../../../shared/api.ts";
  import { api, ApiError, errorText } from "#lib/api.ts";
  import { clock } from "#lib/format.ts";
  import Icon from "#lib/Icon.svelte";
  import Stat from "#lib/Stat.svelte";
  import { session } from "#lib/session.svelte.ts";

  let view = $state<AdminView | null>(null);
  let error = $state("");
  let busy = $state(false);
  let filter = $state("");

  const KINDS: Record<AdminProduct["kind"], string> = { olut: "Olut", viini: "Viini", kuohu: "Kuohuviini", vakeva: "Väkevä", muu: "Muu" };
  const n = new Intl.NumberFormat("fi-FI");
  const date = (ms: number) => new Date(ms).toLocaleDateString("fi-FI", { day: "numeric", month: "numeric", year: "numeric" });

  const count = "rounded-sm border border-line px-1.5 text-sm font-medium text-secondary";
  const productRow = "flex justify-between gap-3 border-t border-line-soft py-2.25";
  const stats = "grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-2.5";

  const products = $derived.by(() => {
    const items = view?.customProducts.items ?? [];
    const q = filter.trim().toLowerCase();
    return q ? items.filter((p) => p.name.toLowerCase().includes(q) || p.ean.includes(q)) : items;
  });

  async function load() {
    try {
      view = await api.admin();
      error = "";
    } catch (e) {
      // 404: not an admin (the API hides the page from everyone else).
      if (e instanceof ApiError && e.status === 404) return goto("/", { replaceState: true });
      error = errorText(e);
    }
  }

  onMount(() => {
    if (!session.me?.admin) {
      goto("/", { replaceState: true });
      return;
    }
    load();
  });

  /** The reports are handled: the product was fixed, or nothing was wrong. */
  async function clearReports(p: AdminProduct) {
    busy = true;
    try {
      await api.adminClearReports(p.ean);
      await load();
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  async function removeProduct(p: AdminProduct) {
    if (!confirm(`Poistetaanko tuote ${p.name} (${p.ean}) kaikilta? Jo kirjatut juomat säilyvät.`)) return;
    busy = true;
    try {
      await api.adminDeleteProduct(p.ean);
      await load();
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Ylläpito · Bläkkiskili</title></svelte:head>

<main class="page [&_code]:text-[0.9em]">
  <div class="mb-5">
    <h1>Ylläpito</h1>
    <p class="mt-1.5 mb-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-lg text-secondary">
      Näkyy vain ADMIN_IDS-listan Telegram-tunnuksille.
      {#if view}Tilanne {clock(view.now)}.{/if}
      <button class="btn btn-ghost btn-sm" disabled={busy} onclick={load}><Icon name="repeat" /> Päivitä</button>
    </p>
  </div>
  {#if error}<p class="text-danger" role="alert">{error}</p>{/if}

  {#if view}
    <div class="grid items-start gap-4 min-[62rem]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] min-[62rem]:gap-6">
      <div class="grid min-w-0 gap-4">
        {#if view.reported.length}
          <section class="card">
            <h2 class="flex items-center gap-2">Virheilmoitukset <span class={count}>{n.format(view.reported.length)}</span></h2>
            <p class="text-[0.9rem] text-secondary">
              Korjaa tuote lukemalla sen viivakoodi botille tai Juo-sivulla, ja kuittaa sitten. Ilmoittajia ei näytetä.
            </p>
            <ul>
              {#each view.reported as p (p.ean)}
                <li class={[productRow, "items-start"]}>
                  <span class="grid min-w-0 gap-0.5 wrap-anywhere">
                    <strong>{p.name}</strong>
                    <span class="text-[0.9rem] text-secondary">
                      {KINDS[p.kind]} · {n.format(Math.round(p.sizeL * 1000) / 10)} cl · {n.format(p.abv)} %{#if p.kcal100 !== null} · {n.format(p.kcal100)} kcal/100 ml{/if}
                      · <code>{p.ean}</code>
                    </span>
                    <ul class="mt-1.25 grid gap-1">
                      {#each p.reports as r, i (i)}
                        <li><q class="wrap-anywhere">{r.message}</q> <span class="text-[0.9rem] text-secondary">{date(r.createdAt)}</span></li>
                      {/each}
                    </ul>
                  </span>
                  <span class="flex flex-none gap-1">
                    <button class="btn btn-sm" disabled={busy} onclick={() => clearReports(p)} title="Merkitse käsitellyksi"><Icon name="check" /> Kuittaa</button>
                    <button class="btn btn-ghost btn-sm btn-icon" disabled={busy} onclick={() => removeProduct(p)} aria-label="Poista {p.name}" title="Poista tuote"><Icon name="trash" /></button>
                  </span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <section class="card">
          <h2 class="flex items-center gap-2">Botti</h2>
          <div class={stats}>
            <Stat label="Käyttäjiä" value={n.format(view.bot.users)} />
            <Stat label="Aktiivisia 7 pv" value={n.format(view.bot.activeUsers7)} sub="14 pv: {n.format(view.bot.activeUsers14)}" />
            <Stat label="Ryhmiä" value={n.format(view.bot.groups)} />
            <Stat label="Aktiivisia ryhmiä 7 pv" value={n.format(view.bot.activeGroups7)} sub="14 pv: {n.format(view.bot.activeGroups14)}" />
            <Stat label="Juomia" value={n.format(view.bot.drinks)} />
            <Stat label="Juomia 24 h" value={n.format(view.bot.drinks24h)} />
          </div>
        </section>

        <section class="card">
          <h2 class="flex items-center gap-2">Verkkosivu</h2>
          <div class={stats}>
            <Stat label="Istuntoja" value={n.format(view.web.sessions)} sub="{n.format(view.web.accounts)} tunnusta" />
            <Stat label="Käyttäjiä 24 h" value={n.format(view.web.activeAccounts1)} />
            <Stat label="Avoimia live-yhteyksiä" value={n.format(view.web.liveViewers)} />
            <Stat label="Verkkoryhmiä" value={n.format(view.web.webGroups)} />
            <Stat label="Voimassa olevia näyttölinkkejä" value={n.format(view.web.screenLinks)} />
            <Stat
              label="Alkon katalogi"
              value={view.catalogue.ready ? n.format(view.catalogue.drinks) : "–"}
              sub={view.catalogue.ready ? "juomaa haettavissa" : "ei ladattu"}
            />
          </div>
        </section>

        <section class="card">
          <h2 class="flex items-center gap-2">Käyttäjien lisäämät tuotteet <span class={count}>{n.format(view.customProducts.total)}</span></h2>
          {#if view.customProducts.total === 0}
            <p class="text-secondary">Kukaan ei ole vielä lisännyt tuotetta viivakoodilla.</p>
          {:else}
            <label class="mb-3 grid gap-1.25">Rajaa nimellä tai viivakoodilla
              <input type="search" bind:value={filter} placeholder="esim. lager tai 6415…" />
            </label>
            {#if view.customProducts.total > view.customProducts.items.length}
              <p class="text-[0.9rem] text-secondary">Näytetään {view.customProducts.items.length} viimeksi muutettua.</p>
            {/if}
            <ul>
              {#each products as p (p.ean)}
                <li class={[productRow, "items-center"]}>
                  <span class="grid min-w-0 gap-0.5 wrap-anywhere">
                    <strong>{p.name}</strong>
                    <span class="text-[0.9rem] text-secondary">
                      {KINDS[p.kind]} · {n.format(Math.round(p.sizeL * 1000) / 10)} cl · {n.format(p.abv)} %{#if p.kcal100 !== null} · {n.format(p.kcal100)} kcal/100 ml{/if}
                    </span>
                    <span class="text-[0.9rem] text-secondary">
                      <code>{p.ean}</code> · lisätty {date(p.createdAt)}{#if p.updatedAt !== p.createdAt} · muutettu {date(p.updatedAt)}{/if}{#if p.orphan} · lisääjä poistanut tunnuksensa{/if}
                    </span>
                  </span>
                  <button class="btn btn-ghost btn-sm btn-icon" disabled={busy} onclick={() => removeProduct(p)} aria-label="Poista {p.name}" title="Poista tuote"><Icon name="trash" /></button>
                </li>
              {:else}
                <li class={[productRow, "items-center text-secondary"]}>Ei osumia.</li>
              {/each}
            </ul>
          {/if}
        </section>
      </div>

      <div class="grid min-w-0 gap-4">
        <section class="card">
          <h2 class="flex items-center gap-2">Eniten juomia</h2>
          {#if view.bot.top.length}
            <ol>
              {#each view.bot.top as t, i (i)}
                <li class="grid grid-cols-[2rem_1fr_auto] gap-2 border-t border-line-soft py-1.25 first:border-t-0">
                  <span class="text-muted tabular-nums">{i + 1}.</span><span class="wrap-anywhere">{t.name}</span><span class="tabular-nums">{n.format(t.value)}</span>
                </li>
              {/each}
            </ol>
          {:else}
            <p class="text-secondary">Ei vielä juomia.</p>
          {/if}
        </section>
        <section class="card card-panel">
          <h2 class="flex items-center gap-2">Muualla</h2>
          <p class="text-secondary">
            Botin puolella: <code>/admin_stats</code> ja <code>/admin_kuvaaja</code>. Tuotteita voi korjata myös botissa skannaamalla viivakoodin.
            Varmuuskopiot, palvelin ja häiriöt: <code>deploy/RUNBOOK.md</code>.
          </p>
        </section>
      </div>
    </div>
  {:else if !error}
    <p class="text-secondary">Ladataan…</p>
  {/if}
</main>
