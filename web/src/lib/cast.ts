/**
 * Cast a screen to a TV (Chromecast and other displays the browser finds) with the Presentation
 * API. The display opens the embed view of the screen link, so it needs the link's token. Must be
 * called soon after a click (the browser wants a user gesture).
 */
const Request = typeof window === "undefined" ? undefined : (window as any).PresentationRequest;

export const canCast = !!Request;

export const castUnsupported =
  "Tämä selain ei tue lähettämistä. Käytä Chromea tai Edgeä (osoitteen pitää olla https tai localhost), tai valitse selaimen valikosta Lähetä…";
export const castFailed = "Lähetys ei onnistunut: näyttöä ei valittu tai löytynyt.";

/** Returns false if the person cancelled or no display was found. `onEnd` runs when casting stops. */
export async function castScreen(token: string, onEnd: () => void): Promise<boolean> {
  if (!Request) return false;
  const p = new URLSearchParams({ embed: "1", theme: "dark" });
  try {
    const connection = await new Request([`${location.origin}/screen?${p}#t=${token}`]).start();
    connection.onclose = onEnd;
    connection.onterminate = onEnd;
    return true;
  } catch {
    return false;
  }
}
