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

function refSchema(members, { defsKey = "definitions", refPrefix = "#/definitions/" } = {}) {
  return {
    properties: { sandbox_mode: { allOf: [{ $ref: `${refPrefix}SandboxMode` }] } },
    [defsKey]: { SandboxMode: { enum: members, type: "string" } },
  };
}

// The shipped Codex schema states these keys as $ref indirections, which is what the previous
// jq-based check could not follow — it read [] for every watched key and never fired.
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

// Codex ships `definitions`, Claude ships `$defs`; a generator bump can move either host.
test("resolveEnumMembers reads both the definitions and $defs spellings", () => {
  const members = ["read-only", "workspace-write"];
  assert.deepEqual(resolveEnumMembers(refSchema(members), "sandbox_mode"), members);
  assert.deepEqual(
    resolveEnumMembers(
      refSchema(members, { defsKey: "$defs", refPrefix: "#/$defs/" }),
      "sandbox_mode"
    ),
    members
  );
});

test("resolveEnumMembers collects members spelled as oneOf branches", () => {
  const schema = {
    properties: { web_search: { allOf: [{ $ref: "#/definitions/WebSearchMode" }] } },
    definitions: { WebSearchMode: { oneOf: [{ enum: ["live"] }, { enum: ["cached"] }] } },
  };
  assert.deepEqual(resolveEnumMembers(schema, "web_search"), ["cached", "live"]);
});

test("resolveEnumMembers survives a chain of wrappers and a $ref cycle", () => {
  const definitions = { Tail: { enum: ["x"] }, Loop: { allOf: [{ $ref: "#/definitions/Loop" }] } };
  for (let index = 0; index < 6; index += 1) {
    definitions[`Hop${index}`] = {
      allOf: [{ $ref: index === 5 ? "#/definitions/Tail" : `#/definitions/Hop${index + 1}` }],
    };
  }
  const schema = {
    properties: {
      sandbox_mode: { allOf: [{ $ref: "#/definitions/Hop0" }] },
      web_search: { $ref: "#/definitions/Loop" },
    },
    definitions,
  };
  assert.deepEqual(resolveEnumMembers(schema, "sandbox_mode"), ["x"]);
  assert.deepEqual(resolveEnumMembers(schema, "web_search"), []);
});

// allOf narrows and oneOf/anyOf widen. Unioning allOf branches reads a narrowed key as unchanged,
// which is the false negative this guard exists to end.
test("resolveEnumMembers intersects allOf branches instead of unioning them", () => {
  const schema = {
    properties: {
      sandbox_mode: { allOf: [{ $ref: "#/definitions/SandboxMode" }, { enum: ["read-only"] }] },
    },
    definitions: { SandboxMode: { enum: ["danger-full-access", "read-only", "workspace-write"] } },
  };
  assert.deepEqual(resolveEnumMembers(schema, "sandbox_mode"), ["read-only"]);
});

test("codex enum drift flags a hardcoded value an allOf narrowed away", () => {
  const wide = refSchema(["read-only", "workspace-write"]);
  const narrowed = {
    properties: {
      sandbox_mode: { allOf: [{ $ref: "#/definitions/SandboxMode" }, { enum: ["read-only"] }] },
    },
    definitions: wide.definitions,
  };
  const findings = findCodexEnumDrift(narrowed, wide, { sandbox_mode: "workspace-write" });
  assert.deepEqual(findings, [
    { key: "sandbox_mode", added: [], removed: ["workspace-write"] },
    { key: "sandbox_mode", stale: "workspace-write" },
  ]);
});

// The runtime keeps writing its string into whatever the field became, so this is the loudest
// signal available — not a reason to fall back to a plain "enum changed" bullet.
test("codex enum drift flags a hardcoded value when the key stops being an enum", () => {
  const findings = findCodexEnumDrift(
    { properties: { sandbox_mode: { type: "boolean" } } },
    refSchema(["read-only", "workspace-write"]),
    { sandbox_mode: "workspace-write" }
  );
  assert.deepEqual(findings, [
    { key: "sandbox_mode", added: [], removed: ["read-only", "workspace-write"] },
    { key: "sandbox_mode", stale: "workspace-write" },
  ]);
});

test("codex enum drift stays quiet for a key that was never an enum", () => {
  const schema = { properties: { sandbox_mode: { type: "string" } } };
  assert.deepEqual(findCodexEnumDrift(schema, schema, { sandbox_mode: "workspace-write" }), []);
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

// Claude already uses $defs elsewhere in this schema, so hooks moving behind a $ref is the likely
// next shape — reading properties.hooks.properties literally would go blind exactly as jq did.
test("hookEventNames follows a $ref on the hooks property", () => {
  const schema = {
    properties: { hooks: { $ref: "#/$defs/Hooks" } },
    $defs: { Hooks: { properties: { PreToolUse: {}, SessionStart: {} } } },
  };
  assert.deepEqual(hookEventNames(schema), ["PreToolUse", "SessionStart"]);
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

// A newly added snapshot has no HEAD copy. The stale check reads only the current schema, so
// losing the comparison baseline must not take it down with it.
test("codex enum drift still flags a stale hardcoded value with no previous schema", () => {
  const findings = findCodexEnumDrift(refSchema(["read-only"]), null, {
    sandbox_mode: "workspace-write",
  });
  assert.deepEqual(findings, [{ key: "sandbox_mode", stale: "workspace-write" }]);
});

test("claude hook drift still flags a stale hardcoded event with no previous schema", () => {
  const current = { properties: { hooks: { properties: { PreToolUse: {} } } } };
  const findings = findClaudeHookDrift(current, null, ["PreToolUse", "SessionStart"]);
  assert.deepEqual(findings, [{ key: "hooks", stale: "SessionStart" }]);
});

test("codex enum drift flags a watched key that vanished entirely", () => {
  const findings = findCodexEnumDrift(
    { properties: { approval_policy: {} } },
    refSchema(["read-only"]),
    { sandbox_mode: "workspace-write" }
  );
  assert.deepEqual(findings, [{ key: "sandbox_mode", missingKey: true }]);
});

// snapshot-upstream writes any body that parses as JSON, so an upstream 200 carrying an error
// payload lands here looking valid. Diffing it would claim every watched key lost every member.
test("codex enum drift reports a non-schema snapshot instead of diffing it", () => {
  const findings = findCodexEnumDrift({ message: "Moved" }, refSchema(["read-only"]), {
    sandbox_mode: "workspace-write",
  });
  assert.deepEqual(findings, [{ notASchema: true }]);
});

test("claude hook drift reports a non-schema snapshot instead of diffing it", () => {
  const previous = { properties: { hooks: { properties: { PreToolUse: {} } } } };
  assert.deepEqual(findClaudeHookDrift({ message: "Moved" }, previous), [{ notASchema: true }]);
});

test("renderSection names a snapshot that parsed but is not a schema", () => {
  assert.match(
    renderSection([], [{ notASchema: true }]),
    /\*\*SCAN SKIPPED\*\* the snapshot parsed/
  );
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

// Silence is how a reviewer concludes the scan ran and found nothing, so a skipped scan must say so.
test("renderSection reports a schema it could not read instead of staying silent", () => {
  const section = renderSection([], [{ unreadable: "snapshots/codex/config-schema.json" }]);
  assert.match(section, /\*\*SCAN SKIPPED\*\* `snapshots\/codex\/config-schema\.json`/);
});
