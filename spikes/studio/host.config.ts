// Spike: the example app, plus a dev-only frame agent so a Studio on another origin can drive it.
// No product code changes: the agent is injected by this config, not by the app.
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig, type Plugin } from "vite";
import base from "../../examples/vite-app/vite.config";

const agent = fileURLToPath(new URL("./frame-agent.ts", import.meta.url));
const injectAgent: Plugin = {
  name: "clipmunk-spike-frame-agent",
  transformIndexHtml: () => [{ tag: "script", attrs: { type: "module", src: `/@fs${agent}` }, injectTo: "head" }],
};

export default mergeConfig(base, defineConfig({
  root: fileURLToPath(new URL("../../examples/vite-app", import.meta.url)),
  plugins: [injectAgent],
  server: { port: 5180, strictPort: true, host: "127.0.0.1", fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
}));
