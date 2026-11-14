ALTER TABLE file_versions ADD COLUMN completion_requested_at timestamptz;
ALTER TABLE file_versions ADD COLUMN links_snapshot jsonb;
ALTER TABLE file_versions ADD COLUMN completion_parts jsonb;
