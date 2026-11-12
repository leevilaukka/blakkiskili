<script lang="ts">
  import { dayAndTime, readDate, readTime, showDate, showTime } from "#lib/fidate.ts";
  import Icon from "#lib/Icon.svelte";

  // A date or a time typed in Finnish format; dates also have a calendar (Monday first, Finnish
  // names), because the browser's own picker follows the browser's language. `value` is an ISO day
  // or "HH:MM" ("" while empty); `min` and `max` are ISO days and only apply to dates.
  let {
    kind,
    value = $bindable(""),
    min,
    max,
    label,
    onchange,
  }: { kind: "date" | "time"; value?: string; min?: string; max?: string; label: string; onchange?: (value: string) => void } = $props();

  let text = $state("");
  let invalid = $state(false);
  let shown = ""; // what `text` was last made from, so typing isn't overwritten

  // Follow changes from outside (a range button, a reset).
  $effect(() => {
    if (value !== shown) {
      shown = value;
      text = kind === "date" ? showDate(value) : showTime(value);
      invalid = false;
    }
  });

  function set(iso: string) {
    shown = iso;
    value = iso;
    text = kind === "date" ? showDate(iso) : showTime(iso);
    invalid = false;
    onchange?.(iso);
  }

  function commit() {
    const read = text.trim() === "" ? "" : kind === "date" ? readDate(text) : readTime(text);
    invalid = read === null || (kind === "date" && !!read && isOut(read));
    if (!invalid) set(read ?? "");
  }

  const isOut = (iso: string) => (!!min && iso < min) || (!!max && iso > max);

  // ---- calendar ----
  const pad = (n: number) => String(n).padStart(2, "0");
  const WEEKDAYS = ["Ma", "Ti", "Ke", "To", "Pe", "La", "Su"];
  const monthName = new Intl.DateTimeFormat("fi-FI", { month: "long", year: "numeric" });
  let open = $state(false);
  let year = $state(0);
  let month = $state(0); // 0-11
  let root: HTMLElement | undefined;

  function toggle() {
    open = !open;
    if (!open) return;
    const [y, m] = (value || max || dayAndTime(Date.now()).day).split("-").map(Number);
    year = y!;
    month = m! - 1;
  }

  function step(by: number) {
    const d = new Date(year, month + by, 1);
    year = d.getFullYear();
    month = d.getMonth();
  }

  const today = $derived(dayAndTime(Date.now()).day);
  // Blank cells up to the first weekday, then the days.
  const cells = $derived.by(() => {
    const lead = (new Date(year, month, 1).getDay() + 6) % 7;
    const count = new Date(year, month + 1, 0).getDate();
    return [...Array<null>(lead).fill(null), ...Array.from({ length: count }, (_, i) => `${year}-${pad(month + 1)}-${pad(i + 1)}`)];
  });
  // Months with no selectable day can't be stepped to.
  const prevOut = $derived(!!min && `${year}-${pad(month + 1)}-01` <= min);
  const nextOut = $derived(!!max && `${year}-${pad(month + 1)}-${pad(new Date(year, month + 1, 0).getDate())}` >= max);

  function pick(iso: string) {
    set(iso);
    open = false;
  }
</script>

<svelte:window
  onclick={(e) => {
    if (open && root && !root.contains(e.target as Node)) open = false;
  }}
  onkeydown={(e) => {
    if (open && e.key === "Escape") open = false;
  }}
/>

<span class="wrap" bind:this={root}>
  <input
    type="text"
    inputmode="numeric"
    placeholder={kind === "date" ? "pp.kk.vvvv" : "tt.mm"}
    autocomplete="off"
    aria-label={label}
    aria-invalid={invalid}
    class:invalid
    class:withbutton={kind === "date"}
    bind:value={text}
    onchange={commit}
    onkeydown={(e) => e.key === "Enter" && commit()}
  />
  {#if kind === "date"}
    <button type="button" class="open" aria-label="Avaa kalenteri" aria-expanded={open} onclick={toggle}><Icon name="calendar" /></button>
    {#if open}
      <div class="cal" role="dialog" aria-label="Kalenteri">
        <div class="head">
          <button type="button" class="btn ghost small icon" aria-label="Edellinen kuukausi" disabled={prevOut} onclick={() => step(-1)}><Icon name="chevronLeft" /></button>
          <strong>{monthName.format(new Date(year, month, 1))}</strong>
          <button type="button" class="btn ghost small icon" aria-label="Seuraava kuukausi" disabled={nextOut} onclick={() => step(1)}><Icon name="chevronRight" /></button>
        </div>
        <div class="grid">
          {#each WEEKDAYS as w}<span class="dow">{w}</span>{/each}
          {#each cells as iso}
            {#if iso}
              <button
                type="button"
                class="day"
                class:selected={iso === value}
                class:today={iso === today}
                disabled={isOut(iso)}
                aria-pressed={iso === value}
                onclick={() => pick(iso)}>{Number(iso.slice(8))}</button
              >
            {:else}
              <span></span>
            {/if}
          {/each}
        </div>
        <div class="foot">
          <button type="button" class="btn small" disabled={isOut(today)} onclick={() => pick(today)}>Tänään</button>
          {#if value}<button type="button" class="btn ghost small" onclick={() => pick("")}>Tyhjennä</button>{/if}
        </div>
      </div>
    {/if}
  {/if}
</span>

<style>
  .wrap {
    position: relative;
    display: block;
  }
  .invalid {
    border-color: var(--danger);
  }
  .withbutton {
    padding-right: 2.5rem;
  }
  .open {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 2.4rem;
    display: grid;
    place-items: center;
    border: 0;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .open:hover {
    color: var(--text-primary);
  }
  .cal {
    position: absolute;
    z-index: 20;
    top: calc(100% + 0.3rem);
    left: 0;
    width: 17rem;
    max-width: calc(100vw - 2rem);
    padding: 0.6rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-1);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.4rem;
    text-transform: capitalize;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px;
    text-align: center;
  }
  .dow {
    color: var(--text-muted);
    font-size: 0.8rem;
    padding: 0.2rem 0;
  }
  .day {
    aspect-ratio: 1;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }
  .day:hover:not(:disabled) {
    background: var(--surface-2);
  }
  .day.today {
    border-color: var(--border);
  }
  .day.selected {
    background: var(--brand-2);
    color: #fff;
  }
  .day:disabled {
    color: var(--text-muted);
    opacity: 0.4;
    cursor: default;
  }
  .foot {
    display: flex;
    justify-content: space-between;
    margin-top: 0.5rem;
  }
</style>
