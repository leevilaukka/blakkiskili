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

<form class="grid gap-3.5" onsubmit={save}>
  <p class="m-0">
    {#if existing}
      Muokkaat viivakoodin <code>{ean}</code> tuotetta.
    {:else}
      Lisäät tuotteen viivakoodille <code>{ean}</code>. Tuote näkyy kaikille, jotka lukevat saman viivakoodin, joten kirjoita tiedot pakkauksesta.
    {/if}
  </p>

  <fieldset>
    <legend class="mb-1.5">Mikä juoma on kyseessä?</legend>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-1.5">
      {#each KINDS as k (k.id)}
        <label class="flex cursor-pointer items-center gap-2 rounded-sm border border-line bg-raised px-2.75 py-1.75 has-checked:border-accent"><input type="radio" name="kind" value={k.id} bind:group={kind} /> {k.label}</label>
      {/each}
    </div>
  </fieldset>

  <label class="grid gap-1.25">Nimi<input type="text" bind:value={name} maxlength="60" placeholder="Esim. Lapin Kulta IVA" required /></label>
  <div class="grid grid-cols-2 gap-3">
    <label class="grid gap-1.25">Tölkin tai pullon koko (cl)<input type="text" inputmode="decimal" bind:value={sizeCl} placeholder="33" required /></label>
    <label class="grid gap-1.25">Alkoholia (%)<input type="text" inputmode="decimal" bind:value={abv} placeholder="4,5" required /></label>
  </div>
  <label class="grid gap-1.25">Energia (kcal / 100 ml, vapaaehtoinen)<input type="text" inputmode="decimal" bind:value={kcal} placeholder="43" /></label>

  {#if error}<p class="m-0 text-danger" role="alert">{error}</p>{/if}

  <div class="flex flex-wrap gap-2">
    <button class="btn btn-primary" type="submit" disabled={busy}>{existing ? "Tallenna muutokset" : "Lisää tuote"}</button>
    <button class="btn btn-ghost" type="button" disabled={busy} onclick={onCancel}>Peruuta</button>
  </div>
  <p class="m-0 text-sm text-secondary">Tuote tallennetaan vain Bläkkiskiliin, ei Alkometriikalle. Voit muokata tai poistaa sen myöhemmin.</p>
</form>

