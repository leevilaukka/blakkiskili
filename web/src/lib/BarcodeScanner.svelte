<script lang="ts">
  // Three ways to give a barcode: the camera (read live), a photo, or the digits typed. Images
  // are read in the browser (#lib/barcode.ts); only the number is handed on.
  import { onDestroy, tick } from "svelte";
  import { plausibleBarcode, readFrame, readPhoto, warmUpDecoder } from "#lib/barcode.ts";
  import Icon from "#lib/Icon.svelte";

  let { onCode, disabled = false }: { onCode: (ean: string) => void; disabled?: boolean } = $props();

  const hasCamera = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  const SCAN_GAP_MS = 120;

  let video = $state<HTMLVideoElement>();
  let fileInput = $state<HTMLInputElement>();
  let active = $state(false);
  let starting = $state(false);
  let reading = $state(false);
  let error = $state("");
  let typed = $state("");
  let stream: MediaStream | null = null;
  /** Bumped whenever the camera stops, so a scan loop of an earlier start ends. */
  let generation = 0;

  function cameraError(e: unknown): string {
    const name = e instanceof DOMException ? e.name : "";
    if (name === "NotAllowedError" || name === "SecurityError")
      return "Kameran käyttö estettiin. Salli kamera selaimen asetuksista, tai valitse kuva tai kirjoita numerot.";
    if (name === "NotFoundError" || name === "OverconstrainedError") return "Kameraa ei löytynyt. Valitse kuva tai kirjoita numerot.";
    if (name === "NotReadableError") return "Kamera on toisen sovelluksen käytössä.";
    return "Kameraa ei saatu auki. Valitse kuva tai kirjoita numerot.";
  }

  async function start() {
    error = "";
    starting = true;
    warmUpDecoder();
    const gen = ++generation;
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      if (gen !== generation) {
        s.getTracks().forEach((t) => t.stop()); // closed while the permission prompt was open
        return;
      }
      stream = s;
      active = true;
      await tick();
      if (!video) throw new Error("no video element");
      video.srcObject = s;
      await video.play();
      void scan(gen);
    } catch (e) {
      stop();
      error = cameraError(e);
    } finally {
      starting = false;
    }
  }

  function stop() {
    generation++;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    active = false;
    if (video) video.srcObject = null;
  }

  async function scan(gen: number) {
    // The same number in two frames before it counts: a blurred frame can pass the checksum.
    let previous: string | null = null;
    while (gen === generation) {
      let code: string | null = null;
      try {
        if (video) code = await readFrame(video);
      } catch (e) {
        console.error("Barcode decoder failed:", e);
        if (gen === generation) {
          stop();
          error = "Viivakoodin lukija ei käynnistynyt. Kirjoita numerot.";
        }
        return;
      }
      if (gen !== generation) return;
      if (code && code === previous) {
        stop();
        navigator.vibrate?.(40);
        onCode(code);
        return;
      }
      if (code) previous = code;
      await new Promise((r) => setTimeout(r, SCAN_GAP_MS));
    }
  }

  async function photo() {
    const file = fileInput?.files?.[0];
    if (!file) return;
    stop();
    error = "";
    reading = true;
    try {
      const code = await readPhoto(file);
      if (code) onCode(code);
      else error = "Kuvasta ei löytynyt viivakoodia. Kokeile lähempää ja tasaisessa valossa, tai kirjoita numerot.";
    } catch (e) {
      console.error("Barcode photo failed:", e);
      error = "Kuvan lukeminen epäonnistui. Kirjoita viivakoodin numerot.";
    } finally {
      reading = false;
      if (fileInput) fileInput.value = ""; // the same photo can be picked again
    }
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const digits = typed.replace(/[\s-]/g, "");
    if (!plausibleBarcode(digits)) {
      error = "Kirjoita viivakoodin kaikki numerot (8 tai 13).";
      return;
    }
    error = "";
    stop();
    onCode(digits);
    typed = "";
  }

  // A hidden tab keeps no camera open.
  function onVisibility() {
    if (document.hidden && active) stop();
  }

  onDestroy(stop);
</script>

<svelte:document onvisibilitychange={onVisibility} />

{#if active}
  <div class="relative mb-3 aspect-[4/3] max-h-[60vh] overflow-hidden rounded-sm bg-black">
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="block size-full object-cover" bind:this={video} muted playsinline></video>
    <div class="absolute inset-x-[12%] top-1/2 h-[2px] bg-brand-1 shadow-[0_0_0_1px_rgb(255_255_255/40%)]" aria-hidden="true"></div>
    <p class="absolute inset-x-0 bottom-0 m-0 bg-black/45 p-1.5 text-center text-sm text-white">Osoita kameralla viivakoodia</p>
  </div>
{/if}

<div class="flex flex-wrap gap-2">
  {#if active}
    <button class="btn" onclick={stop}><Icon name="x" /> Sulje kamera</button>
  {:else if hasCamera}
    <button class="btn btn-primary" disabled={disabled || starting} onclick={start}><Icon name="camera" /> {starting ? "Avataan kameraa…" : "Avaa kamera"}</button>
  {/if}
  <button class="btn" disabled={disabled || reading} onclick={() => fileInput?.click()}>
    <Icon name="image" /> {reading ? "Luetaan kuvaa…" : "Valitse kuva"}
  </button>
  <input class="sr-only" type="file" accept="image/*" tabindex="-1" aria-hidden="true" bind:this={fileInput} onchange={photo} />
</div>

<form class="mt-3 flex gap-2" onsubmit={submit}>
  <label class="sr-only" for="ean">Viivakoodin numerot</label>
  <input id="ean" class="min-w-0 flex-1" type="text" inputmode="numeric" autocomplete="off" placeholder="Tai kirjoita viivakoodin numerot" bind:value={typed} maxlength="20" />
  <button class="btn" type="submit" disabled={disabled || !typed.trim()}><Icon name="search" /> Hae</button>
</form>

{#if error}<p class="mt-3 mb-0 text-danger" role="alert">{error}</p>{/if}

