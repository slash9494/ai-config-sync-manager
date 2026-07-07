import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROSE_FILES = [
  "snapshots/claude/changelog.md",
  "snapshots/claude/releases.json",
  "snapshots/codex/changelog.md",
  "snapshots/codex/releases.json",
];

// Only version-bearing mentions trigger — a bare "Claude Sonnet" is already a known term and would be noise.
// "Claude" prefix is optional (prose says "Opus 4.8" too); GPT accepts hyphen or space and keeps trailing
// variant suffixes (gpt-4o, gpt-5.5-codex-spark) whole.
const MODEL_PATTERNS = [
  { host: "claude", re: /(?:Claude\s+)?(?:Opus|Sonnet|Haiku|Fable)\s+\d+(?:\.\d+)*/gi },
  { host: "claude", re: /claude-(?:opus|sonnet|haiku|fable)-\d[\w.-]*/gi },
  { host: "codex", re: /\bgpt[-\s]\d+\w*(?:[.-]\w+)*/gi },
];

const CLAUDE_FAMILIES = ["opus", "sonnet", "haiku", "fable"];

function normalize(token) {
  return token.toLowerCase().replace(/\s+/g, " ").trim();
}

// float compare is a heuristic (4.10 sorts below 4.7) — fine for single-digit minor bumps; revisit if versions grow.
function parseVersion(str) {
  const match = String(str).match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function candidateFamily(candidate) {
  return candidate.host === "codex" ? "gpt" : claudeFamily(candidate.key);
}

export function maxVersionByFamily(tiers) {
  const max = new Map();
  const add = (family, str) => {
    const v = parseVersion(str);
    if (v === null) return;
    if (!max.has(family) || v > max.get(family)) max.set(family, v);
  };
  for (const tier of tiers) {
    if (tier.claude)
      for (const s of [tier.claude.alias, ...(tier.claude.terms || [])]) add(tier.claude.alias, s);
    if (tier.codex) for (const s of [tier.codex.alias, ...(tier.codex.terms || [])]) add("gpt", s);
  }
  return max;
}

// New only if the family is unseen, has no recorded version, or the mention outranks the newest known version —
// keeps legacy mentions (GPT-4, gpt-3.5) out of the drift list.
function isNewModel(candidate, maxByFamily) {
  const family = candidateFamily(candidate);
  if (!family || !maxByFamily.has(family)) return true;
  const v = parseVersion(candidate.raw);
  return v === null || v > maxByFamily.get(family);
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
  const maxByFamily = maxVersionByFamily(tiers);
  return extractModelMentions(text)
    .filter((c) => !known.has(c.key))
    .filter((c) => isNewModel(c, maxByFamily))
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
