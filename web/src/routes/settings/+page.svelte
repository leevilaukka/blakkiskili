<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import type { ChartName, Gender } from "../../../../shared/api.ts";
  import { api, errorText, responseError } from "#lib/api.ts";
  import Icon from "#lib/Icon.svelte";
  import { session } from "#lib/session.svelte.ts";

  const me = session.me!;
  let chartName = $state<ChartName>(me.chartName);
  let weight = $state(String(me.weight));
  let height = $state(String(me.height));
  let gender = $state<Gender>(me.gender);
  let message = $state("");
  let error = $state("");
  let busy = $state(false);

  // Browsers signed in to this account (this one included); null until known.
  let sessions = $state<number | null>(null);
  let outBusy = $state(false);
  let outError = $state("");

  onMount(async () => {
    sessions = await api.sessions().then((r) => r.count, () => null);
  });

  async function logoutEverywhere() {
    if (!confirm("Kirjaudutaanko ulos kaikilta laitteilta, myös tältä?")) return;
    outBusy = true;
    outError = "";
    try {
      await api.logoutEverywhere();
      session.me = null;
      goto("/login");
    } catch (err) {
      outError = errorText(err);
      outBusy = false;
    }
  }

  // Download, import and delete the account's data.
  let exportBusy = $state(false);
  let dataError = $state("");
  let importResults = $state<{ name: string; ok: boolean; message: string }[]>([]);
  let importBusy = $state(false);
  let deleteText = $state("");
  let deleteBusy = $state(false);
  let deleteError = $state("");
  const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

  async function download() {
    exportBusy = true;
    dataError = "";
    try {
      const res = await fetch("/api/account/export", { credentials: "same-origin" });
      if (!res.ok) throw await responseError(res);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "blakkiskili.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      dataError = errorText(err);
    } finally {
      exportBusy = false;
    }
  }

  async function importFiles(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    // user.csv first: it can create or update the body data the others are checked against.
    const files = [...(input.files ?? [])].sort((a, b) => Number(b.name.startsWith("user")) - Number(a.name.startsWith("user")));
    if (!files.length) return;
    importBusy = true;
    dataError = "";
    importResults = [];
    try {
      for (const file of files) {
        if (file.size > MAX_IMPORT_BYTES) {
          importResults = [...importResults, { name: file.name, ok: false, message: "Tiedosto on liian suuri." }];
          continue;
        }
        const r = await api.importFile(await file.text());
        importResults = [...importResults, { name: file.name, ...r }];
      }
      // user.csv may have changed the body data
      session.me = await api.me();
      weight = String(session.me.weight);
      height = String(session.me.height);
      gender = session.me.gender;
    } catch (err) {
      dataError = errorText(err);
    } finally {
      importBusy = false;
      input.value = "";
    }
  }

  async function deleteAccount() {
    deleteBusy = true;
    deleteError = "";
    try {
      await api.deleteAccount();
      session.me = null;
      goto("/login");
    } catch (err) {
      deleteError = errorText(err);
      deleteBusy = false;
    }
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    message = "";
    try {
      session.me = await api.patchMe({ chartName, weight: Number(weight), height: Number(height), gender });
      message = "Tallennettu.";
    } catch (err) {
      error = errorText(err);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Asetukset · Bläkkiskili</title></svelte:head>

<main class="page">
<div class="col">
  <div class="head">
    <h1>Asetukset</h1>
    <p class="lead">Tunnus <strong>{me.name}</strong>. Painon, pituuden ja sukupuolen perusteella arvioidaan promillet.</p>
  </div>

  <form class="card panel" onsubmit={save}>
    <fieldset>
      <legend>Nimi kuvaajissa</legend>
      <label class="choice"><input type="radio" bind:group={chartName} value="full" /> Koko nimi (Telegramin etu- ja sukunimi)</label>
      <label class="choice"><input type="radio" bind:group={chartName} value="username" /> Käyttäjätunnus (@nimi)</label>
    </fieldset>

    <h2>Promillearvion tiedot</h2>
    <div class="fields">
      <label class="field">Paino (kg)<input type="number" inputmode="numeric" bind:value={weight} min="20" max="250" required /></label>
      <label class="field">Pituus (cm)<input type="number" inputmode="numeric" bind:value={height} min="120" max="240" required /></label>
      <label class="field">Sukupuoli
        <select bind:value={gender}>
          <option value="mies">Mies</option>
          <option value="nainen">Nainen</option>
        </select>
      </label>
    </div>

    <div class="foot">
      <button class="btn primary" disabled={busy} type="submit"><Icon name="check" /> Tallenna</button>
      <div class="status" aria-live="polite">
        {#if message}<p>{message}</p>{/if}
        {#if error}<p class="error" role="alert">{error}</p>{/if}
      </div>
    </div>
  </form>

  <section class="card panel">
    <h2>Kirjautumiset</h2>
    <p class="muted">
      {#if sessions !== null}
        Sivustolle on kirjauduttu tällä tunnuksella {sessions === 1 ? "yhdellä selaimella (tällä)" : `${sessions} selaimella`}.
      {/if}
      Jos olet kirjautunut esimerkiksi kaverin puhelimella tai kadotit laitteen, voit kirjautua ulos kaikkialta. Ryhmien näyttölinkit eivät ole kirjautumisia, joten ne pysyvät voimassa: ne perutaan ryhmän sivulla.
    </p>
    <div class="foot">
      <button class="btn danger" disabled={outBusy} onclick={logoutEverywhere}><Icon name="logout" /> Kirjaudu ulos kaikkialta</button>
      {#if outError}<p class="error" role="alert">{outError}</p>{/if}
    </div>
  </section>

  <section class="card panel">
    <h2>Tietosi</h2>
    <p class="muted">
      Voit ladata kaikki tallennetut tietosi CSV-tiedostoina (zip), kuten botin /data-komennolla. Samat tiedostot voi tuoda takaisin tai uuteen
      Bläkkiskiliin, ja myös vanhan Bläkkisvuohen /data-tiedostot kelpaavat.
    </p>
    <div class="foot">
      <button class="btn" disabled={exportBusy} onclick={download}><Icon name="download" /> Lataa tietoni</button>
    </div>

    <h3>Tuo tietoja</h3>
    <p class="muted">
      Valitse tiedostot <code>user.csv</code>, <code>drinks.csv</code> ja halutessasi <code>groups.csv</code>. Tiedostot käyvät vain sille Telegram-tilille, jolla ne on ladattu.
      user.csv päivittää myös painon, pituuden ja sukupuolen. Tuotuja juomia ei lisätä kahdesti.
    </p>
    <label class="btn file" class:disabled={importBusy}>
      <Icon name="upload" /> Valitse tiedostot
      <input type="file" accept=".csv,text/csv" multiple disabled={importBusy} onchange={importFiles} />
    </label>
    {#if importResults.length}
      <ul class="results" aria-live="polite">
        {#each importResults as r}
          <li class:error={!r.ok}><strong>{r.name}</strong>: {r.message}</li>
        {/each}
      </ul>
    {/if}
    {#if dataError}<p class="error" role="alert">{dataError}</p>{/if}
  </section>

  <section class="card panel">
    <h2>Poista tunnus</h2>
    <p class="muted">
      Tunnuksen poistaminen poistaa kaiken sinuun liittyvän tiedon heti: juomat, suosikit, ryhmäjäsenyydet ja kirjautumiset. Sitä ei voi perua. Lataa tietosi ensin talteen, jos haluat pitää ne.
    </p>
    <details>
      <summary>Haluan poistaa tunnukseni</summary>
      <form
        class="delete"
        onsubmit={(e) => {
          e.preventDefault();
          void deleteAccount();
        }}
      >
        <label class="field">Kirjoita <strong>poista</strong> vahvistaaksesi
          <input type="text" bind:value={deleteText} autocomplete="off" />
        </label>
        <button class="btn danger" type="submit" disabled={deleteBusy || deleteText.trim().toLowerCase() !== "poista"}>
          <Icon name="trash" /> Poista tunnus ja kaikki tietoni
        </button>
      </form>
      {#if deleteError}<p class="error" role="alert">{deleteError}</p>{/if}
    </details>
  </section>
</div>
</main>

<style>
  h3 {
    margin: 1.5rem 0 0.4rem;
    font-size: 1.07rem;
  }
  .file {
    position: relative;
    cursor: pointer;
  }
  .file.disabled {
    opacity: 0.55;
    cursor: default;
  }
  /* The real input stays in the page for keyboards and screen readers, but invisible. */
  .file input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: inherit;
    width: 100%;
    height: 100%;
  }
  .file:focus-within {
    outline: 2px solid var(--brand-2);
    outline-offset: 2px;
  }
  .results {
    list-style: none;
    margin: 0.75rem 0 0;
    padding: 0;
  }
  .results li {
    margin: 0.3rem 0;
  }
  details summary {
    cursor: pointer;
    font-weight: 600;
  }
  .delete {
    display: grid;
    gap: 0.75rem;
    max-width: 22rem;
    margin: 0.75rem 0 0;
  }
  .card + .card {
    margin-top: 1rem;
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0 0 1.25rem;
  }
  legend {
    font-weight: 700;
    font-size: 1.25rem;
    margin-bottom: 0.5rem;
  }
  .choice {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    padding: 0.3rem 0;
  }
  h2 {
    margin-bottom: 0.6rem;
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 0.75rem;
    margin-bottom: 1.25rem;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .status p,
  .foot .error {
    margin: 0;
  }
  form {
    margin-bottom: 1rem;
  }
</style>
