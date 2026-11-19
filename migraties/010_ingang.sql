-- Een ingangsdatum per versie van het metadatamodel (objecttype) en het
-- classificatiemodel. Een versie met een ingang in de toekomst is gepland:
-- tot die dag geldt de huidige versie. Een geplande versie kan worden
-- ingetrokken; de tabellen blijven alleen-toevoegen (de app-rol kan niet
-- wijzigen of verwijderen), dus intrekken is een eigen rij.

ALTER TABLE objecttypen ADD COLUMN IF NOT EXISTS ingang timestamptz;
UPDATE objecttypen SET ingang = gepubliceerd WHERE ingang IS NULL;
ALTER TABLE objecttypen ALTER COLUMN ingang SET DEFAULT now();
ALTER TABLE objecttypen ALTER COLUMN ingang SET NOT NULL;

ALTER TABLE classificatiemodellen ADD COLUMN IF NOT EXISTS ingang timestamptz;
UPDATE classificatiemodellen SET ingang = gepubliceerd WHERE ingang IS NULL;
ALTER TABLE classificatiemodellen ALTER COLUMN ingang SET DEFAULT now();
ALTER TABLE classificatiemodellen ALTER COLUMN ingang SET NOT NULL;

CREATE TABLE IF NOT EXISTS ingetrokken_versies (
  gemeente  text NOT NULL REFERENCES gemeenten (id),
  soort     text NOT NULL CHECK (soort IN ('objecttype', 'classificatiemodel')),
  naam      text NOT NULL,
  versie    integer NOT NULL,
  reden     text NOT NULL CHECK (length(reden) BETWEEN 5 AND 1000),
  door      text,
  op        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gemeente, soort, naam, versie)
);
GRANT SELECT, INSERT ON ingetrokken_versies TO oa_app;
ALTER TABLE ingetrokken_versies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS per_gemeente ON ingetrokken_versies;
CREATE POLICY per_gemeente ON ingetrokken_versies
  USING (gemeente = current_setting('oa.gemeente', true))
  WITH CHECK (gemeente = current_setting('oa.gemeente', true));
