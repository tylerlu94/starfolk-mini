import {
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { SendSSHPublicKeyCommand } from "@aws-sdk/client-ec2-instance-connect";
import { describe, expect, it, vi } from "vitest";

import {
  AwsProviderError,
  Ec2AwsDevboxProvider,
  type AwsProviderClients,
} from "./provider.js";

function providerWith(
  ec2Responses: readonly unknown[] = [],
  instanceConnectResponses: readonly unknown[] = [],
) {
  let ec2ResponseIndex = 0;
  let instanceConnectResponseIndex = 0;
  const ec2Send = vi.fn<(command: object) => Promise<unknown>>(
    async (command: object): Promise<unknown> => {
      void command;
      return ec2Responses[ec2ResponseIndex++];
    },
  );
  const instanceConnectSend = vi.fn<(command: object) => Promise<unknown>>(
    async (command: object): Promise<unknown> => {
      void command;
      return instanceConnectResponses[instanceConnectResponseIndex++];
    },
  );
  const clients: AwsProviderClients = {
    ec2: { send: ec2Send },
    instanceConnect: { send: instanceConnectSend },
  };
  return {
    ec2Send,
    instanceConnectSend,
    provider: new Ec2AwsDevboxProvider(clients, {
      pollIntervalMs: 0,
      terminationPollAttempts: 4,
      volumePollAttempts: 4,
    }),
  };
}

const launchInput = {
  amiId: "ami-0123456789abcdef0",
  clientToken: "stable-client-token",
  instanceType: "t3.small",
  rootDiskGb: 24,
  securityGroupId: "sg-0123456789abcdef0",
  subnetId: "subnet-0123456789abcdef0",
  tags: {
    EnvironmentVersion: "2026-08-23",
    Owner: "interview-demo",
    Project: "sfkm-demo",
    SFKMDevboxId: "devbox_123",
  },
  userData: "#!/bin/bash\nprintf ready",
} as const;

describe("Ec2AwsDevboxProvider", () => {
  it("launches exactly one hardened instance with stable idempotency and tags", async () => {
    const { ec2Send, provider } = providerWith([
      {
        Instances: [
          { InstanceId: "i-0123456789abcdef0", Placement: { AvailabilityZone: "ca-central-1a" } },
        ],
      },
      {
        Instances: [
          { InstanceId: "i-0123456789abcdef0", Placement: { AvailabilityZone: "ca-central-1a" } },
        ],
      },
    ]);

    await expect(provider.launchDevbox(launchInput)).resolves.toEqual({
      availabilityZone: "ca-central-1a",
      instanceId: "i-0123456789abcdef0",
    });
    await expect(provider.launchDevbox(launchInput)).resolves.toEqual({
      availabilityZone: "ca-central-1a",
      instanceId: "i-0123456789abcdef0",
    });

    const command = ec2Send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(RunInstancesCommand);
    const input = (command as RunInstancesCommand).input;
    expect(input).toMatchObject({
      ClientToken: "stable-client-token",
      MaxCount: 1,
      MetadataOptions: { HttpEndpoint: "enabled", HttpTokens: "required" },
      MinCount: 1,
      NetworkInterfaces: [
        {
          AssociatePublicIpAddress: true,
          DeviceIndex: 0,
          Groups: ["sg-0123456789abcdef0"],
          SubnetId: "subnet-0123456789abcdef0",
        },
      ],
    });
    expect(input).not.toHaveProperty("IamInstanceProfile");
    expect(input.BlockDeviceMappings?.[0]?.Ebs).toEqual({
      DeleteOnTermination: true,
      Encrypted: true,
      VolumeSize: 24,
      VolumeType: "gp3",
    });
    expect(input.TagSpecifications).toHaveLength(2);
    expect(input.TagSpecifications?.map((specification) => specification.ResourceType)).toEqual([
      "instance",
      "volume",
    ]);
    expect(input.TagSpecifications?.[0]?.Tags).toEqual([
      { Key: "EnvironmentVersion", Value: "2026-08-23" },
      { Key: "Owner", Value: "interview-demo" },
      { Key: "Project", Value: "sfkm-demo" },
      { Key: "SFKMDevboxId", Value: "devbox_123" },
    ]);
    expect(Buffer.from(input.UserData ?? "", "base64").toString("utf8")).toBe(
      launchInput.userData,
    );
    const replayCommand = ec2Send.mock.calls[1]?.[0];
    expect(replayCommand).toBeInstanceOf(RunInstancesCommand);
    expect((replayCommand as RunInstancesCommand).input).toEqual(input);
  });

  it("rejects launches without the cleanup tags", async () => {
    const { ec2Send, provider } = providerWith();
    await expect(
      provider.launchDevbox({ ...launchInput, tags: { Project: "sfkm-demo" } }),
    ).rejects.toMatchObject({ code: "AWS_REQUIRED_TAGS_MISSING" });
    expect(ec2Send).not.toHaveBeenCalled();
  });

  it("describes a running instance and prefers its public DNS name", async () => {
    const { ec2Send, provider } = providerWith([
      {
        Reservations: [
          {
            Instances: [
              {
                InstanceId: "i-0123456789abcdef0",
                Placement: { AvailabilityZone: "ca-central-1a" },
                PublicDnsName: "ec2.example.test",
                PublicIpAddress: "192.0.2.10",
                State: { Name: "running" },
              },
            ],
          },
        ],
      },
    ]);
    await expect(provider.getConnectionDetails("i-0123456789abcdef0")).resolves.toEqual({
      availabilityZone: "ca-central-1a",
      host: "ec2.example.test",
      instanceId: "i-0123456789abcdef0",
    });
    expect(ec2Send.mock.calls[0]?.[0]).toBeInstanceOf(DescribeInstancesCommand);
  });

  it("pushes a temporary key with Instance Connect and requires Success=true", async () => {
    const { instanceConnectSend, provider } = providerWith([], [{ Success: true }]);
    await provider.authorizeSshKey({
      availabilityZone: "ca-central-1a",
      instanceId: "i-0123456789abcdef0",
      osUser: "ec2-user",
      publicKey: "ssh-ed25519 AAAATEST sfkm-spike",
    });
    const command = instanceConnectSend.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(SendSSHPublicKeyCommand);
    expect((command as SendSSHPublicKeyCommand).input).toEqual({
      AvailabilityZone: "ca-central-1a",
      InstanceId: "i-0123456789abcdef0",
      InstanceOSUser: "ec2-user",
      SSHPublicKey: "ssh-ed25519 AAAATEST sfkm-spike",
    });
  });

  it("terminates once, polls to terminated, and verifies root-volume deletion", async () => {
    const { ec2Send, provider } = providerWith([
      {
        Reservations: [
          {
            Instances: [
              {
                BlockDeviceMappings: [{ Ebs: { VolumeId: "vol-0123456789abcdef0" } }],
                InstanceId: "i-0123456789abcdef0",
                Placement: { AvailabilityZone: "ca-central-1a" },
                State: { Name: "running" },
              },
            ],
          },
        ],
      },
      { TerminatingInstances: [] },
      {
        Reservations: [
          {
            Instances: [
              {
                InstanceId: "i-0123456789abcdef0",
                Placement: { AvailabilityZone: "ca-central-1a" },
                State: { Name: "shutting-down" },
              },
            ],
          },
        ],
      },
      {
        Reservations: [
          {
            Instances: [
              {
                InstanceId: "i-0123456789abcdef0",
                Placement: { AvailabilityZone: "ca-central-1a" },
                State: { Name: "terminated" },
              },
            ],
          },
        ],
      },
      { Volumes: [] },
    ]);

    await provider.terminateDevbox("i-0123456789abcdef0");

    expect(ec2Send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      DescribeInstancesCommand.name,
      TerminateInstancesCommand.name,
      DescribeInstancesCommand.name,
      DescribeInstancesCommand.name,
      DescribeVolumesCommand.name,
    ]);
  });

  it("does not expose AWS credentials or raw service messages in errors", async () => {
    const leakedAccessKey = `AKIA${"A".repeat(16)}`;
    const leakedSecret = "super-secret-aws-credential";
    const clients: AwsProviderClients = {
      ec2: {
        send: vi.fn(async () => {
          const error = new Error(`denied ${leakedAccessKey} ${leakedSecret}`);
          error.name = "AccessDeniedException";
          throw error;
        }),
      },
      instanceConnect: { send: vi.fn() },
    };
    const provider = new Ec2AwsDevboxProvider(clients);

    const error = await provider.launchDevbox(launchInput).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AwsProviderError);
    expect(String(error)).toContain("AccessDeniedException");
    expect(JSON.stringify(error)).not.toContain(leakedAccessKey);
    expect(JSON.stringify(error)).not.toContain(leakedSecret);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });
});
