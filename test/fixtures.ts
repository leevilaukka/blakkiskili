// A small catalogue in Alkometriikka's data.json shape (column order shuffled on purpose:
// the parser must look columns up by name).

const SCHEMA = ["Nimi", "Numero", "Valmistaja", "Pullokoko", "Hinta", "Tyyppi", "Alatyyppi", "Pakkaustyyppi", "Alkoholi-%", "Valikoima", "Tila", "Energia kcal/100 ml", "Valmistusmaa", "EAN"];

type Row = [name: string, id: string, maker: string, size: number, price: number, type: string, subtype: string, packaging: string, abv: number, selection: string, status: string, kcal100: number | null, country: string | null, ean?: string | null];

export const PRODUCTS: Row[] = [
  ["Karhu 4,6 tölkki", "700001", "Sinebrychoff", 0.33, 2.19, "Panimotuotteet", "oluet", "tölkki", 4.6, "vakiovalikoima", "Aktiivinen", 40, "Suomi"],
  ["Karhu 4,6", "700002", "Sinebrychoff", 0.33, 2.29, "Panimotuotteet", "oluet", "lasipullo", 4.6, "vakiovalikoima", "Aktiivinen", 40, "Suomi"],
  ["Karhu 4,6 tölkki", "700008", "Sinebrychoff", 0.5, 2.99, "Panimotuotteet", "oluet", "tölkki", 4.6, "vakiovalikoima", "Aktiivinen", 40, "Suomi"],
  ["Karhu 5,3 6-pack tölkki", "700003", "Sinebrychoff", 1.98, 12.9, "Panimotuotteet", "oluet", "tölkki", 5.3, "vakiovalikoima", "Aktiivinen", 50, "Suomi"],
  ["Karjala tölkki", "700004", "Hartwall", 0.5, 2.99, "Panimotuotteet", "oluet", "tölkki", 8, "tilausvalikoima", "Aktiivinen", 70, "Suomi", "4006381333931"],
  ["Original Long Drink tölkki", "700005", "Hartwall", 0.33, 2.49, "Panimotuotteet", "juomasekoitukset", "tölkki", 5.5, "vakiovalikoima", "Aktiivinen", 60, "Suomi"],
  ["Olvi Lonkero Greippi tölkki", "700006", "Olvi", 0.33, 2.39, "Panimotuotteet", "juomasekoitukset", "tölkki", 5, "vakiovalikoima", "Aktiivinen", 50, "Suomi"],
  ["Pubi Lager hanapakkaus", "700007", "Pienpanimo", 20, 99, "Panimotuotteet", "oluet", "hanapakkaus", 4.7, "tilausvalikoima", "Aktiivinen", 40, "Suomi"],
  ["Château Testi 2022", "700010", "Château Testi", 0.75, 14.9, "Viinit", "punaviinit", "lasipullo", 13, "vakiovalikoima", "Aktiivinen", 80, "Ranska"],
  ["Château Testi 2022", "700014", "Château Testi", 0.375, 8.9, "Viinit", "punaviinit", "lasipullo", 13, "tilausvalikoima", "Aktiivinen", 80, "Ranska"],
  ["Pikku Kuohu", "700011", "Kuohu Oy", 0.2, 4.9, "Viinit", "kuohuviinit ja samppanjat", "lasipullo", 11, "vakiovalikoima", "Aktiivinen", 70, "Suomi"],
  ["Hanaviini Punainen", "700012", "Viini Oy", 3, 34.9, "Viinit", "punaviinit", "hanapakkaus", 12.5, "vakiovalikoima", "Aktiivinen", 80, "Suomi"],
  ["Voimaviini", "700013", "Viini Oy", 0.75, 19.9, "Viinit", "punaviinit", "lasipullo", 16, "tilausvalikoima", "Aktiivinen", null, "Suomi"],
  ["Jaloviina ***", "700020", "Anora", 0.5, 24.9, "Väkevät", "brandyt", "lasipullo", 38, "vakiovalikoima", "Aktiivinen", 210, "Suomi"],
  ["Jaloviina ***", "700022", "Anora", 0.7, 33.9, "Väkevät", "brandyt", "lasipullo", 38, "vakiovalikoima", "Aktiivinen", 210, "Suomi"],
  ["Jaloviina ***", "700023", "Anora", 0.04, 2.49, "Väkevät", "brandyt", "lasipullo", 38, "vakiovalikoima", "Aktiivinen", 210, "Suomi"],
  ["Jaloviina *", "700025", "Anora", 0.5, 22.9, "Väkevät", "brandyt", "lasipullo", 38, "vakiovalikoima", "Aktiivinen", 210, "Suomi"],
  ["Absolut Vodka", "700026", "Absolut", 0.7, 29.9, "Väkevät", "vodka", "lasipullo", 40, "vakiovalikoima", "Aktiivinen", 220, "Ruotsi"],
  ["Absolut Vodka", "700027", "Absolut", 0.05, 3.49, "Väkevät", "vodka", "lasipullo", 40, "vakiovalikoima", "Aktiivinen", 220, "Ruotsi"],
  ["Jaloviina *** muovipullo", "700024", "Anora", 0.5, 24.5, "Väkevät", "brandyt", "muovipullo", 38, "vakiovalikoima", "Aktiivinen", 210, "Suomi"],
  ["Koskenkorva Minttu 21%", "700021", "Anora", 0.04, 1.99, "Väkevät", "mausteliköörit", "lasipullo", 21, "vakiovalikoima", "Aktiivinen", 250, "Suomi"],
  ["Portto Ruby", "700030", "Porto Oy", 0.75, 16.9, "Välituotteet", "portviinit", "lasipullo", 19.5, "vakiovalikoima", "Aktiivinen", 150, "Portugali"],
  ["Karhu 0,0 tölkki", "700040", "Sinebrychoff", 0.33, 1.49, "Alkoholittomat", "alkoholittomat oluet", "tölkki", 0, "vakiovalikoima", "Aktiivinen", 20, "Suomi"],
  ["Karhu Vanha Poistuva", "700050", "Sinebrychoff", 0.33, 2.0, "Panimotuotteet", "oluet", "tölkki", 4.6, "tilausvalikoima", "Poistuva", 40, "Suomi"],
];

export function catalogJson(rows: Row[] = PRODUCTS, lastUpdated = "2026-11-04T23:15:38.631Z") {
  return {
    schema: SCHEMA,
    metadata: { LastUpdated: lastUpdated },
    products: Object.fromEntries(rows.map((r) => [r[1], { values: [...r], priceHistory: [] }])),
    index: {},
    dictionaries: {},
  };
}
