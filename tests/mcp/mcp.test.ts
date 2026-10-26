import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../../src/daemon";
import { clipmunkTools, MCP_INSTRUCTIONS, serveMcp } from "../../src/mcp";
import { FFMPEG, makeTake } from "../support/take";

/** `clipmunk mcp` driven by an in-process client, the way an agent's MCP client talks to it. */
const root = path.resolve("examples/vite-app");
const TAKE = "zz-mcp-take";
const projectFile = path.join(root, ".clipmunk/project.json");
const configFile = path.join(root, "clipmunk.config.json");
let server: ViteDevServer, daemon: Daemon, project: string, config: string;
const made: string[] = [];

/** An MCP session over a pair of streams: send a request, wait for the answer with its id. */
function session(serverRoot: string) {
  const input = new PassThrough(),
    output = new PassThrough();
  void serveMcp({
    input,
    output,
    tools: clipmunkTools(serverRoot),
    name: "clipmunk",
    version: "test",
    instructions: MCP_INSTRUCTIONS,
  });
  const waiting = new Map<number, (message: any) => void>();
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let line = buffer.indexOf("\n"); line >= 0; line = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, line));
      buffer = buffer.slice(line + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let next = 1;
  const rpc = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await rpc("tools/call", { name, arguments: args })).result;
  const textOf = (result: any) =>
    result.content
      .filter((item: any) => item.type === "text")
      .map((item: any) => item.text)
      .join("\n");
  return { rpc, call, textOf, close: () => input.end() };
}
const editOf = async () =>
  JSON.parse(await readFile(path.join(root, ".clipmunk/takes", TAKE, "edit.json"), "utf8")).edit;

beforeAll(async () => {
  process.env.CLIPMUNK_FFMPEG ??= FFMPEG;
  project = await readFile(projectFile, "utf8");
  config = await readFile(configFile, "utf8");
  await makeTake(root, TAKE, { cam: false, named: true });
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
  await writeFile(projectFile, `${JSON.stringify({ ...JSON.parse(project), devUrl: origin }, null, 2)}\n`);
  // The MCP server finds the daemon through .clipmunk/daemon.json, as it does in a project.
  daemon = await startDaemon({ root, port: 0, announce: true });
}, 120_000);
afterAll(async () => {
  await daemon?.close();
  await server?.close();
  await writeFile(projectFile, project);
  await writeFile(configFile, config);
  await rm(path.join(root, ".clipmunk/takes", TAKE), { recursive: true, force: true });
  await rm(path.join(root, ".clipmunk/history", `${TAKE}.json`), { force: true });
  await rm(path.join(root, ".clipmunk/chat"), { recursive: true, force: true });
  await rm(path.join(root, ".clipmunk/cache/frames", TAKE), { recursive: true, force: true });
  for (const file of made) await rm(path.join(root, file), { force: true });
});

describe("clipmunk mcp", () => {
  it("introduces itself and lists its tools", async () => {
    const mcp = session(root);
    const hello = await mcp.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(hello.result).toMatchObject({
      serverInfo: { name: "clipmunk" },
      capabilities: { tools: {} },
      protocolVersion: "2025-06-18",
    });
    expect(hello.result.instructions).toContain("edit_take");
    const { tools } = (await mcp.rpc("tools/list")).result;
    expect(tools.map((tool: any) => tool.name)).toEqual([
      "list_clips",
      "get_take",
      "get_scene",
      "edit_take",
      "apply_preset",
      "preview",
      "export",
      "get_job",
      "get_take_frames",
      "check_scene",
      "wait_for_chat",
      "reply_chat",
    ]);
    for (const tool of tools) expect(tool.inputSchema.type).toBe("object");
    expect((await mcp.rpc("nonsense")).error.code).toBe(-32601);
    mcp.close();
  });

  it("lists clips and reads a take and a scene", async () => {
    const mcp = session(root);
    const clips = mcp.textOf(await mcp.call("list_clips"));
    expect(clips).toContain(`take ${TAKE}: Synthetic take (4.0 s)`);
    expect(clips).toContain("scene rack-focus: Rack focus (1.5 s)");
    const take = mcp.textOf(await mcp.call("get_take", { id: TAKE }));
    expect(take).toContain('2.00s click button "Go" (#go)');
    expect(take).toContain("3.00s shortcut Meta+k");
    expect(take).toMatch(/revision [0-9a-f]{64}/);
    expect(take).toContain('"trim"');
    const scene = mcp.textOf(await mcp.call("get_scene", { id: "rack-focus" }));
    expect(scene).toMatch(/^Component: .*rack-focus\.tsx$/m);
    expect(scene).toContain('"definition"');
    mcp.close();
  });

  it("trims, zooms and captions a take with merge patches, and refuses bad or stale edits", async () => {
    const mcp = session(root);
    const trimmed = await mcp.call("edit_take", {
      id: TAKE,
      patch: { trim: { startMs: 500 } },
      note: "skip the start",
    });
    expect(trimmed.isError).toBeUndefined();
    expect(mcp.textOf(trimmed)).toContain("trim.startMs: 0 -> 500");
    expect(mcp.textOf(trimmed)).toContain("(skip the start)");
    await mcp.call("edit_take", { id: TAKE, patch: { zoom: { mode: "off" } } });
    await mcp.call("edit_take", {
      id: TAKE,
      patch: { captions: { items: [{ atMs: 1500, durMs: 2000, text: "Press Go", source: "manual" }] } },
    });
    const edit = await editOf();
    expect(edit.trim.startMs).toBe(500);
    expect(edit.zoom).toEqual({ mode: "off" });
    expect(edit.captions.items).toEqual([{ atMs: 1500, durMs: 2000, text: "Press Go", source: "manual" }]);
    // A patch that does not validate changes nothing and says why.
    const bad = await mcp.call("edit_take", { id: TAKE, patch: { cursor: { size: 99 } } });
    expect(bad.isError).toBe(true);
    expect(mcp.textOf(bad)).toContain("cursor.size");
    expect((await editOf()).cursor.size).toBe(edit.cursor.size);
    const stale = await mcp.call("edit_take", {
      id: TAKE,
      patch: { trim: { startMs: 600 } },
      revision: "0".repeat(64),
    });
    expect(stale.isError).toBe(true);
    expect(mcp.textOf(stale)).toContain("changed since it was loaded");
    mcp.close();
  }, 60_000);

  it("previews a frame of a take and of a scene", async () => {
    const mcp = session(root);
    const take = await mcp.call("preview", { id: TAKE, atMs: 1200 });
    const image = take.content.find((item: any) => item.type === "image");
    const png = Buffer.from(image.data, "base64");
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1920, 1080]);
    const scene = await mcp.call("preview", { id: "themed-card", atMs: 500, variant: "theme:dark,ratio:9x16" });
    const scenePng = Buffer.from(scene.content.find((item: any) => item.type === "image").data, "base64");
    expect([scenePng.readUInt32BE(16), scenePng.readUInt32BE(20)]).toEqual([300, 534]);
    expect(mcp.textOf(scene)).toContain("scene themed-card at 500 ms");
    mcp.close();
  }, 120_000);

  it("shows a take's own frames and checks a scene against them", async () => {
    const mcp = session(root);
    const frames = await mcp.call("get_take_frames", { id: TAKE });
    expect(frames.isError).toBeUndefined();
    const images = frames.content.filter((item: any) => item.type === "image");
    expect(images.length).toBeGreaterThan(0);
    const png = Buffer.from(images[0].data, "base64");
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    // The default is each click: the synthetic take clicks Go at 2 s.
    expect(mcp.textOf(frames)).toContain("at 2.00 s");
    const chosen = await mcp.call("get_take_frames", { id: TAKE, times: [100, 99_999] });
    expect(chosen.content.filter((item: any) => item.type === "image")).toHaveLength(2);
    expect(mcp.textOf(chosen)).toContain("at 0.10 s");

    const scene = await mcp.call("check_scene", { id: "rack-focus", times: [0, 750] });
    expect(scene.isError).toBeUndefined();
    expect(mcp.textOf(scene)).toContain("No issues.");
    expect(scene.content.filter((item: any) => item.type === "image")).toHaveLength(2);
    const missing = await mcp.call("check_scene", { id: "zz-no-such-scene" });
    expect(missing.isError).toBe(true);
    expect(mcp.textOf(missing)).toContain('No valid scene named "zz-no-such-scene"');
    mcp.close();
  }, 120_000);

  it("applies a preset, exports, and follows the job", async () => {
    const json = JSON.parse(config);
    await writeFile(
      configFile,
      `${JSON.stringify({ ...json, presets: { ...json.presets, "zz-mcp": { edit: { cursor: { size: 2 } } } } }, null, 2)}\n`,
    );
    const mcp = session(root);
    expect(mcp.textOf(await mcp.call("apply_preset", { id: TAKE, preset: "zz-mcp" }))).toContain("Applied zz-mcp");
    expect((await editOf()).cursor.size).toBe(2);
    const started = mcp.textOf(await mcp.call("export", { id: TAKE, options: { formats: ["poster"] } }));
    const job = /job (\w+)/.exec(started)![1]!;
    let state = "";
    await expect
      .poll(
        async () => {
          state = mcp.textOf(await mcp.call("get_job", { id: job }));
          return state.startsWith("Done") || state.startsWith("Failed");
        },
        { timeout: 120_000, interval: 1000 },
      )
      .toBe(true);
    expect(state).toContain(`zz-mcp-take.png`);
    made.push(...[...state.matchAll(/"output": "([^"]+)"/g)].map((match) => match[1]!));
    mcp.close();
  }, 180_000);

  it("chats: waits for the developer, proposes an edit, and the developer keeps and undoes it", async () => {
    const api = (route: string, body?: unknown) =>
      fetch(`${daemon.origin}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }).then((response) => response.json() as Promise<any>);
    const mcp = session(root);
    await mcp.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "Test agent" },
    });
    // Nothing yet: the wait ends empty.
    expect(mcp.textOf(await mcp.call("wait_for_chat", { timeoutMs: 1000 }))).toContain("No message yet");
    // The agent waits; the Studio's message reaches it while it does.
    const waiting = mcp.call("wait_for_chat", { timeoutMs: 20_000 });
    await expect
      .poll(async () => (await api("/v1/chat")).data.agent, { timeout: 5000 })
      .toEqual({ name: "Test agent", waiting: true });
    const sent = await api("/v1/chat", {
      text: "Start it later",
      context: [
        { kind: "clip", clip: { kind: "take", id: TAKE } },
        { kind: "time", ms: 1250 },
      ],
    });
    expect(sent.ok).toBe(true);
    const received = mcp.textOf(await waiting);
    expect(received).toContain("Start it later");
    expect(received).toContain(`take ${TAKE} (get_take to read it)`);
    expect(received).toContain("the moment at 1.25 s");
    // A proposal that would not validate is refused before the developer sees it.
    const bad = await mcp.call("reply_chat", {
      text: "Bigger",
      proposal: { takeId: TAKE, patch: { cursor: { size: 99 } } },
    });
    expect(bad.isError).toBe(true);
    const before = await editOf();
    const replied = await mcp.call("reply_chat", {
      text: "Starting at 0.8 s.",
      proposal: { takeId: TAKE, patch: { trim: { startMs: 800 } }, note: "later start" },
      followUps: ["Also zoom on Go"],
    });
    expect(mcp.textOf(replied)).toContain("keep or undo");
    // Proposed, not applied.
    expect((await editOf()).trim.startMs).toBe(before.trim.startMs);
    const chat = (await api("/v1/chat")).data.messages;
    const proposal = chat.at(-1);
    expect(proposal).toMatchObject({ from: "agent", followUps: ["Also zoom on Go"], proposal: { status: "proposed" } });
    expect(chat.at(-2)).toMatchObject({ from: "developer", delivered: true });
    expect((await api(`/v1/chat/${proposal.id}/keep`, {})).ok).toBe(true);
    expect((await editOf()).trim.startMs).toBe(800);
    expect((await api(`/v1/chat/${proposal.id}/undo`, {})).ok).toBe(true);
    expect((await editOf()).trim.startMs).toBe(before.trim.startMs);
    mcp.close();

    // The conversation is on disk, so a new daemon has it.
    await daemon.close();
    daemon = await startDaemon({ root, port: 0, announce: true });
    const again = (await api("/v1/chat")).data.messages;
    expect(again.map((message: any) => message.text)).toEqual(chat.map((message: any) => message.text));
    expect(again.at(-1).proposal.status).toBe("undone");
  }, 60_000);

  it("says how to start the daemon when none is running", async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "clipmunk-mcp-"));
    const mcp = session(empty);
    const result = await mcp.call("list_clips");
    expect(result.isError).toBe(true);
    expect(mcp.textOf(result)).toContain("npx clipmunk dev");
    mcp.close();
  });
});
