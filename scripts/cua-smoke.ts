// Smoke test: connect to Cua Driver as an MCP stdio client from a Bun process.
// Proves the transport Moki's backend would use. Run: bun scripts/cua-smoke.ts
import { spawn } from "node:child_process";

const child = spawn("/Users/cherry/.local/bin/cua-driver", ["mcp"], {
  stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 1;
const pending = new Map<number, (value: unknown) => void>();
let buffer = "";

child.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    } catch {
      // Non-JSON log line; ignore.
    }
  }
});

function request(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (err) => {
      if (err) reject(err);
    });
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
  });
}

function notify(method: string, params?: unknown) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const init = await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "moki-smoke", version: "0.0.0" },
});
console.log("initialize ok:", JSON.stringify(init.result?.serverInfo ?? init.result));

notify("notifications/initialized");

const tools = await request("tools/list");
const names = (tools.result?.tools ?? []).map((t: any) => t.name);
console.log(`tools/list ok: ${names.length} tools`);
console.log(names.join(", "));

const apps = await request("tools/call", {
  name: "list_apps",
  arguments: {},
});
const text = (apps.result?.content ?? []).map((c: any) => c.text ?? "").join("");
console.log("list_apps ok:", text.slice(0, 300));

child.kill();
process.exit(0);
