-- Custom SQL migration: the event journal is append-only (data-dictionary, rules).
CREATE OR REPLACE FUNCTION core.event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'event journal is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER event_append_only
  BEFORE UPDATE OR DELETE ON core.event
  FOR EACH ROW EXECUTE FUNCTION core.event_append_only();
