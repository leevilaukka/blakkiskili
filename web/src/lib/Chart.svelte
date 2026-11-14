<script lang="ts">
  // Estimated permilles over time, drawn from the API's JSON (the same numbers as the bot's
  // /kuvaaja picture). Past solid, forecast dashed on a light wash, a "nyt" marker, hairline grid
  // and one y axis. Identity is never colour alone: everyone is in the legend with their current
  // value, and up to four people also get direct labels at the "now" dot.
  //
  // Colours come from classes (series-1..10 set --c to --color-series-n, see app.css), so dark mode
  // swaps in its own validated steps and the page's Content-Security-Policy needs no inline styles.
  import type { ChartData } from "../../../shared/api.ts";
  import { clock, permille } from "./format.ts";

  let {
    data,
    big = false,
    legend = true,
    fill = false,
    scale = 1,
  }: {
    data: ChartData;
    big?: boolean;
    /** The names-and-values list above the plot. */
    legend?: boolean;
    /** The plot takes the height its container gives it (the event screen's embed view). */
    fill?: boolean;
    /** Text, margins, lines and dots grow by this (the event screen on a big display). */
    scale?: number;
  } = $props();

  const HOUR = 3_600_000;
  const EPS = 0.005;
  // The bot chart's light-mode palette order; a line's slot decides its colour in both modes.
  const LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948", "#8c564b", "#17becf"];
  const SERIES = ["series-1", "series-2", "series-3", "series-4", "series-5", "series-6", "series-7", "series-8", "series-9", "series-10"];
  const seriesClass = (hex: string) => SERIES[Math.max(0, LIGHT.indexOf(hex))]!;

  let width = $state(640);
  let viewportHeight = $state(900);
  let plotHeight = $state(0);
  const W = $derived(Math.max(width, 300));
  // The big (event screen) chart fills what the window leaves below the heading and legend; a
  // filling one is exactly as tall as its box.
  const H = $derived(
    fill
      ? Math.max(Math.floor(plotHeight), 160)
      : big
        ? Math.min(Math.max(viewportHeight - 300, 300), 640)
        : Math.round(Math.min(Math.max(W * 0.5, 280), 460)),
  );
  const k = $derived(scale);
  const M = $derived({ top: 18 * k, right: 16 * k, bottom: 30 * k, left: 44 * k });

  const floorHour = (t: number) => t - (t % HOUR);
  const ceilHour = (t: number) => (t % HOUR === 0 ? t : floorHour(t) + HOUR);

  const lines = $derived(data.lines);
  const view = $derived.by(() => {
    const times = lines.flatMap((l) => l.points.filter((p) => p[1] > EPS).map((p) => p[0]));
    if (times.length === 0) return { start: data.now - 6 * HOUR, end: data.now + 2 * HOUR };
    let start = Math.max(data.from, floorHour(Math.min(...times) - HOUR));
    const tail = Math.max(...times) + 30 * 60_000;
    let end = Math.min(data.to, ceilHour(data.history ? tail : Math.max(tail, data.now + 2 * HOUR)));
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
    const step = [1, 2, 3, 4, 6].find((s) => spanH / s <= (W - M.left - M.right) / (44 * k)) ?? 6;
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
        cls: seriesClass(l.color),
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
        y: y(d.line.current) - 10 * k,
        text: lines.length === 1 ? `${permille(d.line.current)}‰` : `${truncate(d.line.name, 16)} ${permille(d.line.current)}‰`,
      }))
      .sort((a, b) => a.y - b.y);
    const gap = 17 * k;
    for (let i = 1; i < items.length; i++) items[i]!.y = Math.max(items[i]!.y, items[i - 1]!.y + gap);
    for (const it of items) it.y = Math.min(Math.max(it.y, M.top + 14 * k), H - M.bottom - 4 * k);
    for (let i = items.length - 2; i >= 0; i--) items[i]!.y = Math.min(items[i]!.y, items[i + 1]!.y - gap);
    const chars = Math.max(...items.map((i) => [...i.text].length));
    const toRight = nowX + 10 * k + chars * 7.4 * k <= W - M.right;
    return items.map((it) => ({ ...it, toRight, lx: toRight ? nowX + 10 * k : nowX - 10 * k }));
  });
  const lineClass = "fill-none stroke-(--c) [stroke-width:calc(2.5px*var(--k,1))] [stroke-linecap:round] [stroke-linejoin:round]";
  const dotClass = "fill-(--c) stroke-surface-1 [stroke-width:calc(2px*var(--k,1))]";
  const truncate = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s);

  // ---------- hover / touch / keyboard ----------
  // A mouse shows the moment under it while hovering. A finger taps or drags sideways to pick a
  // moment, which stays after lifting (the finger no longer covers it) until a tap elsewhere; a
  // vertical swipe still scrolls the page (touch-action: pan-y), and the browser taking the
  // gesture over (pointercancel) hides it.
  const times = $derived(lines[0]?.points.map((p) => p[0]) ?? []);
  let cursor = $state<number | null>(null); // index into times
  const cursorT = $derived(cursor === null ? null : (times[cursor] ?? null));
  let plot: SVGSVGElement | undefined = $state();

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
  function pick(e: PointerEvent) {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    cursor = nearest(((e.clientX - r.left) / r.width) * W);
  }
  /** A tap: pointerup rather than pointerdown, so a scroll that starts on the chart shows nothing. */
  function onUp(e: PointerEvent) {
    if (e.pointerType !== "mouse") pick(e);
  }
  function onLeave(e: PointerEvent) {
    if (e.pointerType === "mouse") cursor = null;
  }
  /** A tap anywhere else hides a moment picked by touch. */
  function onWindowDown(e: PointerEvent) {
    if (cursor !== null && plot && !plot.contains(e.target as Node)) cursor = null;
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
  const summary = $derived(lines.map((l) => (data.history ? `${l.name} huippu ${permille(l.peak)} promillea` : `${l.name} ${permille(l.current)} promillea`)).join(", "));
</script>

<svelte:window bind:innerHeight={viewportHeight} onpointerdown={onWindowDown} />

<!-- --k: the scale prop, for a big display -->
<figure class={["m-0", fill && "flex h-full flex-col"]} style:--k={k}>
  {#if legend && lines.length >= 1}
    <ul
      class={[
        "mb-2 flex flex-wrap",
        big ? "gap-x-[calc(1.6rem*var(--k,1))] gap-y-[calc(0.4rem*var(--k,1))] text-[calc(1.2rem*var(--k,1))]" : "gap-x-[1.1rem] gap-y-1 text-[0.9rem]",
      ]}
    >
      {#each drawn as d (d.line.id)}
        <li class={["flex items-center", big ? "gap-[calc(0.4rem*var(--k,1))]" : "gap-1.5"]}>
          <svg
            class={["block flex-none", d.cls, big && "h-[calc(10px*var(--k,1))] w-[calc(22px*var(--k,1))]"]}
            width="22"
            height="10"
            viewBox="0 0 22 10"
            aria-hidden="true"
          >
            <line class="stroke-(--c) stroke-2 [stroke-linecap:round]" x1="1" x2="21" y1="5" y2="5" /><circle class="fill-(--c)" cx="11" cy="5" r="4" />
          </svg>
          <span>{d.line.name}</span>
          <span class="text-secondary">{permille(d.line.current)}‰</span>
        </li>
      {/each}
    </ul>
  {/if}

  <div class={["relative", fill && "min-h-0 flex-1 overflow-hidden"]} bind:clientWidth={width} bind:clientHeight={plotHeight}>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <svg
      bind:this={plot}
      class={["block h-auto w-full touch-pan-y touch-pinch-zoom select-none focus-visible:outline-offset-4 [-webkit-touch-callout:none]", big ? "text-[calc(15px*var(--k,1))]" : "text-[12px]"]}
      viewBox="0 0 {W} {H}"
      width={W}
      height={H}
      role="group"
      aria-label="Arvioitu promillekäyrä. {summary}. Nuolinäppäimillä voit selata hetkiä."
      tabindex="0"
      onpointermove={pick}
      onpointerup={onUp}
      onpointerleave={onLeave}
      onpointercancel={() => (cursor = null)}
      onkeydown={onKey}
      onblur={() => (cursor = null)}
    >
      {#if !data.history}
        <rect class="fill-surface-2 opacity-70" x={nowX} y={M.top} width={Math.max(0, W - M.right - nowX)} height={H - M.top - M.bottom} />
        <text class="fill-muted" x={W - M.right - 6 * k} y={M.top + 16 * k} text-anchor="end">ennuste</text>
      {/if}

      {#each yTicks as v}
        <line class={["stroke-1", v === 0 ? "stroke-axis" : "stroke-line"]} x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} />
        <text class="fill-muted" x={M.left - 8 * k} y={y(v) + 4 * k} text-anchor="end">{permille(v)}</text>
      {/each}
      {#each hourTicks as h}
        <line class="stroke-line stroke-1" x1={x(h.t)} x2={x(h.t)} y1={M.top} y2={H - M.bottom} />
        <text class="fill-muted" x={x(h.t)} y={H - M.bottom + 20 * k} text-anchor="middle">{h.label}</text>
      {/each}

      {#if !data.history}
        <line class="stroke-muted stroke-1" x1={nowX} x2={nowX} y1={M.top} y2={H - M.bottom} />
        <text class="fill-secondary" x={nowX} y={M.top - 5 * k} text-anchor="middle">nyt</text>
      {/if}

      {#each drawn as d (d.line.id)}
        {#if d.hasPast}<path class={[lineClass, d.cls]} d={d.past} />{/if}
        {#if d.hasFuture}<path class={[lineClass, "[stroke-dasharray:2_6]", d.cls]} d={d.future} />{/if}
      {/each}

      {#if cursorT !== null}
        <line class="stroke-secondary stroke-1" x1={x(cursorT)} x2={x(cursorT)} y1={M.top} y2={H - M.bottom} />
        {#each drawn as d (d.line.id)}
          <circle class={[dotClass, d.cls]} cx={x(cursorT)} cy={y(valueAt(d.line, cursorT))} r={4.5 * k} />
        {/each}
      {:else if !data.history}
        {#each drawn as d (d.line.id)}
          <circle class={[dotClass, d.cls]} cx={nowX} cy={y(d.line.current)} r={4.5 * k} />
        {/each}
      {/if}

      {#if cursorT === null && !data.history}
        {#each labels as l (l.d.line.id)}
          {#if Math.abs(l.y - 4 * k - l.dotY) > 12 * k}
            <line class="stroke-muted stroke-1" x1={nowX} y1={l.dotY} x2={l.lx + (l.toRight ? -2 : 2) * k} y2={l.y - 4 * k} />
          {/if}
          <!-- labels are text-token ink with a surface halo, never the series colour -->
          <text
            class={[
              "fill-fg stroke-surface-1 [paint-order:stroke] [stroke-linejoin:round]",
              big ? "text-[calc(17px*var(--k,1))] [stroke-width:calc(4px*var(--k,1))]" : "stroke-4 text-[13px]",
            ]}
            x={l.lx}
            y={l.y}
            text-anchor={l.toRight ? "start" : "end"}>{l.text}</text
          >
        {/each}
      {/if}
      <!-- the pointer target covers the whole plot, not just the painted pixels -->
      <rect class="fill-transparent" x={M.left} y={M.top} width={W - M.left - M.right} height={H - M.top - M.bottom} />
    </svg>

    {#if cursorT !== null}
      <div
        class="pointer-events-none absolute top-0 max-w-[90vw] -translate-x-1/2 rounded-lg border border-line bg-surface-1 px-2.5 py-1.5 text-[0.85rem] whitespace-nowrap shadow-[0_2px_8px_rgb(0_0_0/12%)]"
        style:left="{tipLeft}px"
        role="status"
      >
        <div class="text-[0.78rem] text-secondary">{clock(cursorT)}{cursorT > data.now ? " · ennuste" : ""}</div>
        {#each [...drawn].sort((a, b) => valueAt(b.line, cursorT!) - valueAt(a.line, cursorT!)) as d (d.line.id)}
          <div class="flex items-center gap-1.5">
            <svg class={["block flex-none", d.cls]} width="14" height="8" viewBox="0 0 14 8" aria-hidden="true"
              ><line class="stroke-(--c) stroke-2 [stroke-linecap:round]" x1="0" x2="14" y1="4" y2="4" /></svg
            >
            <strong>{permille(valueAt(d.line, cursorT))}‰</strong>
            {#if lines.length > 1}<span class="text-secondary">{d.line.name}</span>{/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#if !big}
    <details class="mt-2 text-[0.9rem] text-secondary">
      <summary>Taulukko</summary>
      <table class="mt-1.5 w-full border-collapse [&_:is(th,td)]:border-b [&_:is(th,td)]:border-line [&_:is(th,td)]:py-1 [&_:is(th,td)]:pr-2 [&_:is(th,td)]:text-left">
        <thead><tr><th>Nimi</th>{#if !data.history}<th>Nyt</th>{/if}<th>Huippu</th></tr></thead>
        <tbody>
          {#each lines as l (l.id)}
            <tr><td>{l.name}</td>{#if !data.history}<td>{permille(l.current)}‰</td>{/if}<td>{permille(l.peak)}‰</td></tr>
          {/each}
        </tbody>
      </table>
    </details>
  {/if}
</figure>
