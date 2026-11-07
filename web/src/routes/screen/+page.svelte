<script lang="ts">
  import { onMount } from "svelte";
  import type { ScreenView } from "../../../../shared/api.ts";
  import { api, ApiError } from "#lib/api.ts";
  import Chart from "#lib/Chart.svelte";
  import { clock, decimal1, permille } from "#lib/format.ts";

  let view = $state<ScreenView | null>(null);
  let status = $state<"loading" | "live" | "ended" | "reconnecting">("loading");
  let theme = $state<"auto" | "dark" | "light">("auto");

  function applyTheme(t: typeof theme) {
    theme = t;
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    try {
      localStorage.setItem("kili-screen-theme", t);
    } catch {}
  }

  onMount(() => {
    try {
      const saved = localStorage.getItem("kili-screen-theme");
      if (saved === "dark" || saved === "light") applyTheme(saved);
    } catch {}

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
      // from the address bar and history. After that, reloading the page keeps working.
      const token = new URLSearchParams(location.hash.slice(1)).get("t");
      if (token) {
        history.replaceState(null, "", location.pathname);
        try {
          await api.openScreen(token);
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
    };
  });
</script>

<svelte:head>
  <title>{view?.title ?? "Näyttö"} · Bläkkiskili</title>
  <meta name="referrer" content="no-referrer" />
</svelte:head>

<main class="screen">
  {#if status === "ended"}
    <div class="ended">
      <h1>Näyttölinkki on päättynyt</h1>
      <p>Linkki on vanhentunut tai peruttu. Pyydä uusi linkki ryhmästä.</p>
    </div>
  {:else if !view}
    <p class="muted">Ladataan…</p>
  {:else}
    <header>
      <h1>{view.title}</h1>
      <p class="muted">Arvioidut promillet · {clock(view.now)}{status === "reconnecting" ? " · yhteys katkesi, yritetään uudelleen…" : ""}</p>
    </header>

    <div class="body" class:person={view.kind === "person"}>
      <section class="chart">
        {#if view.chart.lines.length}
          <Chart data={view.chart} big />
        {:else}
          <p class="empty">Ei juomia viimeisen vuorokauden aikana.</p>
        {/if}
      </section>

      {#if view.members.length > 1}
        <ol class="board" aria-label="Tilanne">
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

  <footer>
    <span class="muted">Päivittyy automaattisesti</span>
    <span class="themes" role="group" aria-label="Teema">
      {#each [["auto", "Auto"], ["dark", "Tumma"], ["light", "Vaalea"]] as [value, label]}
        <button class="theme" aria-pressed={theme === value} onclick={() => applyTheme(value as typeof theme)}>{label}</button>
      {/each}
    </span>
  </footer>
</main>

<style>
  .screen {
    min-height: 100vh;
    padding: clamp(0.75rem, 2.5vw, 2rem);
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  header h1 {
    font-size: clamp(1.8rem, 4.5vw, 3.5rem);
  }
  header p {
    margin: 0.2rem 0 0;
    font-size: clamp(1rem, 1.8vw, 1.4rem);
  }
  .body {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(16rem, 1fr);
    gap: clamp(1rem, 2.5vw, 2.5rem);
    align-items: start;
    flex: 1;
  }
  .body.person {
    grid-template-columns: minmax(0, 1fr);
  }
  @media (max-width: 800px) {
    .body {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .empty {
    font-size: 1.6rem;
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
    border-bottom: 1px solid var(--border);
    font-size: clamp(1.1rem, 2vw, 1.7rem);
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
  footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    font-size: 0.85rem;
  }
  .themes {
    display: flex;
    gap: 0.25rem;
  }
  .theme {
    background: none;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.25rem 0.6rem;
    color: var(--text-secondary);
  }
  .theme[aria-pressed="true"] {
    background: var(--surface-2);
    color: var(--text-primary);
  }
</style>
