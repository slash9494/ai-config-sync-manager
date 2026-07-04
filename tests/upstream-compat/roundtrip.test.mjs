import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { cleanupFixture, createIntegrationFixture } from "../integration/helpers/fixture.mjs";
import { runSync } from "../integration/helpers/run-cli.mjs";

const claudeFixtures = fileURLToPath(new URL("./claude-fixtures", import.meta.url));
const codexFixtures = fileURLToPath(new URL("./codex-fixtures", import.meta.url));

// Bad key must sit at root scope: codex --strict-config leaves the hooks table
// array loosely validated, so an unknown key appended there is silently accepted.
const UNKNOWN_ROOT_KEY = "totally_unknown_field_xyz = 42\n";
const CONFIG_PARSE_ERROR = /Error loading config\.toml/;
const CODEX_STARTED = /OpenAI Codex v/;
const CODEX_JUDGE_TIMEOUT_MS = 12000;

function binaryAvailable(name) {
  try {
    // Bound the probe: a hung --version (update/telemetry check) would otherwise
    // stall module load until the CI job timeout with no diagnostic.
    execFileSync(name, ["--version"], { stdio: "ignore", timeout: 10000, killSignal: "SIGKILL" });
    return true;
  } catch {
    return false;
  }
}

const codexMissing = binaryAvailable("codex") ? false : "codex CLI not installed";

// The judge runs a non-interactive `exec` that reaches the model only AFTER the
// config is parsed, so the config-parse verdict is emitted within ~1s. We never
// need the model call to succeed; SIGKILL at timeout bounds the doomed network
// attempt while the captured output already carries the verdict.
function judgeCodexConfig(codexHome) {
  let output;
  try {
    output = execFileSync("codex", ["--strict-config", "exec", "--skip-git-repo-check", "noop"], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: codexHome },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CODEX_JUDGE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  return {
    output,
    hasConfigError: CONFIG_PARSE_ERROR.test(output),
    started: CODEX_STARTED.test(output),
  };
}

function copyInto(src, dest) {
  cpSync(src, dest, { recursive: true, dereference: false, verbatimSymlinks: true });
}

function syncApply(home, projectRoot, from, to) {
  const result = runSync({
    home,
    projectRoot,
    args: ["--scope", "global", "--from", from, "--to", to, "--apply"],
  });
  assert.equal(result.status, 0, `sync ${from}->${to} failed: ${result.output}`);
  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Claude skill files round-trip content-identically but the CLI normalizes the
// filename (SKILL.md -> skill.md), so compare by body, not path.
function readSkillBody(home, skillName) {
  const skillDir = join(home, ".claude", "skills", skillName);
  const markdown = readdirSync(skillDir).find((name) => /skill\.md$/i.test(name));
  assert.ok(markdown, `no SKILL markdown found under ${skillDir}`);
  return readFileSync(join(skillDir, markdown), "utf8");
}

test("claude->codex->claude round-trips settings, mcp, agents, and skills without loss", () => {
  const forward = createIntegrationFixture({ scenario: "upstream-compat-forward" });
  const reverse = createIntegrationFixture({ scenario: "upstream-compat-reverse" });
  try {
    copyInto(claudeFixtures, forward.home);
    syncApply(forward.home, forward.project, "claude", "codex");

    assert.ok(
      existsSync(join(forward.home, ".codex", "config.toml")),
      "claude->codex apply did not produce .codex/config.toml"
    );

    copyInto(join(forward.home, ".codex"), join(reverse.home, ".codex"));
    copyInto(join(forward.home, ".agents"), join(reverse.home, ".agents"));
    // Neutral cwd (forward.project): running the CLI from a git repo registers a
    // [projects.<cwd>] trust block that leaks into the hooks fence and corrupts
    // the round-trip.
    syncApply(reverse.home, forward.project, "codex", "claude");

    assert.deepEqual(
      readJson(join(reverse.home, ".claude", "settings.json")),
      readJson(join(claudeFixtures, ".claude", "settings.json")),
      "permissions/hooks did not survive the round-trip"
    );
    assert.deepEqual(
      readJson(join(reverse.home, ".claude.json")).mcpServers,
      readJson(join(claudeFixtures, ".claude.json")).mcpServers,
      "mcp servers did not survive the round-trip"
    );
    assert.equal(
      readFileSync(join(reverse.home, ".claude", "agents", "sample.md"), "utf8"),
      readFileSync(join(claudeFixtures, ".claude", "agents", "sample.md"), "utf8"),
      "agent frontmatter did not survive the round-trip"
    );
    assert.equal(
      readSkillBody(reverse.home, "sample"),
      readFileSync(join(claudeFixtures, ".claude", "skills", "sample", "SKILL.md"), "utf8"),
      "skill body did not survive the round-trip"
    );
  } finally {
    cleanupFixture(forward);
    cleanupFixture(reverse);
  }
});

test("codex CLI accepts the claude->codex sync output", { skip: codexMissing }, () => {
  const fixture = createIntegrationFixture({ scenario: "upstream-compat-host-accepts" });
  try {
    copyInto(claudeFixtures, fixture.home);
    syncApply(fixture.home, fixture.project, "claude", "codex");

    const verdict = judgeCodexConfig(join(fixture.home, ".codex"));
    assert.equal(
      verdict.hasConfigError,
      false,
      `codex rejected the synced config:\n${verdict.output}`
    );
    assert.equal(
      verdict.started,
      true,
      `codex did not start up on the synced config:\n${verdict.output}`
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("codex --strict-config rejects an unknown configuration field", { skip: codexMissing }, () => {
  const fixture = createIntegrationFixture({ scenario: "upstream-compat-host-rejects" });
  try {
    copyInto(codexFixtures, fixture.home);
    const configPath = join(fixture.home, ".codex", "config.toml");

    const cleanVerdict = judgeCodexConfig(join(fixture.home, ".codex"));
    assert.equal(
      cleanVerdict.hasConfigError,
      false,
      `codex rejected the baseline codex fixture:\n${cleanVerdict.output}`
    );

    writeFileSync(configPath, UNKNOWN_ROOT_KEY + readFileSync(configPath, "utf8"));
    const driftVerdict = judgeCodexConfig(join(fixture.home, ".codex"));
    assert.equal(
      driftVerdict.hasConfigError,
      true,
      `codex --strict-config failed to reject an unknown field:\n${driftVerdict.output}`
    );
  } finally {
    cleanupFixture(fixture);
  }
});
