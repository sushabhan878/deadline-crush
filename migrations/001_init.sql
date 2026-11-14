CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL, name text NOT NULL, password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('participant','organizer','admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hackathons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, join_code text UNIQUE NOT NULL,
  starts_at timestamptz NOT NULL, deadline_at timestamptz NOT NULL,
  grace_seconds int NOT NULL DEFAULT 300,
  max_file_bytes bigint NOT NULL DEFAULT 104857600,
  allowed_types text[] NOT NULL DEFAULT '{pdf,zip}',
  max_links int NOT NULL DEFAULT 5,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id uuid NOT NULL REFERENCES hackathons(id),
  name text NOT NULL, invite_code text UNIQUE NOT NULL DEFAULT substr(md5(random()::text),1,8),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hackathon_id, name)
);
CREATE TABLE team_members (
  team_id uuid NOT NULL REFERENCES teams(id),
  user_id uuid NOT NULL REFERENCES users(id),
  hackathon_id uuid NOT NULL REFERENCES hackathons(id),
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('leader','member')),
  PRIMARY KEY (team_id, user_id),
  UNIQUE (user_id, hackathon_id)
);
CREATE TABLE submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid UNIQUE NOT NULL REFERENCES teams(id),
  current_title text NOT NULL DEFAULT '', current_description text NOT NULL DEFAULT '',
  current_links jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE metadata_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES submissions(id), version_no int NOT NULL,
  title text NOT NULL, description text NOT NULL, links jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), in_time boolean NOT NULL DEFAULT true,
  UNIQUE (submission_id, version_no)
);
CREATE TABLE file_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES submissions(id),
  version_no int NOT NULL, idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('uploading','uploaded','checking','accepted','needs_fix','aborted','expired')),
  s3_key text NOT NULL, s3_upload_id text, part_size int NOT NULL, total_parts int NOT NULL,
  declared_size bigint NOT NULL, actual_size bigint, declared_filename text NOT NULL,
  sha256 text, detected_mime text,
  started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, finalized_at timestamptz,
  started_in_time boolean NOT NULL DEFAULT true, completed_in_grace boolean,
  counts boolean NOT NULL DEFAULT false, failure_summary text,
  UNIQUE (submission_id, version_no), UNIQUE (submission_id, idempotency_key)
);
CREATE TABLE upload_parts (
  version_id uuid NOT NULL REFERENCES file_versions(id), part_no int NOT NULL,
  etag text NOT NULL, size bigint NOT NULL, uploaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version_id, part_no)
);
CREATE TABLE jobs (
  id bigserial PRIMARY KEY, version_id uuid NOT NULL REFERENCES file_versions(id),
  kind text NOT NULL DEFAULT 'check_version',
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','done','failed')),
  attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 5,
  locked_by text, lease_expires_at timestamptz, run_after timestamptz NOT NULL DEFAULT now(),
  last_error text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, kind)
);
CREATE TABLE check_results (
  version_id uuid NOT NULL REFERENCES file_versions(id),
  check_name text NOT NULL CHECK (check_name IN ('type','archive','links','preview','hash')),
  status text NOT NULL CHECK (status IN ('pass','fail','skipped')),
  detail jsonb NOT NULL DEFAULT '{}', finished_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, check_name)
);
CREATE TABLE late_attempts (
  id bigserial PRIMARY KEY, team_id uuid NOT NULL, user_id uuid,
  action text NOT NULL CHECK (action IN ('start_upload','complete_upload','edit_metadata')),
  server_time timestamptz NOT NULL, deadline_at timestamptz NOT NULL, delta_ms bigint NOT NULL,
  reason text NOT NULL, ip text
);
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY, hackathon_id uuid NOT NULL, team_id uuid, actor_id uuid,
  type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE receipts (
  version_id uuid PRIMARY KEY REFERENCES file_versions(id), sha256 text,
  emailed_at timestamptz, email_status text
);
CREATE TABLE worker_heartbeats (worker_id text PRIMARY KEY, seen_at timestamptz NOT NULL DEFAULT now());

CREATE INDEX ON file_versions (submission_id, version_no DESC);
CREATE INDEX ON file_versions (status);
CREATE INDEX ON jobs (state, run_after);
CREATE INDEX ON jobs (lease_expires_at) WHERE state = 'running';
CREATE INDEX ON audit_events (team_id, id);
CREATE INDEX ON audit_events (hackathon_id, id);
CREATE INDEX ON late_attempts (team_id);
