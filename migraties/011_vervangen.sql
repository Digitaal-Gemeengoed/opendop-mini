-- Een geplande versie die nog niet is ingegaan, mag de beheerder wijzigen.
-- De tabellen blijven alleen-toevoegen: wijzigen is een nieuwe versie die de
-- geplande vervangt. De geplande krijgt een rij in ingetrokken_versies, met
-- de versie die haar vervangt. Geen stuk kan naar een geplande versie
-- verwijzen (die geldt nog niet), dus er raakt niets los.

ALTER TABLE ingetrokken_versies ADD COLUMN IF NOT EXISTS vervangen_door integer;
