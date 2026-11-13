-- C16: the admin panel's inbox hears about changes through Supabase Realtime
-- (postgres_changes), under the same row-level security as its reads. Supabase creates the
-- publication `supabase_realtime`; plain PostgreSQL (local development, CI) has none, so
-- this does nothing there and the screens poll instead.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['conversations', 'messages', 'takeover_locks', 'internal_notes', 'leads'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $$;
