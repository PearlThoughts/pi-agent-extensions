import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("installed SDK runs the managed workflow producer through monitor capture and local HTTP", {
  skip: process.env.PI_COMPAT !== "1" && "set PI_COMPAT=1, PI_PKG and PI_MONITOR_SOURCE for synthetic installed-SDK integration", timeout: 60000,
}, async () => {
  assert.ok(process.env.PI_PKG); assert.ok(process.env.PI_MONITOR_SOURCE);
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/sdk-integration.ts", import.meta.url))], { env: process.env, timeout: 50000, maxBuffer: 2 * 1024 * 1024 });
  assert.match(stdout, /WORKFLOW_SDK_CAPTURE_OK/); console.log(stdout.trim());
});
