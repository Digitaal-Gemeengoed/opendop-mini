// Een eigen statusveld (MDTO met de zaakstatus van de gemeente): vergrendelen,
// bewaartermijn, classificeren verplicht, attributen per status, doorgeven aan de zaak.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migreer } from "../dist/migreer.js";
import { maakPool, huidigePool } from "../dist/db.js";
import { LokaleOpslag } from "../dist/opslag.js";
import { LokaalSleutelbeheer } from "../dist/sleutelbeheer.js";
import { bouwServer } from "../dist/server.js";
import { GeenZoekindex } from "../dist/zoekindex.js";
import { standaardConfig, telOp } from "@digitaalgemeengoed/oa-contract";

const BEHEER = process.env.TEST_DATABASE_URL_BEHEER;
const APP = process.env.TEST_DATABASE_URL;
const overslaan = !BEHEER || !APP;
const SLEUTEL = "test-dienstsleutel-0123456789";
const G = "heiloo";
let app, map;
const kop = (actor) => ({
  "x-oa-dienstsleutel": SLEUTEL,
  "x-oa-gemeente": G,
  "x-oa-actor": Buffer.from(JSON.stringify({ niveau: 1, ...actor })).toString("base64url"),
});
const MEDEWERKER = { sub: "m-2", naam: "Bram" };
const vraag = (method, url, payload, actor = MEDEWERKER) => app.inject({ method, url, headers: kop(actor), payload });
const vandaag = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });

before(async () => {
  if (overslaan) return;
  await migreer(BEHEER, { gemeenten: [{ id: G, naam: "Gemeente Heiloo" }] });
  try { huidigePool(); } catch { maakPool(APP); }
  map = await mkdtemp(join(tmpdir(), "oa-st-"));
  const middelen = { opslag: new LokaleOpslag(join(map, "o")), sleutelbeheer: new LokaalSleutelbeheer(join(map, "s")), maxBytes: 1024 * 1024 };
  app = bouwServer({ middelen, zoekindex: new GeenZoekindex(), dienstsleutel: SLEUTEL, log: false });
});
after(async () => {
  if (overslaan) return;
  await app.close();
  await huidigePool().end();
  await rm(map, { recursive: true, force: true });
});

const STATUSSEN = ["ontvangen", "in behandeling", "afgesloten", "geannuleerd"];
const md = (status, zaak = "Z-2026-001") => ({ naam: "Brief aan aanvrager", informatiecategorie: "adviezen", beperkingGebruik: "intern", zaak, zaakstatus: status });
const maak = async (status, zaak) => {
  const r = await vraag("POST", "/objecten", { objecttype: "document", metadata: md(status, zaak) });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().identificatie;
};
const zet = (id, status, zaak) => vraag("PUT", `/objecten/${id}/metadata`, { metadata: md(status, zaak) });
const lees = async (id) => (await vraag("GET", `/objecten/${id}`)).json();

test("een eigen statusveld: vergrendelen, termijn, classificeren verplicht, doorgeven aan de zaak", { skip: overslaan }, async () => {
  // MDTO met een eigen keuzeveld met de rol status.
  const config = standaardConfig("mdto");
  config.naam = "MDTO Heiloo";
  config.velden.push({ sleutel: "zaakstatus", aan: true, verplicht: false, label: "Status", eigen: { type: "keuze", opties: STATUSSEN, rol: "status" } });
  const t = await vraag("POST", "/objecttypen/document/model", { config });
  assert.equal(t.statusCode, 201, t.body);
  assert.deepEqual((await vraag("GET", "/classificatiemodel")).json().statussen, STATUSSEN);

  const model = {
    naam: "Heiloo",
    selectielijst: "gemeenten-2020",
    attributen: [{ sleutel: "kenmerk", label: "Kenmerk", type: "tekst", verplicht: false, verplichtBij: ["afgesloten"] }],
    vergrendelBij: ["afgesloten", "geannuleerd"],
    termijnStartBij: "afgesloten",
    classificerenVerplichtBij: ["afgesloten", "geannuleerd"],
    doorgevenBij: ["afgesloten", "geannuleerd"],
    statusKlassen: [{ status: "geannuleerd", namen: ["Afgebroken", "Ingetrokken"] }],
  };
  // Een status die het metadatamodel niet kent: fout.
  assert.equal((await vraag("POST", "/classificatiemodel", { config: { ...model, doorgevenBij: ["gesloten"] } })).statusCode, 422);
  const p = await vraag("POST", "/classificatiemodel", { config: model });
  assert.equal(p.statusCode, 201, p.body);

  // Een nieuw stuk kan niet meteen afgesloten zijn: het is nog niet geclassificeerd.
  const nieuw = await vraag("POST", "/objecten", { objecttype: "document", metadata: md("afgesloten") });
  assert.equal(nieuw.statusCode, 409);
  assert.equal(nieuw.json().fout, "status-vraagt-classificatie");

  const a = await maak("ontvangen");
  const b = await maak("in behandeling");
  const cId = await maak("in behandeling");
  const anders = await maak("in behandeling", "Z-2026-999");

  // Afsluiten zonder classificatie: geweigerd.
  let r = await zet(a, "afgesloten");
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().fout, "status-vraagt-classificatie");

  // Classificeren; het kenmerk is pas bij afgesloten verplicht.
  assert.equal((await vraag("PUT", `/objecten/${a}/classificatie`, { resultaat: "1.1" })).statusCode, 200);
  r = await zet(a, "afgesloten");
  assert.equal(r.statusCode, 409);
  assert.match(r.json().melding, /Kenmerk is verplicht/);
  assert.equal((await vraag("PUT", `/objecten/${a}/classificatie`, { resultaat: "1.1", attributen: { kenmerk: "K-1" } })).statusCode, 200);

  // De andere stukken in de zaak zijn nog niet geclassificeerd: niemand wordt afgesloten.
  r = await zet(a, "afgesloten");
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().fout, "status-zaak-onvolledig");
  assert.equal((await lees(a)).metadata.zaakstatus, "ontvangen");
  assert.equal((await lees(b)).metadata.zaakstatus, "in behandeling");

  for (const id of [b, cId]) assert.equal((await vraag("PUT", `/objecten/${id}/classificatie`, { resultaat: "1.1", attributen: { kenmerk: "K-2" } })).statusCode, 200);
  r = await zet(a, "afgesloten");
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().doorgegeven, { status: "afgesloten", aantal: 2, rol: "zaak", waarde: "Z-2026-001" });

  for (const id of [a, b, cId]) {
    const o = await lees(id);
    assert.equal(o.metadata.zaakstatus, "afgesloten");
    assert.deepEqual(o.vergrendeld, { status: "afgesloten" });
    assert.equal(o.statusdata.afgesloten, vandaag());
    assert.equal(o.bewaren.brondatum, vandaag());
    assert.equal(o.bewaren.archiefactiedatum, telOp(vandaag(), o.bewaren.bewaartermijn));
  }
  // Een stuk in een andere zaak blijft zoals het was.
  assert.equal((await lees(anders)).metadata.zaakstatus, "in behandeling");
  // Het doorgeven staat in de geschiedenis van het andere stuk.
  const g = (await vraag("GET", `/objecten/${b}/gebeurtenissen`)).json();
  const laatste = (Array.isArray(g) ? g : g.gebeurtenissen).at(-1);
  assert.equal(laatste.gegevens?.doorgegeven?.van ?? laatste.data?.doorgegeven?.van, a);

  // Het kenmerk is bij een afgesloten stuk verplicht bij classificeren (vrijgever, want vergrendeld).
  const VRIJ = { sub: "v-2", naam: "Vera", vrijgever: true };
  assert.equal((await vraag("PUT", `/objecten/${a}/classificatie`, { resultaat: "1.1" }, VRIJ)).statusCode, 422);
});
