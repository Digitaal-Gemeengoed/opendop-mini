-- Archiefregeling 2026 (Stcrt. 2026, 40895).
--
-- Art. 2.8 onder a: bij elke versie de omgeving waarmee ze is gemaakt en
-- vastgelegd (programma en versie, besturingssysteem, browser, platform).
-- Art. 2.8 onder b: de resultaten van integriteitscontroles. Alleen toevoegen;
-- de laatste per versie geldt. De worker controleert periodiek.
-- Art. 2.9: duurzame weergaven (PDF/A-2b) krijgen hun profiel.
ALTER TABLE versies ADD COLUMN IF NOT EXISTS omgeving jsonb;
ALTER TABLE weergaven ADD COLUMN IF NOT EXISTS profiel text;

CREATE TABLE IF NOT EXISTS integriteitscontroles (
  object     uuid NOT NULL,
  gemeente   text NOT NULL REFERENCES gemeenten (id),
  nummer     integer NOT NULL,
  tijdstip   timestamptz NOT NULL DEFAULT now(),
  resultaat  text NOT NULL CHECK (resultaat IN ('ok', 'afwijkend', 'onleesbaar')),
  melding    text CHECK (length(melding) <= 500),
  PRIMARY KEY (object, nummer, tijdstip),
  FOREIGN KEY (object, nummer) REFERENCES versies (object, nummer)
);
CREATE INDEX IF NOT EXISTS integriteitscontroles_laatste ON integriteitscontroles (object, nummer, tijdstip DESC);

GRANT SELECT ON integriteitscontroles TO oa_app;
ALTER TABLE integriteitscontroles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS per_gemeente ON integriteitscontroles;
CREATE POLICY per_gemeente ON integriteitscontroles
  USING (gemeente = current_setting('oa.gemeente', true))
  WITH CHECK (gemeente = current_setting('oa.gemeente', true));
