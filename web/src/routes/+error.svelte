<script lang="ts">
  // Unknown addresses, and anything the router can't render. Signed out, the layout sends the
  // visitor to /login before this shows.
  import { page } from "$app/state";

  const notFound = $derived(page.status === 404);
</script>

<svelte:head><title>{notFound ? "Sivua ei löytynyt" : "Virhe"} · Bläkkiskili</title></svelte:head>

<main class="page">
  <div class="mx-auto max-w-[46rem]">
    <div class="mb-5"><h1>{notFound ? "Sivua ei löytynyt" : "Jokin meni pieleen"}</h1></div>
    <p class="text-secondary">
      {notFound ? "Osoitteessa ei ole sivua. Linkki voi olla vanha tai kirjoitettu väärin." : "Sivua ei voitu näyttää. Päivitä sivu, tai palaa etusivulle."}
    </p>
    <a class="btn btn-primary" href="/">Etusivulle</a>
  </div>
</main>
