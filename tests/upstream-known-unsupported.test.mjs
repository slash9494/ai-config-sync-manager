import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const allowlistPath = join(here, "..", "rules", "upstream-known-unsupported.json");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHORT_SHA256 = /^[0-9a-f]{12}$/;
const SCOPES = ["claude_top_level", "claude_nested", "codex_top_level", "codex_nested"];
const DIRECTIONS = ["claude_to_codex", "codex_to_claude"];

async function loadAllowlist() {
  const raw = await readFile(allowlistPath, "utf8");
  return JSON.parse(raw);
}

function isValidDirectionValue(value) {
  if (value === "drop" || value === "preserve") return true;
  if (typeof value !== "string") return false;
  return value.startsWith("bidirectional-equiv:") && value.length > "bidirectional-equiv:".length;
}

function parseIsoDate(s) {
  if (!ISO_DATE.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

test("upstream-known-unsupported.json parses and has all required scopes", async () => {
  const allowlist = await loadAllowlist();
  assert.equal(typeof allowlist, "object");
  for (const scope of SCOPES) {
    assert.ok(scope in allowlist, `missing scope: ${scope}`);
    assert.equal(typeof allowlist[scope], "object", `scope ${scope} must be an object`);
    assert.ok(!Array.isArray(allowlist[scope]), `scope ${scope} must be an object, not an array`);
  }
});

test("upstream-known-unsupported.json entries declare required fields with correct shape", async () => {
  const allowlist = await loadAllowlist();
  for (const scope of SCOPES) {
    for (const [key, entry] of Object.entries(allowlist[scope])) {
      const where = `${scope}.${key}`;
      assert.equal(typeof entry, "object", `${where} must be an object`);
      assert.equal(typeof entry.reason, "string", `${where}.reason must be a string`);
      assert.ok(entry.reason.length > 0, `${where}.reason must be non-empty`);
      assert.equal(typeof entry.decided_in, "string", `${where}.decided_in must be a string`);
      assert.match(entry.decided_at, ISO_DATE, `${where}.decided_at must be YYYY-MM-DD`);
      assert.match(entry.recheck_after, ISO_DATE, `${where}.recheck_after must be YYYY-MM-DD`);
      // top_level entries must carry a hash (hash_drift_section consumes only top_level; a missing hash emits phantom drift every run). nested fields whose schema is a bare $ref / has no description omit it, matching the scan's empty-desc skip.
      if (scope.endsWith("_top_level") || "schema_desc_hash" in entry) {
        assert.match(
          entry.schema_desc_hash,
          SHORT_SHA256,
          `${where}.schema_desc_hash must be 12 hex chars`
        );
      }
      assert.equal(typeof entry.direction, "object", `${where}.direction must be an object`);
      for (const dir of DIRECTIONS) {
        assert.ok(dir in entry.direction, `${where}.direction.${dir} missing`);
        assert.ok(
          isValidDirectionValue(entry.direction[dir]),
          `${where}.direction.${dir} = ${JSON.stringify(entry.direction[dir])} must be "drop", "preserve", or "bidirectional-equiv:<key>"`
        );
      }
    }
  }
});

test("upstream-known-unsupported.json recheck_after is strictly after decided_at", async () => {
  const allowlist = await loadAllowlist();
  for (const scope of SCOPES) {
    for (const [key, entry] of Object.entries(allowlist[scope])) {
      const where = `${scope}.${key}`;
      const decided = parseIsoDate(entry.decided_at);
      const recheck = parseIsoDate(entry.recheck_after);
      assert.ok(decided !== null, `${where}.decided_at unparseable`);
      assert.ok(recheck !== null, `${where}.recheck_after unparseable`);
      assert.ok(
        recheck > decided,
        `${where}.recheck_after (${entry.recheck_after}) must be after decided_at (${entry.decided_at})`
      );
    }
  }
});

test("upstream-known-unsupported.json bidirectional-equiv targets reference existing scope keys", async () => {
  const allowlist = await loadAllowlist();
  const oppositeScope = (scope) =>
    scope.startsWith("claude_")
      ? scope.replace("claude_", "codex_")
      : scope.replace("codex_", "claude_");
  for (const scope of SCOPES) {
    for (const [key, entry] of Object.entries(allowlist[scope])) {
      for (const dir of DIRECTIONS) {
        const value = entry.direction[dir];
        if (typeof value !== "string" || !value.startsWith("bidirectional-equiv:")) continue;
        const target = value.slice("bidirectional-equiv:".length);
        const opposite = oppositeScope(scope);
        assert.ok(
          target in (allowlist[opposite] ?? {}),
          `${scope}.${key}.direction.${dir} points to ${target} but ${opposite}.${target} does not exist`
        );
      }
    }
  }
});

test("upstream-known-unsupported.json PR #5 seed entries are present in codex_top_level", async () => {
  const allowlist = await loadAllowlist();
  const seeded = [
    "apps_mcp_product_sku",
    "desktop",
    "include_collaboration_mode_instructions",
    "model_auto_compact_token_limit_scope",
  ];
  for (const key of seeded) {
    assert.ok(
      key in allowlist.codex_top_level,
      `seed entry codex_top_level.${key} missing — PR #5 decisions must remain recorded`
    );
  }
});
