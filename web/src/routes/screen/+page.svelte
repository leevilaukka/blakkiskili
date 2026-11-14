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
  import { canCast, castEnabled, castFailed, castScreen, castUnsupported } from "#lib/cast.ts";
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
  /** The board lists only people above zero. */
  const boardRows = $derived(view?.members.filter((m) => m.permille > 0.005) ?? []);

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
   * Moving the mouse shows the board toggle and an exit button until it stops again.
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

  /**
   * The mouse pointer (and the chart's hover tooltip) hides after a few seconds without moving,
   * so it doesn't sit on a TV's chart. Moving the mouse brings it back. Not while the OBS panel is
   * open, where it's in use.
   */
  let mouseStopped = $state(false);
  const mouseIdle = $derived(mouseStopped && !panelOpen);
  /** A mouse has moved in the last few seconds: while presenting, the header buttons show then. */
  let mouseSeen = $state(false);
  const cursorShown = $derived(mouseSeen && !mouseStopped);
  let mouseTimer: ReturnType<typeof setTimeout> | undefined;
  function onMouse(e: PointerEvent) {
    if (e.pointerType !== "mouse") return;
    mouseSeen = true;
    mouseStopped = false;
    clearTimeout(mouseTimer);
    mouseTimer = setTimeout(() => (mouseStopped = true), 3000);
  }

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
  const subtitle = "mt-0.75 mb-0 text-[clamp(1rem,1.8vw,calc(1.4rem*var(--k,1)))] text-secondary";
  const headerButton = "btn flex-none text-[clamp(1rem,1.3vw,calc(1.25rem*var(--k,1)))]";
  const themeButton =
    "rounded-sm border border-line bg-raised px-2.5 py-1 text-secondary aria-expanded:bg-surface-2 aria-expanded:text-fg aria-pressed:bg-surface-2 aria-pressed:text-fg";
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
    let wakeLock: WakeLockSentinel | undefined;
    let wakeLockPending = false;

    // Keep the display awake while it is showing the chart (where the browser allows it). The
    // browser releases the lock whenever the page is hidden (another tab, the screen turned off,
    // the TV's browser in the background), so it is asked for again each time the page is shown.
    const showing = () => !stopped && status !== "ended" && !!view;
    async function keepAwake() {
      if (!showing() || wakeLock || wakeLockPending) return;
      if (document.visibilityState !== "visible" || !("wakeLock" in navigator)) return;
      wakeLockPending = true;
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (!showing()) {
          lock.release().catch(() => {});
          return;
        }
        wakeLock = lock;
        lock.addEventListener("release", () => {
          if (wakeLock === lock) wakeLock = undefined;
        });
      } catch {
        // not allowed (e.g. battery saver) or not supported
      } finally {
        wakeLockPending = false;
      }
    }
    function letSleep() {
      wakeLock?.release().catch(() => {});
      wakeLock = undefined;
    }
    document.addEventListener("visibilitychange", keepAwake);

    function listen() {
      source = new EventSource("/api/screen/events");
      source.addEventListener("update", (e) => {
        view = JSON.parse((e as MessageEvent).data);
        status = "live";
      });
      source.addEventListener("end", () => {
        source?.close();
        status = "ended";
        letSleep();
      });
      source.onerror = async () => {
        if (status === "live") status = "reconnecting";
        try {
          await api.screen(); // the browser retries by itself; this only tells whether the link is gone
        } catch (e) {
          if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
            source?.close();
            status = "ended";
            letSleep();
          }
        }
      };
    }

    // A screen often starts on a TV whose connection is still coming up, or while the bot restarts.
    // Only an answer that the link is invalid ends it; anything else is retried, since the token
    // is already gone from the address bar and a reload couldn't bring it back.
    async function untilAnswered<T>(call: () => Promise<T>): Promise<T | undefined> {
      for (let delay = 2000; !stopped; delay = Math.min(delay * 2, 30_000)) {
        try {
          return await call();
        } catch (e) {
          if (e instanceof ApiError && [400, 401, 404].includes(e.status)) {
            status = "ended";
            return undefined;
          }
          status = "reconnecting";
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    async function start() {
      // The link is /screen#t=TOKEN: the token is exchanged for a cookie right away and removed
      // from the address bar and history (the search parameters stay). After that, reloading the
      // page keeps working.
      const token = new URLSearchParams(location.hash.slice(1)).get("t");
      if (token) {
        history.replaceState(null, "", location.pathname + location.search);
        if (!(await untilAnswered(() => api.openScreen(token)))) return;
        linkToken = token;
      }
      const first = await untilAnswered(() => api.screen());
      if (!first) return;
      view = first;
      status = "live";
      if (!stopped) listen();
      keepAwake();
    }
    start();

    return () => {
      stopped = true;
      source?.close();
      document.removeEventListener("visibilitychange", keepAwake);
      clearTimeout(mouseTimer);
      letSleep();
      document.documentElement.removeAttribute("data-bg");
    };
  });
</script>

<!-- Another screen link opened in a tab already on /screen only changes the fragment: start over with it -->
<svelte:window
  onhashchange={() => new URLSearchParams(location.hash.slice(1)).has("t") && location.reload()}
  bind:innerWidth
  bind:innerHeight
  onpointermove={onMouse}
  onpointerdown={onMouse}
/>
<svelte:document onfullscreenchange={onFullscreenChange} />

<svelte:head>
  <title>{view?.title ?? "Näyttö"} · Bläkkiskili</title>
  <meta name="referrer" content="no-referrer" />
</svelte:head>

<!-- fit (embed, fullscreen, or a roomy window): exactly the window, the chart taking what the
     heading and footer leave -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<main
  class={[
    "flex flex-col gap-4",
    fit ? "h-screen min-h-0 overflow-hidden" : "min-h-screen",
    embed ? "p-[clamp(0.5rem,1.5vw,1rem)]" : "p-[clamp(0.75rem,2.5vw,2rem)]",
    mouseIdle && "cursor-none **:cursor-none",
  ]}
  style:--k={scale}
  ondblclick={() => presenting && stopPresenting()}
>
  {#if status === "ended"}
    <div class="m-auto max-w-[30rem] text-center">
      <h1 class="tracking-normal">Näyttölinkki on päättynyt</h1>
      <p>Linkki on vanhentunut tai peruttu. Pyydä uusi linkki ryhmästä.</p>
    </div>
  {:else if !view}
    <p class="text-secondary">{status === "reconnecting" ? "Yhteys palvelimeen ei toimi, yritetään uudelleen…" : "Ladataan…"}</p>
  {:else}
    {#if showTitle || !embed}
      <header class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <h1 class="flex items-center gap-[0.4em] text-[clamp(1.8rem,4.5vw,calc(3.5rem*var(--k,1)))] tracking-normal wrap-anywhere">
            {#if view.photo && !photoFailed}
              <!-- fetched from Telegram by our server (src/web/photos.ts); Telegram shows group photos round -->
              <img class="size-[0.9em] flex-none rounded-full" src="/api/screen/photo" alt="" width="48" height="48" onerror={() => (photoFailed = true)} />
            {:else}
              <img class="size-[0.9em] flex-none rounded-[0.1em]" src="/kili-256.jpg" alt="" width="48" height="48" />
            {/if}
            {view.title}
          </h1>
          {#if castError}<p class={subtitle} role="alert">{castError}</p>{/if}
          <p class={subtitle}>Arvioidut promillet · {clock(view.now)}{status === "reconnecting" ? " · yhteys katkesi, yritetään uudelleen…" : ""}</p>
        </div>
        {#if !embed}
          <!-- presenting: only the board toggle and the way out, and only while the mouse moves;
               invisible rather than removed, so the heading doesn't reflow when they come and go -->
          <!-- the fade: visibility flips at the end of a fade-out and at the start of a fade-in -->
          <div
            class={[
              "flex flex-none flex-wrap justify-end gap-2 transition-[opacity,visibility] duration-200 motion-reduce:transition-none",
              presenting && !cursorShown && "invisible opacity-0",
            ]}
          >
            {#if view.members.length > 1}
              <button class={headerButton} aria-expanded={showBoard} aria-controls="board" onclick={toggleBoard}>
                <Icon name="list" /> {showBoard ? "Piilota tilanne" : "Näytä tilanne"}
              </button>
            {/if}
            {#if presenting}
              <button class={headerButton} onclick={stopPresenting}>
                <Icon name="minimize" /> Poistu kokoruudusta
              </button>
            {:else if castEnabled}
            <button
              class={headerButton}
              disabled={!linkToken}
              onclick={cast}
              title={linkToken ? "Näytä kuvaaja Chromecastilla tai muulla näytöllä." : "Avaa näyttölinkki uudelleen, jotta voit lähettää kuvan."}
            >
              <Icon name="cast" /> {casting ? "Lähetetään…" : "Lähetä"}
            </button>
            {/if}
            {#if !presenting}
              <button class={headerButton} onclick={present} title="Piilottaa painikkeet, kunnes hiirtä liikutetaan. Esc tai tuplaklikkaus palauttaa ne.">
                <Icon name="maximize" /> Koko näyttö
              </button>
            {/if}
          </div>
        {/if}
      </header>
    {/if}

    <!-- board closed (or a person's screen): the chart gets the whole width -->
    <div
      class={[
        "grid flex-1 gap-[clamp(1rem,2.5vw,2.5rem)]",
        showBoard ? "grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)] max-[800px]:grid-cols-[minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)]",
        fit ? "min-h-0 grid-rows-[minmax(0,1fr)] items-stretch" : "items-start",
      ]}
    >
      <section class={[fit && "min-h-0"]}>
        {#if view.chart.lines.length}
          <Chart data={view.chart} big legend={showLegend} fill={fit} {scale} {mouseIdle} />
        {:else}
          <p class="text-[calc(1.6rem*var(--k,1))] text-secondary">Ei juomia viimeisen vuorokauden aikana.</p>
        {/if}
      </section>

      {#if showBoard && !boardRows.length}
        <!-- everyone back at zero: say so, rather than leave the board's column empty -->
        <p class="m-0 self-start border-b border-line-soft py-2.25 text-[clamp(1.1rem,2vw,calc(1.7rem*var(--k,1)))] text-secondary" id="board">
          Kenelläkään ei ole nyt promilleja.
        </p>
      {:else if showBoard}
        <ol class={["grid gap-1", fit && "max-h-full self-start overflow-hidden"]} id="board" aria-label="Tilanne">
          {#each boardRows as m, i (m.name)}
            <li class="grid grid-cols-[2ch_1fr_auto_auto] items-baseline gap-3.5 border-b border-line-soft py-2.25 text-[clamp(1.1rem,2vw,calc(1.7rem*var(--k,1)))]">
              <span class="text-muted tabular-nums">{i + 1}</span>
              <span class="wrap-anywhere">{m.name}</span>
              <span class="font-bold tabular-nums">{permille(m.permille)}<small class="ml-[0.1em] text-[0.6em] text-secondary">‰</small></span>
              <span class="text-[0.65em] whitespace-nowrap text-secondary">{decimal1(m.standardDrinks12h)} ann.</span>
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  {/if}

  {#if !embed}
    {#if panelOpen && !presenting}
      <section class="grid gap-2.5 rounded-sm border border-line bg-surface-2 px-5 py-4" id="embed-panel" aria-labelledby="embed-title">
        <h2 class="flex items-center gap-2 text-[1.15rem]" id="embed-title"><Icon name="monitor" /> Upotus OBS:ään tai muuhun lähetysohjelmaan</h2>
        <p class="m-0 text-secondary">
          Lisää OBS:ssä lähteeksi <strong>Selain</strong> (Browser) ja liitä osoitteeksi alla oleva linkki. Kuvaaja täyttää lähteen koon.
        </p>
        <div class="flex flex-wrap items-center gap-x-5 gap-y-2 [&_label]:flex [&_label]:items-center [&_label]:gap-1.75">
          <label><input type="checkbox" bind:checked={opt.title} /> Otsikko</label>
          <label><input type="checkbox" bind:checked={opt.legend} /> Nimet kuvaajan yllä</label>
          <label><input type="checkbox" bind:checked={opt.board} /> Tilanne kuvaajan vieressä</label>
          {#if view?.groupId}<label><input type="checkbox" bind:checked={opt.qr} /> QR-koodi ryhmän sivulle</label>{/if}
          <label><input type="checkbox" bind:checked={opt.transparent} /> Läpinäkyvä tausta</label>
          <label>Värit
            <select class="w-auto" bind:value={opt.theme}>
              <option value="dark">Tumma</option>
              <option value="light">Vaalea</option>
              <option value="auto">Järjestelmän mukaan</option>
            </select>
          </label>
        </div>
        <div class="flex gap-2">
          <input type="text" readonly value={embedUrl} onfocus={(e) => e.currentTarget.select()} aria-label="Upotuslinkki" />
          <button class="btn" onclick={copyEmbed}><Icon name={copied ? "check" : "copy"} /> {copied ? "Kopioitu" : "Kopioi"}</button>
          {#if linkToken}<a class="btn" href={embedUrl} target="_blank" rel="noopener">Esikatsele</a>{/if}
        </div>
        {#if linkToken}
          <p class="m-0 text-[0.9rem] text-secondary">Linkissä on näyttölinkin avain: jaa se vain lähetysohjelmaan.</p>
        {:else}
          <p class="m-0 text-[0.9rem] text-secondary">
            Tämä sivu avattiin ilman näyttölinkkiä, joten linkistä puuttuu avain. Lisää perään alkuperäisen näyttölinkin <code>#t=…</code>-osa tai luo uusi näyttölinkki ryhmän sivulla.
          </p>
        {/if}
      </section>
    {/if}
  {/if}

  {#if !embed || showQr}
    <footer class="flex items-end justify-between gap-4 text-[clamp(0.85rem,1.1vw,calc(1rem*var(--k,1)))]">
      <!-- the QR code, then the notes, at the footer's left -->
      <div class="flex min-w-0 items-end gap-[calc(1rem*var(--k,1))]">
        {#if showQr}
          <figure class="m-0 w-[calc(5.5rem*var(--k,1))] flex-none text-center">
            <figcaption class="mb-0.75 text-[0.85em] text-secondary">Ryhmän sivu</figcaption>
            <QrCode text={groupUrl} label="QR-koodi ryhmän sivulle" />
          </figure>
        {/if}
        {#if !embed}
      <div class="max-w-[calc(60rem*var(--k,1))] text-secondary [&_p]:mt-0.75 [&_p]:mb-0">
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
      <div class={presenting ? "hidden" : "flex flex-none gap-3"}>
        {#if view}
          <button class={themeButton} aria-expanded={panelOpen} aria-controls="embed-panel" onclick={() => (panelOpen = !panelOpen)}>OBS-upotus</button>
        {/if}
        <span class="flex gap-1" role="group" aria-label="Teema">
          {#each [["auto", "Auto"], ["dark", "Tumma"], ["light", "Vaalea"]] as [value, label]}
            <button class={themeButton} aria-pressed={theme === value} onclick={() => applyTheme(value as Theme)}>{label}</button>
          {/each}
        </span>
      </div>
      {/if}
    </footer>
  {/if}
</main>
