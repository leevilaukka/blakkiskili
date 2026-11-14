<script lang="ts">
  // A QR code as one SVG path (uqr encodes; drawing it here keeps the CSP's no-inline-styles rule).
  // Always black on white, also in dark mode: that's what phone cameras read reliably.
  import { encode } from "uqr";

  let { text, label }: { text: string; label: string } = $props();

  const qr = $derived(encode(text, { ecc: "M", border: 2 }));
  const d = $derived(
    qr.data
      .flatMap((row, y) => row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : "")))
      .join(""),
  );
</script>

<svg class="block h-auto w-full rounded-sm" viewBox="0 0 {qr.size} {qr.size}" role="img" aria-label={label} shape-rendering="crispEdges">
  <rect width={qr.size} height={qr.size} fill="#fff" />
  <path {d} fill="#000" />
</svg>

