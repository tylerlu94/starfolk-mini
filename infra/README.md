# Infrastructure

Infrastructure automation is intentionally deferred until the real-EC2 vertical slice is stable. The AWS workstream owns this directory.

`aws/demo-backend-policy.json` is a reviewable starting point for the temporary
demo IAM identity. Scope its `RunInstances` resources to the selected AMI,
subnet, security group, and EBS resources before attaching it. The broad read
and terminate statements exist so cleanup still works when application state is
missing; use a dedicated demo account or add account-specific tag conditions.

Do not add Terraform or Packer until the runtime contract passes the controlled
AWS spike in `docs/runbooks/aws-spike.md`.
