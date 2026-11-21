<script lang="ts">
  // Pikakutsu links are /liity/<code> (in the path, so link previews can show the group). The
  // first ones had the code in the fragment (/liity#k=…, and /jam#j=… before that): send those on.
  import { onMount } from "svelte";
  onMount(() => {
    const params = new URLSearchParams(location.hash.slice(1));
    const code = params.get("k") ?? params.get("j");
    location.replace(code ? `/liity/${encodeURIComponent(code)}` : "/groups");
  });
</script>
