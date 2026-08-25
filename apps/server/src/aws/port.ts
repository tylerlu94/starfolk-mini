export interface LaunchDevboxInput {
  readonly amiId: string;
  readonly clientToken: string;
  readonly instanceType: string;
  readonly rootDiskGb: number;
  readonly securityGroupId: string;
  readonly subnetId: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly userData: string;
}

export interface LaunchDevboxResult {
  readonly availabilityZone: string;
  readonly instanceId: string;
}

export interface InstanceConnectionDetails {
  readonly availabilityZone: string;
  readonly host: string;
  readonly instanceId: string;
}

export interface AuthorizeSshKeyInput {
  readonly availabilityZone: string;
  readonly instanceId: string;
  readonly osUser: string;
  readonly publicKey: string;
}

export interface AwsDevboxProvider {
  authorizeSshKey(input: AuthorizeSshKeyInput): Promise<void>;
  getConnectionDetails(instanceId: string): Promise<InstanceConnectionDetails>;
  launchDevbox(input: LaunchDevboxInput): Promise<LaunchDevboxResult>;
  terminateDevbox(instanceId: string): Promise<void>;
}
