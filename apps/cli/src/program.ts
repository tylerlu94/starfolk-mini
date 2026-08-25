import { Command } from "commander";

export interface CliCommands {
  connectSession(sessionId: string): Promise<void>;
  createDevbox(repositoryUrl: string, branch: string): Promise<void>;
  deleteDevbox(devboxId: string): Promise<void>;
  ssh(devboxId: string): Promise<void>;
  startSession(devboxId: string, prompt: string): Promise<void>;
}

export function createProgram(service: CliCommands): Command {
  const program = new Command()
    .name("sfkm")
    .description("Mini Starfolk CLI")
    .version("0.0.0");

  const devbox = program.command("devbox").description("Create and delete EC2 devboxes");
  devbox
    .command("create")
    .description("Create a devbox from a public GitHub repository branch")
    .requiredOption("--repo <url>", "Public GitHub HTTPS repository URL")
    .requiredOption("--branch <branch>", "Git branch to provision")
    .action(async (options: { branch: string; repo: string }) =>
      service.createDevbox(options.repo, options.branch));
  devbox
    .command("delete")
    .description("Delete a devbox")
    .argument("<devbox-id>")
    .action(async (devboxId: string) => service.deleteDevbox(devboxId));

  program
    .command("ssh")
    .description("Open an interactive SSH shell in a devbox repository")
    .argument("<devbox-id>")
    .action(async (devboxId: string) => service.ssh(devboxId));

  const session = program.command("session").description("Start or reconnect to agent sessions");
  session
    .command("start")
    .description("Start the pinned agent and attach to it")
    .argument("<devbox-id>")
    .argument("<prompt>")
    .action(async (devboxId: string, prompt: string) => service.startSession(devboxId, prompt));
  session
    .command("connect")
    .description("Reconnect to the original agent process")
    .argument("<session-id>")
    .action(async (sessionId: string) => service.connectSession(sessionId));

  return program;
}
