-- C16: the admin panel's inbox hears about changes through Supabase Realtime
-- (postgres_changes), under the same row-level security as its reads. Supabase creates the
-- publication `supabase_realtime`; plain PostgreSQL (local development, CI) has none, so
-- this does nothing there and the screens poll instead. Only the tables the screens listen
-- to are published: Realtime sends a DELETE's key to every subscriber of the table, whatever
-- row-level security says, so staff-only tables (internal notes) stay out.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['conversations', 'messages', 'takeover_locks'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $$;
