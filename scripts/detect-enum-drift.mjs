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

const REF_PREFIX = "#/definitions/";
const MAX_REF_DEPTH = 8;

// Watched keys are $ref indirections — `{"allOf":[{"$ref":"#/definitions/SandboxMode"}]}` — so
// reading `.enum` off the property yields nothing and every comparison silently passes. The members
// live on the definition, and some definitions spell them as oneOf branches of one enum each.
export function resolveEnumMembers(schema, key) {
  const root = schema?.properties?.[key];
  if (!root) return [];
  const members = new Set();
  const visit = (node, depth) => {
    if (!node || typeof node !== "object" || depth > MAX_REF_DEPTH) return;
    for (const value of Array.isArray(node.enum) ? node.enum : []) members.add(value);
    for (const branch of ["oneOf", "anyOf", "allOf"]) {
      for (const child of Array.isArray(node[branch]) ? node[branch] : []) visit(child, depth + 1);
    }
    const ref = node.$ref;
    if (typeof ref === "string" && ref.startsWith(REF_PREFIX)) {
      visit(schema?.definitions?.[ref.slice(REF_PREFIX.length)], depth + 1);
    }
  };
  visit(root, 0);
  return [...members].sort();
}

export function hookEventNames(schema) {
  const events = schema?.properties?.hooks?.properties;
  return events && typeof events === "object" ? Object.keys(events).sort() : [];
}

function memberDiff(current, previous) {
  return {
    added: current.filter((member) => !previous.includes(member)),
    removed: previous.filter((member) => !current.includes(member)),
  };
}

export function findCodexEnumDrift(current, previous, watch = CODEX_WATCH) {
  const findings = [];
  for (const [key, hardcoded] of Object.entries(watch)) {
    if (!current?.properties?.[key]) {
      findings.push({ key, missingKey: true });
      continue;
    }
    const members = resolveEnumMembers(current, key);
    const { added, removed } = memberDiff(members, resolveEnumMembers(previous, key));
    if (added.length > 0 || removed.length > 0) findings.push({ key, added, removed });
    if (members.length > 0 && !members.includes(hardcoded))
      findings.push({ key, stale: hardcoded });
  }
  return findings;
}

export function findClaudeHookDrift(current, previous, hardcoded = CLAUDE_HOOK_EVENTS) {
  const findings = [];
  const events = hookEventNames(current);
  const { added, removed } = memberDiff(events, hookEventNames(previous));
  if (added.length > 0 || removed.length > 0) findings.push({ key: "hooks", added, removed });
  if (events.length === 0) return findings;
  for (const event of hardcoded) {
    if (!events.includes(event)) findings.push({ key: "hooks", stale: event });
  }
  return findings;
}

function renderFinding(finding, staleLabel) {
  if (finding.missingKey) {
    return `- **KEY GONE** \`${finding.key}\` is no longer in the schema at all`;
  }
  if (finding.stale) return staleLabel(finding);
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
  if (claudeFindings.length > 0) {
    lines.push("", "### Claude");
    for (const finding of claudeFindings) {
      lines.push(
        renderFinding(
          finding,
          (f) =>
            `- **STALE HARDCODED** hook event \`${f.stale}\` no longer in \`hooks.properties\` (runtime writes a hook the host will not fire)`
        )
      );
    }
  }
  if (codexFindings.length > 0) {
    lines.push("", "### Codex");
    for (const finding of codexFindings) {
      lines.push(
        renderFinding(
          finding,
          (f) =>
            `- **STALE HARDCODED** \`${f.key} = "${f.stale}"\` no longer in schema enum (runtime will write an invalid value)`
        )
      );
    }
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
    return JSON.parse(execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8" }));
  } catch (err) {
    // A silent {} reads as "everything is new" and would report the whole enum as added.
    process.stderr.write(`detect-enum-drift: cannot read HEAD:${path}: ${err.message}\n`);
    return null;
  }
}

function main() {
  const claude = [readSchema(CLAUDE_SCHEMA), readSchemaAtHead(CLAUDE_SCHEMA)];
  const codex = [readSchema(CODEX_SCHEMA), readSchemaAtHead(CODEX_SCHEMA)];
  const section = renderSection(
    claude.every(Boolean) ? findClaudeHookDrift(...claude) : [],
    codex.every(Boolean) ? findCodexEnumDrift(...codex) : []
  );
  if (section) process.stdout.write(section);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
