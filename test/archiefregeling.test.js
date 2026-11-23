// Archiefregeling 2026 (Stcrt. 2026, 40895) tegen een echte PostgreSQL:
// openbaarheid (art. 2.12), werkomgeving en integriteitscontroles (art. 2.8),
// en de duurzame weergave in PDF/A (art. 2.9). Zonder database overgeslagen.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { standaardConfig } from "@digitaalgemeengoed/oa-contract";
import { migreer } from "../dist/migreer.js";
import { maakPool } from "../dist/db.js";
import { LokaleOpslag } from "../dist/opslag.js";
import { bouwServer } from "../dist/server.js";
import { controleerIntegriteit, maakVerwerkers, verwerkRonde } from "../dist/worker.js";
import { GeenZoekindex } from "../dist/zoekindex.js";
import pg from "pg";

const BEHEER = process.env.TEST_DATABASE_URL_BEHEER;
const APP = process.env.TEST_DATABASE_URL;
const overslaan = !BEHEER || !APP;
const SLEUTEL = "test-dienstsleutel-0123456789";
const G = "archieftest";

let app, map, pool, beheer, middelen, verwerkers;
const omgezet = [];
const nepOmzetter = { soort: "gotenberg", naarPdfa: async (b) => (omgezet.push(b), Buffer.from(`%PDF-1.7 nep van ${b.formaat}`)) };

const kop = (sub = "medewerker-1", extra = {}) => ({
  "x-oa-dienstsleutel": SLEUTEL,
  "x-oa-gemeente": G,
  "x-oa-actor": Buffer.from(JSON.stringify({ sub, naam: sub, ...extra })).toString("base64url"),
});
const html = (s) => ({ formaat: "html", mediaType: "text/html", codering: "tekst", data: s });

before(async () => {
  if (overslaan) return;
  await migreer(BEHEER, { gemeenten: [{ id: G, naam: "Gemeente Archieftest" }] });
  pool = maakPool(APP);
  beheer = new pg.Pool({ connectionString: BEHEER, max: 2 });
  map = await mkdtemp(join(tmpdir(), "oa-archief-"));
  middelen = { opslag: new LokaleOpslag(map), sleutelbeheer: null, maxBytes: 1024 * 1024 };
  app = bouwServer({ middelen, zoekindex: new GeenZoekindex(), dienstsleutel: SLEUTEL, log: false });
  verwerkers = maakVerwerkers(beheer, middelen, new GeenZoekindex(), nepOmzetter);
  // Het standaardmodel MDTO, zoals een gemeente het publiceert.
  const r = await app.inject({ method: "POST", url: "/objecttypen/document/model", headers: kop("beheer:1", { beheerder: true }), payload: { config: standaardConfig("mdto") } });
  assert.equal(r.statusCode, 201, r.body);
});

after(async () => {
  if (overslaan) return;
  await app.close();
  await pool.end();
  await beheer.end();
  await rm(map, { recursive: true, force: true });
});

let id;

test("openbaarheid: beperkt openbaar vraagt grond, duur en einddatum; de duur past bij de grond", { skip: overslaan }, async () => {
  let r = await app.inject({ method: "POST", url: "/objecten", headers: kop(), payload: { objecttype: "document", metadata: { naam: "Gespreksverslag", openbaarheid: "beperkt openbaar" }, inhoud: html("<h1>Gespreksverslag</h1>"), omgeving: { werkomgeving: { id: "word", naam: "Microsoft Word", versie: "Word 16.0.18129", platform: "PC" }, browser: "Mozilla/5.0 Edge" } } });
  assert.equal(r.statusCode, 201, r.body);
  const o = r.json();
  id = o.identificatie;
  for (const k of ["beperkingsgrond", "beperkingstermijn", "beperkingEinddatum"]) assert.ok(o.volledigheid.ontbreekt.includes(k), k);
  // 30 jaar mag niet bij een grond van ten hoogste 20 jaar (artikel 7.4).
  r = await app.inject({ method: "PUT", url: `/objecten/${id}/metadata`, headers: kop(), payload: { metadata: { naam: "Gespreksverslag", openbaarheid: "beperkt openbaar", beperkingsgrond: "art. 7.2 lid 2 onder d — inspectie, controle en toezicht", beperkingstermijn: 30, beperkingEinddatum: "2056-11-23" } } });
  assert.equal(r.statusCode, 422, r.body);
  assert.ok(r.json().details.some((d) => d.veld === "beperkingstermijn" && /Ten hoogste 20/.test(d.melding)), r.body);
  r = await app.inject({ method: "PUT", url: `/objecten/${id}/metadata`, headers: kop(), payload: { metadata: { naam: "Gespreksverslag", openbaarheid: "beperkt openbaar", beperkingsgrond: "art. 7.2 lid 2 onder e — eerbiediging van de persoonlijke levenssfeer", beperkingstermijn: 110, beperkingEinddatum: "2136-11-23" } } });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(!r.json().volledigheid.ontbreekt.some((k) => k.startsWith("beperkings") || k === "beperkingEinddatum"));
});

test("werkomgeving: bij de versie, aangevuld met het platform (art. 2.8 onder a)", { skip: overslaan }, async () => {
  const o = (await app.inject({ method: "GET", url: `/objecten/${id}`, headers: kop() })).json();
  const om = o.versies[0].omgeving;
  assert.deepEqual(om.werkomgeving, { id: "word", naam: "Microsoft Word", versie: "Word 16.0.18129", platform: "PC" });
  assert.equal(om.browser, "Mozilla/5.0 Edge");
  assert.equal(om.platform.naam, "opendop-mini");
  assert.match(om.platform.runtime, /^Node\.js v\d+/);
  // Te lang of rommel: ingekort of weggelaten.
  const r = await app.inject({ method: "POST", url: `/objecten/${id}/versies`, headers: kop(), payload: { inhoud: html("<h1>Gespreksverslag</h1><p>2</p>"), omgeving: { werkomgeving: { id: "x".repeat(100), naam: 5 }, browser: "b".repeat(400) } } });
  assert.equal(r.statusCode, 201, r.body);
  const v2 = r.json().versies[1].omgeving;
  assert.equal(v2.werkomgeving.id.length, 60);
  assert.equal(v2.werkomgeving.naam, undefined);
  assert.equal(v2.browser.length, 300);
});

test("PDF/A: de worker maakt een duurzame weergave van elke nieuwe versie (art. 2.9)", { skip: overslaan }, async () => {
  while ((await verwerkRonde(beheer, verwerkers)) > 0);
  const o = (await app.inject({ method: "GET", url: `/objecten/${id}`, headers: kop() })).json();
  for (const v of o.versies) {
    const pdf = v.weergaven?.find((w) => w.formaat === "pdf");
    assert.ok(pdf, `versie ${v.nummer} heeft een PDF`);
    assert.equal(pdf.profiel, "PDF/A-2b, PDF/UA-1");
  }
  // Html gaat als volledige pagina met taal en titel naar de omzetter.
  assert.match(omgezet[0].data.toString(), /^<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>Gespreksverslag<\/title>/);
  const r = await app.inject({ method: "GET", url: `/objecten/${id}/versies/1/weergaven/pdf`, headers: kop() });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /^%PDF-1\.7 nep van html/);
  // In de geschiedenis, zonder dat het volgnummer van het stuk verandert.
  const g = (await app.inject({ method: "GET", url: `/objecten/${id}/gebeurtenissen`, headers: kop() })).json();
  assert.equal(g.filter((x) => x.type === "weergave.toegevoegd" && x.gegevens.formaat === "pdf").length, 2);
  // Nogmaals verwerken maakt niets dubbel.
  const n = omgezet.length;
  await beheer.query("UPDATE outbox SET status = 'wachtend' WHERE taak = 'pdfa'");
  while ((await verwerkRonde(beheer, verwerkers)) > 0);
  assert.equal(omgezet.length, n);
});

test("integriteit: elke versie wordt gecontroleerd; een afwijking wordt een gebeurtenis (art. 2.8 onder b)", { skip: overslaan }, async () => {
  let u = await controleerIntegriteit(beheer, middelen, { perRonde: 100, gemeente: G });
  assert.ok(u.gecontroleerd >= 2);
  assert.equal(u.afwijkingen, 0);
  let o = (await app.inject({ method: "GET", url: `/objecten/${id}`, headers: kop() })).json();
  assert.equal(o.versies[0].integriteit.resultaat, "ok");
  // Pas na de termijn opnieuw.
  assert.equal((await controleerIntegriteit(beheer, middelen, { perRonde: 100, gemeente: G })).gecontroleerd, 0);
  // Iemand knoeit met het opgeslagen bestand van versie 1.
  const bestanden = await readdir(join(map, G, id));
  const v1 = bestanden.find((b) => b.startsWith("1-") && !b.includes("."));
  await writeFile(join(map, G, id, v1), Buffer.concat([await readFile(join(map, G, id, v1)), Buffer.from("x")]));
  const fout = console.error;
  const meldingen = [];
  console.error = (m) => meldingen.push(m);
  try {
    u = await controleerIntegriteit(beheer, middelen, { perRonde: 100, dagen: 0, gemeente: G });
  } finally {
    console.error = fout;
  }
  assert.equal(u.afwijkingen, 1);
  assert.match(meldingen.join("\n"), /72 uur/);
  o = (await app.inject({ method: "GET", url: `/objecten/${id}`, headers: kop() })).json();
  assert.equal(o.versies[0].integriteit.resultaat, "afwijkend");
  const g = (await app.inject({ method: "GET", url: `/objecten/${id}/gebeurtenissen`, headers: kop() })).json();
  assert.ok(g.some((x) => x.type === "integriteit.afwijking" && x.gegevens.nummer === 1));
});
