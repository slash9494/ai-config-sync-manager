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

test("renderSection returns empty string with no candidates and a section otherwise", () => {
  assert.equal(renderSection([]), "");
  const section = renderSection(findModelDrift("Claude Sonnet 5 launched.", TIERS));
  assert.match(section, /## Model drift/);
  assert.match(section, /Claude Sonnet 5/);
});
