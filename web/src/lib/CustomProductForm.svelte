<script lang="ts">
  // Adding (or editing) a product for a barcode Alko doesn't know, as the bot's ➕ Lisää tuote:
  // kind, name, size of one can or bottle, ABV and optionally energy. Shared with everyone.
  import type { BarcodeResult, CustomKind, CustomProductItem } from "../../../shared/api.ts";
  import { api, errorText } from "#lib/api.ts";

  let {
    ean,
    existing = null,
    onSaved,
    onCancel,
  }: { ean: string; existing?: CustomProductItem | null; onSaved: (r: BarcodeResult) => void; onCancel: () => void } = $props();

  const KINDS: { id: CustomKind; label: string }[] = [
    { id: "olut", label: "🍺 Olut, siideri tai lonkero" },
    { id: "viini", label: "🍷 Viini" },
    { id: "kuohu", label: "🥂 Kuohuviini" },
    { id: "vakeva", label: "🥃 Väkevä" },
    { id: "muu", label: "🍹 Muu (juomasekoitus, valmisjuoma…)" },
  ];

  const text = (n: number | null | undefined) => (n == null ? "" : String(Math.round(n * 100) / 100).replace(".", ","));
  // The form starts from the product being edited; it is shown again for another barcode.
  // svelte-ignore state_referenced_locally
  let kind = $state<CustomKind | "">(existing?.kind ?? "");
  // svelte-ignore state_referenced_locally
  let name = $state(existing?.name ?? "");
  // svelte-ignore state_referenced_locally
  let sizeCl = $state(text(existing && existing.sizeL * 100));
  // svelte-ignore state_referenced_locally
  let abv = $state(text(existing?.abv));
  // svelte-ignore state_referenced_locally
  let kcal = $state(text(existing?.kcal100));
  let error = $state("");
  let busy = $state(false);

  const num = (s: string) => Number(s.trim().replace(",", ".").replace(/\s*(cl|%|kcal)$/i, ""));

  async function save(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    const size = num(sizeCl);
    const percent = num(abv);
    const energy = kcal.trim() ? num(kcal) : null;
    if (!kind) return void (error = "Valitse, mikä juoma on kyseessä.");
    if (!Number.isFinite(size) || !sizeCl.trim()) return void (error = "Kirjoita koko senttilitroina, esim. 33.");
    if (!Number.isFinite(percent) || !abv.trim()) return void (error = "Kirjoita alkoholiprosentti, esim. 4,5.");
    if (energy !== null && !Number.isFinite(energy)) return void (error = "Kirjoita energia numerona, tai jätä kenttä tyhjäksi.");
    busy = true;
    try {
      onSaved(await api.saveCustomProduct(ean, { kind, name: name.trim(), sizeL: Math.round(size * 100) / 10000, abv: percent, kcal100: energy }));
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }
</script>

<form onsubmit={save}>
  <p class="intro">
    {#if existing}
      Muokkaat viivakoodin <code>{ean}</code> tuotetta.
    {:else}
      Lisäät tuotteen viivakoodille <code>{ean}</code>. Tuote näkyy kaikille, jotka lukevat saman viivakoodin, joten kirjoita tiedot pakkauksesta.
    {/if}
  </p>

  <fieldset>
    <legend>Mikä juoma on kyseessä?</legend>
    <div class="kinds">
      {#each KINDS as k (k.id)}
        <label class="kind"><input type="radio" name="kind" value={k.id} bind:group={kind} /> {k.label}</label>
      {/each}
    </div>
  </fieldset>

  <label class="field">Nimi<input type="text" bind:value={name} maxlength="60" placeholder="Esim. Lapin Kulta IVA" required /></label>
  <div class="row">
    <label class="field">Tölkin tai pullon koko (cl)<input type="text" inputmode="decimal" bind:value={sizeCl} placeholder="33" required /></label>
    <label class="field">Alkoholia (%)<input type="text" inputmode="decimal" bind:value={abv} placeholder="4,5" required /></label>
  </div>
  <label class="field">Energia (kcal / 100 ml, vapaaehtoinen)<input type="text" inputmode="decimal" bind:value={kcal} placeholder="43" /></label>

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  <div class="buttons">
    <button class="btn primary" type="submit" disabled={busy}>{existing ? "Tallenna muutokset" : "Lisää tuote"}</button>
    <button class="btn ghost" type="button" disabled={busy} onclick={onCancel}>Peruuta</button>
  </div>
  <p class="muted small">Tuote tallennetaan vain Bläkkiskiliin, ei Alkometriikalle. Voit muokata tai poistaa sen myöhemmin.</p>
</form>

<style>
  form {
    display: grid;
    gap: 0.9rem;
  }
  .intro,
  .small,
  .error {
    margin: 0;
  }
  .small {
    font-size: 0.93rem;
  }
  fieldset {
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend {
    margin-bottom: 0.4rem;
    padding: 0;
  }
  .kinds {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
    gap: 0.4rem;
  }
  .kind {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--raised);
    cursor: pointer;
  }
  .kind:has(input:checked) {
    border-color: var(--accent);
  }
  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
