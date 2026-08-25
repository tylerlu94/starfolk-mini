#!/usr/bin/env bash
set -Eeuo pipefail

# This script is intentionally gated because it launches billable infrastructure.
# It performs one controlled run and verifies cleanup before exiting.

required_commands=(aws jq ssh ssh-keygen uuidgen)
for command_name in "${required_commands[@]}"; do
  command -v "$command_name" >/dev/null || {
    echo "missing required command: $command_name" >&2
    exit 1
  }
done

required_variables=(
  AWS_REGION
  SFKM_SPIKE_AMI_ID
  SFKM_SPIKE_SUBNET_ID
  SFKM_SPIKE_SECURITY_GROUP_ID
  SFKM_SPIKE_SSH_CIDR
  SFKM_SPIKE_OWNER
  SFKM_SPIKE_REPO_URL
  SFKM_SPIKE_REPO_SHA
)
for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "missing required variable: $variable_name" >&2
    exit 1
  fi
done

if [[ "${SFKM_AWS_SPIKE_CONFIRM:-}" != "launch-one-billable-instance" ]]; then
  echo "refusing to launch: set SFKM_AWS_SPIKE_CONFIRM=launch-one-billable-instance" >&2
  exit 1
fi
if [[ ! "$SFKM_SPIKE_SSH_CIDR" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/32$ ]]; then
  echo "SFKM_SPIKE_SSH_CIDR must be one IPv4 /32" >&2
  exit 1
fi
if [[ ! "$SFKM_SPIKE_OWNER" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
  echo "SFKM_SPIKE_OWNER contains unsupported characters" >&2
  exit 1
fi
if [[ ! "$SFKM_SPIKE_REPO_URL" =~ ^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(\.git)?$ ]]; then
  echo "SFKM_SPIKE_REPO_URL must be a public GitHub HTTPS URL" >&2
  exit 1
fi
if [[ ! "$SFKM_SPIKE_REPO_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "SFKM_SPIKE_REPO_SHA must be one full lowercase Git SHA" >&2
  exit 1
fi
spike_dir="$(mktemp -d "${TMPDIR:-/tmp}/sfkm-aws-spike.XXXXXXXX")"
chmod 700 "$spike_dir"
lock_dir="${TMPDIR:-/tmp}/sfkm-real-aws.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "another local real-AWS SFKM run may be active: $lock_dir" >&2
  echo "remove the directory only after verifying no such run exists" >&2
  exit 1
fi
active_instance_id=""
active_volume_id=""
agent_phase_started=false
availability_zone=""
known_hosts=""
private_key=""
public_host=""
session_name=""
ssh_options=()

cleanup_local() {
  if [[ "$spike_dir" == *"/sfkm-aws-spike."* && -d "$spike_dir" ]]; then
    rm -rf "$spike_dir"
  fi
  rmdir "$lock_dir" 2>/dev/null || true
}

verify_volume_deleted() {
  local volume_id="$1"
  local attempt
  local volume_error_file="$spike_dir/volume-error.txt"
  for attempt in {1..60}; do
    local volume_count
    if ! volume_count="$(aws ec2 describe-volumes \
      --region "$AWS_REGION" \
      --volume-ids "$volume_id" \
      --query 'length(Volumes)' \
      --output text 2>"$volume_error_file")"; then
      if grep -q 'InvalidVolume.NotFound' "$volume_error_file"; then
        return 0
      fi
      echo "could not verify deletion of root volume $volume_id" >&2
      return 1
    fi
    if [[ "$volume_count" == "0" ]]; then
      return 0
    fi
    sleep 5
  done
  echo "root volume still exists after termination: $volume_id" >&2
  return 1
}

cleanup_instance() {
  if [[ -z "$active_instance_id" ]]; then
    return 0
  fi
  echo "terminating $active_instance_id" >&2
  aws ec2 terminate-instances \
    --region "$AWS_REGION" \
    --instance-ids "$active_instance_id" \
    --output json >/dev/null || true
  aws ec2 wait instance-terminated \
    --region "$AWS_REGION" \
    --instance-ids "$active_instance_id"
  if [[ -n "$active_volume_id" ]]; then
    verify_volume_deleted "$active_volume_id"
  fi
  active_instance_id=""
  active_volume_id=""
}

collect_remote_diagnostics() {
  if [[ "$agent_phase_started" != true ]] ||
    [[ -z "$active_instance_id" ]] ||
    [[ -z "$public_host" ]] ||
    [[ -z "$session_name" ]] ||
    ! declare -F authorize_key >/dev/null; then
    return 0
  fi

  echo "collecting non-secret agent diagnostics before cleanup" >&2
  if ! authorize_key; then
    echo "could not authorize diagnostic SSH connection" >&2
    return 0
  fi
  ssh "${ssh_options[@]}" "ec2-user@$public_host" bash -s -- "$session_name" <<'REMOTE_DIAGNOSTICS' || true
set +e
session_name="$1"
echo "diagnostic timestamp: $(date -Is)"
tmux list-sessions
tmux list-panes -t "=$session_name" \
  -F 'session=#{session_name} pane=#{pane_id} pid=#{pane_pid} dead=#{pane_dead} command=#{pane_current_command}'
ps -eo pid,ppid,stat,etime,comm,args | grep -E '[c]odex|[s]fkm-spike-agent|[t]mux'
ls -la /home/ec2-user/.local/state/sfkm-spike
if test -f /home/ec2-user/.local/state/sfkm-spike/exit-code; then
  printf 'recorded exit code: '
  cat /home/ec2-user/.local/state/sfkm-spike/exit-code
fi
if test -f /home/ec2-user/.local/state/sfkm-spike/output.log; then
  wc -c /home/ec2-user/.local/state/sfkm-spike/output.log
fi
df -h /
free -m
REMOTE_DIAGNOSTICS
}

on_exit() {
  local exit_code=$?
  if [[ "$exit_code" -ne 0 ]]; then
    set +e
    collect_remote_diagnostics
    set -e
  fi
  cleanup_instance || exit_code=1
  cleanup_local
  exit "$exit_code"
}
trap on_exit EXIT INT TERM

account_id="$(aws sts get-caller-identity --query Account --output text)"
echo "AWS account: $account_id; region: $AWS_REGION" >&2

ami_description="$(aws ec2 describe-images \
  --region "$AWS_REGION" \
  --image-ids "$SFKM_SPIKE_AMI_ID" \
  --query 'Images[0].[Name,Description,State]' \
  --output text)"
if [[ "$ami_description" != *"available"* ]] ||
  [[ ! "$ami_description" =~ [Aa]mazon.Linux.2023|al2023 ]]; then
  echo "AMI is unavailable or is not identifiable as Amazon Linux 2023: $ami_description" >&2
  exit 1
fi

ssh_cidrs="$(aws ec2 describe-security-groups \
  --region "$AWS_REGION" \
  --group-ids "$SFKM_SPIKE_SECURITY_GROUP_ID" \
  --output json \
  | jq -r '.SecurityGroups[].IpPermissions[] | select(.IpProtocol == "tcp" and .FromPort <= 22 and .ToPort >= 22) | .IpRanges[].CidrIp')"
if [[ "$ssh_cidrs" != "$SFKM_SPIKE_SSH_CIDR" ]]; then
  echo "security group must expose SSH to exactly $SFKM_SPIKE_SSH_CIDR; found: $ssh_cidrs" >&2
  exit 1
fi

user_data_file="$spike_dir/user-data.sh"
prompt_file="$spike_dir/prompt.txt"

printf '%s\n' \
  "Inspect this repository at the checked-out commit. Make no source changes. Run npm run type-check, npm test -- --run, and npm run build, then summarize the results." \
  > "$prompt_file"
chmod 600 "$prompt_file"

for run_number in 1; do
  echo "starting controlled AWS spike" >&2
  client_token="sfkm-spike-$(uuidgen | tr '[:upper:]' '[:lower:]')"
  devbox_tag="spike-$client_token"
  private_key="$spike_dir/id_ed25519-$run_number"
  known_hosts="$spike_dir/known_hosts-$run_number"
  ssh-keygen -q -t ed25519 -N "" -C "sfkm-aws-spike-$run_number" -f "$private_key"
  chmod 600 "$private_key"
  : > "$known_hosts"
  chmod 600 "$known_hosts"

  cat > "$user_data_file" <<'USER_DATA'
#!/bin/bash
set -Eeuo pipefail
dnf install -y gcc-c++ git make tmux nodejs24 nodejs24-npm
npm install -g @openai/codex@0.146.0
install -d -m 0755 -o ec2-user -g ec2-user /workspace
install -d -m 0755 -o ec2-user -g ec2-user /workspace/repo
install -d -m 0700 -o ec2-user -g ec2-user /home/ec2-user/.local/state/sfkm-spike
cat > /usr/local/bin/sfkm-spike-agent <<'AGENT_WRAPPER'
#!/bin/bash
set -Eeuo pipefail
prompt_file="$1"
state_dir="$2"
cd /workspace/repo
codex exec --sandbox workspace-write - < "$prompt_file" > "$state_dir/output.log" 2>&1 &
agent_pid=$!
printf '%s\n' "$agent_pid" > "$state_dir/agent.pid"
chmod 0600 "$state_dir/agent.pid" "$state_dir/output.log"
set +e
wait "$agent_pid"
exit_code=$?
set -e
if [[ "$exit_code" -eq 0 ]]; then
  printf '%s\n' 'SFKM_AGENT_PROCESS_COMPLETE' >> "$state_dir/output.log"
fi
printf '%s\n' "$exit_code" > "$state_dir/exit-code"
chmod 0600 "$state_dir/exit-code"
exit "$exit_code"
AGENT_WRAPPER
chmod 0755 /usr/local/bin/sfkm-spike-agent
touch /var/lib/cloud/instance/sfkm-spike-ready
USER_DATA
  chmod 600 "$user_data_file"

  launch_instance() {
    aws ec2 run-instances \
      --region "$AWS_REGION" \
      --image-id "$SFKM_SPIKE_AMI_ID" \
      --instance-type "${SFKM_SPIKE_INSTANCE_TYPE:-t3.small}" \
      --subnet-id "$SFKM_SPIKE_SUBNET_ID" \
      --security-group-ids "$SFKM_SPIKE_SECURITY_GROUP_ID" \
      --associate-public-ip-address \
      --client-token "$client_token" \
      --metadata-options HttpTokens=required,HttpEndpoint=enabled \
      --block-device-mappings 'DeviceName=/dev/xvda,Ebs={DeleteOnTermination=true,Encrypted=true,VolumeSize=24,VolumeType=gp3}' \
      --tag-specifications \
        "ResourceType=instance,Tags=[{Key=Project,Value=sfkm-demo},{Key=SFKMDevboxId,Value=$devbox_tag},{Key=EnvironmentVersion,Value=aws-spike},{Key=Owner,Value=$SFKM_SPIKE_OWNER}]" \
        "ResourceType=volume,Tags=[{Key=Project,Value=sfkm-demo},{Key=SFKMDevboxId,Value=$devbox_tag},{Key=EnvironmentVersion,Value=aws-spike},{Key=Owner,Value=$SFKM_SPIKE_OWNER}]" \
      --user-data "file://$user_data_file" \
      --query 'Instances[0].InstanceId' \
      --output text
  }

  active_instance_id="$(launch_instance)"
  replay_instance_id="$(launch_instance)"
  if [[ "$active_instance_id" != "$replay_instance_id" ]]; then
    echo "client-token replay returned a different instance" >&2
    exit 1
  fi
  echo "client-token replay returned $active_instance_id" >&2

  aws ec2 wait instance-status-ok \
    --region "$AWS_REGION" \
    --instance-ids "$active_instance_id"
  instance_details="$(aws ec2 describe-instances \
    --region "$AWS_REGION" \
    --instance-ids "$active_instance_id" \
    --output json)"
  availability_zone="$(jq -r '.Reservations[0].Instances[0].Placement.AvailabilityZone' <<< "$instance_details")"
  public_host="$(jq -r '.Reservations[0].Instances[0] | if .PublicDnsName != "" then .PublicDnsName else .PublicIpAddress end' <<< "$instance_details")"
  active_volume_id="$(jq -r '.Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId' <<< "$instance_details")"

  authorize_key() {
    aws ec2-instance-connect send-ssh-public-key \
      --region "$AWS_REGION" \
      --availability-zone "$availability_zone" \
      --instance-id "$active_instance_id" \
      --instance-os-user ec2-user \
      --ssh-public-key "file://$private_key.pub" \
      --query Success \
      --output text | grep -qx True
  }

  ssh_options=(
    -i "$private_key"
    -o "UserKnownHostsFile=$known_hosts"
    -o StrictHostKeyChecking=accept-new
    -o IdentitiesOnly=yes
    -o ConnectTimeout=10
  )

  ssh_ready=false
  for _attempt in {1..60}; do
    if authorize_key && ssh "${ssh_options[@]}" "ec2-user@$public_host" \
      'test -f /var/lib/cloud/instance/sfkm-spike-ready'; then
      ssh_ready=true
      break
    fi
    sleep 5
  done
  if [[ "$ssh_ready" != true ]]; then
    echo "instance bootstrap or SSH did not become ready" >&2
    exit 1
  fi

  authorize_key
  ssh "${ssh_options[@]}" "ec2-user@$public_host" bash -s -- \
    "$SFKM_SPIKE_REPO_URL" "$SFKM_SPIKE_REPO_SHA" <<'REMOTE_REPO'
set -Eeuo pipefail
repo_url="$1"
repo_sha="$2"
if [[ ! -d /workspace/repo/.git ]]; then
  git clone --filter=blob:none "$repo_url" /workspace/repo
fi
git -C /workspace/repo fetch --depth 1 origin "$repo_sha"
git -C /workspace/repo checkout --detach "$repo_sha"
test "$(git -C /workspace/repo rev-parse HEAD)" = "$repo_sha"
cd /workspace/repo
test -f package-lock.json
npm ci
npm run type-check
npm test -- --run
npm run build
REMOTE_REPO

  echo "Complete native Codex login as ec2-user; SSH will close automatically." >&2
  authorize_key
  ssh -tt "${ssh_options[@]}" "ec2-user@$public_host" \
    'cd /workspace/repo && codex login --device-auth'

  authorize_key
  ssh "${ssh_options[@]}" "ec2-user@$public_host" \
    'install -m 0600 /dev/stdin /home/ec2-user/.local/state/sfkm-spike/prompt.txt' \
    < "$prompt_file"

  session_name="sfkm-spike-$run_number"
  agent_phase_started=true
  authorize_key
  ssh "${ssh_options[@]}" "ec2-user@$public_host" tmux new-session -d -s "$session_name" \
    /usr/local/bin/sfkm-spike-agent \
    /home/ec2-user/.local/state/sfkm-spike/prompt.txt \
    /home/ec2-user/.local/state/sfkm-spike

  authorize_key
  ssh "${ssh_options[@]}" "ec2-user@$public_host" \
    tmux set-window-option -t "=$session_name" remain-on-exit on

  authorize_key
  first_pid="$(ssh "${ssh_options[@]}" "ec2-user@$public_host" \
    'for _attempt in {1..30}; do if test -s /home/ec2-user/.local/state/sfkm-spike/agent.pid; then cat /home/ec2-user/.local/state/sfkm-spike/agent.pid; exit 0; fi; sleep 1; done; exit 1')"
  if [[ ! "$first_pid" =~ ^[0-9]+$ ]]; then
    echo "agent PID was not recorded" >&2
    exit 1
  fi

  # Deliberately use a fresh Instance Connect authorization after disconnect.
  authorize_key
  second_pid="$(ssh "${ssh_options[@]}" "ec2-user@$public_host" \
    'agent_pid=$(cat /home/ec2-user/.local/state/sfkm-spike/agent.pid); kill -0 "$agent_pid"; printf "%s\n" "$agent_pid"')"
  if [[ "$first_pid" != "$second_pid" ]]; then
    echo "reconnect did not find the same agent PID" >&2
    exit 1
  fi
  echo "same agent PID survived disconnect/reconnect: $second_pid" >&2

  # A third, freshly authorized SSH connection observes the same tmux session
  # and waits for agent output. This is intentionally headless so terminal
  # rendering cannot turn a healthy agent run into an infrastructure failure.
  authorize_key
  reconnect_snapshot="$(ssh "${ssh_options[@]}" "ec2-user@$public_host" bash -s -- "$session_name" <<'REMOTE_RECONNECT'
set -Eeuo pipefail
session_name="$1"
tmux has-session -t "=$session_name"
tmux list-panes -t "=$session_name" \
  -F 'session=#{session_name} pane=#{pane_id} pid=#{pane_pid} dead=#{pane_dead} command=#{pane_current_command}'
for _attempt in {1..60}; do
  if test -s /home/ec2-user/.local/state/sfkm-spike/output.log; then
    wc -c /home/ec2-user/.local/state/sfkm-spike/output.log
    exit 0
  fi
  sleep 1
done
exit 1
REMOTE_RECONNECT
)"
  printf '%s\n' "$reconnect_snapshot"

  authorize_key
  if ! agent_exit_code="$(ssh "${ssh_options[@]}" "ec2-user@$public_host" \
    'for _attempt in {1..180}; do if test -f /home/ec2-user/.local/state/sfkm-spike/exit-code; then exit_code=$(cat /home/ec2-user/.local/state/sfkm-spike/exit-code); printf "%s\n" "$exit_code"; test "$exit_code" -eq 0; exit; fi; sleep 5; done; exit 1')"; then
    echo "agent did not complete successfully; recorded exit code: ${agent_exit_code:-unavailable}" >&2
    exit 1
  fi
  echo "agent completed with exit code $agent_exit_code" >&2

  authorize_key
  final_snapshot="$(ssh "${ssh_options[@]}" "ec2-user@$public_host" bash -s -- "$session_name" <<'REMOTE_FINAL'
set -Eeuo pipefail
session_name="$1"
tmux has-session -t "=$session_name"
tmux list-panes -t "=$session_name" \
  -F 'retained session=#{session_name} pane=#{pane_id} pid=#{pane_pid} dead=#{pane_dead} command=#{pane_current_command}'
grep -q 'SFKM_AGENT_PROCESS_COMPLETE' /home/ec2-user/.local/state/sfkm-spike/output.log
tail -n 40 /home/ec2-user/.local/state/sfkm-spike/output.log
REMOTE_FINAL
)"
  printf '%s\n' "$final_snapshot"

  agent_phase_started=false
  cleanup_instance
  echo "completed spike run $run_number with instance and root-volume cleanup" >&2
done

echo "AWS spike passed" >&2
