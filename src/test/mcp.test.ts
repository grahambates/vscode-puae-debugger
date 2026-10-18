import * as path from "path";
import { handleRequest, JSON_RPC_METHOD_NOT_FOUND, ServerInfo, ToolDefinition } from "../mcp/jsonRpc";
import { TOOLS } from "../mcp/tools";

const INFO: ServerInfo = { name: "test-server", version: "9.9.9" };
const FIXTURE = path.join(__dirname, "fixtures/profiles/template.puaeprofile");

const echoTool: ToolDefinition = {
  name: "echo",
  description: "echoes",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  run: (args) => `got:${args.text}`,
};
const throwingTool: ToolDefinition = {
  name: "boom",
  description: "throws",
  inputSchema: { type: "object" },
  run: () => { throw new Error("kaboom"); },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (method: string, params?: Record<string, unknown>): Promise<any> =>
  handleRequest({ jsonrpc: "2.0", id: 1, method, params }, INFO, [echoTool, throwingTool]);

// A notification is a message with NO id field at all — not an id of undefined, which a default
// parameter would quietly turn back into a real id.
const notify = (method: string, params?: Record<string, unknown>) =>
  handleRequest({ jsonrpc: "2.0", method, params }, INFO, [echoTool, throwingTool]);

describe("MCP protocol routing", () => {
  it("answers initialize with the version the client asked for, when supported", async () => {
    const r = await call("initialize", { protocolVersion: "2024-11-05" });
    expect(r.result.protocolVersion).toBe("2024-11-05");
    expect(r.result.serverInfo).toEqual(INFO);
  });

  it("falls back to its newest version for an unfamiliar one rather than erroring", async () => {
    // The spec has the server state the version it will actually use; the client then decides
    // whether to continue. Refusing outright would strand clients that ask for something newer.
    const r = await call("initialize", { protocolVersion: "1999-01-01" });
    expect(r.result.protocolVersion).toBe("2025-06-18");
    expect(r.error).toBeUndefined();
  });

  it("declares only the tools capability", async () => {
    // Advertising resources/prompts we don't implement would invite calls that can't be answered.
    const r = await call("initialize", { protocolVersion: "2025-06-18" });
    expect(r.result.capabilities).toEqual({ tools: {} });
  });

  it("never replies to a notification", async () => {
    for (const m of ["notifications/initialized", "notifications/cancelled", "initialize", "tools/list", "ping", "whatever"]) {
      expect(await notify(m, {})).toBeUndefined();
    }
  });

  it("lists tools with their schemas", async () => {
    const r = await call("tools/list");
    expect(r.result.tools.map((t: { name: string }) => t.name)).toEqual(["echo", "boom"]);
    expect(r.result.tools[0].inputSchema).toEqual(echoTool.inputSchema);
  });

  it("calls a tool and returns its text", async () => {
    const r = await call("tools/call", { name: "echo", arguments: { text: "hi" } });
    expect(r.result.content).toEqual([{ type: "text", text: "got:hi" }]);
    expect(r.result.isError).toBeUndefined();
  });

  it("defaults missing arguments to an empty object", async () => {
    const r = await call("tools/call", { name: "echo" });
    expect(r.result.content[0].text).toBe("got:undefined");
  });

  it("reports a throwing tool as isError, not a transport error", async () => {
    // The model should see the message and be able to correct itself; a JSON-RPC error object
    // doesn't reliably surface that.
    const r = await call("tools/call", { name: "boom" });
    expect(r.error).toBeUndefined();
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toBe("kaboom");
  });

  it("rejects an unknown tool at the protocol level", async () => {
    const r = await call("tools/call", { name: "missing" });
    expect(r.error.code).toBe(JSON_RPC_METHOD_NOT_FOUND);
  });

  it("rejects an unknown method", async () => {
    const r = await call("resources/list");
    expect(r.error.code).toBe(JSON_RPC_METHOD_NOT_FOUND);
  });

  it("answers ping", async () => {
    expect((await call("ping")).result).toEqual({});
  });
});

describe("MCP tools", () => {
  const realCall = (name: string, args: Record<string, unknown>) =>
    handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, INFO, TOOLS);

  it("exposes the analysis tools", async () => {
    const r = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, INFO, TOOLS);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((r as any).result.tools.map((t: { name: string }) => t.name)).toEqual(["profile_check", "profile_dump"]);
  });

  it("steers the caller to run check before trusting dump", async () => {
    // The ordering advice is the single most important thing these descriptions carry: a
    // capture's per-function percentages read as plausible even when the frame total they are a
    // share of is impossible. Asserted so it can't be edited away without a test failing.
    const check = TOOLS.find((t) => t.name === "profile_check")!;
    expect(check.description).toMatch(/ALWAYS run this before profile_dump/);
  });

  it("profile_check reports findings for a real capture", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await realCall("profile_check", { file: FIXTURE }) as any;
    expect(r.result.isError).toBeUndefined();
    expect(r.result.content[0].text).toMatch(/frame 0:/);
    // This fixture predates the arm-pending fix and is genuinely over budget — see
    // profileAnalysis.test.ts. Its finding should reach the caller.
    expect(r.result.content[0].text).toMatch(/frame-over-budget/);
  });

  it("profile_dump renders the cost table and honours --frame/--functions equivalents", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await realCall("profile_dump", { file: FIXTURE, frame: 0, functions: 2 }) as any;
    const text = r.result.content[0].text as string;
    expect(text).toMatch(/Frame 0:/);
    expect(text).toMatch(/self%\s+total\s+total%\s+width%/);
    expect(text).toMatch(/more \(use --functions 0\)/); // the cap was applied
  });

  it("reports a missing file as isError rather than throwing", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await realCall("profile_check", { file: "/no/such/file.puaeprofile" }) as any;
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/Could not read/);
  });

  it("reports a missing required argument as isError", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await realCall("profile_check", {}) as any;
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/"file" is required/);
  });
});
