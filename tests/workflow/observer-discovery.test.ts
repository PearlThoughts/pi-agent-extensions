import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { discoverChildObserver } from "../../extensions/workflow/child-observer.js";

test("lazy SDK bus discovery carries only version and callback registration", () => {
  const bus = createEventBus();
  assert.equal(discoverChildObserver(bus), undefined);
  const attach = async () => ({ async dispose() {} });
  bus.on("pi-monitor:workflow-observer:v1", (request: any) => {
    assert.deepEqual(Object.keys(request).sort(), ["register", "version"]);
    assert.equal(request.version, 1); request.register(attach);
  });
  assert.equal(discoverChildObserver(bus), attach);
  bus.on("pi-monitor:workflow-observer:v1", (request: any) => request.register(attach));
  assert.equal(discoverChildObserver(bus), attach);
  bus.on("pi-monitor:workflow-observer:v1", (request: any) => request.register(async () => ({ async dispose() {} })));
  assert.throws(() => discoverChildObserver(bus), /Incompatible/);
});
