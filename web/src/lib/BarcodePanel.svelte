<script lang="ts">
  // A barcode, and what it leads to: the same answers as the bot's barcodeView (src/bot/menu.ts).
  import type { BarcodeResult, CustomProductItem, LogDrinkRequest } from "../../../shared/api.ts";
  import { api, errorText } from "#lib/api.ts";
  import BarcodeScanner from "#lib/BarcodeScanner.svelte";
  import CustomProductForm from "#lib/CustomProductForm.svelte";
  import Icon from "#lib/Icon.svelte";
  import ProductCard from "#lib/ProductCard.svelte";

  let { busy, log }: { busy: boolean; log: (drink: LogDrinkRequest) => Promise<void> } = $props();

  const KIND_NAMES: Record<CustomProductItem["kind"], string> = {
    olut: "Olut, siideri tai lonkero",
    viini: "Viini",
    kuohu: "Kuohuviini",
    vakeva: "Väkevä",
    muu: "Muu",
  };
  const num = (n: number) => String(Math.round(n * 100) / 100).replace(".", ",");

  let ean = $state<string | null>(null);
  let result = $state<BarcodeResult | null>(null);
  let loading = $state(false);
  let error = $state("");
  let editing = $state(false);
  let notice = $state("");
  /** "Ilmoita virheestä" form open, for users who can't edit the product themselves. */
  let reporting = $state(false);
  let reportText = $state("");
  let reportError = $state("");
  let sending = $state(false);

  async function lookup(code: string) {
    ean = code;
    result = null;
    error = "";
    notice = "";
    editing = false;
    closeReport();
    loading = true;
    try {
      result = await api.barcode(code);
      ean = result.ean; // UPC-A comes back as its EAN-13
    } catch (e) {
      error = errorText(e);
    } finally {
      loading = false;
    }
  }

  function reset() {
    ean = null;
    result = null;
    error = "";
    notice = "";
    editing = false;
    closeReport();
  }

  function closeReport() {
    reporting = false;
    reportText = "";
    reportError = "";
  }

  async function sendReport(e: SubmitEvent, c: CustomProductItem) {
    e.preventDefault();
    if (!reportText.trim()) return;
    sending = true;
    reportError = "";
    try {
      await api.reportCustomProduct(c.ean, reportText.trim());
      closeReport();
      notice = "Kiitos! Ilmoitus lähetettiin ylläpitäjille.";
    } catch (err) {
      reportError = errorText(err);
    } finally {
      sending = false;
    }
  }

  function saved(r: BarcodeResult) {
    const created = result?.status !== "found";
    result = r;
    editing = false;
    notice = created ? "Tuote tallennettu. Viivakoodi avaa sen nyt kaikille." : "Tuote päivitetty.";
  }

  async function remove(c: CustomProductItem) {
    if (!confirm(`Poistetaanko viivakoodin ${c.ean} tuote ${c.name} kaikilta? Jo merkityt juomat säilyvät.`)) return;
    try {
      await api.deleteCustomProduct(c.ean);
      result = { status: "unknown", ean: c.ean };
      notice = "Tuote poistettu.";
    } catch (e) {
      error = errorText(e);
    }
  }
</script>

{#if ean === null}
  <BarcodeScanner onCode={lookup} disabled={busy} />
  <p class="muted small">Kuva luetaan selaimessasi. Palvelimelle lähetetään vain viivakoodin numero.</p>
{:else}
  <div class="result" aria-live="polite">
    {#if loading}
      <p class="muted">Haetaan viivakoodia <code>{ean}</code>…</p>
    {:else if error}
      <p class="error" role="alert">{error}</p>
      <button class="btn small" onclick={() => ean && lookup(ean)}><Icon name="repeat" /> Yritä uudelleen</button>
    {:else if result}
      {#if notice}<p class="notice"><Icon name="check" /> {notice}</p>{/if}
      {#if editing}
        <CustomProductForm ean={result.ean} existing={result.status === "found" ? result.custom : null} onSaved={saved} onCancel={() => (editing = false)} />
      {:else if result.status === "found"}
        {@const custom = result.custom}
        {@const product = result.product}
        <p>
          Viivakoodi <code>{result.ean}</code> kuuluu tälle {custom ? "käyttäjien lisäämälle tuotteelle" : "tuotteelle"}.
        </p>
        <ProductCard {product} {busy} onLog={(serving) => log({ kind: "product", productId: product.id, serving })}>
          {#if custom}
            <p class="details">
              {KIND_NAMES[custom.kind]}{#if custom.kcal100 !== null}{" · "}{num(custom.kcal100)} kcal / 100 ml{/if}<br />
              <span class="muted">Käyttäjän lisäämä tuote, ei Alkon valikoimassa.</span>
            </p>
          {/if}
        </ProductCard>
        {#if custom?.canEdit}
          <div class="buttons">
            <button class="btn small" onclick={() => (editing = true)}><Icon name="edit" /> Muokkaa tuotetta</button>
            <button class="btn small danger" onclick={() => remove(custom)}><Icon name="trash" /> Poista tuote</button>
          </div>
        {:else if custom && reporting}
          <form class="report" onsubmit={(e) => sendReport(e, custom)}>
            <label class="field"
              >Mikä tuotteessa on vialla?
              <!-- svelte-ignore a11y_autofocus -->
              <input type="text" bind:value={reportText} maxlength="300" placeholder="Esim. prosentti on 5,5 eikä 4,5" required autofocus />
            </label>
            {#if reportError}<p class="error" role="alert">{reportError}</p>{/if}
            <div class="buttons">
              <button class="btn small primary" type="submit" disabled={sending || !reportText.trim()}><Icon name="send" /> Lähetä</button>
              <button class="btn small ghost" type="button" disabled={sending} onclick={closeReport}>Peruuta</button>
            </div>
            <p class="muted hint">Viesti menee ylläpitäjille, jotka korjaavat tuotteen. He eivät näe, kuka ilmoitti.</p>
          </form>
        {:else if custom}
          <div class="buttons">
            <button class="btn small ghost" onclick={() => ((reporting = true), (notice = ""))}><Icon name="flag" /> Ilmoita virheestä</button>
          </div>
        {/if}
      {:else if result.status === "alcohol_free"}
        <p>Viivakoodi <code>{result.ean}</code> kuuluu tuotteelle <b>{result.name}</b>, mutta se on alkoholiton (alle 1 %), joten sitä ei voi merkitä juomaksi.</p>
      {:else}
        <p>
          {#if result.status === "gone"}
            Viivakoodi <code>{result.ean}</code> kuuluu tuotteelle, jota ei enää löydy Alkon valikoimasta. Jos tuotetta myydään muualla, voit lisätä sen itse.
          {:else}
            Alko ei tunne viivakoodia <code>{result.ean}</code>. Voit hakea tuotetta nimellä, tai jos se on esimerkiksi kaupan tuote, lisätä sen itse.
          {/if}
        </p>
        <button class="btn primary" onclick={() => (editing = true)}><Icon name="plus" /> Lisää tuote</button>
      {/if}
    {/if}
    {#if !editing && !loading}
      <div class="again">
        <button class="btn" onclick={reset}><Icon name="camera" /> Lue toinen viivakoodi</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .result {
    display: grid;
    gap: 0.75rem;
  }
  .result p,
  .small {
    margin: 0;
  }
  .small {
    margin-top: 0.75rem;
    font-size: 0.93rem;
  }
  .details {
    margin: -0.25rem 0 0.5rem;
    color: var(--text-secondary);
    font-size: 0.93rem;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .report {
    display: grid;
    gap: 0.6rem;
  }
  .hint {
    font-size: 0.93rem;
  }
  .again {
    padding-top: 0.75rem;
    border-top: 1px solid var(--border-soft);
  }
</style>
