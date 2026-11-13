ALTER TABLE archive_batches ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE archive_batches ADD COLUMN deleted_by UUID REFERENCES users(id);
ALTER TABLE archive_batches ADD CONSTRAINT batch_deletion_actor CHECK ((deleted_at IS NULL) = (deleted_by IS NULL));

INSERT INTO permissions(code) VALUES ('batches:delete');
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='operator' AND p.code='batches:delete';
