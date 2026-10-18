// Minimal MCP stdio transport: newline-delimited JSON-RPC 2.0 over stdin/stdout.
//
// Hand-rolled rather than taking @modelcontextprotocol/sdk, for the same reason this project
// hand-rolls its DAP server and its PUAE RPC dispatcher: the surface actually used here is small
// and fully specified, while the SDK would pull express, hono, zod, ajv and jose into a package
// with ten runtime dependencies — for a server that only ever speaks stdio.
//
// The protocol used here is three requests and one notification:
//   initialize                -> { protocolVersion, capabilities, serverInfo }
//   notifications/initialized -> (no reply; it is a notification)
//   tools/list                -> { tools: [...] }
//   tools/call                -> { content: [...], isError? }
//
// Framing: one JSON object per line, no embedded newlines. That is the whole stdio transport.
//
// stdout is the protocol stream, so NOTHING may write to it except sendMessage — the same hazard
// server.ts's --stdio DAP mode documents, and the reason `log` below goes to stderr
// unconditionally rather than branching on anything.

import { createInterface } from "readline";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number; // absent for notifications, which must not be replied to
  method: string;
  params?: Record<string, unknown>;
}

// JSON-RPC reserved codes. Tool *failures* are not these — a tool that runs and reports a problem
// returns a normal result with isError, so the model sees the message instead of a transport
// error. These are for malformed or unroutable messages.
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INTERNAL_ERROR = -32603;

export interface ToolDefinition {
  name: string;
  description: string;
  // JSON Schema for the tool's arguments. Hand-written rather than generated — see tools.ts.
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string> | string;
}

// Protocol revisions this server knows how to speak. A client asks for one in `initialize`; the
// spec has the server answer with the version it will actually use, so an unknown request gets
// the newest we support rather than an error — the client then decides whether to proceed.
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export function log(message: string): void {
  process.stderr.write(message + "\n");
}

export interface ServerInfo {
  name: string;
  version: string;
  /**
   * Returned by `initialize` as the server's `instructions`, which clients put in front of the
   * model. Not part of `serverInfo` itself.
   */
  instructions?: string;
}

// Route one message and produce its response, or undefined when there is nothing to send.
// Separated from the stdio plumbing so the protocol can be tested directly, without a subprocess.
//
// A notification has no id and must never be answered — replying to one is a protocol violation
// some clients treat as fatal — so every branch returns undefined for them.
export async function handleRequest(
  req: JsonRpcRequest,
  info: ServerInfo,
  tools: ToolDefinition[],
): Promise<Record<string, unknown> | undefined> {
  const isNotification = req.id === undefined;
  const ok = (result: unknown) => ({ jsonrpc: "2.0" as const, id: req.id!, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0" as const, id: req.id!, error: { code, message } });

  switch (req.method) {
    case "initialize": {
      if (isNotification) return undefined;
      const asked = (req.params?.protocolVersion as string) ?? "";
      // The spec has the server answer with the version it will actually use, so an unfamiliar
      // request gets the newest we support rather than an error; the client then decides.
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL_VERSION;
      // Only tools are declared. Advertising capabilities we don't implement (resources, prompts)
      // would invite calls this server can't answer.
      const { instructions, ...serverInfo } = info;
      return ok({ protocolVersion, capabilities: { tools: {} }, serverInfo, ...(instructions ? { instructions } : {}) });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;
    case "ping":
      return isNotification ? undefined : ok({});
    case "tools/list":
      if (isNotification) return undefined;
      return ok({
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      if (isNotification) return undefined;
      const name = req.params?.name as string;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return err(JSON_RPC_METHOD_NOT_FOUND, `Unknown tool: ${name}`);
      try {
        const text = await tool.run((req.params?.arguments as Record<string, unknown>) ?? {});
        return ok({ content: [{ type: "text", text }] });
      } catch (e) {
        // A tool failing on its input (a missing file, an unreadable capture) is a normal result
        // carrying isError, not a transport error: the model should see the message and be able
        // to correct itself, which a JSON-RPC error object doesn't reliably surface.
        return ok({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    }
    default:
      return isNotification ? undefined : err(JSON_RPC_METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
  }
}

export function serveStdio(info: ServerInfo, tools: ToolDefinition[]): void {
  const send = (message: Record<string, unknown>): void => {
    process.stdout.write(JSON.stringify(message) + "\n");
  };

  // Messages are handled strictly in order. Concurrency would buy nothing — every tool is
  // CPU-bound analysis of one file — and serialising keeps stdout writes from interleaving.
  let queue: Promise<void> = Promise.resolve();
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: JSON_RPC_PARSE_ERROR, message: "Parse error" } });
      return;
    }
    if (typeof req?.method !== "string") {
      send({ jsonrpc: "2.0", id: req?.id ?? null, error: { code: JSON_RPC_INVALID_REQUEST, message: "Invalid request" } });
      return;
    }
    queue = queue
      .then(async () => {
        const response = await handleRequest(req, info, tools);
        if (response) send(response);
      })
      .catch((e) => {
        // Never let one bad message kill the loop — the client would hang waiting for a reply
        // that is never coming.
        if (req.id !== undefined) {
          send({ jsonrpc: "2.0", id: req.id, error: { code: JSON_RPC_INTERNAL_ERROR, message: e instanceof Error ? e.message : String(e) } });
        }
      });
  });
  rl.on("close", () => process.exit(0));
}
