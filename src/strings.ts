// User-facing texts (Finnish), ported from the original app/strings.js and converted to
// Telegram HTML. Placeholders are filled with fmt(), which escapes values.
// Texts about the operator, privacy and code were rewritten for v2: review them before launch.

export const E = {
  beers: "🍻",
  wine: "🍷",
  glasses: "🥂",
  shot: "🥃",
  memo: "📝",
  cross: "❌",
  gear: "⚙",
  person: "👤",
  scale: "⚖",
  ruler: "📏",
  female: "♀",
  male: "♂",
  trash: "🗑",
  refresh: "🔃",
  star: "🌟",
  stopwatch: "⏱",
  floppy: "💾",
  chart: "📊",
  info: "ℹ",
  goat: "🐐",
  inbox: "📥",
  link: "🔗",
  key: "🔑",
} as const;

export const PLATFORM_NAMES = { telegram: "Telegram", discord: "Discord" } as const;

export const DRINK_RESPONSES = [
  "Bäää.",
  "Uuteen nousuun.",
  "Muista juoda vettä!",
  "Aamu alkaa A:lla.",
  "Muista juoda vettä!",
  "Juo viinaa, viina on hyvää.",
  "Meno on meno.",
  "Lörs lärä, viinaa!",
  "Muista juoda vettä!",
  "Bäätöntä menoa!",
  "Loers laerae, booze!",
  "Remember to drink water!",
  "To the new rise.",
  "Go is go.",
  "Morning begins with A",
  "Drink booze, booze is good.",
];

export const randomDrinkResponse = () =>
  DRINK_RESPONSES[Math.floor(Math.random() * DRINK_RESPONSES.length)]!;

export const S = {
  yes: "Kyllä",
  no: "En",
  back: "« Takaisin",
  male: "Mies",
  female: "Nainen",

  short_permilles: "<b>Nyt:</b> {permilles}‰ - <b>30min:</b> {permilles30Min}‰",
  long_permilles:
    "<b>Nyt:</b> {permilles}‰ - <b>30min:</b> {permilles30Min}‰.\nVeressäsi on {grams} grammaa alkoholia, joka vastaa {standard_drinks} annosta. Olet selvinpäin {hours}h {minutes}min päästä.\n\nViimeisen kolmen päivän tapahtumat:\n{drink_list}",

  header: E.goat + " <b>Bäää - {title}</b> " + E.goat + "\n\n",
  header_permilles: "<b>Nyt:</b> {permilles}‰ - <b>30min:</b> {permilles30Min}‰\n\n",

  user404: "Rekisteröidy ensiksi: avaa /start minulle privaviestinä ja valitse Luo tunnus, tai käytä komentoa /tunnus.",
  user404_group: "Rekisteröidy ensiksi lähettämällä minulle privaviestinä /start.",
  terms_required: "Hyväksy ensin käyttöehdot: luo tunnus uudelleen komennolla /tunnus.",
  use_only_in_private: "Käytä komentoa vain minun kanssa privaviestinä!",
  use_only_in_chats: "Käytä komentoa vain ryhmissä!",
  unauthorized: "Ei käyttöoikeutta.",
  error: "Vakava virhe! Aloita komento alusta, niin yleensä poistuu sillä.",
  unknown_text: "Mitä? Avaa valikko komennolla /start tai katso ohjeet komennolla /help.",

  start: {
    title: "Bläkkiskili",
    on_select:
      "Veressäsi on {grams} grammaa alkoholia, joka vastaa {standard_drinks} annosta. Olet selvinpäin {hours}h {minutes}min päästä.{energy}{drink_list}",
    drinks3h: "\n\n<b>Viimeisen kolmen tunnin tapahtumat:</b>\n{list}",
    on_select_nonuser:
      "Bläkkiskili auttaa sinua ja ystäviäsi seuraamaan rippauksesi (lue: promillejesi) tasoa. Luo ensimmäiseksi tunnus valitsemalla <b>Luo tunnus</b>. Tunnuksen luomisen jälkeen voit alkaa kellottamaan juomia sisään juomavalikosta. Annan sinulle arvioita rippauksesta promillejen muodossa. Minut voi myös lisätä ryhmään, jolloin kerron /promillet-komennolla kaikkien ryhmässä olevien rippitasot. Jokaisen ryhmäläisen täytyy kuitenkin sanoa ryhmässä /moro, jotta he pääsevät rippilistaukseen mukaan.\n\nKäytitkö vanhaa Bläkkisvuohea? Voit tuoda tietosi valitsemalla <b>Tuo vanhat tiedot</b>.",
  },

  juo: {
    button: E.glasses + " Juo",
    title: "Juo",
    drinks1h: "<b>Viimeisen tunnin tapahtumat:</b>\n{list}\n\n",
    on_select:
      "Valitse juomasi alla olevista valikoista. Jos et löydä etsimääsi, klikkaa <b>Oma juoma</b>. Jos olet unohtanut lisätä juomia, voit lisätä ne takautuvasti valitsemalla <b>Jälkikellotus</b>. Jos lisäsit vahingossa väärän juoman, valitse <b>Kumoa</b>. Kaksi alinta nappia ovat pikavalinnat kahdelle viimeisimmälle juomalle.",
    on_drink: "{drink_response}\n\nJuoma tallennettu: {drink}{energy}",
    miedot: { button: E.beers + " Miedot", title: "Miedot", on_select: "Valitse mieto." },
    viinit: { button: E.wine + " Viinit", title: "Viinit", on_select: "Valitse viini." },
    shotit: { button: E.shot + " Shotit", title: "Shotit", on_select: "Valitse shotti." },
    oma: {
      button: E.memo + " Oma juoma",
      title: "Oma juoma",
      on_select: "Tilastoi oma juomasi. {help}",
      help: "Kirjoita juoma muodossa senttilitrat prosentit.\nEsim.\n<code>33cl 5.1%</code>, tai <code>33 5.1</code>",
      error_words: "Liian paljon tai vähän sanoja. {help}",
      error_cl: "Senttilitrat ei ole numero. {help}",
      error_vol: "Prosentti ei ole numero. {help}",
      error_exceeds: "Absoluuttisen alkoholin määrä on liian suuri. Tarkista numerot.",
      description: "Oma juoma - {cl}cl {vol}%",
    },
    late: {
      button: E.stopwatch + " Jälkikellotus",
      title: "Jälkikellotus",
      on_select:
        "Jälkikellottamalla voit tilastoida unohtuneet juomat monta tuntia jälkikäteen.\n\nKuinka pitkältä aikaväliltä haluat syöttää unohtuneita juomia? Syötä aikaväli tunneissa.\n\nEsimerkiksi kaksi ja puoli tuntia: <b>2.5</b>\nYksi tunti ja 15 minuuttia: <b>1.25</b>",
      hours_error: "Tunnit väärin. Syötä arvo väliltä 0-24.",
      input_drinks:
        "Kirjoita juomia seuraavassa muodossa:\nSenttilitrat Tilavuusprosentti.\nEsimerkiksi: <code>33 4.7</code>\n\nErota eri juomat joko rivinvaihdolla, tai kirjoita useampi viesti.",
      words_error: "Sanojen määrän täytyy olla parillinen luku.",
      drink_error: "Tarkista juoman {drink} senttilitrat ja tilavuusprosentti!",
      out_of_limits: "Tarkista juoman {drink} senttilitrat ja tilavuus, nyt alkoholin määrä ylittää rajat!",
      drinks_correct:
        "{count} juoma(a) syötetty onnistuneesti. Voit jatkaa juomien lisäämistä tai painaa <b>Tallenna</b> tilastoidaksesi syötetyt juomat.\n\nNykyiset syötetyt juomat:\n{list}",
      drink_name: "Jälkikellotus",
      save: E.floppy + " Tallenna",
      saved: "{drink_response} {count} juomaa jälkikellotettu onnistuneesti!\n\n{short}",
      nothing_to_save: "Ei tallennettavia juomia. Aloita jälkikellotus alusta.",
    },
    undo: {
      button: E.cross + " Kumoa",
      title: "Kumoa",
      on_select:
        "Olet kumoamassa viimeksi juodun juomasi. Oletko varma?\n\nKumottava juoma:\n<b>Nimi:</b> {name}\n<b>Juotu:</b> {created}",
      no_drinks: "Ei kumottavia juomia.",
      success:
        "Kumoaminen onnistui. Olet enää nyt <b>{permilles}‰</b> humalassa ja 30min päästä <b>{permilles30Min}‰</b> humalassa.",
    },
  },

  search: {
    button: "🔎 Hae Alkosta",
    title: "Hae Alkosta",
    prompt:
      "Kirjoita juoman nimi, esim. <code>karhu</code>, <code>lapin kulta</code> tai <code>jallu</code>. Voit lisätä perään määrän, esim. <code>jallu 3 cl</code>. Haku kattaa Alkon valikoiman (Alkometriikka).",
    results: "Osumat haulle <b>{q}</b>. Voit myös kirjoittaa uuden haun.",
    none: "Ei osumia haulle <b>{q}</b>. Kokeile toista nimeä tai käytä <b>Oma juoma</b> -nappia.",
    product: "<b>{name}</b>\n{details}\n\nValitse määrä:",
    product_link: "Lisätietoja Alkometriikassa",
    price: "Alkossa {price} / {size}",
    per_standard_drink: "{price} / annos",
    gone: "Tuotetta ei enää löydy valikoimasta. Hae uudelleen.",
    custom_button: "✏️ Muu määrä",
    custom_prompt:
      "<b>{name}</b> ({abv} %)\n\nKirjoita juomasi määrä, esim. <code>3 cl</code>, <code>25</code> (= cl) tai <code>0,5 l</code>.",
    custom_invalid: "En ymmärtänyt määrää.",
    custom_too_much: "Määrä on liian suuri yhdelle juomalle (haku <b>{q}</b>). Tarkista luku.",
    more: "🔎 Hae lisää",
    to_menu: "🥂 Juo-valikko",
    inline_register: "Luo ensin tunnus",
    inline_private: "Kellota juomat yksityisesti",
    inline_unavailable: "Haku ei ole juuri nyt käytössä",
    feedback_off:
      "Juomaa ei tallennettu: botin inline-palaute on pois päältä. Käytä hakua Juo-valikosta.\n\n(Ylläpitäjälle: BotFather → /setinlinefeedback → Enabled.)",
  },

  energy: {
    session: "Tämän illan juomissa on noin <b>{kcal}</b> kcal.{unknown}",
    // Custom and late-logged drinks, and drinks imported from the old bot, have no energy data.
    unknown: " Energiatieto puuttuu {count} juomalta.",
  },

  barcode: {
    title: "Viivakoodi",
    found: "Viivakoodi <code>{ean}</code> kuuluu tälle tuotteelle.",
    gone: "Viivakoodi <code>{ean}</code> kuuluu tuotteelle, jota ei enää löydy valikoimasta.",
    alcohol_free: "Viivakoodi <code>{ean}</code> kuuluu tuotteelle <b>{name}</b>, mutta se on alkoholiton (alle 1 %), joten sitä ei voi merkitä juomaksi.",
    unknown: "Alko ei tunne viivakoodia <code>{ean}</code>. Voit hakea tuotetta nimellä.",
    invalid: "En tunnistanut viivakoodia. Lähetä numerot tai selkeä kuva viivakoodista.",
    no_code_in_photo: "En löytänyt kuvasta viivakoodia. Yritä uudelleen lähempää ja tasaisessa valossa, tai kirjoita numerot.",
    photo_failed: "Kuvan lukeminen epäonnistui. Kirjoita viivakoodin numerot.",
    off: "Viivakoodit eivät ole käytössä.",
    rate_limited: "Viivakoodeja on haettu juuri paljon. Kokeile hetken päästä uudelleen.",
    unavailable: "Viivakoodin <code>{ean}</code> haku ei onnistunut juuri nyt. Kokeile myöhemmin uudelleen.",
  },

  asetukset: {
    button: E.gear + " Asetukset",
    title: "Asetukset",
    on_select: "Asetuksista voit muokata tunnustasi, ladata tietosi tai poistaa tunnuksesi.",
    muokkaa: {
      button: E.person + " Muokkaa tunnusta",
      on_select:
        "Voit muokata tässä tunnuksesi painoa, pituutta ja sukupuolta sekä päivittää nimimerkin.\n\nNykyiset tiedot:\n<b>Nimimerkki:</b> {name}\n<b>Paino:</b> {weight}kg\n<b>Pituus:</b> {height}cm\n<b>Sukupuoli:</b> {gender}\n<b>Käyttäjä luotu:</b> {created}",
      paino: { button: E.scale + " Muokkaa painoa", on_select: "<b>Paino nyt:</b> {weight}kg\n\nSyötä uusi painosi kokonaislukuna.", changed: "Paino muutettu!" },
      pituus: { button: E.ruler + " Muokkaa pituutta", on_select: "<b>Pituus nyt:</b> {height}cm\n\nSyötä uusi pituutesi kokonaislukuna.", changed: "Pituus muutettu!" },
      sukupuoli: {
        button: E.female + E.male + " Muokkaa sukupuolta",
        on_select: "<b>Sukupuoli nyt:</b> {gender}\n\nValitse uusi biologinen sukupuolesi alta:",
        changed: "Sukupuoli muutettu!",
      },
      weight_error: "Painon pitää olla kokonaisluku ja ala- ja ylärajat ovat 20kg ja 250kg.",
      height_error: "Pituuden täytyy olla kokonaisluku ja ala- ja ylärajat ovat 120cm ja 240cm.",
    },
    paivita: {
      button: E.refresh + " Päivitä nimi",
      done: "Nimi päivitetty! Nimesi on nyt: <b>{name}</b>. Nimi päivittyy myös automaattisesti, kun käytät bottia.",
    },
    data: { button: E.inbox + " Lataa tietoni" },
    linkit: {
      button: E.link + " Yhdistetyt palvelut",
      on_select:
        "Voit käyttää samaa tunnusta useammasta palvelusta (esim. Telegram ja Discord). Tunnukseesi on yhdistetty:\n{list}\n\nYhdistä uusi palvelu luomalla koodi ja lähettämällä se toisen palvelun Bläkkiskili-botille.",
      item: "- {platform}",
      item_current: "- {platform} (tämä)",
      create: E.key + " Luo yhdistämiskoodi",
      code:
        "Yhdistämiskoodisi on <code>{code}</code>\n\nLähetä toisen palvelun Bläkkiskili-botille viesti <code>/yhdista {code}</code>. Koodi toimii kerran ja vanhenee {minutes} minuutissa. Älä anna koodia muille: sillä pääsee tunnukseesi.",
      unlink: "Irrota {platform}",
      unlink_confirm:
        "Irrotetaanko {platform} tunnuksestasi? Tietosi säilyvät, mutta et voi käyttää tunnusta sieltä ennen kuin yhdistät sen uudelleen.",
      unlinked: "{platform} irrotettu.",
    },
    poista: {
      button: E.trash + " Poista tunnus",
      on_select:
        "Olet poistamassa tunnuksesi. Hyväksymällä poistat kaiken sinuun liittyvän tiedon Bläkkiskilin tietokannasta eikä sinua enää ole mahdollista listata missään listauksissa.\n\nVoit ladata tietosi ensin talteen komennolla /data.\n\nOletko varma, että haluat poistaa tunnuksesi?",
      double_confirm: "Oletko aivan varma? Kaikki tietosi <b>poistetaan</b> jos klikkaat kyllä.",
      canceled: "Peruit tunnuksen poistamisen.",
      deleted: "Kaikki tietosi on nyt poistettu. Rippaa rauhassa.",
    },
  },

  register: {
    button: E.star + " Luo tunnus",
    title: "Luo tunnus",
    on_select:
      "Tarvitset tunnusta käyttääksesi suurinta osaa botin ominaisuuksista. Alkoholilaskuria varten tarvitsen seuraavat tiedot: paino, pituus ja sukupuoli.\n\nAloita syöttämällä painosi kilogrammoissa ja kokonaislukuna:",
    weight_error: "Syötä paino uudelleen. Painon pitää olla kokonaisluku ja ala- ja ylärajat ovat 20kg ja 250kg.",
    height: "Paino syötetty. Syötä seuraavaksi pituus senttimetreissä:",
    height_error: "Syötä pituus uudelleen. Pituuden täytyy olla kokonaisluku ja ala- ja ylärajat ovat 120cm ja 240cm.",
    gender: "Pituus syötetty. Valitse seuraavaksi biologinen sukupuoli:",
    terms: "Sukupuoli syötetty.\n\n{terms}\n\nOletko lukenut ja hyväksynyt käyttöehdot?",
    terms_rejected: "Lue käyttöehdot ja hyväksy ne, ennen kuin voit käyttää muita komentoja.",
    updated: "Olet jo rekisteröitynyt. Tiedot päivitetty.",
    created:
      "Moikka {name}! Tunnuksesi luotiin onnistuneesti. Muista, että kaikki antamani luvut ovat vain arvioita, eikä niihin voi täysin luottaa.\n\nJa eikun juomaan!",
  },

  tilastoja: {
    button: E.chart + " Tilastoja",
    title: "Tilastoja",
    on_select:
      "Valitse tarkasteltava tilasto alla olevista valikoista. <b>Kulutus</b> kertoo sinulle kokonaiskulutuksestasi lukuja ja <b>Otinko</b> listaa viimeisen 3 päivän aikana tilastoidut juomat.",
    kulutus: {
      button: "Kulutus",
      text: "Olet <b>{day_count}</b> päivän aikana tuhonnut <b>{grams}</b> grammaa alkoholia, joka vastaa <b>{standard_drinks}</b> annosta. Keskimäärin olet juonut <b>{avg}</b> annosta per päivä.",
      energy: "\n\nJuomissa oli energiaa noin <b>{kcal}</b> kcal.{unknown}",
      hint: "\n\nJos haluat tietää lähiajan kulutuksesi, kirjoita tarkasteltavien päivien määrä numerona.",
      days: (n: number) => `${n} päivää`,
    },
    otinko: { button: "Otinko", text: "Viimeisen kolmen vuorokauden tapahtumat:\n\n{list}" },
  },

  import: {
    button: E.inbox + " Tuo vanhat tiedot",
    title: "Tuo vanhat tiedot",
    intro:
      "Voit tuoda tiedot vanhasta Bläkkisvuohesta. Lataa ne vanhasta botista komennolla /data ja lähetä tänne saamasi tiedostot <b>user.csv</b>, <b>drinks.csv</b> ja halutessasi <b>groups.csv</b>.\n\nTarkistan, että tiedostot ovat sinun: ne käyvät vain samalle Telegram-tilille, jolla ne ladattiin.\n\n{terms}\n\nOletko lukenut ja hyväksynyt käyttöehdot?",
    send_files: "Kiitos! Lähetä nyt tiedostot (user.csv, drinks.csv, groups.csv) tähän keskusteluun. Voit lähettää ne yhdessä tai erikseen. Lopeta komennolla /start.",
    not_in_flow: "Jos haluat tuoda vanhat tietosi, aloita komennolla /tuo.",
    user_created: "Tunnus luotu vanhoilla tiedoilla (paino, pituus, sukupuoli).",
    user_updated: "Tunnuksen tiedot päivitetty vanhoilla tiedoilla (paino, pituus, sukupuoli).",
    drinks: "Juomahistoria tuotu: {inserted} juomaa lisätty, {duplicates} oli jo tallessa, {invalid} virheellistä riviä ohitettu.",
    groups: "{groups} ryhmäjäsenyyttä tallennettu. Pääset ryhmän listauksiin automaattisesti, kun ryhmässä käytetään uutta bottia ensimmäisen kerran.",
    waiting_for_user: "Sain tiedoston, mutta tarvitsen ensin user.csv-tiedoston, jotta voin luoda tunnuksesi. Tallennan tämän siihen asti.",
    not_yours: "Tiedosto ei ole sinun: se on ladattu eri Telegram-tilillä. Mitään ei tuotu.",
    unknown_format: "En tunnistanut tiedostoa. Lähetä vanhan Bläkkisvuohen /data-komennolla ladattu user.csv, drinks.csv tai groups.csv.",
    empty: "Tiedosto on tyhjä.",
    invalid_profile: "user.csv:n tiedot (paino, pituus tai sukupuoli) eivät kelpaa. Luo tunnus käsin valitsemalla Luo tunnus, ja tuo sitten drinks.csv.",
    no_account: "Luo ensin tunnus (tai lähetä user.csv), niin voin tuoda juomat.",
    parse_error: "Tiedoston lukeminen epäonnistui. Onko se varmasti CSV-tiedosto?",
    too_big: "Tiedosto on liian suuri.",
  },

  help: {
    button: E.info + " Help",
    title: "Help",
    on_select: "Missä tarvitset apua?",
    general: {
      button: "Yleistä",
      title: "Help: Yleistä",
      text:
        "Bläkkiskili auttaa arvioimaan alkoholin määrää veressä eli promilleja. Botille tilastoidaan juomia sitä mukaa, kun niitä juodaan, ja botti laskee juoduista juomista promillet, palamisen huomioon ottaen. Lisäksi botin voi lisätä ryhmään ryhmätilastoja varten.\n\n<b>Käyttö</b>\n\nBotin käyttäminen on yksinkertaista. Juodut juomat tilastoidaan /start-valikosta (tai pikakomennoilla, ks. /komennot) ja botti laskee promillemäärän heti. Botin käyttö <b>vaatii tunnuksen</b> luomisen, jotta promillejen arviointi olisi mahdollisimman tarkkaa.",
    },
    faq: {
      button: "FAQ",
      title: "FAQ",
      on_select: "Valitse yksi ala-aiheista:",
      juominen: {
        button: "Juominen",
        title: "FAQ: Juominen",
        text:
          "<b>Kannattaako juoma merkata avatessa vai viimeistellessä?</b>\nJuomat kannattaa merkata silloin, kun ne avaa. Promillearvioinnissa oletetaan juoman imeytyvän 99-prosenttisesti 30 minuutissa. Lisäksi avatessa juoman muistaa merkata paremmin.\n\n<b>Kuinka tarkka promillejen arviointi on?</b>\nNoin 1.5‰ asti hyvin tarkka, jonka jälkeen laskukaava alkaa heittämään. Laskenta on sama kuin alkuperäisessä Bläkkisvuohessa.\n\n<b>Unohdin lisätä juomat, mitä nyt?</b>\nKäytä /jalkikellotus-komentoa, tai /start-valikosta löytyvää Jälkikellotus-nappulaa.",
      },
      ryhmat: {
        button: "Ryhmät",
        title: "FAQ: Ryhmät",
        text:
          "<b>Miten voin liittyä ryhmään tai poistua ryhmästä?</b>\nKirjoita ryhmässä /moro, jos haluat liittyä ryhmään. Kirjoita /poistu, jos haluat poistua ryhmästä. Ryhmään liittyneenä sinun promilletasosi näkyy esim. /promillet-komennolla.\n\n<b>Toin vanhat tietoni, pitääkö sanoa /moro uudestaan?</b>\nEi tarvitse, jos toit myös groups.csv-tiedoston: sinut lisätään vanhoihin ryhmiisi automaattisesti, kun niissä käytetään uutta bottia.\n\n<b>Miksi /kuvaaja -kuvassa kaikkien promillet laskee samaa tahtia?</b>\nPromillet kuvaavat alkoholin osuutta koko kehon verestä. Alkoholi palaa elimistössä nopeammin painavammilla ihmisillä, mutta veren määrä kehossa on tällöin myös suhteessa noin saman verran korkeampi. Tällöin promillejen väheneminen kehossa on kaikilla ihmisillä jotakuinkin sama.\n\n<b>Tallentaako Bläkkiskili ryhmän viestit?</b>\n<b>Ei tallenna.</b> Botti näkee ryhmässä vain sille osoitetut komennot.",
      },
      koodi: {
        button: "Koodi",
        title: "FAQ: Koodi",
        text:
          "<b>Miten Bläkkiskili on koodattu?</b>\nBläkkiskili on kirjoitettu TypeScriptillä Bun-ajoympäristöllä ja grammY-kirjastolla, tietokantana SQLite. Se perustuu Joonas Ulmasen (@ultsi) alkuperäiseen Bläkkisvuoheen (https://gitlab.com/ultsi-projects/blakkisvuohi), mutta ei ole sen tekijän ylläpitämä. Bläkkiskili on lisensoitu GPLv3:lla.{source}{maintainer}",
      },
    },
    privacy: {
      button: "Yksityisyys",
      title: "Help: Yksityisyys",
      text:
        "<b>Mitä tietoja kerätään?</b>\n- Telegramiin määritelty nimimerkki ja koko nimi (etu- ja sukunimi, salattuna)\n- Tiiviste (HMAC) Telegram-tilisi tunnisteesta (ja muiden tunnukseen yhdistämiesi palveluiden tunnisteista), sekä tunnisteet salattuna poistovaroituksen lähettämistä varten\n- Paino, pituus ja sukupuoli\n- Merkattujen juomien alkoholimäärät, nimet ja juomisajat, arvioitu energiamäärä (kun se tiedetään), sekä Alkon valikoimasta valituille juomille tuotenumero\n- Kun haet tuotetta viivakoodilla, vain viivakoodin numero lähetetään Alkometriikalle, joka kysyy sen Alkolta. Mitään sinuun liittyvää ei lähetetä, eikä kuvia tallenneta\n- Tiivisteet liittymiesi ryhmien tunnisteista\n\nRyhmien viestejä, puhelinnumeroa tai muita tietoja ei tallenneta.\n\n<b>Voinko saada tai poistaa tietoni?</b>\nKyllä. /data lähettää kaikki tietosi CSV-tiedostoina, ja Asetukset → Poista tunnus poistaa kaiken sinuun liittyvän tiedon heti.{retention}\n\n<b>Varmuuskopiot</b>\nTietokannasta otetaan salattuja varmuuskopioita EU:ssa sijaitsevaan tallennustilaan. Poistetut tiedot häviävät myös varmuuskopioista viimeistään noin kolmen kuukauden kuluttua.{maintainer}",
    },
  },

  terms:
    "<b>Käyttöehdot</b>\n\nKäyttämällä Bläkkiskiliä olet hyväksynyt seuraavat käyttöehdot. Bläkkiskilin päätarkoitus on arvioida alkoholin määrää kehossa. Bläkkiskilin toiminta voi muuttua tai pysähtyä milloin vain. Sinun täytyy olla yli 18 vuotta käyttääksesi Bläkkiskiliä. Bläkkiskilin kehittäjät tai ylläpitäjät eivät ole vastuussa mistään suorasta tai epäsuorasta haitasta, jota palvelun käyttäminen voi aiheuttaa. Bläkkiskili on ilmainen käyttää. Ominaisuuksien, kuten promillejen arvioiminen, takia Bläkkiskili tallentaa käyttäjistä erinäisiä tietoja ja käyttää näitä hyväksi laskennassa. Sinuun suoraan linkitettävät tiedot tiivistetään tai salataan ennen tallentamista. Tietoja ei koskaan anneta tai myydä eteenpäin kolmansille osapuolille. Voit ladata tietosi komennolla /data ja poistaa ne milloin tahansa asetuksista.{retention}\n\nBläkkiskilin tuottamat arviot ovat arvioita, eikä niihin voi missään tapauksessa täysin luottaa. Noudata lakia, kun käytät alkoholia.\n\nNämä käyttöehdot voivat muuttua milloin vain ilman erillistä huomautusta. Uusimmat käyttöehdot voi aina lukea /terms-komennolla.",

  retention:
    " Tunnus ja kaikki sen tiedot poistetaan automaattisesti, jos Bläkkiskiliä ei ole käytetty {months} kuukauteen. Saat tästä varoituksen privaviestinä {warn_days} päivää etukäteen.",

  inactivity_warning:
    E.goat + " <b>Bäää!</b> Et ole käyttänyt Bläkkiskiliä {months} kuukauteen, joten tunnuksesi ja kaikki tietosi poistetaan {warn_days} päivän kuluttua.\n\nJos haluat pitää tunnuksesi, käytä bottia, esimerkiksi komennolla /start. Voit myös ladata tietosi talteen komennolla /data.",

  announcement: "📣 <b>Tiedote {date}</b>\n{text}",

  about:
    "<b>Bläkkiskili</b> arvioi veren alkoholipitoisuutta juomiesi perusteella. Se perustuu Joonas Ulmasen (@ultsi) alkuperäiseen Bläkkisvuoheen (https://gitlab.com/ultsi-projects/blakkisvuohi), mutta ei ole alkuperäisen tekijän ylläpitämä. Bläkkiskili on vapaata ohjelmistoa GPLv3-lisenssillä.{source}{maintainer}\n\nKäyttöehdot: /terms",

  commands: {
    moro: "Rippaa rauhassa kera {chat_title} -kavereiden.",
    poistu: "Ei enää rippausta kera {chat_title} -kavereiden.",
    promillet_group: "<b>{chat_title}</b> -käyttäjien rippitaso:\nKäyttäjä...‰ (annoksia 12h/24h)\n\n{list}",
    promillet_item: "{name}... {permilles} ({std12h}/{std24h})",
    annokset_group: "<b>{chat_title}</b> -käyttäjien rippitaso:\nKäyttäjä...annoksia (yht. 12h/24h)\n\n{list}",
    annokset_item: "{name}... {standard_drinks}kpl ({std12h}/{std24h})",
    nobody: "Kukaan ei ole juonut. Vielä.",
    kuvaaja_title: "Promillekuvaaja feat. {name}",
    kuvaaja_empty: "Ei piirrettävää: kukaan ei ole juonut viime aikoina. Vielä.",
    adopted: "Toin {count} vanhan Bläkkisvuohen jäsentä tämän ryhmän listauksiin.",
    stats_private:
      "Olet {day_count} päivän aikana tuhonnut {grams} grammaa alkoholia, joka vastaa {standard_drinks} annosta. Keskimäärin olet juonut {avg} annosta per päivä.",
    stats_group:
      "Tilastoja:\n\nRyhmän jäsenet ovat {day_count} päivän aikana tuhonneet {grams} grammaa alkoholia, joka vastaa {standard_drinks} annosta. Keskimäärin on juotu {avg} annosta per päivä. Lisäksi kaikki käyttäjät globaalisti ovat yhteensä tilastoineet {global}. Hienosti.\n\nTop10 tilastot <b>{unit}</b>:\n\n{list}",
    laatta_confirm: "Olet laattaamassa viimeksi juodun juomasi ({name}, {created}). Oletko varma?",
    laatta_cancel: "Laatta peruttu.",
    whoami:
      "Käyttäjä {name}\nPaino: {weight}kg\nPituus: {height}cm\nSukupuoli: {gender}\nKäyttäjä luotu: {created}",
    data_reply: "Tässä kaikki sinun käyttäjätunnukseesi liitetyt tiedot. Voit tuoda ne takaisin komennolla /tuo.",
    data_none: "Sinun käyttäjätunnuksella ei ole tallennettu yhtään tietoa.",
    yhdista: {
      usage:
        "Tällä komennolla yhdistät tämän Telegram-tilin tunnukseen, jonka olet luonut toisessa palvelussa. Luo siellä yhdistämiskoodi asetuksista ja lähetä tänne <code>/yhdista KOODI</code>.",
      done: "Yhdistetty! Voit nyt käyttää tunnustasi {name} myös täältä.",
      invalid: "Koodi on väärä tai vanhentunut. Luo uusi koodi ja yritä uudelleen.",
      already_linked: "Tämä Telegram-tili on jo yhdistetty tähän tunnukseen.",
      has_account:
        "Tällä Telegram-tilillä on jo oma tunnus, eikä tunnuksia voi yhdistää. Jos haluat käyttää toista tunnusta, lataa tietosi talteen komennolla /data ja poista tämän tilin tunnus asetuksista.",
      platform_taken: "Tunnukseen on jo yhdistetty toinen Telegram-tili. Irrota se ensin tunnuksen asetuksista.",
    },
    admin_stats:
      "Tilastoja:\nKäyttäjiä on yhteensä {users}kpl, joista 14pv sisällä aktiivisia {active14}, ja 7pv sisällä aktiivisia {active7}.\nRyhmiä on yhteensä {groups}kpl, joista 14pv sisällä aktiivisia {groups14}, ja 7pv sisällä aktiivisia {groups7}. Lisäksi kaikki käyttäjät ovat yhteensä tilastoineet {drinks} juomaa.\nTop10 tilastot:\n\n{list}",
    help:
      "Bläkkiskili auttaa sinua ja ystäviäsi seuraamaan rippauksesi (lue: promillejesi) tasoa. Aloita lähettämällä minulle privaviestinä /start.\n\nLuo ensimmäiseksi tunnus. Sen jälkeen voit alkaa kellottamaan juomia sisään /start-valikosta. Minut voi myös lisätä ryhmään, jolloin kerron /promillet-komennolla kaikkien ryhmässä olevien rippitasot. Jokaisen ryhmäläisen täytyy kuitenkin sanoa ryhmässä /moro, jotta he pääsevät rippilistaukseen mukaan.\n\nKaikki komennot: /komennot",
  },
} as const;
