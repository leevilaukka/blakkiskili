<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import type { ChartName, Gender, LoginPlatform, LoginProvider, LoginsView } from "../../../../shared/api.ts";
  import { api, ApiError, errorText, responseError } from "#lib/api.ts";
  import { date } from "#lib/format.ts";
  import Icon from "#lib/Icon.svelte";
  import { addPasskey, decodeTelegramResult, goToProvider, goToTelegram, LOGIN_NAMES, passkeysSupported } from "#lib/logins.ts";
  import { session } from "#lib/session.svelte.ts";
  import { moveToAccount, setMoving } from "#lib/local/migrate.ts";
  import { clearLocal, loadLocal } from "#lib/local/store.ts";
  import type { LocalData } from "#lib/local/core.ts";

  const me = session.me!;
  let name = $state(me.name);
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

  // Ways to sign in: the account's logins, and the site's methods it could add.
  let logins = $state<LoginsView | null>(null);
  let providers = $state<LoginProvider[]>([]);
  let botId = $state(0);
  let loginBusy = $state(false);
  let loginMessage = $state("");
  let loginError = $state("");
  const has = (p: LoginPlatform) => !!logins?.logins.some((l) => l.platform === p);
  const addable = $derived(
    providers.filter((p) => (p === "passkey" ? passkeysSupported() : !has(p))) as LoginProvider[],
  );
  const usableCount = $derived(logins?.logins.filter((l) => l.usable).length ?? 0);

  async function loginAction(action: () => Promise<unknown>, done = "") {
    loginBusy = true;
    loginError = "";
    loginMessage = "";
    try {
      const r = await action();
      if (r === false) return; // cancelled in the browser's dialog
      logins = await api.logins();
      loginMessage = done;
    } catch (err) {
      loginError = errorText(err);
    } finally {
      loginBusy = false;
    }
  }

  function addLogin(p: LoginProvider) {
    if (p === "telegram") return goToTelegram(botId, "/settings");
    if (p === "passkey") return loginAction(addPasskey, "Pääsyavain lisätty.");
    loginBusy = true;
    goToProvider(p, true).catch((err) => {
      loginError = errorText(err);
      loginBusy = false;
    });
  }

  function removeLogin(p: LoginPlatform) {
    if (!confirm(`Poistetaanko kirjautumistapa ${LOGIN_NAMES[p]}?`)) return;
    void loginAction(() => api.removeLogin(p), `${LOGIN_NAMES[p]} poistettu.`);
  }

  function removePasskey(id: string) {
    if (!confirm("Poistetaanko pääsyavain? Sillä ei voi enää kirjautua.")) return;
    void loginAction(() => api.removePasskey(id), "Pääsyavain poistettu.");
  }

  // Back from adding a login: Google and Microsoft through the server (#linked=… or #error=…),
  // Telegram's page straight here (#tgAuthResult=…). Off the address bar right away.
  async function handleFragment() {
    const params = new URLSearchParams(location.hash.slice(1));
    if (![...params.keys()].length) return;
    history.replaceState(null, "", location.pathname);
    const linked = params.get("linked");
    const failed = params.get("error");
    const telegram = params.get("tgAuthResult");
    if (linked === "google" || linked === "microsoft") loginMessage = `${LOGIN_NAMES[linked]} lisätty. Voit nyt kirjautua myös sillä.`;
    if (failed) loginError = errorText(new ApiError(0, failed));
    if (telegram !== null) {
      let data: unknown;
      try {
        data = decodeTelegramResult(telegram);
      } catch {
        loginError = errorText(new ApiError(0, "cancelled"));
        return;
      }
      await loginAction(async () => {
        await api.linkTelegram(data);
        session.me = await api.me();
      }, "Telegram lisätty. Botti käyttää nyt samaa tunnusta.");
    }
  }

  // A local account (this page then manages it), or one left on this device next to a server account.
  let localData = $state<LocalData | null>(null);
  let persisted = $state<boolean | null>(null);
  let moveBusy = $state(false);
  let moveError = $state("");

  function startMove() {
    setMoving(true);
    goto("/login");
  }

  async function moveHere() {
    moveBusy = true;
    moveError = "";
    try {
      const r = await moveToAccount(localData);
      localData = null;
      if (r) session.notice = `Tämän laitteen tiedot siirrettiin tunnukseen: ${r.inserted} juomaa${r.favorites ? ` ja ${r.favorites} suosikkia` : ""}.`;
    } catch (err) {
      moveError = errorText(err);
    } finally {
      moveBusy = false;
    }
  }

  async function dropLocal() {
    if (!confirm("Poistetaanko tämän laitteen paikalliset tiedot? Niitä ei voi palauttaa.")) return;
    await clearLocal();
    localData = null;
  }

  onMount(async () => {
    localData = await loadLocal();
    if (session.local) {
      persisted = (await navigator.storage?.persisted?.().catch(() => null)) ?? null;
      return; // no server account: nothing else to load
    }
    void handleFragment();
    sessions = await api.sessions().then((r) => r.count, () => null);
    const [view, config] = await Promise.all([api.logins().catch(() => null), api.config().catch(() => null)]);
    logins ??= view;
    providers = config?.loginProviders ?? [];
    botId = config?.botId ?? 0;
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
      session.local = false;
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
      session.me = await api.patchMe({
        ...(me.telegram ? { chartName } : { name: name.trim() }),
        weight: Number(weight),
        height: Number(height),
        gender,
      });
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
    {#if me.telegram}
      <fieldset class="mb-5">
        <legend class="mb-2 text-xl font-bold">Nimi kuvaajissa</legend>
        <label class="flex items-center gap-2.5 py-1.25"><input type="radio" bind:group={chartName} value="full" /> Koko nimi (Telegramin etu- ja sukunimi)</label>
        <label class="flex items-center gap-2.5 py-1.25"><input type="radio" bind:group={chartName} value="username" /> Käyttäjätunnus (@nimi)</label>
      </fieldset>
    {:else}
      <label class="mb-5 grid max-w-[22rem] gap-1.25">
        <span class="text-xl font-bold">Nimimerkki</span>
        <input type="text" bind:value={name} minlength="2" maxlength="32" autocomplete="nickname" required />
        <span class="text-sm text-secondary">{session.local ? "Näkyy kuvaajassa." : "Näkyy ryhmissä ja kuvaajissa muille."}</span>
      </label>
    {/if}

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

  {#if session.local}
    <section class="card card-panel mt-4">
      <h2>Tiedot vain tällä laitteella</h2>
      <p class="text-secondary">
        Käytät Bläkkiskiliä ilman tunnusta: {localData?.drinks.length ?? 0} juomaa ja {localData?.favorites.length ?? 0} suosikkia on tallennettu vain tähän selaimeen.
        Jos selaimen tiedot tyhjennetään tai laite vaihtuu, ne häviävät.
        {#if persisted === false}Selain voi myös poistaa ne itse, jos tila käy vähiin: sovelluksena asennettuna (Lisää aloitusnäyttöön) ne säilyvät varmemmin.{/if}
      </p>
      <p class="text-secondary">
        Siirrä tiedot verkkoon, niin voit käyttää ryhmiä, Telegram-bottia ja muita laitteita. Kirjaudu tai luo tunnus, ja juomasi ja suosikkisi siirretään siihen.
      </p>
      <button class="btn btn-primary" onclick={startMove}><Icon name="upload" /> Siirrä tiedot verkkoon</button>
    </section>
  {:else}
  {#if localData}
    <section class="card card-panel mt-4">
      <h2>Tällä laitteella on paikallisia tietoja</h2>
      <p class="text-secondary">
        Tähän selaimeen on tallennettu ilman tunnusta {localData.drinks.length} juomaa ({localData.profile.name}). Voit siirtää ne tähän tunnukseen
        (samoja juomia ei lisätä kahdesti) tai poistaa ne laitteelta.
      </p>
      <div class="flex flex-wrap items-center gap-2.5">
        <button class="btn btn-primary" disabled={moveBusy} onclick={moveHere}><Icon name="upload" /> Siirrä tähän tunnukseen</button>
        <button class="btn btn-ghost" disabled={moveBusy} onclick={dropLocal}><Icon name="trash" /> Poista laitteelta</button>
      </div>
      {#if moveError}<p class="text-danger" role="alert">{moveError}</p>{/if}
    </section>
  {/if}

  <section class="card card-panel mt-4">
    <h2>Kirjautumistavat</h2>
    <p class="text-secondary">Näillä tavoilla pääset tunnukseesi. Kun tapoja on useampi, pääset sisään, vaikka yksi lakkaisi toimimasta.</p>
    {#if logins}
      {#if logins.logins.length === 0}
        <p class="notice">Liityit vieraana, joten tunnukseesi pääsee vain tällä selaimella. Lisää kirjautumistapa, ettet menetä sitä, jos selaimen tiedot tyhjenevät tai kirjaudut ulos.</p>
      {:else if usableCount === 0}
        <p class="notice">Mikään tunnuksesi kirjautumistavoista ei ole nyt sivustolla käytössä. Lisää toinen tapa, ettet jää ulos, kun kirjaudut seuraavan kerran.</p>
      {:else if usableCount === 1 && addable.length}
        <p class="notice">Sinulla on vain yksi kirjautumistapa. Lisää toinen varalle.</p>
      {/if}
      <ul class="my-3 grid gap-2 p-0">
        {#each logins.logins as l (l.platform)}
          <li class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line px-3 py-2">
            <strong>{LOGIN_NAMES[l.platform]}</strong>
            {#if l.current}<span class="text-sm text-secondary">tämä selain</span>{/if}
            {#if !l.usable}<span class="text-sm text-secondary">ei käytössä sivustolla nyt</span>{/if}
            <span class="text-sm text-secondary">lisätty {date(l.createdAt)}</span>
            {#if l.platform !== "passkey" && !l.current && logins.logins.length > 1}
              <button class="btn btn-ghost btn-sm ml-auto" disabled={loginBusy} onclick={() => removeLogin(l.platform)}><Icon name="trash" /> Poista</button>
            {/if}
          </li>
          {#if l.platform === "passkey"}
            {#each logins.passkeys as k, i (k.id)}
              <li class="ml-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line px-3 py-2">
                <Icon name="key" /> Pääsyavain {i + 1}
                <span class="text-sm text-secondary">
                  luotu {date(k.createdAt)}{#if k.lastUsedAt}, käytetty {date(k.lastUsedAt)}{/if}
                </span>
                <!-- the last one would take this browser's login with it: the server refuses, so no button -->
                {#if logins.passkeys.length > 1 || !l.current}
                  <button class="btn btn-ghost btn-sm ml-auto" disabled={loginBusy} onclick={() => removePasskey(k.id)}><Icon name="trash" /> Poista</button>
                {/if}
              </li>
            {/each}
          {/if}
        {/each}
      </ul>
      {#if addable.length}
        <div class="flex flex-wrap gap-2.5">
          {#each addable as p (p)}
            <button class="btn" disabled={loginBusy || (p === "telegram" && !botId)} onclick={() => addLogin(p)}>
              {#if p === "passkey"}<Icon name="key" /> Lisää pääsyavain{:else}<Icon name="plus" /> Lisää {LOGIN_NAMES[p]}{/if}
            </button>
          {/each}
        </div>
      {/if}
    {/if}
    <div aria-live="polite">
      {#if loginMessage}<p class="mb-0">{loginMessage}</p>{/if}
      {#if loginError}<p class="mb-0 text-danger" role="alert">{loginError}</p>{/if}
    </div>
  </section>

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
    {#if !me.telegram}
      <p class="notice">Lataus ja tuonti käyttävät Telegram-tunnistetta, joten ne toimivat, kun tunnukseen on lisätty Telegram (Kirjautumistavat).</p>
    {/if}
    <div class="flex items-center gap-4">
      <button class="btn" disabled={exportBusy || !me.telegram} onclick={download}><Icon name="download" /> Lataa tietoni</button>
    </div>

    <h3 class="mt-6 mb-1.5 text-lg">Tuo tietoja</h3>
    <p class="text-secondary">
      Valitse tiedostot <code>user.csv</code>, <code>drinks.csv</code> ja halutessasi <code>groups.csv</code>. Tiedostot käyvät vain sille Telegram-tilille, jolla ne on ladattu.
      user.csv päivittää myös painon, pituuden ja sukupuolen. Tuotuja juomia ei lisätä kahdesti.
    </p>
    <label
      class={[
        "btn relative focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-2",
        importBusy || !me.telegram ? "cursor-default opacity-55" : "cursor-pointer",
      ]}
    >
      <Icon name="upload" /> Valitse tiedostot
      <!-- The real input stays in the page for keyboards and screen readers, but invisible. -->
      <input class="absolute inset-0 size-full cursor-[inherit] opacity-0" type="file" accept=".csv,text/csv" multiple disabled={importBusy || !me.telegram} onchange={importFiles} />
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

  {/if}

  <section class="card card-panel mt-4">
    <h2>Poista tunnus</h2>
    <p class="text-secondary">
      {#if session.local}
        Poistaa tältä laitteelta kaikki tiedot: juomat, suosikit ja kehon tiedot. Sitä ei voi perua.
      {:else}
        Tunnuksen poistaminen poistaa kaiken sinuun liittyvän tiedon heti: juomat, suosikit, ryhmäjäsenyydet ja kirjautumiset. Sitä ei voi perua. Lataa tietosi ensin talteen, jos haluat pitää ne.
      {/if}
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
