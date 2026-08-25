CREATE TABLE environments (
  id text PRIMARY KEY CHECK (id ~ '^env_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  version text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  ami_id text NOT NULL,
  instance_type text NOT NULL,
  root_disk_gb integer NOT NULL CHECK (root_disk_gb > 0),
  default_agent text NOT NULL,
  default_model text NOT NULL,
  setup_command text NOT NULL,
  runtime_artifact_version text NOT NULL,
  runtime_artifact_sha256 text NOT NULL CHECK (runtime_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  configuration_hash text NOT NULL UNIQUE CHECK (configuration_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX environments_one_default
  ON environments (is_default)
  WHERE is_default;

CREATE TABLE devboxes (
  id text PRIMARY KEY CHECK (id ~ '^devbox_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  environment_id text NOT NULL REFERENCES environments(id),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  repo_url text NOT NULL,
  branch text NOT NULL,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-fA-F]{40}$'),
  status text NOT NULL CHECK (status IN ('PROVISIONING', 'READY', 'FAILED', 'DELETING', 'DELETED')),
  status_reason text,
  aws_client_token text NOT NULL UNIQUE,
  aws_instance_id text UNIQUE,
  aws_availability_zone text,
  public_hostname text,
  bootstrap_token_hash text CHECK (bootstrap_token_hash IS NULL OR bootstrap_token_hash ~ '^[0-9a-f]{64}$'),
  bootstrap_deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  deleted_at timestamptz,
  CHECK ((aws_instance_id IS NULL) = (aws_availability_zone IS NULL)),
  CHECK (status <> 'READY' OR ready_at IS NOT NULL),
  CHECK (status <> 'DELETED' OR deleted_at IS NOT NULL)
);

CREATE INDEX devboxes_status_index ON devboxes(status);

CREATE TABLE sessions (
  id text PRIMARY KEY CHECK (id ~ '^session_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  devbox_id text NOT NULL REFERENCES devboxes(id),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  agent text NOT NULL,
  model text NOT NULL,
  tmux_name text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('STARTING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  status_reason text,
  exit_code integer,
  callback_token_hash text CHECK (callback_token_hash IS NULL OR callback_token_hash ~ '^[0-9a-f]{64}$'),
  start_deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  CHECK (status NOT IN ('SUCCEEDED', 'FAILED') OR finished_at IS NOT NULL),
  CHECK (status <> 'SUCCEEDED' OR exit_code = 0)
);

CREATE INDEX sessions_devbox_id_index ON sessions(devbox_id);
CREATE INDEX sessions_status_index ON sessions(status);

CREATE FUNCTION reject_environment_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'environment rows are immutable';
END;
$$;

CREATE TRIGGER environments_immutable_update
  BEFORE UPDATE OR DELETE ON environments
  FOR EACH ROW EXECUTE FUNCTION reject_environment_changes();
