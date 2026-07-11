import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../bin/ai-config-sync.mjs", import.meta.url));

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-config-sync-test-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  return { root, home, project };
}

function expectedBackupPath(backup, targetPath) {
  const absolute = resolve(targetPath);
  const parsed = parse(absolute);
  const relativePath = relative(parsed.root, absolute);
  const rootLabel =
    parsed.root === "/" || parsed.root === ""
      ? ""
      : parsed.root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "") || "root";
  return rootLabel ? join(backup, rootLabel, relativePath) : join(backup, relativePath);
}

function runCli(fixture, args, input, extraEnv = {}) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: fixture.project,
    env: {
      ...process.env,
      AI_CONFIG_SYNC_HOME: fixture.home,
      ...extraEnv,
    },
    encoding: "utf8",
    input,
  });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function backupRoot(output) {
  const match = output.match(/^Backup root: (.+)$/m);
  assert.ok(match, "sync output should include a backup root");
  return match[1];
}

function statusDetailPath(output) {
  const match = output.match(/^Detail file: (.+)$/m);
  assert.ok(match, "status output should include a detail file path");
  return match[1];
}

test("status supports item selectors for MCP servers", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      notion: { command: "npx", args: ["notion-mcp"] },
      playwright: { command: "npx", args: ["playwright-mcp"] },
    },
  });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    ["[mcp_servers.playwright]", 'command = "npx"', 'args = ["playwright-mcp"]', ""].join("\n")
  );

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "mcp:notion", "--json"])
  );

  assert.deepEqual(report.include, ["mcp:notion"]);
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].area, "mcp");
  assert.deepEqual(report.entries[0].missingInCodex, ["notion"]);
  assert.deepEqual(report.entries[0].itemQualities, { notion: "exact" });
});

test("status supports glob item selectors", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      notion: { command: "npx", args: ["notion-mcp"] },
      playwright: { command: "npx", args: ["playwright-mcp"] },
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const included = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "mcp:not*", "--json"])
  );
  assert.equal(included.entries.length, 1);
  assert.deepEqual(included.entries[0].missingInCodex, ["notion"]);

  const excluded = JSON.parse(
    runCli(fixture, [
      "status",
      "--scope",
      "project",
      "--include",
      "mcp",
      "--exclude",
      "mcp:play*",
      "--json",
    ])
  );
  assert.equal(excluded.entries.length, 1);
  assert.deepEqual(excluded.entries[0].missingInCodex, ["notion"]);
});

test("global MCP status reads Claude servers from configurable global paths", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.home, ".claude"), { recursive: true });
  mkdirSync(join(fixture.home, ".codex"), { recursive: true });
  writeJson(join(fixture.home, ".claude.json"), {
    mcpServers: {
      notion: { command: "npx", args: ["notion-mcp"] },
    },
  });
  writeFileSync(join(fixture.home, ".codex/config.toml"), "");

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "global", "--include", "mcp:notion", "--json"])
  );

  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].area, "mcp");
  assert.equal(report.entries[0].claudePath, join(fixture.home, ".claude.json"));
  assert.deepEqual(report.entries[0].claudeMcpPaths, [join(fixture.home, ".claude.json")]);
  assert.deepEqual(report.entries[0].missingInCodex, ["notion"]);
});

test("global MCP status ignores Claude settings.json mcpServers (only ~/.claude.json is canonical)", () => {
  // settings.json holds policy keys like enabledMcpjsonServers but cannot host
  // server definitions. Only ~/.claude.json's top-level mcpServers is canonical.
  const fixture = createFixture();
  mkdirSync(join(fixture.home, ".claude"), { recursive: true });
  mkdirSync(join(fixture.home, ".codex"), { recursive: true });
  writeJson(join(fixture.home, ".claude/settings.json"), {
    mcpServers: { ignored: { command: "noop" } },
  });
  writeJson(join(fixture.home, ".codex/mcp.json"), {
    mcpServers: { github: { command: "github-mcp-server" } },
  });
  writeFileSync(join(fixture.home, ".codex/config.toml"), "");

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "global", "--include", "mcp", "--json"])
  );

  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].area, "mcp");
  assert.deepEqual(report.entries[0].claudeMcpPaths, []);
  assert.deepEqual(report.entries[0].codexMcpPaths, [
    join(fixture.home, ".codex/config.toml"),
    join(fixture.home, ".codex/mcp.json"),
  ]);
  assert.deepEqual(report.entries[0].missingInClaude, ["github"]);
  assert.deepEqual(report.entries[0].missingInCodex ?? [], []);
});

test("project MCP status reads Codex JSON MCP path", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), { mcpServers: {} });
  writeJson(join(fixture.project, ".codex/mcp.json"), {
    mcpServers: {
      notion: { command: "npx", args: ["notion-mcp"] },
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "mcp:notion", "--json"])
  );

  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].area, "mcp");
  const projectRoot = realpathSync(fixture.project);
  assert.deepEqual(report.entries[0].codexMcpPaths, [
    join(projectRoot, ".codex/config.toml"),
    join(projectRoot, ".codex/mcp.json"),
  ]);
  assert.deepEqual(report.entries[0].missingInClaude, ["notion"]);
});

test("global MCP sync reads servers from ~/.claude.json", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.home, ".claude"), { recursive: true });
  mkdirSync(join(fixture.home, ".codex"), { recursive: true });
  writeJson(join(fixture.home, ".claude.json"), {
    mcpServers: {
      notion: { command: "npx", args: ["notion-mcp"] },
    },
  });
  writeFileSync(join(fixture.home, ".codex/config.toml"), "");

  const output = runCli(fixture, [
    "sync",
    "--scope",
    "global",
    "--include",
    "mcp:notion",
    "--apply",
  ]);
  const config = readFileSync(join(fixture.home, ".codex/config.toml"), "utf8");

  assert.match(output, /merged MCP servers claude -> codex: notion/);
  assert.match(config, /\[mcp_servers\.notion\]/);
  assert.match(config, /args = \["notion-mcp"\]/);
});

test("global MCP sync maps Codex bearer_token_env_var to Claude Authorization header", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.home, ".codex"), { recursive: true });
  writeFileSync(
    join(fixture.home, ".codex/config.toml"),
    [
      "[mcp_servers.sentry]",
      'transport = "streamable_http"',
      'url = "https://mcp.sentry.io"',
      'bearer_token_env_var = "SENTRY_AUTH_TOKEN"',
      "",
    ].join("\n")
  );

  const output = runCli(fixture, [
    "sync",
    "--scope",
    "global",
    "--include",
    "mcp:sentry",
    "--from",
    "codex",
    "--to",
    "claude",
    "--apply",
  ]);
  const claude = JSON.parse(readFileSync(join(fixture.home, ".claude.json"), "utf8"));

  assert.match(output, /merged MCP servers codex -> claude: sentry/);
  assert.deepEqual(claude.mcpServers.sentry, {
    type: "http",
    url: "https://mcp.sentry.io",
    headers: { Authorization: "Bearer ${SENTRY_AUTH_TOKEN}" },
  });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "global", "--include", "mcp:sentry", "--json"])
  );
  assert.equal(report.entries.length, 0);
});

test("global MCP sync maps Claude Authorization header to Codex bearer_token_env_var", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.home, ".codex"), { recursive: true });
  writeJson(join(fixture.home, ".claude.json"), {
    mcpServers: {
      sentry: {
        type: "http",
        url: "https://mcp.sentry.io",
        headers: { Authorization: "Bearer ${SENTRY_AUTH_TOKEN}" },
      },
    },
  });
  writeFileSync(join(fixture.home, ".codex/config.toml"), "");

  const output = runCli(fixture, [
    "sync",
    "--scope",
    "global",
    "--include",
    "mcp:sentry",
    "--from",
    "claude",
    "--to",
    "codex",
    "--apply",
  ]);
  const config = readFileSync(join(fixture.home, ".codex/config.toml"), "utf8");

  assert.match(output, /merged MCP servers claude -> codex: sentry/);
  assert.match(config, /\[mcp_servers\.sentry\]/);
  assert.match(config, /transport = "streamable_http"/);
  assert.match(config, /url = "https:\/\/mcp\.sentry\.io"/);
  assert.match(config, /bearer_token_env_var = "SENTRY_AUTH_TOKEN"/);

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "global", "--include", "mcp:sentry", "--json"])
  );
  assert.equal(report.entries.length, 0);
});

test("global MCP status reports parity when ~/.claude.json and codex config.toml hold the same server", () => {
  // ~/.claude.json is the only canonical Claude global MCP source; settings.json
  // and the legacy ~/.claude/mcp.json must not be probed.
  const fixture = createFixture();
  mkdirSync(join(fixture.home, ".claude"), { recursive: true });
  mkdirSync(join(fixture.home, ".codex"), { recursive: true });
  writeJson(join(fixture.home, ".claude.json"), {
    mcpServers: {
      notion: { command: "npx", args: ["notion-mcp"] },
    },
  });
  writeFileSync(
    join(fixture.home, ".codex/config.toml"),
    ["[mcp_servers.notion]", 'command = "npx"', 'args = ["notion-mcp"]', ""].join("\n")
  );

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "global", "--include", "mcp", "--json"])
  );

  assert.equal(report.entries.length, 0);
  assert.match(report.summary, /No diff detected/);
});

test("project MCP status detects servers in top-level .mcp.json", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      notion: { command: "npx", args: ["notion-mcp"] },
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "mcp:notion", "--json"])
  );

  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].area, "mcp");
  assert.deepEqual(report.entries[0].claudeMcpPaths, [
    join(realpathSync(fixture.project), ".mcp.json"),
  ]);
  assert.deepEqual(report.entries[0].missingInCodex, ["notion"]);
});

test("project MCP status detects servers in ~/.claude.json projects.<root>.mcpServers (local override)", () => {
  const fixture = createFixture();
  const projectRoot = realpathSync(fixture.project);
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.home, ".claude.json"), {
    projects: {
      [projectRoot]: {
        mcpServers: {
          notion: { command: "npx", args: ["notion-mcp"] },
        },
      },
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "mcp:notion", "--json"])
  );

  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].area, "mcp");
  assert.deepEqual(report.entries[0].missingInCodex, ["notion"]);
  assert.deepEqual(report.entries[0].claudeMcpPaths, [
    `${join(fixture.home, ".claude.json")}#projects:${projectRoot}`,
  ]);
});

test("project MCP sync apply merges into ~/.claude.json projects.<root>.mcpServers when that is the only Claude target", () => {
  const fixture = createFixture();
  const projectRoot = realpathSync(fixture.project);
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  // Pre-create ~/.claude.json without project-local section so apply can write back into it.
  writeJson(join(fixture.home, ".claude.json"), {
    projects: { [projectRoot]: {} },
  });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    ["[mcp_servers.notion]", 'command = "npx"', 'args = ["notion-mcp"]', ""].join("\n")
  );

  const output = runCli(
    fixture,
    ["sync", "--scope", "project", "--include", "mcp:notion", "--apply"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "codex" }
  );

  assert.match(output, /merged MCP servers codex -> claude: notion/);
  // Default target stays ${root}/.mcp.json — that file should now own the merged server.
  const projectMcp = JSON.parse(readFileSync(join(fixture.project, ".mcp.json"), "utf8"));
  assert.deepEqual(projectMcp.mcpServers.notion, {
    type: "stdio",
    command: "npx",
    args: ["notion-mcp"],
  });
});

test("project MCP sync delete removes from both .mcp.json and ~/.claude.json projects.<root>", () => {
  const fixture = createFixture();
  const projectRoot = realpathSync(fixture.project);
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  // Same server name lives in both Claude project sources.
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      notion: { command: "npx", args: ["notion-mcp"] },
    },
  });
  writeJson(join(fixture.home, ".claude.json"), {
    projects: {
      [projectRoot]: {
        mcpServers: {
          notion: { command: "npx", args: ["notion-mcp"] },
        },
      },
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  // codex direction with no codex servers => Claude-side servers are deletes.
  const output = runCli(
    fixture,
    ["sync", "--scope", "project", "--include", "mcp:notion", "--apply"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "codex" }
  );

  assert.match(output, /deleted mcp item\(s\) from claude: notion/);

  const projectMcp = JSON.parse(readFileSync(join(fixture.project, ".mcp.json"), "utf8"));
  assert.deepEqual(projectMcp.mcpServers ?? {}, {});

  const homeClaude = JSON.parse(readFileSync(join(fixture.home, ".claude.json"), "utf8"));
  assert.deepEqual(homeClaude.projects[projectRoot].mcpServers ?? {}, {});
});

test("project MCP read merges both .mcp.json and ~/.claude.json projects.<root>; later source wins on key collisions", () => {
  // The reader uses `path.reduce((servers, item) => ({ ...servers, ...readClaudeMcpServers(item) }))`,
  // which means later entries in `mcpPaths` override earlier ones. The order is
  // [`${root}/.mcp.json`, `${home}/.claude.json#projects:<root>`], so the local override wins.
  const fixture = createFixture();
  const projectRoot = realpathSync(fixture.project);
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      shared: { command: "from-mcpjson" },
    },
  });
  writeJson(join(fixture.home, ".claude.json"), {
    projects: {
      [projectRoot]: {
        mcpServers: {
          shared: { command: "from-claudejson" },
        },
      },
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const plan = JSON.parse(
    runCli(fixture, ["sync", "--scope", "project", "--include", "mcp:shared", "--plan-json"])
  );

  // Both sources contribute; status sees a single missing-in-codex item.
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].action, "merge-mcp-servers");
  assert.deepEqual(plan.operations[0].serverNames, ["shared"]);

  // The patch preview's command field reflects the winning source (project-local override).
  const change = plan.operations[0].patchPreview[0].changes.find((line) =>
    line.startsWith("command:")
  );
  assert.equal(change, 'command: "from-claudejson"');
});

test("project MCP status display path reflects actual data location for ~/.claude.json projects.<root>", () => {
  const fixture = createFixture();
  const projectRoot = realpathSync(fixture.project);
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.home, ".claude.json"), {
    projects: {
      [projectRoot]: {
        mcpServers: { notion: { command: "npx", args: ["notion-mcp"] } },
      },
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const output = runCli(fixture, ["status", "--scope", "project", "--include", "mcp:notion"]);

  // The diff line should disclose the ~/.claude.json (projects.<root>) location, not .mcp.json.
  const claudePathMatch = new RegExp(
    `Claude: ${escapeRe(join(fixture.home, ".claude.json"))} \\(projects\\.${escapeRe(projectRoot)}\\)`
  );
  assert.match(output, claudePathMatch);
});

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("global instructions status reads Claude settings instructions", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.home, ".claude"), { recursive: true });
  mkdirSync(join(fixture.home, ".codex"), { recursive: true });
  writeJson(join(fixture.home, ".claude/settings.json"), {
    instructions: "claude settings instructions",
  });
  writeFileSync(join(fixture.home, ".codex/AGENTS.md"), "codex instructions\n");

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "global", "--include", "instructions", "--json"])
  );

  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].area, "instructions");
  assert.equal(report.entries[0].claudePath, join(fixture.home, ".claude/CLAUDE.md"));
  assert.deepEqual(report.entries[0].claudeInstructionPaths, [
    join(fixture.home, ".claude/settings.json#instructions"),
  ]);
  assert.deepEqual(report.entries[0].claudeInstructionCheckedPaths, [
    join(fixture.home, ".claude/CLAUDE.md"),
    join(fixture.home, ".claude/settings.json"),
  ]);
  assert.match(report.entries[0].claude, /1 source\(s\) sha256:/);
});

test("global instructions status reads Codex config instructions", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.home, ".claude"), { recursive: true });
  mkdirSync(join(fixture.home, ".codex"), { recursive: true });
  writeFileSync(join(fixture.home, ".claude/CLAUDE.md"), "claude instructions\n");
  writeFileSync(
    join(fixture.home, ".codex/config.toml"),
    'instructions = "codex config instructions"\n'
  );

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "global", "--include", "instructions", "--json"])
  );

  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].area, "instructions");
  assert.deepEqual(report.entries[0].codexInstructionPaths, [
    join(fixture.home, ".codex/config.toml#instructions"),
  ]);
  assert.match(report.entries[0].codex, /1 source\(s\) sha256:/);
});

test("status supports compact and tree output formats", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      notion: { command: "npx", args: ["notion-mcp"] },
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const compact = runCli(fixture, [
    "status",
    "--scope",
    "project",
    "--include",
    "mcp:notion",
    "--compact",
  ]);
  const tree = runCli(fixture, [
    "status",
    "--scope",
    "project",
    "--include",
    "mcp:notion",
    "--tree",
  ]);

  assert.match(compact, /^status: 1 diff\(s\) detected for project scope\./);
  assert.match(compact, /project\/mcp \[safe\] missing-in-codex: notion \[exact\]/);
  assert.match(compact, /details: Claude has it; Codex missing\./);
  assert.match(tree, /project\/\n {2}mcp\/\n {4}\[safe\] MCP servers differ/);
  assert.match(tree, /missing-in-codex: notion \[exact\]/);
  assert.match(tree, /details: Claude has it; Codex missing\./);
});

test("default status prints grouped apply-ready diff status", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      notion: { command: "npx", args: ["notion-mcp"] },
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const output = runCli(fixture, ["status", "--scope", "project", "--include", "mcp:notion"]);

  assert.match(output, /Result:/);
  assert.match(output, /- 1 safe item\(s\)/);
  assert.match(output, /Diff status:/);
  assert.match(output, /codex:/);
  assert.match(output, /project\/mcp: \+notion \[exact\] \(missing in Codex, safe\)/);
  assert.match(output, /details: Claude has it; Codex missing\./);
  assert.match(output, /action: copy Claude -> Codex/);
  assert.match(output, /apply: ai-config-sync sync --scope project --include mcp:notion --apply/);
  assert.match(output, /Detail file: /);
  assert.match(readFileSync(statusDetailPath(output), "utf8"), /project\/mcp: \+notion \[exact\]/);
});

test("default status details content differs sources", () => {
  const fixture = createFixture();
  writeFileSync(join(fixture.project, "CLAUDE.md"), "claude instructions\n");
  writeFileSync(join(fixture.project, "AGENTS.md"), "codex instructions\n");

  const output = runCli(fixture, ["status", "--scope", "project", "--include", "instructions"]);

  assert.match(output, /review:/);
  assert.match(
    output,
    /project\/instructions: ~instructions \[equivalent\] \(content differs, safe\)/
  );
  assert.match(
    output,
    /details: Default sync updates Codex from Claude\. Claude: sources: .*CLAUDE\.md; checked: .*CLAUDE\.md, .*\.claude\/settings\.json \(1 source\(s\) sha256:/
  );
  assert.match(
    output,
    /Codex: sources: .*AGENTS\.md; checked: .*AGENTS\.md, .*\.codex\/config\.toml \(1 source\(s\) sha256:/
  );
  assert.match(output, /diff:/);
  assert.match(output, /- Codex current L1: codex instructions/);
  assert.match(output, /\+ After apply from Claude L1: claude instructions/);
});

test("instructions status treats terminology-mapped model names as equivalent", () => {
  const fixture = createFixture();
  writeFileSync(join(fixture.project, "CLAUDE.md"), "Use opus4.8(latest) for hard reasoning.\n");
  writeFileSync(join(fixture.project, "AGENTS.md"), "Use gpt-5.6 for hard reasoning.\n");

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "instructions", "--json"])
  );

  assert.equal(report.entries.length, 0);
});

test("default status collapses large area diffs and writes full detail file", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/skills"), { recursive: true });
  mkdirSync(join(fixture.project, ".agents/skills"), { recursive: true });

  for (let index = 0; index < 12; index += 1) {
    const skill = `skill-${index}`;
    mkdirSync(join(fixture.project, ".claude/skills", skill), { recursive: true });
    writeFileSync(join(fixture.project, ".claude/skills", skill, "SKILL.md"), `# ${skill}\n`);
  }

  const output = runCli(fixture, ["status", "--scope", "project", "--include", "skills"]);
  const detail = readFileSync(statusDetailPath(output), "utf8");

  assert.match(output, /project\/skills: \+12 \(12 diff\(s\), safe\)/);
  assert.match(output, /hidden because this area has 10\+ item diffs/);
  assert.doesNotMatch(output, /skill-11 \[exact\]/);
  assert.match(detail, /project\/skills: \+skill-11 \[exact\] \(missing in Codex, safe\)/);
});

test("status labels permission mapping quality per item", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: {
      allow: ["Bash", "WebFetch"],
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const report = JSON.parse(
    runCli(fixture, [
      "status",
      "--scope",
      "project",
      "--include",
      "permissions:Bash,permissions:WebFetch",
      "--json",
    ])
  );

  assert.equal(report.entries[0].itemQualities["allow:Bash"], "exact");
  assert.equal(report.entries[0].itemQualities["allow:WebFetch"], "approximate");
});

test("commands support command-specific help", () => {
  const fixture = createFixture();
  const connectHelp = runCli(fixture, ["connect", "--help"]);
  const statusHelp = runCli(fixture, ["status", "--help"]);
  const syncHelp = runCli(fixture, ["sync", "--help"]);

  assert.match(connectHelp, /Usage:\n {2}ai-config-sync connect/);
  assert.match(statusHelp, /--compact/);
  assert.match(statusHelp, /--tree/);
  assert.match(syncHelp, /--plan-json/);
  assert.match(syncHelp, /--from claude\|codex/);
});

test("connect initializes config root and status ignore in an isolated home", () => {
  const fixture = createFixture();
  // Empty PATH so that any `claude` CLI invocation fails predictably, letting
  // the test verify the blocked-status branch instead of touching the user's
  // real ~/.claude. Codex install no longer shells out to the host CLI — it
  // writes ~/.agents/plugins/marketplace.json directly.
  mkdirSync(join(fixture.home, ".claude"), { recursive: true });
  mkdirSync(join(fixture.home, ".codex"), { recursive: true });

  const output = runCli(fixture, ["connect"], undefined, { PATH: "" });
  const statusIgnore = JSON.parse(
    readFileSync(join(fixture.home, ".ai-config-sync-manager/rules/status-ignore.json"), "utf8")
  );

  assert.match(output, /ok: initialized config root/);
  assert.match(output, /ok: initialized status ignore/);
  assert.match(output, /blocked: registered Claude plugin/);
  assert.match(output, /ok: registered Codex plugin/);
  assert.ok(existsSync(join(fixture.home, ".ai-config-sync-manager")));
  assert.ok(existsSync(join(fixture.home, ".agents/plugins/ai-config-sync-manager")));
  assert.ok(existsSync(join(fixture.home, ".agents/plugins/marketplace.json")));
  const marketplace = JSON.parse(
    readFileSync(join(fixture.home, ".agents/plugins/marketplace.json"), "utf8")
  );
  assert.equal(marketplace.name, "local-plugins");
  const entry = marketplace.plugins.find((p) => p.name === "ai-config-sync-manager");
  assert.ok(entry, "marketplace entry must be present");
  assert.equal(entry.source.source, "local");
  assert.equal(entry.source.path, "./ai-config-sync-manager");
  assert.equal(entry.policy.installation, "INSTALLED_BY_DEFAULT");
  const configToml = readFileSync(join(fixture.home, ".codex/config.toml"), "utf8");
  assert.match(configToml, /\[plugins\."ai-config-sync-manager@local-plugins"\]/);
  assert.match(configToml, /^enabled = true$/m);
  assert.deepEqual(statusIgnore, { version: 1, exclude: [] });
});

test("connect skips host registration when host directory is missing", () => {
  const fixture = createFixture();

  const output = runCli(fixture, ["connect"], undefined, { PATH: "" });

  assert.match(output, /skipped: Claude host not detected/);
  assert.match(output, /skipped: Codex host not detected/);
  assert.equal(existsSync(join(fixture.home, ".claude/plugins")), false);
  assert.equal(existsSync(join(fixture.home, "plugins/ai-config-sync-manager")), false);
  assert.ok(existsSync(join(fixture.home, ".ai-config-sync-manager")));
});

test("connect skips Codex when only Claude host is detected", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.home, ".claude"), { recursive: true });

  const output = runCli(fixture, ["connect"], undefined, { PATH: "" });

  // Without `claude` on PATH the install attempt is blocked, but Codex must
  // still be skipped because the host directory is absent.
  assert.match(output, /blocked: registered Claude plugin/);
  assert.match(output, /skipped: Codex host not detected/);
});

test("status reports same-name skill content drift as a manual conflict", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/skills/review"), { recursive: true });
  mkdirSync(join(fixture.project, ".agents/skills/review"), { recursive: true });
  writeFileSync(join(fixture.project, ".claude/skills/review/SKILL.md"), "# Review\nmodel: opus\n");
  writeFileSync(
    join(fixture.project, ".agents/skills/review/SKILL.md"),
    "# Review\nCodex version\n"
  );

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills:review", "--json"])
  );

  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].area, "skills");
  assert.equal(report.entries[0].risk, "manual");
  assert.deepEqual(report.entries[0].conflicts, ["review"]);

  const output = runCli(fixture, ["status", "--scope", "project", "--include", "skills:review"]);
  assert.match(output, /project\/skills: !review \[unsupported\] \(conflict, manual\)/);
  assert.match(output, /action: sync area/);
  assert.match(
    output,
    /apply: ai-config-sync sync --scope project --include skills:review --apply/
  );
  assert.match(output, /- Codex current L2: Codex version/);
  assert.match(output, /\+ After apply from Claude L2: model: gpt-5\.6/);
  assert.match(
    readFileSync(statusDetailPath(output), "utf8"),
    /\+ After apply from Claude L2: model: gpt-5\.6/
  );
});

test("status treats skill as equivalent when transform and override jointly equalize content", () => {
  // Verifies skillDirsEquivalent's transform+override combined-path: SKILL.md
  // diverges in BOTH a model token (opus <-> gpt-5.6, closed by terminology
  // transform) AND a free-prose line (closed only by an active paraphrase
  // override). Neither path alone makes them equal, but applied together they
  // must — otherwise the skill surfaces as a manual conflict.
  const fixture = createFixture();
  // realpath because macOS tmpdir resolves /var -> /private/var; the CLI uses
  // the canonical form internally so override path matching needs the same.
  const projectReal = realpathSync(fixture.project);
  const claudeSkill = join(projectReal, ".claude/skills/jointly");
  const codexSkill = join(projectReal, ".agents/skills/jointly");
  mkdirSync(claudeSkill, { recursive: true });
  mkdirSync(codexSkill, { recursive: true });

  // opus4.8(latest) <-> gpt-5.6 is a baked-in terminology mapping (agents-map.json
  // models.tiers, latest-frontier-model). Used here to force one-directional
  // transform equivalence for the model-token line.
  const claudeBody = "# Jointly\nUse opus4.8(latest) for hard reasoning.\nRead the docs.\n";
  const codexBody = "# Jointly\nUse gpt-5.6 for hard reasoning.\nInspect the docs.\n";
  writeFileSync(join(claudeSkill, "SKILL.md"), claudeBody);
  writeFileSync(join(codexSkill, "SKILL.md"), codexBody);

  // Register a paraphrase override masking the prose-only diff (Read <-> Inspect)
  // on line 3 of each manifest. Line 1 = "# Jointly", line 2 = model-token line
  // (handled by terminology-map transform), line 3 = the override target.
  writeJson(join(fixture.home, ".ai-config-sync-manager/rules/paraphrase-overrides.json"), {
    version: 1,
    overrides: [
      {
        id: "jointly-line3",
        area: "skills",
        claude_path: join(claudeSkill, "SKILL.md"),
        codex_path: join(codexSkill, "SKILL.md"),
        claude_line: 3,
        codex_line: 3,
        claude_text: "Read the docs.",
        codex_text: "Inspect the docs.",
      },
    ],
  });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills:jointly", "--json"])
  );
  assert.equal(report.entries.length, 0);
  assert.equal(report.paraphraseOverrides.active.length, 1);
  assert.equal(report.paraphraseOverrides.stale.length, 0);
});

test("status treats skill differing only by model alias as equivalent (no phantom conflict)", () => {
  // Regression for the status equivalence path: transformedSkillContentHash must
  // fold the transformed model token back to canonical (like skillContentHash),
  // otherwise the forward (claude->codex) hash ends on a host-native value and
  // surfaces a manual-risk phantom conflict even though copy/preview already
  // report equivalence. Claude's "Opus" is a tier *term*, not the alias, so the
  // alias-keyed normalizeModelAlias leaves it unfolded on read — only the
  // post-transform normalize closes the gap.
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/skills/aliased"), { recursive: true });
  mkdirSync(join(fixture.project, ".agents/skills/aliased"), { recursive: true });
  writeFileSync(
    join(fixture.project, ".claude/skills/aliased/SKILL.md"),
    "---\nname: aliased\nmodel: Opus\n---\n# Aliased\nShared body.\n"
  );
  writeFileSync(
    join(fixture.project, ".agents/skills/aliased/SKILL.md"),
    "---\nname: aliased\nmodel: gpt-5.6\n---\n# Aliased\nShared body.\n"
  );

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills:aliased", "--json"])
  );
  assert.equal(report.entries.length, 0);
});

test("status treats skill differing by model alias plus a term-masked line as equivalent", () => {
  // Regression for #10 sibling path: maskedSkillContentHash transforms to the
  // host-native model alias but never folds it back to canonical the way
  // skillContentHash does. When a skill needs BOTH a term ignore rule (to mask a
  // diverging prose line) AND the model fold, the masked hash ends on gpt-5.6 vs
  // canonical opus and the skill surfaces as a phantom manual conflict.
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/masked-alias"),
    "claude",
    [
      "---",
      "name: masked-alias",
      "model: Opus",
      "---",
      "# X",
      "refs .claude/docs/repo-analysis/ here",
      "common line",
      "",
    ].join("\n")
  );
  writeSkillManifest(
    join(fixture.project, ".agents/skills/masked-alias"),
    "codex",
    ["---", "name: masked-alias", "model: gpt-5.6", "---", "# X", "common line", ""].join("\n")
  );
  mkdirSync(join(fixture.project, ".ai-config-sync-manager"), { recursive: true });
  writeJson(join(fixture.project, ".ai-config-sync-manager/status-ignore.json"), {
    version: 1,
    exclude: [{ area: "skills", term: ".claude/docs/repo-analysis/" }],
  });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills:masked-alias", "--json"])
  );
  assert.equal(report.entries.length, 0);
});

test("status treats skill differing by model alias plus an override-masked line as equivalent", () => {
  // Regression for #10 sibling path: overriddenTransformedSkillContentHash layers
  // transformTextForHost over paraphrase masking but never folds the model token
  // back to canonical. A skill needing BOTH a paraphrase override (to mask a
  // diverging prose line) AND the model fold ends on gpt-5.6 vs canonical opus,
  // surfacing as a phantom manual conflict even though the prose is overridden.
  const fixture = createFixture();
  const projectReal = realpathSync(fixture.project);
  const claudeSkill = join(projectReal, ".claude/skills/override-alias");
  const codexSkill = join(projectReal, ".agents/skills/override-alias");
  mkdirSync(claudeSkill, { recursive: true });
  mkdirSync(codexSkill, { recursive: true });
  writeFileSync(
    join(claudeSkill, "SKILL.md"),
    "---\nname: override-alias\nmodel: Opus\n---\n# X\nRead the docs.\n"
  );
  writeFileSync(
    join(codexSkill, "SKILL.md"),
    "---\nname: override-alias\nmodel: gpt-5.6\n---\n# X\nInspect the docs.\n"
  );
  writeJson(join(fixture.home, ".ai-config-sync-manager/rules/paraphrase-overrides.json"), {
    version: 1,
    overrides: [
      {
        id: "override-alias-line6",
        area: "skills",
        claude_path: join(claudeSkill, "SKILL.md"),
        codex_path: join(codexSkill, "SKILL.md"),
        claude_line: 6,
        codex_line: 6,
        claude_text: "Read the docs.",
        codex_text: "Inspect the docs.",
      },
    ],
  });

  const report = JSON.parse(
    runCli(fixture, [
      "status",
      "--scope",
      "project",
      "--include",
      "skills:override-alias",
      "--json",
    ])
  );
  assert.equal(report.entries.length, 0);
  assert.equal(report.paraphraseOverrides.active.length, 1);
  assert.equal(report.paraphraseOverrides.stale.length, 0);
});

test("status preview shows diff in references/* file when manifest is masked", () => {
  // Verifies skillDirChangePreview iterates beyond SKILL.md so a real diff in
  // references/foo.md becomes visible even when the manifest is fully masked
  // by an active paraphrase override (which would otherwise leave only the
  // legacy "No line-level preview available." fallback).
  const fixture = createFixture();
  const projectReal = realpathSync(fixture.project);
  const claudeSkill = join(projectReal, ".claude/skills/multi");
  const codexSkill = join(projectReal, ".agents/skills/multi");
  mkdirSync(join(claudeSkill, "references"), { recursive: true });
  mkdirSync(join(codexSkill, "references"), { recursive: true });

  const claudeManifest = "# Multi\nRead the spec.\n";
  const codexManifest = "# Multi\nInspect the spec.\n";
  writeFileSync(join(claudeSkill, "SKILL.md"), claudeManifest);
  writeFileSync(join(codexSkill, "SKILL.md"), codexManifest);
  writeFileSync(join(claudeSkill, "references/foo.md"), "alpha line\nshared tail\n");
  writeFileSync(join(codexSkill, "references/foo.md"), "omega line\nshared tail\n");

  // Mask the manifest divergence so the only remaining diff is in references/foo.md.
  writeJson(join(fixture.home, ".ai-config-sync-manager/rules/paraphrase-overrides.json"), {
    version: 1,
    overrides: [
      {
        id: "multi-manifest",
        area: "skills",
        claude_path: join(claudeSkill, "SKILL.md"),
        codex_path: join(codexSkill, "SKILL.md"),
        claude_line: 2,
        codex_line: 2,
        claude_text: "Read the spec.",
        codex_text: "Inspect the spec.",
      },
    ],
  });

  const output = runCli(fixture, ["status", "--scope", "project", "--include", "skills:multi"]);
  assert.match(output, /references\/foo\.md:/);
  assert.match(output, /- Codex current L1: omega line/);
  assert.match(output, /\+ After apply from Claude L1: alpha line/);
  assert.doesNotMatch(output, /No line-level preview available\./);
});

test("status preview masks skill overrides before host transform", () => {
  const fixture = createFixture();
  const projectReal = realpathSync(fixture.project);
  const claudeSkill = join(projectReal, ".claude/skills/transform-mask");
  const codexSkill = join(projectReal, ".agents/skills/transform-mask");
  mkdirSync(join(claudeSkill, "references"), { recursive: true });
  mkdirSync(join(codexSkill, "references"), { recursive: true });

  writeFileSync(
    join(claudeSkill, "skill.md"),
    "# Transform Mask\nUse Bash and Read.\nAgent path: `~/.claude/agents/team/{name}.md`\n"
  );
  writeFileSync(
    join(codexSkill, "SKILL.md"),
    "# Transform Mask\nUse exec_command and Inspect.\nAgent path: `~/.codex/agents/{name}.toml`\n"
  );
  writeFileSync(join(claudeSkill, "references/foo.md"), "alpha line\n");
  writeFileSync(join(codexSkill, "references/foo.md"), "omega line\n");

  writeJson(join(fixture.home, ".ai-config-sync-manager/rules/paraphrase-overrides.json"), {
    version: 1,
    overrides: [
      {
        id: "skill-transform-mask",
        area: "skills",
        claude_path: join(claudeSkill, "skill.md"),
        codex_path: join(codexSkill, "SKILL.md"),
        claude_line: 2,
        codex_line: 2,
        claude_text: "Use Bash and Read.",
        codex_text: "Use exec_command and Inspect.",
      },
    ],
  });

  const output = runCli(fixture, [
    "status",
    "--scope",
    "project",
    "--include",
    "skills:transform-mask",
  ]);
  const detail = readFileSync(statusDetailPath(output), "utf8");

  assert.match(detail, /references\/foo\.md:/);
  assert.match(detail, /- Codex current L1: omega line/);
  assert.match(detail, /\+ After apply from Claude L1: alpha line/);
  assert.doesNotMatch(
    detail,
    /skill-transform-mask|Use Bash and Read|Use exec_command and Inspect|Use exec_command and Read|agents\/team\/\{name\}\.md|agents\/\{name\}\.toml/
  );

  const syncOutput = runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "skills:transform-mask",
    "--dry-run",
  ]);
  assert.doesNotMatch(
    syncOutput,
    /skill-transform-mask|Use Bash and Read|Use exec_command and Inspect|Use exec_command and Read|agents\/team\/\{name\}\.md|agents\/\{name\}\.toml/
  );
});

test("status treats grouped and flat agent path references as equivalent inside skills", () => {
  const fixture = createFixture();
  const projectReal = realpathSync(fixture.project);
  const claudeSkill = join(projectReal, ".claude/skills/path-equivalent");
  const codexSkill = join(projectReal, ".agents/skills/path-equivalent");
  mkdirSync(join(claudeSkill, "references"), { recursive: true });
  mkdirSync(join(codexSkill, "references"), { recursive: true });

  writeFileSync(
    join(claudeSkill, "skill.md"),
    [
      "---",
      "name: path-equivalent",
      "description: agent path: grouped",
      "---",
      "Agent path: `~/.claude/agents/insight-pipeline/{name}.md`",
      "Use Bash, Read, Write.",
      "Agent(",
      ")",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(codexSkill, "SKILL.md"),
    [
      "---",
      "name: path-equivalent",
      'description: "agent path: grouped"',
      "---",
      "Agent path: `~/.codex/agents/{name}.toml`",
      "Use exec_command, Inspect, Emit.",
      '<!-- ai-config-sync:manual-review reason="cannot parse Agent arguments: argument is not a single object literal" -->Agent(',
      ")",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(claudeSkill, "references/foo.md"),
    "Cache: `~/.claude/agent-memory/notion/`\n"
  );
  writeFileSync(join(codexSkill, "references/foo.md"), "Cache: `~/.codex/agent-memory/notion/`\n");

  writeJson(join(fixture.home, ".ai-config-sync-manager/rules/paraphrase-overrides.json"), {
    version: 1,
    overrides: [
      {
        id: "path-equivalent-tools",
        area: "skills",
        claude_path: join(claudeSkill, "skill.md"),
        codex_path: join(codexSkill, "SKILL.md"),
        claude_line: 6,
        codex_line: 6,
        claude_text: "Use Bash, Read, Write.",
        codex_text: "Use exec_command, Inspect, Emit.",
      },
    ],
  });

  const report = JSON.parse(
    runCli(fixture, [
      "status",
      "--scope",
      "project",
      "--include",
      "skills:path-equivalent",
      "--json",
    ])
  );
  assert.equal(report.entries.length, 0);
});

test("contentChangePreview centers window on diff position when line tail differs", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/skills/long-tail"), { recursive: true });
  mkdirSync(join(fixture.project, ".agents/skills/long-tail"), { recursive: true });

  // Build a long shared prefix so the actual divergence sits well past the
  // legacy 140-char head-truncation window. Without diff-aware truncation the
  // diff bytes ("ALPHA" vs "OMEGA") would be sliced off and the preview would
  // render two visually identical lines.
  const sharedPrefix = `# Long Tail\nshared start line\n${"shared body word ".repeat(20)}`;
  const claudeBody = `${sharedPrefix}TAIL_DIFF_MARKER_ALPHA trailing words after diff position\n`;
  const codexBody = `${sharedPrefix}TAIL_DIFF_MARKER_OMEGA trailing words after diff position\n`;
  writeFileSync(join(fixture.project, ".claude/skills/long-tail/SKILL.md"), claudeBody);
  writeFileSync(join(fixture.project, ".agents/skills/long-tail/SKILL.md"), codexBody);

  const output = runCli(fixture, ["status", "--scope", "project", "--include", "skills:long-tail"]);

  // Both diff markers must appear in the preview — proving the window is
  // centered around the first divergence rather than truncated from the head.
  assert.match(output, /TAIL_DIFF_MARKER_ALPHA/);
  assert.match(output, /TAIL_DIFF_MARKER_OMEGA/);
  // Truncation should be marked with leading ellipsis since the diff sits past
  // the maxWidth threshold.
  assert.match(output, /- Codex current L\d+: \.\.\./);
  assert.match(output, /\+ After apply from Claude L\d+: \.\.\./);
});

test("status keeps missing skills as safe copy candidates", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/skills/review"), { recursive: true });
  writeFileSync(join(fixture.project, ".claude/skills/review/SKILL.md"), "# Review\n");

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills:review", "--json"])
  );

  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].area, "skills");
  assert.equal(report.entries[0].risk, "safe");
  assert.deepEqual(report.entries[0].missingInCodex, ["review"]);
});

test("status reports symlink skills as unsupported and excludes them from sync", async () => {
  const fixture = createFixture();
  const { symlinkSync } = await import("node:fs");
  const sharedSkill = join(fixture.root, "shared-gstack");
  mkdirSync(sharedSkill, { recursive: true });
  mkdirSync(join(fixture.project, ".claude/skills"), { recursive: true });
  writeFileSync(join(sharedSkill, "SKILL.md"), "# GStack\n");
  symlinkSync(sharedSkill, join(fixture.project, ".claude/skills/gstack"), "dir");

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills:gstack", "--json"])
  );

  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].area, "skills");
  assert.equal(report.entries[0].risk, "manual");
  assert.equal(report.entries[0].statusOnly, true);
  assert.deepEqual(report.entries[0].unsupported, ["gstack"]);
  assert.equal(report.entries[0].itemQualities.gstack, "unsupported");
  assert.equal(report.entries[0].missingInCodex?.length ?? 0, 0);

  const output = runCli(fixture, ["status", "--scope", "project", "--include", "skills:gstack"]);
  assert.match(output, /project\/skills: !gstack \[unsupported\] \(unsupported, manual\)/);
  assert.match(output, /action: manual review/);
  assert.match(output, /apply: manual review/);

  const plan = JSON.parse(
    runCli(fixture, ["sync", "--scope", "project", "--include", "skills:gstack", "--plan-json"])
  );
  assert.deepEqual(plan.operations, []);
});

test("status ignore file hides diffs until the rule is removed", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/skills/review"), { recursive: true });
  mkdirSync(join(fixture.project, ".ai-config-sync-manager"), { recursive: true });
  writeFileSync(join(fixture.project, ".claude/skills/review/SKILL.md"), "# Review\n");
  writeJson(join(fixture.project, ".ai-config-sync-manager/status-ignore.json"), {
    version: 1,
    exclude: [{ scope: "project", area: "skills", item: "review" }],
  });

  const ignored = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills:review", "--json"])
  );
  assert.equal(ignored.statusIgnored, 1);
  assert.equal(
    ignored.statusIgnorePath,
    join(realpathSync(fixture.project), ".ai-config-sync-manager/status-ignore.json")
  );
  assert.equal(ignored.entries.length, 0);

  writeJson(join(fixture.project, ".ai-config-sync-manager/status-ignore.json"), {
    version: 1,
    exclude: [],
  });
  const visible = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills:review", "--json"])
  );
  assert.equal(visible.statusIgnored, 0);
  assert.equal(visible.entries.length, 1);
});

test("status ignore file supports glob item selectors", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/skills/review-api"), { recursive: true });
  mkdirSync(join(fixture.project, ".claude/skills/review-ui"), { recursive: true });
  mkdirSync(join(fixture.project, ".ai-config-sync-manager"), { recursive: true });
  writeFileSync(join(fixture.project, ".claude/skills/review-api/SKILL.md"), "# Review API\n");
  writeFileSync(join(fixture.project, ".claude/skills/review-ui/SKILL.md"), "# Review UI\n");
  writeJson(join(fixture.project, ".ai-config-sync-manager/status-ignore.json"), {
    version: 1,
    exclude: [{ scope: "project", area: "skills", item: "review-*" }],
  });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills", "--json"])
  );
  assert.equal(report.statusIgnored, 2);
  assert.equal(report.entries.length, 0);
});

test("status ignore file also removes entries from sync plans", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  mkdirSync(join(fixture.project, ".ai-config-sync-manager"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      notion: { command: "npx", args: ["notion-mcp"] },
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");
  writeJson(join(fixture.project, ".ai-config-sync-manager/status-ignore.json"), {
    version: 1,
    exclude: [{ scope: "project", area: "mcp", item: "notion" }],
  });

  const plan = JSON.parse(
    runCli(fixture, ["sync", "--scope", "project", "--include", "mcp:notion", "--plan-json"])
  );

  assert.equal(plan.ignored, 1);
  assert.equal(
    plan.ignorePath,
    join(realpathSync(fixture.project), ".ai-config-sync-manager/status-ignore.json")
  );
  assert.equal(plan.operations.length, 0);
});

test("status surfaces global plugins area as unsupported and skips self-managed", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.home, ".claude"), { recursive: true });
  mkdirSync(join(fixture.home, ".codex"), { recursive: true });
  writeJson(join(fixture.home, ".claude/plugins/installed_plugins.json"), {
    plugins: {
      "foo@user": [{ installPath: "/tmp/p/foo" }],
      "config-manager@ai-config-sync-manager": [{ installPath: "/tmp/p/cm" }],
    },
  });
  writeJson(join(fixture.home, ".agents/plugins/marketplace.json"), {
    plugins: [
      { name: "bar", path: "/tmp/p/bar", source: "/tmp/p/bar", version: "0.1.0" },
      { name: "ai-config-sync-manager", path: "/tmp/p/cm", source: "/tmp/p/cm", version: "0.1.0" },
    ],
  });

  const report = JSON.parse(runCli(fixture, ["status", "--scope", "global", "--json"]));
  const pluginEntry = report.entries.find((entry) => entry.area === "plugins");
  assert.ok(pluginEntry, "plugins entry should be present");
  assert.equal(pluginEntry.scope, "global");
  assert.equal(pluginEntry.risk, "manual");
  assert.equal(pluginEntry.statusOnly, true);
  assert.deepEqual(pluginEntry.unsupported, ["bar", "foo@user"]);
  assert.equal(pluginEntry.itemQualities["foo@user"], "unsupported");
  assert.equal(pluginEntry.itemQualities.bar, "unsupported");
  assert.equal(pluginEntry.claude, "1 plugin(s)");
  assert.equal(pluginEntry.codex, "1 plugin(s)");
});

test("status omits plugins entry when manifests are empty or self-managed only", () => {
  const fixtureA = createFixture();
  const reportA = JSON.parse(runCli(fixtureA, ["status", "--scope", "global", "--json"]));
  assert.equal(
    reportA.entries.some((entry) => entry.area === "plugins"),
    false
  );

  const fixtureB = createFixture();
  writeJson(join(fixtureB.home, ".claude/plugins/installed_plugins.json"), {
    plugins: {
      "config-manager@ai-config-sync-manager": [{ installPath: "/tmp/p/cm" }],
    },
  });
  const reportB = JSON.parse(runCli(fixtureB, ["status", "--scope", "global", "--json"]));
  assert.equal(
    reportB.entries.some((entry) => entry.area === "plugins"),
    false
  );
});

test("status human-readable output includes plugin install hints", () => {
  const fixture = createFixture();
  writeJson(join(fixture.home, ".claude/plugins/installed_plugins.json"), {
    plugins: {
      "foo@user": [{ installPath: "/tmp/p/foo" }],
    },
  });
  writeJson(join(fixture.home, ".agents/plugins/marketplace.json"), {
    plugins: [{ name: "bar", path: "/tmp/p/bar", source: "/tmp/p/bar", version: "0.1.0" }],
  });

  const output = runCli(fixture, ["status", "--scope", "global", "--include", "plugins"]);
  assert.match(output, /Plugin sync is unsupported/);
  assert.match(output, /\/plugin install/);
  assert.match(output, /\.agents\/plugins\/marketplace\.json/);
  assert.match(output, /global\/plugins: !foo@user \[unsupported\] \(unsupported, manual\)/);
});

test("status ignore hides plugins entry and supports item-level filtering", () => {
  const fixture = createFixture();
  writeJson(join(fixture.home, ".claude/plugins/installed_plugins.json"), {
    plugins: {
      "foo@user": [{ installPath: "/tmp/p/foo" }],
      "baz@user": [{ installPath: "/tmp/p/baz" }],
    },
  });
  writeJson(join(fixture.home, ".agents/plugins/marketplace.json"), {
    plugins: [{ name: "bar", path: "/tmp/p/bar", source: "/tmp/p/bar", version: "0.1.0" }],
  });

  writeJson(join(fixture.home, ".ai-config-sync-manager/rules/status-ignore.json"), {
    version: 1,
    exclude: [{ scope: "global", area: "plugins" }],
  });
  const ignoredArea = JSON.parse(runCli(fixture, ["status", "--scope", "global", "--json"]));
  assert.ok(ignoredArea.statusIgnored >= 1);
  assert.equal(
    ignoredArea.entries.some((entry) => entry.area === "plugins"),
    false
  );

  writeJson(join(fixture.home, ".ai-config-sync-manager/rules/status-ignore.json"), {
    version: 1,
    exclude: [{ scope: "global", area: "plugins", item: "foo@user" }],
  });
  const ignoredItem = JSON.parse(runCli(fixture, ["status", "--scope", "global", "--json"]));
  const remaining = ignoredItem.entries.find((entry) => entry.area === "plugins");
  assert.ok(remaining, "plugins entry should remain after item-level ignore");
  assert.equal(remaining.unsupported.includes("foo@user"), false);
  assert.ok(remaining.unsupported.includes("bar"));
  assert.ok(remaining.unsupported.includes("baz@user"));
  assert.ok(ignoredItem.statusIgnored >= 1);
});

test("sync apply maps Bash permissions, MCP tool approvals, and creates backups", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: {
      allow: ["Bash(npm run check:*)", "mcp__notion__search"],
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), 'approval_policy = "never"\n');

  const output = runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:Bash(npm run check:*),permissions:mcp__notion__search",
    "--apply",
  ]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");
  const rules = readFileSync(join(fixture.project, ".codex/rules/default.rules"), "utf8");

  assert.match(output, /approval required: no/i);
  assert.match(config, /\[mcp_servers\.notion\.tools\.search\]/);
  assert.match(config, /approval_mode = "approve"/);
  assert.doesNotMatch(config, /# BEGIN ai-config-sync permissions/);
  assert.doesNotMatch(config, /# permissions\.allow/);
  assert.match(rules, /prefix_rule\(pattern=\["npm","run","check"\], decision="allow"/);
  assert.ok(
    existsSync(
      expectedBackupPath(
        backupRoot(output),
        join(realpathSync(fixture.project), ".codex/config.toml")
      )
    )
  );
});

test("sync apply without scope applies global and project scopes", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.home, ".claude"), { recursive: true });
  mkdirSync(join(fixture.home, ".codex"), { recursive: true });
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.home, ".claude.json"), {
    mcpServers: {
      globalNotion: { command: "npx", args: ["global-notion-mcp"] },
    },
  });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      projectNotion: { command: "npx", args: ["project-notion-mcp"] },
    },
  });
  writeFileSync(join(fixture.home, ".codex/config.toml"), "");
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const output = runCli(fixture, ["sync", "--include", "mcp", "--apply"]);
  const globalConfig = readFileSync(join(fixture.home, ".codex/config.toml"), "utf8");
  const projectConfig = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.match(output, /Scope: global/);
  assert.match(output, /Scope: project/);
  assert.match(globalConfig, /\[mcp_servers\.globalNotion\]/);
  assert.match(projectConfig, /\[mcp_servers\.projectNotion\]/);
});

test("sync dry-run without scope plans global and project scopes", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.home, ".claude"), { recursive: true });
  mkdirSync(join(fixture.home, ".codex"), { recursive: true });
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.home, ".claude.json"), {
    mcpServers: {
      globalNotion: { command: "npx", args: ["global-notion-mcp"] },
    },
  });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      projectNotion: { command: "npx", args: ["project-notion-mcp"] },
    },
  });
  writeFileSync(join(fixture.home, ".codex/config.toml"), "");
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const plan = JSON.parse(runCli(fixture, ["sync", "--include", "mcp", "--plan-json"]));

  assert.deepEqual(plan.scopes, ["global", "project"]);
  assert.equal(plan.plans.length, 2);
  assert.equal(plan.plans[0].mode, "dry-run");
  assert.equal(plan.plans[0].scope, "global");
  assert.equal(plan.plans[1].scope, "project");
});

test("default sync plans equivalent instruction content diffs", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    instructions: "claude settings instructions",
  });
  writeFileSync(join(fixture.project, "AGENTS.md"), "codex instructions\n");

  const plan = JSON.parse(
    runCli(fixture, ["sync", "--scope", "project", "--include", "instructions", "--plan-json"])
  );

  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].risk, "safe");
  assert.equal(plan.operations[0].action, "write-instructions");
  assert.equal(plan.operations[0].approvalRequired, false);
  assert.equal(plan.operations[0].targetPath, join(realpathSync(fixture.project), "AGENTS.md"));
  assert.equal(plan.operations[0].content, "claude settings instructions");
  assert.deepEqual(plan.operations[0].changePreview, [
    "- Codex current L1: codex instructions",
    "+ After apply from Claude L1: claude settings instructions",
  ]);
});

test("sync apply writes equivalent instruction content diffs", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    instructions: "claude settings instructions",
  });
  writeFileSync(join(fixture.project, "AGENTS.md"), "codex instructions\n");

  const output = runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "instructions",
    "--apply",
  ]);
  const agents = readFileSync(join(fixture.project, "AGENTS.md"), "utf8");

  assert.match(output, /wrote instructions/);
  assert.equal(agents, "claude settings instructions\n");
});

test("sync applies default terminology mappings to instructions", () => {
  const fixture = createFixture();
  writeFileSync(
    join(fixture.project, "CLAUDE.md"),
    "Use CLAUDE.md with opus4.8(latest), thinking budget, and Task-tool delegation.\n"
  );
  writeFileSync(join(fixture.project, "AGENTS.md"), "old\n");

  const output = runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "instructions",
    "--apply",
  ]);
  const agents = readFileSync(join(fixture.project, "AGENTS.md"), "utf8");

  assert.match(output, /Term mapping: .*rules\/terminology-map\.json/);
  assert.match(output, /Target templates: .*rules\/host-target-templates\.json/);
  assert.equal(
    agents,
    "Use AGENTS.md with gpt-5.6, reasoning effort, and Codex spawn_agent delegation.\n"
  );
});

test("sync applies host target templates to generic host surfaces", () => {
  const fixture = createFixture();
  writeFileSync(
    join(fixture.project, "CLAUDE.md"),
    "Use a Claude slash command with Claude hook handler and Task tool.\n"
  );
  writeFileSync(join(fixture.project, "AGENTS.md"), "old\n");

  runCli(fixture, ["sync", "--scope", "project", "--include", "instructions", "--apply"]);
  const agents = readFileSync(join(fixture.project, "AGENTS.md"), "utf8");

  assert.equal(
    agents,
    "Use a Codex skill command with Codex native hook and Codex spawn_agent delegation.\n"
  );
});

test("sync applies project host target template override", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, "rules"), { recursive: true });
  writeJson(join(fixture.project, "rules/host-target-templates.json"), {
    version: 1,
    templates: [
      {
        id: "qa",
        aliases: {
          claude: ["qa skill"],
          codex: ["qa command"],
        },
        target: {
          claude: "custom Claude QA template",
          codex: "custom Codex QA template",
        },
      },
    ],
  });
  writeFileSync(join(fixture.project, "CLAUDE.md"), "Run the qa skill.\n");
  writeFileSync(join(fixture.project, "AGENTS.md"), "old\n");

  runCli(fixture, ["sync", "--scope", "project", "--include", "instructions", "--apply"]);
  const agents = readFileSync(join(fixture.project, "AGENTS.md"), "utf8");

  assert.equal(agents, "Run the custom Codex QA template.\n");
});

test("sync applies project terminology mapping override", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, "rules"), { recursive: true });
  writeJson(join(fixture.project, "rules/terminology-map.json"), {
    version: 1,
    rules: [
      {
        id: "custom-model",
        claude: ["custom-claude-model"],
        codex: ["custom-codex-model"],
      },
    ],
  });
  writeFileSync(join(fixture.project, "CLAUDE.md"), "Use custom-claude-model.\n");
  writeFileSync(join(fixture.project, "AGENTS.md"), "old\n");

  runCli(fixture, ["sync", "--scope", "project", "--include", "instructions", "--apply"]);
  const agents = readFileSync(join(fixture.project, "AGENTS.md"), "utf8");

  assert.equal(agents, "Use custom-codex-model.\n");
});

test("sync applies layered project terminology mapping override", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, "rules"), { recursive: true });
  writeJson(join(fixture.project, "rules/terminology-map.json"), {
    version: 2,
    layers: [
      {
        id: "custom-layer",
        rules: [
          {
            id: "custom-layer-model",
            claude: ["layer-claude-model"],
            codex: ["layer-codex-model"],
          },
        ],
      },
    ],
  });
  writeFileSync(join(fixture.project, "CLAUDE.md"), "Use layer-claude-model.\n");
  writeFileSync(join(fixture.project, "AGENTS.md"), "old\n");

  runCli(fixture, ["sync", "--scope", "project", "--include", "instructions", "--apply"]);
  const agents = readFileSync(join(fixture.project, "AGENTS.md"), "utf8");

  assert.equal(agents, "Use layer-codex-model.\n");
});

test("sync apply replaces manual skill conflicts without per-operation approval", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/skills/review"), { recursive: true });
  mkdirSync(join(fixture.project, ".agents/skills/review"), { recursive: true });
  writeFileSync(join(fixture.project, ".claude/skills/review/SKILL.md"), "# Review\nmodel: opus\n");
  writeFileSync(
    join(fixture.project, ".agents/skills/review/SKILL.md"),
    "# Review\nCodex version\n"
  );

  const output = runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "skills:review",
    "--apply",
  ]);
  const skill = readFileSync(join(fixture.project, ".agents/skills/review/SKILL.md"), "utf8");

  assert.match(output, /\[manual\] project\/skills: copy-missing-skills/);
  assert.match(output, /Approval required: no/);
  assert.match(output, /Change preview:/);
  assert.match(output, /review: target will be replaced from Claude/);
  assert.match(output, /- Target current L2: Codex version/);
  assert.match(output, /\+ After apply from Claude L2: model: gpt-5\.6/);
  assert.match(output, /replaced skill review/);
  assert.equal(skill, "# Review\nmodel: gpt-5.6\n");
});

test("sync apply normalizes model alias in frontmatter when copying skill claude->codex", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/skills/review"), { recursive: true });
  writeFileSync(
    join(fixture.project, ".claude/skills/review/SKILL.md"),
    "---\nname: review\nmodel: opus\n---\n# Review\n\nBody.\n"
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:review", "--apply"]);
  const skill = readFileSync(join(fixture.project, ".agents/skills/review/SKILL.md"), "utf8");

  assert.match(skill, /^---\n/);
  assert.match(skill, /\nmodel: gpt-5\.6\n/);
  assert.doesNotMatch(skill, /\nmodel: opus\n/);
});

test("sync apply normalizes model alias in frontmatter when copying skill codex->claude", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".agents/skills/review"), { recursive: true });
  writeFileSync(
    join(fixture.project, ".agents/skills/review/SKILL.md"),
    "---\nname: review\nmodel: gpt-5.6\n---\n# Review\n\nBody.\n"
  );

  runCli(fixture, [
    "sync",
    "--from",
    "codex",
    "--to",
    "claude",
    "--scope",
    "project",
    "--include",
    "skills:review",
    "--apply",
  ]);
  const skill = readFileSync(join(fixture.project, ".claude/skills/review/SKILL.md"), "utf8");

  assert.match(skill, /^---\n/);
  assert.match(skill, /\nmodel: opus\n/);
  assert.doesNotMatch(skill, /\nmodel: gpt-5\.6\n/);
});

test("sync applies terminology mappings when copying skills", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/skills/review"), { recursive: true });
  writeFileSync(
    join(fixture.project, ".claude/skills/review/SKILL.md"),
    "# Review\nUse CLAUDE.md with Opus.\n"
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:review", "--apply"]);
  const skill = readFileSync(join(fixture.project, ".agents/skills/review/SKILL.md"), "utf8");

  assert.equal(skill, "# Review\nUse AGENTS.md with gpt-5.6.\n");
});

test("sync applies host target templates when copying skills", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/skills/host-surface"), { recursive: true });
  writeFileSync(
    join(fixture.project, ".claude/skills/host-surface/SKILL.md"),
    "# Host Surface\nUse Claude plugin command and Claude command hook.\n"
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:host-surface", "--apply"]);
  const skill = readFileSync(join(fixture.project, ".agents/skills/host-surface/SKILL.md"), "utf8");

  assert.equal(skill, "# Host Surface\nUse Codex skill command and Codex native hook.\n");
});

test("sync regex-translates agent file paths and extensions when copying skills", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/skills/agent-path"), { recursive: true });
  writeFileSync(
    join(fixture.project, ".claude/skills/agent-path/SKILL.md"),
    "# Agent Path\nRead .claude/agents/preview-tester.md for your role.\n"
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:agent-path", "--apply"]);
  const skill = readFileSync(join(fixture.project, ".agents/skills/agent-path/SKILL.md"), "utf8");

  assert.equal(skill, "# Agent Path\nRead .codex/agents/preview-tester.toml for your role.\n");
});

test("sync supports JSON plan output", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      notion: { command: "npx", args: ["notion-mcp"] },
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const plan = JSON.parse(
    runCli(fixture, ["sync", "--scope", "project", "--include", "mcp:notion", "--plan-json"])
  );

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.route, "auto");
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].action, "merge-mcp-servers");
  assert.deepEqual(plan.operations[0].serverNames, ["notion"]);
  assert.deepEqual(plan.operations[0].itemQualities, { notion: "exact" });
  assert.deepEqual(plan.results, []);
});

test("default sync plans Codex-only config toward Claude", () => {
  // Direction-aware semantics: with AI_CONFIG_SYNC_HOST=codex, default
  // direction flips to codex->claude, so a Codex-only item is a + copy
  // into Claude (rather than a delete from Codex under the default
  // claude->codex direction).
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), { mcpServers: {} });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    ["[mcp_servers.notion]", 'command = "npx"', 'args = ["notion-mcp"]', ""].join("\n")
  );

  const plan = JSON.parse(
    runCli(
      fixture,
      ["sync", "--scope", "project", "--include", "mcp:notion", "--plan-json"],
      undefined,
      { AI_CONFIG_SYNC_HOST: "codex" }
    )
  );

  assert.equal(plan.route, "auto");
  assert.equal(plan.from, "codex");
  assert.equal(plan.to, "claude");
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].action, "merge-mcp-servers");
  assert.equal(plan.operations[0].from, "codex");
  assert.equal(plan.operations[0].to, "claude");
  assert.deepEqual(plan.operations[0].serverNames, ["notion"]);
});

test("default sync applies Codex-only config to Claude", () => {
  // Mirror of the planning test above: with codex-host direction, the
  // Codex-only item becomes a + copy applied into Claude.
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), { mcpServers: {} });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    ["[mcp_servers.notion]", 'command = "npx"', 'args = ["notion-mcp"]', ""].join("\n")
  );

  const output = runCli(
    fixture,
    ["sync", "--scope", "project", "--include", "mcp:notion", "--apply"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "codex" }
  );
  const mcp = JSON.parse(readFileSync(join(fixture.project, ".mcp.json"), "utf8"));

  assert.match(output, /merged MCP servers codex -> claude: notion/);
  assert.deepEqual(mcp.mcpServers.notion, { type: "stdio", command: "npx", args: ["notion-mcp"] });
});

test("default sync propagates Codex deletion to Claude after baseline", () => {
  // Direction alone now drives delete detection; baseline tracking is no
  // longer required. With AI_CONFIG_SYNC_HOST=codex, an item present in
  // Claude but absent from Codex (the source) is a delete from Claude.
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      notion: { command: "npx", args: ["notion-mcp"] },
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const output = runCli(
    fixture,
    ["sync", "--scope", "project", "--include", "mcp:notion", "--apply"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "codex" }
  );
  const mcp = JSON.parse(readFileSync(join(fixture.project, ".mcp.json"), "utf8"));

  assert.match(output, /deleted mcp item\(s\) from claude: notion/);
  assert.deepEqual(mcp.mcpServers, {});
});

test("default sync propagates Claude addition to Codex after baseline", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), { mcpServers: {} });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  runCli(fixture, ["sync", "--scope", "project", "--apply"]);
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      notion: { command: "npx", args: ["notion-mcp"] },
    },
  });

  const output = runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "mcp:notion",
    "--apply",
  ]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.match(output, /merged MCP servers claude -> codex: notion/);
  assert.match(config, /\[mcp_servers\.notion\]/);
});

test("default sync deletes Claude skill not present in Codex (codex->claude direction)", () => {
  // Direction-driven delete: with codex as source (host=codex), a skill
  // that exists only on the Claude target is removed via deleteSkillItems.
  // The original directory is replaced by a backup copy.
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/skills/orphan"), { recursive: true });
  writeFileSync(join(fixture.project, ".claude/skills/orphan/SKILL.md"), "# Orphan\n");
  // Codex side exists but does not contain the skill.
  mkdirSync(join(fixture.project, ".agents/skills"), { recursive: true });

  const output = runCli(
    fixture,
    ["sync", "--scope", "project", "--include", "skills:orphan", "--apply"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "codex" }
  );

  const claudeSkillDir = join(fixture.project, ".claude/skills/orphan");
  assert.equal(existsSync(claudeSkillDir), false, "claude-side skill directory should be removed");
  assert.match(output, /deleted skills item\(s\) from claude: orphan/);

  const backup = backupRoot(output);
  assert.ok(existsSync(backup), "backup root directory should exist");
  // process.cwd() resolves symlinks (e.g. /var -> /private/var on macOS).
  const projectRoot = realpathSync(fixture.project);
  const backupPath = expectedBackupPath(
    backup,
    join(projectRoot, ".claude/skills/orphan/SKILL.md")
  );
  assert.ok(
    existsSync(backupPath),
    `backup should contain SKILL.md for the deleted skill at ${backupPath}`
  );
});

test("default sync deletes Claude agent not present in Codex (codex->claude direction)", () => {
  // Direction-driven delete: an agent file present only on the Claude
  // target is removed via deleteAgentItems with backup intact.
  const fixture = createFixture();
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/orphan.md"),
    { name: "orphan", description: "Orphan agent", model: "opus" },
    "Orphan agent body"
  );
  mkdirSync(join(fixture.project, ".codex/agents"), { recursive: true });

  const output = runCli(
    fixture,
    ["sync", "--scope", "project", "--include", "agents:orphan", "--apply"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "codex" }
  );

  const claudeAgentPath = join(fixture.project, ".claude/agents/orphan.md");
  assert.equal(existsSync(claudeAgentPath), false, "claude-side agent file should be removed");
  assert.match(output, /deleted agents item\(s\) from claude: orphan/);

  const backup = backupRoot(output);
  const projectRoot = realpathSync(fixture.project);
  const backupAgentPath = expectedBackupPath(backup, join(projectRoot, ".claude/agents/orphan.md"));
  assert.ok(
    existsSync(backupAgentPath),
    `backup should contain the deleted agent file at ${backupAgentPath}`
  );
});

test("default sync deletes Codex skill not present in Claude (claude->codex direction)", () => {
  // Mirror of the codex->claude case: with the default direction
  // (claude is source), a Codex-only skill is removed.
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/skills"), { recursive: true });
  mkdirSync(join(fixture.project, ".agents/skills/orphan"), { recursive: true });
  writeFileSync(join(fixture.project, ".agents/skills/orphan/SKILL.md"), "# Orphan\n");

  const output = runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "skills:orphan",
    "--apply",
  ]);

  const codexSkillDir = join(fixture.project, ".agents/skills/orphan");
  assert.equal(existsSync(codexSkillDir), false, "codex-side skill directory should be removed");
  assert.match(output, /deleted skills item\(s\) from codex: orphan/);

  const backup = backupRoot(output);
  const projectRoot = realpathSync(fixture.project);
  const backupSkillFile = join(
    backup,
    join(projectRoot, ".agents/skills/orphan/SKILL.md").replace(/^\/+/, "")
  );
  assert.ok(
    existsSync(backupSkillFile),
    `backup should contain SKILL.md for the deleted skill at ${backupSkillFile}`
  );
});

test("explicit --from codex --to claude deletes Claude-only item", () => {
  // The explicit route shares the same direction-aware algorithm as auto:
  // a skill missing from the source (Codex) is deleted from the target
  // (Claude), regardless of whether the route was inferred or explicit.
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/skills/orphan"), { recursive: true });
  writeFileSync(join(fixture.project, ".claude/skills/orphan/SKILL.md"), "# Orphan\n");
  mkdirSync(join(fixture.project, ".agents/skills"), { recursive: true });

  const plan = JSON.parse(
    runCli(fixture, [
      "sync",
      "--from",
      "codex",
      "--to",
      "claude",
      "--scope",
      "project",
      "--include",
      "skills:orphan",
      "--plan-json",
    ])
  );

  assert.equal(plan.route, "explicit");
  assert.equal(plan.from, "codex");
  assert.equal(plan.to, "claude");
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].action, "delete-items");
  assert.equal(plan.operations[0].area, "skills");
  assert.equal(plan.operations[0].from, "codex");
  assert.equal(plan.operations[0].to, "claude");
  assert.deepEqual(plan.operations[0].itemNames, ["orphan"]);
});

test("direction-driven plan reports - symbol for missing-in-source items", () => {
  // The status table representation marks missing-in-source items with a
  // '-' symbol and labels the action "delete from <Target>". The plan
  // JSON correspondingly emits a delete-items operation pointing at the
  // target host. Both surfaces are checked here against the same fixture.
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      notion: { command: "npx", args: ["notion-mcp"] },
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  // With AI_CONFIG_SYNC_HOST=codex, source=codex and notion is only on the
  // Claude target -> action should label as "delete from Claude".
  const statusReport = JSON.parse(
    runCli(
      fixture,
      ["status", "--scope", "project", "--include", "mcp:notion", "--json"],
      undefined,
      { AI_CONFIG_SYNC_HOST: "codex" }
    )
  );

  const entry = statusReport.entries.find((item) => item.area === "mcp");
  assert.ok(entry, "expected an mcp status entry");
  // The diff data is symmetric; "missingInCodex" simply means Claude has
  // an item Codex lacks. The direction-aware interpretation lives in the
  // plan and rendered status surfaces below.
  assert.deepEqual(entry.missingInCodex, ["notion"]);
  assert.deepEqual(entry.missingInClaude ?? [], []);
  // Driven from the same data, the direction-aware sync plan exposes the
  // delete operation to the same target host.
  const plan = JSON.parse(
    runCli(
      fixture,
      ["sync", "--scope", "project", "--include", "mcp:notion", "--plan-json"],
      undefined,
      { AI_CONFIG_SYNC_HOST: "codex" }
    )
  );

  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].action, "delete-items");
  assert.equal(plan.operations[0].to, "claude");
  assert.deepEqual(plan.operations[0].itemNames, ["notion"]);

  // The default text status output exposes the symbol/action labels.
  const text = runCli(
    fixture,
    ["status", "--scope", "project", "--include", "mcp:notion"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "codex" }
  );

  assert.match(text, /-notion/);
  assert.match(text, /delete from Claude/);
});

test("sync rejects unknown --confirm flag with a helpful error", () => {
  const fixture = createFixture();
  let error;
  try {
    runCli(fixture, ["sync", "--confirm"]);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "expected --confirm to throw");
  assert.match(error.stderr ?? error.message ?? "", /Unknown option for sync: --confirm/);
});

test("sync plan includes permission review notes for risky and approximate mappings", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: {
      allow: ["Bash", "WebFetch"],
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const text = runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:Bash,permissions:WebFetch",
    "--dry-run",
  ]);
  const plan = JSON.parse(
    runCli(fixture, [
      "sync",
      "--scope",
      "project",
      "--include",
      "permissions:Bash,permissions:WebFetch",
      "--plan-json",
    ])
  );

  assert.match(text, /Review notes:/);
  assert.match(text, /Patch preview:/);
  assert.match(text, /rules\/default\.rules prefix_rule\(pattern=\["bash"\], decision="allow"/);
  assert.match(text, /config\.toml web_search = "live"/);
  assert.match(text, /Bash: broad, interpreter, shell-wrapper, network, or destructive command/);
  assert.match(text, /WebFetch: maps to config\.toml web_search/);
  assert.equal(plan.operations[0].patchPreview[0].item, "allow:Bash");
  assert.deepEqual(plan.operations[0].patchPreview[0].changes, [
    'rules/default.rules prefix_rule(pattern=["bash"], decision="allow", justification="Migrated from Claude allow permission Bash.")',
  ]);
  assert.deepEqual(plan.operations[0].patchPreview[1].changes, ['config.toml web_search = "live"']);
  assert.deepEqual(plan.operations[0].reviewNotes, [
    "Bash: broad, interpreter, shell-wrapper, network, or destructive command will be written as a prefix_rule; review before apply",
    'WebFetch: maps to config.toml web_search = "live"; reverse sync will normalize to WebSearch (lossy)',
  ]);
});

test("sync apply maps allow:WebFetch to native web_search instead of managed metadata", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: {
      allow: ["Bash", "WebFetch"],
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:Bash,permissions:WebFetch",
    "--apply",
  ]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");
  const rules = readFileSync(join(fixture.project, ".codex/rules/default.rules"), "utf8");

  assert.match(config, /web_search = "live"/);
  assert.doesNotMatch(config, /approval_policy = "on-request"/);
  assert.doesNotMatch(config, /# permissions\.allow = "WebFetch"/);
  assert.doesNotMatch(config, /# permissions\.allow = "Bash"/);
  assert.match(rules, /prefix_rule\(pattern=\["bash"\], decision="allow"/);
});

test("status treats Claude file-write permissions as equivalent to Codex workspace-write after apply", () => {
  for (const permission of ["Write", "Edit", "MultiEdit"]) {
    const fixture = createFixture();
    mkdirSync(join(fixture.project, ".claude"), { recursive: true });
    mkdirSync(join(fixture.project, ".codex"), { recursive: true });
    writeJson(join(fixture.project, ".claude/settings.json"), {
      permissions: {
        allow: [permission],
      },
    });
    writeFileSync(join(fixture.project, ".codex/config.toml"), "");

    runCli(fixture, [
      "sync",
      "--scope",
      "project",
      "--include",
      `permissions:${permission}`,
      "--apply",
    ]);
    const report = JSON.parse(
      runCli(fixture, ["status", "--scope", "project", "--include", "permissions", "--json"])
    );
    const permissionEntries = report.entries.filter((entry) => entry.area === "permissions");

    assert.equal(
      permissionEntries.length,
      0,
      `expected ${permission} to be equivalent to workspace-write, got: ${JSON.stringify(permissionEntries)}`
    );
  }
});

test("sync apply converts Codex native permissions back to Claude permissions", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex/rules"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), { permissions: {} });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    [
      'approval_policy = "never"',
      'sandbox_mode = "workspace-write"',
      'web_search = "live"',
      "",
      "[mcp_servers.github]",
      'command = "github-mcp-server"',
      'enabled_tools = ["search_repositories", "get_issue"]',
      'disabled_tools = ["delete_repository"]',
      "",
      "[mcp_servers.notion.tools.search]",
      'approval_mode = "approve"',
      "",
    ].join("\n")
  );
  writeFileSync(
    join(fixture.project, ".codex/rules/default.rules"),
    'prefix_rule(pattern=["npm","run","check"], decision="prompt", justification="test")\n'
  );

  runCli(fixture, [
    "sync",
    "--from",
    "codex",
    "--to",
    "claude",
    "--scope",
    "project",
    "--include",
    "permissions:Bash(npm run check:*),permissions:mcp__notion__search,permissions:WebSearch,permissions:mcp__github__search_repositories,permissions:mcp__github__delete_repository,permissions:Write,permissions:Edit,permissions:MultiEdit",
    "--apply",
  ]);
  const settings = JSON.parse(readFileSync(join(fixture.project, ".claude/settings.json"), "utf8"));

  assert.deepEqual(settings.permissions.ask, ["Bash(npm run check:*)"]);
  assert.deepEqual(settings.permissions.allow, [
    "Edit",
    "MultiEdit",
    "WebSearch",
    "Write",
    "mcp__github__search_repositories",
    "mcp__notion__search",
  ]);
  assert.deepEqual(settings.permissions.deny, ["mcp__github__delete_repository"]);
  assert.ok(!settings.permissions.allow.includes("approval_policy"));
});

test("sync apply strips secret-like env values when AI_CONFIG_SYNC_STRIP_SECRETS opts in", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      notion: {
        command: "node",
        args: ["server.js"],
        env: {
          NOTION_TOKEN: "secret",
          SAFE_ENV: "visible",
        },
      },
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const output = runCli(
    fixture,
    ["sync", "--scope", "project", "--include", "mcp:notion", "--apply"],
    undefined,
    { AI_CONFIG_SYNC_STRIP_SECRETS: "1" }
  );
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.match(output, /Patch preview:/);
  assert.match(output, /notion: add/);
  assert.match(output, /env\.SAFE_ENV: "visible"/);
  assert.match(output, /metadata-only env\.NOTION_TOKEN: skipped secret-like value/);
  assert.match(config, /\[mcp_servers\.notion\]/);
  assert.match(config, /SAFE_ENV = "visible"/);
  assert.doesNotMatch(config, /NOTION_TOKEN/);
  assert.doesNotMatch(config, /secret/);
});

test("sync apply converts Claude command hooks to Codex native hook TOML", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    hooks: {
      PostToolUse: [
        {
          matcher: "Write",
          hooks: [
            {
              type: "command",
              command: "npm run check",
              timeout: 30,
              statusMessage: "checking",
            },
          ],
        },
      ],
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  runCli(fixture, ["sync", "--scope", "project", "--include", "hooks:PostToolUse", "--apply"]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.match(config, /\[features\]/);
  assert.match(config, /hooks = true/);
  assert.match(config, /\[\[hooks\.PostToolUse\]\]/);
  assert.match(config, /matcher = "Write"/);
  assert.match(config, /command = "npm run check"/);
  assert.match(config, /timeout = 30/);
  assert.doesNotMatch(config, /# BEGIN ai-config-sync hooks/);
});

test("sync apply keeps unsupported hooks as managed metadata", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    hooks: {
      Notification: [
        {
          hooks: [
            {
              type: "webhook",
              url: "https://example.invalid/hook",
            },
          ],
        },
      ],
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  runCli(fixture, ["sync", "--scope", "project", "--include", "hooks:Notification", "--apply"]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.match(config, /# BEGIN ai-config-sync hooks/);
  assert.match(config, /# hooks\.Notification = /);
  assert.doesNotMatch(config, /\[\[hooks\.Notification\]\]/);
});

test("sync apply with hook subset preserves previously synced hooks", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    hooks: {
      Notification: [{ hooks: [{ type: "command", command: "echo notify" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
      Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "hooks:Notification,hooks:PreToolUse,hooks:Stop",
    "--apply",
  ]);

  writeJson(join(fixture.project, ".claude/settings.json"), {
    hooks: {
      Notification: [{ hooks: [{ type: "command", command: "echo notify" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
      Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo ups" }] }],
    },
  });

  runCli(fixture, ["sync", "--scope", "project", "--include", "hooks:UserPromptSubmit", "--apply"]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.match(config, /\[features\]/);
  assert.match(config, /hooks = true/);
  assert.match(config, /\[\[hooks\.Notification\]\]/);
  assert.match(config, /\[\[hooks\.PreToolUse\]\]/);
  assert.match(config, /\[\[hooks\.Stop\]\]/);
  assert.match(config, /\[\[hooks\.UserPromptSubmit\]\]/);
  assert.match(config, /command = "echo notify"/);
  assert.match(config, /command = "echo pre"/);
  assert.match(config, /command = "echo stop"/);
  assert.match(config, /command = "echo ups"/);

  const beginIndex = config.indexOf("# BEGIN ai-config-sync native-hooks");
  const endIndex = config.indexOf("# END ai-config-sync native-hooks");
  assert.ok(beginIndex !== -1, "managed native-hooks block should be present");
  assert.ok(endIndex > beginIndex, "managed native-hooks block should close after begin marker");
  const managedBlock = config.slice(beginIndex, endIndex);
  assert.match(managedBlock, /\[\[hooks\.Notification\]\]/);
  assert.match(managedBlock, /\[\[hooks\.PreToolUse\]\]/);
  assert.match(managedBlock, /\[\[hooks\.Stop\]\]/);
  assert.match(managedBlock, /\[\[hooks\.UserPromptSubmit\]\]/);
});

test("sync apply converts Codex native hooks back to Claude settings", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {});
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    [
      "[features]",
      "hooks = true",
      "",
      "[[hooks.PostToolUse]]",
      'matcher = "Write"',
      "[[hooks.PostToolUse.hooks]]",
      'type = "command"',
      'command = "npm run check"',
      "timeout = 30",
      'statusMessage = "checking"',
      "",
    ].join("\n")
  );

  runCli(fixture, [
    "sync",
    "--from",
    "codex",
    "--to",
    "claude",
    "--scope",
    "project",
    "--include",
    "hooks:PostToolUse",
    "--apply",
  ]);
  const settings = JSON.parse(readFileSync(join(fixture.project, ".claude/settings.json"), "utf8"));

  assert.deepEqual(settings.hooks.PostToolUse, [
    {
      matcher: "Write",
      hooks: [
        {
          type: "command",
          command: "npm run check",
          timeout: 30,
          statusMessage: "checking",
        },
      ],
    },
  ]);
});

test("AI_CONFIG_SYNC_HOST=codex flips default sync direction to codex -> claude", () => {
  const fixture = createFixture();
  const plan = JSON.parse(
    runCli(fixture, ["sync", "--scope", "project", "--plan-json"], undefined, {
      AI_CONFIG_SYNC_HOST: "codex",
    })
  );

  assert.equal(plan.from, "codex");
  assert.equal(plan.to, "claude");
  assert.equal(plan.route, "auto");
});

test("AI_CONFIG_SYNC_HOST=claude keeps default sync direction as claude -> codex", () => {
  const fixture = createFixture();
  const plan = JSON.parse(
    runCli(fixture, ["sync", "--scope", "project", "--plan-json"], undefined, {
      AI_CONFIG_SYNC_HOST: "claude",
    })
  );

  assert.equal(plan.from, "claude");
  assert.equal(plan.to, "codex");
  assert.equal(plan.route, "auto");
});

test("status reflects AI_CONFIG_SYNC_HOST=codex in direction header and details wording", () => {
  const fixture = createFixture();
  writeFileSync(join(fixture.project, "CLAUDE.md"), "claude side instructions\n");
  writeFileSync(join(fixture.project, "AGENTS.md"), "codex side instructions\n");

  const output = runCli(
    fixture,
    ["status", "--scope", "project", "--include", "instructions"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "codex" }
  );

  assert.match(output, /Default sync direction: codex -> claude/);
  assert.match(output, /Default sync updates Claude from Codex/);
});

test("status keeps claude -> codex direction by default", () => {
  const fixture = createFixture();
  writeFileSync(join(fixture.project, "CLAUDE.md"), "claude side instructions\n");
  writeFileSync(join(fixture.project, "AGENTS.md"), "codex side instructions\n");

  const output = runCli(
    fixture,
    ["status", "--scope", "project", "--include", "instructions"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "claude" }
  );

  assert.match(output, /Default sync direction: claude -> codex/);
  assert.match(output, /Default sync updates Codex from Claude/);
});

test("status instruction diff preview labels follow AI_CONFIG_SYNC_HOST=codex direction", () => {
  const fixture = createFixture();
  writeFileSync(join(fixture.project, "CLAUDE.md"), "claude line one\n");
  writeFileSync(join(fixture.project, "AGENTS.md"), "codex line one\n");

  const output = runCli(
    fixture,
    ["status", "--scope", "project", "--include", "instructions"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "codex" }
  );

  const detail = readFileSync(statusDetailPath(output), "utf8");
  assert.match(detail, /Claude current L1: claude line one/);
  assert.match(detail, /After apply from Codex L1:/);
  assert.doesNotMatch(detail, /(?<!After )Codex current L1: codex line one/);
  assert.doesNotMatch(detail, /After apply from Claude L1:/);
});

test("status instruction diff preview labels keep claude->codex labels by default", () => {
  const fixture = createFixture();
  writeFileSync(join(fixture.project, "CLAUDE.md"), "claude line one\n");
  writeFileSync(join(fixture.project, "AGENTS.md"), "codex line one\n");

  const output = runCli(
    fixture,
    ["status", "--scope", "project", "--include", "instructions"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "claude" }
  );

  const detail = readFileSync(statusDetailPath(output), "utf8");
  assert.match(detail, /Codex current L1: codex line one/);
  assert.match(detail, /After apply from Claude L1:/);
});

test("compact and tree status formats include direction", () => {
  const fixture = createFixture();
  const compact = runCli(fixture, ["status", "--scope", "project", "--compact"], undefined, {
    AI_CONFIG_SYNC_HOST: "codex",
  });
  const tree = runCli(fixture, ["status", "--scope", "project", "--tree"], undefined, {
    AI_CONFIG_SYNC_HOST: "codex",
  });

  assert.match(compact, /direction=codex->claude/);
  assert.match(tree, /Default sync direction: codex -> claude/);
});

test("sync plan render shows default direction even on auto route", () => {
  const fixture = createFixture();
  const output = runCli(fixture, ["sync", "--scope", "project"], undefined, {
    AI_CONFIG_SYNC_HOST: "codex",
  });

  assert.match(output, /Route: auto \(diff-directed, default codex -> claude\)/);
});

test("status JSON includes direction object", () => {
  const fixture = createFixture();
  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--json"], undefined, {
      AI_CONFIG_SYNC_HOST: "codex",
    })
  );

  assert.equal(report.source, "codex");
  assert.equal(report.target, "claude");
  assert.deepEqual(report.direction, { from: "codex", to: "claude" });
});

test("explicit --from --to overrides AI_CONFIG_SYNC_HOST", () => {
  const fixture = createFixture();
  const plan = JSON.parse(
    runCli(
      fixture,
      ["sync", "--from", "claude", "--to", "codex", "--scope", "project", "--plan-json"],
      undefined,
      { AI_CONFIG_SYNC_HOST: "codex" }
    )
  );

  assert.equal(plan.from, "claude");
  assert.equal(plan.to, "codex");
  assert.equal(plan.route, "explicit");
});

function writeClaudeAgent(path, frontmatter, body) {
  mkdirSync(dirname(path), { recursive: true });
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push("---", "", body);
  writeFileSync(path, `${lines.join("\n")}\n`);
}

function writeCodexAgent(path, fields) {
  mkdirSync(dirname(path), { recursive: true });
  const order = [
    "name",
    "description",
    "model",
    "model_reasoning_effort",
    "developer_instructions",
  ];
  const lines = [];
  for (const key of order) {
    if (fields[key] === undefined || fields[key] === null) continue;
    lines.push(`${key} = ${JSON.stringify(String(fields[key]))}`);
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
}

test("agents status reports Claude-only agent as missing in Codex", () => {
  const fixture = createFixture();
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/sample.md"),
    { name: "sample", description: "Sample agent", model: "opus" },
    "Sample agent body"
  );
  mkdirSync(join(fixture.project, ".codex/agents"), { recursive: true });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "agents", "--json"])
  );

  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].area, "agents");
  assert.equal(report.entries[0].risk, "safe");
  assert.deepEqual(report.entries[0].missingInCodex, ["sample"]);
  assert.deepEqual(report.entries[0].missingInClaude, []);
  assert.equal(report.entries[0].itemQualities.sample, "exact");
});

test("agents status reports Codex-only agent as missing in Claude", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/agents"), { recursive: true });
  writeCodexAgent(join(fixture.project, ".codex/agents/sample.toml"), {
    name: "sample",
    description: "Sample agent",
    model: "gpt-5.4",
    developer_instructions: "Sample agent body",
  });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "agents", "--json"])
  );

  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].area, "agents");
  assert.deepEqual(report.entries[0].missingInClaude, ["sample"]);
  assert.deepEqual(report.entries[0].missingInCodex, []);
  assert.equal(report.entries[0].itemQualities.sample, "exact");
});

test("agents status flags same-name agents with diverged bodies as conflict", () => {
  const fixture = createFixture();
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/sample.md"),
    { name: "sample", description: "Sample", model: "opus" },
    "Claude side body"
  );
  writeCodexAgent(join(fixture.project, ".codex/agents/sample.toml"), {
    name: "sample",
    description: "Sample",
    model: "gpt-5.4",
    developer_instructions: "Different codex body",
  });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "agents", "--json"])
  );

  const conflictEntry = report.entries.find(
    (entry) =>
      entry.area === "agents" && Array.isArray(entry.conflicts) && entry.conflicts.length > 0
  );
  assert.ok(conflictEntry, "expected an agents conflict entry");
  assert.equal(conflictEntry.risk, "manual");
  assert.deepEqual(conflictEntry.conflicts, ["sample"]);
});

test("agents status treats transform-equivalent bodies as no diff", () => {
  const fixture = createFixture();
  const body = "Use opus for the latest model";
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/sample.md"),
    { name: "sample", description: "Sample", model: "opus" },
    body
  );
  writeCodexAgent(join(fixture.project, ".codex/agents/sample.toml"), {
    name: "sample",
    description: "Sample",
    model: "gpt-5.4",
    developer_instructions: `\n${body}\n`,
  });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "agents", "--json"])
  );

  const agentsEntries = report.entries.filter((entry) => entry.area === "agents");
  assert.equal(agentsEntries.length, 0);
});

test("agents status ignores migration preamble in Codex developer_instructions", () => {
  const fixture = createFixture();
  const body = "Shared agent body";
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/sample.md"),
    { name: "sample", description: "Sample", model: "opus" },
    body
  );
  writeCodexAgent(join(fixture.project, ".codex/agents/sample.toml"), {
    name: "sample",
    description: "Sample",
    model: "gpt-5.4",
    developer_instructions: `Migrated from Claude agent: /old/path\n\n\n${body}\n`,
  });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "agents", "--json"])
  );

  const agentsEntries = report.entries.filter((entry) => entry.area === "agents");
  assert.equal(agentsEntries.length, 0);
});

test("agents sync apply copies Claude agent to Codex with model alias", () => {
  const fixture = createFixture();
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/sample.md"),
    { name: "sample", description: "Example agent", model: "opus" },
    "Hello, agent body."
  );
  mkdirSync(join(fixture.project, ".codex/agents"), { recursive: true });

  const output = runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "agents:sample",
    "--apply",
  ]);
  const codexFile = readFileSync(join(fixture.project, ".codex/agents/sample.toml"), "utf8");

  assert.match(output, /copied agent sample -> .*\.codex\/agents\/sample\.toml/);
  assert.match(output, /Backup root: /);
  assert.match(codexFile, /^name = "sample"$/m);
  assert.match(codexFile, /^description = "Example agent"$/m);
  assert.match(codexFile, /^model = "gpt-5\.6"$/m);
  assert.match(codexFile, /developer_instructions = "[^"]*Hello, agent body\./);
});

test("agents sync apply derives name and description from body when Claude frontmatter is missing them", () => {
  const fixture = createFixture();
  const claudePath = join(fixture.project, ".claude/agents/sample.md");
  mkdirSync(dirname(claudePath), { recursive: true });
  writeFileSync(
    claudePath,
    "---\nmodel: opus\n---\n# Sample Heading\n\nThis agent reviews pull requests for security issues.\n\nMore detailed instructions follow.\n"
  );
  mkdirSync(join(fixture.project, ".codex/agents"), { recursive: true });

  runCli(fixture, ["sync", "--scope", "project", "--include", "agents:sample", "--apply"]);
  const codexFile = readFileSync(join(fixture.project, ".codex/agents/sample.toml"), "utf8");

  assert.match(codexFile, /^name = "sample"$/m);
  assert.match(
    codexFile,
    /^description = "This agent reviews pull requests for security issues\."$/m
  );
});

test("agents sync apply copies Codex agent to Claude with reverse model alias", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/agents"), { recursive: true });
  writeCodexAgent(join(fixture.project, ".codex/agents/sample.toml"), {
    name: "sample",
    description: "Example agent",
    model: "gpt-5.4",
    developer_instructions: "Migrated from Claude agent: /old/path\n\nReal codex content",
  });

  const output = runCli(
    fixture,
    ["sync", "--scope", "project", "--include", "agents:sample", "--apply"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "codex" }
  );
  const claudeFile = readFileSync(join(fixture.project, ".claude/agents/sample.md"), "utf8");

  assert.match(output, /copied agent sample -> .*\.claude\/agents\/sample\.md/);
  assert.match(claudeFile, /^name: sample$/m);
  assert.match(claudeFile, /^description: Example agent$/m);
  assert.match(claudeFile, /^model: sonnet$/m);
  assert.match(claudeFile, /Real codex content/);
  assert.doesNotMatch(claudeFile, /Migrated from Claude agent/);
});

test("agents sync apply preserves Codex metadata-only fields when overwriting", () => {
  const fixture = createFixture();
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/sample.md"),
    { name: "sample", description: "Sample", model: "opus", tools: "Read,Edit", color: "blue" },
    "Claude side body"
  );
  writeCodexAgent(join(fixture.project, ".codex/agents/sample.toml"), {
    name: "sample",
    description: "Sample",
    model: "gpt-5.4",
    model_reasoning_effort: "high",
    developer_instructions: "Older codex body",
  });

  runCli(fixture, ["sync", "--scope", "project", "--include", "agents:sample", "--apply"]);
  const codexFile = readFileSync(join(fixture.project, ".codex/agents/sample.toml"), "utf8");

  assert.match(codexFile, /^model_reasoning_effort = "high"$/m);
  assert.match(codexFile, /developer_instructions = "[^"]*Claude side body/);
  assert.doesNotMatch(codexFile, /Older codex body/);
});

test("agents sync apply preserves Claude metadata-only fields when overwriting", () => {
  const fixture = createFixture();
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/sample.md"),
    { name: "sample", description: "Sample", model: "opus", tools: "Read,Edit", color: "blue" },
    "Older claude body"
  );
  writeCodexAgent(join(fixture.project, ".codex/agents/sample.toml"), {
    name: "sample",
    description: "Sample",
    model: "gpt-5.4",
    developer_instructions: "Codex side body",
  });

  runCli(
    fixture,
    ["sync", "--scope", "project", "--include", "agents:sample", "--apply"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "codex" }
  );
  const claudeFile = readFileSync(join(fixture.project, ".claude/agents/sample.md"), "utf8");

  assert.match(claudeFile, /^tools: Read,Edit$/m);
  assert.match(claudeFile, /^color: blue$/m);
  assert.match(claudeFile, /Codex side body/);
  assert.doesNotMatch(claudeFile, /Older claude body/);
});

test("agents sync apply with selector limits work to a single agent", () => {
  const fixture = createFixture();
  for (const name of ["foo", "bar"]) {
    writeClaudeAgent(
      join(fixture.project, ".claude/agents", `${name}.md`),
      { name, description: `Agent ${name}`, model: "opus" },
      `Body of ${name}`
    );
  }
  mkdirSync(join(fixture.project, ".codex/agents"), { recursive: true });

  runCli(fixture, ["sync", "--scope", "project", "--include", "agents:foo", "--apply"]);

  assert.equal(existsSync(join(fixture.project, ".codex/agents/foo.toml")), true);
  assert.equal(existsSync(join(fixture.project, ".codex/agents/bar.toml")), false);
});

test("agents status labels mapping quality as exact for matched agents", () => {
  const fixture = createFixture();
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/foo.md"),
    { name: "foo", description: "Agent foo", model: "opus" },
    "Foo body"
  );
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/bar.md"),
    { name: "bar", description: "Agent bar", model: "opus" },
    "Bar body"
  );
  writeCodexAgent(join(fixture.project, ".codex/agents/foo.toml"), {
    name: "foo",
    description: "Agent foo",
    model: "gpt-5.4",
    developer_instructions: "\nFoo body\n",
  });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "agents", "--json"])
  );

  const entry = report.entries.find((item) => item.area === "agents");
  assert.ok(entry, "expected agents entry");
  assert.deepEqual(entry.missingInCodex, ["bar"]);
  assert.equal(entry.itemQualities.bar, "exact");
});

test("agents sync propagates Claude-side deletion to Codex after baseline", () => {
  const fixture = createFixture();
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/sample.md"),
    { name: "sample", description: "Sample", model: "opus" },
    "Sample body"
  );
  mkdirSync(join(fixture.project, ".codex/agents"), { recursive: true });

  runCli(fixture, ["sync", "--scope", "project", "--apply"]);
  assert.equal(existsSync(join(fixture.project, ".codex/agents/sample.toml")), true);

  rmSync(join(fixture.project, ".claude/agents/sample.md"));

  const plan = JSON.parse(
    runCli(fixture, ["sync", "--scope", "project", "--include", "agents:sample", "--plan-json"])
  );

  assert.equal(plan.hasBaseline, true);
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].action, "delete-items");
  assert.equal(plan.operations[0].area, "agents");
  assert.equal(plan.operations[0].from, "claude");
  assert.equal(plan.operations[0].to, "codex");
  assert.deepEqual(plan.operations[0].itemNames, ["sample"]);
});

test("agents status matches folder-layout Claude agent against flat Codex agent by canonical frontmatter name", () => {
  // Real-world layout: user keeps `code-writer/code-writer-logic.md` under
  // a folder for organization, but the frontmatter `name` is the canonical
  // invocation id. Codex stores the same agent flat as `code-writer-logic.toml`.
  // The enumerator must key off the frontmatter name, not the file path.
  const fixture = createFixture();
  const body = "Code writer logic body";
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/code-writer/code-writer-logic.md"),
    { name: "code-writer-logic", description: "Logic writer", model: "opus" },
    body
  );
  writeCodexAgent(join(fixture.project, ".codex/agents/code-writer-logic.toml"), {
    name: "code-writer-logic",
    description: "Logic writer",
    model: "gpt-5.4",
    developer_instructions: `\n${body}\n`,
  });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "agents", "--json"])
  );

  const agentsEntries = report.entries.filter((entry) => entry.area === "agents");
  assert.equal(
    agentsEntries.length,
    0,
    "no agent diff should be reported when canonical names match"
  );
});

test("agents status matches slash-in-frontmatter Claude name against dash-flattened Codex name", () => {
  // Variant where Claude frontmatter contains a slash (e.g. coderabbit/local-analyzer)
  // but Codex flattens slashes to dashes. Canonical key normalization must turn
  // the Claude name into the dash form so they match.
  const fixture = createFixture();
  const body = "Coderabbit local analyzer body";
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/coderabbit/local-analyzer.md"),
    { name: "coderabbit/local-analyzer", description: "Local analyzer", model: "opus" },
    body
  );
  writeCodexAgent(join(fixture.project, ".codex/agents/coderabbit-local-analyzer.toml"), {
    name: "coderabbit-local-analyzer",
    description: "Local analyzer",
    model: "gpt-5.4",
    developer_instructions: `\n${body}\n`,
  });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "agents", "--json"])
  );

  const agentsEntries = report.entries.filter((entry) => entry.area === "agents");
  assert.equal(
    agentsEntries.length,
    0,
    "slash-normalized canonical names should match across hosts"
  );
});

test("agents sync codex->claude writes new flat Codex agent to top-level Claude path", () => {
  // When no Claude side exists for an incoming flat Codex agent, the destination
  // must be the top-level `.claude/agents/<name>.md` (no folder grouping invented).
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/agents"), { recursive: true });
  writeCodexAgent(join(fixture.project, ".codex/agents/new-agent.toml"), {
    name: "new-agent",
    description: "New agent",
    model: "gpt-5.4",
    developer_instructions: "New agent body",
  });

  runCli(
    fixture,
    ["sync", "--scope", "project", "--include", "agents:new-agent", "--apply"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "codex" }
  );

  assert.equal(existsSync(join(fixture.project, ".claude/agents/new-agent.md")), true);
});

test("agents sync claude->codex writes grouped Claude agent to flat Codex path", () => {
  // A Claude agent stored in a folder (group-x/agent-y.md) with a flat frontmatter
  // name must round-trip to a flat Codex filename keyed by the canonical name.
  const fixture = createFixture();
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/group-x/agent-y.md"),
    { name: "agent-y", description: "Agent Y", model: "opus" },
    "Agent Y body"
  );
  mkdirSync(join(fixture.project, ".codex/agents"), { recursive: true });

  runCli(fixture, [
    "sync",
    "--from",
    "claude",
    "--to",
    "codex",
    "--scope",
    "project",
    "--include",
    "agents:agent-y",
    "--apply",
  ]);

  assert.equal(existsSync(join(fixture.project, ".codex/agents/agent-y.toml")), true);
});

function callsArchivePath(output) {
  const match = output.match(/^Calls archive: (.+)$/m);
  assert.ok(match, "apply output should include a calls archive path");
  return match[1];
}

function writeSkillManifest(skillDir, host, body) {
  const filename = host === "claude" ? "skill.md" : "SKILL.md";
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, filename), body);
}

test("sync apply transforms Agent call inside skill body to Codex marker plus rendered prose", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/preview"),
    "claude",
    [
      "# Preview",
      'Agent({ description: "Run preview tests", subagent_type: "general-purpose", prompt: "Read .claude/agents/preview-tester.md and run." })',
      "",
    ].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:preview", "--apply"]);
  const codexBody = readFileSync(join(fixture.project, ".agents/skills/preview/SKILL.md"), "utf8");

  assert.match(codexBody, /<!-- ai-config-sync:agent-call \{/);
  assert.match(codexBody, /"call":"Agent"/);
  assert.match(codexBody, /"description":"Run preview tests"/);
  assert.match(codexBody, /"subagent_type":"general-purpose"/);
  assert.match(codexBody, /Use `spawn_agent` with agent_type: "Run preview tests"\./);
  assert.match(codexBody, /\nTask:\n/);
  assert.match(codexBody, /\.codex\/agents\/preview-tester\.toml/);
  assert.doesNotMatch(codexBody, /Agent\(\{/);
});

test("sync apply round-trips Codex agent-call marker back into Claude Agent({...}) call", () => {
  const fixture = createFixture();
  const codexSkillDir = join(fixture.project, ".agents/skills/preview");
  const markerFields = {
    description: "Run preview tests",
    subagent_type: "general-purpose",
    prompt: "Read .codex/agents/preview-tester.toml and run.",
  };
  const markerPayload = JSON.stringify({ call: "Agent", fields: markerFields });
  writeSkillManifest(
    codexSkillDir,
    "codex",
    [
      "# Preview",
      `<!-- ai-config-sync:agent-call ${markerPayload} -->`,
      'Use `spawn_agent` with agent_type: "Run preview tests".',
      "",
      "Task:",
      "Read .codex/agents/preview-tester.toml and run.",
      "",
    ].join("\n")
  );

  runCli(
    fixture,
    ["sync", "--scope", "project", "--include", "skills:preview", "--apply"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "codex" }
  );
  const claudeBody = readFileSync(join(fixture.project, ".claude/skills/preview/skill.md"), "utf8");

  assert.match(claudeBody, /Agent\(\{/);
  assert.match(claudeBody, /subagent_type: "general-purpose"/);
  assert.match(claudeBody, /description: "Run preview tests"/);
  assert.match(claudeBody, /prompt: "Read \.claude\/agents\/preview-tester\.md and run\."/);
});

test("sync apply leaves unparseable Agent call intact and emits a manual-review marker", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/preview"),
    "claude",
    ["# Preview", "Agent({ description: someVar, prompt: `Hello ${name}` })", ""].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:preview", "--apply"]);
  const codexBody = readFileSync(join(fixture.project, ".agents/skills/preview/SKILL.md"), "utf8");

  assert.match(codexBody, /Agent\(\{/);
  assert.match(codexBody, /<!-- ai-config-sync:manual-review [^>]*-->Agent\(\{/);
});

test("sync apply strips manual-review marker when copying Codex skill back to Claude", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".agents/skills/preview"),
    "codex",
    [
      "# Preview",
      '<!-- ai-config-sync:manual-review reason="cannot parse Agent arguments: argument is not a single object literal" -->Agent(',
      '  subagent_type: "insight-analyzer",',
      '  prompt: "Run it"',
      ")",
      "",
    ].join("\n")
  );

  runCli(fixture, [
    "sync",
    "--from",
    "codex",
    "--to",
    "claude",
    "--scope",
    "project",
    "--include",
    "skills:preview",
    "--apply",
  ]);
  const claudeBody = readFileSync(join(fixture.project, ".claude/skills/preview/skill.md"), "utf8");

  assert.match(claudeBody, /^Agent\($/m);
  assert.doesNotMatch(claudeBody, /ai-config-sync:manual-review/);
});

test("sync apply does not transform identifier-suffixed call names like MyAgent", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/preview"),
    "claude",
    ["# Preview", "MyAgent({ x: 1 })", ""].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:preview", "--apply"]);
  const codexBody = readFileSync(join(fixture.project, ".agents/skills/preview/SKILL.md"), "utf8");

  assert.match(codexBody, /MyAgent\(\{/);
  assert.doesNotMatch(codexBody, /<!-- ai-config-sync:agent-call /);
  assert.doesNotMatch(codexBody, /<!-- ai-config-sync:manual-review /);
});

test("sync apply leaves TaskCreate call verbatim when no template is registered", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/preview"),
    "claude",
    ["# Preview", 'TaskCreate({ items: ["task1","task2"] })', ""].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:preview", "--apply"]);
  const codexBody = readFileSync(join(fixture.project, ".agents/skills/preview/SKILL.md"), "utf8");

  assert.match(codexBody, /TaskCreate\(\{ items: \["task1","task2"\] \}\)/);
  assert.doesNotMatch(codexBody, /<!-- ai-config-sync:stripped /);
  assert.doesNotMatch(codexBody, /<!-- ai-config-sync:manual-review /);
});

test("sync apply transforms TeamCreate call with flat named-args + members array to per-member spawn_agent prose", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/preview"),
    "claude",
    [
      "# Preview",
      "TeamCreate(",
      '  team_name: "review-team",',
      "  members: [",
      '    { name: "code", agent_type: "browser-audit/code-security-auditor", model: "opus", prompt: "Audit code." },',
      '    { name: "browser", agent_type: "browser-audit/browser-runtime-auditor", model: "opus", prompt: "Audit runtime." }',
      "  ]",
      ")",
      "",
    ].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:preview", "--apply"]);
  const codexBody = readFileSync(join(fixture.project, ".agents/skills/preview/SKILL.md"), "utf8");

  assert.match(codexBody, /<!-- ai-config-sync:team-call \{/);
  assert.match(codexBody, /"call":"TeamCreate"/);
  assert.match(codexBody, /Use `multi_agent_v2\.spawn_agent` to launch the "review-team" team/);
  assert.match(
    codexBody,
    /### Member: code \(agent_type: "browser-audit\/code-security-auditor", model: "gpt-5\.6"\)/
  );
  assert.match(
    codexBody,
    /### Member: browser \(agent_type: "browser-audit\/browser-runtime-auditor", model: "gpt-5\.6"\)/
  );
  assert.doesNotMatch(codexBody, /TeamCreate\(/);
  assert.doesNotMatch(codexBody, /ai-config-sync:manual-review/);
});

test("sync apply parses Agent call written in flat named-arg form", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/preview"),
    "claude",
    [
      "# Preview",
      "Agent(",
      '  description: "Audit scope mapping",',
      '  subagent_type: "browser-audit/scope-mapper",',
      '  model: "opus",',
      '  prompt: "Map the audit scope."',
      ")",
      "",
    ].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:preview", "--apply"]);
  const codexBody = readFileSync(join(fixture.project, ".agents/skills/preview/SKILL.md"), "utf8");

  assert.match(codexBody, /<!-- ai-config-sync:agent-call \{/);
  assert.match(codexBody, /"call":"Agent"/);
  assert.match(codexBody, /Use `spawn_agent` with agent_type: "Audit scope mapping"\./);
  assert.doesNotMatch(codexBody, /Agent\(/);
  assert.doesNotMatch(codexBody, /ai-config-sync:manual-review/);
});

test("sync apply round-trips Codex team-call marker back into Claude TeamCreate({...}) call", () => {
  const fixture = createFixture();
  const codexSkillDir = join(fixture.project, ".agents/skills/preview");
  const markerFields = {
    team_name: "review-team",
    members: [
      { name: "code", agent_type: "browser-audit/code", model: "gpt-5.6", prompt: "Audit code." },
    ],
  };
  const markerPayload = JSON.stringify({ call: "TeamCreate", fields: markerFields });
  writeSkillManifest(
    codexSkillDir,
    "codex",
    [
      "# Preview",
      `<!-- ai-config-sync:team-call ${markerPayload} -->`,
      'Use `multi_agent_v2.spawn_agent` to launch the "review-team" team. Each member runs in parallel.',
      "",
      '### Member: code (agent_type: "browser-audit/code", model: "gpt-5.6")',
      "Audit code.",
      "",
      "",
    ].join("\n")
  );

  runCli(
    fixture,
    ["sync", "--scope", "project", "--include", "skills:preview", "--apply"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "codex" }
  );
  const claudeBody = readFileSync(join(fixture.project, ".claude/skills/preview/skill.md"), "utf8");

  assert.match(claudeBody, /TeamCreate\(\{/);
  assert.match(claudeBody, /team_name: "review-team"/);
  assert.match(claudeBody, /members:/);
  assert.doesNotMatch(claudeBody, /ai-config-sync:team-call/);
});

test("sync dry-run does not write the calls archive file to disk", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/preview"),
    "claude",
    ["# Preview", 'TaskCreate({ items: ["task1","task2"] })', ""].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:preview", "--dry-run"]);
  const backupsRoot = join(fixture.home, ".ai-config-sync-manager/backups");
  assert.equal(
    existsSync(backupsRoot),
    false,
    "dry-run should not create the backups directory or any archive file"
  );
});

test("sync apply renames lowercase Claude skill manifest to uppercase SKILL.md on Codex side", () => {
  const fixture = createFixture();
  writeSkillManifest(join(fixture.project, ".claude/skills/foo"), "claude", "# Foo\nbody\n");

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:foo", "--apply"]);
  const codexEntries = readdirSync(join(fixture.project, ".agents/skills/foo"));

  assert.ok(codexEntries.includes("SKILL.md"), `expected SKILL.md, got: ${codexEntries.join(",")}`);
  assert.ok(
    !codexEntries.includes("skill.md"),
    `did not expect skill.md in ${codexEntries.join(",")}`
  );
});

test("sync apply renames uppercase Codex skill manifest to lowercase skill.md on Claude side", () => {
  const fixture = createFixture();
  writeSkillManifest(join(fixture.project, ".codex/skills/bar"), "codex", "# Bar\nbody\n");

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:bar", "--apply"], undefined, {
    AI_CONFIG_SYNC_HOST: "codex",
  });
  const claudeEntries = readdirSync(join(fixture.project, ".claude/skills/bar"));

  assert.ok(
    claudeEntries.includes("skill.md"),
    `expected skill.md, got: ${claudeEntries.join(",")}`
  );
  assert.ok(
    !claudeEntries.includes("SKILL.md"),
    `did not expect SKILL.md in ${claudeEntries.join(",")}`
  );
});

test("sync apply rewrites skill.md body references to SKILL.md when copying to Codex", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/foo"),
    "claude",
    "# Foo\nRead skill.md for full details.\n"
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:foo", "--apply"]);
  const codexBody = readFileSync(join(fixture.project, ".agents/skills/foo/SKILL.md"), "utf8");

  assert.match(codexBody, /Read SKILL\.md for full details\./);
  assert.doesNotMatch(codexBody, /Read skill\.md for full details\./);
});

test("status treats identical skill content with mismatched manifest casing as no conflict", () => {
  const fixture = createFixture();
  const sharedBody = "# Foo\nshared body\n";
  writeSkillManifest(join(fixture.project, ".claude/skills/foo"), "claude", sharedBody);
  writeSkillManifest(join(fixture.project, ".agents/skills/foo"), "codex", sharedBody);

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills", "--json"])
  );
  const skillsEntries = report.entries.filter((entry) => entry.area === "skills");

  assert.equal(
    skillsEntries.length,
    0,
    `expected no skills entries, got: ${JSON.stringify(skillsEntries)}`
  );
});

test("status treats transformed skill content as equivalent after apply", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/foo"),
    "claude",
    "# Foo\nUse CLAUDE.md with Opus.\n"
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:foo", "--apply"]);
  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills:foo", "--json"])
  );
  const skillsEntries = report.entries.filter((entry) => entry.area === "skills");

  assert.equal(
    skillsEntries.length,
    0,
    `expected transformed skills to be equivalent, got: ${JSON.stringify(skillsEntries)}`
  );
});

test("status treats multi-file skills with mismatched manifest casing as no conflict", () => {
  const fixture = createFixture();
  const sharedManifest = "# Foo\nshared body\n";
  const sharedHelper = "shared helper text\n";
  const claudeDir = join(fixture.project, ".claude/skills/foo");
  const codexDir = join(fixture.project, ".agents/skills/foo");
  writeSkillManifest(claudeDir, "claude", sharedManifest);
  writeSkillManifest(codexDir, "codex", sharedManifest);
  mkdirSync(join(claudeDir, "helpers"), { recursive: true });
  mkdirSync(join(codexDir, "helpers"), { recursive: true });
  writeFileSync(join(claudeDir, "helpers/util.md"), sharedHelper);
  writeFileSync(join(codexDir, "helpers/util.md"), sharedHelper);

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills:foo", "--json"])
  );
  const skillsEntries = report.entries.filter((entry) => entry.area === "skills");

  assert.equal(
    skillsEntries.length,
    0,
    `expected no skills entries, got: ${JSON.stringify(skillsEntries)}`
  );
});

test("sync apply maps English agent-team term to canonical multiple spawn_agent invocations on Codex side", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/team"),
    "claude",
    "# Team\nUse agent team mode for parallel review.\n"
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:team", "--apply"]);
  const codexBody = readFileSync(join(fixture.project, ".agents/skills/team/SKILL.md"), "utf8");

  assert.match(codexBody, /Use multiple spawn_agent invocations for parallel review\./);
  assert.doesNotMatch(codexBody, /agent team mode/);
});

test("sync apply maps Korean agent-team term to canonical multiple spawn_agent invocations on Codex side", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/team"),
    "claude",
    "# Team\n에이전트팀 모드를 사용하라.\n"
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:team", "--apply"]);
  const codexBody = readFileSync(join(fixture.project, ".agents/skills/team/SKILL.md"), "utf8");

  assert.match(codexBody, /multiple spawn_agent invocations/);
  assert.doesNotMatch(codexBody, /에이전트팀/);
});

test("sync apply rewrites grouped Claude agent paths to flat Codex agent paths with hyphen-joined group prefix and .toml extension", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/agent-paths"),
    "claude",
    [
      "# Agent Paths",
      "에이전트 정의: ~/.claude/agents/insight-pipeline/{name}.md",
      "Concrete file: `.claude/agents/coderabbit/local-analyzer.md`",
      "Flat agent (no group): `~/.claude/agents/{name}.md`",
      "",
    ].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:agent-paths", "--apply"]);
  const codexBody = readFileSync(
    join(fixture.project, ".agents/skills/agent-paths/SKILL.md"),
    "utf8"
  );

  assert.match(codexBody, /~\/\.codex\/agents\/\{name\}\.toml/);
  assert.match(codexBody, /`\.codex\/agents\/local-analyzer\.toml`/);
  assert.doesNotMatch(codexBody, /\.claude\/agents\//);
  assert.doesNotMatch(codexBody, /\.codex\/agents\/[A-Za-z0-9_-]+\/.*\.md/);
  assert.doesNotMatch(codexBody, /agents\/insight-pipeline\//);
  assert.doesNotMatch(codexBody, /agents\/coderabbit-/);
  assert.doesNotMatch(codexBody, /agents\/insight-pipeline-/);
});

test("sync apply rewrites Claude workspace path prefixes (.claude/docs, .claude/hooks, .claude/insights) to Codex equivalents", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/paths"),
    "claude",
    [
      "# Paths",
      "Write reports under `{repo}/.claude/docs/repo-analysis/`.",
      "Hooks live in `~/.claude/hooks/coderabbit/`.",
      "Pending insights at `.claude/insights/commit-insight-pending.jsonl`.",
      "Singular form `.claude/insight/foo.json` is preserved.",
      "",
    ].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:paths", "--apply"]);
  const codexBody = readFileSync(join(fixture.project, ".agents/skills/paths/SKILL.md"), "utf8");

  assert.match(codexBody, /\{repo\}\/\.codex\/docs\/repo-analysis\//);
  assert.match(codexBody, /~\/\.codex\/hooks\/coderabbit\//);
  assert.match(codexBody, /\.codex\/insights\/commit-insight-pending\.jsonl/);
  assert.match(codexBody, /\.codex\/insight\/foo\.json/);
  assert.doesNotMatch(codexBody, /\.claude\/(docs|hooks|insights?)\b/);
});

test("sync apply preserves precise settings.json / mcp.json / config.toml mappings while rewriting other .claude/ prefixes generically", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/exceptions"),
    "claude",
    [
      "# Exceptions",
      "Edit `~/.claude/settings.json` to change permissions.",
      "MCP servers live in `~/.claude/mcp.json`.",
      "Hooks live under `~/.claude/hooks/coderabbit/`.",
      "Reports go to `{repo}/.claude/docs/repo-analysis/`.",
      "",
    ].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:exceptions", "--apply"]);
  const codexBody = readFileSync(
    join(fixture.project, ".agents/skills/exceptions/SKILL.md"),
    "utf8"
  );

  assert.match(codexBody, /`~\/\.codex\/config\.toml`/);
  assert.match(codexBody, /`~\/\.codex\/config\.toml \[mcp_servers\]`/);
  assert.match(codexBody, /`~\/\.codex\/hooks\/coderabbit\/`/);
  assert.match(codexBody, /`\{repo\}\/\.codex\/docs\/repo-analysis\/`/);
  assert.doesNotMatch(codexBody, /\.codex\/settings\.json/);
  assert.doesNotMatch(codexBody, /\.codex\/mcp\.json/);
  assert.doesNotMatch(codexBody, /\.claude\//);
});

test("sync apply preserves .claude/rules guidance paths instead of rewriting them to .codex/rules", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/rules-carveout"),
    "claude",
    [
      "# Rules Carveout",
      "Path scoped rules live under `.claude/rules/go.md`.",
      "Non-segment match `.claude/rulesfoo/bar.md` is still swapped.",
      "",
    ].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:rules-carveout", "--apply"]);
  const codexBody = readFileSync(
    join(fixture.project, ".agents/skills/rules-carveout/SKILL.md"),
    "utf8"
  );

  assert.match(codexBody, /\.claude\/rules\/go\.md/);
  assert.doesNotMatch(codexBody, /\.codex\/rules\/go\.md/);
  assert.match(codexBody, /\.codex\/rulesfoo\/bar\.md/);
});

test("sync apply rewrites prose mentions of TeamCreate to multiple spawn_agent invocations on Codex side", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/team-prose"),
    "claude",
    "# Team\n`TeamCreate` 로 아래 팀 구성한다.\n"
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:team-prose", "--apply"]);
  const codexBody = readFileSync(
    join(fixture.project, ".agents/skills/team-prose/SKILL.md"),
    "utf8"
  );

  assert.match(codexBody, /`multiple spawn_agent invocations` 로 아래 팀 구성한다\./);
  assert.doesNotMatch(codexBody, /TeamCreate/);
});

test("sync apply rewrites prose mentions of TaskCreate / TaskUpdate to spawn_agent on Codex side", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/task-prose"),
    "claude",
    "# Task\n각 분석가에게 `TaskCreate` 로 동시 할당하고 `TaskUpdate` 로 진행 상태를 갱신한다.\n"
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:task-prose", "--apply"]);
  const codexBody = readFileSync(
    join(fixture.project, ".agents/skills/task-prose/SKILL.md"),
    "utf8"
  );

  assert.match(codexBody, /`spawn_agent` 로 동시 할당하고 `spawn_agent` 로 진행 상태를 갱신한다\./);
  assert.doesNotMatch(codexBody, /TaskCreate|TaskUpdate/);
});

test("sync apply preserves TeamCreate fields inside ai-config-sync team-call marker JSON (round-trip safe)", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/round-trip"),
    "claude",
    [
      "# Round Trip",
      'TeamCreate({ team_name: "alpha", members: [{ name: "a", agent_type: "x", model: "opus", prompt: "do" }] })',
      "",
    ].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:round-trip", "--apply"]);
  const codexBody = readFileSync(
    join(fixture.project, ".agents/skills/round-trip/SKILL.md"),
    "utf8"
  );

  assert.match(codexBody, /"call":"TeamCreate"/);
  assert.match(codexBody, /"team_name":"alpha"/);
  assert.match(codexBody, /"members":/);
  assert.doesNotMatch(codexBody, /TeamCreate\(/);
});

test("sync apply rewrites prose mentions of SendMessage to send_input on Codex side", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/send"),
    "claude",
    "# Send\n충돌 회피용으로 `SendMessage` 만 사용한다.\n"
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:send", "--apply"]);
  const codexBody = readFileSync(join(fixture.project, ".agents/skills/send/SKILL.md"), "utf8");

  assert.match(codexBody, /`send_input` 만 사용한다\./);
  assert.doesNotMatch(codexBody, /SendMessage/);
});

test("sync apply rewrites headless `claude -p` invocation to `codex exec` on Codex side", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/headless"),
    "claude",
    "# Headless\nbackground orchestration via headless `claude -p` and `claude --print` modes.\n"
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:headless", "--apply"]);
  const codexBody = readFileSync(join(fixture.project, ".agents/skills/headless/SKILL.md"), "utf8");

  assert.match(codexBody, /headless `codex exec` and `codex exec` modes\./);
  assert.doesNotMatch(codexBody, /claude -p|claude --print/);
});

test("sync apply rewrites Codex `codex exec` mention back to Claude `claude -p` on Claude side", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".agents/skills/headless-back"),
    "codex",
    "# Headless\nbackground orchestration via headless `codex exec`.\n"
  );

  runCli(fixture, [
    "sync",
    "--from",
    "codex",
    "--to",
    "claude",
    "--scope",
    "project",
    "--include",
    "skills:headless-back",
    "--apply",
  ]);
  const claudeBody = readFileSync(
    join(fixture.project, ".claude/skills/headless-back/SKILL.md"),
    "utf8"
  );

  assert.match(claudeBody, /headless `claude -p`\./);
  assert.doesNotMatch(claudeBody, /codex exec/);
});

test("sync apply maps bare Claude Bash permission to a bash-scoped Codex prefix_rule", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: ["Bash"] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  runCli(fixture, ["sync", "--scope", "project", "--include", "permissions:Bash", "--apply"]);
  const rules = readFileSync(join(fixture.project, ".codex/rules/default.rules"), "utf8");

  assert.match(rules, /prefix_rule\(pattern=\["bash"\], decision="allow"/);
  assert.doesNotMatch(rules, /prefix_rule\(pattern=\[\],/);
});

test("sync apply maps Codex bash-scoped prefix_rule back to bare Claude Bash permission", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex/rules"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), { permissions: {} });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");
  writeFileSync(
    join(fixture.project, ".codex/rules/default.rules"),
    'prefix_rule(pattern=["bash"], decision="allow", justification="test")\n'
  );

  runCli(fixture, [
    "sync",
    "--from",
    "codex",
    "--to",
    "claude",
    "--scope",
    "project",
    "--include",
    "permissions:Bash",
    "--apply",
  ]);
  const settings = JSON.parse(readFileSync(join(fixture.project, ".claude/settings.json"), "utf8"));

  assert.deepEqual(settings.permissions.allow, ["Bash"]);
  assert.ok(!settings.permissions.allow?.includes("Bash(bash:*)"));
});

test("sync apply round-trips bare Claude Bash permission through Codex without drift", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: ["Bash"] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  runCli(fixture, ["sync", "--scope", "project", "--include", "permissions:Bash", "--apply"]);
  writeJson(join(fixture.project, ".claude/settings.json"), { permissions: {} });
  runCli(fixture, [
    "sync",
    "--from",
    "codex",
    "--to",
    "claude",
    "--scope",
    "project",
    "--include",
    "permissions:Bash",
    "--apply",
  ]);
  const settings = JSON.parse(readFileSync(join(fixture.project, ".claude/settings.json"), "utf8"));

  assert.deepEqual(settings.permissions.allow, ["Bash"]);
});

test("sync apply preserves compound Bash permission round-trip without collapsing to bare Bash", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: ["Bash(git status:*)", "Bash(npm:*)"] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:Bash(git status:*),permissions:Bash(npm:*)",
    "--apply",
  ]);
  const rules = readFileSync(join(fixture.project, ".codex/rules/default.rules"), "utf8");
  assert.match(rules, /prefix_rule\(pattern=\["git","status"\], decision="allow"/);
  assert.match(rules, /prefix_rule\(pattern=\["npm"\], decision="allow"/);

  writeJson(join(fixture.project, ".claude/settings.json"), { permissions: {} });
  runCli(fixture, [
    "sync",
    "--from",
    "codex",
    "--to",
    "claude",
    "--scope",
    "project",
    "--include",
    "permissions:Bash(git status:*),permissions:Bash(npm:*)",
    "--apply",
  ]);
  const settings = JSON.parse(readFileSync(join(fixture.project, ".claude/settings.json"), "utf8"));
  assert.ok(settings.permissions.allow.includes("Bash(git status:*)"));
  assert.ok(settings.permissions.allow.includes("Bash(npm:*)"));
  assert.ok(!settings.permissions.allow.includes("Bash"));
});

test("sync apply treats legacy Codex prefix_rule with empty pattern as bare Claude Bash permission", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex/rules"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), { permissions: {} });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");
  writeFileSync(
    join(fixture.project, ".codex/rules/default.rules"),
    'prefix_rule(pattern=[], decision="allow", justification="legacy")\n'
  );

  runCli(fixture, [
    "sync",
    "--from",
    "codex",
    "--to",
    "claude",
    "--scope",
    "project",
    "--include",
    "permissions:Bash",
    "--apply",
  ]);
  const settings = JSON.parse(readFileSync(join(fixture.project, ".claude/settings.json"), "utf8"));

  assert.deepEqual(settings.permissions.allow, ["Bash"]);
});

test("sync apply maps allow:WebSearch to web_search=live without flipping approval_policy", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: ["WebSearch"] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  runCli(fixture, ["sync", "--scope", "project", "--include", "permissions:WebSearch", "--apply"]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.match(config, /web_search = "live"/);
  assert.doesNotMatch(config, /approval_policy = "on-request"/);
  assert.doesNotMatch(config, /# permissions\.allow = "WebSearch"/);
});

test("sync apply round-trips allow:WebSearch through Codex without drift", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: ["WebSearch"] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  runCli(fixture, ["sync", "--scope", "project", "--include", "permissions:WebSearch", "--apply"]);
  writeJson(join(fixture.project, ".claude/settings.json"), { permissions: {} });
  runCli(fixture, [
    "sync",
    "--from",
    "codex",
    "--to",
    "claude",
    "--scope",
    "project",
    "--include",
    "permissions:WebSearch",
    "--apply",
  ]);
  const settings = JSON.parse(readFileSync(join(fixture.project, ".claude/settings.json"), "utf8"));

  assert.deepEqual(settings.permissions.allow, ["WebSearch"]);
});

test("sync apply emits a lossy round-trip review note for allow:WebFetch", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: ["WebFetch"] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const plan = JSON.parse(
    runCli(fixture, [
      "sync",
      "--scope",
      "project",
      "--include",
      "permissions:WebFetch",
      "--plan-json",
    ])
  );
  runCli(fixture, ["sync", "--scope", "project", "--include", "permissions:WebFetch", "--apply"]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.match(config, /web_search = "live"/);
  assert.deepEqual(plan.operations[0].reviewNotes, [
    'WebFetch: maps to config.toml web_search = "live"; reverse sync will normalize to WebSearch (lossy)',
  ]);
});

test("sync apply maps allow:mcp tools into enabled_tools array idempotently", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: ["mcp__github__create_issue"] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:mcp__github__create_issue",
    "--apply",
  ]);
  const firstApply = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.match(firstApply, /\[mcp_servers\.github\]/);
  assert.match(firstApply, /enabled_tools = \["create_issue"\]/);
  assert.match(firstApply, /\[mcp_servers\.github\.tools\.create_issue\]/);
  assert.match(firstApply, /approval_mode = "approve"/);

  runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:mcp__github__create_issue",
    "--apply",
  ]);
  const secondApply = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.equal(
    (secondApply.match(/enabled_tools = \[/g) ?? []).length,
    1,
    "second apply should not duplicate enabled_tools"
  );
  assert.doesNotMatch(secondApply, /enabled_tools = \["create_issue", "create_issue"\]/);
});

test("sync apply maps deny:mcp tools into disabled_tools and approval_mode=deny", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { deny: ["mcp__github__delete_repo"] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:deny:mcp__github__delete_repo",
    "--apply",
  ]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.match(config, /disabled_tools = \["delete_repo"\]/);
  assert.match(config, /\[mcp_servers\.github\.tools\.delete_repo\]\napproval_mode = "deny"/);
});

test("sync apply maps ask:mcp tools to approval_mode=prompt without touching enabled/disabled arrays", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { ask: ["mcp__github__push_files"] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:ask:mcp__github__push_files",
    "--apply",
  ]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.match(config, /\[mcp_servers\.github\.tools\.push_files\]\napproval_mode = "prompt"/);
  assert.doesNotMatch(config, /enabled_tools/);
  assert.doesNotMatch(config, /disabled_tools/);
});

test("sync apply only sets approval_policy=on-request when at least one item is in the ask bucket", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { ask: ["WebFetch"] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:ask:WebFetch",
    "--apply",
  ]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.match(config, /approval_policy = "on-request"/);
  assert.doesNotMatch(config, /web_search = "live"/);
});

test("sync apply treats bare allow:Agent as a no-op with no archive entry", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: ["Agent"] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const output = runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:Agent",
    "--apply",
  ]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");
  const archivePath = join(backupRoot(output), "unsupported-calls.json");

  assert.doesNotMatch(config, /approval_policy/);
  assert.doesNotMatch(config, /web_search/);
  assert.doesNotMatch(config, /# permissions\.allow = "Agent"/);
  assert.doesNotMatch(config, /\[mcp_servers/);
  assert.equal(existsSync(archivePath), false, "no archive should be written for bare allow:Agent");
});

test("sync apply skips deny:Agent because the item has no codex mapping", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { deny: ["Agent"] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const output = runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:deny:Agent",
    "--apply",
  ]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");
  const archivePath = join(backupRoot(output), "unsupported-calls.json");

  assert.doesNotMatch(config, /approval_policy/);
  assert.doesNotMatch(config, /web_search/);
  assert.doesNotMatch(config, /# permissions\.deny = "Agent"/);
  assert.equal(
    existsSync(archivePath),
    false,
    "deny:Agent now classifies as unsupported drift and is hidden, so no archive entry is produced"
  );
});

test("status reads sandbox_workspace_write.network_access=true as a WebFetch reverse permission item", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), { permissions: {} });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    ["[sandbox_workspace_write]", "network_access = true", ""].join("\n")
  );

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "permissions:WebFetch", "--json"])
  );

  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].area, "permissions");
  assert.ok(
    report.entries[0].missingInClaude.includes("WebFetch") ||
      report.entries[0].missingInClaude.includes("allow:WebFetch"),
    `expected missingInClaude to contain WebFetch, got ${JSON.stringify(report.entries[0].missingInClaude)}`
  );
});

test("reverse status ignores stale permission comments without matching native config", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), { permissions: {} });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    [
      "# BEGIN ai-config-sync permissions",
      '# permissions.allow = "WebFetch"',
      '# permissions.ask = "WebSearch"',
      "# END ai-config-sync permissions",
      "",
    ].join("\n")
  );

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "permissions", "--json"])
  );

  const permissionEntries = report.entries.filter((entry) => entry.area === "permissions");
  for (const entry of permissionEntries) {
    assert.ok(
      !entry.missingInClaude.some((item) => item === "WebFetch" || item === "allow:WebFetch"),
      `expected stale WebFetch comment to be ignored, got missingInClaude=${JSON.stringify(entry.missingInClaude)}`
    );
    assert.ok(
      !entry.missingInClaude.some((item) => item === "WebSearch" || item === "ask:WebSearch"),
      `expected stale ask:WebSearch comment to be ignored, got missingInClaude=${JSON.stringify(entry.missingInClaude)}`
    );
  }
});

test("reverse status ignores stale hook comments without native [[hooks.*]] table", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), { hooks: {} });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    [
      "# BEGIN ai-config-sync hooks",
      '# hooks.PreToolUse = [{"hooks":[{"type":"webhook","url":"https://example.invalid/hook"}]}]',
      "# END ai-config-sync hooks",
      "",
    ].join("\n")
  );

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "hooks", "--json"])
  );

  const hookEntries = report.entries.filter((entry) => entry.area === "hooks");
  for (const entry of hookEntries) {
    assert.ok(
      !entry.missingInClaude.includes("PreToolUse"),
      `expected stale PreToolUse comment to be ignored, got missingInClaude=${JSON.stringify(entry.missingInClaude)}`
    );
  }
});

test("status appends rules/default.rules to codex path summary when permissions touch prefix rules", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: ["Bash(git:*)"] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const output = runCli(fixture, ["status", "--scope", "project", "--include", "permissions"]);

  const expectedRulesPath = join(realpathSync(fixture.project), ".codex/rules/default.rules");
  assert.ok(
    output.includes(`+ ${expectedRulesPath}`),
    `expected codex path summary to mention default.rules, got:\n${output}`
  );
});

test("status hides unsupported Agent permission items as drift", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: {
      allow: ["Agent(general-purpose)", "Bash(git:*)"],
      deny: ["Agent"],
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "permissions", "--json"])
  );

  const permissions = report.entries.find((entry) => entry.area === "permissions");
  assert.ok(permissions, "expected a permissions diff entry");
  for (const item of permissions.missingInCodex) {
    assert.ok(
      !item.includes("Agent"),
      `unsupported Agent item should be hidden as drift, got ${item}`
    );
  }
  // The supported Bash item should still surface.
  assert.ok(
    permissions.missingInCodex.some(
      (item) => item === "allow:Bash(git:*)" || item === "Bash(git:*)"
    ),
    "expected supported Bash item to remain in drift"
  );
});

test("sync apply maps server-level allow:mcp__<server> to a noop when codex already has the bare server table", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: ["mcp__notion"] },
  });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    ["[mcp_servers.notion]", 'url = "https://mcp.notion.com/mcp"', ""].join("\n")
  );

  // status should not flag drift because codex defaults already permit every tool.
  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "permissions", "--json"])
  );
  assert.equal(
    report.entries.length,
    0,
    `expected no drift, got ${JSON.stringify(report.entries)}`
  );

  // Apply still succeeds and remains idempotent.
  runCli(fixture, ["sync", "--scope", "project", "--include", "permissions", "--apply"]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");
  assert.match(config, /\[mcp_servers\.notion\]/);
  assert.doesNotMatch(config, /enabled_tools/);
  assert.doesNotMatch(config, /# permissions\.allow = "mcp__notion"/);
});

test("sync apply maps server-level deny:mcp__<server> to enabled_tools = []", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { deny: ["mcp__notion"] },
  });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    ["[mcp_servers.notion]", 'url = "https://mcp.notion.com/mcp"', ""].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "permissions", "--apply"]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.match(config, /\[mcp_servers\.notion\]/);
  assert.match(config, /enabled_tools = \[\]/);
});

test("sync apply maps wildcard tool allow:mcp__<server>__* as a server-scope noop", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: ["mcp__notion__*"] },
  });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    ["[mcp_servers.notion]", 'url = "https://mcp.notion.com/mcp"', ""].join("\n")
  );

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "permissions", "--json"])
  );
  assert.equal(report.entries.length, 0);

  runCli(fixture, ["sync", "--scope", "project", "--include", "permissions", "--apply"]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.match(config, /\[mcp_servers\.notion\]/);
  assert.doesNotMatch(config, /enabled_tools/);
  assert.doesNotMatch(config, /\.tools\./);
});

test("sync apply maps allow:mcp__<server>__<tool> when codex has only the bare server table", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: ["mcp__notion__create_page"] },
  });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    ["[mcp_servers.notion]", 'url = "https://mcp.notion.com/mcp"', ""].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "permissions", "--apply"]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.match(config, /\[mcp_servers\.notion\]/);
  assert.match(config, /url = "https:\/\/mcp\.notion\.com\/mcp"/);
  assert.match(config, /enabled_tools = \["create_page"\]/);
  assert.match(config, /\[mcp_servers\.notion\.tools\.create_page\]\napproval_mode = "approve"/);

  // Idempotency: a second apply should leave the file functionally identical.
  runCli(fixture, ["sync", "--scope", "project", "--include", "permissions", "--apply"]);
  const second = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");
  assert.equal(
    (second.match(/enabled_tools = \[/g) ?? []).length,
    1,
    "second apply must not duplicate enabled_tools"
  );
  assert.equal(
    (second.match(/\[mcp_servers\.notion\.tools\.create_page\]/g) ?? []).length,
    1,
    "second apply must not duplicate the tool subtable"
  );
});

test("status treats allow:WebFetch and codex web_search=live as the same capability", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: ["WebFetch"] },
  });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    ['web_search = "live"', ""].join("\n")
  );

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "permissions", "--json"])
  );

  const permissions = report.entries.filter((entry) => entry.area === "permissions");
  for (const entry of permissions) {
    assert.ok(
      !entry.missingInCodex.some((item) => item === "WebFetch" || item === "allow:WebFetch"),
      `expected WebFetch to match codex web_search=live, got missingInCodex=${JSON.stringify(entry.missingInCodex)}`
    );
  }
});

test("sync apply removes Codex prefix_rule when matching Bash permission is dropped from Claude", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex/rules"), { recursive: true });
  // Claude side: no Bash(claude -p:*) anymore.
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: [] },
  });
  // Codex side: has the rule the previous forward sync would have written.
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");
  writeFileSync(
    join(fixture.project, ".codex/rules/default.rules"),
    [
      "# BEGIN ai-config-sync permissions-rules",
      'prefix_rule(pattern=["claude","-p"], decision="allow", justification="Migrated from Claude allow permission Bash(claude -p:*).")',
      "# END ai-config-sync permissions-rules",
      "",
    ].join("\n")
  );

  const output = runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:Bash(claude -p:*)",
    "--apply",
  ]);
  const rules = readFileSync(join(fixture.project, ".codex/rules/default.rules"), "utf8");

  assert.match(output, /deleted permissions item\(s\) from codex/);
  assert.doesNotMatch(rules, /prefix_rule\(pattern=\["claude","-p"\]/);

  // Idempotent: a second apply on the same input must not error or revive the rule.
  runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:Bash(claude -p:*)",
    "--apply",
  ]);
  const rulesAgain = readFileSync(join(fixture.project, ".codex/rules/default.rules"), "utf8");
  assert.doesNotMatch(rulesAgain, /prefix_rule\(pattern=\["claude","-p"\]/);
});

test("sync apply removes Codex enabled_tools entry and tool subtable when MCP permission is dropped from Claude", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: [] },
  });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    [
      "[mcp_servers.notion]",
      'enabled_tools = ["create_page"]',
      "",
      "[mcp_servers.notion.tools.create_page]",
      'approval_mode = "approve"',
      "",
    ].join("\n")
  );

  runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:mcp__notion__create_page",
    "--apply",
  ]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.doesNotMatch(config, /\[mcp_servers\.notion\.tools\.create_page\]/);
  assert.doesNotMatch(config, /enabled_tools = \["create_page"\]/);
});

test("sync apply preserves sandbox_mode when only one of Write/Edit/MultiEdit is dropped from Claude", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  // Claude still keeps Edit and MultiEdit, only Write was removed.
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: ["Edit", "MultiEdit"] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), 'sandbox_mode = "workspace-write"\n');

  runCli(fixture, ["sync", "--scope", "project", "--include", "permissions:Write", "--apply"]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.match(config, /sandbox_mode = "workspace-write"/);
});

test("sync apply removes sandbox_mode when all Write/Edit/MultiEdit are dropped from Claude", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: [] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), 'sandbox_mode = "workspace-write"\n');

  runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:Write,permissions:Edit,permissions:MultiEdit",
    "--apply",
  ]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.doesNotMatch(config, /sandbox_mode = "workspace-write"/);
});

test("sync apply removes web_search when WebSearch and WebFetch are dropped from Claude", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: [] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), 'web_search = "live"\n');

  runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:WebSearch,permissions:WebFetch",
    "--apply",
  ]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.doesNotMatch(config, /web_search = "live"/);
});

test("sync apply preserves web_search when only WebSearch is dropped but WebFetch remains in Claude", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: ["WebFetch"] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), 'web_search = "live"\n');

  runCli(fixture, ["sync", "--scope", "project", "--include", "permissions:WebSearch", "--apply"]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.match(config, /web_search = "live"/);
});

test("status emits each permission item exactly once after dual-form fix", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  // Codex has a Bash permission (via prefix_rule), Claude has none. Expect a single
  // "missing in claude" entry, not duplicated as both `allow:Bash(...)` and `Bash(...)`.
  writeJson(join(fixture.project, ".claude/settings.json"), { permissions: { allow: [] } });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");
  mkdirSync(join(fixture.project, ".codex/rules"), { recursive: true });
  writeFileSync(
    join(fixture.project, ".codex/rules/default.rules"),
    [
      "# BEGIN ai-config-sync permissions-rules",
      'prefix_rule(pattern=["claude","-p"], decision="allow", justification="Migrated from Claude allow permission Bash(claude -p:*).")',
      "# END ai-config-sync permissions-rules",
      "",
    ].join("\n")
  );

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "permissions", "--json"])
  );
  const permissions = report.entries.filter((entry) => entry.area === "permissions");

  for (const entry of permissions) {
    const missing = entry.missingInClaude ?? [];
    const matchingForms = missing.filter(
      (item) => item === "Bash(claude -p:*)" || item === "allow:Bash(claude -p:*)"
    );
    assert.equal(
      matchingForms.length,
      1,
      `expected exactly one form, got ${JSON.stringify(matchingForms)}`
    );
  }
});

test("status filters allow:SendMessage from missing-in-codex drift as unsupported", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: ["SendMessage"] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "permissions", "--json"])
  );
  const permissions = report.entries.filter((entry) => entry.area === "permissions");

  for (const entry of permissions) {
    assert.ok(
      !(entry.missingInCodex ?? []).some((item) => item.endsWith("SendMessage")),
      `expected SendMessage to be filtered as unsupported, got ${JSON.stringify(entry.missingInCodex)}`
    );
  }
});

test("permission review notes carry preserved-as-metadata-only message for SendMessage", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: ["SendMessage", "Bash(npm run check:*)"] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  // Status filters SendMessage so it never reaches the plan; cover the review-note
  // helper path directly via a synthesized include that bypasses the filter by
  // also containing a non-unsupported item — confirm SendMessage isn't planned.
  const plan = JSON.parse(
    runCli(fixture, ["sync", "--scope", "project", "--include", "permissions", "--plan-json"])
  );

  const planned = (plan.operations ?? []).flatMap((op) => op.itemNames ?? []);
  assert.ok(
    !planned.some((item) => item.endsWith("SendMessage")),
    `expected SendMessage to be filtered out of plan items, got ${JSON.stringify(planned)}`
  );
});

test("sync apply round-trips Bash native delete with no further drift on subsequent status", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex/rules"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: [] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");
  writeFileSync(
    join(fixture.project, ".codex/rules/default.rules"),
    [
      "# BEGIN ai-config-sync permissions-rules",
      'prefix_rule(pattern=["claude","-p"], decision="allow", justification="Migrated from Claude allow permission Bash(claude -p:*).")',
      "# END ai-config-sync permissions-rules",
      "",
    ].join("\n")
  );

  runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:Bash(claude -p:*)",
    "--apply",
  ]);

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "permissions", "--json"])
  );
  const permissions = report.entries.filter((entry) => entry.area === "permissions");
  for (const entry of permissions) {
    assert.equal(
      (entry.missingInClaude ?? []).length,
      0,
      `unexpected drift: ${JSON.stringify(entry.missingInClaude)}`
    );
    assert.equal(
      (entry.missingInCodex ?? []).length,
      0,
      `unexpected drift: ${JSON.stringify(entry.missingInCodex)}`
    );
  }
});

test("sync apply success message names rules/default.rules when only Bash permissions are deleted from codex", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex/rules"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: [] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");
  writeFileSync(
    join(fixture.project, ".codex/rules/default.rules"),
    [
      "# BEGIN ai-config-sync permissions-rules",
      'prefix_rule(pattern=["claude","-p"], decision="allow", justification="Migrated from Claude allow permission Bash(claude -p:*).")',
      'prefix_rule(pattern=["claude","plugin"], decision="allow", justification="Migrated from Claude allow permission Bash(claude plugin:*).")',
      "# END ai-config-sync permissions-rules",
      "",
    ].join("\n")
  );

  const output = runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:Bash(claude -p:*),permissions:Bash(claude plugin:*)",
    "--apply",
  ]);

  assert.match(output, /deleted permissions item\(s\) from codex \(rules\/default\.rules\):/);
  const successLine = output
    .split("\n")
    .find((line) => line.includes("deleted permissions item(s) from codex"));
  assert.ok(successLine, "expected a success line for the codex permissions delete");
  assert.doesNotMatch(successLine, /config\.toml/);
});

test("sync apply success message names config.toml + rules/default.rules when Bash and mcp permissions are deleted from codex", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex/rules"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: [] },
  });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    [
      "[mcp_servers.notion]",
      'enabled_tools = ["create_page"]',
      "",
      "[mcp_servers.notion.tools.create_page]",
      'approval_mode = "approve"',
      "",
    ].join("\n")
  );
  writeFileSync(
    join(fixture.project, ".codex/rules/default.rules"),
    [
      "# BEGIN ai-config-sync permissions-rules",
      'prefix_rule(pattern=["claude","-p"], decision="allow", justification="Migrated from Claude allow permission Bash(claude -p:*).")',
      "# END ai-config-sync permissions-rules",
      "",
    ].join("\n")
  );

  const output = runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:Bash(claude -p:*),permissions:mcp__notion__create_page",
    "--apply",
  ]);

  assert.match(
    output,
    /deleted permissions item\(s\) from codex \(config\.toml \+ rules\/default\.rules\):/
  );
});

test("sync apply deletes prefix_rule with no spaces inside the JSON array (forward writer's exact format)", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex/rules"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: [] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");
  writeFileSync(
    join(fixture.project, ".codex/rules/default.rules"),
    'prefix_rule(pattern=["a","b"], decision="allow", justification="Migrated from Claude allow permission Bash(a b:*).")\n'
  );

  runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:Bash(a b:*)",
    "--apply",
  ]);

  const rules = readFileSync(join(fixture.project, ".codex/rules/default.rules"), "utf8");
  assert.doesNotMatch(rules, /prefix_rule/);
});

test("sync apply deletes prefix_rule written with spaces inside the JSON array and no justification", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex/rules"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: [] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");
  writeFileSync(
    join(fixture.project, ".codex/rules/default.rules"),
    'prefix_rule(pattern=["a", "b"], decision="allow")\n'
  );

  runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:Bash(a b:*)",
    "--apply",
  ]);

  const rules = readFileSync(join(fixture.project, ".codex/rules/default.rules"), "utf8");
  assert.doesNotMatch(rules, /prefix_rule/);
});

test("sync apply deletes the user's exact three prefix_rule lines from the bug report", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex/rules"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: [] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");
  writeFileSync(
    join(fixture.project, ".codex/rules/default.rules"),
    [
      'prefix_rule(pattern=["rm", "-rf", "dist/claude-marketplace"], decision="allow")',
      'prefix_rule(pattern=["claude", "-p"], decision="allow")',
      'prefix_rule(pattern=["claude", "plugin"], decision="allow")',
      "",
    ].join("\n")
  );

  runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:Bash(rm -rf dist/claude-marketplace:*),permissions:Bash(claude -p:*),permissions:Bash(claude plugin:*)",
    "--apply",
  ]);

  const rules = readFileSync(join(fixture.project, ".codex/rules/default.rules"), "utf8");
  assert.doesNotMatch(
    rules,
    /prefix_rule/,
    `expected all three prefix_rule lines to be removed, got:\n${rules}`
  );
});

test("sync apply prefix_rule delete is idempotent across whitespace-variant lines", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex/rules"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: [] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");
  writeFileSync(
    join(fixture.project, ".codex/rules/default.rules"),
    'prefix_rule(pattern=["claude", "-p"], decision="allow")\n'
  );

  runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:Bash(claude -p:*)",
    "--apply",
  ]);
  const afterFirst = readFileSync(join(fixture.project, ".codex/rules/default.rules"), "utf8");

  runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:Bash(claude -p:*)",
    "--apply",
  ]);
  const afterSecond = readFileSync(join(fixture.project, ".codex/rules/default.rules"), "utf8");

  assert.equal(
    afterSecond,
    afterFirst,
    "second delete should leave the file identical to the first delete"
  );
  assert.doesNotMatch(afterFirst, /prefix_rule/);
});

test("sync apply prefix_rule delete leaves non-matching parts untouched", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex/rules"), { recursive: true });
  writeJson(join(fixture.project, ".claude/settings.json"), {
    permissions: { allow: [] },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");
  writeFileSync(
    join(fixture.project, ".codex/rules/default.rules"),
    'prefix_rule(pattern=["claude", "-p", "extra"], decision="allow")\n'
  );

  runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "permissions:Bash(claude -p:*)",
    "--apply",
  ]);

  const rules = readFileSync(join(fixture.project, ".codex/rules/default.rules"), "utf8");
  assert.match(rules, /prefix_rule\(pattern=\["claude", "-p", "extra"\]/);
});

test("sync apply quotes unquoted colon-containing skill description on copy", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/foo"),
    "claude",
    [
      "---",
      "name: foo",
      "description: First sentence. bias warning: edge case.",
      "---",
      "body",
      "",
    ].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:foo", "--apply"]);
  const codexManifest = readFileSync(join(fixture.project, ".agents/skills/foo/SKILL.md"), "utf8");

  assert.match(codexManifest, /^description: "First sentence\. bias warning: edge case\."$/m);
  assert.match(codexManifest, /^body$/m);
});

test("sync apply preserves already-quoted skill description on copy", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/foo"),
    "claude",
    ["---", "name: foo", 'description: "valid"', "---", "body", ""].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:foo", "--apply"]);
  const codexManifest = readFileSync(join(fixture.project, ".agents/skills/foo/SKILL.md"), "utf8");

  const descriptionMatch = codexManifest.match(/^description:\s*(.+)$/m);
  assert.ok(descriptionMatch, "description should be present in destination");
  const rawDescription = descriptionMatch[1].trim();
  const parsedDescription = rawDescription.startsWith('"')
    ? JSON.parse(rawDescription)
    : rawDescription;
  assert.equal(parsedDescription, "valid");
});

test("sync apply leaves no-frontmatter skill manifest content untouched", () => {
  const fixture = createFixture();
  const sourceBody = ["# Foo", "", "Plain body without YAML frontmatter.", ""].join("\n");
  writeSkillManifest(join(fixture.project, ".claude/skills/foo"), "claude", sourceBody);

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:foo", "--apply"]);
  const codexManifest = readFileSync(join(fixture.project, ".agents/skills/foo/SKILL.md"), "utf8");

  assert.equal(codexManifest, sourceBody);
});

test("sync apply quotes skill description containing colon-space and tilde from real-world bug", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/code-writer"),
    "claude",
    [
      "---",
      "name: code-writer",
      "description: Routes code to specialized agents. bias warning: ~ guidance for edge cases.",
      "---",
      "body",
      "",
    ].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:code-writer", "--apply"]);
  const codexManifest = readFileSync(
    join(fixture.project, ".agents/skills/code-writer/SKILL.md"),
    "utf8"
  );

  const descriptionMatch = codexManifest.match(/^description:\s*(.+)$/m);
  assert.ok(descriptionMatch, "description should be present in destination");
  const rawDescription = descriptionMatch[1].trim();
  assert.ok(
    rawDescription.startsWith('"') && rawDescription.endsWith('"'),
    `description should be JSON-quoted, got: ${rawDescription}`
  );
  const parsedDescription = JSON.parse(rawDescription);
  assert.equal(
    parsedDescription,
    "Routes code to specialized agents. bias warning: ~ guidance for edge cases."
  );
});

test("sync apply normalizes frontmatter while still applying terminology body transforms", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/foo"),
    "claude",
    [
      "---",
      "name: foo",
      "description: First sentence. bias warning: keep an eye out.",
      "---",
      "Use a Claude subagent for the task.",
      "",
    ].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:foo", "--apply"]);
  const codexManifest = readFileSync(join(fixture.project, ".agents/skills/foo/SKILL.md"), "utf8");

  assert.match(codexManifest, /^description: "First sentence\. bias warning: keep an eye out\."$/m);
  assert.match(codexManifest, /Codex sub-agent/);
  assert.doesNotMatch(codexManifest, /Claude subagent/);
});

test("status suppresses skill conflict when frontmatter differs only by quoting", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/foo"),
    "claude",
    ["---", "name: foo", "description: bias warning: ~ guidance.", "---", "body", ""].join("\n")
  );
  writeSkillManifest(
    join(fixture.project, ".agents/skills/foo"),
    "codex",
    ["---", "name: foo", 'description: "bias warning: ~ guidance."', "---", "body", ""].join("\n")
  );

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills:foo", "--json"])
  );

  for (const entry of report.entries) {
    assert.deepEqual(entry.conflicts ?? [], []);
    assert.notEqual(entry.risk, "manual");
  }
});

test("status still detects skill conflict when descriptions differ semantically", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/foo"),
    "claude",
    ["---", "name: foo", "description: foo", "---", "body", ""].join("\n")
  );
  writeSkillManifest(
    join(fixture.project, ".agents/skills/foo"),
    "codex",
    ["---", "name: foo", "description: bar", "---", "body", ""].join("\n")
  );

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills:foo", "--json"])
  );

  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].area, "skills");
  assert.deepEqual(report.entries[0].conflicts, ["foo"]);
  assert.equal(report.entries[0].risk, "manual");
});

test("status hashes no-frontmatter skill manifests by raw bytes (no regression)", () => {
  const matchingFixture = createFixture();
  const sharedBody = ["# Foo", "", "Plain body without YAML frontmatter.", ""].join("\n");
  writeSkillManifest(join(matchingFixture.project, ".claude/skills/foo"), "claude", sharedBody);
  writeSkillManifest(join(matchingFixture.project, ".agents/skills/foo"), "codex", sharedBody);

  const matchingReport = JSON.parse(
    runCli(matchingFixture, ["status", "--scope", "project", "--include", "skills:foo", "--json"])
  );
  for (const entry of matchingReport.entries) {
    assert.deepEqual(entry.conflicts ?? [], []);
    assert.notEqual(entry.risk, "manual");
  }

  const driftFixture = createFixture();
  writeSkillManifest(
    join(driftFixture.project, ".claude/skills/foo"),
    "claude",
    "# Foo\nclaude side\n"
  );
  writeSkillManifest(
    join(driftFixture.project, ".agents/skills/foo"),
    "codex",
    "# Foo\ncodex side\n"
  );

  const driftReport = JSON.parse(
    runCli(driftFixture, ["status", "--scope", "project", "--include", "skills:foo", "--json"])
  );
  assert.equal(driftReport.entries.length, 1);
  assert.deepEqual(driftReport.entries[0].conflicts, ["foo"]);
  assert.equal(driftReport.entries[0].risk, "manual");
});

test("status reports zero skill drift after a forward apply round-trip", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/foo"),
    "claude",
    ["---", "name: foo", "description: bias warning: ~ guidance.", "---", "body", ""].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:foo", "--apply"]);

  const codexManifest = readFileSync(join(fixture.project, ".agents/skills/foo/SKILL.md"), "utf8");
  assert.match(codexManifest, /^description: "bias warning: ~ guidance\."$/m);

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills:foo", "--json"])
  );
  for (const entry of report.entries) {
    assert.deepEqual(entry.conflicts ?? [], []);
    assert.deepEqual(entry.missingInCodex ?? [], []);
    assert.deepEqual(entry.missingInClaude ?? [], []);
    assert.notEqual(entry.risk, "manual");
  }
});

test("sync apply quotes glob frontmatter starting with asterisk so Codex strict YAML cannot misread it as an alias", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/code-review"),
    "claude",
    ["---", "name: code-review", "globs: **/*.{js,ts,jsx,tsx,py,go,java}", "---", "body", ""].join(
      "\n"
    )
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:code-review", "--apply"]);
  const codexManifest = readFileSync(
    join(fixture.project, ".agents/skills/code-review/SKILL.md"),
    "utf8"
  );

  assert.match(codexManifest, /^name: code-review$/m);
  assert.match(codexManifest, /^globs: "\*\*\/\*\.\{js,ts,jsx,tsx,py,go,java\}"$/m);
  assert.doesNotMatch(codexManifest, /^globs: \*\*/m);
});

test("sync apply emits no bare-asterisk frontmatter line when source globs use leading asterisks", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/code-review"),
    "claude",
    ["---", "name: code-review", "globs: **/*.{js,ts,jsx,tsx,py,go,java}", "---", "body", ""].join(
      "\n"
    )
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:code-review", "--apply"]);
  const codexManifest = readFileSync(
    join(fixture.project, ".agents/skills/code-review/SKILL.md"),
    "utf8"
  );

  const closing = codexManifest.indexOf("\n---", 3);
  assert.ok(closing !== -1, "codex manifest should retain a closing frontmatter delimiter");
  const frontmatterRegion = codexManifest.slice(3, closing);
  for (const rawLine of frontmatterRegion.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    assert.doesNotMatch(
      line,
      /^[^"]*\*/,
      `frontmatter line should not start with bare * — got: ${line}`
    );
  }
});

test("sync apply quotes scalars beginning with YAML reserved indicators", () => {
  const fixture = createFixture();
  const indicatorPairs = [
    ["alias_value", "*foo"],
    ["anchor_value", "&bar"],
    ["tag_value", "!baz"],
    ["pipe_value", "|literal"],
    ["gt_value", ">gt"],
    ["question_value", "?q"],
    ["at_value", "@at"],
    ["backtick_value", "`bt`"],
    ["pct_value", "%pct"],
    ["flow_seq", "[a,b]"],
    ["flow_map", "{a:1}"],
    ["comma_value", ",comma"],
    ["hash_value", "#hash"],
    ["colon_value", ":colon"],
    ["apo_value", "'apo"],
    ["dq_value", '"dq'],
  ];

  const lines = ["---", "name: foo"];
  for (const [key, value] of indicatorPairs) {
    lines.push(`${key}: ${value}`);
  }
  lines.push("---", "body", "");

  writeSkillManifest(join(fixture.project, ".claude/skills/foo"), "claude", lines.join("\n"));

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:foo", "--apply"]);
  const codexManifest = readFileSync(join(fixture.project, ".agents/skills/foo/SKILL.md"), "utf8");

  for (const [key] of indicatorPairs) {
    assert.match(
      codexManifest,
      new RegExp(`^${key}: "`, "m"),
      `expected ${key} to be double-quoted in codex manifest`
    );
  }
});

test("sync apply quotes scalars that would otherwise coerce to YAML bool, null, or number", () => {
  const fixture = createFixture();
  const coercionPairs = [
    ["bool_yes", "yes"],
    ["bool_no", "NO"],
    ["bool_off", "off"],
    ["bool_true", "True"],
    ["null_word", "null"],
    ["null_tilde", "~"],
    ["int_value", "1"],
    ["float_value", "1.5"],
    ["exp_value", "1e3"],
    ["hex_value", "0x1A"],
    ["octal_value", "0o17"],
  ];

  const lines = ["---", "name: foo"];
  for (const [key, value] of coercionPairs) {
    lines.push(`${key}: ${value}`);
  }
  lines.push("---", "body", "");

  writeSkillManifest(join(fixture.project, ".claude/skills/foo"), "claude", lines.join("\n"));

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:foo", "--apply"]);
  const codexManifest = readFileSync(join(fixture.project, ".agents/skills/foo/SKILL.md"), "utf8");

  for (const [key, value] of coercionPairs) {
    assert.match(
      codexManifest,
      new RegExp(`^${key}: "${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"$`, "m"),
      `expected ${key} to be double-quoted as ${JSON.stringify(value)}`
    );
  }
});

test("sync apply quotes scalars with leading or trailing whitespace and skips empty values", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/foo"),
    "claude",
    [
      "---",
      "name: foo",
      'padded_left: "  foo"',
      'padded_right: "bar  "',
      'empty_str: ""',
      "---",
      "body",
      "",
    ].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:foo", "--apply"]);
  const codexManifest = readFileSync(join(fixture.project, ".agents/skills/foo/SKILL.md"), "utf8");

  assert.match(codexManifest, /^padded_left: " {2}foo"$/m);
  assert.match(codexManifest, /^padded_right: "bar {2}"$/m);
  assert.doesNotMatch(codexManifest, /^empty_str:/m);
});

test("sync apply leaves plain ASCII frontmatter values unquoted as before", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/foo"),
    "claude",
    ["---", "name: code-review", "description: Review the code carefully.", "---", "body", ""].join(
      "\n"
    )
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:foo", "--apply"]);
  const codexManifest = readFileSync(join(fixture.project, ".agents/skills/foo/SKILL.md"), "utf8");

  assert.match(codexManifest, /^name: code-review$/m);
  assert.match(codexManifest, /^description: Review the code carefully\.$/m);
});

test("status renders line-level preview for folder-grouped Claude agent conflict", () => {
  const fixture = createFixture();
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/group-x/agent-y.md"),
    { name: "agent-y", description: "Sample agent", model: "opus" },
    "Claude body for agent-y"
  );
  writeCodexAgent(join(fixture.project, ".codex/agents/agent-y.toml"), {
    name: "agent-y",
    description: "Sample agent",
    model: "gpt-5.4",
    developer_instructions: "Codex body for agent-y",
  });

  const output = runCli(fixture, ["status", "--scope", "project", "--include", "agents:agent-y"]);

  assert.match(output, /agent-y/);
  assert.match(output, /Claude body for agent-y/);
  assert.match(output, /Codex body for agent-y/);
  assert.doesNotMatch(output, /No line-level preview available\./);
});

test("status ignores Codex bundled .system skill namespace", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".agents/skills/.system/imagegen"), { recursive: true });
  mkdirSync(join(fixture.project, ".agents/skills/normal-skill"), { recursive: true });
  writeFileSync(join(fixture.project, ".agents/skills/.system/.codex-system-skills.marker"), "");
  writeFileSync(
    join(fixture.project, ".agents/skills/.system/imagegen/SKILL.md"),
    "---\nname: imagegen\ndescription: bundled\n---\nimagegen body\n"
  );
  writeFileSync(
    join(fixture.project, ".agents/skills/normal-skill/SKILL.md"),
    "---\nname: normal-skill\ndescription: normal\n---\nnormal body\n"
  );
  mkdirSync(join(fixture.project, ".claude/skills"), { recursive: true });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills", "--json"])
  );

  const skillEntry = report.entries.find((entry) => entry.area === "skills");
  assert.ok(skillEntry, "expected a skills entry");
  const allItems = [
    ...(skillEntry.missingInCodex ?? []),
    ...(skillEntry.missingInClaude ?? []),
    ...(skillEntry.conflicts ?? []),
  ];
  assert.ok(allItems.includes("normal-skill"), "normal-skill should appear");
  assert.ok(!allItems.includes(".system"), ".system should not be enumerated");
  assert.ok(!allItems.includes("imagegen"), "imagegen (under .system) should not be enumerated");
});

test("sync apply copies secret env keys by default", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      figma: {
        command: "node",
        args: ["server.js"],
        env: { FIGMA_API_KEY: "figd_xxx" },
      },
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  runCli(fixture, ["sync", "--scope", "project", "--include", "mcp:figma", "--apply"]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.match(config, /\[mcp_servers\.figma\]/);
  assert.match(config, /FIGMA_API_KEY = "figd_xxx"/);
});

test("sync apply strips secret env keys when AI_CONFIG_SYNC_STRIP_SECRETS is set", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      figma: {
        command: "node",
        args: ["server.js"],
        env: { FIGMA_API_KEY: "figd_xxx" },
      },
    },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");

  runCli(fixture, ["sync", "--scope", "project", "--include", "mcp:figma", "--apply"], undefined, {
    AI_CONFIG_SYNC_STRIP_SECRETS: "1",
  });
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.match(config, /\[mcp_servers\.figma\]/);
  assert.doesNotMatch(config, /FIGMA_API_KEY/);
  assert.doesNotMatch(config, /figd_xxx/);
});

test("sync apply consolidates pre-existing top-level mcp_servers entries into managed block", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      bar: { command: "npx", args: ["bar-mcp"] },
    },
  });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    ["[mcp_servers.foo]", 'command = "old"', "", ""].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "mcp:bar", "--apply"]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  // Managed block has both servers
  assert.match(
    config,
    /# BEGIN ai-config-sync mcp-servers[\s\S]*?\[mcp_servers\.bar\][\s\S]*?# END ai-config-sync mcp-servers/
  );
  assert.match(
    config,
    /# BEGIN ai-config-sync mcp-servers[\s\S]*?\[mcp_servers\.foo\][\s\S]*?# END ai-config-sync mcp-servers/
  );
  // No duplicate `[mcp_servers.foo]` outside the managed block — exactly one occurrence in total.
  assert.equal((config.match(/^\[mcp_servers\.foo\]/gm) ?? []).length, 1);
  assert.equal((config.match(/^\[mcp_servers\.bar\]/gm) ?? []).length, 1);
});

test("sync apply strips pre-existing top-level entry even when sync target name doesn't include it", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      shared: { command: "npx", args: ["shared-mcp"] },
    },
  });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    ["[mcp_servers.user-only]", 'command = "preserved"', ""].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "mcp:shared", "--apply"]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  // user-only is captured by readCodexMcpServers and ends up in `merged`. The managed
  // block should now own it; the original top-level table should be stripped.
  assert.equal((config.match(/^\[mcp_servers\.user-only\]/gm) ?? []).length, 1);
  assert.equal((config.match(/^\[mcp_servers\.shared\]/gm) ?? []).length, 1);
  assert.match(
    config,
    /# BEGIN ai-config-sync mcp-servers[\s\S]*?\[mcp_servers\.user-only\][\s\S]*?# END ai-config-sync mcp-servers/
  );
});

test("sync apply is idempotent — running twice produces identical output with no duplicates", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      bar: { command: "npx", args: ["bar-mcp"] },
    },
  });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    ["[mcp_servers.foo]", 'command = "old"', ""].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "mcp:bar", "--apply"]);
  const first = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  runCli(fixture, ["sync", "--scope", "project", "--include", "mcp:bar", "--apply"]);
  const second = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  assert.equal(first, second);
  assert.equal((second.match(/^\[mcp_servers\.foo\]/gm) ?? []).length, 1);
  assert.equal((second.match(/^\[mcp_servers\.bar\]/gm) ?? []).length, 1);
});

test("sync apply against the user's bug pattern produces valid TOML with no duplicate keys", () => {
  // Reproduces the original bug: top-level mcp_servers tables exist in Codex, then
  // a sync of a NEW server triggers a merge that previously rebuilt the managed block
  // with the captured top-level entries — producing TOML duplicate-key errors.
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: {
      agentation: { command: "npx", args: ["agentation-mcp"] },
      browsermcp: { command: "npx", args: ["browsermcp"] },
      newserver: { command: "npx", args: ["newserver-mcp"] },
    },
  });
  writeFileSync(
    join(fixture.project, ".codex/config.toml"),
    [
      "[mcp_servers.agentation]",
      'command = "old-agentation"',
      "",
      "[mcp_servers.browsermcp]",
      'command = "old-browsermcp"',
      "",
    ].join("\n")
  );

  // Syncing the new server triggers a merge that captures all of Codex's existing
  // top-level entries into the managed-block render. With the fix, the originals
  // are stripped first.
  runCli(fixture, ["sync", "--scope", "project", "--include", "mcp:newserver", "--apply"]);
  const config = readFileSync(join(fixture.project, ".codex/config.toml"), "utf8");

  // Critical: each server appears exactly once. Without the fix, both agentation and
  // browsermcp would appear twice (top-level + managed block) — invalid TOML.
  assert.equal((config.match(/^\[mcp_servers\.agentation\]/gm) ?? []).length, 1);
  assert.equal((config.match(/^\[mcp_servers\.browsermcp\]/gm) ?? []).length, 1);
  assert.equal((config.match(/^\[mcp_servers\.newserver\]/gm) ?? []).length, 1);

  // All three live inside the managed block.
  assert.match(
    config,
    /# BEGIN ai-config-sync mcp-servers[\s\S]*?\[mcp_servers\.agentation\][\s\S]*?# END ai-config-sync mcp-servers/
  );
  assert.match(
    config,
    /# BEGIN ai-config-sync mcp-servers[\s\S]*?\[mcp_servers\.browsermcp\][\s\S]*?# END ai-config-sync mcp-servers/
  );
  assert.match(
    config,
    /# BEGIN ai-config-sync mcp-servers[\s\S]*?\[mcp_servers\.newserver\][\s\S]*?# END ai-config-sync mcp-servers/
  );
});

test("status-ignore term rule masks the matching line in conflict comparison and hides the entry when only that line differs", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/term-only"),
    "claude",
    ["# X", "refs .claude/docs/repo-analysis/ here", "common content line", ""].join("\n")
  );
  writeSkillManifest(
    join(fixture.project, ".agents/skills/term-only"),
    "codex",
    ["# X", "common content line", ""].join("\n")
  );
  mkdirSync(join(fixture.project, ".ai-config-sync-manager"), { recursive: true });
  writeJson(join(fixture.project, ".ai-config-sync-manager/status-ignore.json"), {
    version: 1,
    exclude: [{ area: "skills", term: ".claude/docs/repo-analysis/" }],
  });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills:term-only", "--json"])
  );
  const skillEntry = report.entries.find((entry) => entry.area === "skills");
  if (skillEntry) {
    assert.ok(
      !(skillEntry.conflicts ?? []).includes("term-only"),
      "term-only should be filtered when only the term line differs"
    );
  }
});

test("status-ignore term rule keeps the entry visible when other lines also differ beyond the term line", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/term-plus"),
    "claude",
    ["# X", "refs .claude/docs/repo-analysis/ here", "alpha unique line", ""].join("\n")
  );
  writeSkillManifest(
    join(fixture.project, ".agents/skills/term-plus"),
    "codex",
    ["# X", "beta divergent line", ""].join("\n")
  );
  mkdirSync(join(fixture.project, ".ai-config-sync-manager"), { recursive: true });
  writeJson(join(fixture.project, ".ai-config-sync-manager/status-ignore.json"), {
    version: 1,
    exclude: [{ area: "skills", term: ".claude/docs/repo-analysis/" }],
  });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills:term-plus", "--json"])
  );
  const skillEntry = report.entries.find((entry) => entry.area === "skills");
  assert.ok(skillEntry, "expected a skills entry");
  assert.ok(
    (skillEntry.conflicts ?? []).includes("term-plus"),
    "term-plus should remain in conflicts when non-term lines also differ"
  );
});

test("status-ignore term rule does not affect entries missing on one host", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/with-term"),
    "claude",
    "# X\nrefs .claude/docs/repo-analysis/ here\n"
  );
  mkdirSync(join(fixture.project, ".ai-config-sync-manager"), { recursive: true });
  writeJson(join(fixture.project, ".ai-config-sync-manager/status-ignore.json"), {
    version: 1,
    exclude: [{ area: "skills", term: ".claude/docs/repo-analysis/" }],
  });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills:with-term", "--json"])
  );
  const skillEntry = report.entries.find((entry) => entry.area === "skills");
  assert.ok(skillEntry, "expected a skills entry");
  assert.ok(
    skillEntry.missingInCodex.includes("with-term"),
    "with-term should remain in missingInCodex; term has no effect on missing-on-one-side"
  );
});

test("status-ignore path-only rule still ignores the entry at entry level", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/path-only"),
    "claude",
    "# PathOnly\nbody\n"
  );
  mkdirSync(join(fixture.project, ".ai-config-sync-manager"), { recursive: true });
  const skillsGlob = join(realpathSync(fixture.project), ".claude/skills/path-only");
  writeJson(join(fixture.project, ".ai-config-sync-manager/status-ignore.json"), {
    version: 1,
    exclude: [{ area: "skills", path: skillsGlob }],
  });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills", "--json"])
  );
  const skillEntry = report.entries.find((entry) => entry.area === "skills");
  if (skillEntry) {
    assert.ok(
      !skillEntry.missingInCodex.includes("path-only"),
      "path-only should be filtered by entry-level path rule"
    );
  }
});

test("status-ignore term + path AND restricts the line-mask to entries whose path matches", () => {
  const fixture = createFixture();
  const sharedTermBody = [
    "# Header",
    "refs .claude/docs/repo-analysis/ here",
    "common content line",
    "",
  ].join("\n");
  const sharedCleanBody = ["# Header", "common content line", ""].join("\n");
  writeSkillManifest(join(fixture.project, ".claude/skills/in-scope"), "claude", sharedTermBody);
  writeSkillManifest(join(fixture.project, ".agents/skills/in-scope"), "codex", sharedCleanBody);
  writeSkillManifest(join(fixture.project, ".claude/skills/out-scope"), "claude", sharedTermBody);
  writeSkillManifest(join(fixture.project, ".agents/skills/out-scope"), "codex", sharedCleanBody);

  mkdirSync(join(fixture.project, ".ai-config-sync-manager"), { recursive: true });
  const inScopeGlob = join(realpathSync(fixture.project), ".claude/skills/in-scope");
  writeJson(join(fixture.project, ".ai-config-sync-manager/status-ignore.json"), {
    version: 1,
    exclude: [{ area: "skills", path: inScopeGlob, term: ".claude/docs/repo-analysis/" }],
  });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills", "--json"])
  );
  const skillEntry = report.entries.find((entry) => entry.area === "skills");
  assert.ok(skillEntry, "expected a skills entry");
  const conflicts = skillEntry.conflicts ?? [];
  assert.ok(!conflicts.includes("in-scope"), "in-scope should be masked away (path + term match)");
  assert.ok(
    conflicts.includes("out-scope"),
    "out-scope should remain in conflicts (path miss → no mask applied)"
  );
});

test("status-ignore term that matches no file leaves entry visible", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/lonely"),
    "claude",
    "# Lonely\nplain body without target term\n"
  );
  mkdirSync(join(fixture.project, ".ai-config-sync-manager"), { recursive: true });
  writeJson(join(fixture.project, ".ai-config-sync-manager/status-ignore.json"), {
    version: 1,
    exclude: [{ area: "skills", term: "NEVER_PRESENT" }],
  });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills", "--json"])
  );
  const skillEntry = report.entries.find((entry) => entry.area === "skills");
  assert.ok(skillEntry, "expected a skills entry");
  assert.ok(
    skillEntry.missingInCodex.includes("lonely"),
    "lonely should remain when term is absent"
  );
});

test("status-ignore string-form selector still hides matching skill after term field addition", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/legacy-skill"),
    "claude",
    "# Legacy\nbody\n"
  );
  mkdirSync(join(fixture.project, ".ai-config-sync-manager"), { recursive: true });
  writeJson(join(fixture.project, ".ai-config-sync-manager/status-ignore.json"), {
    version: 1,
    exclude: ["skills:legacy-skill"],
  });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills", "--json"])
  );
  const skillEntry = report.entries.find((entry) => entry.area === "skills");
  if (skillEntry) {
    assert.ok(
      !skillEntry.missingInCodex.includes("legacy-skill"),
      "legacy-skill should be hidden by string selector"
    );
  }
});

test("status-ignore term expands through terminology mapping so .claude/docs/... rule masks .codex/docs/... lines too", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/term-expand"),
    "claude",
    ["# X", "refs .claude/docs/repo-analysis/ here", "common content line", ""].join("\n")
  );
  writeSkillManifest(
    join(fixture.project, ".agents/skills/term-expand"),
    "codex",
    ["# X", "refs .codex/docs/repo-analysis/ here", "common content line", ""].join("\n")
  );
  mkdirSync(join(fixture.project, ".ai-config-sync-manager"), { recursive: true });
  writeJson(join(fixture.project, ".ai-config-sync-manager/status-ignore.json"), {
    version: 1,
    exclude: [{ area: "skills", term: ".claude/docs/repo-analysis/" }],
  });

  const report = JSON.parse(
    runCli(fixture, ["status", "--scope", "project", "--include", "skills:term-expand", "--json"])
  );
  const skillEntry = report.entries.find((entry) => entry.area === "skills");
  if (skillEntry) {
    assert.ok(
      !(skillEntry.conflicts ?? []).includes("term-expand"),
      "term-expand should be filtered when claude-side rule expands to mask the codex-side line via terminology mapping"
    );
  }
});

test("status-ignore term expands codex-side mention to mask matching claude-side line as well", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/term-expand-reverse"),
    "claude",
    ["# X", "refs .claude/docs/repo-analysis/ here", "common content line", ""].join("\n")
  );
  writeSkillManifest(
    join(fixture.project, ".agents/skills/term-expand-reverse"),
    "codex",
    ["# X", "refs .codex/docs/repo-analysis/ here", "common content line", ""].join("\n")
  );
  mkdirSync(join(fixture.project, ".ai-config-sync-manager"), { recursive: true });
  writeJson(join(fixture.project, ".ai-config-sync-manager/status-ignore.json"), {
    version: 1,
    exclude: [{ area: "skills", term: ".codex/docs/repo-analysis/" }],
  });

  const report = JSON.parse(
    runCli(fixture, [
      "status",
      "--scope",
      "project",
      "--include",
      "skills:term-expand-reverse",
      "--json",
    ])
  );
  const skillEntry = report.entries.find((entry) => entry.area === "skills");
  if (skillEntry) {
    assert.ok(
      !(skillEntry.conflicts ?? []).includes("term-expand-reverse"),
      "term-expand-reverse should be filtered when codex-side rule expands to mask the claude-side line via reverse terminology mapping"
    );
  }
});

test("status-ignore term hides matching line from status detail diff while keeping unrelated diff lines visible", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/detail-mask"),
    "claude",
    ["# X", "refs .claude/docs/repo-analysis/ here", "alpha unique line", ""].join("\n")
  );
  writeSkillManifest(
    join(fixture.project, ".agents/skills/detail-mask"),
    "codex",
    ["# X", "refs .claude/docs/repo-analysis/ here", "beta unique line", ""].join("\n")
  );
  mkdirSync(join(fixture.project, ".ai-config-sync-manager"), { recursive: true });
  writeJson(join(fixture.project, ".ai-config-sync-manager/status-ignore.json"), {
    version: 1,
    exclude: [{ area: "skills", term: ".claude/docs/repo-analysis/" }],
  });

  const output = runCli(fixture, [
    "status",
    "--scope",
    "project",
    "--include",
    "skills:detail-mask",
  ]);

  const diffSection = output.slice(output.indexOf("Diff status:"), output.indexOf("Detail file:"));
  assert.match(diffSection, /alpha unique line/);
  assert.match(diffSection, /beta unique line/);
  assert.doesNotMatch(diffSection, /\.claude\/docs\/repo-analysis\//);
  assert.doesNotMatch(diffSection, /\.codex\/docs\/repo-analysis\//);

  const detailPath = statusDetailPath(output);
  const detail = readFileSync(detailPath, "utf8");
  assert.match(detail, /alpha unique line/);
  assert.match(detail, /beta unique line/);
  assert.doesNotMatch(detail, /\.claude\/docs\/repo-analysis\//);
  assert.doesNotMatch(detail, /\.codex\/docs\/repo-analysis\//);
});

test("sync dry-run preview masks term lines in skill change preview", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/preview-mask"),
    "claude",
    ["# X", "refs .claude/docs/repo-analysis/ here", "alpha unique line", ""].join("\n")
  );
  writeSkillManifest(
    join(fixture.project, ".agents/skills/preview-mask"),
    "codex",
    ["# X", "refs .claude/docs/repo-analysis/ here", "beta unique line", ""].join("\n")
  );
  mkdirSync(join(fixture.project, ".ai-config-sync-manager"), { recursive: true });
  writeJson(join(fixture.project, ".ai-config-sync-manager/status-ignore.json"), {
    version: 1,
    exclude: [{ area: "skills", term: ".claude/docs/repo-analysis/" }],
  });

  const output = runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "skills:preview-mask",
  ]);

  assert.match(output, /Change preview:/);
  const preview = output.slice(output.indexOf("Change preview:"));
  assert.match(preview, /alpha unique line/);
  assert.match(preview, /beta unique line/);
  assert.doesNotMatch(preview, /\.claude\/docs\/repo-analysis\//);
  assert.doesNotMatch(preview, /\.codex\/docs\/repo-analysis\//);
});

test("sync dry-run preview masks term lines in agent change preview", () => {
  const fixture = createFixture();
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/sample.md"),
    { name: "sample", description: "Sample", model: "opus" },
    ["refs .claude/docs/repo-analysis/ here", "alpha unique line"].join("\n")
  );
  writeCodexAgent(join(fixture.project, ".codex/agents/sample.toml"), {
    name: "sample",
    description: "Sample",
    model: "gpt-5.4",
    developer_instructions: ["", "refs .claude/docs/repo-analysis/ here", "beta unique line"].join(
      "\n"
    ),
  });
  mkdirSync(join(fixture.project, ".ai-config-sync-manager"), { recursive: true });
  writeJson(join(fixture.project, ".ai-config-sync-manager/status-ignore.json"), {
    version: 1,
    exclude: [{ area: "agents", term: ".claude/docs/repo-analysis/" }],
  });

  const output = runCli(fixture, ["sync", "--scope", "project", "--include", "agents:sample"]);

  assert.match(output, /Change preview:/);
  const preview = output.slice(output.indexOf("Change preview:"));
  assert.match(preview, /alpha unique line/);
  assert.match(preview, /beta unique line/);
  assert.doesNotMatch(preview, /\.claude\/docs\/repo-analysis\//);
  assert.doesNotMatch(preview, /\.codex\/docs\/repo-analysis\//);
});

test("status detail diff without ignore term keeps every differing line visible (regression guard)", () => {
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/no-mask"),
    "claude",
    ["# X", "refs .claude/docs/repo-analysis/ here", "alpha unique line", ""].join("\n")
  );
  writeSkillManifest(
    join(fixture.project, ".agents/skills/no-mask"),
    "codex",
    ["# X", "refs .claude/docs/repo-analysis/ here", "beta unique line", ""].join("\n")
  );

  const output = runCli(fixture, ["status", "--scope", "project", "--include", "skills:no-mask"]);

  assert.match(output, /alpha unique line/);
  assert.match(output, /beta unique line/);
  assert.match(output, /\.codex\/docs\/repo-analysis\//);
});

test("sync applies layered partial merge to terminology-map: rule.id override keeps other bundled rules intact", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, "rules"), { recursive: true });
  writeJson(join(fixture.project, "rules/terminology-map.json"), {
    version: 2,
    layers: [
      {
        id: "orchestration",
        rules: [
          {
            id: "agent-team",
            claude: ["custom team variant"],
            codex: ["custom-codex-equivalent"],
          },
        ],
      },
    ],
  });
  writeFileSync(
    join(fixture.project, "CLAUDE.md"),
    "Use custom team variant for fan-out and thinking budget for compute.\n"
  );
  writeFileSync(join(fixture.project, "AGENTS.md"), "old\n");

  runCli(fixture, ["sync", "--scope", "project", "--include", "instructions", "--apply"]);
  const agents = readFileSync(join(fixture.project, "AGENTS.md"), "utf8");

  assert.equal(
    agents,
    "Use custom-codex-equivalent for fan-out and reasoning effort for compute.\n"
  );
});

test("sync applies layered partial merge to host-target-templates: template.id override leaves other bundled templates intact", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, "rules"), { recursive: true });
  writeJson(join(fixture.project, "rules/host-target-templates.json"), {
    version: 1,
    templates: [
      {
        id: "command-surface",
        target: {
          claude: "Custom Claude command surface",
          codex: "Custom Codex command surface",
        },
      },
    ],
  });
  writeFileSync(
    join(fixture.project, "CLAUDE.md"),
    "Trigger via Claude slash command and Claude hook handler.\n"
  );
  writeFileSync(join(fixture.project, "AGENTS.md"), "old\n");

  runCli(fixture, ["sync", "--scope", "project", "--include", "instructions", "--apply"]);
  const agents = readFileSync(join(fixture.project, "AGENTS.md"), "utf8");

  assert.equal(agents, "Trigger via Custom Codex command surface and Codex native hook.\n");
});

test("sync applies layered partial merge to call-templates: unsupported id override leaves supported entries intact", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, "rules"), { recursive: true });
  writeJson(join(fixture.project, "rules/call-templates.json"), {
    version: "0.1",
    unsupported: [
      {
        id: "custom-call",
        claude_call: "CustomCall",
        codex_marker: "ai-config-sync:stripped",
        reason: "user-defined custom unsupported call",
      },
    ],
  });
  writeFileSync(
    join(fixture.project, "CLAUDE.md"),
    'CustomCall({ x: 1 })\nAgent({ description: "qa", prompt: "Run tests" })\n'
  );
  writeFileSync(join(fixture.project, "AGENTS.md"), "old\n");

  runCli(fixture, ["sync", "--scope", "project", "--include", "instructions", "--apply"]);
  const agents = readFileSync(join(fixture.project, "AGENTS.md"), "utf8");

  assert.match(
    agents,
    /<!--\s*ai-config-sync:stripped\s+\{[\s\S]*?"call":"CustomCall"[\s\S]*?\}\s*-->/
  );
  assert.match(
    agents,
    /<!--\s*ai-config-sync:agent-call\s+\{[\s\S]*?"call":"Agent"[\s\S]*?\}\s*-->/
  );
  assert.match(agents, /Use `spawn_agent` with agent_type: "qa"/);
  assert.doesNotMatch(agents, /CustomCall\(\{ x: 1 \}\)/);
});

test("sync applies layered partial merge to agents-map: model tier id override extends bundled tiers list", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, "rules"), { recursive: true });
  writeJson(join(fixture.project, "rules/agents-map.json"), {
    version: "0.2",
    models: {
      tiers: [
        {
          id: "latest-frontier-model",
          claude: {
            alias: "opus",
            terms: ["my-custom-opus-alias", "opus4.7(latest)", "Opus"],
          },
          codex: {
            alias: "gpt-5.5",
            terms: ["GPT-5.5"],
          },
        },
      ],
    },
  });
  writeFileSync(
    join(fixture.project, "CLAUDE.md"),
    "Use my-custom-opus-alias today and sonnet for chat.\n"
  );
  writeFileSync(join(fixture.project, "AGENTS.md"), "old\n");

  runCli(fixture, ["sync", "--scope", "project", "--include", "instructions", "--apply"]);
  const agents = readFileSync(join(fixture.project, "AGENTS.md"), "utf8");

  assert.equal(agents, "Use gpt-5.5 today and gpt-5.4 for chat.\n");
});

// ---------------------------------------------------------------------------
// Distribution-C step-7 reinforcement tests:
//   - build-dist thin output + launcher pin
//   - host-launcher resolution branches
//   - connect stale cleanup
//   - connect version injection
//   - state schemaVersion guard
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

test("build-dist emits thin host plugin trees with pinned launchers", () => {
  // Run the real build-dist (skip cache sync; never touches network or ~/.claude).
  execFileSync(process.execPath, [join(repoRoot, "scripts/build-dist.mjs"), "--skip-sync"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  const claudeBin = join(repoRoot, "dist/claude-marketplace/plugins/config-manager/bin");
  const codexBin = join(repoRoot, "dist/codex-plugin/bin");
  const claudeRoot = join(repoRoot, "dist/claude-marketplace/plugins/config-manager");
  const codexRoot = join(repoRoot, "dist/codex-plugin");

  // bin directories present
  assert.ok(existsSync(claudeBin), "claude bin directory missing");
  assert.ok(existsSync(codexBin), "codex bin directory missing");

  // bundled heavy directories are NOT copied
  for (const heavy of ["packages", "schemas", "rules"]) {
    assert.ok(!existsSync(join(claudeRoot, heavy)), `unexpected ${heavy}/ in claude dist`);
    assert.ok(!existsSync(join(codexRoot, heavy)), `unexpected ${heavy}/ in codex dist`);
  }

  // launcher exists, executable, references pinned version + package
  const claudeLauncher = join(claudeBin, "ai-config-sync");
  const codexLauncher = join(codexBin, "ai-config-sync");
  assert.ok(existsSync(claudeLauncher));
  assert.ok(existsSync(codexLauncher));

  assert.equal(statSync(claudeLauncher).mode & 0o777, 0o755);
  assert.equal(statSync(codexLauncher).mode & 0o777, 0o755);

  const claudeText = readFileSync(claudeLauncher, "utf8");
  const codexText = readFileSync(codexLauncher, "utf8");
  assert.match(claudeText, new RegExp(`PINNED_VERSION="${escapeRe(rootPkg.version)}"`));
  assert.match(claudeText, /PACKAGE_NAME="ai-config-sync-manager"/);
  assert.match(claudeText, /AI_CONFIG_SYNC_HOST:-claude/);
  assert.match(codexText, new RegExp(`PINNED_VERSION="${escapeRe(rootPkg.version)}"`));
  assert.match(codexText, /AI_CONFIG_SYNC_HOST:-codex/);

  // marketplace.json plugin entry version pinned to root version
  const marketplace = JSON.parse(
    readFileSync(join(repoRoot, "dist/claude-marketplace/.claude-plugin/marketplace.json"), "utf8")
  );
  const plugin = marketplace.plugins.find((p) => p.name === "config-manager");
  assert.equal(plugin.version, rootPkg.version);
});

function readModeBits(path) {
  return statSync(path).mode & 0o777;
}

async function writeLauncherFixture(
  tmpHost,
  host,
  pinnedVersion = "0.1.0",
  packageName = "ai-config-sync-manager"
) {
  const { writeHostLauncher } = await import(
    fileURLToPath(new URL("../scripts/lib/host-launcher.mjs", import.meta.url))
  );
  const path = join(tmpHost, "ai-config-sync");
  writeHostLauncher(path, host, { pinnedVersion, packageName });
  return path;
}

test("host-launcher uses AI_CONFIG_SYNC_ROOT runtime when present", async () => {
  const fixture = createFixture();
  const launcher = await writeLauncherFixture(fixture.root, "claude");

  // Create a fake runtime root with bin/ai-config-sync.mjs that prints a marker
  const rootDir = join(fixture.root, "fake-runtime");
  mkdirSync(join(rootDir, "bin"), { recursive: true });
  writeFileSync(
    join(rootDir, "bin/ai-config-sync.mjs"),
    'console.log("RUNTIME_OK:" + process.argv.slice(2).join(","));\n'
  );

  const out = execFileSync("bash", [launcher, "alpha", "beta"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, AI_CONFIG_SYNC_ROOT: rootDir },
  });
  assert.match(out, /^RUNTIME_OK:alpha,beta$/m);
});

test("host-launcher aborts when AI_CONFIG_SYNC_ROOT is set but runtime is missing", async () => {
  const fixture = createFixture();
  const launcher = await writeLauncherFixture(fixture.root, "claude");

  let error;
  try {
    execFileSync("bash", [launcher], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, AI_CONFIG_SYNC_ROOT: join(fixture.root, "missing") },
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "expected non-zero exit when runtime missing");
  assert.match(error.stderr ?? "", /AI_CONFIG_SYNC_ROOT=/);
  assert.match(error.stderr ?? "", /does not exist/);
});

test("host-launcher self-excludes its own path during PATH lookup", async () => {
  const fixture = createFixture();
  // Stage launcher in a directory that we put on PATH, named ai-config-sync.
  const launcherDir = join(fixture.root, "stage");
  mkdirSync(launcherDir, { recursive: true });
  const { writeHostLauncher } = await import(
    fileURLToPath(new URL("../scripts/lib/host-launcher.mjs", import.meta.url))
  );
  const launcher = join(launcherDir, "ai-config-sync");
  writeHostLauncher(launcher, "claude", {
    pinnedVersion: "0.1.0",
    packageName: "ai-config-sync-manager",
  });

  // Strip npm from PATH so step 3 also fails fast and reaches step 4.
  // Use a minimal PATH containing only the launcher's own dir + /usr/bin (for `command`, `node`, `head`, `tr`).
  const minimalPath = `${launcherDir}:/usr/bin:/bin`;

  let error;
  try {
    execFileSync("bash", [launcher], {
      encoding: "utf8",
      env: { PATH: minimalPath, HOME: fixture.home },
    });
  } catch (caught) {
    error = caught;
  }

  // If the launcher had not self-excluded, it would `exec "$FOUND"` and recurse
  // (or succeed). Either way we expect to reach step 3 (npm exec). On most
  // dev machines /usr/bin/npm exists so step 3 may run; we cannot rely on
  // its absence. Instead, weakly verify the launcher contains realpath
  // self-exclude logic so the recursion guard exists.
  const text = readFileSync(launcher, "utf8");
  assert.match(text, /realpathSync/);
  assert.match(text, /LAUNCHER_REAL/);
  assert.match(text, /FOUND_REAL/);
  // The result of execution itself is environment-dependent; we only assert
  // that *if* it errored, it was not the recursion-loop signature.
  if (error) {
    assert.doesNotMatch(error.stderr ?? "", /Maximum call stack/);
  }
});

test("host-launcher delegates to PATH binary discovered after self-exclude", async () => {
  // Verifies step-2 PATH lookup actually exec's the discovered binary.
  // (The compare_versions branch matrix is environment-sensitive; we exercise
  //  the "proceed" outcome which is the common case for equal/patch/unknown.)
  const fixture = createFixture();

  const stubDir = join(fixture.root, "stub");
  mkdirSync(stubDir, { recursive: true });
  const stub = join(stubDir, "ai-config-sync");
  writeFileSync(
    stub,
    '#!/usr/bin/env bash\nif [ "${1:-}" = "--version" ]; then echo "0.1.0"; exit 0; fi\necho "STUB_RAN:${1:-}"\n'
  );
  chmodSync(stub, 0o755);

  const launcherDir = join(fixture.root, "launcher");
  mkdirSync(launcherDir, { recursive: true });
  const { writeHostLauncher } = await import(
    fileURLToPath(new URL("../scripts/lib/host-launcher.mjs", import.meta.url))
  );
  const launcher = join(launcherDir, "launcher.sh");
  writeHostLauncher(launcher, "claude", {
    pinnedVersion: "0.1.0",
    packageName: "ai-config-sync-manager",
  });

  const env = { PATH: `${stubDir}:/usr/bin:/bin`, HOME: fixture.home };
  const run = spawnSync("bash", [launcher, "hello"], { encoding: "utf8", env });
  assert.equal(run.status, 0, `unexpected exit: ${run.stderr}`);
  assert.match(run.stdout, /STUB_RAN:hello/);
});

test("host-launcher script body documents npm exec fallback", async () => {
  const fixture = createFixture();
  const launcher = await writeLauncherFixture(fixture.root, "claude", "9.9.9", "demo-pkg");
  const text = readFileSync(launcher, "utf8");
  assert.match(text, /npm exec --yes --package="\$PACKAGE_NAME@\$PINNED_VERSION"/);
  assert.match(text, /PACKAGE_NAME="demo-pkg"/);
  assert.match(text, /PINNED_VERSION="9\.9\.9"/);
  assert.equal(readModeBits(launcher), 0o755);
});

test("connect surfaces a blocked status when the Claude host CLI is unavailable", () => {
  // Claude plugin install still delegates to the `claude` CLI, so an empty
  // PATH must surface as blocked without writing installed_plugins.json. The
  // Codex side now writes ~/.agents/plugins/marketplace.json directly (no host
  // CLI dependency), so it succeeds independently.
  const fixture = createFixture();
  mkdirSync(join(fixture.home, ".claude"), { recursive: true });
  mkdirSync(join(fixture.home, ".codex"), { recursive: true });

  const output = runCli(fixture, ["connect"], undefined, { PATH: "" });

  assert.match(output, /blocked: registered Claude plugin/);
  assert.match(output, /ok: registered Codex plugin/);
  assert.equal(
    existsSync(join(fixture.home, ".claude/plugins/installed_plugins.json")),
    false,
    "connect must not write installed_plugins.json directly"
  );
  assert.ok(
    existsSync(join(fixture.home, ".agents/plugins/marketplace.json")),
    "connect must write Codex marketplace.json directly"
  );
});

// state schemaVersion helpers
function setupBaselineFixture() {
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude"), { recursive: true });
  mkdirSync(join(fixture.project, ".codex"), { recursive: true });
  writeJson(join(fixture.project, ".mcp.json"), {
    mcpServers: { notion: { command: "npx", args: ["notion-mcp"] } },
  });
  writeFileSync(join(fixture.project, ".codex/config.toml"), "");
  return fixture;
}

function projectStatePath(fixture) {
  // project state filename is project-<sha256:16> of resolved cwd; use realpath to mirror runtime
  const real = realpathSync(fixture.project);
  const id = createHash("sha256").update(real).digest("hex").slice(0, 16);
  return join(fixture.home, ".ai-config-sync-manager/state", `project-${id}.json`);
}

test("sync backfills schemaVersion when state file lacks it", () => {
  const fixture = setupBaselineFixture();
  const statePath = projectStatePath(fixture);

  // Seed legacy state without schemaVersion
  writeJson(statePath, {
    version: 1,
    scope: "project",
    root: realpathSync(fixture.project),
    updatedAt: new Date().toISOString(),
    areas: {
      mcp: { claude: [], codex: [] },
      permissions: { claude: [], codex: [] },
      hooks: { claude: [], codex: [] },
      agents: { claude: [], codex: [] },
    },
  });

  // Plain dry-run reads the state via createOperations. Capture stderr.
  const result = spawnSync(
    process.execPath,
    [cliPath, "sync", "--scope", "project", "--include", "mcp:notion"],
    {
      cwd: fixture.project,
      encoding: "utf8",
      env: { ...process.env, AI_CONFIG_SYNC_HOME: fixture.home },
    }
  );

  assert.equal(result.status, 0, `unexpected exit: ${result.stderr}`);
  assert.match(result.stderr, /missing schemaVersion; backfilled to 1/);

  // Apply, then re-read state file: schemaVersion must be present
  runCli(fixture, ["sync", "--scope", "project", "--include", "mcp:notion", "--apply"]);
  const after = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(after.schemaVersion, 1);
});

test("sync proceeds normally when state has schemaVersion 1", () => {
  const fixture = setupBaselineFixture();
  // First apply produces the canonical state with schemaVersion: 1
  runCli(fixture, ["sync", "--scope", "project", "--include", "mcp:notion", "--apply"]);

  const statePath = projectStatePath(fixture);
  const seeded = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(seeded.schemaVersion, 1);

  // Second sync should not error and should not emit the schemaVersion notice
  const result = spawnSync(process.execPath, [cliPath, "sync", "--scope", "project"], {
    cwd: fixture.project,
    encoding: "utf8",
    env: { ...process.env, AI_CONFIG_SYNC_HOME: fixture.home },
  });
  assert.equal(result.status, 0, `unexpected exit: ${result.stderr}`);
  assert.match(result.stdout, /AI Config Sync Manager sync/);
  assert.doesNotMatch(result.stderr, /missing schemaVersion/);
  assert.doesNotMatch(result.stderr, /baseline state schema mismatch/);
});

test("sync aborts when state schemaVersion is unknown", () => {
  const fixture = setupBaselineFixture();
  const statePath = projectStatePath(fixture);

  writeJson(statePath, {
    schemaVersion: 2,
    version: 1,
    scope: "project",
    root: realpathSync(fixture.project),
    updatedAt: new Date().toISOString(),
    areas: {
      mcp: { claude: [], codex: [] },
      permissions: { claude: [], codex: [] },
      hooks: { claude: [], codex: [] },
      agents: { claude: [], codex: [] },
    },
  });

  let error;
  try {
    runCli(fixture, ["sync", "--scope", "project"]);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "expected schemaVersion mismatch to abort");
  assert.match(error.stderr ?? error.message ?? "", /baseline state schema mismatch/);
  assert.match(error.stderr ?? error.message ?? "", /expected 1, got 2/);
});

function readUnsupportedCallsArchive(output) {
  const archivePath = join(backupRoot(output), "unsupported-calls.json");
  if (!existsSync(archivePath)) return [];
  const data = JSON.parse(readFileSync(archivePath, "utf8"));
  return Array.isArray(data) ? data : [];
}

test("sync apply rewrites exec_command in codex agent body to Bash on claude side", () => {
  // exec-command-call terminology rule: codex `exec_command` -> claude `Bash`
  // (auto-rewrite via transformTextForHost). After rewrite, no vocab-mismatch
  // should remain for that token.
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/agents"), { recursive: true });
  writeCodexAgent(join(fixture.project, ".codex/agents/sample.toml"), {
    name: "sample",
    description: "Sample",
    model: "gpt-5.4",
    developer_instructions: "Use exec_command to run shell commands.",
  });

  runCli(
    fixture,
    ["sync", "--scope", "project", "--include", "agents:sample", "--apply"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "codex" }
  );
  const claudeBody = readFileSync(join(fixture.project, ".claude/agents/sample.md"), "utf8");

  assert.match(claudeBody, /\bBash\b/);
  assert.doesNotMatch(claudeBody, /\bexec_command\b/);
});

test("sync apply paraphrases wait_agent on claude side via tool-paraphrase rule", () => {
  // wait_agent is codex_only with no 1:1 callable on claude. The
  // tool-paraphrase rule rewrites it to a descriptive phrase so the
  // resulting claude file is readable rather than referencing a tool
  // claude cannot invoke.
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/agents"), { recursive: true });
  writeCodexAgent(join(fixture.project, ".codex/agents/sample.toml"), {
    name: "sample",
    description: "Sample",
    model: "gpt-5.4",
    developer_instructions: "Then wait_agent for completion.",
  });

  runCli(
    fixture,
    ["sync", "--scope", "project", "--include", "agents:sample", "--apply"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "codex" }
  );

  const claudeAgent = readFileSync(join(fixture.project, ".claude/agents/sample.md"), "utf8");
  assert.match(claudeAgent, /wait for the spawned agent/);
  assert.doesNotMatch(claudeAgent, /\bwait_agent\b/);
});

test("sync apply records vocab-mismatch when claude agent body uses Read", () => {
  // Read is claude_only — when copied claude->codex (default direction), it
  // is flagged as vocab-mismatch on the codex side.
  const fixture = createFixture();
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/sample.md"),
    { name: "sample", description: "Sample", model: "opus" },
    "Use Read tool to inspect files."
  );
  mkdirSync(join(fixture.project, ".codex/agents"), { recursive: true });

  const output = runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "agents:sample",
    "--apply",
  ]);
  const archive = readUnsupportedCallsArchive(output);

  const finding = archive.find(
    (entry) =>
      entry.action === "vocab-mismatch" &&
      entry.call === "Read" &&
      entry.direction === "claude->codex"
  );
  assert.ok(finding, `expected vocab-mismatch entry for Read, got: ${JSON.stringify(archive)}`);
});

test("sync apply strips codex-only tokens from preserved claude agent.tools field", () => {
  // sanitizeAgentToolsField removes tokens that only exist on the wrong host
  // namespace (codex) when preserving the claude tools frontmatter during a
  // codex->claude overwrite. Removed tokens are recorded as
  // vocab-mismatch-sanitized in the archive.
  const fixture = createFixture();
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/sample.md"),
    {
      name: "sample",
      description: "Sample",
      model: "opus",
      tools: "Agent, Bash, wait_agent, apply_patch",
    },
    "Older claude body"
  );
  writeCodexAgent(join(fixture.project, ".codex/agents/sample.toml"), {
    name: "sample",
    description: "Sample",
    model: "gpt-5.4",
    developer_instructions: "Codex side body",
  });

  const output = runCli(
    fixture,
    ["sync", "--scope", "project", "--include", "agents:sample", "--apply"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "codex" }
  );
  const claudeFile = readFileSync(join(fixture.project, ".claude/agents/sample.md"), "utf8");

  assert.match(claudeFile, /^tools: Agent,Bash$/m);
  assert.doesNotMatch(claudeFile, /wait_agent/);
  assert.doesNotMatch(claudeFile, /apply_patch/);

  const archive = readUnsupportedCallsArchive(output);
  const finding = archive.find(
    (entry) => entry.action === "vocab-mismatch-sanitized" && entry.call === "agent.tools"
  );
  assert.ok(finding, `expected vocab-mismatch-sanitized entry, got: ${JSON.stringify(archive)}`);
  assert.deepEqual([...finding.fields.removed].sort(), ["apply_patch", "wait_agent"]);
});

test("sync apply paraphrases wait_agent inside a skill body via tool-paraphrase rule", () => {
  // Skill body goes through copyFileWithMappings on codex->claude, which
  // applies term mappings including the tool-paraphrase layer. wait_agent
  // (codex_only) becomes its claude prose form so the resulting claude
  // SKILL.md no longer references an uncallable tool.
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".agents/skills/foo"),
    "codex",
    ["# Foo", "Use wait_agent to coordinate.", ""].join("\n")
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "skills:foo", "--apply"], undefined, {
    AI_CONFIG_SYNC_HOST: "codex",
  });

  const claudeManifest = readFileSync(join(fixture.project, ".claude/skills/foo/SKILL.md"), "utf8");
  assert.match(claudeManifest, /wait for the spawned agent/);
  assert.doesNotMatch(claudeManifest, /\bwait_agent\b/);
});

test("status surfaces vocab-mismatch when claude agent body uses spawn_agent", () => {
  const fixture = createFixture();
  mkdirSync(join(fixture.home, ".claude/agents"), { recursive: true });
  mkdirSync(join(fixture.home, ".codex/agents"), { recursive: true });
  writeClaudeAgent(
    join(fixture.home, ".claude/agents/sample.md"),
    { name: "sample", description: "demo agent", model: "opus" },
    "spawn_agent를 호출한다.\n"
  );
  writeCodexAgent(join(fixture.home, ".codex/agents/sample.toml"), {
    name: "sample",
    description: "demo agent",
    model: "gpt-5.6",
    developer_instructions: "spawn_agent를 호출한다.\n",
  });

  const output = runCli(fixture, ["status", "--scope", "global"]);
  assert.match(output, /Vocab mismatches \(\d+ total/);
  // spawn_agent has a claude term-mapping equivalent ("Task tool"), so it lands in
  // the auto-suggest bucket which renders as a before/after diff pair.
  assert.match(output, /Claude agents\/sample L\d+ @/);
  assert.match(output, /-\s+spawn_agent/);
  assert.match(output, /\+\s+Task tool/);

  const detailPath = statusDetailPath(output);
  const detail = readFileSync(detailPath, "utf8");
  assert.match(detail, /^vocab:$/m);
  assert.match(detail, /-\s+spawn_agent/);
  assert.match(detail, /\+\s+Task tool/);
});

test("sync dry-run skill change preview normalizes YAML frontmatter quotes", () => {
  // Conflicting skill manifests where the claude (source) side has an
  // unquoted YAML scalar containing a colon. skillChangePreview should
  // run the source through normalizeYamlFrontmatter so the After-apply
  // line surfaces the value as a JSON-quoted string rather than the raw
  // ambiguous form.
  const fixture = createFixture();
  writeSkillManifest(
    join(fixture.project, ".claude/skills/quote-demo"),
    "claude",
    [
      "---",
      "name: quote-demo",
      "description: 어쩌고: 콜론 포함",
      "---",
      "",
      "Claude body line.",
      "",
    ].join("\n")
  );
  writeSkillManifest(
    join(fixture.project, ".agents/skills/quote-demo"),
    "codex",
    [
      "---",
      "name: quote-demo",
      'description: "기존 codex 설명"',
      "---",
      "",
      "Codex body line.",
      "",
    ].join("\n")
  );

  const output = runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "skills:quote-demo",
    "--dry-run",
  ]);
  assert.match(output, /Change preview:/);
  assert.match(output, /\+ After apply from Claude L\d+: description: "어쩌고: 콜론 포함"/);
});

test("sync apply auto-fixes wait_agent in claude source agent file", () => {
  // wait_agent is codex_only with a tool-paraphrase rule. The auto-fix pass
  // should rewrite the source claude .md (where the wrong-host token lives)
  // in place after the main sync runs, replacing wait_agent with its claude
  // paraphrase. The codex side also gets an applied operation since the
  // agents area has a diff.
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".codex/agents"), { recursive: true });
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/sample.md"),
    { name: "sample", description: "demo", model: "opus" },
    "Then wait_agent for completion.\n"
  );

  runCli(fixture, ["sync", "--scope", "project", "--include", "agents:sample", "--apply"]);

  const claudeAfter = readFileSync(join(fixture.project, ".claude/agents/sample.md"), "utf8");
  assert.match(claudeAfter, /wait for the spawned agent/);
  assert.doesNotMatch(claudeAfter, /\bwait_agent\b/);
});

test("sync apply auto-fixes Grep tool reference in codex source agent file", () => {
  // Grep is claude_only with a tool-paraphrase rule. Codex source containing
  // 'Grep' should be rewritten to the codex paraphrase 'search file contents
  // via grep' so codex actually understands the intent (codex has no Grep).
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/agents"), { recursive: true });
  writeCodexAgent(join(fixture.project, ".codex/agents/sample.toml"), {
    name: "sample",
    description: "demo",
    model: "gpt-5.4",
    developer_instructions: "Use Grep to scan files.",
  });

  runCli(
    fixture,
    ["sync", "--scope", "project", "--include", "agents:sample", "--apply"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "codex" }
  );

  const codexAfter = readFileSync(join(fixture.project, ".codex/agents/sample.toml"), "utf8");
  assert.match(codexAfter, /search file contents via grep/);
  assert.doesNotMatch(codexAfter, /\bGrep\b/);
});

test("sync apply auto-fix backs up source file before rewriting", () => {
  // The rewrite path goes through backupPath(plan, source) so the original
  // wait_agent line is preserved under backupRoot before the in-place edit.
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".codex/agents"), { recursive: true });
  const claudePath = join(fixture.project, ".claude/agents/sample.md");
  writeClaudeAgent(
    claudePath,
    { name: "sample", description: "demo", model: "opus" },
    "Then wait_agent for completion.\n"
  );

  const output = runCli(fixture, [
    "sync",
    "--scope",
    "project",
    "--include",
    "agents:sample",
    "--apply",
  ]);
  const backupRootDir = backupRoot(output);

  const backupCandidates = collectBackupFiles(backupRootDir).filter((p) => p.endsWith("sample.md"));
  assert.ok(
    backupCandidates.length > 0,
    `expected backup of sample.md, got: ${JSON.stringify(collectBackupFiles(backupRootDir))}`
  );

  const backedUp = readFileSync(backupCandidates[0], "utf8");
  assert.match(backedUp, /\bwait_agent\b/);
});

test("sync apply leaves manual review tokens (Read/Write/Edit) untouched in source", () => {
  // Read/Write/Edit are claude_only but intentionally NOT in the
  // tool-paraphrase layer (false-positive risk in prose). They surface as
  // "Manual review" in status and stay raw after --apply.
  const fixture = createFixture();
  mkdirSync(join(fixture.project, ".claude/agents"), { recursive: true });
  const codexPath = join(fixture.project, ".codex/agents/sample.toml");
  writeCodexAgent(codexPath, {
    name: "sample",
    description: "demo",
    model: "gpt-5.4",
    developer_instructions: "Use Read tool to inspect files.",
  });

  runCli(
    fixture,
    ["sync", "--scope", "project", "--include", "agents:sample", "--apply"],
    undefined,
    { AI_CONFIG_SYNC_HOST: "codex" }
  );

  const codexAfter = readFileSync(codexPath, "utf8");
  assert.match(codexAfter, /\bRead\b/);
});

function collectBackupFiles(rootDir) {
  if (!existsSync(rootDir)) return [];
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

// Helper: write a Codex agent file whose developer_instructions body lines
// align 1:1 with the matching Claude agent. Claude's frontmatter parser leaves
// a leading blank line in the body (so user content starts at L2), so the
// codex side mirrors that by embedding a leading and trailing newline inside
// the JSON-quoted scalar. Without this alignment the paraphrase counterpart
// match (cpLine === before) fails and the override is never registered.
function writeCodexAgentBodyAligned(path, fields, bodyText) {
  mkdirSync(dirname(path), { recursive: true });
  const order = ["name", "description", "model"];
  const lines = [];
  for (const key of order) {
    if (fields[key] === undefined || fields[key] === null) continue;
    lines.push(`${key} = ${JSON.stringify(String(fields[key]))}`);
  }
  lines.push(`developer_instructions = ${JSON.stringify(`\n${bodyText}\n`)}`);
  writeFileSync(path, `${lines.join("\n")}\n`);
}

test("paraphrase dry-run reports planned line changes without writing files", () => {
  const fixture = createFixture();
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/sample.md"),
    { name: "sample", description: "demo", model: "opus" },
    "Use Read tool to inspect."
  );
  const codexPath = join(fixture.project, ".codex/agents/sample.toml");
  writeCodexAgentBodyAligned(
    codexPath,
    { name: "sample", description: "demo", model: "gpt-5.4" },
    "Use Read tool to inspect."
  );
  const codexBefore = readFileSync(codexPath, "utf8");

  const result = JSON.parse(
    runCli(fixture, ["paraphrase", "--scope", "project", "--map", "Read=Inspection", "--json"])
  );

  assert.equal(result.mode, "dry-run");
  assert.ok(result.applied.length > 0, `expected applied entries, got: ${JSON.stringify(result)}`);
  const change = result.applied[0];
  assert.match(change.before, /\bRead\b/);
  assert.match(change.after, /\bInspection\b/);
  assert.equal(change.counterpart_matched, true);

  // Codex source unchanged in dry-run.
  assert.equal(readFileSync(codexPath, "utf8"), codexBefore);
  // Override file should not be written either.
  assert.equal(
    existsSync(join(fixture.home, ".ai-config-sync-manager/rules/paraphrase-overrides.json")),
    false
  );
});

test("paraphrase --apply registers an active override that masks the conflict in status", () => {
  const fixture = createFixture();
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/sample.md"),
    { name: "sample", description: "demo", model: "opus" },
    "Use Read tool to inspect."
  );
  const codexPath = join(fixture.project, ".codex/agents/sample.toml");
  writeCodexAgentBodyAligned(
    codexPath,
    { name: "sample", description: "demo", model: "gpt-5.4" },
    "Use Read tool to inspect."
  );

  // Baseline: codex side has a claude_only token (Read) so vocab-mismatch fires.
  const before = JSON.parse(runCli(fixture, ["status", "--scope", "project", "--json"]));
  assert.equal(before.vocabFindings.length, 1);
  assert.equal(before.vocabFindings[0].token, "Read");
  assert.equal(before.paraphraseOverrides.active.length, 0);

  runCli(fixture, [
    "paraphrase",
    "--scope",
    "project",
    "--map",
    "Read=Inspection",
    "--apply",
    "--json",
  ]);

  // Codex source rewritten in place.
  const codexAfter = readFileSync(codexPath, "utf8");
  assert.match(codexAfter, /Inspection/);
  assert.doesNotMatch(codexAfter, /\bRead\b/);

  // Override file written under AI_CONFIG_SYNC_HOME.
  const overridesPath = join(
    fixture.home,
    ".ai-config-sync-manager/rules/paraphrase-overrides.json"
  );
  assert.equal(existsSync(overridesPath), true);
  const overrides = JSON.parse(readFileSync(overridesPath, "utf8"));
  assert.equal(overrides.overrides.length, 1);

  // Status now masks both the vocab finding and the agent conflict.
  const after = JSON.parse(runCli(fixture, ["status", "--scope", "project", "--json"]));
  assert.equal(after.vocabFindings.length, 0);
  assert.equal(after.entries.length, 0);
  assert.equal(after.paraphraseOverrides.active.length, 1);
  assert.equal(after.paraphraseOverrides.stale.length, 0);
});

test("paraphrase override is auto-invalidated as stale when the codex line drifts", () => {
  const fixture = createFixture();
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/sample.md"),
    { name: "sample", description: "demo", model: "opus" },
    "Use Read tool to inspect."
  );
  const codexPath = join(fixture.project, ".codex/agents/sample.toml");
  writeCodexAgentBodyAligned(
    codexPath,
    { name: "sample", description: "demo", model: "gpt-5.4" },
    "Use Read tool to inspect."
  );

  runCli(fixture, [
    "paraphrase",
    "--scope",
    "project",
    "--map",
    "Read=Inspection",
    "--apply",
    "--json",
  ]);

  // Confirm baseline active override after apply.
  const masked = JSON.parse(runCli(fixture, ["status", "--scope", "project", "--json"]));
  assert.equal(masked.paraphraseOverrides.active.length, 1);
  assert.equal(masked.entries.length, 0);

  // Externally edit the codex file so the recorded codex_text no longer matches.
  writeCodexAgentBodyAligned(
    codexPath,
    { name: "sample", description: "demo", model: "gpt-5.4" },
    "Use something else entirely."
  );

  const drift = JSON.parse(runCli(fixture, ["status", "--scope", "project", "--json"]));
  assert.equal(drift.paraphraseOverrides.active.length, 0);
  assert.equal(drift.paraphraseOverrides.stale.length, 1);
  // Conflict resurfaces because the override no longer masks the diff.
  assert.equal(drift.entries.length, 1);
  assert.equal(drift.entries[0].area, "agents");
  assert.deepEqual(drift.entries[0].conflicts, ["sample"]);
});

// Note on coverage: every codex_only token (wait_agent, apply_patch,
// spawn_agent, send_input, exec_command) currently has a tool-paraphrase or
// terminology-map auto-fix, which fills `recommended` and removes the finding
// from paraphrase's manual-review queue. So the "codex_only token in claude
// file" direction has no manual targets to drive through `paraphrase --apply`.
// Instead, this case exercises a second manual claude_only token (Write) at
// the global scope to confirm the override registration path is independent
// of scope and works for tokens beyond the one in the previous case.
test("paraphrase --apply at global scope registers an override for a second manual token", () => {
  const fixture = createFixture();
  writeClaudeAgent(
    join(fixture.home, ".claude/agents/sample.md"),
    { name: "sample", description: "demo", model: "opus" },
    "Use Write tool to record output."
  );
  const codexPath = join(fixture.home, ".codex/agents/sample.toml");
  writeCodexAgentBodyAligned(
    codexPath,
    { name: "sample", description: "demo", model: "gpt-5.4" },
    "Use Write tool to record output."
  );

  const before = JSON.parse(runCli(fixture, ["status", "--scope", "global", "--json"]));
  const writeFinding = before.vocabFindings.find((f) => f.token === "Write");
  assert.ok(
    writeFinding,
    `expected Write vocab finding, got: ${JSON.stringify(before.vocabFindings)}`
  );

  runCli(fixture, [
    "paraphrase",
    "--scope",
    "global",
    "--map",
    "Write=Author",
    "--apply",
    "--json",
  ]);

  const codexAfter = readFileSync(codexPath, "utf8");
  assert.match(codexAfter, /Author/);
  assert.doesNotMatch(codexAfter, /\bWrite\b/);

  const after = JSON.parse(runCli(fixture, ["status", "--scope", "global", "--json"]));
  assert.equal(after.vocabFindings.filter((f) => f.token === "Write").length, 0);
  assert.equal(after.paraphraseOverrides.active.length, 1);
  assert.equal(after.paraphraseOverrides.stale.length, 0);
  assert.equal(after.entries.filter((e) => e.area === "agents").length, 0);
});

// `paraphrase --register` covers the case where one side was already rewritten
// outside the CLI (e.g. a manual ruby/sed pass), so `lintHostVocab` finds zero
// strict-vocab tokens on either side and the lint-driven `paraphrase --apply`
// path registers nothing. `--register` skips the rewrite stage and instead
// diffs the two files line-by-line; for each diverging pair, it tests whether
// the effective map (file + cli --map) makes the lines byte-equal — and if
// so, appends an override entry without touching the source files.
test("paraphrase --register registers override for pre-paraphrased codex line", () => {
  const fixture = createFixture();
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/sample.md"),
    { name: "sample", description: "demo", model: "opus" },
    "Use Read tool to inspect."
  );
  const codexPath = join(fixture.project, ".codex/agents/sample.toml");
  writeCodexAgentBodyAligned(
    codexPath,
    { name: "sample", description: "demo", model: "gpt-5.4" },
    "Use Inspection tool to inspect."
  );
  const codexBefore = readFileSync(codexPath, "utf8");

  // Lint-driven paraphrase finds no findings — codex already has Inspection,
  // claude has Read but Read is a claude_only token so it's allowed in claude
  // files. The standard --apply path therefore registers nothing.
  const lintResult = JSON.parse(
    runCli(fixture, [
      "paraphrase",
      "--scope",
      "project",
      "--map",
      "Read=Inspection",
      "--apply",
      "--json",
    ])
  );
  assert.equal(lintResult.applied.length, 0);
  assert.equal(
    existsSync(join(fixture.home, ".ai-config-sync-manager/rules/paraphrase-overrides.json")),
    false
  );

  // Status reports the conflict because hashes differ.
  const conflict = JSON.parse(runCli(fixture, ["status", "--scope", "project", "--json"]));
  assert.equal(conflict.entries.length, 1);
  assert.equal(conflict.entries[0].area, "agents");

  // --register dry-run: matches without writing anything.
  const dryRun = JSON.parse(
    runCli(fixture, [
      "paraphrase",
      "--register",
      "--scope",
      "project",
      "--map",
      "Read=Inspection",
      "--json",
    ])
  );
  assert.equal(dryRun.mode, "register-dry-run");
  assert.equal(dryRun.matched.length, 1);
  assert.equal(dryRun.matched[0].claude_text.includes("Read"), true);
  assert.equal(dryRun.matched[0].codex_text.includes("Inspection"), true);
  assert.equal(readFileSync(codexPath, "utf8"), codexBefore);
  assert.equal(
    existsSync(join(fixture.home, ".ai-config-sync-manager/rules/paraphrase-overrides.json")),
    false
  );

  // --register --apply: persists override but still leaves source files alone.
  const applied = JSON.parse(
    runCli(fixture, [
      "paraphrase",
      "--register",
      "--scope",
      "project",
      "--map",
      "Read=Inspection",
      "--apply",
      "--json",
    ])
  );
  assert.equal(applied.mode, "register-apply");
  assert.equal(applied.matched.length, 1);
  assert.equal(readFileSync(codexPath, "utf8"), codexBefore);

  const overridesPath = join(
    fixture.home,
    ".ai-config-sync-manager/rules/paraphrase-overrides.json"
  );
  assert.equal(existsSync(overridesPath), true);
  const overrides = JSON.parse(readFileSync(overridesPath, "utf8"));
  assert.equal(overrides.overrides.length, 1);
  assert.match(overrides.overrides[0].id, /-register-L\d+$/);

  // Status no longer reports the conflict.
  const after = JSON.parse(runCli(fixture, ["status", "--scope", "project", "--json"]));
  assert.equal(after.entries.length, 0);
  assert.equal(after.paraphraseOverrides.active.length, 1);
});

// `--register` must skip a diverging line when the supplied map cannot make
// the two sides byte-equal (e.g. unrelated content drift, not a paraphrase).
// The line lands in the `skipped` bucket with `reason: mapping-not-equivalent`
// and no override is registered for it.
test("paraphrase --register skips line when map does not equate the diff", () => {
  const fixture = createFixture();
  writeClaudeAgent(
    join(fixture.project, ".claude/agents/sample.md"),
    { name: "sample", description: "demo", model: "opus" },
    "Use Read tool to inspect."
  );
  const codexPath = join(fixture.project, ".codex/agents/sample.toml");
  writeCodexAgentBodyAligned(
    codexPath,
    { name: "sample", description: "demo", model: "gpt-5.4" },
    "Use Read tool to verify behavior."
  );

  const result = JSON.parse(
    runCli(fixture, [
      "paraphrase",
      "--register",
      "--scope",
      "project",
      "--map",
      "Read=Inspection",
      "--apply",
      "--json",
    ])
  );
  assert.equal(result.matched.length, 0);
  assert.ok(result.skipped.length > 0);
  assert.equal(result.skipped[0].reason, "mapping-not-equivalent");
  assert.equal(
    existsSync(join(fixture.home, ".ai-config-sync-manager/rules/paraphrase-overrides.json")),
    false
  );
});

// update_plan is a codex_only manual token (no terminology-map / paraphrase-map
// entry), so when it appears in a claude file it surfaces as a vocab-mismatch
// finding with no auto-fix. The bidirectional recall flow drives it through
// `paraphrase --apply` (claude side rewritten, override registered, status
// clean afterwards).
test("paraphrase --apply rewrites codex_only manual token (update_plan) on claude side", () => {
  const fixture = createFixture();
  const claudePath = join(fixture.project, ".claude/agents/sample.md");
  writeClaudeAgent(
    claudePath,
    { name: "sample", description: "demo", model: "opus" },
    "Use update_plan to outline steps."
  );
  const codexPath = join(fixture.project, ".codex/agents/sample.toml");
  writeCodexAgentBodyAligned(
    codexPath,
    { name: "sample", description: "demo", model: "gpt-5.4" },
    "Use update_plan to outline steps."
  );

  // Baseline: claude side has a codex_only token (update_plan) so vocab-mismatch fires.
  const before = JSON.parse(runCli(fixture, ["status", "--scope", "project", "--json"]));
  const updatePlanFinding = before.vocabFindings.find((f) => f.token === "update_plan");
  assert.ok(
    updatePlanFinding,
    `expected update_plan vocab finding, got: ${JSON.stringify(before.vocabFindings)}`
  );
  assert.equal(updatePlanFinding.host, "claude");
  assert.equal(before.paraphraseOverrides.active.length, 0);

  const result = JSON.parse(
    runCli(fixture, [
      "paraphrase",
      "--scope",
      "project",
      "--map",
      "update_plan=update the plan",
      "--apply",
      "--json",
    ])
  );

  assert.equal(result.mode, "apply");
  assert.ok(result.applied.length > 0, `expected applied entries, got: ${JSON.stringify(result)}`);
  const change = result.applied[0];
  assert.equal(change.host, "claude");
  assert.match(change.before, /\bupdate_plan\b/);
  assert.match(change.after, /update the plan/);
  assert.equal(change.counterpart_matched, true);

  // Claude source rewritten in place; codex source untouched.
  const claudeAfter = readFileSync(claudePath, "utf8");
  assert.match(claudeAfter, /update the plan/);
  assert.doesNotMatch(claudeAfter, /\bupdate_plan\b/);

  // paraphrase-overrides.json registers the entry.
  const overridesPath = join(
    fixture.home,
    ".ai-config-sync-manager/rules/paraphrase-overrides.json"
  );
  assert.equal(existsSync(overridesPath), true);
  const overrides = JSON.parse(readFileSync(overridesPath, "utf8"));
  assert.equal(overrides.overrides.length, 1);

  // Bidirectional recall: status now shows clean state (vocab + conflicts masked).
  const after = JSON.parse(runCli(fixture, ["status", "--scope", "project", "--json"]));
  assert.equal(after.vocabFindings.filter((f) => f.token === "update_plan").length, 0);
  assert.equal(after.entries.filter((e) => e.area === "agents").length, 0);
  assert.equal(after.paraphraseOverrides.active.length, 1);
  assert.equal(after.paraphraseOverrides.stale.length, 0);
});

// When the counterpart file's body has the exact same text but at a different
// line number (drift caused by edits on one side only), `runParaphrase` falls
// back from direct line-number matching to a text-search across the
// counterpart body. The override is registered with each host's own line
// number.
test("paraphrase --apply uses text-search fallback when counterpart line offset differs", () => {
  const fixture = createFixture();
  // claude body: padding line A on L2, target text on L3.
  // (writeClaudeAgent emits "---", "", body — so user content starts at L2.)
  const claudePath = join(fixture.project, ".claude/agents/sample.md");
  writeClaudeAgent(
    claudePath,
    { name: "sample", description: "demo", model: "opus" },
    "Padding context line.\nRead-only — no modifications unless explicitly asked."
  );
  // codex body: target text on L2, trailing context on L3.
  // (writeCodexAgentBodyAligned wraps with leading/trailing newline — so user
  // content starts at L2.)
  const codexPath = join(fixture.project, ".codex/agents/sample.toml");
  writeCodexAgentBodyAligned(
    codexPath,
    { name: "sample", description: "demo", model: "gpt-5.4" },
    "Read-only — no modifications unless explicitly asked.\nExtra trailing context."
  );

  // Read is claude_only — present in codex file → finding host=codex, line=2.
  // Counterpart (claude) line 2 holds "Padding context line." (mismatch),
  // but line 3 holds the same target text → text-search fallback recovers it.
  const result = JSON.parse(
    runCli(fixture, [
      "paraphrase",
      "--scope",
      "project",
      "--map",
      "Read=Inspection",
      "--apply",
      "--json",
    ])
  );

  assert.equal(result.mode, "apply");
  assert.ok(result.applied.length > 0, `expected applied entries, got: ${JSON.stringify(result)}`);
  const change = result.applied[0];
  assert.equal(change.host, "codex");
  assert.equal(change.line, 2);
  assert.equal(change.counterpart_matched, true);
  assert.equal(change.counterpart_line, 3);
  assert.match(change.before, /\bRead-only\b/);
  assert.match(change.after, /Inspection-only/);

  // Codex source rewritten; claude source untouched (counterpart only stores line/text).
  const codexAfter = readFileSync(codexPath, "utf8");
  assert.match(codexAfter, /Inspection-only/);
  assert.doesNotMatch(codexAfter, /\bRead-only\b/);
  const claudeAfter = readFileSync(claudePath, "utf8");
  assert.match(claudeAfter, /Read-only/);

  // Override file records each host's own line number.
  const overridesPath = join(
    fixture.home,
    ".ai-config-sync-manager/rules/paraphrase-overrides.json"
  );
  const overrides = JSON.parse(readFileSync(overridesPath, "utf8"));
  assert.equal(overrides.overrides.length, 1);
  const entry = overrides.overrides[0];
  assert.equal(entry.codex_line, 2);
  assert.equal(entry.claude_line, 3);

  // The override is active and unstaled; any residual diff comes from the
  // intentionally non-paraphrase padding lines, not from the masked target.
  const after = JSON.parse(runCli(fixture, ["status", "--scope", "project", "--json"]));
  assert.equal(after.paraphraseOverrides.active.length, 1);
  assert.equal(after.paraphraseOverrides.stale.length, 0);
});
