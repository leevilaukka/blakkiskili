<script lang="ts">
  import type { ChartName, Gender } from "../../../../shared/api.ts";
  import { api, errorText } from "#lib/api.ts";
  import { session } from "#lib/session.svelte.ts";

  const me = session.me!;
  let chartName = $state<ChartName>(me.chartName);
  let weight = $state(String(me.weight));
  let height = $state(String(me.height));
  let gender = $state<Gender>(me.gender);
  let message = $state("");
  let error = $state("");
  let busy = $state(false);

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
  <h1>Asetukset</h1>
  <p class="muted">Tunnus: {me.name}. Painon, pituuden ja sukupuolen perusteella arvioidaan promillet.</p>

  <form class="card" onsubmit={save}>
    <fieldset>
      <legend>Nimi kuvaajissa</legend>
      <label class="choice"><input type="radio" bind:group={chartName} value="full" /> Koko nimi (Telegramin etu- ja sukunimi)</label>
      <label class="choice"><input type="radio" bind:group={chartName} value="username" /> Käyttäjätunnus (@nimi)</label>
    </fieldset>

    <div class="fields">
      <label>Paino (kg)<input type="number" inputmode="numeric" bind:value={weight} min="20" max="250" required /></label>
      <label>Pituus (cm)<input type="number" inputmode="numeric" bind:value={height} min="120" max="240" required /></label>
    </div>
    <label class="gender">Sukupuoli
      <select bind:value={gender}>
        <option value="mies">Mies</option>
        <option value="nainen">Nainen</option>
      </select>
    </label>

    <div class="status" aria-live="polite">
      {#if message}<p>{message}</p>{/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
    <button class="btn primary" disabled={busy} type="submit">Tallenna</button>
  </form>
</div>
</main>

<style>
  h1 {
    font-size: 1.4rem;
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0 0 1rem;
  }
  legend {
    font-weight: 600;
    margin-bottom: 0.4rem;
  }
  .choice {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    padding: 0.3rem 0;
    color: var(--text-primary);
    font-size: 1rem;
  }
  .choice input {
    width: auto;
    min-height: 0;
  }
  .fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }
  label {
    display: grid;
    gap: 0.25rem;
    font-size: 0.9rem;
    color: var(--text-secondary);
  }
  .gender {
    margin-bottom: 0.75rem;
  }
  .status {
    min-height: 1.6rem;
  }
  .status p {
    margin: 0.25rem 0;
  }
</style>
