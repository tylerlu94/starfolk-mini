import {
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  EC2InstanceConnectClient,
  SendSSHPublicKeyCommand,
} from "@aws-sdk/client-ec2-instance-connect";
import { z } from "zod";

import type { _InstanceType } from "@aws-sdk/client-ec2";

import type {
  AuthorizeSshKeyInput,
  AwsDevboxProvider,
  InstanceConnectionDetails,
  LaunchDevboxInput,
  LaunchDevboxResult,
} from "./port.js";

const runInstancesResponseSchema = z.object({
  Instances: z
    .array(
      z.object({
        InstanceId: z.string().min(1),
        Placement: z.object({ AvailabilityZone: z.string().min(1) }),
      }),
    )
    .length(1),
});

const describedInstanceSchema = z.object({
  BlockDeviceMappings: z
    .array(z.object({ Ebs: z.object({ VolumeId: z.string().min(1) }).optional() }))
    .optional(),
  InstanceId: z.string().min(1),
  Placement: z.object({ AvailabilityZone: z.string().min(1) }),
  PublicDnsName: z.string().optional(),
  PublicIpAddress: z.string().optional(),
  State: z.object({ Name: z.string().min(1) }),
});

const describeInstancesResponseSchema = z.object({
  Reservations: z
    .array(z.object({ Instances: z.array(describedInstanceSchema).optional() }))
    .optional(),
});

const describeVolumesResponseSchema = z.object({
  Volumes: z.array(z.object({ VolumeId: z.string().min(1) })).optional(),
});

const sendSshPublicKeyResponseSchema = z.object({ Success: z.literal(true) });

const terminalInstanceStates = new Set(["terminated"]);
const terminatingInstanceStates = new Set(["shutting-down", "terminated"]);

interface CommandSender {
  send(command: object): Promise<unknown>;
}

export interface Ec2AwsDevboxProviderOptions {
  readonly pollIntervalMs?: number;
  readonly terminationPollAttempts?: number;
  readonly volumePollAttempts?: number;
}

export interface AwsProviderClients {
  readonly ec2: CommandSender;
  readonly instanceConnect: CommandSender;
}

export class AwsProviderError extends Error {
  readonly code: string;
  readonly operation: string;

  constructor(operation: string, code: string) {
    super(`AWS ${operation} failed (${code}).`);
    this.name = "AwsProviderError";
    this.code = code;
    this.operation = operation;
  }
}

export class Ec2AwsDevboxProvider implements AwsDevboxProvider {
  private readonly pollIntervalMs: number;
  private readonly terminationPollAttempts: number;
  private readonly volumePollAttempts: number;

  constructor(
    private readonly clients: AwsProviderClients,
    options: Ec2AwsDevboxProviderOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.terminationPollAttempts = options.terminationPollAttempts ?? 120;
    this.volumePollAttempts = options.volumePollAttempts ?? 120;
  }

  async authorizeSshKey(input: AuthorizeSshKeyInput): Promise<void> {
    try {
      const response = await this.clients.instanceConnect.send(
        new SendSSHPublicKeyCommand({
          AvailabilityZone: input.availabilityZone,
          InstanceId: input.instanceId,
          InstanceOSUser: input.osUser,
          SSHPublicKey: input.publicKey,
        }),
      );
      sendSshPublicKeyResponseSchema.parse(response);
    } catch (error: unknown) {
      throw safeAwsError("SendSSHPublicKey", error);
    }
  }

  async getConnectionDetails(instanceId: string): Promise<InstanceConnectionDetails> {
    const instance = await this.describeInstance(instanceId, "DescribeInstances");

    if (instance.State.Name !== "running") {
      throw new AwsProviderError("DescribeInstances", "AWS_INSTANCE_NOT_CONNECTABLE");
    }

    const host = nonEmpty(instance.PublicDnsName) ?? nonEmpty(instance.PublicIpAddress);
    if (host === undefined) {
      throw new AwsProviderError("DescribeInstances", "AWS_INSTANCE_ADDRESS_MISSING");
    }

    return {
      availabilityZone: instance.Placement.AvailabilityZone,
      host,
      instanceId: instance.InstanceId,
    };
  }

  async launchDevbox(input: LaunchDevboxInput): Promise<LaunchDevboxResult> {
    validateLaunchInput(input);

    const tags = Object.entries(input.tags)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([Key, Value]) => ({ Key, Value }));

    try {
      const response = await this.clients.ec2.send(
        new RunInstancesCommand({
          BlockDeviceMappings: [
            {
              DeviceName: "/dev/xvda",
              Ebs: {
                DeleteOnTermination: true,
                Encrypted: true,
                VolumeSize: input.rootDiskGb,
                VolumeType: "gp3",
              },
            },
          ],
          ClientToken: input.clientToken,
          ImageId: input.amiId,
          InstanceType: input.instanceType as _InstanceType,
          MaxCount: 1,
          MetadataOptions: { HttpEndpoint: "enabled", HttpTokens: "required" },
          MinCount: 1,
          NetworkInterfaces: [
            {
              AssociatePublicIpAddress: true,
              DeleteOnTermination: true,
              DeviceIndex: 0,
              Groups: [input.securityGroupId],
              SubnetId: input.subnetId,
            },
          ],
          TagSpecifications: [
            { ResourceType: "instance", Tags: tags },
            { ResourceType: "volume", Tags: tags },
          ],
          UserData: Buffer.from(input.userData, "utf8").toString("base64"),
        }),
      );
      const parsed = runInstancesResponseSchema.parse(response);
      const instance = parsed.Instances[0];
      if (instance === undefined) {
        throw new Error("validated launch response did not contain an instance");
      }

      return {
        availabilityZone: instance.Placement.AvailabilityZone,
        instanceId: instance.InstanceId,
      };
    } catch (error: unknown) {
      throw safeAwsError("RunInstances", error);
    }
  }

  async terminateDevbox(instanceId: string): Promise<void> {
    let instance;
    try {
      instance = await this.describeInstance(instanceId, "DescribeInstancesBeforeTerminate");
    } catch (error: unknown) {
      if (isAwsNotFound(error, "InvalidInstanceID.NotFound")) {
        return;
      }
      throw error;
    }

    const volumeIds = (instance.BlockDeviceMappings ?? [])
      .map((mapping) => mapping.Ebs?.VolumeId)
      .filter((volumeId): volumeId is string => volumeId !== undefined);

    if (!terminatingInstanceStates.has(instance.State.Name)) {
      try {
        await this.clients.ec2.send(
          new TerminateInstancesCommand({ InstanceIds: [instanceId] }),
        );
      } catch (error: unknown) {
        throw safeAwsError("TerminateInstances", error);
      }
    }

    await this.waitUntilTerminated(instanceId);
    await this.waitUntilVolumesDeleted(volumeIds);
  }

  private async describeInstance(instanceId: string, operation: string) {
    try {
      const response = await this.clients.ec2.send(
        new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
      );
      const parsed = describeInstancesResponseSchema.parse(response);
      const instances = (parsed.Reservations ?? []).flatMap(
        (reservation) => reservation.Instances ?? [],
      );
      if (instances.length !== 1 || instances[0] === undefined) {
        throw new AwsProviderError(operation, "AWS_INSTANCE_RESPONSE_INVALID");
      }
      return instances[0];
    } catch (error: unknown) {
      throw safeAwsError(operation, error);
    }
  }

  private async waitUntilTerminated(instanceId: string): Promise<void> {
    for (let attempt = 0; attempt < this.terminationPollAttempts; attempt += 1) {
      try {
        const instance = await this.describeInstance(instanceId, "PollInstanceTermination");
        if (terminalInstanceStates.has(instance.State.Name)) {
          return;
        }
      } catch (error: unknown) {
        if (isAwsNotFound(error, "InvalidInstanceID.NotFound")) {
          return;
        }
        throw error;
      }
      await sleep(this.pollIntervalMs);
    }
    throw new AwsProviderError("PollInstanceTermination", "AWS_TERMINATION_TIMEOUT");
  }

  private async waitUntilVolumesDeleted(volumeIds: readonly string[]): Promise<void> {
    if (volumeIds.length === 0) {
      return;
    }

    for (let attempt = 0; attempt < this.volumePollAttempts; attempt += 1) {
      try {
        const response = await this.clients.ec2.send(
          new DescribeVolumesCommand({ VolumeIds: [...volumeIds] }),
        );
        const parsed = describeVolumesResponseSchema.parse(response);
        if ((parsed.Volumes ?? []).length === 0) {
          return;
        }
      } catch (error: unknown) {
        if (awsErrorCode(error) === "InvalidVolume.NotFound") {
          return;
        }
        throw safeAwsError("DescribeVolumesAfterTerminate", error);
      }
      await sleep(this.pollIntervalMs);
    }
    throw new AwsProviderError("DescribeVolumesAfterTerminate", "AWS_VOLUME_CLEANUP_TIMEOUT");
  }
}

export function createEc2AwsDevboxProvider(
  region: string,
  options: Ec2AwsDevboxProviderOptions = {},
): Ec2AwsDevboxProvider {
  const ec2 = new EC2Client({ region });
  const instanceConnect = new EC2InstanceConnectClient({ region });
  return new Ec2AwsDevboxProvider(
    {
      ec2: { send: (command) => ec2.send(command as never) },
      instanceConnect: { send: (command) => instanceConnect.send(command as never) },
    },
    options,
  );
}

function validateLaunchInput(input: LaunchDevboxInput): void {
  if (!Number.isSafeInteger(input.rootDiskGb) || input.rootDiskGb <= 0) {
    throw new AwsProviderError("RunInstances", "AWS_LAUNCH_INPUT_INVALID");
  }
  if (
    input.tags.Project !== "sfkm-demo" ||
    !nonEmpty(input.tags.SFKMDevboxId) ||
    !nonEmpty(input.tags.EnvironmentVersion) ||
    !nonEmpty(input.tags.Owner)
  ) {
    throw new AwsProviderError("RunInstances", "AWS_REQUIRED_TAGS_MISSING");
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeAwsError(operation: string, error: unknown): AwsProviderError {
  if (error instanceof AwsProviderError) {
    return error;
  }
  return new AwsProviderError(operation, awsErrorCode(error) ?? "AWS_RESPONSE_INVALID");
}

function awsErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return undefined;
  }
  const name = error.name;
  return typeof name === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(name) ? name : undefined;
}

function isAwsNotFound(error: unknown, code: string): boolean {
  return error instanceof AwsProviderError && error.code === code;
}
