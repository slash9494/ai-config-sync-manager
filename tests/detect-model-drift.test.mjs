import test from "node:test";
import assert from "node:assert/strict";
import {
  knownModelTokens,
  extractModelMentions,
  findModelDrift,
  renderSection,
} from "../scripts/detect-model-drift.mjs";

const TIERS = [
  {
    id: "latest-frontier-model",
    claude: { alias: "opus", terms: ["Claude Opus 4.7", "Opus 4.7", "Opus"] },
    codex: { alias: "gpt-5.5", terms: ["GPT-5.5"] },
  },
  {
    id: "balanced-model",
    claude: { alias: "sonnet", terms: ["Claude Sonnet", "Sonnet"] },
    codex: { alias: "gpt-5.4", terms: ["GPT-5.4"] },
  },
  {
    id: "small-fast-model",
    claude: { alias: "haiku", terms: ["Claude Haiku", "Haiku"] },
    codex: { alias: "gpt-5.4-mini", terms: ["GPT-5.4-Mini"] },
  },
];

test("model drift detector flags a new versioned model absent from tiers", () => {
  const prose = "- Introducing Claude Sonnet 5: now the default model in Claude Code.";
  const drift = findModelDrift(prose, TIERS);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].raw, "Claude Sonnet 5");
  assert.equal(drift[0].tierId, "balanced-model");
});

test("model drift detector stays silent when only known models appear", () => {
  const prose = "Bugfix for Claude Opus 4.7 and GPT-5.4-Mini and a bare Sonnet mention.";
  assert.deepEqual(findModelDrift(prose, TIERS), []);
});

test("stale tier surfaces when Opus bumps past the recorded version", () => {
  const prose = "Claude Opus 4.8 replaces Opus 4.7 as the frontier model.";
  const drift = findModelDrift(prose, TIERS);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].tierId, "latest-frontier-model");
  assert.match(drift[0].note, /갱신/);
});

test("Fable is intentionally excluded from detection", () => {
  assert.deepEqual(findModelDrift("Meet Claude Fable 5, a creative-writing model.", TIERS), []);
});

test("hyphenated model ids are extracted", () => {
  const mentions = extractModelMentions("claude-opus-4-8-20260101 and gpt-6.0 shipped");
  const raws = mentions.map((m) => m.raw);
  assert.ok(raws.some((r) => r.startsWith("claude-opus-4-8")));
  assert.ok(raws.includes("gpt-6.0"));
});

test("knownModelTokens flattens alias and terms case-insensitively", () => {
  const known = knownModelTokens(TIERS);
  assert.ok(known.has("opus"));
  assert.ok(known.has("claude opus 4.7"));
  assert.ok(known.has("gpt-5.4-mini"));
});

test("bare family words without the Claude prefix are not flagged as models", () => {
  assert.deepEqual(
    findModelDrift("wrote a haiku 5 lines long and his opus 3 masterpiece.", TIERS),
    []
  );
});

test("Claude-prefixed display name is required for a claude model to register", () => {
  const drift = findModelDrift("Claude Opus 4.8 is the new frontier.", TIERS);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].raw, "Claude Opus 4.8");
  assert.equal(drift[0].tierId, "latest-frontier-model");
});

test("space-separated GPT mention is flagged", () => {
  const drift = findModelDrift("Now powered by GPT 6.0.", TIERS);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].host, "codex");
});

test("separator-less GPT form is flagged", () => {
  const raws = extractModelMentions("shipped GPT6 and gpt5.5-turbo").map((m) => m.raw);
  assert.ok(raws.includes("GPT6"));
  assert.ok(raws.includes("gpt5.5-turbo"));
});

test("variant suffixes are kept whole, not truncated", () => {
  const raws = extractModelMentions("shipped gpt-4o and gpt-6.5-codex-spark").map((m) => m.raw);
  assert.ok(raws.includes("gpt-4o"));
  assert.ok(raws.includes("gpt-6.5-codex-spark"));
});

test("space-separated GPT capability-tier names are flagged", () => {
  const raws = extractModelMentions(
    "GPT-5.6 Sol leads, GPT-5.6 Terra balances, GPT-5.6 Luna scales."
  ).map((m) => m.raw);
  assert.ok(raws.includes("GPT-5.6 Sol"));
  assert.ok(raws.includes("GPT-5.6 Terra"));
  assert.ok(raws.includes("GPT-5.6 Luna"));
});

test("hyphenated GPT variant ids stay whole", () => {
  const raws = extractModelMentions(
    "Use gpt-5.6-terra for balance and gpt-5.6-luna for volume."
  ).map((m) => m.raw);
  assert.ok(raws.includes("gpt-5.6-terra"));
  assert.ok(raws.includes("gpt-5.6-luna"));
});

test("bare capability-tier words without the gpt anchor are not flagged", () => {
  assert.deepEqual(
    findModelDrift("Sol, Terra, and Luna are Latin words for sun, earth, and moon.", TIERS),
    []
  );
});

test("an unpredictable future codex tier name surfaces without being enumerated", () => {
  const raws = extractModelMentions("The new GPT-7.0 Nova model ships today.").map((m) => m.raw);
  assert.ok(raws.includes("GPT-7.0 Nova"));
});

test("product/plan stopwords are claude-scoped — codex Pro/Max variants still surface", () => {
  // "Pro"/"Max" are Claude plans but real Codex model tiers; dropping them on the codex side would
  // silently miss a new variant whose base tier is already known (edge-audit EA-1/EA-2).
  const codex = extractModelMentions("GPT-5.4 Pro and GPT-5.6 Max launched.").map((m) => m.raw);
  assert.ok(codex.includes("GPT-5.4 Pro"));
  assert.ok(codex.includes("GPT-5.6 Max"));
  // Same words on the claude side stay filtered (Claude Pro / Claude Max are plans, not models).
  const claude = extractModelMentions("Claude Pro 5 and Claude Max 6 updated.").map((m) => m.raw);
  assert.equal(claude.length, 0);
});

test("OpenAI o-series ids are detected", () => {
  const raws = extractModelMentions("Shipped o3-pro, o4-mini, and o1 today.").map((m) => m.raw);
  assert.ok(raws.includes("o3-pro"));
  assert.ok(raws.includes("o4-mini"));
  assert.ok(raws.includes("o1"));
});

test("a bare id fragment is dropped when a named mention extends it", () => {
  const raws = extractModelMentions("The GPT-7.0 Nova model ships.").map((m) => m.raw);
  assert.ok(raws.includes("GPT-7.0 Nova"));
  assert.ok(!raws.includes("GPT-7.0"));
});

test("an unpredictable future claude family surfaces without being enumerated", () => {
  const drift = findModelDrift("Meet Claude Nova 1, our newest family.", TIERS);
  assert.ok(drift.some((c) => c.raw === "Claude Nova 1"));
});

test("version-then-name Claude order is matched (Claude 3.5 Haiku)", () => {
  const raws = extractModelMentions("Claude 3.5 Haiku and Claude 5.0 Zenith shipped.").map(
    (m) => m.raw
  );
  assert.ok(raws.includes("Claude 3.5 Haiku"));
  assert.ok(raws.includes("Claude 5.0 Zenith"));
});

test("Claude product/plan words in the name slot are dropped (grounded stopwords)", () => {
  const raws = extractModelMentions(
    "Claude Code 2 and Claude Platform 3 and Claude Max 4 updated."
  ).map((m) => m.raw);
  assert.equal(raws.length, 0);
});

test("capitalized non-model words in a model position are dropped by the stopword denylist", () => {
  const raws = extractModelMentions("The GPT-5.6 Family grows; Claude Code 2 shipped.").map(
    (m) => m.raw
  );
  assert.ok(!raws.some((r) => /Family/.test(r)));
  assert.ok(!raws.some((r) => /Claude Code/.test(r)));
});

test("renderSection returns empty string with no candidates and a section otherwise", () => {
  assert.equal(renderSection([]), "");
  const section = renderSection(findModelDrift("Claude Sonnet 5 launched.", TIERS));
  assert.match(section, /## Model drift/);
  assert.match(section, /Claude Sonnet 5/);
});
