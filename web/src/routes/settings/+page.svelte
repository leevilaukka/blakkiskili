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
<div class="mx-auto max-w-[46rem]">
  <div class="mb-5">
    <h1>Asetukset</h1>
    <p class="mt-1.5 mb-0 text-lg text-secondary">Tunnus <strong>{me.name}</strong>. Painon, pituuden ja sukupuolen perusteella arvioidaan promillet.</p>
  </div>

  <form class="card card-panel" onsubmit={save}>
    <fieldset class="mb-5">
      <legend class="mb-2 text-xl font-bold">Nimi kuvaajissa</legend>
      <label class="flex items-center gap-2.5 py-1.25"><input type="radio" bind:group={chartName} value="full" /> Koko nimi (Telegramin etu- ja sukunimi)</label>
      <label class="flex items-center gap-2.5 py-1.25"><input type="radio" bind:group={chartName} value="username" /> Käyttäjätunnus (@nimi)</label>
    </fieldset>

    <h2 class="mb-2.5">Promillearvion tiedot</h2>
    <div class="mb-5 grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
      <label class="grid gap-1.25">Paino (kg)<input type="number" inputmode="numeric" bind:value={weight} min="20" max="250" required /></label>
      <label class="grid gap-1.25">Pituus (cm)<input type="number" inputmode="numeric" bind:value={height} min="120" max="240" required /></label>
      <label class="grid gap-1.25">Sukupuoli
        <select bind:value={gender}>
          <option value="mies">Mies</option>
          <option value="nainen">Nainen</option>
        </select>
      </label>
    </div>

    <div class="flex items-center gap-4">
      <button class="btn btn-primary" disabled={busy} type="submit"><Icon name="check" /> Tallenna</button>
      <div aria-live="polite">
        {#if message}<p class="m-0">{message}</p>{/if}
        {#if error}<p class="m-0 text-danger" role="alert">{error}</p>{/if}
      </div>
    </div>
  </form>

  <section class="card card-panel mt-4">
    <h2>Kirjautumiset</h2>
    <p class="text-secondary">
      {#if sessions !== null}
        Sivustolle on kirjauduttu tällä tunnuksella {sessions === 1 ? "yhdellä selaimella (tällä)" : `${sessions} selaimella`}.
      {/if}
      Jos olet kirjautunut esimerkiksi kaverin puhelimella tai kadotit laitteen, voit kirjautua ulos kaikkialta. Ryhmien näyttölinkit eivät ole kirjautumisia, joten ne pysyvät voimassa: ne perutaan ryhmän sivulla.
    </p>
    <div class="flex items-center gap-4">
      <button class="btn btn-danger" disabled={outBusy} onclick={logoutEverywhere}><Icon name="logout" /> Kirjaudu ulos kaikkialta</button>
      {#if outError}<p class="m-0 text-danger" role="alert">{outError}</p>{/if}
    </div>
  </section>

  <section class="card card-panel mt-4">
    <h2>Tietosi</h2>
    <p class="text-secondary">
      Voit ladata kaikki tallennetut tietosi CSV-tiedostoina (zip), kuten botin /data-komennolla. Samat tiedostot voi tuoda takaisin tai uuteen
      Bläkkiskiliin, ja myös vanhan Bläkkisvuohen /data-tiedostot kelpaavat.
    </p>
    <div class="flex items-center gap-4">
      <button class="btn" disabled={exportBusy} onclick={download}><Icon name="download" /> Lataa tietoni</button>
    </div>

    <h3 class="mt-6 mb-1.5 text-lg">Tuo tietoja</h3>
    <p class="text-secondary">
      Valitse tiedostot <code>user.csv</code>, <code>drinks.csv</code> ja halutessasi <code>groups.csv</code>. Tiedostot käyvät vain sille Telegram-tilille, jolla ne on ladattu.
      user.csv päivittää myös painon, pituuden ja sukupuolen. Tuotuja juomia ei lisätä kahdesti.
    </p>
    <label
      class={[
        "btn relative focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-2",
        importBusy ? "cursor-default opacity-55" : "cursor-pointer",
      ]}
    >
      <Icon name="upload" /> Valitse tiedostot
      <!-- The real input stays in the page for keyboards and screen readers, but invisible. -->
      <input class="absolute inset-0 size-full cursor-[inherit] opacity-0" type="file" accept=".csv,text/csv" multiple disabled={importBusy} onchange={importFiles} />
    </label>
    {#if importResults.length}
      <ul class="mt-3" aria-live="polite">
        {#each importResults as r}
          <li class={["my-1.25", !r.ok && "text-danger"]}><strong>{r.name}</strong>: {r.message}</li>
        {/each}
      </ul>
    {/if}
    {#if dataError}<p class="text-danger" role="alert">{dataError}</p>{/if}
  </section>

  <section class="card card-panel mt-4">
    <h2>Poista tunnus</h2>
    <p class="text-secondary">
      Tunnuksen poistaminen poistaa kaiken sinuun liittyvän tiedon heti: juomat, suosikit, ryhmäjäsenyydet ja kirjautumiset. Sitä ei voi perua. Lataa tietosi ensin talteen, jos haluat pitää ne.
    </p>
    <details>
      <summary class="cursor-pointer font-semibold">Haluan poistaa tunnukseni</summary>
      <form
        class="mt-3 grid max-w-[22rem] gap-3"
        onsubmit={(e) => {
          e.preventDefault();
          void deleteAccount();
        }}
      >
        <label class="grid gap-1.25">Kirjoita <strong>poista</strong> vahvistaaksesi
          <input type="text" bind:value={deleteText} autocomplete="off" />
        </label>
        <button class="btn btn-danger" type="submit" disabled={deleteBusy || deleteText.trim().toLowerCase() !== "poista"}>
          <Icon name="trash" /> Poista tunnus ja kaikki tietoni
        </button>
      </form>
      {#if deleteError}<p class="text-danger" role="alert">{deleteError}</p>{/if}
    </details>
  </section>
</div>
</main>
