<script lang="ts">
  // Estimated permilles over time, drawn from the API's JSON (the same numbers as the bot's
  // /kuvaaja picture). Past solid, forecast dashed on a light wash, a "nyt" marker, hairline grid
  // and one y axis. Identity is never colour alone: two or more people always get a legend with
  // each current value, and up to four also get direct labels at the "now" dot.
  //
  // Colours come from CSS classes (s1..s10 → --series-n), so dark mode swaps in its own validated
  // steps and the page's Content-Security-Policy needs no inline styles.
  import type { ChartData } from "../../../shared/api.ts";
  import { clock, permille } from "./format.ts";

  let { data, big = false }: { data: ChartData; big?: boolean } = $props();

  const HOUR = 3_600_000;
  const EPS = 0.005;
  // The bot chart's light-mode palette order; a line's slot decides its colour in both modes.
  const LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948", "#8c564b", "#17becf"];
  const slot = (hex: string) => Math.max(0, LIGHT.indexOf(hex)) + 1;

  let width = $state(640);
  let viewportHeight = $state(900);
  const W = $derived(Math.max(width, 300));
  // The big (event screen) chart fills what the window leaves below the heading and legend.
  const H = $derived(big ? Math.min(Math.max(viewportHeight - 300, 300), 640) : 300);
  const M = $derived({ top: 18, right: 16, bottom: 30, left: 44 });

  const floorHour = (t: number) => t - (t % HOUR);
  const ceilHour = (t: number) => (t % HOUR === 0 ? t : floorHour(t) + HOUR);

  const lines = $derived(data.lines);
  const view = $derived.by(() => {
    const times = lines.flatMap((l) => l.points.filter((p) => p[1] > EPS).map((p) => p[0]));
    if (times.length === 0) return { start: data.now - 6 * HOUR, end: data.now + 2 * HOUR };
    let start = Math.max(data.from, floorHour(Math.min(...times) - HOUR));
    let end = Math.min(data.to, ceilHour(Math.max(Math.max(...times) + 30 * 60_000, data.now + 2 * HOUR)));
    if (end - start < 6 * HOUR) start = Math.max(data.from, end - 6 * HOUR);
    if (end - start < 6 * HOUR) end = Math.min(data.to, start + 6 * HOUR);
    return { start, end };
  });

  const yStep = $derived.by(() => {
    const raw = Math.max(0.5, ...lines.map((l) => l.peak)) * 1.08;
    return [0.1, 0.2, 0.25, 0.5, 1, 2].find((s) => raw / s <= 6) ?? 5;
  });
  const yMax = $derived(Math.ceil((Math.max(0.5, ...lines.map((l) => l.peak)) * 1.08) / yStep) * yStep);
  const yTicks = $derived(Array.from({ length: Math.round(yMax / yStep) + 1 }, (_, i) => +(i * yStep).toFixed(2)));

  const x = (t: number) => M.left + ((t - view.start) / (view.end - view.start)) * (W - M.left - M.right);
  const y = (v: number) => H - M.bottom - (v / yMax) * (H - M.top - M.bottom);
  const nowX = $derived(x(data.now));

  const hourTicks = $derived.by(() => {
    const spanH = (view.end - view.start) / HOUR;
    const step = [1, 2, 3, 4, 6].find((s) => spanH / s <= (W - M.left - M.right) / 44) ?? 6;
    const out: { t: number; label: string }[] = [];
    for (let t = ceilHour(view.start); t <= view.end; t += HOUR) {
      const h = new Date(t).getHours();
      if (h % step === 0) out.push({ t, label: String(h) });
    }
    return out;
  });

  /** Drops the flat zero runs at both ends (keeping one zero point) so lines don't pile up on the axis. */
  function trimmed(points: [number, number][]): [number, number][] {
    const inView = points.filter((p) => p[0] >= view.start && p[0] <= view.end);
    const first = inView.findIndex((p) => p[1] > EPS);
    if (first === -1) return [];
    let last = inView.length - 1;
    while (inView[last]![1] <= EPS) last -= 1;
    return inView.slice(Math.max(0, first - 1), Math.min(inView.length, last + 2));
  }
  const path = (pts: [number, number][]) => pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");

  const drawn = $derived(
    lines.map((l) => {
      const pts = trimmed(l.points);
      return {
        line: l,
        cls: `s${slot(l.color)}`,
        past: path(pts.filter((p) => p[0] <= data.now)),
        future: path(pts.filter((p) => p[0] >= data.now)),
        hasPast: pts.filter((p) => p[0] <= data.now).length > 1,
        hasFuture: pts.filter((p) => p[0] >= data.now).length > 1,
      };
    }),
  );

  // Direct labels at the "now" dot (up to four people), pushed apart with leader lines.
  const direct = $derived(lines.length > 0 && lines.length <= 4);
  const labels = $derived.by(() => {
    if (!direct) return [];
    const items = drawn
      .map((d) => ({
        d,
        dotY: y(d.line.current),
        y: y(d.line.current) - 10,
        text: lines.length === 1 ? `${permille(d.line.current)}‰` : `${truncate(d.line.name, 16)} ${permille(d.line.current)}‰`,
      }))
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < items.length; i++) items[i]!.y = Math.max(items[i]!.y, items[i - 1]!.y + 17);
    for (const it of items) it.y = Math.min(Math.max(it.y, M.top + 14), H - M.bottom - 4);
    for (let i = items.length - 2; i >= 0; i--) items[i]!.y = Math.min(items[i]!.y, items[i + 1]!.y - 17);
    const chars = Math.max(...items.map((i) => [...i.text].length));
    const toRight = nowX + 10 + chars * 7.4 <= W - M.right;
    return items.map((it) => ({ ...it, toRight, lx: toRight ? nowX + 10 : nowX - 10 }));
  });
  const truncate = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s);

  // ---------- hover / keyboard ----------
  const times = $derived(lines[0]?.points.map((p) => p[0]) ?? []);
  let cursor = $state<number | null>(null); // index into times
  const cursorT = $derived(cursor === null ? null : (times[cursor] ?? null));

  function nearest(px: number): number | null {
    let best: number | null = null;
    let bestD = Infinity;
    times.forEach((t, i) => {
      const d = Math.abs(x(t) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }
  function onMove(e: PointerEvent) {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    cursor = nearest(((e.clientX - r.left) / r.width) * W);
  }
  function onKey(e: KeyboardEvent) {
    if (times.length === 0) return;
    const now = times.indexOf(data.now);
    if (e.key === "ArrowLeft") cursor = Math.max(0, (cursor ?? now) - 1);
    else if (e.key === "ArrowRight") cursor = Math.min(times.length - 1, (cursor ?? now) + 1);
    else if (e.key === "Escape") cursor = null;
    else return;
    e.preventDefault();
  }
  const tipLeft = $derived(cursorT === null ? 0 : Math.min(Math.max(x(cursorT), 90), W - 90));
  const valueAt = (l: (typeof lines)[number], t: number) => l.points.find((p) => p[0] === t)?.[1] ?? 0;
  const summary = $derived(lines.map((l) => `${l.name} ${permille(l.current)} promillea`).join(", "));
</script>

<svelte:window bind:innerHeight={viewportHeight} />

<figure class="chart" class:big>
  {#if lines.length >= 2}
    <ul class="legend">
      {#each drawn as d (d.line.id)}
        <li>
          <svg class="key {d.cls}" width="22" height="10" viewBox="0 0 22 10" aria-hidden="true">
            <line x1="1" x2="21" y1="5" y2="5" /><circle cx="11" cy="5" r="4" />
          </svg>
          <span class="name">{d.line.name}</span>
          <span class="val">{permille(d.line.current)}‰</span>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="plot" bind:clientWidth={width}>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <svg
      viewBox="0 0 {W} {H}"
      width={W}
      height={H}
      role="group"
      aria-label="Arvioitu promillekäyrä. {summary}. Nuolinäppäimillä voit selata hetkiä."
      tabindex="0"
      onpointermove={onMove}
      onpointerleave={() => (cursor = null)}
      onkeydown={onKey}
      onblur={() => (cursor = null)}
    >
      <rect class="wash" x={nowX} y={M.top} width={Math.max(0, W - M.right - nowX)} height={H - M.top - M.bottom} />
      <text class="muted" x={W - M.right - 6} y={M.top + 16} text-anchor="end">ennuste</text>

      {#each yTicks as v}
        <line class="grid" class:zero={v === 0} x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} />
        <text class="muted" x={M.left - 8} y={y(v) + 4} text-anchor="end">{permille(v)}</text>
      {/each}
      {#each hourTicks as h}
        <line class="grid" x1={x(h.t)} x2={x(h.t)} y1={M.top} y2={H - M.bottom} />
        <text class="muted" x={x(h.t)} y={H - M.bottom + 20} text-anchor="middle">{h.label}</text>
      {/each}

      <line class="nowline" x1={nowX} x2={nowX} y1={M.top} y2={H - M.bottom} />
      <text class="secondary" x={nowX} y={M.top - 5} text-anchor="middle">nyt</text>

      {#each drawn as d (d.line.id)}
        {#if d.hasPast}<path class="line {d.cls}" d={d.past} />{/if}
        {#if d.hasFuture}<path class="line future {d.cls}" d={d.future} />{/if}
      {/each}

      {#if cursorT !== null}
        <line class="cross" x1={x(cursorT)} x2={x(cursorT)} y1={M.top} y2={H - M.bottom} />
        {#each drawn as d (d.line.id)}
          <circle class="dot {d.cls}" cx={x(cursorT)} cy={y(valueAt(d.line, cursorT))} r="4.5" />
        {/each}
      {:else}
        {#each drawn as d (d.line.id)}
          <circle class="dot {d.cls}" cx={nowX} cy={y(d.line.current)} r="4.5" />
        {/each}
      {/if}

      {#if cursorT === null}
        {#each labels as l (l.d.line.id)}
          {#if Math.abs(l.y - 4 - l.dotY) > 12}
            <line class="leader" x1={nowX} y1={l.dotY} x2={l.lx + (l.toRight ? -2 : 2)} y2={l.y - 4} />
          {/if}
          <text class="direct" x={l.lx} y={l.y} text-anchor={l.toRight ? "start" : "end"}>{l.text}</text>
        {/each}
      {/if}
      <!-- the pointer target covers the whole plot, not just the painted pixels -->
      <rect class="hit" x={M.left} y={M.top} width={W - M.left - M.right} height={H - M.top - M.bottom} />
    </svg>

    {#if cursorT !== null}
      <div class="tip" style:left="{tipLeft}px" role="status">
        <div class="when">{clock(cursorT)}{cursorT > data.now ? " · ennuste" : ""}</div>
        {#each [...drawn].sort((a, b) => valueAt(b.line, cursorT!) - valueAt(a.line, cursorT!)) as d (d.line.id)}
          <div class="row">
            <svg class="key {d.cls}" width="14" height="8" viewBox="0 0 14 8" aria-hidden="true"><line x1="0" x2="14" y1="4" y2="4" /></svg>
            <strong>{permille(valueAt(d.line, cursorT))}‰</strong>
            {#if lines.length > 1}<span class="name">{d.line.name}</span>{/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#if !big}
  <details class="table">
    <summary>Taulukko</summary>
    <table>
      <thead><tr><th>Nimi</th><th>Nyt</th><th>Huippu</th></tr></thead>
      <tbody>
        {#each lines as l (l.id)}
          <tr><td>{l.name}</td><td>{permille(l.current)}‰</td><td>{permille(l.peak)}‰</td></tr>
        {/each}
      </tbody>
    </table>
  </details>
  {/if}
</figure>

<style>
  .chart {
    margin: 0;
  }
  .plot {
    position: relative;
  }
  svg {
    display: block;
    width: 100%;
    height: auto;
    font-size: 12px;
    touch-action: pan-y;
  }
  svg:focus-visible {
    outline-offset: 4px;
  }
  .big svg {
    font-size: 15px;
  }

  .grid {
    stroke: var(--border);
    stroke-width: 1;
  }
  .grid.zero {
    stroke: var(--axis);
  }
  .muted {
    fill: var(--text-muted);
  }
  .secondary {
    fill: var(--text-secondary);
  }
  .wash {
    fill: var(--surface-2);
    opacity: 0.7;
  }
  .nowline {
    stroke: var(--text-muted);
    stroke-width: 1;
  }
  .cross {
    stroke: var(--text-secondary);
    stroke-width: 1;
  }
  .hit {
    fill: transparent;
  }
  .line {
    fill: none;
    stroke: var(--c);
    stroke-width: 2.5;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .line.future {
    stroke-dasharray: 2 6;
  }
  .dot {
    fill: var(--c);
    stroke: var(--surface-1);
    stroke-width: 2;
  }
  .leader {
    stroke: var(--text-muted);
    stroke-width: 1;
  }
  /* labels are text-token ink with a surface halo, never the series colour */
  .direct {
    fill: var(--text-primary);
    stroke: var(--surface-1);
    stroke-width: 4;
    stroke-linejoin: round;
    paint-order: stroke;
    font-size: 13px;
  }
  .big .direct {
    font-size: 17px;
  }

  .legend {
    list-style: none;
    margin: 0 0 0.5rem;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1.1rem;
    font-size: 0.9rem;
  }
  .big .legend {
    font-size: 1.2rem;
    gap: 0.4rem 1.6rem;
  }
  .legend li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .legend .val {
    color: var(--text-secondary);
  }
  .key {
    width: auto;
    height: auto;
    flex: none;
  }
  .key line {
    stroke: var(--c);
    stroke-width: 2;
    stroke-linecap: round;
  }
  .key circle {
    fill: var(--c);
  }

  .tip {
    position: absolute;
    top: 0;
    transform: translateX(-50%);
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.4rem 0.6rem;
    font-size: 0.85rem;
    pointer-events: none;
    box-shadow: 0 2px 8px rgb(0 0 0 / 12%);
    white-space: nowrap;
    max-width: 90vw;
  }
  .tip .when {
    color: var(--text-secondary);
    font-size: 0.78rem;
  }
  .tip .row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .tip .name {
    color: var(--text-secondary);
  }

  .table {
    margin-top: 0.5rem;
    font-size: 0.9rem;
    color: var(--text-secondary);
  }
  .table table {
    border-collapse: collapse;
    margin-top: 0.4rem;
    width: 100%;
  }
  .table th,
  .table td {
    text-align: left;
    padding: 0.25rem 0.5rem 0.25rem 0;
    border-bottom: 1px solid var(--border);
  }

  .s1 { --c: var(--series-1); }
  .s2 { --c: var(--series-2); }
  .s3 { --c: var(--series-3); }
  .s4 { --c: var(--series-4); }
  .s5 { --c: var(--series-5); }
  .s6 { --c: var(--series-6); }
  .s7 { --c: var(--series-7); }
  .s8 { --c: var(--series-8); }
  .s9 { --c: var(--series-9); }
  .s10 { --c: var(--series-10); }
</style>
