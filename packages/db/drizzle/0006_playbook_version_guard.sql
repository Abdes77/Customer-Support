-- Playbook versions are immutable documents (hand-written; C1 review, C6).
--
-- 1. Price norms are numbers now. Versions stored before this migration hold a price norm as
--    free text ("range": "$400 to $1,500"). Ranges that are plainly "$a to $b" become
--    lowUsd/highUsd; anything else is dropped, because a figure nobody can read back exactly
--    must not reach a customer. This has to happen before the rows become unchangeable.
-- 2. A signed-in user who inserts a version is recorded as its author, whatever the row said.
-- 3. Every update of a version is refused, on every connection, except a change of the
--    `is_active` flag (activating a new version, a rollback) and the author being set to
--    NULL when that user is deleted (not by a signed-in user). An edit is a new version.

UPDATE public.playbook_versions v
   SET document = jsonb_set(
         v.document,
         '{priceNorms}',
         coalesce(
           (SELECT jsonb_agg(
                     CASE
                       WHEN e.norm ? 'range' THEN jsonb_build_object(
                         'job', e.norm -> 'job',
                         'lowUsd', least(replace(m.parts[1], ',', '')::numeric, replace(m.parts[2], ',', '')::numeric),
                         'highUsd', greatest(replace(m.parts[1], ',', '')::numeric, replace(m.parts[2], ',', '')::numeric),
                         'unit', 'per job',
                         'region', 'not stated',
                         'notes', coalesce(e.norm -> 'notes', 'null'::jsonb))
                       ELSE e.norm
                     END
                     ORDER BY e.ord)
              FROM jsonb_array_elements(v.document -> 'priceNorms') WITH ORDINALITY AS e(norm, ord)
              LEFT JOIN LATERAL (
                SELECT regexp_match(
                         e.norm ->> 'range',
                         '^\s*\$([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:to|-)\s*\$([0-9][0-9,]*(?:\.[0-9]+)?)\s*$'
                       ) AS parts
              ) AS m ON true
             WHERE NOT (e.norm ? 'range') OR m.parts IS NOT NULL),
           '[]'::jsonb))
 WHERE jsonb_typeof(v.document -> 'priceNorms') = 'array'
   AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(v.document -> 'priceNorms') AS n(norm)
          WHERE n.norm ? 'range');
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.set_playbook_version_author() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
  AS $$
BEGIN
  -- Only for a signed-in user (Database.asUser, Supabase's REST API): jobs and scripts say
  -- who the author is themselves.
  IF current_user = 'authenticated' THEN
    NEW.created_by := auth.uid();
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE TRIGGER playbook_versions_author
  BEFORE INSERT ON public.playbook_versions
  FOR EACH ROW EXECUTE FUNCTION app.set_playbook_version_author();
--> statement-breakpoint

-- An AFTER trigger on purpose: row-level security judges the statement first, so a write
-- that reaches for another tenant is still refused as "insufficient privilege".
CREATE OR REPLACE FUNCTION app.reject_playbook_version_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
  AS $$
DECLARE
  old_row jsonb := to_jsonb(OLD) - 'is_active';
  new_row jsonb := to_jsonb(NEW) - 'is_active';
BEGIN
  -- Deleting the author sets created_by to NULL (ON DELETE SET NULL). That update runs as
  -- the table's owner, never as a signed-in user, who therefore cannot erase an author.
  IF NEW.created_by IS NULL AND current_user NOT IN ('authenticated', 'anon') THEN
    old_row := old_row - 'created_by';
    new_row := new_row - 'created_by';
  END IF;
  IF old_row = new_row THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'playbook versions are immutable: save a new version instead'
    USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint

CREATE TRIGGER playbook_versions_immutable
  AFTER UPDATE ON public.playbook_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_playbook_version_change();
