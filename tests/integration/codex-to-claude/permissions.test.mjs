import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  cleanupFixture,
  createIntegrationFixture,
  layCodexHome,
  layExpectedClaude,
} from "../helpers/fixture.mjs";
import { assertGolden } from "../helpers/golden.mjs";
import { runPlanJson, runSync } from "../helpers/run-cli.mjs";
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

function applyPermissions(fixture, env = {}) {
  return runSync({
    home: fixture.home,
    projectRoot: fixture.project,
    args: [
      "--scope",
      "global",
      "--include",
      "permissions",
      "--from",
      "codex",
      "--to",
      "claude",
      "--apply",
    ],
    env,
  });
}

test("manual-allow: codex sandbox+web_search becomes claude permissions.allow (golden)", () => {
  withFixture("permissions-manual-allow", (fixture) => {
    const specs = [{ area: "permissions", variant: "manual-allow" }];
    layCodexHome(fixture.home, specs);
    const beforeSnapshot = snapshotTree(fixture.home);

    const result = applyPermissions(fixture);
    assert.equal(result.status, 0, `apply failed: ${result.output}`);

    layExpectedClaude(fixture.expectedHome, specs);
    assertGolden(fixture.home, fixture.expectedHome, { ignore: GOLDEN_IGNORE });
    assertSourceUnchanged(fixture.home, beforeSnapshot);
  });
});

test("plan json marks permissions area as manual risk", () => {
  withFixture("permissions-plan-manual-risk", (fixture) => {
    const specs = [{ area: "permissions", variant: "manual-allow" }];
    layCodexHome(fixture.home, specs);

    const planJson = runPlanJson({
      home: fixture.home,
      projectRoot: fixture.project,
      include: ["permissions"],
    });

    const planText = JSON.stringify(planJson);
    assert.ok(
      planText.includes('"permissions"'),
      `expected plan to reference permissions area: ${planText}`
    );
    assert.ok(
      planText.includes("manual"),
      `expected plan to mark permissions area as manual risk: ${planText}`
    );
  });
});

test("second apply is idempotent", () => {
  withFixture("permissions-idempotent", (fixture) => {
    const specs = [{ area: "permissions", variant: "manual-allow" }];
    layCodexHome(fixture.home, specs);

    const first = applyPermissions(fixture);
    assert.equal(first.status, 0, `first apply failed: ${first.output}`);

    const settingsPath = join(fixture.home, ".claude", "settings.json");
    const afterFirst = JSON.parse(readFileSync(settingsPath, "utf8"));
    const firstAllow = (afterFirst.permissions && afterFirst.permissions.allow) || [];

    const second = applyPermissions(fixture);
    assert.equal(second.status, 0, `second apply failed: ${second.output}`);

    const afterSecond = JSON.parse(readFileSync(settingsPath, "utf8"));
    const secondAllow = (afterSecond.permissions && afterSecond.permissions.allow) || [];
    assert.equal(
      secondAllow.length,
      firstAllow.length,
      `permissions.allow length must not grow: first=${JSON.stringify(firstAllow)} second=${JSON.stringify(secondAllow)}`
    );
  });
});

function layCodexManagedRule(fixture, ruleLine) {
  mkdirSync(join(fixture.home, ".codex", "rules"), { recursive: true });
  writeFileSync(join(fixture.home, ".codex", "config.toml"), "");
  writeFileSync(
    join(fixture.home, ".codex", "rules", "default.rules"),
    `# BEGIN ai-config-sync permissions-rules\n${ruleLine}\n# END ai-config-sync permissions-rules\n`
  );
}

function readClaudeDeny(fixture) {
  const settings = JSON.parse(readFileSync(join(fixture.home, ".claude", "settings.json"), "utf8"));
  return (settings.permissions && settings.permissions.deny) || [];
}

test("codex to claude permissions sync restores a deny rule cut at its wildcard from its justification", () => {
  withFixture("permissions-justification-restore", (fixture) => {
    layCodexManagedRule(
      fixture,
      'prefix_rule(pattern=["git","push"], decision="forbidden", justification="Migrated from Claude deny permission Bash(git push:* --force).")'
    );

    const result = applyPermissions(fixture);
    assert.equal(result.status, 0, `apply failed: ${result.output}`);

    const deny = readClaudeDeny(fixture);
    assert.ok(
      deny.includes("Bash(git push:* --force)"),
      `expected original rule: ${JSON.stringify(deny)}`
    );
    assert.ok(
      !deny.includes("Bash(git push:*)"),
      `broader rule must not be added: ${JSON.stringify(deny)}`
    );
  });
});

test("codex to claude permissions sync ignores a justification whose rule does not match the pattern", () => {
  withFixture("permissions-justification-mismatch", (fixture) => {
    layCodexManagedRule(
      fixture,
      'prefix_rule(pattern=["git","push"], decision="forbidden", justification="Migrated from Claude deny permission Bash(npm run build:*).")'
    );

    const result = applyPermissions(fixture);
    assert.equal(result.status, 0, `apply failed: ${result.output}`);

    const deny = readClaudeDeny(fixture);
    assert.ok(
      deny.includes("Bash(git push:*)"),
      `expected pattern fallback: ${JSON.stringify(deny)}`
    );
    assert.ok(
      !deny.includes("Bash(npm run build:*)"),
      `mismatched justification must be ignored: ${JSON.stringify(deny)}`
    );
  });
});
