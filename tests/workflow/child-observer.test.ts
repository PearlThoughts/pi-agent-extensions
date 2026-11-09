import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AttachChild } from "../../extensions/workflow/child-observer.js";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createWorkflowTool, WorkflowManager } from "../../extensions/workflow/runtime.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function harness(t: any, observer?: AttachChild) {
  const root = mkdtempSync(join(tmpdir(), "workflow-observer-"));
  const agentDir = join(root, "agent"); mkdirSync(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(root, { recursive: true, force: true }); });
  const faux = createFauxCore({ provider: "workflow-test", models: [{ id: "test", reasoning: true }] });
  const model = faux.getModel();
  const config = { api: faux.api, apiKey: "synthetic", models: [model], streamSimple: faux.streamSimple };
  const manager = new WorkflowManager({ cwd: root, runsDir: join(root, "runs"), childObserver: observer });
  manager.on("error", () => {});
  manager.setModelRegistry({ getRegisteredProviderIds: () => [model.provider], getRegisteredProviderConfig: () => config } as any);
  const parent = SessionManager.inMemory(root);
  manager.setSessionId(parent.getSessionId());
  const tool = createWorkflowTool({ manager });
  const execute = (script: string, options: any = {}, signal?: AbortSignal) => (tool.execute as any)("tool-call", { script, background: false, ...options }, signal, undefined, { sessionManager: parent });
  return { manager, parent, faux, model, execute, root };
}

const script = (body: string) => `export const meta = {name:"capture",description:"synthetic capture"}; ${body}`;
const call = (prompt: string) => `agent(${JSON.stringify(prompt)}, {model:"workflow-test/test:high",tools:["read","bash"],disallowedTools:["bash"]})`;

test("public workflow tool observes actual parallel SDK children before prompting with immutable parent ancestry", async (t) => {
  const seen: any[] = [], disposed: string[] = [];
  const h = await harness(t, async (session: any, origin: any) => {
    assert.equal(session.messages.length, 0, "observer attaches before the first user prompt");
    assert.equal(session.resourceLoader.getExtensions().extensions.length, 0, "SDK children keep noExtensions");
    assert.equal(session.sessionId, session.sessionManager.getSessionId());
    assert.equal(session.model.provider, "workflow-test");
    assert.equal(session.thinkingLevel, "high");
    assert.deepEqual(session.getActiveToolNames(), ["read"]);
    seen.push({ session, origin });
    return { async dispose() { disposed.push(session.sessionId); } };
  });
  const first = deferred(), second = deferred(), started = deferred();
  let calls = 0;
  h.faux.setResponses([async () => { if (++calls === 2) started.resolve(); await first.promise; return fauxAssistantMessage("first"); }, async () => { if (++calls === 2) started.resolve(); await second.promise; return fauxAssistantMessage("second"); }]);
  const result = h.execute(script(`return parallel([()=>${call("one")},()=>${call("two")}]);`));
  await started.promise;
  h.manager.setSessionId(SessionManager.inMemory(h.root).getSessionId());
  second.resolve(); first.resolve();
  assert.deepEqual((await result).details.result, ["first", "second"]);
  assert.equal(seen.length, 2, "both actual SDK children must be observed");
  assert.equal(new Set(seen.map(x => x.session.sessionId)).size, 2);
  assert.ok(seen.every(x => x.origin.parentSessionId === h.parent.getSessionId()));
  assert.ok(seen.every(x => x.origin.version === 1 && x.origin.producer === "workflow"));
  assert.equal(new Set(seen.map(x => x.origin.callId)).size, 2);
  assert.equal(disposed.length, 2);
});

test("missing observer keeps SDK results and explicit routing unchanged", async (t) => {
  const h = await harness(t);
  h.faux.setResponses([fauxAssistantMessage("unchanged")]);
  assert.equal((await h.execute(script(`return ${call("normal")};`))).details.result, "unchanged");
});

test("invocation parent is captured before asynchronous approval", async (t) => {
  const seen: any[] = [];
  const h = await harness(t, async (_session: any, origin: any) => { seen.push(origin); return { async dispose() {} }; });
  const approved = deferred(), waiting = deferred();
  const tool = createWorkflowTool({ manager: h.manager, beforeExecute: async (input: any) => { waiting.resolve(); await approved.promise; return input; } } as any);
  let current = h.parent.getSessionId();
  h.faux.setResponses([fauxAssistantMessage("approved")]);
  const result = (tool.execute as any)("approval", { script: script(`return ${call("work")};`), background: false }, undefined, undefined, { sessionManager: { getSessionId: () => current } });
  await waiting.promise;
  current = SessionManager.inMemory(h.root).getSessionId(); h.manager.setSessionId(current);
  approved.resolve(); await result;
  assert.equal(seen[0].parentSessionId, h.parent.getSessionId());
});

test("observer startup failure prevents child prompts and inference", async (t) => {
  let session: any;
  const h = await harness(t, async (child: any) => { session = child; throw new Error("capture unavailable"); });
  h.faux.setResponses([fauxAssistantMessage("must not run")]);
  const result = await h.execute(script(`return ${call("startup")};`));
  assert.equal(result.details.result, null, "retain upstream failed-agent result semantics");
  assert.match(h.manager.listRuns()[0].agents[0].error!, /capture unavailable/);
  assert.equal(h.faux.state.callCount, 0);
  assert.equal(session.messages.length, 0);
});

test("cancellation during observer startup drains the lease before any prompt", async (t) => {
  const waiting = deferred(), release = deferred(); let disposed = false;
  const h = await harness(t, async () => { waiting.resolve(); await release.promise; return { async dispose() { disposed = true; } }; });
  const controller = new AbortController();
  const result = h.execute(script(`return ${call("cancelled")};`), {}, controller.signal);
  await waiting.promise; controller.abort(new Error("cancelled")); release.resolve();
  await assert.rejects(result, /cancelled/);
  assert.equal(h.faux.state.callCount, 0);
  assert.equal(disposed, true);
});

test("failed inference retries with a distinct actual SDK child and lease", async (t) => {
  const seen: any[] = [], disposed: string[] = [];
  const h = await harness(t, async (session: any, origin: any) => { seen.push({ id: session.sessionId, origin }); return { async dispose() { disposed.push(session.sessionId); } }; });
  h.faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "synthetic denial" }), fauxAssistantMessage("retried")]);
  const result = await h.execute(script(`return ${call("retry")};`), { agentRetries: 1 });
  assert.equal(result.details.result, "retried");
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].id, seen[1].id);
  assert.notEqual(seen[0].origin.attemptId, seen[1].origin.attemptId);
  assert.equal(seen[0].origin.callId, seen[1].origin.callId);
  assert.ok(seen.every(x => x.origin.parentSessionId === h.parent.getSessionId()));
  assert.deepEqual(disposed, seen.map(x => x.id));
});

test("paused workflow resumes cached steps without children and preserves original ancestry", async (t) => {
  const seen: any[] = [], waiting = deferred(), release = deferred();
  const h = await harness(t, async (session: any, origin: any) => { seen.push({ id: session.sessionId, origin }); return { async dispose() {} }; });
  h.faux.setResponses([fauxAssistantMessage("cached"), async () => { waiting.resolve(); await release.promise; return fauxAssistantMessage("interrupted"); }, fauxAssistantMessage("resumed")]);
  const result = await h.execute(script(`const first=await ${call("first")}; return [first,await ${call("second")}];`), { background: true });
  const runId = result.details.runId;
  await waiting.promise; h.manager.pause(runId); release.resolve();
  // A paused run's current promise is intentionally consumed by the background tool.
  for (let i = 0; h.manager.getRun(runId)?.journal.length !== 1 && i < 100; i++) await new Promise(r => setTimeout(r, 2));
  await new Promise(r => setImmediate(r));
  h.manager.setSessionId(SessionManager.inMemory(h.root).getSessionId());
  const completed = new Promise<void>(r => h.manager.once("complete", () => r()));
  await h.execute("", { resumeFromRunId: runId }); await completed;
  assert.equal(seen.length, 3, "resume creates only the uncached child");
  assert.equal(new Set(seen.map(x => x.id)).size, 3);
  assert.ok(seen.every(x => x.origin.parentSessionId === h.parent.getSessionId()));
  assert.equal(JSON.stringify(h.manager.getRun(runId)?.result?.result), JSON.stringify(["cached", "resumed"]));
});

test("a stalled observer drain is bounded and cannot hold a successful workflow open", { timeout: 3500 }, async (t) => {
  const h = await harness(t, async () => ({ dispose: () => new Promise<void>(() => {}) }));
  h.faux.setResponses([fauxAssistantMessage("finished")]);
  assert.equal((await h.execute(script(`return ${call("bounded")};`))).details.result, "finished");
});

test("observer drain failure keeps successful inference results", async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => warnings.push(args));
  const h = await harness(t, async () => ({ async dispose() { throw new Error("synthetic upload failure"); } }));
  h.faux.setResponses([fauxAssistantMessage("delivered")]);
  assert.equal((await h.execute(script(`return ${call("delivery")};`))).details.result, "delivered");
  assert.equal(warnings.length, 1, "drain failure is reported without discarding inference");
});

test("an invocation cancelled before dispatch never starts child inference", async (t) => {
  const h = await harness(t);
  h.faux.setResponses([fauxAssistantMessage("must not run")]);
  const controller = new AbortController(); controller.abort(new Error("already cancelled"));
  await assert.rejects(h.execute(script(`return ${call("pre-cancelled")};`), {}, controller.signal), /already cancelled/);
  assert.equal(h.faux.state.callCount, 0);
});
