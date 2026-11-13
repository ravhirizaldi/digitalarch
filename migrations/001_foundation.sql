CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL CHECK (username ~ '^[a-zA-Z0-9_.-]{3,64}$'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  must_change_password BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX users_username_ci ON users(lower(username));
CREATE TABLE roles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL);
CREATE TABLE permissions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code TEXT UNIQUE NOT NULL);
CREATE TABLE user_roles (user_id UUID NOT NULL REFERENCES users(id), role_id UUID NOT NULL REFERENCES roles(id), PRIMARY KEY(user_id,role_id));
CREATE TABLE role_permissions (role_id UUID NOT NULL REFERENCES roles(id), permission_id UUID NOT NULL REFERENCES permissions(id), PRIMARY KEY(role_id,permission_id));
CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id),
  token_hash TEXT UNIQUE NOT NULL, csrf_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ, CHECK (expires_at > created_at)
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE auth_login_attempts (
  username TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, window_started_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE archive_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), batch_code TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','paused','capture_completed','cancelled')),
  physical_location TEXT CHECK(length(physical_location)<=240),
  created_by UUID NOT NULL REFERENCES users(id), assigned_operator_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paused_at TIMESTAMPTZ, capture_completed_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0)
);
CREATE INDEX batches_operator_status ON archive_batches(assigned_operator_id,status,updated_at DESC);
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), batch_id UUID NOT NULL REFERENCES archive_batches(id),
  document_index INTEGER NOT NULL CHECK(document_index>0),
  title TEXT, archive_number TEXT, document_type TEXT, document_date DATE,
  metadata_status TEXT NOT NULL DEFAULT 'pending', metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(batch_id,document_index), UNIQUE(id,batch_id)
);
CREATE TABLE scan_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), batch_id UUID NOT NULL REFERENCES archive_batches(id),
  document_id UUID NOT NULL, session_number INTEGER NOT NULL CHECK(session_number>0),
  status TEXT NOT NULL CHECK(status IN ('running','completed','partial','failed','interrupted','cancelled')),
  created_by UUID NOT NULL REFERENCES users(id), scanner_mode TEXT NOT NULL CHECK(scanner_mode IN ('real','simulator')),
  device_id TEXT, device_name TEXT, profile_id TEXT, profile_name TEXT, settings_snapshot JSONB,
  job_id TEXT UNIQUE NOT NULL, page_count INTEGER NOT NULL DEFAULT 0 CHECK(page_count>=0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ, error_summary TEXT,
  recovery_pending BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(batch_id,session_number), UNIQUE(id,batch_id,document_id),
  FOREIGN KEY(document_id,batch_id) REFERENCES documents(id,batch_id)
);
CREATE UNIQUE INDEX one_running_session_per_batch ON scan_sessions(batch_id) WHERE status='running';
CREATE TABLE pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), batch_id UUID NOT NULL REFERENCES archive_batches(id),
  document_id UUID NOT NULL, scan_session_id UUID NOT NULL,
  capture_order INTEGER NOT NULL CHECK(capture_order>0), display_order INTEGER NOT NULL CHECK(display_order>0),
  original_storage_key TEXT UNIQUE NOT NULL, active_storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK(mime_type='image/png'), byte_size BIGINT NOT NULL CHECK(byte_size>0),
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  width_px INTEGER NOT NULL CHECK(width_px>0), height_px INTEGER NOT NULL CHECK(height_px>0), dpi INTEGER,
  source TEXT NOT NULL CHECK(source IN ('simulator','real')),
  rotation_degrees INTEGER NOT NULL DEFAULT 0 CHECK(rotation_degrees IN (0,90,180,270)),
  is_excluded BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(batch_id,capture_order),
  FOREIGN KEY(scan_session_id,batch_id,document_id) REFERENCES scan_sessions(id,batch_id,document_id)
);
CREATE INDEX pages_session ON pages(scan_session_id);
CREATE INDEX pages_display ON pages(batch_id,display_order);
CREATE TABLE page_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), page_id UUID NOT NULL REFERENCES pages(id),
  storage_key TEXT NOT NULL, sha256 TEXT NOT NULL, rotation_degrees INTEGER NOT NULL DEFAULT 0,
  created_by UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), metadata JSONB
);
CREATE INDEX page_revisions_page ON page_revisions(page_id,created_at);
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_id UUID REFERENCES users(id),
  action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id UUID, batch_id UUID REFERENCES archive_batches(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), metadata JSONB NOT NULL DEFAULT '{}', correlation_id UUID
);
CREATE INDEX audit_created ON audit_logs(created_at DESC);
CREATE INDEX audit_batch ON audit_logs(batch_id,created_at DESC);

CREATE FUNCTION protect_original_page() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Captured pages cannot be deleted'; END IF;
  IF ROW(NEW.batch_id,NEW.document_id,NEW.scan_session_id,NEW.capture_order,NEW.original_storage_key,NEW.sha256,NEW.source,NEW.byte_size)
     IS DISTINCT FROM ROW(OLD.batch_id,OLD.document_id,OLD.scan_session_id,OLD.capture_order,OLD.original_storage_key,OLD.sha256,OLD.source,OLD.byte_size)
  THEN RAISE EXCEPTION 'Original page provenance is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_original BEFORE UPDATE OR DELETE ON pages FOR EACH ROW EXECUTE FUNCTION protect_original_page();
CREATE FUNCTION protect_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit records are append-only'; END $$;
CREATE TRIGGER append_only_audit BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION protect_audit();

INSERT INTO roles(code,display_name) VALUES
('operator','Operator'),('qc_officer','QC Officer'),('approver_l1','Approver Level 1'),
('approver_l2','Approver Level 2'),('archive_viewer','Archive Viewer'),('system_admin','System Administrator');
INSERT INTO permissions(code) SELECT unnest(ARRAY[
  'users:read','users:create','users:update','users:disable','roles:assign',
  'batches:create','batches:read','batches:read_all','batches:update','batches:resume','batches:pause','batches:complete_capture','batches:reassign',
  'scanner:read','scanner:scan','scanner:configure',
  'qc:read','qc:review','qc:submit','qc:return',
  'approval_l1:review','approval_l1:approve','approval_l1:reject',
  'approval_l2:review','approval_l2:approve','approval_l2:reject',
  'archive:read','archive:search','audit:read','system:read'
]);
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE
 (r.code='operator' AND p.code=ANY(ARRAY['batches:create','batches:read','batches:update','batches:resume','batches:pause','batches:complete_capture','scanner:read','scanner:scan','scanner:configure'])) OR
 (r.code='qc_officer' AND p.code=ANY(ARRAY['qc:read','qc:review','qc:submit','qc:return','scanner:read','scanner:scan','scanner:configure'])) OR
 (r.code='approver_l1' AND p.code LIKE 'approval_l1:%') OR
 (r.code='approver_l2' AND p.code LIKE 'approval_l2:%') OR
 (r.code='archive_viewer' AND p.code LIKE 'archive:%') OR
 (r.code='system_admin' AND p.code=ANY(ARRAY['users:read','users:create','users:update','users:disable','roles:assign','batches:read_all','batches:reassign','audit:read','system:read']));
