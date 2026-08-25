#!/usr/bin/env bash
set -Eeuo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${SFKM_SPIKE_OWNER:?SFKM_SPIKE_OWNER is required}"

if [[ "${SFKM_AWS_CLEANUP_CONFIRM:-}" != "terminate-all-listed-sfkm-demo-instances" ]]; then
  echo "refusing cleanup: set SFKM_AWS_CLEANUP_CONFIRM=terminate-all-listed-sfkm-demo-instances" >&2
  exit 1
fi
if [[ ! "$SFKM_SPIKE_OWNER" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
  echo "SFKM_SPIKE_OWNER contains unsupported characters" >&2
  exit 1
fi

instance_ids_text="$(aws ec2 describe-instances \
  --region "$AWS_REGION" \
  --filters \
    Name=tag:Project,Values=sfkm-demo \
    "Name=tag:Owner,Values=$SFKM_SPIKE_OWNER" \
    Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down \
  --query 'Reservations[].Instances[].InstanceId' \
  --output text)"
instance_ids=()
while IFS= read -r instance_id; do
  if [[ -n "$instance_id" ]]; then
    instance_ids+=("$instance_id")
  fi
done < <(tr '\t' '\n' <<< "$instance_ids_text")

if (( ${#instance_ids[@]} == 0 )); then
  echo "no tagged SFKM demo instances found"
  exit 0
fi

printf 'will terminate:\n'
printf '  %s\n' "${instance_ids[@]}"
aws ec2 terminate-instances \
  --region "$AWS_REGION" \
  --instance-ids "${instance_ids[@]}" \
  --output json >/dev/null
aws ec2 wait instance-terminated \
  --region "$AWS_REGION" \
  --instance-ids "${instance_ids[@]}"
echo "terminated all listed instances; inspect tagged volumes before deleting any survivor"
aws ec2 describe-volumes \
  --region "$AWS_REGION" \
  --filters Name=tag:Project,Values=sfkm-demo "Name=tag:Owner,Values=$SFKM_SPIKE_OWNER" \
  --query 'Volumes[].{VolumeId:VolumeId,State:State,InstanceId:Attachments[0].InstanceId}' \
  --output table
