// Dump the full Cua Driver MCP tool catalog: names, descriptions, argument schemas.
// Writes scripts/cua-tools.json for reference. Run: bun scripts/cua-tools.ts
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

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

const init = await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "moki-tools-dump", version: "0.0.0" },
});
if (!init.result) throw new Error("initialize failed");
child.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
);

const tools = await request("tools/list");
const catalog = (tools.result?.tools ?? []) as Array<{
  name: string;
  description?: string;
  inputSchema?: any;
}>;

writeFileSync(
  "/Users/cherry/moki/scripts/cua-tools.json",
  JSON.stringify(catalog, null, 2),
);

for (const t of catalog) {
  const args = Object.keys(t.inputSchema?.properties ?? {});
  console.log(`${t.name}(${args.join(", ")})`);
  const desc = (t.description ?? "").split("\n")[0];
  if (desc) console.log(`  ${desc.slice(0, 140)}`);
}
console.log(`\n${catalog.length} tools. Full schemas: scripts/cua-tools.json`);

child.kill();
process.exit(0);
