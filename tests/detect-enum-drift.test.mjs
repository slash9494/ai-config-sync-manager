import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  resolveEnumMembers,
  hookEventNames,
  findCodexEnumDrift,
  findClaudeHookDrift,
  renderSection,
} from "../scripts/detect-enum-drift.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const codexSchemaPath = join(here, "..", "snapshots", "codex", "config-schema.json");
const claudeSchemaPath = join(here, "..", "snapshots", "claude", "settings-schema.json");

function refSchema(members) {
  return {
    properties: { sandbox_mode: { allOf: [{ $ref: "#/definitions/SandboxMode" }] } },
    definitions: { SandboxMode: { enum: members, type: "string" } },
  };
}

// The shipped schema states these keys as $ref indirections, which is what the previous jq-based
// check could not follow — it read [] for every watched key and never fired.
test("resolveEnumMembers follows the $ref the real Codex schema uses", () => {
  const schema = JSON.parse(readFileSync(codexSchemaPath, "utf8"));
  assert.deepEqual(resolveEnumMembers(schema, "sandbox_mode"), [
    "danger-full-access",
    "read-only",
    "workspace-write",
  ]);
  assert.ok(resolveEnumMembers(schema, "approval_policy").length > 0);
  assert.ok(resolveEnumMembers(schema, "web_search").includes("live"));
});

test("resolveEnumMembers collects members spelled as oneOf branches", () => {
  const schema = {
    properties: { web_search: { allOf: [{ $ref: "#/definitions/WebSearchMode" }] } },
    definitions: {
      WebSearchMode: { oneOf: [{ enum: ["live"] }, { enum: ["cached"] }] },
    },
  };
  assert.deepEqual(resolveEnumMembers(schema, "web_search"), ["cached", "live"]);
});

test("resolveEnumMembers returns nothing for an absent key", () => {
  assert.deepEqual(resolveEnumMembers(refSchema(["read-only"]), "approval_policy"), []);
});

test("hookEventNames reads the real Claude schema", () => {
  const schema = JSON.parse(readFileSync(claudeSchemaPath, "utf8"));
  const events = hookEventNames(schema);
  for (const event of ["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit"]) {
    assert.ok(events.includes(event), `missing ${event}`);
  }
});

test("codex enum drift reports added and removed members", () => {
  const findings = findCodexEnumDrift(
    refSchema(["danger-full-access", "read-only", "workspace-write"]),
    refSchema(["read-only", "workspace-jail"]),
    { sandbox_mode: "workspace-write" }
  );
  assert.deepEqual(findings, [
    {
      key: "sandbox_mode",
      added: ["danger-full-access", "workspace-write"],
      removed: ["workspace-jail"],
    },
  ]);
});

test("codex enum drift flags a hardcoded value the schema dropped", () => {
  const findings = findCodexEnumDrift(refSchema(["read-only"]), refSchema(["read-only"]), {
    sandbox_mode: "workspace-write",
  });
  assert.deepEqual(findings, [{ key: "sandbox_mode", stale: "workspace-write" }]);
});

test("codex enum drift flags a watched key that vanished entirely", () => {
  const findings = findCodexEnumDrift({ properties: {} }, refSchema(["read-only"]), {
    sandbox_mode: "workspace-write",
  });
  assert.deepEqual(findings, [{ key: "sandbox_mode", missingKey: true }]);
});

test("codex enum drift stays silent when the watched enum is unchanged", () => {
  const schema = refSchema(["read-only", "workspace-write"]);
  assert.deepEqual(findCodexEnumDrift(schema, schema, { sandbox_mode: "workspace-write" }), []);
});

test("claude hook drift flags a hardcoded event the schema dropped", () => {
  const current = { properties: { hooks: { properties: { PreToolUse: {} } } } };
  const previous = { properties: { hooks: { properties: { PreToolUse: {}, SessionStart: {} } } } };
  const findings = findClaudeHookDrift(current, previous, ["PreToolUse", "SessionStart"]);
  assert.deepEqual(findings, [
    { key: "hooks", added: [], removed: ["SessionStart"] },
    { key: "hooks", stale: "SessionStart" },
  ]);
});

test("the shipped schemas keep every value the runtime hardcodes", () => {
  const codex = JSON.parse(readFileSync(codexSchemaPath, "utf8"));
  const claude = JSON.parse(readFileSync(claudeSchemaPath, "utf8"));
  assert.deepEqual(findCodexEnumDrift(codex, codex), []);
  assert.deepEqual(findClaudeHookDrift(claude, claude), []);
});

test("renderSection is empty when nothing drifted", () => {
  assert.equal(renderSection([], []), "");
});

test("renderSection labels stale hardcoded values per host", () => {
  const section = renderSection(
    [{ key: "hooks", stale: "PreToolUse" }],
    [{ key: "sandbox_mode", stale: "workspace-write" }]
  );
  assert.match(section, /## Compat scan — enum drift on watched keys/);
  assert.match(section, /### Claude\n- \*\*STALE HARDCODED\*\* hook event `PreToolUse`/);
  assert.match(section, /### Codex\n- \*\*STALE HARDCODED\*\* `sandbox_mode = "workspace-write"`/);
});
