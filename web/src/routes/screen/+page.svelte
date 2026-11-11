<script lang="ts">
  // An event screen: a group's (or one person's) live chart, opened with a link and no account.
  //
  // For OBS and other streaming software there is an embed view, set with search parameters
  // before the link's #t= part, e.g. /screen?embed=1&board=1&bg=transparent#t=TOKEN:
  //   embed=1           no footer or buttons; the chart fills the window (the browser source)
  //   title=0           no heading (name, picture, time)
  //   legend=0          no names-and-values list above the chart
  //   board=1           the leaderboard beside the chart (also overrides the saved choice outside embed)
  //   qr=1              a QR code to the group's page (always shown outside embed)
  //   bg=transparent    transparent background, for an overlay
  //   theme=dark|light  fixed colours (otherwise the system's)
  import { onMount } from "svelte";
  import type { ScreenView } from "../../../../shared/api.ts";
  import { api, ApiError } from "#lib/api.ts";
  import { canCast, castFailed, castScreen, castUnsupported } from "#lib/cast.ts";
  import Chart from "#lib/Chart.svelte";
  import Icon from "#lib/Icon.svelte";
  import QrCode from "#lib/QrCode.svelte";
  import { clock, decimal1, permille } from "#lib/format.ts";

  type Theme = "auto" | "dark" | "light";

  let view = $state<ScreenView | null>(null);
  let status = $state<"loading" | "live" | "ended" | "reconnecting">("loading");
  let theme = $state<Theme>("auto");
  /** The group's Telegram photo failed to load (none, or Telegram unreachable): show the goat. */
  let photoFailed = $state(false);
  /** The leaderboard beside the chart; closed by default so the chart gets the whole width. */
  let boardOpen = $state(false);
  const showBoard = $derived(boardOpen && !!view && view.members.length > 1);

  /** From the search parameters (see the top of this file). */
  let embed = $state(false);
  let showTitle = $state(true);
  let showLegend = $state(true);
  let qrParam = $state(false);
  /** A QR code to the group's page (members can open it, e.g. to hide their name) in the footer. */
  const showQr = $derived(!!view?.groupId && (!embed || qrParam));
  const groupUrl = $derived(view?.groupId && typeof location !== "undefined" ? `${location.origin}/groups/${view.groupId}` : "");

  /** The link's token, kept in memory only, to build the embed link. Gone after a reload. */
  let linkToken = $state<string | null>(null);
  let panelOpen = $state(false);
  /**
   * Fullscreen with no buttons, for a TV. Follows the browser's fullscreen (Esc leaves it); where
   * there is none (iPhone Safari) the buttons are just hidden. A double-click brings them back.
   */
  let presenting = $state(false);
  /** The window's size: when there's room, the chart fills the height (as on a TV). */
  let innerWidth = $state(1280);
  let innerHeight = $state(800);
  const fit = $derived(embed || presenting || (innerWidth > 800 && innerHeight >= 480 && !panelOpen));
  /**
   * Text and chart details grow gently on displays bigger than 1280×800, so a TV stays readable:
   * half as fast as the window (2560×1440 gives 1.4), at most 2×.
   */
  const scale = $derived(Math.min(1 + Math.max(Math.min(innerWidth / 1280, innerHeight / 800) - 1, 0) / 2, 2));

  async function present() {
    panelOpen = false;
    presenting = true;
    try {
      await document.documentElement.requestFullscreen?.();
    } catch {} // not allowed or not supported: the buttons stay hidden anyway
  }
  function stopPresenting() {
    presenting = false;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  function onFullscreenChange() {
    if (!document.fullscreenElement) presenting = false;
  }
  let casting = $state(false);
  let castError = $state("");
  async function cast() {
    castError = canCast ? "" : castUnsupported;
    if (!linkToken || !canCast) return;
    if (await castScreen(linkToken, () => (casting = false))) casting = true;
    else castError = castFailed;
  }
  let copied = $state(false);
  const opt = $state({ title: true, legend: true, board: false, qr: false, transparent: true, theme: "dark" as Theme });
  const embedUrl = $derived.by(() => {
    if (typeof location === "undefined") return "";
    const p = new URLSearchParams({ embed: "1" });
    if (!opt.title) p.set("title", "0");
    if (!opt.legend) p.set("legend", "0");
    if (opt.board) p.set("board", "1");
    if (opt.qr) p.set("qr", "1");
    if (opt.transparent) p.set("bg", "transparent");
    if (opt.theme !== "auto") p.set("theme", opt.theme);
    return `${location.origin}/screen?${p}${linkToken ? `#t=${linkToken}` : ""}`;
  });

  function toggleBoard() {
    boardOpen = !boardOpen;
    try {
      localStorage.setItem("kili-screen-board", boardOpen ? "open" : "closed");
    } catch {}
  }
  const host = typeof location === "undefined" ? "" : location.host;

  function applyTheme(t: Theme, save = true) {
    theme = t;
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    if (!save) return;
    try {
      localStorage.setItem("kili-screen-theme", t);
    } catch {}
  }

  async function copyEmbed() {
    try {
      await navigator.clipboard.writeText(embedUrl);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {}
  }

  onMount(() => {
    const params = new URLSearchParams(location.search);
    embed = params.get("embed") === "1";
    showTitle = params.get("title") !== "0";
    showLegend = params.get("legend") !== "0";
    qrParam = params.get("qr") === "1";
    if (params.get("bg") === "transparent") document.documentElement.setAttribute("data-bg", "transparent");
    try {
      boardOpen = localStorage.getItem("kili-screen-board") === "open";
      const saved = localStorage.getItem("kili-screen-theme");
      if (!embed && (saved === "dark" || saved === "light")) applyTheme(saved);
    } catch {}
    if (embed) boardOpen = false;
    if (params.has("board")) boardOpen = params.get("board") === "1";
    const fixed = params.get("theme");
    if (fixed === "dark" || fixed === "light") applyTheme(fixed, false);

    let source: EventSource | undefined;
    let stopped = false;
    let wakeLock: { release(): Promise<void> } | undefined;

    function listen() {
      source = new EventSource("/api/screen/events");
      source.addEventListener("update", (e) => {
        view = JSON.parse((e as MessageEvent).data);
        status = "live";
      });
      source.addEventListener("end", () => {
        source?.close();
        status = "ended";
      });
      source.onerror = async () => {
        if (status === "live") status = "reconnecting";
        try {
          await api.screen(); // the browser retries by itself; this only tells whether the link is gone
        } catch (e) {
          if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
            source?.close();
            status = "ended";
          }
        }
      };
    }

    async function start() {
      // The link is /screen#t=TOKEN: the token is exchanged for a cookie right away and removed
      // from the address bar and history (the search parameters stay). After that, reloading the
      // page keeps working.
      const token = new URLSearchParams(location.hash.slice(1)).get("t");
      if (token) {
        history.replaceState(null, "", location.pathname + location.search);
        try {
          await api.openScreen(token);
          linkToken = token;
        } catch {
          status = "ended";
          return;
        }
      }
      try {
        view = await api.screen();
        status = "live";
      } catch {
        status = "ended";
        return;
      }
      if (!stopped) listen();
      // Keep the display awake while it is showing the chart (where the browser allows it).
      try {
        wakeLock = await (navigator as any).wakeLock?.request("screen");
      } catch {}
    }
    start();

    return () => {
      stopped = true;
      source?.close();
      wakeLock?.release().catch(() => {});
      document.documentElement.removeAttribute("data-bg");
    };
  });
</script>

<!-- Another screen link opened in a tab already on /screen only changes the fragment: start over with it -->
<svelte:window
  onhashchange={() => new URLSearchParams(location.hash.slice(1)).has("t") && location.reload()}
  bind:innerWidth
  bind:innerHeight
/>
<svelte:document onfullscreenchange={onFullscreenChange} />

<svelte:head>
  <title>{view?.title ?? "Näyttö"} · Bläkkiskili</title>
  <meta name="referrer" content="no-referrer" />
</svelte:head>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<main class="screen" class:embed class:fit style:--k={scale} ondblclick={() => presenting && stopPresenting()}>
  {#if status === "ended"}
    <div class="ended">
      <h1>Näyttölinkki on päättynyt</h1>
      <p>Linkki on vanhentunut tai peruttu. Pyydä uusi linkki ryhmästä.</p>
    </div>
  {:else if !view}
    <p class="muted">Ladataan…</p>
  {:else}
    {#if showTitle || !embed}
      <header>
        <div class="titles">
          <h1>
            {#if view.photo && !photoFailed}
              <!-- fetched from Telegram by our server (src/web/photos.ts) -->
              <img class="group" src="/api/screen/photo" alt="" width="48" height="48" onerror={() => (photoFailed = true)} />
            {:else}
              <img src="/kili-256.jpg" alt="" width="48" height="48" />
            {/if}
            {view.title}
          </h1>
          {#if castError}<p class="muted" role="alert">{castError}</p>{/if}
          <p class="muted">Arvioidut promillet · {clock(view.now)}{status === "reconnecting" ? " · yhteys katkesi, yritetään uudelleen…" : ""}</p>
        </div>
        {#if !embed && !presenting}
          <div class="actions">
            {#if view.members.length > 1}
              <button class="btn toggle" aria-expanded={showBoard} aria-controls="board" onclick={toggleBoard}>
                <Icon name="list" /> {showBoard ? "Piilota tilanne" : "Näytä tilanne"}
              </button>
            {/if}
            <button
              class="btn toggle"
              disabled={!linkToken}
              onclick={cast}
              title={linkToken ? "Näytä kuvaaja Chromecastilla tai muulla näytöllä." : "Avaa näyttölinkki uudelleen, jotta voit lähettää kuvan."}
            >
              <Icon name="cast" /> {casting ? "Lähetetään…" : "Lähetä"}
            </button>
          
            <button class="btn toggle" onclick={present} title="Piilottaa painikkeet. Esc tai tuplaklikkaus palauttaa ne.">
              <Icon name="maximize" /> Koko näyttö
            </button>
          </div>
        {/if}
      </header>
    {/if}

    <div class="body" class:wide={!showBoard}>
      <section class="chart">
        {#if view.chart.lines.length}
          <Chart data={view.chart} big legend={showLegend} fill={fit} {scale} />
        {:else}
          <p class="empty">Ei juomia viimeisen vuorokauden aikana.</p>
        {/if}
      </section>

      {#if showBoard}
        <ol class="board" id="board" aria-label="Tilanne">
          {#each view.members.filter((m) => m.permille > 0.005) as m, i (m.name)}
            <li>
              <span class="rank">{i + 1}</span>
              <span class="name">{m.name}</span>
              <span class="value">{permille(m.permille)}<small>‰</small></span>
              <span class="muted drinks">{decimal1(m.standardDrinks12h)} ann.</span>
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  {/if}

  {#if !embed}
    {#if panelOpen && !presenting}
      <section class="panel" id="embed-panel" aria-labelledby="embed-title">
        <h2 id="embed-title"><Icon name="monitor" /> Upotus OBS:ään tai muuhun lähetysohjelmaan</h2>
        <p class="muted">
          Lisää OBS:ssä lähteeksi <strong>Selain</strong> (Browser) ja liitä osoitteeksi alla oleva linkki. Kuvaaja täyttää lähteen koon.
        </p>
        <div class="options">
          <label><input type="checkbox" bind:checked={opt.title} /> Otsikko</label>
          <label><input type="checkbox" bind:checked={opt.legend} /> Nimet kuvaajan yllä</label>
          <label><input type="checkbox" bind:checked={opt.board} /> Tilanne kuvaajan vieressä</label>
          {#if view?.groupId}<label><input type="checkbox" bind:checked={opt.qr} /> QR-koodi ryhmän sivulle</label>{/if}
          <label><input type="checkbox" bind:checked={opt.transparent} /> Läpinäkyvä tausta</label>
          <label class="select">Värit
            <select bind:value={opt.theme}>
              <option value="dark">Tumma</option>
              <option value="light">Vaalea</option>
              <option value="auto">Järjestelmän mukaan</option>
            </select>
          </label>
        </div>
        <div class="copyrow">
          <input type="text" readonly value={embedUrl} onfocus={(e) => e.currentTarget.select()} aria-label="Upotuslinkki" />
          <button class="btn" onclick={copyEmbed}><Icon name={copied ? "check" : "copy"} /> {copied ? "Kopioitu" : "Kopioi"}</button>
          {#if linkToken}<a class="btn" href={embedUrl} target="_blank" rel="noopener">Esikatsele</a>{/if}
        </div>
        {#if linkToken}
          <p class="muted small">Linkissä on näyttölinkin avain: jaa se vain lähetysohjelmaan.</p>
        {:else}
          <p class="muted small">
            Tämä sivu avattiin ilman näyttölinkkiä, joten linkistä puuttuu avain. Lisää perään alkuperäisen näyttölinkin <code>#t=…</code>-osa tai luo uusi näyttölinkki ryhmän sivulla.
          </p>
        {/if}
      </section>
    {/if}
  {/if}

  {#if !embed || showQr}
    <footer>
      <div class="info">
        {#if showQr}
          <figure class="qr">
            <figcaption>Ryhmän sivu</figcaption>
            <QrCode text={groupUrl} label="QR-koodi ryhmän sivulle" />
          </figure>
        {/if}
        {#if !embed}
      <div class="muted note">
        {#if view?.kind === "group"}
          <p>
            Nimet ja promillet näkyvät kaikille tämän näytön katsojille.
            Nimettömäksi pääsee lähettämällä botille yksityisviestinä <code>/nimeton</code> tai valitsemalla
            ryhmän sivulla <strong>Näytä minut näytöillä nimettömänä</strong> ({host}).
          </p>
        {/if}
        <p>Promillet ovat laskennallisia arvioita. Päivittyy automaattisesti.</p>
      </div>
        {/if}
      </div>
      {#if !embed}
      <div class="controls" class:hidden={presenting}>
        {#if view}
          <button class="theme" aria-expanded={panelOpen} aria-controls="embed-panel" onclick={() => (panelOpen = !panelOpen)}>OBS-upotus</button>
        {/if}
        <span class="themes" role="group" aria-label="Teema">
          {#each [["auto", "Auto"], ["dark", "Tumma"], ["light", "Vaalea"]] as [value, label]}
            <button class="theme" aria-pressed={theme === value} onclick={() => applyTheme(value as Theme)}>{label}</button>
          {/each}
        </span>
      </div>
      {/if}
    </footer>
  {/if}
</main>

<style>
  .screen {
    min-height: 100vh;
    padding: clamp(0.75rem, 2.5vw, 2rem);
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  /* fit (embed, fullscreen, or a roomy window): exactly the window, the chart taking what the
     heading and footer leave */
  .screen.fit {
    height: 100vh;
    min-height: 0;
    overflow: hidden;
  }
  .screen.embed {
    padding: clamp(0.5rem, 1.5vw, 1rem);
  }
  .fit .body {
    min-height: 0;
    grid-template-rows: minmax(0, 1fr);
    align-items: stretch;
  }
  .fit .chart {
    min-height: 0;
  }
  .fit .board {
    align-self: start;
    max-height: 100%;
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 1rem;
  }
  .titles {
    min-width: 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: end;
    gap: 0.5rem;
    flex: none;
  }
  .controls.hidden {
    display: none;
  }
  .toggle {
    flex: none;
    font-size: clamp(1rem, 1.3vw, calc(1.25rem * var(--k, 1)));
  }
  header h1 {
    display: flex;
    align-items: center;
    gap: 0.4em;
    font-size: clamp(1.8rem, 4.5vw, calc(3.5rem * var(--k, 1)));
    overflow-wrap: anywhere;
  }
  header img {
    width: 0.9em;
    height: 0.9em;
    flex: none;
    border-radius: 0.1em;
  }
  /* Telegram shows group photos round */
  header img.group {
    border-radius: 50%;
  }
  header p {
    margin: 0.2rem 0 0;
    font-size: clamp(1rem, 1.8vw, calc(1.4rem * var(--k, 1)));
  }
  .body {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(16rem, 1fr);
    gap: clamp(1rem, 2.5vw, 2.5rem);
    align-items: start;
    flex: 1;
  }
  /* board closed (or a person's screen): the chart gets the whole width */
  .body.wide {
    grid-template-columns: minmax(0, 1fr);
  }
  @media (max-width: 800px) {
    .body {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .empty {
    font-size: calc(1.6rem * var(--k, 1));
    color: var(--text-secondary);
  }
  .board {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.25rem;
  }
  .board li {
    display: grid;
    grid-template-columns: 2ch 1fr auto auto;
    gap: 0.9rem;
    align-items: baseline;
    padding: 0.55rem 0;
    border-bottom: 1px solid var(--border-soft);
    font-size: clamp(1.1rem, 2vw, calc(1.7rem * var(--k, 1)));
  }
  .rank {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .name {
    overflow-wrap: anywhere;
  }
  .value {
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .value small {
    font-size: 0.6em;
    color: var(--text-secondary);
    margin-left: 0.1em;
  }
  .drinks {
    font-size: 0.65em;
    white-space: nowrap;
  }
  .ended {
    margin: auto;
    text-align: center;
    max-width: 30rem;
  }

  .panel {
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface-2);
    padding: 1rem 1.25rem;
    display: grid;
    gap: 0.6rem;
  }
  .panel h2 {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 1.15rem;
  }
  .panel p {
    margin: 0;
  }
  .options {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1.25rem;
  }
  .options label {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }
  .options select {
    width: auto;
  }
  .copyrow {
    display: flex;
    gap: 0.5rem;
  }
  .small {
    font-size: 0.9rem;
  }

  footer {
    display: flex;
    justify-content: space-between;
    align-items: end;
    gap: 1rem;
    font-size: clamp(0.85rem, 1.1vw, calc(1rem * var(--k, 1)));
  }
  /* the QR code, then the notes, at the footer's left */
  .info {
    display: flex;
    align-items: end;
    gap: calc(1rem * var(--k, 1));
    min-width: 0;
  }
  .qr {
    flex: none;
    width: calc(5.5rem * var(--k, 1));
    margin: 0;
    text-align: center;
  }
  .qr figcaption {
    margin-bottom: 0.2rem;
    color: var(--text-secondary);
    font-size: 0.85em;
  }
  .note {
    max-width: calc(60rem * var(--k, 1));
  }
  .note p {
    margin: 0.2rem 0 0;
  }
  .controls {
    display: flex;
    gap: 0.75rem;
    flex: none;
  }
  .themes {
    display: flex;
    gap: 0.25rem;
  }
  .theme {
    background: var(--raised);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.25rem 0.6rem;
    color: var(--text-secondary);
  }
  .theme[aria-pressed="true"],
  .theme[aria-expanded="true"] {
    background: var(--surface-2);
    color: var(--text-primary);
  }
</style>
