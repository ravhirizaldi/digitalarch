ALTER TABLE users ADD COLUMN viewer_registration_status TEXT
  CHECK(viewer_registration_status IN ('pending','approved','rejected'));
ALTER TABLE users ADD CONSTRAINT pending_viewers_inactive
  CHECK(viewer_registration_status IS NULL OR viewer_registration_status='approved' OR NOT is_active);

CREATE TABLE viewer_registration_audit (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_id UUID REFERENCES users(id),
  subject_user_id UUID REFERENCES users(id), batch_id UUID REFERENCES archive_batches(id),
  document_id UUID REFERENCES documents(id), action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), metadata JSONB NOT NULL DEFAULT '{}', correlation_id UUID
);
CREATE TABLE viewer_access_audit (LIKE viewer_registration_audit INCLUDING ALL);
ALTER TABLE viewer_access_audit ADD FOREIGN KEY(actor_id) REFERENCES users(id),
  ADD FOREIGN KEY(subject_user_id) REFERENCES users(id), ADD FOREIGN KEY(batch_id) REFERENCES archive_batches(id),
  ADD FOREIGN KEY(document_id) REFERENCES documents(id);
CREATE TABLE viewer_activity_audit (LIKE viewer_access_audit INCLUDING ALL);
ALTER TABLE viewer_activity_audit ADD FOREIGN KEY(actor_id) REFERENCES users(id),
  ADD FOREIGN KEY(subject_user_id) REFERENCES users(id), ADD FOREIGN KEY(batch_id) REFERENCES archive_batches(id),
  ADD FOREIGN KEY(document_id) REFERENCES documents(id);
CREATE TABLE viewer_download_audit (LIKE viewer_access_audit INCLUDING ALL);
ALTER TABLE viewer_download_audit ADD FOREIGN KEY(actor_id) REFERENCES users(id),
  ADD FOREIGN KEY(subject_user_id) REFERENCES users(id), ADD FOREIGN KEY(batch_id) REFERENCES archive_batches(id),
  ADD FOREIGN KEY(document_id) REFERENCES documents(id), ADD COLUMN download_id UUID NOT NULL;
CREATE INDEX viewer_download_request ON viewer_download_audit(download_id,created_at DESC);

DO $$ DECLARE name TEXT; BEGIN
  FOREACH name IN ARRAY ARRAY['viewer_registration_audit','viewer_access_audit','viewer_activity_audit','viewer_download_audit'] LOOP
    EXECUTE format('CREATE INDEX ON %I(created_at DESC,id)',name);
    EXECUTE format('CREATE INDEX ON %I(actor_id,created_at DESC)',name);
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protect_audit()',name);
  END LOOP;
END $$;

CREATE VIEW all_audit_logs AS
  SELECT id,actor_id,action,entity_type,entity_id,batch_id,created_at,metadata,correlation_id FROM audit_logs
  UNION ALL SELECT id,actor_id,action,'viewer_registration',subject_user_id,batch_id,created_at,metadata,correlation_id FROM viewer_registration_audit
  UNION ALL SELECT id,actor_id,action,'viewer_access',subject_user_id,batch_id,created_at,metadata,correlation_id FROM viewer_access_audit
  UNION ALL SELECT id,actor_id,action,'viewer_activity',document_id,batch_id,created_at,metadata,correlation_id FROM viewer_activity_audit
  UNION ALL SELECT id,actor_id,action,'viewer_download',download_id,batch_id,created_at,metadata,correlation_id FROM viewer_download_audit;

INSERT INTO permissions(code) VALUES('viewers:approve');
INSERT INTO role_permissions(role_id,permission_id)
  SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='system_admin' AND p.code='viewers:approve';
