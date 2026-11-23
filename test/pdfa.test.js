// PDF/A-2b met de metadata in de XMP (Archiefregeling 2026, art. 2.9). De client
// praat met een nagebootste Gotenberg die de echte LibreOffice gebruikt (zoals
// Gotenberg zelf). Zonder soffice wordt de test overgeslagen.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gotenberg, metEigenschappen, alsPagina, eersteKop } from "../dist/omzetter.js";

const soffice = (() => {
  try {
    execFileSync("soffice", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const qpdf = (() => {
  try {
    execFileSync("qpdf", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let map, server, adres;
const ontvangen = [];

/** Zoals Gotenberg: LibreOffice met PDF/A-2 en PDF/UA. */
function zetOm(pad) {
  const filter = 'pdf:writer_pdf_Export:{"SelectPdfVersion":{"type":"long","value":"2"},"PDFUACompliance":{"type":"boolean","value":"true"}}';
  execFileSync("soffice", [`-env:UserInstallation=file://${map}/profiel`, "--headless", "--convert-to", filter, "--outdir", map, pad], { stdio: "ignore", timeout: 120_000 });
  return readFileSync(pad.replace(/\.[a-z]+$/, ".pdf"));
}

before(async () => {
  if (!soffice) return;
  map = mkdtempSync(join(tmpdir(), "oa-pdfa-"));
  server = createServer(async (req, res) => {
    const r = new Request(`http://x${req.url}`, { method: req.method, headers: req.headers, body: req, duplex: "half" });
    const f = await r.formData();
    const bestand = f.get("files");
    ontvangen.push({ pad: req.url, pdfa: f.get("pdfa"), pdfua: f.get("pdfua"), naam: bestand.name });
    const pad = join(map, bestand.name);
    writeFileSync(pad, Buffer.from(await bestand.arrayBuffer()));
    try {
      res.end(zetOm(pad));
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  adres = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  if (map) rmSync(map, { recursive: true, force: true });
});

/** De XMP van de PDF als tekst (qpdf zet de stromen uit elkaar). */
function xmp(pdf) {
  const in_ = join(map, `x-${Date.now()}.pdf`);
  writeFileSync(in_, pdf);
  if (!qpdf) return pdf.toString("latin1");
  const uit = `${in_}.qdf`;
  execFileSync("qpdf", ["--qdf", "--object-streams=disable", in_, uit]);
  return readFileSync(uit).toString("utf8");
}

test("docx: eigenschappen uit de metadata komen in de XMP van een PDF/A-2", { skip: !soffice }, async () => {
  // Een docx zoals Word die bewaart, hier gemaakt door LibreOffice.
  writeFileSync(join(map, "bron.html"), "<html><body><h1>Raadsvoorstel</h1><p>Het college stelt voor.</p></body></html>");
  execFileSync("soffice", [`-env:UserInstallation=file://${map}/profiel`, "--headless", "--convert-to", "docx:MS Word 2007 XML", "--outdir", map, join(map, "bron.html")], { stdio: "ignore", timeout: 120_000 });
  const docx = readFileSync(join(map, "bron.docx"));
  const met = metEigenschappen("docx", docx, { titel: "Raadsvoorstel fietsenstalling & stallingen", auteur: "Femke de Vries", omschrijving: "Krediet voor een stalling.", trefwoorden: "fiets, stalling", taal: "nl-NL" });
  const pdf = await new Gotenberg(adres).naarPdfa({ formaat: "docx", data: met });
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.deepEqual(ontvangen.at(-1), { pad: "/forms/libreoffice/convert", pdfa: "PDF/A-2b", pdfua: "true", naam: "stuk.docx" });
  const x = xmp(pdf);
  assert.match(x, /pdfaid:part[^0-9]*2/, "PDF/A-2");
  // LibreOffice 24.2 escapet een & in de XMP dubbel (&amp;amp;); het Info-woordenboek heeft hem goed.
  assert.match(x, /<dc:title>[\s\S]*Raadsvoorstel fietsenstalling &amp;(amp;)? stallingen/, "titel in de XMP");
  assert.match(x, /Femke de Vries/, "auteur in de XMP");
  assert.match(x, /pdfuaid:part/, "PDF/UA");
});

test("odt: eigenschappen in meta.xml, mimetype blijft voorop", { skip: !soffice }, async () => {
  execFileSync("soffice", [`-env:UserInstallation=file://${map}/profiel`, "--headless", "--convert-to", "odt", "--outdir", map, join(map, "bron.html")], { stdio: "ignore", timeout: 120_000 });
  const odt = readFileSync(join(map, "bron.odt"));
  const met = metEigenschappen("odt", odt, { titel: "Besluit op bezwaar", trefwoorden: "bezwaar, Wmo" });
  assert.equal(met.subarray(30, 38).toString("latin1"), "mimetype");
  const pdf = await new Gotenberg(adres).naarPdfa({ formaat: "odt", data: met });
  assert.match(xmp(pdf), /Besluit op bezwaar/);
});

test("html (zoals een geanonimiseerde weergave): taal en titel voor PDF/UA", async () => {
  const p = alsPagina('<h1 data-oa-stijl="titel">Gespreksverslag [persoon 1]</h1><p>x</p>', eersteKop('<h1 data-oa-stijl="titel">Gespreksverslag [persoon 1]</h1>'), "nl");
  assert.match(p, /^<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>Gespreksverslag \[persoon 1\]<\/title>/);
  assert.equal(alsPagina("<!doctype html><html></html>", "x"), "<!doctype html><html></html>");
});

test("de omzetter weigert wat geen PDF is", async () => {
  const nep = async () => new Response("geen pdf", { status: 200 });
  await assert.rejects(new Gotenberg("http://g", nep).naarPdfa({ formaat: "docx", data: Buffer.from("x") }), /geen PDF/);
  await assert.rejects(new Gotenberg("http://g", nep).naarPdfa({ formaat: "eml", data: Buffer.from("x") }), /kan niet naar PDF\/A/);
});
