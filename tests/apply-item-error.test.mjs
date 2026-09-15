import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../bin/ai-config-sync.mjs", import.meta.url));

function createHome() {
  const home = join(mkdtempSync(join(tmpdir(), "apply-item-error-")), "home");
  mkdirSync(home, { recursive: true });
  return home;
}

function writeSkill(home, name) {
  const dir = join(home, ".claude/skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: skill ${name}\n---\nbody\n`
  );
  return dir;
}

function writeAgent(home, name) {
  const path = join(home, ".claude/agents", `${name}.md`);
  mkdirSync(join(home, ".claude/agents"), { recursive: true });
  writeFileSync(path, `---\nname: ${name}\ndescription: agent ${name}\n---\nYou are ${name}.\n`);
  return path;
}

function applyGlobal(home, include) {
  const output = execFileSync(
    process.execPath,
    [
      cliPath,
      "sync",
      "--scope",
      "global",
      "--from",
      "claude",
      "--to",
      "codex",
      "--include",
      include,
      "--apply",
      "--ledger-json",
    ],
    { cwd: home, env: { ...process.env, AI_CONFIG_SYNC_HOME: home, HOME: home }, encoding: "utf8" }
  );
  const end = output.indexOf("\nAI Config Sync Manager sync");
  return JSON.parse(output.slice(0, end === -1 ? output.length : end));
}

test("skills sync apply records one unreadable skill as its own error and still copies the skills after it", () => {
  const home = createHome();
  writeSkill(home, "aa");
  symlinkSync("/nonexistent/target", join(writeSkill(home, "bb"), "dangling"));
  writeSkill(home, "cc");

  const ledger = applyGlobal(home, "skills");
  const byItem = Object.fromEntries(ledger.items.map((item) => [item.item, item.status]));

  assert.deepEqual(byItem, { aa: "applied", bb: "error", cc: "applied" });
  assert.equal(ledger.summary.error, 1);
  const cc = ledger.items.find((item) => item.item === "cc");
  assert.match(cc.after_hash, /^sha256:[0-9a-f]{64}$/);
});

test("skills sync apply removes the half-copied skill so the next apply retries it instead of skipping it", () => {
  const home = createHome();
  writeSkill(home, "aa");
  const bb = writeSkill(home, "bb");
  symlinkSync("/nonexistent/target", join(bb, "zz-dangling"));

  applyGlobal(home, "skills");
  // Positive control first: a skill that copies lands here, so the absence below is not a wrong path.
  assert.ok(existsSync(join(home, ".agents/skills/aa/SKILL.md")));
  assert.equal(existsSync(join(home, ".agents/skills/bb")), false);

  execFileSync("rm", [join(bb, "zz-dangling")]);
  const retry = applyGlobal(home, "skills");
  assert.deepEqual(
    retry.items.map((item) => [item.item, item.status]),
    [["bb", "applied"]]
  );
});

test("agents sync apply records each unwritable agent under its own name, never one line for the whole area", (t) => {
  if (process.getuid?.() === 0)
    t.skip("root writes into a mode-555 directory, so the fault cannot be staged");
  const home = createHome();
  writeAgent(home, "aa");
  writeAgent(home, "bb");
  const target = join(home, ".codex/agents");
  mkdirSync(target, { recursive: true });
  chmodSync(target, 0o555);
  let ledger;
  try {
    ledger = applyGlobal(home, "agents");
  } finally {
    chmodSync(target, 0o755);
  }

  assert.deepEqual(
    ledger.items.map((item) => [item.item, item.status]),
    [
      ["aa", "error"],
      ["bb", "error"],
    ]
  );
});
