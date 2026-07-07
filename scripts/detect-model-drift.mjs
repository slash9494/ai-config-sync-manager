import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROSE_FILES = [
  "snapshots/claude/changelog.md",
  "snapshots/claude/releases.json",
  "snapshots/codex/changelog.md",
  "snapshots/codex/releases.json",
];

// Version-bearing mentions only — a bare "Claude Sonnet" is already a known term and would be noise.
// "Claude" prefix is required for display names: Opus/Sonnet/Haiku are common English words, so a bare
// "a haiku 5 lines" must not register. GPT is safe bare; separator is optional ("GPT6", "gpt5.5") and variant
// suffixes (gpt-4o, gpt-5.5-codex-spark) are kept whole. Legacy mentions (GPT-4) may surface as candidates —
// cheap human-review noise, preferred over the silent misses a version floor caused.
// Fable is intentionally excluded — it is only a short-lived Claude offering, not a mapped tier.
// Known gap (deliberate): non-gpt Codex names (o-series, "Codex Max") aren't matched — a `codex \w+` pattern
// would flag the "Codex CLI" product name on every line. Codex ships gpt-* naming, so revisit only if that changes.
const MODEL_PATTERNS = [
  { host: "claude", re: /Claude\s+(?:Opus|Sonnet|Haiku)\s+\d+(?:\.\d+)*/gi },
  { host: "claude", re: /claude-(?:opus|sonnet|haiku)-\d[\w.-]*/gi },
  { host: "codex", re: /\bgpt[-\s]?\d+\w*(?:[.-]\w+)*/gi },
];

const CLAUDE_FAMILIES = ["opus", "sonnet", "haiku"];

function normalize(token) {
  return token.toLowerCase().replace(/\s+/g, " ").trim();
}

export function knownModelTokens(tiers) {
  const known = new Set();
  for (const tier of tiers) {
    for (const side of ["claude", "codex"]) {
      const entry = tier[side];
      if (!entry) continue;
      if (entry.alias) known.add(normalize(entry.alias));
      for (const term of entry.terms || []) known.add(normalize(term));
    }
  }
  return known;
}

export function extractModelMentions(text) {
  const found = new Map();
  for (const { host, re } of MODEL_PATTERNS) {
    for (const match of text.matchAll(re)) {
      const raw = match[0];
      const key = normalize(raw);
      if (!found.has(key)) found.set(key, { raw, host, key });
    }
  }
  return [...found.values()];
}

function claudeFamily(key) {
  return CLAUDE_FAMILIES.find((fam) => key.includes(fam)) || null;
}

function tierHint(candidate, tiers) {
  if (candidate.host === "codex") return { tierId: null, note: "codex tier 확인 필요" };
  const fam = claudeFamily(candidate.key);
  if (!fam) return { tierId: null, note: "새 tier 후보" };
  const tier = tiers.find((t) => t.claude && t.claude.alias === fam);
  if (!tier) return { tierId: null, note: `새 tier 후보 (${fam})` };
  return { tierId: tier.id, note: "기존 tier terms 갱신 권장" };
}

export function findModelDrift(text, tiers) {
  const known = knownModelTokens(tiers);
  return extractModelMentions(text)
    .filter((c) => !known.has(c.key))
    .map((c) => ({ ...c, ...tierHint(c, tiers) }));
}

export function renderSection(candidates) {
  if (candidates.length === 0) return "";
  const lines = candidates.map((c) => {
    const tier = c.tierId ? `추정 tier: ${c.tierId}` : c.note;
    return `- \`${c.raw}\` (${tier})${c.tierId ? ` — ${c.note}` : ""}`;
  });
  return [
    "",
    "## Model drift — agents-map.models.tiers 갱신 필요",
    "",
    "신규 모델 후보 (스키마에 없어 구조 스캔이 놓침). `rules/agents-map.json` `models.tiers` 확인:",
    "",
    ...lines,
    "",
  ].join("\n");
}

function addedProse() {
  let raw;
  try {
    raw = execFileSync("git", ["diff", "--", ...PROSE_FILES], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return "";
  }
  return raw
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

function main() {
  const tiers = JSON.parse(readFileSync("rules/agents-map.json", "utf8")).models.tiers;
  const section = renderSection(findModelDrift(addedProse(), tiers));
  if (section) process.stdout.write(section);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
