<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import type { ChartName, Gender } from "../../../../shared/api.ts";
  import { api, errorText } from "#lib/api.ts";
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
</div>
</main>

<style>
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
