import { createHash } from "node:crypto";
import pg from "pg";
import { rolWaarden, type Actor } from "@digitaalgemeengoed/oa-contract";
import { datasleutel, legGebeurtenisVast, leesInhoud, leesWeergave, type Middelen } from "./objecten.js";
import { alsPagina, eersteKop, GeenOmzetter, metEigenschappen, OM_TE_ZETTEN, PDFA_PROFIEL, type Omzetter } from "./omzetter.js";
import { versleutel } from "./sleutelbeheer.js";
import { tekstUit, type Zoekindex } from "./zoekindex.js";

/** Wie de worker is in de gebeurtenissen. */
const SYSTEEM: Actor = { sub: "opendop-mini:worker", naam: "Platform (achtergrondtaak)" };

/**
 * Verwerkt de outbox: het zware werk na een vastlegging (OA-ADR-003).
 *
 * De worker verbindt met de beheerverbinding, omdat hij voor alle
 * gemeenten werkt. Het formaat van de taken is zo gekozen dat Debezium en
 * Kafka later kunnen worden ingeschoven zonder de gebeurtenissen te
 * veranderen.
 */
export interface Taak {
  id: number;
  gemeente: string;
  volgnummer: number;
  taak: string;
}
export type Taakverwerker = (taak: Taak) => Promise<void>;

/**
 * Taak "zoekindex": zet de huidige stand van het object in de index van de
 * gemeente, of haalt het eruit als het onleesbaar is gemaakt. Indexeert
 * altijd de huidige stand, dus de volgorde van taken maakt niet uit.
 * Versleutelde inhoud wordt hiervoor ontsleuteld; de index bevat dus
 * leesbare tekst en hoort even goed beschermd te worden als de opslag.
 */
export function maakVerwerkers(pool: pg.Pool, m: Middelen, zoekindex: Zoekindex, omzetter: Omzetter = new GeenOmzetter()): Record<string, Taakverwerker> {
  return {
    /**
     * Taak "pdfa": een duurzame weergave in PDF/A-2b (met PDF/UA) van een
     * nieuwe versie of een geanonimiseerde weergave (Archiefregeling 2026,
     * art. 2.9). Bij een gewone versie gaan titel, auteur, omschrijving,
     * trefwoorden en taal uit de metadata mee als documenteigenschappen. Een
     * geanonimiseerde weergave krijgt alleen haar eigen eerste kop als titel:
     * de metadata kunnen persoonsgegevens bevatten.
     */
    pdfa: async ({ gemeente, volgnummer }) => {
      if (omzetter.soort === "uit") return;
      const g = await pool.query("SELECT type, object_id, gegevens FROM gebeurtenissen WHERE volgnummer = $1", [volgnummer]);
      const ev = g.rows[0];
      if (!ev?.object_id) return;
      const id: string = ev.object_id;
      const o = (await pool.query("SELECT * FROM objecten WHERE identificatie = $1", [id])).rows[0];
      if (!o || o.onleesbaar_gemaakt || o.aard === "persoonlijk") return;
      const c = pool as unknown as pg.PoolClient;
      const t = await pool.query("SELECT schema FROM objecttypen WHERE gemeente IN ($1, '*') AND naam = $2 AND versie = $3 ORDER BY gemeente = '*' LIMIT 1", [gemeente, o.objecttype_naam, o.objecttype_versie]);
      const rollen = rolWaarden(t.rows[0]?.schema, o.metadata ?? {});
      let bron: { formaat: string; data: Buffer };
      let nummer: number, soort: "weergave" | "geanonimiseerd", wvolgnummer: number;
      if (ev.type === "versie.vastgelegd") {
        nummer = Number(ev.gegevens.nummer);
        soort = "weergave";
        wvolgnummer = 1;
        const inhoud = await leesInhoud(c, m, gemeente, id, nummer);
        if (OM_TE_ZETTEN.has(inhoud.formaat) && inhoud.formaat !== "html") {
          const anoniem = ev.gegevens.soort === "anonimisering";
          bron = {
            formaat: inhoud.formaat,
            data: anoniem
              ? inhoud.data
              : metEigenschappen(inhoud.formaat, inhoud.data, {
                  titel: rollen.titel,
                  auteur: rollen.auteur,
                  omschrijving: rollen.omschrijving,
                  trefwoorden: rollen.trefwoorden,
                  taal: rollen.taal,
                }),
          };
        } else {
          // Alleen html (zoals de demo-tekstverwerker): de html zelf, of de html-weergave.
          const html = inhoud.formaat === "html" ? inhoud : await leesWeergave(c, m, gemeente, id, nummer, "html").catch(() => null);
          if (!html) return;
          bron = { formaat: "html", data: Buffer.from(alsPagina(html.data.toString("utf8"), rollen.titel, taalCode(rollen.taal))) };
        }
      } else if (ev.type === "anonimisering.vastgelegd") {
        nummer = Number(ev.gegevens.versie);
        soort = "geanonimiseerd";
        wvolgnummer = Number(ev.gegevens.volgnummer);
        const html = await leesWeergave(c, m, gemeente, id, nummer, "html", "geanonimiseerd");
        const tekst = html.data.toString("utf8");
        bron = { formaat: "html", data: Buffer.from(alsPagina(tekst, eersteKop(tekst), taalCode(rollen.taal))) };
      } else return;

      const al = await pool.query("SELECT 1 FROM weergaven WHERE object = $1 AND nummer = $2 AND formaat = 'pdf' AND soort = $3 AND volgnummer = $4", [id, nummer, soort, wvolgnummer]);
      if (al.rowCount) return;
      const pdf = await omzetter.naarPdfa(bron);
      const sha = createHash("sha256").update(pdf).digest("hex");
      const ruimte = o.aard;
      const v = (await pool.query("SELECT versleuteld FROM versies WHERE object = $1 AND nummer = $2", [id, nummer])).rows[0];
      const dek = v?.versleuteld ? await datasleutel(m, gemeente, id, o.sleutel_verpakt) : null;
      const binding = soort === "weergave" ? `${id}/${nummer}/pdf` : `${id}/${nummer}/pdf/${soort}-${wvolgnummer}`;
      const sleutel = `${id}/${nummer}-${soort === "weergave" ? "" : `${soort}-${wvolgnummer}-`}${sha.slice(0, 16)}.pdf`;
      await m.opslag.schrijf(gemeente, sleutel, dek ? versleutel(dek, pdf, binding) : pdf, dek ? "application/octet-stream" : "application/pdf", ruimte);
      await pool.query(
        `INSERT INTO weergaven (object, gemeente, nummer, formaat, media_type, sha256, grootte, opslagsleutel, versleuteld, ruimte, soort, volgnummer, profiel)
         VALUES ($1, $2, $3, 'pdf', 'application/pdf', $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING`,
        [id, gemeente, nummer, sha, pdf.length, sleutel, !!dek, ruimte, soort, wvolgnummer, PDFA_PROFIEL],
      );
      // In de geschiedenis van het stuk (beheeractiviteit, art. 2.5 onder i). Geen nieuw volgnummer voor
      // het object: een medewerker die intussen opslaat, krijgt zo geen conflict.
      await legGebeurtenisVast(pool as unknown as pg.PoolClient, gemeente, "weergave.toegevoegd", id, SYSTEEM, {
        nummer, formaat: "pdf", profiel: PDFA_PROFIEL, sha256: sha, grootte: pdf.length, ...(soort === "geanonimiseerd" ? { soort, volgnummer: wvolgnummer } : {}),
      });
    },
    zoekindex: async ({ gemeente, volgnummer }) => {
      if (zoekindex.soort === "uit") return;
      const g = await pool.query("SELECT object_id FROM gebeurtenissen WHERE volgnummer = $1", [volgnummer]);
      const id: string | null = g.rows[0]?.object_id ?? null;
      if (!id) return;
      const o = await pool.query("SELECT * FROM objecten WHERE identificatie = $1", [id]);
      const obj = o.rows[0];
      // Persoonlijke stukken horen niet in de zoekindex.
      if (!obj || obj.onleesbaar_gemaakt || obj.aard === "persoonlijk") {
        await zoekindex.verwijder(gemeente, id);
        return;
      }
      const v = await pool.query("SELECT nummer FROM versies WHERE object = $1 ORDER BY nummer DESC LIMIT 1", [id]);
      const versie: number | null = v.rows[0]?.nummer ?? null;
      let tekst = "";
      if (versie !== null) {
        // Heeft de versie een html-weergave (naast een docx of odt), indexeer die.
        const w = await pool.query("SELECT 1 FROM weergaven WHERE object = $1 AND nummer = $2 AND formaat = 'html' AND soort = 'weergave'", [id, versie]);
        const c = pool as unknown as pg.PoolClient;
        const inhoud = w.rowCount ? await leesWeergave(c, m, gemeente, id, versie, "html") : await leesInhoud(c, m, gemeente, id, versie);
        tekst = tekstUit(inhoud.formaat, inhoud.data);
      }
      // De index kent vaste velden (naam, informatiecategorie …); welk veld van
      // het gekozen metadatamodel daarbij hoort, zegt de rol in het schema.
      const t = await pool.query("SELECT schema FROM objecttypen WHERE gemeente = $1 AND naam = $2 AND versie = $3", [gemeente, obj.objecttype_naam, obj.objecttype_versie]);
      const rollen = rolWaarden(t.rows[0]?.schema, obj.metadata ?? {});
      const { titel, ...rest } = rollen;
      await zoekindex.indexeer(gemeente, {
        identificatie: id,
        objecttype: obj.objecttype_naam,
        versie,
        metadata: { ...(titel ? { naam: titel } : {}), ...rest },
        tekst,
        bijgewerkt: new Date().toISOString(),
      });
    },
  };
}

export async function verwerkRonde(pool: pg.Pool, verwerkers: Record<string, Taakverwerker>, maxPerRonde = 20): Promise<number> {
  const c = await pool.connect();
  let aantal = 0;
  try {
    await c.query("BEGIN");
    const r = await c.query(
      `SELECT id, gemeente, volgnummer, taak FROM outbox
        WHERE status = 'wachtend' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [maxPerRonde],
    );
    for (const t of r.rows) {
      const verwerker = verwerkers[t.taak];
      try {
        if (!verwerker) throw new Error(`geen verwerker voor taak ${t.taak}`);
        await verwerker({ id: Number(t.id), gemeente: t.gemeente, volgnummer: Number(t.volgnummer), taak: t.taak });
        await c.query("UPDATE outbox SET status = 'klaar', verwerkt = now(), pogingen = pogingen + 1 WHERE id = $1", [t.id]);
      } catch (e) {
        await c.query(
          `UPDATE outbox SET pogingen = pogingen + 1, laatste_fout = $2, verwerkt = now(),
                  status = CASE WHEN pogingen + 1 >= 5 THEN 'mislukt' ELSE 'wachtend' END
            WHERE id = $1`,
          [t.id, (e as Error).message.slice(0, 500)],
        );
      }
      aantal++;
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  return aantal;
}

/** "dut" of "nl" naar een taalcode voor html (lang). */
function taalCode(t: string | undefined): string {
  const c = (t ?? "nl").toLowerCase();
  return ({ dut: "nl", nld: "nl", eng: "en", ger: "de", deu: "de", fre: "fr", fra: "fr", fry: "fy" } as Record<string, string>)[c] ?? (/^[a-z]{2}$/.test(c) ? c : "nl");
}

/**
 * Integriteitscontrole (Archiefregeling 2026, art. 2.8 onder b; art. 2.10):
 * leest een versie terug, ontsleutelt haar en vergelijkt de sha256 met de
 * registratie. Elke versie komt eens per `dagen` aan de beurt; de oudste
 * eerst. Het resultaat komt in integriteitscontroles. Klopt het niet, dan een
 * gebeurtenis en een melding in het log: mogelijk een incident dat binnen 72
 * uur gemeld moet worden (art. 7.1).
 */
export async function controleerIntegriteit(pool: pg.Pool, m: Middelen, opties: { perRonde?: number; dagen?: number; gemeente?: string } = {}): Promise<{ gecontroleerd: number; afwijkingen: number }> {
  const r = await pool.query(
    `SELECT v.object, v.nummer, v.gemeente FROM versies v JOIN objecten o ON o.identificatie = v.object
       LEFT JOIN LATERAL (SELECT max(tijdstip) AS t FROM integriteitscontroles i WHERE i.object = v.object AND i.nummer = v.nummer) ic ON true
      WHERE o.onleesbaar_gemaakt IS NULL AND (ic.t IS NULL OR ic.t < now() - make_interval(days => $2))
        AND ($3::text IS NULL OR v.gemeente = $3)
      ORDER BY ic.t NULLS FIRST, v.vastgelegd LIMIT $1`,
    [opties.perRonde ?? 50, opties.dagen ?? 30, opties.gemeente ?? null],
  );
  let afwijkingen = 0;
  for (const v of r.rows) {
    let resultaat: "ok" | "afwijkend" | "onleesbaar" = "ok";
    let melding: string | null = null;
    try {
      await leesInhoud(pool as unknown as pg.PoolClient, m, v.gemeente, v.object, v.nummer);
    } catch (e) {
      melding = (e as Error).message.slice(0, 500);
      resultaat = /wijkt af/.test(melding) ? "afwijkend" : "onleesbaar";
    }
    await pool.query("INSERT INTO integriteitscontroles (object, gemeente, nummer, resultaat, melding) VALUES ($1, $2, $3, $4, $5)", [v.object, v.gemeente, v.nummer, resultaat, melding]);
    if (resultaat !== "ok") {
      afwijkingen++;
      await legGebeurtenisVast(pool as unknown as pg.PoolClient, v.gemeente, "integriteit.afwijking", v.object, SYSTEEM, { nummer: v.nummer, resultaat, melding });
      console.error(`INTEGRITEIT: ${v.gemeente} ${v.object} versie ${v.nummer}: ${resultaat} (${melding}). Mogelijk een incident: melden bij de Inspectie binnen 72 uur (Archiefregeling 2026, art. 7.1).`);
    }
  }
  return { gecontroleerd: r.rowCount ?? 0, afwijkingen };
}

export async function draaiWorker(
  url: string,
  m: Middelen,
  zoekindex: Zoekindex,
  intervalMs = 1000,
  opties: { omzetter?: Omzetter; integriteitMinuten?: number; integriteitDagen?: number } = {},
): Promise<() => void> {
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  const verwerkers = maakVerwerkers(pool, m, zoekindex, opties.omzetter);
  let actief = true;
  const controle = setInterval(() => {
    // Mislukt omzetten (omzetter even weg): na een uur opnieuw proberen.
    pool
      .query("UPDATE outbox SET status = 'wachtend', pogingen = 0 WHERE taak = 'pdfa' AND status = 'mislukt' AND coalesce(verwerkt, aangemaakt) < now() - interval '1 hour'")
      .catch(() => undefined);
    controleerIntegriteit(pool, m, { dagen: opties.integriteitDagen })
      .then((u) => u.gecontroleerd && console.log(`integriteit: ${u.gecontroleerd} versie(s) gecontroleerd, ${u.afwijkingen} afwijking(en)`))
      .catch((e: Error) => console.error("integriteit:", e.message));
  }, (opties.integriteitMinuten ?? 10) * 60_000);
  controle.unref();
  const lus = async () => {
    while (actief) {
      try {
        const n = await verwerkRonde(pool, verwerkers);
        if (n === 0) await new Promise((r) => setTimeout(r, intervalMs));
      } catch (e) {
        console.error("worker:", (e as Error).message);
        await new Promise((r) => setTimeout(r, intervalMs * 5));
      }
    }
    await pool.end();
  };
  void lus();
  return () => {
    actief = false;
    clearInterval(controle);
  };
}
