import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../bin/ai-config-sync.mjs", import.meta.url));

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "ledger-test-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  return { root, home, project };
}

function runCli(fixture, args, extraEnv = {}) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: fixture.project,
    env: { ...process.env, AI_CONFIG_SYNC_HOME: fixture.home, ...extraEnv },
    encoding: "utf8",
  });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeCodexMcp(fixture, name) {
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    [`[mcp_servers.${name}]`, 'command = "npx"', `args = ["${name}-mcp"]`, ""].join("\n")
  );
}

// Returns only the ledger JSON; runCli mixes it with the human-readable banner on stdout.
function applyWithLedgerJson(fixture, includeArg, extraEnv = {}) {
  const output = runCli(
    fixture,
    ["sync", "--scope", "project", "--include", includeArg, "--apply", "--ledger-json"],
    extraEnv
  );
  const end = output.indexOf("\nAI Config Sync Manager sync");
  return JSON.parse(output.slice(0, end === -1 ? output.length : end));
}

const SHA256 = /^sha256:[0-9a-f]{64}$/;

test("sync apply ledger emits the frozen JSON shape with plan_hash, mode, scope, and summary", () => {
  const fixture = createFixture();
  writeCodexMcp(fixture, "notion");

  const ledger = applyWithLedgerJson(fixture, "mcp:notion", { AI_CONFIG_SYNC_HOST: "codex" });

  assert.match(ledger.plan_hash, SHA256);
  assert.equal(ledger.mode, "apply");
  assert.equal(ledger.scope, "project");
  assert.equal(ledger.writes_started, true);
  assert.ok(Array.isArray(ledger.items));
  assert.deepEqual(Object.keys(ledger.summary).sort(), ["applied", "error", "noop", "skipped"]);
});

test("sync apply ledger records a per-item entry with null before-hash for an absent target", () => {
  const fixture = createFixture();
  writeCodexMcp(fixture, "notion");

  const ledger = applyWithLedgerJson(fixture, "mcp:notion", { AI_CONFIG_SYNC_HOST: "codex" });

  assert.equal(ledger.items.length, 1);
  const item = ledger.items[0];
  assert.equal(item.scope, "project");
  assert.equal(item.area, "mcp");
  assert.equal(item.item, "notion");
  assert.equal(item.action, "merge-mcp-servers");
  assert.equal(item.status, "applied");
  assert.equal(item.before_hash, null);
  assert.match(item.after_hash, SHA256);
  assert.deepEqual(ledger.summary, { applied: 1, skipped: 0, error: 0, noop: 0 });
});

test("sync apply ledger records before-hash and backup_path when overwriting an existing target", () => {
  const fixture = createFixture();
  writeCodexMcp(fixture, "notion");
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: { existing: { type: "stdio", command: "old", args: [] } },
  });

  const ledger = applyWithLedgerJson(fixture, "mcp:notion", { AI_CONFIG_SYNC_HOST: "codex" });
  const item = ledger.items.find((entry) => entry.item === "notion");

  assert.match(item.before_hash, SHA256);
  assert.match(item.after_hash, SHA256);
  assert.notEqual(item.before_hash, item.after_hash);
  assert.ok(item.backup_path && isAbsolute(item.backup_path));
  assert.equal(existsSync(item.backup_path), true, `backup path missing: ${item.backup_path}`);
});

test("sync apply backs up project instructions when the project path is absolute", () => {
  const fixture = createFixture();
  writeFileSync(join(fixture.project, "CLAUDE.md"), "Claude instructions\n");
  writeFileSync(join(fixture.project, "AGENTS.md"), "Codex instructions\n");

  const ledger = applyWithLedgerJson(fixture, "instructions");
  const item = ledger.items.find((entry) => entry.area === "instructions");

  assert.ok(item, "expected an instructions ledger entry");
  assert.equal(item.action, "write-instructions");
  assert.equal(item.status, "applied");
  assert.match(item.before_hash, SHA256);
  assert.match(item.after_hash, SHA256);
  assert.equal(ledger.summary.error, 0);
  assert.equal(ledger.summary.applied, 1);
  assert.equal(existsSync(item.backup_path), true, `backup path missing: ${item.backup_path}`);
  assert.equal(readFileSync(join(fixture.project, "AGENTS.md"), "utf8"), "Claude instructions\n");
});

test("sync apply ledger hashes a copied skill directory as a tree hash", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/skills/review"), { recursive: true });
  writeFileSync(
    join(fixture.project, ".claude/skills/review/SKILL.md"),
    "---\nname: review\n---\n# Review\n\nBody.\n"
  );

  const ledger = applyWithLedgerJson(fixture, "skills:review");
  const item = ledger.items.find((entry) => entry.item === "review");

  assert.equal(item.area, "skills");
  assert.equal(item.action, "copy-missing-skills");
  assert.equal(item.status, "applied");
  assert.equal(item.before_hash, null);
  assert.match(item.after_hash, SHA256);
  assert.deepEqual(ledger.summary, { applied: 1, skipped: 0, error: 0, noop: 0 });
});

test("sync apply ledger records a merged agent file per item", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/agents"), { recursive: true });
  writeFileSync(
    join(fixture.project, ".claude/agents/helper.md"),
    "---\nname: helper\ndescription: helps\n---\nBody.\n"
  );

  const ledger = applyWithLedgerJson(fixture, "agents:helper");
  const item = ledger.items.find((entry) => entry.item === "helper");

  assert.equal(item.area, "agents");
  assert.equal(item.action, "merge-agents");
  assert.equal(item.status, "applied");
  assert.match(item.after_hash, SHA256);
});

test("apply ledger records vocab-fix rewrites", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/agents"), { recursive: true });
  // exec_command is a Codex-only token; in a Claude file it is auto-rewritten to Bash and logged as a vocab-fix.
  writeFileSync(
    join(fixture.project, ".claude/agents/helper.md"),
    "---\nname: helper\ndescription: helps\n---\nUse exec_command to run shell commands.\n"
  );

  const ledger = applyWithLedgerJson(fixture, "agents:helper");
  const item = ledger.items.find((entry) => entry.area === "vocab");

  assert.ok(item, "expected a vocab ledger entry");
  assert.equal(item.action, "vocab-fix");
  assert.equal(item.status, "applied");
  assert.ok(item.after_hash);
  assert.match(item.after_hash, SHA256);
});

test("sync apply ledger records merged permission items", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: ["Bash"] },
  });

  const ledger = applyWithLedgerJson(fixture, "permissions:Bash");
  const item = ledger.items.find((entry) => entry.area === "permissions");

  assert.ok(item, "expected a permissions ledger entry");
  assert.equal(item.action, "merge-settings-items");
  assert.equal(item.status, "applied");
  assert.equal(ledger.summary.applied >= 1, true);
});

test("sync apply ledger reports noop summary when nothing needs applying", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });

  const ledger = applyWithLedgerJson(fixture, "mcp");

  assert.equal(ledger.writes_started, true);
  assert.deepEqual(ledger.items, []);
  assert.deepEqual(ledger.summary, { applied: 0, skipped: 0, error: 0, noop: 0 });
});

test("sync ledger flags are a no-op in dry-run mode", () => {
  const fixture = createFixture();
  writeCodexMcp(fixture, "notion");

  const output = runCli(
    fixture,
    ["sync", "--scope", "project", "--include", "mcp:notion", "--ledger-json"],
    { AI_CONFIG_SYNC_HOST: "codex" }
  );

  assert.ok(output.startsWith("AI Config Sync Manager sync"));
  assert.doesNotMatch(output, /"plan_hash"/);
});

test("sync --ledger <path> writes the ledger JSON to disk without printing it", () => {
  const fixture = createFixture();
  writeCodexMcp(fixture, "notion");
  const ledgerPath = join(fixture.root, "ledger.json");

  const output = runCli(
    fixture,
    ["sync", "--scope", "project", "--include", "mcp:notion", "--apply", "--ledger", ledgerPath],
    { AI_CONFIG_SYNC_HOST: "codex" }
  );

  assert.doesNotMatch(output, /"plan_hash"/);
  const written = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.match(written.plan_hash, SHA256);
  assert.deepEqual(written.summary, { applied: 1, skipped: 0, error: 0, noop: 0 });
});

test("sync apply ledger marks writes_started and records an error item on a forced write failure", () => {
  const fixture = createFixture();
  writeCodexMcp(fixture, "notion");
  // Make the Claude MCP target file read-only so the merge write throws mid-apply.
  const mcpTarget = join(fixture.project, ".mcp.json");
  writeJson(mcpTarget, { mcpServers: {} });
  chmodSync(mcpTarget, 0o444);

  try {
    const ledger = applyWithLedgerJson(fixture, "mcp:notion", { AI_CONFIG_SYNC_HOST: "codex" });
    assert.equal(ledger.writes_started, true);
    const errored = ledger.items.find((entry) => entry.status === "error");
    assert.ok(errored, "expected an error ledger entry");
    assert.equal(errored.area, "mcp");
    assert.equal(ledger.summary.error >= 1, true);
  } finally {
    chmodSync(mcpTarget, 0o644);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function writeSkill(fixture, name) {
  mkdirSync(join(fixture.project, `.claude/skills/${name}`), { recursive: true });
  writeFileSync(
    join(fixture.project, `.claude/skills/${name}/SKILL.md`),
    `---\nname: ${name}\n---\n# Review\n\nBody.\n`
  );
}

test("sync apply writes the default-on ledger file named after the backup timestamp", () => {
  const fixture = createFixture();
  writeSkill(fixture, "review");

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:review", "--apply"]);

  const ledgerDir = join(fixture.home, ".ai-config-sync-manager/ledgers");
  const ledgerFiles = readdirSync(ledgerDir);
  assert.equal(ledgerFiles.length, 1);

  const timestamp = ledgerFiles[0].replace(/\.json$/, "");
  const backupDirs = readdirSync(join(fixture.home, ".ai-config-sync-manager/backups"));
  assert.ok(backupDirs.includes(timestamp));

  const ledger = JSON.parse(readFileSync(join(ledgerDir, ledgerFiles[0]), "utf8"));
  assert.equal(ledger.mode, "apply");
  assert.match(ledger.plan_hash, SHA256);
  const item = ledger.items.find((entry) => entry.item === "review");
  assert.ok(item, "expected a review ledger entry");
  assert.equal(item.status, "applied");
  assert.match(item.after_hash, SHA256);
});

test("sync dry-run does not write the default-on ledger file", () => {
  const fixture = createFixture();
  writeSkill(fixture, "review");

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:review"]);

  const ledgerDir = join(fixture.home, ".ai-config-sync-manager/ledgers");
  assert.equal(existsSync(ledgerDir) && readdirSync(ledgerDir).length > 0, false);
});
