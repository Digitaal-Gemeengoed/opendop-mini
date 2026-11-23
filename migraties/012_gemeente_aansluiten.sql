-- Een gemeente aansluiten zonder migratie: de integratielaag meldt de
-- thuisgemeente aan zodra iemand van die gemeente inlogt (Keycloak
-- Organizations). De applicatie mag daarom een gemeente toevoegen en haar naam
-- bijwerken, maar niet verwijderen. Opslag, zoekindex en sleutels per gemeente
-- maakt het platform aan bij het eerste gebruik.
ALTER TABLE gemeenten ADD COLUMN IF NOT EXISTS aangesloten timestamptz NOT NULL DEFAULT now();
GRANT INSERT ON gemeenten TO oa_app;
GRANT UPDATE (naam) ON gemeenten TO oa_app;
