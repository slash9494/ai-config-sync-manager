import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
import { extractBackupRoot, runSync } from "../helpers/run-cli.mjs";
import { readClaudeMcpFromHome } from "../helpers/readers.mjs";
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

function applyMcp(fixture, env = {}) {
  return runSync({
    home: fixture.home,
    projectRoot: fixture.project,
    args: ["--scope", "global", "--include", "mcp", "--from", "codex", "--to", "claude", "--apply"],
    env,
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

test("[mcp_servers.notion] becomes ~/.claude.json mcpServers.notion (golden)", () => {
  withFixture("mcp-apply-happy", (fixture) => {
    const specs = [{ area: "mcp", variant: "happy" }];
    layCodexHome(fixture.home, specs);
    const beforeSnapshot = snapshotTree(fixture.home);

    const result = applyMcp(fixture);
    assert.equal(result.status, 0, `apply failed: ${result.output}`);

    layExpectedClaude(fixture.expectedHome, specs);
    assertGolden(fixture.home, fixture.expectedHome, { ignore: GOLDEN_IGNORE });
    assertSourceUnchanged(fixture.home, beforeSnapshot);
  });
});

test("secret env preserved by default", () => {
  withFixture("mcp-secret-env-default", (fixture) => {
    const specs = [{ area: "mcp", variant: "secret-env" }];
    layCodexHome(fixture.home, specs);
    const beforeSnapshot = snapshotTree(fixture.home);

    const result = applyMcp(fixture);
    assert.equal(result.status, 0, `apply failed: ${result.output}`);

    layExpectedClaude(fixture.expectedHome, specs);
    assertGolden(fixture.home, fixture.expectedHome, { ignore: GOLDEN_IGNORE });
    assertSourceUnchanged(fixture.home, beforeSnapshot);
  });
});

test("STRIP_SECRETS=1 omits secret env values", () => {
  withFixture("mcp-secret-env-strip", (fixture) => {
    const specs = [{ area: "mcp", variant: "secret-env" }];
    layCodexHome(fixture.home, specs);

    const result = applyMcp(fixture, { AI_CONFIG_SYNC_STRIP_SECRETS: "1" });
    assert.equal(result.status, 0, `apply failed: ${result.output}`);

    const servers = readClaudeMcpFromHome(fixture.home);
    assert.ok(servers.notion, "expected notion mcp server in ~/.claude.json");
    const env = servers.notion.env;
    if (env && typeof env === "object") {
      assert.equal(
        Object.prototype.hasOwnProperty.call(env, "NOTION_TOKEN"),
        false,
        `expected NOTION_TOKEN to be stripped, got env: ${JSON.stringify(env)}`
      );
    }
  });
});

test("manual-conflict overwrites with backup of prior value", () => {
  withFixture("mcp-manual-conflict", (fixture) => {
    const specs = [{ area: "mcp", variant: "manual-conflict" }];
    layCodexHome(fixture.home, specs);
    layPreExistingClaude(fixture.home, specs);

    const beforeSnapshot = snapshotTree(fixture.home);
    const result = applyMcp(fixture);
    assert.equal(result.status, 0, `apply failed: ${result.output}`);

    layExpectedClaude(fixture.expectedHome, specs);
    assertGolden(fixture.home, fixture.expectedHome, { ignore: GOLDEN_IGNORE });

    const backupRootDir = extractBackupRoot(result.stdout);
    assert.ok(backupRootDir, "expected Backup root in stdout");
    assert.equal(existsSync(backupRootDir), true, `backup root missing: ${backupRootDir}`);

    const backupFiles = walkFiles(backupRootDir);
    const backedUpHasOldValue = backupFiles.some((p) => {
      try {
        return readFileSync(p, "utf8").includes("local-notion-mcp");
      } catch {
        return false;
      }
    });
    assert.ok(
      backedUpHasOldValue,
      `expected backup containing prior local-notion-mcp value, files: ${backupFiles.join(", ")}`
    );

    assertSourceUnchanged(fixture.home, beforeSnapshot);
  });
});

test("second apply is idempotent", () => {
  withFixture("mcp-idempotent", (fixture) => {
    const specs = [{ area: "mcp", variant: "happy" }];
    layCodexHome(fixture.home, specs);

    const first = applyMcp(fixture);
    assert.equal(first.status, 0, `first apply failed: ${first.output}`);

    const afterFirst = readFileSync(join(fixture.home, ".claude.json"), "utf8");

    const second = applyMcp(fixture);
    assert.equal(second.status, 0, `second apply failed: ${second.output}`);

    const afterSecond = readFileSync(join(fixture.home, ".claude.json"), "utf8");
    assert.equal(afterSecond, afterFirst, "second apply must not change ~/.claude.json");
  });
});

test("codex to claude MCP sync keeps Claude-only keys on the server it overwrites", () => {
  withFixture("mcp-claude-only-keys", (fixture) => {
    mkdirSync(join(fixture.home, ".codex"), { recursive: true });
    writeFileSync(
      join(fixture.home, ".codex/config.toml"),
      '[mcp_servers.docs]\nurl = "https://codex.example/mcp"\n'
    );
    writeFileSync(
      join(fixture.home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          docs: {
            type: "http",
            url: "https://old.example/mcp",
            alwaysLoad: false,
            bareElicitationCapability: true,
          },
        },
      })
    );

    const result = applyMcp(fixture);
    assert.equal(result.status, 0, `apply failed: ${result.output}`);

    const claude = JSON.parse(readFileSync(join(fixture.home, ".claude.json"), "utf8"));
    assert.deepEqual(claude.mcpServers.docs, {
      alwaysLoad: false,
      bareElicitationCapability: true,
      type: "http",
      url: "https://codex.example/mcp",
    });
  });
});
