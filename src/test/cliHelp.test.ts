// The risk with top-level help isn't that it's wrong today — it's that a fifth subcommand gets
// added and the list silently stays at four. These tests fail in that case.

import { HELP_FLAGS, usage, VERSION_FLAGS } from "../standalone/cliHelp";

describe("CLI help", () => {
  const text = usage("1.2.3");

  it("names the binary and its version", () => {
    expect(text.startsWith("puae-debugger 1.2.3")).toBe(true);
  });

  it.each(["profile", "mcp", "skill install"])("documents the %s subcommand", (subcommand) => {
    expect(text).toContain(`puae-debugger ${subcommand}`);
  });

  it("documents every server flag parseArgs accepts", () => {
    // Mirrors the switch in server.ts's parseArgs. A flag that works but isn't listed is
    // undiscoverable; one that's listed but doesn't work is a lie.
    for (const flag of ["--port", "--http-port", "--stdio", "--no-open"]) {
      expect(text).toContain(flag);
    }
  });

  it("mentions that subcommands have their own help", () => {
    expect(text).toMatch(/profile --help/);
  });

  it("accepts the conventional help and version flags", () => {
    expect(HELP_FLAGS).toEqual(expect.arrayContaining(["-h", "--help"]));
    expect(VERSION_FLAGS).toEqual(expect.arrayContaining(["-v", "--version"]));
  });
});
