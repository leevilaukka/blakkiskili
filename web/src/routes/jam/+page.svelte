<script lang="ts">
  // Pikakutsu links were /jam#j=… at first; they live at /liity now. Kept for links already shared
  // (they last a week at most), so this can go after that.
  import { onMount } from "svelte";
  onMount(() => location.replace(`/liity${location.hash}`));
</script>
