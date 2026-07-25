import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const agentsMapPath = join(here, "..", "rules", "agents-map.json");

async function loadTiers() {
  return JSON.parse(await readFile(agentsMapPath, "utf8")).models.tiers;
}

function tokensFor(tier, host) {
  const side = tier[host] ?? {};
  return [side.alias, ...(Array.isArray(side.terms) ? side.terms : [])].filter(Boolean);
}

test("agents-map tiers declare an alias for both hosts", async () => {
  for (const tier of await loadTiers()) {
    for (const host of ["claude", "codex"]) {
      assert.equal(typeof tier[host]?.alias, "string", `${tier.id}.${host}.alias must be a string`);
      assert.ok(tier[host].alias.length > 0, `${tier.id}.${host}.alias must be non-empty`);
    }
  }
});

// Every alias and term is a lookup key in modelAliasMap. A token claimed by two tiers resolves by
// declaration order, so one tier silently loses — and an overlay that reuses a token would either
// be ignored or capture one it did not mean to.
test("no model token is claimed by two tiers", async () => {
  const tiers = await loadTiers();
  for (const host of ["claude", "codex"]) {
    const owner = new Map();
    for (const tier of tiers) {
      for (const token of tokensFor(tier, host)) {
        assert.equal(
          owner.has(token),
          false,
          `${host} token ${JSON.stringify(token)} is in both ${owner.get(token)} and ${tier.id}`
        );
        owner.set(token, tier.id);
      }
    }
  }
});

// The alias is what conversion writes, so it has to survive its own mapping unchanged.
test("every alias round-trips back to itself", async () => {
  const tiers = await loadTiers();
  const aliasMap = (from, to) => {
    const map = {};
    for (const tier of tiers) {
      for (const token of tokensFor(tier, from)) map[token] = tier[to].alias;
    }
    return map;
  };
  const forward = aliasMap("claude", "codex");
  const backward = aliasMap("codex", "claude");
  for (const tier of tiers) {
    assert.equal(backward[forward[tier.claude.alias]], tier.claude.alias, `${tier.id} claude`);
    assert.equal(forward[backward[tier.codex.alias]], tier.codex.alias, `${tier.id} codex`);
  }
});
