<script lang="ts">
  // A number tile: small label over a big value, with an optional unit and a line under it.
  let { label, value, unit, sub }: { label: string; value: string | number; unit?: string; sub?: string } = $props();
</script>

<div class="rounded-sm border border-line bg-surface-1 px-4 py-3">
  <span class="block text-sm text-secondary">{label}</span>
  <span class="block text-2xl leading-tight font-bold tabular-nums"
    >{value}{#if unit}{" "}<small class="text-[0.6em] font-medium text-secondary">{unit}</small>{/if}</span
  >
  {#if sub}<span class="block text-xs text-muted">{sub}</span>{/if}
</div>
