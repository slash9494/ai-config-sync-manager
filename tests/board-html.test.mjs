import test from "node:test";
import assert from "node:assert/strict";

import { buildBoardModel, renderBoardHtml } from "../bin/util/board-html.mjs";

function boardInput(overrides) {
  return {
    inventory: [],
    overlays: [],
    direction: { from: "claude", to: "codex" },
    scopes: ["project"],
    ...overrides,
  };
}

function inventoryItem(overrides) {
  return {
    area: "skills",
    scope: "project",
    name: "alpha",
    inClaude: true,
    inCodex: true,
    claudePath: "",
    codexPath: "",
    ...overrides,
  };
}

function overlayItem(overrides) {
  return { scope: "project", area: "skills", name: "alpha", status: "conflict", ...overrides };
}

function groupItems(group) {
  return group.harnessGroups ? group.harnessGroups.flatMap((sub) => sub.items) : group.items;
}

function allItems(model) {
  return model.areas.flatMap((area) => area.groups.flatMap(groupItems));
}

function findItem(model, name) {
  return allItems(model).find((item) => item.name === name);
}

test("buildBoardModel marks an item present on both hosts without an overlay as in-sync", () => {
  const model = buildBoardModel(boardInput({ inventory: [inventoryItem({ name: "alpha" })] }));
  assert.equal(findItem(model, "alpha").status, "in-sync");
});

test("buildBoardModel maps single-host inventory membership to host-only status", () => {
  const model = buildBoardModel(
    boardInput({
      inventory: [
        inventoryItem({ name: "claudeside", inClaude: true, inCodex: false }),
        inventoryItem({ name: "codexside", inClaude: false, inCodex: true }),
      ],
    })
  );
  assert.equal(findItem(model, "claudeside").status, "claude-only");
  assert.equal(findItem(model, "codexside").status, "codex-only");
});

test("buildBoardModel overlays a conflict onto an in-sync inventory item", () => {
  const model = buildBoardModel(
    boardInput({
      inventory: [inventoryItem({ name: "alpha" })],
      overlays: [overlayItem({ name: "alpha", status: "conflict" })],
    })
  );
  assert.equal(findItem(model, "alpha").status, "conflict");
});

test("buildBoardModel overlays a host-only status onto an in-sync item", () => {
  const model = buildBoardModel(
    boardInput({
      inventory: [inventoryItem({ name: "alpha" })],
      overlays: [overlayItem({ name: "alpha", status: "claude-only" })],
    })
  );
  assert.equal(findItem(model, "alpha").status, "claude-only");
});

test("buildBoardModel overlays an unsupported status onto an inventory item", () => {
  const model = buildBoardModel(
    boardInput({
      inventory: [inventoryItem({ area: "hooks", name: "watchdog" })],
      overlays: [overlayItem({ area: "hooks", name: "watchdog", status: "unsupported" })],
    })
  );
  assert.equal(findItem(model, "watchdog").status, "unsupported");
});

test("buildBoardModel adds an overlay item that is absent from the inventory", () => {
  const model = buildBoardModel(
    boardInput({
      overlays: [overlayItem({ area: "hooks", name: "orphan", status: "codex-only" })],
    })
  );
  const orphan = findItem(model, "orphan");
  assert.ok(orphan, "overlay-only item should be added to the model");
  assert.equal(orphan.status, "codex-only");
});

test("buildBoardModel aggregates counts per area and per status", () => {
  const model = buildBoardModel(
    boardInput({
      inventory: [
        inventoryItem({ area: "skills", name: "alpha", inClaude: true, inCodex: true }),
        inventoryItem({ area: "skills", name: "beta", inClaude: true, inCodex: false }),
        inventoryItem({ area: "agents", name: "gamma", inClaude: false, inCodex: true }),
      ],
    })
  );

  assert.deepEqual(model.areaSummary, [
    { area: "skills", count: 2 },
    { area: "agents", count: 1 },
  ]);

  const statusCounts = Object.fromEntries(
    model.statusSummary.map((entry) => [entry.status, entry.count])
  );
  assert.deepEqual(statusCounts, { "claude-only": 1, "codex-only": 1, "in-sync": 1 });
});

test("renderBoardHtml includes every item name", () => {
  const model = buildBoardModel(
    boardInput({
      inventory: [
        inventoryItem({ name: "alpha" }),
        inventoryItem({ name: "beta", inClaude: true, inCodex: false }),
      ],
    })
  );
  const html = renderBoardHtml(model);
  assert.match(html, /alpha/);
  assert.match(html, /beta/);
});

test("renderBoardHtml embeds no external references", () => {
  const html = renderBoardHtml(
    buildBoardModel(boardInput({ inventory: [inventoryItem({ name: "alpha" })] }))
  );
  assert.doesNotMatch(html, /<script\s+src=/);
  assert.doesNotMatch(html, /<link\b/);
  assert.doesNotMatch(html, /(?:href|src)="https?:/);
});

test("renderBoardHtml escapes markup and quotes in names and descriptions", () => {
  const model = buildBoardModel(
    boardInput({ inventory: [inventoryItem({ name: 'a"b<c>' })] }),
    () => 'desc <i>"x"'
  );
  const html = renderBoardHtml(model);
  assert.match(html, /a&quot;b&lt;c&gt;/);
  assert.match(html, /desc &lt;i&gt;&quot;x&quot;/);
  assert.doesNotMatch(html, /<c>/);
  assert.doesNotMatch(html, /<i>/);
});

test("renderBoardHtml renders a status color marker and label per status", () => {
  const html = renderBoardHtml(
    buildBoardModel(boardInput({ inventory: [inventoryItem({ name: "alpha" })] }))
  );
  assert.match(html, /#22c55e/);
  assert.match(html, /In sync/);
  assert.match(html, /class="item"/);
  assert.match(html, /class="dot"/);
});

test("renderBoardHtml colors claude-only and codex-only distinctly", () => {
  const html = renderBoardHtml(
    buildBoardModel(
      boardInput({
        inventory: [
          inventoryItem({ name: "claudeside", inClaude: true, inCodex: false }),
          inventoryItem({ name: "codexside", inClaude: false, inCodex: true }),
        ],
      })
    )
  );
  assert.match(html, /#3b82f6/);
  assert.match(html, /#a855f7/);
});

test("renderBoardHtml renders an area tab and section marker per area", () => {
  const model = buildBoardModel(
    boardInput({
      inventory: [
        inventoryItem({ area: "skills", name: "alpha" }),
        inventoryItem({ area: "agents", name: "beta" }),
      ],
    })
  );
  const html = renderBoardHtml(model);
  assert.match(html, /class="tab[^"]*"[^>]*data-tab="skills"/);
  assert.match(html, /data-tab="agents"/);
  assert.match(html, /class="area"[^>]*data-area="skills"/);
  assert.match(html, /class="area"[^>]*data-area="agents"/);
});

test("buildBoardModel groups agents by harness within a scope, ungrouped first", () => {
  const model = buildBoardModel(
    boardInput({
      inventory: [
        inventoryItem({ area: "agents", name: "rooted", harness: null }),
        inventoryItem({ area: "agents", name: "nested", harness: "refactor" }),
      ],
    })
  );
  const agents = model.areas.find((area) => area.area === "agents");
  const [group] = agents.groups;
  assert.ok(group.harnessGroups, "agents scope groups carry harness subgroups");
  assert.equal(group.harnessGroups[0].harness, null);
  assert.equal(group.harnessGroups[0].items[0].name, "rooted");
  assert.equal(group.harnessGroups[1].harness, "refactor");
  assert.equal(group.harnessGroups[1].items[0].name, "nested");
});

test("buildBoardModel keeps non-agent areas as flat item groups", () => {
  const model = buildBoardModel(
    boardInput({ inventory: [inventoryItem({ area: "skills", name: "alpha" })] })
  );
  const skills = model.areas.find((area) => area.area === "skills");
  assert.ok(skills.groups[0].items, "skills scope groups stay flat");
  assert.equal(skills.groups[0].harnessGroups, undefined);
});

test("renderBoardHtml includes the harness folder name in an agent's filter search text", () => {
  const html = renderBoardHtml(
    buildBoardModel(
      boardInput({
        inventory: [inventoryItem({ area: "agents", name: "nested", harness: "browser-audit" })],
      })
    )
  );
  assert.match(html, /data-search="[^"]*browser-audit[^"]*"/);
});

test("renderBoardHtml labels a harness subgroup and omits a label for ungrouped agents", () => {
  const html = renderBoardHtml(
    buildBoardModel(
      boardInput({
        inventory: [
          inventoryItem({ area: "agents", name: "rooted", harness: null }),
          inventoryItem({ area: "agents", name: "nested", harness: "refactor" }),
        ],
      })
    )
  );
  assert.match(html, /class="harness-label">refactor</);
  assert.doesNotMatch(html, /class="harness-label">rooted</);
});
