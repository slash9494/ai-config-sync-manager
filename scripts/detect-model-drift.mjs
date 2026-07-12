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
// capitalized name in a model position and drop it only when it is a known non-model word.
// Stopwords are the inverse risk of an allowlist: a stopword that later becomes a real model name
// silently misses it, so the lists stay tight, grounded, and HOST-SCOPED. Grammar words are never a
// model in any position → global. Product/plan words were grounded in the "Claude <word>" slot
// (Code appears 130×, Platform/API/Pro/Max/Desktop/Browser/Skills/Agent/Fable are Claude products,
// plans, or an unmapped model) — but on the Codex side "Pro"/"Max" are REAL model tiers (GPT-5 Pro,
// o1-pro), so applying them there would silently drop a new variant whose base tier is already known.
// Hence product words apply to the claude patterns only. New names surface by default; cheap
// human-review noise beats a silent miss (this is what let a tier bump slip through before).
// Known gap (deliberate): a name with no anchor at all ("Terra" alone, no Claude/gpt/o prefix) is not
// matched — it would false-positive on the common word.
const GRAMMAR_STOPWORDS = new Set([
  "family",
  "families",
  "series",
  "model",
  "models",
  "preview",
  "release",
  "generation",
]);
const CLAUDE_PRODUCT_STOPWORDS = new Set([
  "code",
  "platform",
  "api",
  "pro",
  "max",
  "desktop",
  "browser",
  "skills",
  "agent",
  "fable",
]);
function isStopword(host, name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return GRAMMAR_STOPWORDS.has(lower) || (host === "claude" && CLAUDE_PRODUCT_STOPWORDS.has(lower));
}
// Claude display names ship in both orders — name-then-version ("Claude Opus 4.8") and
// version-then-name ("Claude 3.5 Haiku", still current) — so both are matched. The anchor is
// case-insensitive ([Cc]laude / [Gg][Pp][Tt]) while the name char-class stays case-sensitive: an /i/
// flag would collapse [A-Z] and let lowercase prose words through as false model names.
const MODEL_PATTERNS = [
  { host: "claude", re: /[Cc]laude\s+([A-Z][a-zA-Z]*)\s+\d+(?:\.\d+)*/g, nameGroup: 1 },
  { host: "claude", re: /[Cc]laude\s+\d+(?:\.\d+)*\s+([A-Z][a-zA-Z]*)/g, nameGroup: 1 },
  { host: "claude", re: /claude-([a-z]+)-\d[\w.-]*/gi, nameGroup: 1 },
  { host: "codex", re: /\bgpt[-\s]?\d+\w*(?:[.-]\w+)*/gi },
  { host: "codex", re: /\b[Gg][Pp][Tt][-\s]?\d+(?:\.\d+)*\s+([A-Z][a-zA-Z]*)\b/g, nameGroup: 1 },
  // OpenAI o-series reasoning ids (o1, o3-pro, o4-mini). Bare "o<digit>" is anchored on a word boundary
  // and a required digit, so prose like "to 3" or "video" does not match.
  { host: "codex", re: /\bo\d+(?:-[a-z]+)*\b/gi },
];

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
      if (nameGroup && isStopword(host, match[nameGroup])) continue;
      const raw = match[0];
      const key = normalize(raw);
      if (!found.has(key)) found.set(key, { raw, host, key });
    }
  }
  // Drop a bare-id fragment when a longer same-host mention extends it with a name ("GPT-7.0" vs
  // "GPT-7.0 Nova") — the specific one already carries the family, so the fragment is duplicate noise.
  const all = [...found.values()];
  return all.filter(
    (a) => !all.some((b) => b !== a && b.host === a.host && b.key.startsWith(`${a.key} `))
  );
}

// Family list is derived from the tiers, not enumerated — a new claude alias needs no edit here.
function claudeTier(key, tiers) {
  return tiers.find((t) => t.claude?.alias && key.includes(t.claude.alias)) || null;
}

function tierHint(candidate, tiers) {
  if (candidate.host === "codex") return { tierId: null, note: "codex tier 확인 필요" };
  const tier = claudeTier(candidate.key, tiers);
  if (!tier) return { tierId: null, note: "새 tier 후보" };
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
  } catch (err) {
    // Surface the failure — a silent "" is indistinguishable from "no new prose" and would report no drift.
    process.stderr.write(
      `detect-model-drift: git diff failed, treating prose as empty: ${err.message}\n`
    );
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
