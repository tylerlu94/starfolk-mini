UPDATE sessions
SET status = 'FAILED',
  status_reason = 'Devbox was deleted.',
  exit_code = NULL,
  finished_at = COALESCE(sessions.finished_at, devboxes.deleted_at, now()),
  callback_token_hash = NULL,
  updated_at = now()
FROM devboxes
WHERE sessions.devbox_id = devboxes.id
  AND devboxes.status = 'DELETED'
  AND sessions.status IN ('STARTING', 'RUNNING');
