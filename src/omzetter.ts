import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

/**
 * Een duurzame weergave in PDF/A-2b (Archiefregeling 2026, art. 2.9: zo vroeg
 * mogelijk in een duurzaam bestandsformaat), met PDF/UA voor de
 * toegankelijkheid. Het omzetten doet Gotenberg (LibreOffice en Chromium in
 * een container op VPS 2). Metadata gaan er vóór het omzetten in, als
 * documenteigenschappen: achteraf in de PDF schrijven breekt PDF/A.
 */
export const PDFA_PROFIEL = "PDF/A-2b, PDF/UA-1";

export interface Omzetter {
  soort: "gotenberg" | "uit";
  /** Kantoorbestand (docx, odt, xlsx …) of html naar PDF/A-2b. */
  naarPdfa(bestand: { formaat: string; data: Buffer }): Promise<Buffer>;
}

/** Formaten die de omzetter aankan. */
export const OM_TE_ZETTEN = new Set(["docx", "odt", "xlsx", "ods", "pptx", "odp", "html"]);

export class GeenOmzetter implements Omzetter {
  readonly soort = "uit" as const;
  async naarPdfa(): Promise<Buffer> {
    throw new Error("Er is geen omzetter ingesteld (OMZETTER_URL).");
  }
}

export class Gotenberg implements Omzetter {
  readonly soort = "gotenberg" as const;
  constructor(
    private readonly url: string,
    private readonly doeFetch: typeof fetch = fetch,
    private readonly wachttijdMs = 120_000,
  ) {}

  async naarPdfa(bestand: { formaat: string; data: Buffer }): Promise<Buffer> {
    if (!OM_TE_ZETTEN.has(bestand.formaat)) throw new Error(`Formaat ${bestand.formaat} kan niet naar PDF/A.`);
    const html = bestand.formaat === "html";
    const f = new FormData();
    // Chromium wil precies index.html; LibreOffice herkent het formaat aan de extensie.
    f.append("files", new Blob([new Uint8Array(bestand.data)]), html ? "index.html" : `stuk.${bestand.formaat}`);
    f.append("pdfa", "PDF/A-2b");
    f.append("pdfua", "true");
    const pad = html ? "/forms/chromium/convert/html" : "/forms/libreoffice/convert";
    const r = await this.doeFetch(`${this.url.replace(/\/$/, "")}${pad}`, { method: "POST", body: f, signal: AbortSignal.timeout(this.wachttijdMs) });
    if (!r.ok) throw new Error(`Omzetten naar PDF/A mislukte: ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
    const pdf = Buffer.from(await r.arrayBuffer());
    if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("De omzetter gaf geen PDF terug.");
    return pdf;
  }
}

export interface Eigenschappen {
  titel?: string;
  auteur?: string;
  onderwerp?: string;
  omschrijving?: string;
  trefwoorden?: string;
  taal?: string;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Zet of vervangt <tag>waarde</tag> binnen het blok; het blok sluit met `slot`. */
function zet(blok: string, tag: string, waarde: string | undefined, slot: string): string {
  if (!waarde?.trim()) return blok;
  const nieuw = `<${tag}>${xml(waarde.trim())}</${tag}>`;
  const bestaand = new RegExp(`<${tag}(\\s[^>]*)?(/>|>[\\s\\S]*?</${tag}>)`);
  if (bestaand.test(blok)) return blok.replace(bestaand, nieuw);
  return blok.replace(slot, `${nieuw}${slot}`);
}

/**
 * De metadata als documenteigenschappen in een kopie van het bestand (docx of
 * odt), zodat LibreOffice ze bij het omzetten in de XMP van de PDF/A zet
 * (dc:title, dc:creator, dc:description, pdf:Keywords, dc:language). Andere
 * formaten, of een bestand dat niet te lezen is: ongewijzigd.
 */
export function metEigenschappen(formaat: string, data: Buffer, e: Eigenschappen): Buffer {
  if (formaat !== "docx" && formaat !== "odt") return data;
  let bestanden: Record<string, Uint8Array>;
  try {
    bestanden = unzipSync(new Uint8Array(data));
  } catch {
    return data;
  }
  if (formaat === "docx") {
    const core = bestanden["docProps/core.xml"];
    if (!core) return data;
    let s = strFromU8(core);
    const slot = "</cp:coreProperties>";
    if (!s.includes(slot)) return data;
    s = zet(s, "dc:title", e.titel, slot);
    s = zet(s, "dc:creator", e.auteur, slot);
    s = zet(s, "dc:subject", e.onderwerp, slot);
    s = zet(s, "dc:description", e.omschrijving, slot);
    s = zet(s, "cp:keywords", e.trefwoorden, slot);
    s = zet(s, "dc:language", e.taal, slot);
    bestanden["docProps/core.xml"] = strToU8(s);
  } else {
    const meta = bestanden["meta.xml"];
    if (!meta) return data;
    let s = strFromU8(meta);
    const slot = "</office:meta>";
    if (!s.includes(slot)) return data;
    s = zet(s, "dc:title", e.titel, slot);
    s = zet(s, "dc:creator", e.auteur, slot);
    s = zet(s, "dc:subject", e.onderwerp, slot);
    s = zet(s, "dc:description", e.omschrijving, slot);
    s = zet(s, "dc:language", e.taal, slot);
    if (e.trefwoorden?.trim()) {
      s = s.replace(/<meta:keyword>[\s\S]*?<\/meta:keyword>/g, "");
      const woorden = e.trefwoorden.split(",").map((w) => w.trim()).filter(Boolean);
      s = s.replace(slot, `${woorden.map((w) => `<meta:keyword>${xml(w)}</meta:keyword>`).join("")}${slot}`);
    }
    bestanden["meta.xml"] = strToU8(s);
  }
  // ODF: "mimetype" eerst en ongecomprimeerd.
  const uit: Zippable = {};
  if (bestanden.mimetype) uit.mimetype = [bestanden.mimetype, { level: 0 }];
  for (const [naam, inhoud] of Object.entries(bestanden)) if (naam !== "mimetype") uit[naam] = inhoud;
  return Buffer.from(zipSync(uit));
}

/** Html-fragment (de weergave van de assistent) als volledige pagina met taal en titel, zoals PDF/UA vraagt. */
export function alsPagina(fragment: string, titel: string | undefined, taal = "nl"): string {
  if (/^\s*<!doctype html/i.test(fragment) || /^\s*<html/i.test(fragment)) return fragment;
  return `<!doctype html><html lang="${xml(taal)}"><head><meta charset="utf-8"><title>${xml(titel?.trim() || "Document")}</title></head><body>${fragment}</body></html>`;
}

/** De eerste kop (de titelregel of kop 1) als tekst: de titel van een geanonimiseerde weergave. */
export function eersteKop(html: string): string | undefined {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const t = m?.[1]?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return t || undefined;
}
