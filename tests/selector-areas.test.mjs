import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../bin/ai-config-sync.mjs", import.meta.url));

function runSync(args) {
  const home = join(mkdtempSync(join(tmpdir(), "selector-areas-")), "home");
  mkdirSync(join(home, ".claude/commands"), { recursive: true });
  writeFileSync(join(home, ".claude/commands/deploy.md"), "Deploy the app.\n");
  return spawnSync(process.execPath, [cliPath, "sync", "--scope", "global", ...args], {
    cwd: home,
    env: { ...process.env, AI_CONFIG_SYNC_HOME: home, HOME: home },
    encoding: "utf8",
  });
}

test("sync refuses --include commands instead of planning an empty result that reads as in sync", () => {
  const result = runSync(["--include", "commands", "--plan-json"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /Area "commands" is not implemented/);
  assert.doesNotMatch(result.stdout, /"operations"/);
});

test("sync refuses an unknown area selector and names the areas it accepts", () => {
  const result = runSync(["--exclude", "skils:typo", "--dry-run"]);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr + result.stdout,
    /Unknown area: skils\. Use one of: instructions, skills/
  );
});

test("sync still accepts every implemented area selector", () => {
  const result = runSync([
    "--include",
    "instructions,skills,agents,mcp,permissions,hooks,plugins",
    "--plan-json",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(Array.isArray(JSON.parse(result.stdout).operations));
});
