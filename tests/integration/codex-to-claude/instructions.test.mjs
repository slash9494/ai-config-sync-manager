import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  cleanupFixture,
  createIntegrationFixture,
  layCodexHome,
  layExpectedClaude,
} from "../helpers/fixture.mjs";
import { assertGolden } from "../helpers/golden.mjs";
import { extractBackupRoot, runPlanJson, runSync } from "../helpers/run-cli.mjs";
import { assertSourceUnchanged, snapshotTree } from "../helpers/snapshot.mjs";

function withFixture(scenario, body) {
  const fixture = createIntegrationFixture({ scenario });
  let kept = false;
  try {
    body(fixture);
  } catch (error) {
    if (process.env.KEEP_FIXTURE === "1") {
      kept = true;
      error.message = `${error.message}\n[fixture kept at ${fixture.root}]`;
    }
    throw error;
  } finally {
    if (!kept && process.env.KEEP_FIXTURE !== "1") {
      cleanupFixture(fixture);
    }
  }
}

function applyInstructions(fixture) {
  return runSync({
    home: fixture.home,
    projectRoot: fixture.project,
    args: [
      "--scope",
      "global",
      "--include",
      "instructions",
      "--from",
      "codex",
      "--to",
      "claude",
      "--apply",
    ],
  });
}

function walkFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let info;
    try {
      info = statSync(current);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      for (const name of readdirSync(current)) stack.push(join(current, name));
    } else if (info.isFile()) {
      out.push(current);
    }
  }
  return out;
}

test("instructions dry-run produces plan with codex->claude direction and writes nothing", () => {
  withFixture("instructions-dry-run", (fixture) => {
    layCodexHome(fixture.home, [{ area: "instructions", variant: "happy" }]);
    const beforeSnapshot = snapshotTree(fixture.home);

    const planJson = runPlanJson({
      home: fixture.home,
      projectRoot: fixture.project,
      include: ["instructions"],
    });

    assert.equal(planJson.from, "codex");
    assert.equal(planJson.to, "claude");
    assert.ok(
      Array.isArray(planJson.operations) &&
        planJson.operations.some((op) => op.area === "instructions"),
      "expected at least one instructions operation"
    );

    assertSourceUnchanged(fixture.home, beforeSnapshot);
    assert.equal(
      existsSync(join(fixture.home, ".claude", "CLAUDE.md")),
      false,
      "dry-run must not write CLAUDE.md"
    );
  });
});

test("apply copies AGENTS.md to ~/.claude/CLAUDE.md verbatim", () => {
  withFixture("instructions-apply-happy", (fixture) => {
    const specs = [{ area: "instructions", variant: "happy" }];
    layCodexHome(fixture.home, specs);
    const beforeSnapshot = snapshotTree(fixture.home);

    const result = applyInstructions(fixture);
    assert.equal(result.status, 0, `apply failed: ${result.output}`);

    layExpectedClaude(fixture.expectedHome, specs);
    assertGolden(fixture.home, fixture.expectedHome, {
      ignore: [".ai-config-sync-manager/", "backups/", ".DS_Store", ".codex/", ".agents/"],
    });
    assertSourceUnchanged(fixture.home, beforeSnapshot);
  });
});

test("multi-section preserves H2 hierarchy and fenced code blocks", () => {
  withFixture("instructions-multi-section", (fixture) => {
    const specs = [{ area: "instructions", variant: "multi-section" }];
    layCodexHome(fixture.home, specs);
    const beforeSnapshot = snapshotTree(fixture.home);

    const result = applyInstructions(fixture);
    assert.equal(result.status, 0, `apply failed: ${result.output}`);

    layExpectedClaude(fixture.expectedHome, specs);
    assertGolden(fixture.home, fixture.expectedHome, {
      ignore: [".ai-config-sync-manager/", "backups/", ".DS_Store", ".codex/", ".agents/"],
    });
    assertSourceUnchanged(fixture.home, beforeSnapshot);
  });
});

test("empty source produces no target without error", () => {
  withFixture("instructions-empty-source", (fixture) => {
    const specs = [{ area: "instructions", variant: "empty-source" }];
    layCodexHome(fixture.home, specs);
    const beforeSnapshot = snapshotTree(fixture.home);

    const result = applyInstructions(fixture);
    assert.equal(result.status, 0, `apply failed: ${result.output}`);
    assert.equal(
      existsSync(join(fixture.home, ".claude", "CLAUDE.md")),
      false,
      "empty source must not produce a CLAUDE.md"
    );
    assertSourceUnchanged(fixture.home, beforeSnapshot);
  });
});

test("second apply is idempotent and leaves source unchanged", () => {
  withFixture("instructions-idempotent", (fixture) => {
    const specs = [{ area: "instructions", variant: "happy" }];
    layCodexHome(fixture.home, specs);
    const beforeSnapshot = snapshotTree(fixture.home);

    const first = applyInstructions(fixture);
    assert.equal(first.status, 0, `first apply failed: ${first.output}`);

    const afterFirstClaude = readFileSync(join(fixture.home, ".claude", "CLAUDE.md"), "utf8");

    const second = applyInstructions(fixture);
    assert.equal(second.status, 0, `second apply failed: ${second.output}`);
    assert.match(
      second.stdout,
      /No sync operations planned\.|noop: No operations to apply/,
      "second apply should report no operations"
    );

    const afterSecondClaude = readFileSync(join(fixture.home, ".claude", "CLAUDE.md"), "utf8");
    assert.equal(afterSecondClaude, afterFirstClaude, "second apply must not change CLAUDE.md");
    assertSourceUnchanged(fixture.home, beforeSnapshot);
  });
});

test("pre-existing CLAUDE.md is backed up before overwrite", () => {
  withFixture("instructions-backup", (fixture) => {
    const specs = [{ area: "instructions", variant: "happy" }];
    layCodexHome(fixture.home, specs);

    const claudeDir = join(fixture.home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const oldContent = "OLD\n";
    writeFileSync(join(claudeDir, "CLAUDE.md"), oldContent);

    const beforeSnapshot = snapshotTree(fixture.home);
    const result = applyInstructions(fixture);
    assert.equal(result.status, 0, `apply failed: ${result.output}`);

    const backupRootDir = extractBackupRoot(result.stdout);
    assert.ok(backupRootDir, "expected Backup root in stdout");
    assert.equal(existsSync(backupRootDir), true, `backup root missing: ${backupRootDir}`);

    const backupFiles = walkFiles(backupRootDir);
    const claudeBackups = backupFiles.filter((p) =>
      p.replaceAll("\\", "/").endsWith("/.claude/CLAUDE.md")
    );
    assert.ok(
      claudeBackups.length > 0,
      `expected a backup of CLAUDE.md under ${backupRootDir}, got: ${backupFiles.join(", ")}`
    );
    const backedUp = readFileSync(claudeBackups[0], "utf8");
    assert.equal(backedUp, oldContent, "backup file must contain pre-existing content");

    const sourceContent = readFileSync(join(fixture.home, ".codex", "AGENTS.md"), "utf8");
    const currentContent = readFileSync(join(claudeDir, "CLAUDE.md"), "utf8");
    const expectedTrailing = sourceContent.endsWith("\n") ? sourceContent : `${sourceContent}\n`;
    assert.equal(currentContent, expectedTrailing, "current CLAUDE.md must match codex source");

    assertSourceUnchanged(fixture.home, beforeSnapshot);
  });
});
