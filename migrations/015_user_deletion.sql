ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE users ADD CONSTRAINT deleted_user_disabled CHECK (deleted_at IS NULL OR NOT is_active);

INSERT INTO permissions(code) VALUES ('users:delete');
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='system_admin' AND p.code='users:delete';
