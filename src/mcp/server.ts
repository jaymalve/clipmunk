import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** A minimal Model Context Protocol server over stdio: newline-delimited JSON-RPC 2.0 with the
 * methods an agent's client uses for tools (initialize, tools/list, tools/call, ping). Clipmunk
 * needs nothing else, so it carries no SDK.
 */
export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResult = { content: ToolContent[]; isError?: boolean };
export type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `session.client` is the name the agent's MCP client gave in initialize. */
  call(args: Record<string, unknown>, session: { client?: string }): Promise<ToolResult>;
};
type Request = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

export const PROTOCOL_VERSION = "2025-06-18";

export function serveMcp(options: {
  input: Readable;
  output: Writable;
  tools: readonly Tool[];
  name: string;
  version: string;
  instructions?: string;
}): Promise<void> {
  const send = (message: Record<string, unknown>) =>
    options.output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const reply = (id: Request["id"], result: unknown) => send({ id, result });
  const error = (id: Request["id"], code: number, message: string) => send({ id, error: { code, message } });

  const session: { client?: string } = {};
  async function handle(request: Request) {
    const { id, method, params = {} } = request;
    const notification = id === undefined;
    switch (method) {
      case "initialize": {
        const client = (params.clientInfo as { name?: unknown } | undefined)?.name;
        if (typeof client === "string") session.client = client;
        return reply(id, {
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: options.name, version: options.version },
          ...(options.instructions ? { instructions: options.instructions } : {}),
        });
      }
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, {
          tools: options.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case "tools/call": {
        const tool = options.tools.find((candidate) => candidate.name === params.name);
        if (!tool) return error(id, -32602, `Unknown tool: ${String(params.name)}`);
        try {
          return reply(id, await tool.call((params.arguments as Record<string, unknown>) ?? {}, session));
        } catch (failure) {
          // A failing tool is a result the agent can read, not a protocol error.
          return reply(id, {
            content: [{ type: "text", text: failure instanceof Error ? failure.message : String(failure) }],
            isError: true,
          });
        }
      }
      default:
        if (!notification) error(id, -32601, `Method not found: ${method}`);
    }
  }

  return new Promise((resolve) => {
    const lines = createInterface({ input: options.input });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let request: Request;
      try {
        request = JSON.parse(line);
      } catch {
        return error(null, -32700, "Parse error");
      }
      void handle(request);
    });
    lines.on("close", () => resolve());
  });
}
