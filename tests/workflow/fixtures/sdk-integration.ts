// Actual SDK/extension/tool/provider/HTTP boundaries; all config and content are synthetic.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pkg = process.env.PI_PKG!, monitor = process.env.PI_MONITOR_SOURCE!;
assert.ok(pkg); assert.ok(monitor);
assert.equal(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version, "1.5.0");
const scratch = mkdtempSync(join(tmpdir(), "workflow-sdk-capture-")), agentDir = join(scratch, "agent"), cwd = join(scratch, "work");
mkdirSync(agentDir); mkdirSync(cwd); mkdirSync(join(cwd, ".pi"));
process.chdir(cwd);
Object.assign(process.env, { HOME: scratch, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_MONITOR_FILE: join(scratch, "events.jsonl"), PI_MONITOR_CONFIG: join(scratch, "monitor.json") });
for (const key of ["PI_MONITOR_URL", "PI_MONITOR_TOKEN", "PI_MONITOR_PARENT_SESSION"]) delete process.env[key];
registerHooks({ resolve(specifier, context, next) { return next(specifier, specifier.startsWith("@earendil-works/") ? { ...context, parentURL: pathToFileURL(join(pkg, "dist/index.js")).href } : context); } });
const pi = await import(pathToFileURL(join(pkg, "dist/index.js")).href);
const { fakeGateway } = await import(pathToFileURL(join(monitor, "test/fixtures/fake-gateway.ts")).href);
const gw = await fakeGateway(); gw.state.turns = 1;
const gates = new Map<string, { started: boolean; promise: Promise<void>; release(): void }>();
function gate(name: string) { let release!: () => void; const value = { started: false, promise: new Promise<void>(r => { release = r; }), release: () => release() }; gates.set(name, value); return value; }
const requests: { id: string; body: string }[] = []; let retry = 0;
const proxy = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks), text = (req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw).toString();
    if (req.url === "/backend-api/codex/responses") {
      requests.push({ id: String(req.headers["x-pt-session"]), body: text });
      for (const [name, value] of gates) if (text.includes(name)) { value.started = true; await value.promise; }
    }
    const headers = { ...req.headers } as any; delete headers.host; delete headers["content-length"];
    const upstream = await fetch(`${gw.url}${req.url}`, { method: req.method, headers, ...(req.method !== "GET" ? { body: raw } : {}) });
    let body = await upstream.text();
    if (text.includes("RETRY_EMPTY") && retry++ === 0) body = body.replace(/answer \d+/g, "");
    const replyHeaders = Object.fromEntries(upstream.headers); delete replyHeaders["transfer-encoding"]; delete replyHeaders["content-length"]; delete replyHeaders["content-encoding"];
    res.writeHead(upstream.status, replyHeaders); res.end(body);
  } catch { if (!res.destroyed) res.writeHead(500).end(); }
});
await new Promise<void>(r => proxy.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(proxy.address() as any).port}`;
writeFileSync(process.env.PI_MONITOR_CONFIG!, JSON.stringify({ gatewayUrl: url, url, token: "monitor-token" }), { mode: 0o600 });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ pearlthoughts: { type: "oauth", access: "access-1", refresh: "unused", expires: Date.now() + 3600000 } }), { mode: 0o600 });
const route = { model: "pearlthoughts/gpt-6-luna", thinking: "high" };
writeFileSync(join(cwd, ".pi/workflow.json"), JSON.stringify({ version: 1, profile: "custom", concurrency: 4, maxAgents: 15, approvalMode: "always", routes: { scout: route, worker: route, reviewer: route, synthesizer: route } }));
const script = (body: string) => `export const meta={name:"sdk_capture",description:"synthetic workflow"}; ${body}`;
const company = (text: string) => `agent(${JSON.stringify(text)},{model:"pearlthoughts/gpt-6-luna:high",tools:[]})`;
const spool = process.env.PI_MONITOR_FILE!;
const rows = () => existsSync(spool) ? readFileSync(spool, "utf8").trim().split("\n").filter(Boolean).map(x => JSON.parse(x)) : [];
const until = async (predicate: () => boolean) => { const end = Date.now() + 10000; while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); assert.ok(predicate(), "synthetic workflow condition timed out"); };
const runDir = join(scratch, ".pi/workflows/projects", createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16), "runs");
const run = (id: string) => JSON.parse(readFileSync(join(runDir, `${id}.json`), "utf8"));
const errors: any[] = [], sessions: any[] = [];
let bus: any, tool: any, command: any;
const busShapes: string[][] = [];
const bind = (s: any) => s.bindExtensions({ mode: "rpc", uiContext: { confirm: async () => true, notify() {}, setStatus() {}, setWidget() {} }, onError: (e: any) => errors.push(e) });
const runtime = await pi.createAgentSessionRuntime(async (options: any) => {
  bus = pi.createEventBus();
  bus.on("pi-monitor:workflow-observer:v1", (r: any) => { busShapes.push(Object.keys(r).sort()); });
  const services = await pi.createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [join(root, "extensions/workflow/index.ts"), monitor, join(root, "tests/workflow/fixtures/private-provider.ts")], eventBus: bus } });
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  const extensions = services.resourceLoader.getExtensions().extensions;
  const workflows = extensions.flatMap((e: any) => [...e.tools.values()].filter((t: any) => t.definition.name === "workflow"));
  assert.equal(workflows.length, 1, "compatibility entry replaces the original workflow tool"); tool = workflows[0].definition;
  command = extensions.map((e: any) => e.commands.get("workflow")).find(Boolean);
  const result = await pi.createAgentSessionFromServices({ services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent, tools: [] });
  await result.session.setModel(result.session.modelRuntime.getModel("pearlthoughts", "gpt-6-luna"));
  return { ...result, services, diagnostics: [] };
}, { cwd, agentDir, sessionManager: pi.SessionManager.inMemory(cwd) });
runtime.setRebindSession(bind);
let parent = runtime.session; sessions.push(parent); await bind(parent);
const originalParent = parent.sessionId;
const execute = (body: string, options: any = {}, signal?: AbortSignal) => tool.execute("synthetic-workflow", { script: script(body), background: false, ...options }, signal, undefined, parent.extensionRunner.createContext());
try {
  await parent.prompt("synthetic workflow parent");
  const parallelGate = gate("PARALLEL_SLOW");
  const parallel = execute(`return parallel([()=>${company("PARALLEL_SLOW")},()=>${company("PARALLEL_FAST")}]);`);
  await until(() => parallelGate.started && rows().some(r => r.role === "user" && r.text === "PARALLEL_FAST"));
  const fastId = rows().find(r => r.text === "PARALLEL_FAST").sessionId;
  await runtime.newSession(); parent = runtime.session; sessions.push(parent);
  await parent.prompt("synthetic replacement workflow parent");
  const newParentResult = await execute(`return ${company("PARALLEL_NEW_PARENT")};`);
  assert.ok(newParentResult.details.result);
  const newParentId = requests.find(r => r.body.includes("PARALLEL_NEW_PARENT"))!.id;
  assert.ok(rows().filter(r => r.sessionId === newParentId).every(r => r.parentSessionId === parent.sessionId));
  parallelGate.release(); await parallel;
  const oldRows = rows().filter(r => r.parentSessionId === originalParent);
  assert.equal(new Set(oldRows.map(r => r.sessionId)).size, 2);
  assert.ok(oldRows.some(r => r.sessionId === fastId));
  const currentParent = parent.sessionId; assert.notEqual(currentParent, originalParent);
  const sibling = await execute(`return parallel([()=>${company("COMPANY_SIBLING")},()=>agent("PRIVATE_WORKFLOW_PROMPT",{model:"workflow-private/private",tools:[]})]);`);
  assert.equal(sibling.details.result[1], "PRIVATE_WORKFLOW_REPLY");
  await execute(`return ${company("RETRY_EMPTY")};`, { agentRetries: 1 });
  assert.equal(new Set(requests.filter(r => r.body.includes("RETRY_EMPTY")).map(r => r.id)).size, 2);
  const lateGate = gate("BACKGROUND_LATE");
  const background = await execute(`return ${company("BACKGROUND_LATE")};`, { background: true });
  await until(() => lateGate.started); const lateParent = parent.sessionId;
  await runtime.newSession(); parent = runtime.session; sessions.push(parent);
  await parent.prompt("synthetic replacement workflow parent");
  lateGate.release(); await until(() => run(background.details.runId).status === "completed");
  const lateId = requests.find(r => r.body.includes("BACKGROUND_LATE"))!.id;
  assert.ok(rows().filter(r => r.sessionId === lateId).every(r => r.parentSessionId === lateParent));
  const pauseGate = gate("RESUME_BLOCKED");
  const paused = await execute(`const cached=await ${company("RESUME_CACHED")}; return [cached,await ${company("RESUME_BLOCKED")}];`, { background: true });
  await until(() => pauseGate.started); const resumeParent = parent.sessionId;
  await command.handler(`pause ${paused.details.runId}`, parent.extensionRunner.createContext());
  pauseGate.release(); await until(() => run(paused.details.runId).status === "paused");
  await new Promise(r => setTimeout(r, 30));
  const cachedRequests = requests.filter(r => r.body.includes("RESUME_CACHED")).length;
  await runtime.newSession(); parent = runtime.session; sessions.push(parent);
  await parent.prompt("synthetic replacement workflow parent");
  await execute("", { resumeFromRunId: paused.details.runId, script: run(paused.details.runId).script });
  await until(() => run(paused.details.runId).status === "completed");
  assert.equal(requests.filter(r => r.body.includes("RESUME_CACHED")).length, cachedRequests);
  const resumeRequests = requests.filter(r => r.body.includes("RESUME_BLOCKED"));
  assert.equal(new Set(resumeRequests.map(r => r.id)).size, 2);
  for (const request of resumeRequests) assert.ok(rows().filter(r => r.sessionId === request.id).every(r => r.parentSessionId === resumeParent));
  const before = requests.length;
  bus.on("pi-monitor:workflow-observer:v1", (r: any) => r.register(async () => { throw new Error("must reject incompatible observer before prompt"); }));
  const failed = await execute(`return ${company("MUST_NOT_PROMPT")};`);
  assert.equal(failed.details.result, null); assert.equal(requests.length, before);
  assert.deepEqual(errors, []);
  assert.ok(busShapes.length > 0);
  for (const shape of busShapes) assert.deepEqual(shape, ["register", "version"]);
  assert.doesNotMatch(readFileSync(spool, "utf8"), /PRIVATE_WORKFLOW/);
  const captured = rows(); assert.equal(new Set(captured.map(r => r.id)).size, captured.length);
  for (const request of requests.filter(r => r.id !== originalParent)) assert.ok(captured.some(r => r.sessionId === request.id), "actual request session must have captured rows");
  await until(() => gw.got.records.length === captured.length);
  assert.doesNotMatch(JSON.stringify(gw.got.records), /PRIVATE_WORKFLOW/);
  writeFileSync(join(scratch, "captured-records.json"), JSON.stringify(captured, null, 2));
  const childIds = [...new Set(captured.filter(r => r.parentSessionId).map(r => r.sessionId))];
  const parentIds = [...new Set(captured.filter(r => !r.parentSessionId).map(r => r.sessionId))];
  assert.equal(captured.length, 28); assert.equal(childIds.length, 10); assert.equal(parentIds.length, 4);
  assert.ok(captured.filter(r => r.parentSessionId).every(r => parentIds.includes(r.parentSessionId)));
  writeFileSync(join(scratch, "workflow-evidence.json"), JSON.stringify({ originalParent, currentParent: parent.sessionId, parentIds, childIds,
    expected: { records: 28, sessions: 14, edges: 10, roots: 4 }, requests: requests.map(r => ({ id: r.id })), runs: [background.details.runId, paused.details.runId] }, null, 2));
  console.log("WORKFLOW_SDK_CAPTURE_OK", JSON.stringify({ scratch, originalParent, currentParent: parent.sessionId, records: captured.length, childSessions: new Set(captured.filter(r => r.parentSessionId).map(r => r.sessionId)).size }));
} finally {
  for (const value of gates.values()) value.release();
  for (const s of sessions.reverse()) { await s.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); s.dispose(); }
  proxy.close(); proxy.closeAllConnections(); gw.close();
}
