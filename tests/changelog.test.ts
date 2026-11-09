import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

function fixture(t: any, version: string, sections: string) {
  const root = mkdtempSync(join(tmpdir(), "workflow-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packagePath = join(root, "package.json"), changelogPath = join(root, "CHANGELOG.md");
  writeFileSync(packagePath, JSON.stringify({ version }));
  writeFileSync(changelogPath, `# Changelog\n\n## [Unreleased]\n\nCompatibility capture.\n\n${sections}`);
  const env = { ...process.env, PACKAGE_JSON_PATH: packagePath, CHANGELOG_PATH: changelogPath };
  const cli = resolve("scripts/changelog.mjs");
  return { env, cli, changelogPath };
}

test("changelog CLI promotes and validates compatibility prereleases in numeric order", (t) => {
  const f = fixture(t, "0.5.6-pt.10", "## [0.5.6-pt.2] - 2026-11-08\n\nOlder compatibility.\n\n## [0.5.5] - 2026-10-14\n\nOriginal.\n");
  execFileSync(process.execPath, [f.cli, "promote", "0.5.6-pt.10"], { env: f.env });
  execFileSync(process.execPath, [f.cli, "check"], { env: f.env });
  assert.match(readFileSync(f.changelogPath, "utf8"), /## \[0\.5\.6-pt\.10\] - \d{4}-\d{2}-\d{2}/);
  writeFileSync(f.changelogPath, readFileSync(f.changelogPath, "utf8").replace("0.5.6-pt.10", "0.5.6-pt.1"));
  const invalid = spawnSync(process.execPath, [f.cli, "check", "0.5.6-pt.1"], { env: f.env, encoding: "utf8" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /newest-first/);
});

test("changelog CLI keeps stable release validation and rejects duplicate or malformed versions", (t) => {
  const f = fixture(t, "0.5.6", "## [0.5.6] - 2026-11-09\n\nStable.\n\n## [0.5.6-pt.1] - 2026-11-08\n\nCompatibility.\n");
  execFileSync(process.execPath, [f.cli, "check"], { env: f.env });
  assert.notEqual(spawnSync(process.execPath, [f.cli, "check", "0.5.6-"], { env: f.env }).status, 0);
  writeFileSync(f.changelogPath, readFileSync(f.changelogPath, "utf8") + "\n## [0.5.6] - 2026-11-07\n\nDuplicate.\n");
  assert.notEqual(spawnSync(process.execPath, [f.cli, "check"], { env: f.env }).status, 0);
});
