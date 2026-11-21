<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import type { LoginProvider } from "../../../../shared/api.ts";
  import { api, ApiError, errorText } from "#lib/api.ts";
  import Icon from "#lib/Icon.svelte";
  import { decodeTelegramResult, goToProvider, goToTelegram, passkeysSupported, signInWithPasskey } from "#lib/logins.ts";
  import { session, takeReturn } from "#lib/session.svelte.ts";
  import { finishMove, isMoving, setMoving } from "#lib/local/migrate.ts";

  let error = $state("");
  let working = $state(false);
  let botUsername = $state("");
  let botId = $state(0);
  let providers = $state<LoginProvider[]>([]);
  let localAccounts = $state(false);
  // Moving this device's local account online ("Siirrä verkkoon" in Settings).
  const moving = isMoving();
  const oauth = $derived(providers.filter((p): p is "google" | "microsoft" => p === "google" || p === "microsoft"));
  const passkeys = $derived(providers.includes("passkey") && passkeysSupported());

  async function done() {
    session.local = false; // a server session now; a local account on the device stays until moved
    session.me = await api.me();
    try {
      const moved = await finishMove();
      if (moved) session.notice = moved;
    } catch (e) {
      session.notice = `Tietojen siirto ei onnistunut: ${errorText(e)} Yritä uudelleen asetuksista.`;
    }
    // An invite link opened while signed out is waiting in sessionStorage (see /join).
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem("kili-pikakutsu") ? "/liity" : sessionStorage.getItem("kili-invite") ? "/join" : null;
    } catch {}
    const back = takeReturn();
    goto(pending ?? back ?? "/", { replaceState: true });
  }

  async function withLink(token: string) {
    working = true;
    error = "";
    try {
      await api.signInWithLink(token);
      await done();
    } catch (e) {
      error = errorText(e);
      working = false;
    }
  }

  async function withTelegram(user: unknown) {
    working = true;
    error = "";
    try {
      await api.signInWithTelegram(user);
      await done();
    } catch (e) {
      error = errorText(e);
      working = false;
    }
  }

  async function withProvider(platform: "google" | "microsoft") {
    working = true;
    error = "";
    try {
      await goToProvider(platform, false); // the browser leaves for the provider's page
    } catch (e) {
      error = errorText(e);
      working = false;
    }
  }

  async function withPasskey() {
    working = true;
    error = "";
    try {
      if (await signInWithPasskey()) return await done();
    } catch (e) {
      error = errorText(e);
    }
    working = false;
  }

  // /web in the bot gives /login#t=TOKEN, and Telegram's sign-in comes back as
  // /login#tgAuthResult=…. Both are in the fragment so they never reach a server log; remove
  // them from the address bar and history right away. Google and Microsoft come back through the
  // server, which sends the browser to /login#signedin or /login#error=<code>.
  function takeFragment(): { token?: string; telegram?: string; signedIn: boolean; failed?: string } {
    const params = new URLSearchParams(location.hash.slice(1));
    const token = params.get("t") ?? undefined;
    const telegram = params.get("tgAuthResult") ?? undefined;
    const signedIn = params.has("signedin");
    const failed = params.get("error") ?? undefined;
    if (token || telegram !== undefined || signedIn || failed) history.replaceState(null, "", location.pathname);
    return { token, telegram, signedIn, failed };
  }

  function handleFragment(): boolean {
    const { token, telegram, signedIn, failed } = takeFragment();
    if (failed) error = errorText(new ApiError(0, failed));
    if (signedIn) {
      working = true;
      done().catch((e) => {
        error = errorText(e);
        working = false;
      });
      return true;
    }
    if (token) {
      withLink(token);
      return true;
    }
    if (telegram !== undefined) {
      let user: unknown;
      try {
        user = decodeTelegramResult(telegram);
      } catch {
        error = "Telegram-kirjautuminen keskeytyi. Yritä uudelleen.";
        return false;
      }
      withTelegram(user);
      return true;
    }
    return false;
  }

  // A link opened in a tab already showing this page only changes the fragment: the browser
  // doesn't load the page again, so the token arrives here instead of in onMount.
  function onHashChange() {
    if (!working) handleFragment();
  }

  // Signed in in another tab (or with the link in a new tab): move on when this one is looked at.
  async function onVisible() {
    if (document.visibilityState !== "visible" || working || session.me) return;
    try {
      session.me = await api.me();
    } catch {
      return; // still signed out
    }
    await done();
  }

  onMount(async () => {
    if (session.me && !session.local && !location.hash.includes("signedin")) return goto("/", { replaceState: true });
    // (a signed-in visitor never sees this page)

    if (handleFragment()) return;

    // The Telegram button needs the bot's id, and the site's domain registered with BotFather
    // (/setdomain), or Telegram's page says "Bot domain invalid".
    try {
      const config = await api.config();
      botUsername = config.botUsername;
      botId = config.botId;
      providers = config.loginProviders;
      localAccounts = config.localAccounts;
    } catch (e) {
      error = errorText(e);
    }
  });
</script>

<svelte:head><title>Kirjaudu · Bläkkiskili</title></svelte:head>
<svelte:window onhashchange={onHashChange} />
<svelte:document onvisibilitychange={onVisible} />

<main class="page">
  <div class="mx-auto max-w-[28rem] pt-10 text-center">
    <img class="mx-auto mb-4 block size-[128px] rounded-xl" src="/kili-256.jpg" alt="" width="128" height="128" />
    <h1 class="text-4xl font-medium text-wordmark">Bläkkiskili</h1>
    <p class="mt-1.5 mb-6 text-lg text-secondary">Promillearviot, illan juomat ja ryhmän kuvaaja selaimessa.</p>

    <section class="card card-panel text-left">
      {#if working}
        <p>Kirjaudutaan…</p>
      {:else}
        {#if moving}
          <div class="notice mb-4">
            <div>
              <p class="mt-0">Kirjaudu tai luo tunnus: tämän laitteen juomat ja suosikit siirretään siihen.</p>
              <a href="/settings" onclick={() => setMoving(false)}>Peru siirto</a>
            </div>
          </div>
        {/if}
        <h2>Kirjaudu</h2>
        <div class="my-4 grid gap-2.5">
          <button class="btn btn-primary justify-center" disabled={!botId} onclick={() => goToTelegram(botId, "/login")}>Kirjaudu Telegramilla</button>
          {#each oauth as p (p)}
            <button class="btn justify-center" onclick={() => withProvider(p)}>Kirjaudu {p === "google" ? "Googlella" : "Microsoftilla"}</button>
          {/each}
          {#if passkeys}
            <button class="btn justify-center" onclick={withPasskey}><Icon name="key" /> Kirjaudu pääsyavaimella</button>
          {/if}
        </div>
        <p class="text-sm text-secondary">
          Jos Telegram-kirjautuminen ei toimi, lähetä botille <code>/web</code>, niin saat kertakäyttöisen kirjautumislinkin.
        </p>

        <h2 class="mt-6">Uusi käyttäjä?</h2>
        <p class="text-secondary">
          Telegramissa tunnus luodaan botin kanssa, ja sivusto käyttää samoja tietoja.
          {#if botUsername}
            <a href="https://t.me/{botUsername}" target="_blank" rel="noopener">Avaa botti Telegramissa (@{botUsername})</a>.
          {/if}
          {#if oauth.length}
            Voit myös kirjautua {oauth.map((p) => (p === "google" ? "Googlella" : "Microsoftilla")).join(" tai ")}, niin pääset luomaan tunnuksen suoraan täällä.
          {/if}
        </p>
        {#if passkeys}
          <a class="btn" href="/signup?passkey"><Icon name="key" /> Luo tunnus pääsyavaimella</a>
          <p class="mt-2 mb-0 text-sm text-secondary">Pääsyavain toimii puhelimen tai tietokoneen lukituksella: ei salasanaa eikä muita palveluita.</p>
        {/if}
        {#if localAccounts && !session.local && !moving}
          <h2 class="mt-6">Ilman tunnusta</h2>
          <p class="text-secondary">
            Voit käyttää Bläkkiskiliä myös ilman tunnusta: tiedot tallennetaan vain tähän selaimeen, eikä niitä lähetetä minnekään.
            Ryhmät tarvitsevat tunnuksen, ja tiedot voi siirtää tunnukseen myöhemmin.
          </p>
          <a class="btn" href="/signup?local"><Icon name="monitor" /> Käytä vain tällä laitteella</a>
        {/if}
      {/if}
      {#if error}<p class="text-danger" role="alert">{error}</p>{/if}
    </section>
  </div>
</main>
