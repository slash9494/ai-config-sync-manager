import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  cleanupFixture,
  createIntegrationFixture,
  layCodexHome,
  layExpectedClaude,
  layPreExistingClaude,
} from "../helpers/fixture.mjs";
import { assertGolden } from "../helpers/golden.mjs";
import { extractBackupRoot, runPlanJson, runSync } from "../helpers/run-cli.mjs";
import { scanClaudeSkills } from "../helpers/readers.mjs";
import { assertSourceUnchanged, snapshotTree } from "../helpers/snapshot.mjs";

const GOLDEN_IGNORE = [".ai-config-sync-manager/", "backups/", ".DS_Store", ".codex/", ".agents/"];

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

function applySkills(fixture) {
  return runSync({
    home: fixture.home,
    projectRoot: fixture.project,
    args: [
      "--scope",
      "global",
      "--include",
      "skills",
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

test("apply copies SKILL.md frontmatter intact (golden)", () => {
  withFixture("skills-apply-happy", (fixture) => {
    const specs = [{ area: "skills", variant: "happy" }];
    layCodexHome(fixture.home, specs);
    const beforeSnapshot = snapshotTree(fixture.home);

    const result = applySkills(fixture);
    assert.equal(result.status, 0, `apply failed: ${result.output}`);

    layExpectedClaude(fixture.expectedHome, specs);
    assertGolden(fixture.home, fixture.expectedHome, { ignore: GOLDEN_IGNORE });
    assertSourceUnchanged(fixture.home, beforeSnapshot);
  });
});

test("symlinked skill is unsupported and not copied to target", () => {
  withFixture("skills-symlink-unsupported", (fixture) => {
    const specs = [{ area: "skills", variant: "symlink-unsupported" }];
    layCodexHome(fixture.home, specs);
    const beforeSnapshot = snapshotTree(fixture.home);

    const result = applySkills(fixture);
    assert.equal(result.status, 0, `apply failed: ${result.output}`);

    const skillsDir = join(fixture.home, ".claude", "skills");
    assert.equal(
      existsSync(join(skillsDir, "hello", "SKILL.md")),
      true,
      "expected hello skill copied to claude target"
    );
    assert.equal(
      existsSync(join(skillsDir, "aliased")),
      false,
      "symlinked aliased skill must not be copied to claude target"
    );

    assertSourceUnchanged(fixture.home, beforeSnapshot);
  });
});

test("manual-overwrite replaces existing claude skill body and backs up", () => {
  withFixture("skills-manual-overwrite", (fixture) => {
    const specs = [{ area: "skills", variant: "manual-overwrite" }];
    layCodexHome(fixture.home, specs);
    layPreExistingClaude(fixture.home, specs);

    const preClaudeSkillPath = join(fixture.home, ".claude", "skills", "hello", "SKILL.md");
    const oldClaudeSkill = readFileSync(preClaudeSkillPath, "utf8");
    assert.match(oldClaudeSkill, /OLD BODY on claude side/);

    const planJson = runPlanJson({
      home: fixture.home,
      projectRoot: fixture.project,
      include: ["skills"],
    });
    const skillOps = planJson.operations.filter((op) => op.area === "skills");
    assert.ok(skillOps.length > 0, "expected at least one skills operation in plan");
    assert.ok(
      skillOps.some((op) => op.risk === "manual"),
      `expected risk=manual for overwrite plan, got: ${JSON.stringify(skillOps.map((op) => op.risk))}`
    );

    const beforeSnapshot = snapshotTree(fixture.home);
    const result = applySkills(fixture);
    assert.equal(result.status, 0, `apply failed: ${result.output}`);

    const targetSkillDir = join(fixture.home, ".claude", "skills", "hello");
    const newSkillFile = readdirSync(targetSkillDir).find((n) => n.toLowerCase() === "skill.md");
    assert.ok(newSkillFile, `expected SKILL.md/skill.md after apply in ${targetSkillDir}`);
    const newBody = readFileSync(join(targetSkillDir, newSkillFile), "utf8");
    assert.match(newBody, /NEW BODY from codex side/);
    assert.doesNotMatch(newBody, /OLD BODY on claude side/);

    const backupRootDir = extractBackupRoot(result.stdout);
    assert.ok(backupRootDir, "expected Backup root in stdout");
    assert.equal(existsSync(backupRootDir), true, `backup root missing: ${backupRootDir}`);

    const backupFiles = walkFiles(backupRootDir);
    const backedUpSkill = backupFiles.find((p) =>
      /\/\.claude\/skills\/hello\/skill\.md$/i.test(p.replaceAll("\\", "/"))
    );
    assert.ok(backedUpSkill, `expected backup of hello SKILL.md, got: ${backupFiles.join(", ")}`);
    assert.equal(
      readFileSync(backedUpSkill, "utf8"),
      oldClaudeSkill,
      "backup must contain pre-existing claude content"
    );

    assertSourceUnchanged(fixture.home, beforeSnapshot);
  });
});

test("scan after apply matches codex source skill set", () => {
  withFixture("skills-scan-after-apply", (fixture) => {
    const specs = [{ area: "skills", variant: "happy" }];
    layCodexHome(fixture.home, specs);

    const result = applySkills(fixture);
    assert.equal(result.status, 0, `apply failed: ${result.output}`);

    const scanned = scanClaudeSkills(fixture.home);
    assert.deepEqual(
      [...scanned.keys()].sort(),
      ["hello"],
      `unexpected skill set after apply: ${[...scanned.keys()].join(", ")}`
    );
    const hello = scanned.get("hello");
    assert.equal(hello.frontmatter.name, "hello");
  });
});

test("second apply is idempotent", () => {
  withFixture("skills-idempotent", (fixture) => {
    const specs = [{ area: "skills", variant: "happy" }];
    layCodexHome(fixture.home, specs);

    const first = applySkills(fixture);
    assert.equal(first.status, 0, `first apply failed: ${first.output}`);

    const afterFirst = snapshotTree(join(fixture.home, ".claude"));

    const second = applySkills(fixture);
    assert.equal(second.status, 0, `second apply failed: ${second.output}`);

    const afterSecond = snapshotTree(join(fixture.home, ".claude"));
    assert.equal(
      afterSecond.size,
      afterFirst.size,
      "claude tree size changed between first and second apply"
    );
    for (const [path, entry] of afterFirst) {
      const next = afterSecond.get(path);
      assert.ok(next, `path ${path} disappeared on second apply`);
      assert.equal(next.sha256, entry.sha256, `path ${path} content changed on second apply`);
    }
  });
});
