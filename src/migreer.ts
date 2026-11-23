import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { OBJECTTYPE_DOCUMENT_V1 } from "@digitaalgemeengoed/oa-contract";

const map = join(dirname(fileURLToPath(import.meta.url)), "..", "migraties");

/**
 * Voert de migraties uit en zet de startgegevens neer: de aangesloten
 * gemeenten en het gedeelde objecttype "document".
 */
export async function migreer(url: string, opties: { appWachtwoord?: string; gemeenten?: { id: string; naam: string }[] } = {}) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migraties (naam text PRIMARY KEY, uitgevoerd timestamptz NOT NULL DEFAULT now())`);
    const bestanden = (await readdir(map)).filter((b) => b.endsWith(".sql")).sort();
    for (const b of bestanden) {
      const al = await c.query("SELECT 1 FROM schema_migraties WHERE naam = $1", [b]);
      if (al.rowCount) continue;
      await c.query("BEGIN");
      await c.query(await readFile(join(map, b), "utf8"));
      await c.query("INSERT INTO schema_migraties (naam) VALUES ($1)", [b]);
      await c.query("COMMIT");
      console.log(`migratie uitgevoerd: ${b}`);
    }
    if (opties.appWachtwoord) {
      await c.query(`ALTER ROLE oa_app PASSWORD ${pg.escapeLiteral(opties.appWachtwoord)}`);
    }
    for (const g of opties.gemeenten ?? []) {
      await c.query("INSERT INTO gemeenten (id, naam) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET naam = EXCLUDED.naam", [g.id, g.naam]);
    }
    const t = OBJECTTYPE_DOCUMENT_V1;
    await c.query(
      `INSERT INTO objecttypen (gemeente, naam, versie, titel, schema, status)
       VALUES ('*', $1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [t.naam, t.versie, t.titel, JSON.stringify(t.schema), t.status],
    );
  } finally {
    await c.end();
  }
}

/**
 * Leest "haarlem:Gemeente Haarlem,zandvoort:Gemeente Zandvoort". Een derde deel
 * met e-maildomeinen ("haarlem:Gemeente Haarlem:haarlem.nl", zoals GEMEENTEN op
 * VPS 3) negeert het platform: die zijn voor Keycloak.
 */
export function leesGemeenten(tekst: string | undefined): { id: string; naam: string }[] {
  return (tekst ?? "")
    .replace(/^"|"$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, ...rest] = s.split(":");
      if (rest.length > 1 && /^[a-z0-9.+-]+$/.test(rest[rest.length - 1]!)) rest.pop();
      return { id: id!.trim(), naam: (rest.join(":") || id!).trim() };
    });
}
