-- Reserve feeder positions even when one PNG needs recovery, so later sessions cannot take its place.
ALTER TABLE scan_sessions ADD COLUMN capture_order_base INTEGER NOT NULL DEFAULT 0 CHECK(capture_order_base>=0);
ALTER TABLE scan_sessions ADD COLUMN captured_file_count INTEGER NOT NULL DEFAULT 0 CHECK(captured_file_count>=0);
