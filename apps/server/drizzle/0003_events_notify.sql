-- Every inserted event is announced on channel nb_events so all server instances can push it live.
CREATE OR REPLACE FUNCTION nb_events_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('nb_events', json_build_object('id', NEW.id, 'w', NEW.workspace_id)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER events_notify AFTER INSERT ON events FOR EACH ROW EXECUTE FUNCTION nb_events_notify();
