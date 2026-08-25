import { describe, expect, it } from "vitest";

import { createProgram, type CliCommands } from "./program.js";

describe("CLI command surface", () => {
  it("exposes only the five requested operations", () => {
    const program = createProgram(noopCommands());
    const topLevel = program.commands.map((command) => command.name()).sort();
    expect(topLevel).toEqual(["devbox", "session", "ssh"]);

    const devbox = program.commands.find((command) => command.name() === "devbox");
    const session = program.commands.find((command) => command.name() === "session");
    expect(devbox?.commands.map((command) => command.name()).sort()).toEqual(["create", "delete"]);
    expect(session?.commands.map((command) => command.name()).sort()).toEqual(["connect", "start"]);
    expect(program.options.map(({ long }) => long)).toEqual(["--version"]);
  });

  it("passes the required repository and branch to devbox creation", async () => {
    const calls: string[][] = [];
    const commands = noopCommands();
    commands.createDevbox = async (repositoryUrl, branch) => {
      calls.push([repositoryUrl, branch]);
    };

    await createProgram(commands).parseAsync([
      "node",
      "sfkm",
      "devbox",
      "create",
      "--repo",
      "https://github.com/openai/example.git",
      "--branch",
      "main",
    ]);

    expect(calls).toEqual([["https://github.com/openai/example.git", "main"]]);
  });
});

function noopCommands(): CliCommands {
  return {
    connectSession: async () => undefined,
    createDevbox: async () => undefined,
    deleteDevbox: async () => undefined,
    ssh: async () => undefined,
    startSession: async () => undefined,
  };
}
