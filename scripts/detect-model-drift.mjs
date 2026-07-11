import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROSE_FILES = [
  "snapshots/claude/changelog.md",
  "snapshots/claude/releases.json",
  "snapshots/codex/changelog.md",
  "snapshots/codex/releases.json",
];

// A mention must carry a version number (Claude display name) or a gpt-<n> anchor (Codex) — a bare
// "Sonnet" or "a haiku 5 lines" is noise. Model FAMILY / tier names are deliberately NOT enumerated:
// they are unpredictable (Opus→…, Sol/Terra/Luna, and whatever ships next), so an allowlist of known
// names would silently miss the very thing this detector exists to catch. Instead we match any
// capitalized name in a model position and drop it only when it is a known non-model word
// (MODEL_STOPWORDS) — a stable grammar/product denylist. New names surface by default; cheap
// human-review noise is preferred over a silent miss (this is what let a tier bump slip through before).
// Fable is excluded via the stopword list (a real model, intentionally not a mapped tier).
// Known gap (deliberate): a name with no Claude/gpt anchor ("Terra" alone) is not matched — it would
// false-positive on the common word; non-gpt Codex ids (o-series) also stay unmatched by the gpt anchor.
const MODEL_STOPWORDS = new Set([
  "family",
  "families",
  "series",
  "model",
  "models",
  "preview",
  "release",
  "generation",
  "today",
  "now",
  "available",
  "api",
  "code",
  "desktop",
  "platform",
  "app",
  "cli",
  "bedrock",
  "vertex",
  "azure",
  "fable",
]);
const MODEL_PATTERNS = [
  { host: "claude", re: /Claude\s+([A-Z][a-zA-Z]*)\s+\d+(?:\.\d+)*/g, nameGroup: 1 },
  { host: "claude", re: /claude-([a-z]+)-\d[\w.-]*/gi, nameGroup: 1 },
  { host: "codex", re: /\bgpt[-\s]?\d+\w*(?:[.-]\w+)*/gi },
  { host: "codex", re: /\b[Gg][Pp][Tt][-\s]?\d+(?:\.\d+)*\s+([A-Z][a-zA-Z]*)\b/g, nameGroup: 1 },
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
  for (const { host, re, nameGroup } of MODEL_PATTERNS) {
    for (const match of text.matchAll(re)) {
      if (nameGroup && MODEL_STOPWORDS.has(match[nameGroup]?.toLowerCase())) continue;
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
