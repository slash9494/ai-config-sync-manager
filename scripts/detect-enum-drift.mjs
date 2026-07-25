import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CODEX_SCHEMA = "snapshots/codex/config-schema.json";
const CLAUDE_SCHEMA = "snapshots/claude/settings-schema.json";

// Watched key -> the value bin/ai-config-sync.mjs writes for it.
const CODEX_WATCH = {
  sandbox_mode: "workspace-write",
  approval_policy: "on-request",
  web_search: "live",
};
const CLAUDE_HOOK_EVENTS = ["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit"];

// The two hosts already disagree: the Codex schema is draft-07 with `definitions`, the Claude one
// uses `$defs`. Supporting only the spelling a host happens to use today would turn a schema
// generator bump into "every member was removed" plus a silently skipped stale check.
const REF_PREFIXES = ["#/definitions/", "#/$defs/"];
const MAX_REF_HOPS = 16;
const COMPOSITION_KEYS = ["oneOf", "anyOf", "allOf"];

// git show streams a whole schema; the Claude one is already ~200 KB and grows every release, and
// Node's 1 MiB default would turn that growth into a silent scan failure.
const GIT_SHOW_MAX_BUFFER = 64 * 1024 * 1024;

function definitionFor(schema, ref) {
  for (const prefix of REF_PREFIXES) {
    if (!ref.startsWith(prefix)) continue;
    const name = ref.slice(prefix.length);
    return schema?.definitions?.[name] ?? schema?.$defs?.[name];
  }
  return undefined;
}

// Hops count $ref indirections only. Counting composition depth too made a single `allOf` + `$ref`
// wrapper cost two of the budget, so a schema nested a few layers deeper resolved to nothing.
function walk(schema, node, visit, hops = 0, seen = new Set()) {
  if (!node || typeof node !== "object" || hops > MAX_REF_HOPS) return;
  visit(node);
  for (const key of COMPOSITION_KEYS) {
    for (const child of Array.isArray(node[key]) ? node[key] : []) {
      walk(schema, child, visit, hops, seen);
    }
  }
  const ref = node.$ref;
  if (typeof ref !== "string" || seen.has(ref)) return;
  seen.add(ref);
  walk(schema, definitionFor(schema, ref), visit, hops + 1, seen);
}

export function resolveEnumMembers(schema, key) {
  const members = new Set();
  walk(schema, schema?.properties?.[key], (node) => {
    for (const value of Array.isArray(node.enum) ? node.enum : []) members.add(value);
  });
  return [...members].sort();
}

export function hookEventNames(schema) {
  const events = new Set();
  walk(schema, schema?.properties?.hooks, (node) => {
    if (!node.properties || typeof node.properties !== "object") return;
    for (const name of Object.keys(node.properties)) events.add(name);
  });
  return [...events].sort();
}

function memberDiff(current, previous) {
  return {
    added: current.filter((member) => !previous.includes(member)),
    removed: previous.filter((member) => !current.includes(member)),
  };
}

// `previous` is optional on purpose: the stale-hardcoded check reads only the current schema, and
// tying it to a readable HEAD copy would silence it exactly when a snapshot is newly added.
export function findCodexEnumDrift(current, previous, watch = CODEX_WATCH) {
  const findings = [];
  const readable = Object.keys(current?.properties ?? {}).length > 0;
  for (const [key, hardcoded] of Object.entries(watch)) {
    if (readable && !current.properties[key]) {
      findings.push({ key, missingKey: true });
      continue;
    }
    const members = resolveEnumMembers(current, key);
    if (previous) {
      const { added, removed } = memberDiff(members, resolveEnumMembers(previous, key));
      if (added.length > 0 || removed.length > 0) findings.push({ key, added, removed });
    }
    if (members.length > 0 && !members.includes(hardcoded))
      findings.push({ key, stale: hardcoded });
  }
  return findings;
}

export function findClaudeHookDrift(current, previous, hardcoded = CLAUDE_HOOK_EVENTS) {
  const findings = [];
  const events = hookEventNames(current);
  if (previous) {
    const { added, removed } = memberDiff(events, hookEventNames(previous));
    if (added.length > 0 || removed.length > 0) findings.push({ key: "hooks", added, removed });
  }
  if (events.length === 0) return findings;
  for (const event of hardcoded) {
    if (!events.includes(event)) findings.push({ key: "hooks", stale: event });
  }
  return findings;
}

function renderFinding(finding, staleLabel) {
  if (finding.unreadable) {
    return `- **SCAN SKIPPED** \`${finding.unreadable}\` could not be read, so nothing was checked`;
  }
  if (finding.missingKey) {
    return `- **KEY GONE** \`${finding.key}\` is no longer in the schema at all`;
  }
  if (finding.stale) return `- **STALE HARDCODED** ${staleLabel(finding)}`;
  const lines = [`- \`${finding.key}\` enum changed`];
  if (finding.added.length > 0) lines.push(`  - added: ${finding.added.join(" ")}`);
  if (finding.removed.length > 0) lines.push(`  - removed: ${finding.removed.join(" ")}`);
  return lines.join("\n");
}

export function renderSection(claudeFindings, codexFindings) {
  if (claudeFindings.length === 0 && codexFindings.length === 0) return "";
  const lines = [
    "",
    "## Compat scan — enum drift on watched keys",
    "",
    "Enum members on keys the runtime hardcodes. STALE HARDCODED means `bin/ai-config-sync.mjs` will emit a value the new schema rejects — runtime fix required, not just a checklist.",
  ];
  const hosts = [
    [
      "Claude",
      claudeFindings,
      (f) =>
        `hook event \`${f.stale}\` no longer in \`hooks.properties\` (runtime writes a hook the host will not fire)`,
    ],
    [
      "Codex",
      codexFindings,
      (f) =>
        `\`${f.key} = "${f.stale}"\` no longer in schema enum (runtime will write an invalid value)`,
    ],
  ];
  for (const [title, findings, staleLabel] of hosts) {
    if (findings.length === 0) continue;
    lines.push("", `### ${title}`);
    for (const finding of findings) lines.push(renderFinding(finding, staleLabel));
  }
  lines.push("");
  return lines.join("\n");
}

function readSchema(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // An empty object would read as "every watched key was removed upstream" and invent a KEY GONE
    // report out of a local read failure.
    process.stderr.write(`detect-enum-drift: cannot read ${path}: ${err.message}\n`);
    return null;
  }
}

function readSchemaAtHead(path) {
  try {
    return JSON.parse(
      execFileSync("git", ["show", `HEAD:${path}`], {
        encoding: "utf8",
        maxBuffer: GIT_SHOW_MAX_BUFFER,
      })
    );
  } catch (err) {
    process.stderr.write(`detect-enum-drift: cannot read HEAD:${path}: ${err.message}\n`);
    return null;
  }
}

// An unreadable current schema is reported rather than skipped — the section being absent is how a
// reviewer concludes the scan ran and found nothing.
function scan(path, find) {
  const current = readSchema(path);
  if (!current) return [{ unreadable: path }];
  return find(current, readSchemaAtHead(path));
}

function main() {
  const section = renderSection(
    scan(CLAUDE_SCHEMA, findClaudeHookDrift),
    scan(CODEX_SCHEMA, findCodexEnumDrift)
  );
  if (section) process.stdout.write(section);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
