#!/usr/bin/env node

import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { serializeYamlScalar } from "./util/yaml-scalar.mjs";
import { hashPath } from "./util/ledger-hash.mjs";

const hosts = new Set(["claude", "codex"]);
const [command = "help", ...argv] = process.argv.slice(2);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.AI_CONFIG_SYNC_HOME ?? homedir();
const STATE_SCHEMA_VERSION = 1;
const BACKUP_RETENTION = 30;
const LEDGER_RETENTION = 300;
const STATUS_DETAILS_RETENTION = 100;
const CODEX_PLUGIN_NAME = "ai-config-sync-manager";
const CODEX_MARKETPLACE_NAME = "local-plugins";
const runtimePackage = readRuntimePackage();

/**
 * Domain typedef block — applied incrementally to parser / plan / apply
 * boundary functions. See workflow.md §8.4 for the rollout policy.
 *
 * @typedef {"claude" | "codex"} Host
 * @typedef {"global" | "project"} ConfigScope
 * @typedef {"dry-run" | "apply"} SyncMode
 * @typedef {"safe" | "partial" | "manual"} RiskLevel
 * @typedef {"instructions" | "skills" | "agents" | "mcp" | "permissions" | "hooks" | "commands" | "plugins"} ConfigArea
 *
 * @typedef {Object} Selectors
 * @property {Array<{ area: ConfigArea, item?: string }>} include
 * @property {Array<{ area: ConfigArea, item?: string }>} exclude
 *
 * @typedef {Object} SyncOptions
 * @property {Host} from
 * @property {Host} to
 * @property {boolean} routeExplicit
 * @property {boolean} apply
 * @property {boolean} planJson
 * @property {ConfigScope} scope - First scope in `scopes` (back-compat)
 * @property {ConfigScope[]} scopes
 * @property {Selectors} selectors
 */
const runtimeVersion = runtimePackage.version;
const runtimePackageName = runtimePackage.name;

if (command === "--version" || command === "-v") {
  console.log(runtimeVersion);
  process.exit(0);
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : "Unknown CLI error");
}

async function main() {
  if (command === "connect") {
    if (isHelp(argv)) {
      printConnectHelp();
    } else {
      noOptions(argv, "connect");
      await runConnect();
    }
  } else if (command === "status") {
    if (isHelp(argv)) {
      printStatusHelp();
    } else {
      const { format, json, scopes, selectors } = parseStatus(argv);
      const report = createStatusReport(scopes, selectors);
      console.log(json ? JSON.stringify(report, null, 2) : renderStatus(report, format));
    }
  } else if (command === "sync") {
    if (isHelp(argv)) {
      printSyncHelp();
    } else {
      const options = parseSync(argv);
      const mode = options.apply ? "apply" : "dry-run";
      const plans = createSyncPlans(options, mode);
      if (mode === "apply") {
        for (const plan of plans) applySyncPlan(plan);
        emitLedger(plans, options);
      }
      console.log(
        options.planJson ? JSON.stringify(formatPlanOutput(plans), null, 2) : renderSyncPlans(plans)
      );
    }
  } else if (command === "reference") {
    if (isHelp(argv)) {
      printReferenceHelp();
    } else {
      const { output } = parseReference(argv);
      const markdown = generateReferenceMarkdown();
      if (output) {
        const resolved = resolve(expandHome(output));
        mkdirSync(dirname(resolved), { recursive: true });
        writeFileSync(resolved, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
        console.log(`Reference written to ${resolved}`);
      } else {
        console.log(markdown);
      }
    }
  } else if (command === "paraphrase") {
    if (isHelp(argv)) {
      printParaphraseHelp();
    } else {
      const options = parseParaphrase(argv);
      const result = options.register
        ? await runParaphraseRegister(options)
        : await runParaphrase(options);
      const text = options.register
        ? renderParaphraseRegister(result, options)
        : renderParaphrase(result, options);
      console.log(options.json ? JSON.stringify(result, null, 2) : text);
    }
  } else {
    printHelp();
  }
}

function createSyncPlans(options, mode) {
  return options.scopes.map((scope) => createSyncPlan({ ...options, scope }, mode));
}

function formatPlanOutput(plans) {
  return plans.length === 1
    ? plans[0]
    : {
        mode: plans[0]?.mode ?? "dry-run",
        scopes: plans.map((plan) => plan.scope),
        plans,
      };
}

function parseStatus(argv) {
  let format = "default";
  let json = false;
  let scopes = ["global", "project"];
  const selectors = emptySelectors();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      json = true;
    } else if (token === "--compact") {
      format = "compact";
    } else if (token === "--tree") {
      format = "tree";
    } else if (token === "--scope") {
      const value = argv[index + 1];
      scopes = parseScopes(value, true);
      index += 1;
    } else if (token === "--include" || token === "--exclude") {
      addSelectors(selectors, token, argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown option for status: ${token}`);
    }
  }

  return { format, json, scopes, selectors };
}

function defaultSyncDirection() {
  const sessionHost = process.env.AI_CONFIG_SYNC_HOST === "codex" ? "codex" : "claude";
  return sessionHost === "codex"
    ? { from: "codex", to: "claude" }
    : { from: "claude", to: "codex" };
}

function createStatusReport(scopes, selectors = emptySelectors()) {
  const direction = defaultSyncDirection();
  const ignoreSource = ignoreListSource();
  const ignoreRules = (ignoreSource.data?.exclude ?? []).filter(Boolean);
  const filtered = filterIgnoredEntries(
    filterEntries(
      scopes.flatMap((scope) => diffScope(scope, ignoreRules)),
      selectors
    )
  );
  const entries = filtered.entries;
  const vocabFindings = filterVocabFindings(
    scopes.flatMap((scope) => lintScopeForVocab(scope)),
    selectors,
    filtered.rules ?? []
  );
  const paraphraseOverrides = activeParaphraseOverrides();

  return {
    source: direction.from,
    target: direction.to,
    direction,
    scopes,
    include: renderSelectors(selectors.include),
    exclude: renderSelectors(selectors.exclude),
    statusIgnorePath: filtered.path,
    statusIgnoreRules: filtered.rules ?? [],
    statusIgnored: filtered.ignored,
    scaffold: false,
    entries,
    vocabFindings,
    paraphraseOverrides,
    summary: buildStatusSummary(
      entries.length,
      vocabFindings.length,
      scopes,
      paraphraseOverrides.active.length,
      paraphraseOverrides.stale.length,
      vocabFindings.filter((f) => !f.recommended).length
    ),
  };
}

function buildStatusSummary(
  diffCount,
  vocabCount,
  scopes,
  overrideActiveCount = 0,
  overrideStaleCount = 0,
  vocabManualCount = 0
) {
  const scopeLabel = scopes.join("+");
  const parts = [];
  parts.push(
    diffCount === 0
      ? `No diff detected for ${scopeLabel} scope.`
      : `${diffCount} diff(s) detected for ${scopeLabel} scope.`
  );
  if (vocabCount > 0) {
    const autoCount = vocabCount - vocabManualCount;
    const segments = [];
    if (autoCount > 0) segments.push(`${autoCount} auto-fix on \`sync --apply\``);
    if (vocabManualCount > 0) {
      segments.push(
        `${vocabManualCount} manual — run \`ai-config-sync paraphrase\` (not \`sync\`) to mask host-only tokens`
      );
    }
    parts.push(`${vocabCount} vocab mismatch(es) detected (${segments.join("; ")}).`);
  }
  if (overrideActiveCount > 0 || overrideStaleCount > 0) {
    parts.push(
      `${overrideActiveCount} paraphrase override(s) active, ${overrideStaleCount} stale.`
    );
  }
  return parts.join(" ");
}

function renderStatus(report, format = "default") {
  if (format === "compact") return renderCompactStatus(report);
  if (format === "tree") return renderTreeStatus(report);
  const detailPath = writeStatusDetailFile(report);

  const lines = [
    "AI Config Sync Manager status",
    `Default sync direction: ${report.direction.from} -> ${report.direction.to} (override with --from/--to or AI_CONFIG_SYNC_HOST)`,
    `Scopes: ${report.scopes.join(", ")}`,
    `Include: ${report.include.length ? report.include.join(", ") : "all"}`,
    `Exclude: ${report.exclude.length ? report.exclude.join(", ") : "none"}`,
    formatStatusIgnoreLine(report.statusIgnorePath, report.statusIgnoreRules, report.statusIgnored),
    report.summary,
  ];

  if (report.entries.length > 0) {
    lines.push("");
    lines.push(renderStatusResult(report.entries, report.statusIgnoreRules ?? []));
    lines.push("");
    lines.push("Diff status:");
    lines.push(renderDiffStatus(report.entries, report.statusIgnoreRules ?? []));
    lines.push("");
  }

  if (Array.isArray(report.vocabFindings) && report.vocabFindings.length > 0) {
    lines.push("");
    lines.push(...renderVocabFindings(report.vocabFindings));
    lines.push("");
  }

  if (detailPath) {
    lines.push(`Detail file: ${detailPath}`);
    lines.push("Open the detail file for the full item list and before/after diff preview.");
    lines.push("");
  }

  if (report.entries.length > 0) {
    lines.push("Run a listed command with --dry-run first when risk is manual.");
  }

  return lines.join("\n");
}

function renderVocabFindings(findings) {
  const auto = findings.filter((f) => f.recommended);
  const manual = findings.filter((f) => !f.recommended);
  const sortFn = (a, b) =>
    a.host.localeCompare(b.host) ||
    a.area.localeCompare(b.area) ||
    a.path.localeCompare(b.path) ||
    a.line - b.line;

  const lines = [
    `Vocab mismatches (${findings.length} total: ${auto.length} auto-fix, ${manual.length} manual):`,
  ];

  if (auto.length > 0) {
    lines.push("");
    lines.push("Auto-fix (sync --apply rewrites source files using these replacements):");
    for (const f of [...auto].sort(sortFn)) {
      const hostLabel = f.host === "claude" ? "Claude" : "Codex";
      lines.push(`  ${hostLabel} ${f.area}/${f.item} L${f.line} @ ${f.path}`);
      lines.push(`    - ${f.token}`);
      lines.push(`    + ${f.recommended}`);
    }
  }

  if (manual.length > 0) {
    lines.push("");
    lines.push(
      "Manual review — run `ai-config-sync paraphrase` to rewrite both sides and register an override:"
    );
    for (const f of [...manual].sort(sortFn)) {
      const hostLabel = f.host === "claude" ? "Claude" : "Codex";
      const sideLabel = f.side.replace("_only", "-only");
      lines.push(
        `  ${hostLabel} ${f.area}/${f.item} L${f.line}: ${f.token} [${sideLabel}; not callable on ${f.host}] @ ${f.path}`
      );
    }
  }

  return lines;
}

function renderStatusResult(entries, ignoreRules = []) {
  const rows = statusTableRows(entries, ignoreRules);
  const safeCount = rows.filter((row) => row.risk === "safe").length;
  const manualCount = rows.filter((row) => row.risk !== "safe").length;

  return [
    "Result:",
    `  - ${safeCount} safe item(s)`,
    `  - ${manualCount} manual-risk item(s)`,
  ].join("\n");
}

function renderDiffStatus(entries, ignoreRules = []) {
  const rows = statusTableRows(entries, ignoreRules);
  const groups = [
    ["claude", rows.filter((row) => row.target === "claude")],
    ["codex", rows.filter((row) => row.target === "codex")],
    ["review", rows.filter((row) => row.target === "review")],
  ].filter(([, groupRows]) => groupRows.length > 0);

  return groups
    .map(([target, groupRows]) => [`  ${target}:`, ...renderDiffStatusRows(groupRows)].join("\n"))
    .join("\n");
}

function renderDiffStatusRows(rows) {
  return groupRowsForDisplay(rows).flatMap((group) => {
    if (group.rows.length < 10) return group.rows.map(renderDiffStatusRow);
    return [renderDiffStatusSummaryRow(group)];
  });
}

function groupRowsForDisplay(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.scope}/${row.area}`;
    const group = groups.get(key) ?? { scope: row.scope, area: row.area, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function renderDiffStatusSummaryRow(group) {
  const counts = countRowSymbols(group.rows);
  const risk = group.rows.some((row) => row.risk !== "safe") ? "manual-risk" : "safe";
  return [
    `    - ${group.scope}/${group.area}: ${formatSymbolCounts(counts)} (${group.rows.length} diff(s), ${risk})`,
    "      details: hidden because this area has 10+ item diffs; see detail file for all items and before/after previews",
    `      apply: ai-config-sync sync --scope ${group.scope} --include ${group.area} --apply`,
  ].join("\n");
}

function countRowSymbols(rows) {
  return rows.reduce((counts, row) => {
    counts[row.symbol] = (counts[row.symbol] ?? 0) + 1;
    return counts;
  }, {});
}

function formatSymbolCounts(counts) {
  return ["+", "-", "~", "!"]
    .filter((symbol) => counts[symbol])
    .map((symbol) => `${symbol}${counts[symbol]}`)
    .join(", ");
}

function formatIgnoreRule(rule) {
  if (typeof rule === "string") return rule;
  if (rule && typeof rule === "object") return JSON.stringify(rule);
  return String(rule);
}

function formatIgnoreRulesSegment(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return "";
  return ` rules: [${rules.map(formatIgnoreRule).join(", ")}]`;
}

function formatStatusIgnoreLine(path, rules, ignored) {
  return `Status ignore: ${path}${formatIgnoreRulesSegment(rules)} (${ignored} hidden)`;
}

function formatPlanIgnoreLine(path, rules, ignored) {
  return `Ignore: ${path}${formatIgnoreRulesSegment(rules)} (${ignored} hidden)`;
}

function formatCompactIgnoreSegment(rules, ignored) {
  const parts = [];
  if (Array.isArray(rules) && rules.length > 0) {
    parts.push(`ignore_rules=${rules.map(formatIgnoreRule).join(",")}`);
  }
  if (typeof ignored === "number" && ignored > 0) {
    parts.push(`hidden=${ignored}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function renderDiffStatusRow(row) {
  const lines = [
    `    - ${row.scope}/${row.area}: ${row.symbol}${row.item} (${row.change}, ${row.risk})`,
    `      details: ${row.details}`,
    `      action: ${row.action}`,
    `      apply: ${row.command}`,
  ];

  if (row.preview?.length) {
    lines.push("      diff:");
    for (const line of row.preview) lines.push(`        ${line}`);
  }

  return lines.join("\n");
}

function writeStatusDetailFile(report) {
  const detailPath = statusDetailPath();
  const rows = statusTableRows(report.entries, report.statusIgnoreRules ?? []);
  const lines = [
    "AI Config Sync Manager status detail",
    `Default sync direction: ${report.direction.from} -> ${report.direction.to}`,
    `Scopes: ${report.scopes.join(", ")}`,
    `Include: ${report.include.length ? report.include.join(", ") : "all"}`,
    `Exclude: ${report.exclude.length ? report.exclude.join(", ") : "none"}`,
    report.summary,
    "",
  ];

  for (const [target, targetRows] of [
    ["claude", rows.filter((row) => row.target === "claude")],
    ["codex", rows.filter((row) => row.target === "codex")],
    ["review", rows.filter((row) => row.target === "review")],
  ]) {
    if (targetRows.length === 0) continue;
    lines.push(`${target}:`);
    for (const row of targetRows) {
      lines.push(renderDiffStatusRow(row).replace(/^ {4}/gm, "  "));
    }
    lines.push("");
  }

  if (Array.isArray(report.vocabFindings) && report.vocabFindings.length > 0) {
    lines.push("vocab:");
    for (const line of renderVocabFindings(report.vocabFindings)) lines.push(`  ${line}`);
    lines.push("");
  }

  const staleOverrides = report.paraphraseOverrides?.stale ?? [];
  if (staleOverrides.length > 0) {
    lines.push("stale paraphrase overrides:");
    for (const entry of staleOverrides) {
      lines.push(`  - ${entry.id} [${entry._staleReason}]`);
      lines.push(
        `      scope: ${entry.scope ?? "?"}, area: ${entry.area ?? "?"}, item: ${entry.item ?? "?"}`
      );
      lines.push(`      claude: ${entry.claude_path} L${entry.claude_line}`);
      lines.push(`        - before: ${entry.claude_text}`);
      lines.push(`      codex:  ${entry.codex_path} L${entry.codex_line}`);
      lines.push(`        - before: ${entry.codex_text}`);
    }
    lines.push("");
  }

  mkdirSync(dirname(detailPath), { recursive: true });
  pruneRetention(dirname(detailPath), STATUS_DETAILS_RETENTION - 1);
  writeFileSync(detailPath, `${lines.join("\n").trimEnd()}\n`);
  return detailPath;
}

function statusDetailPath() {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  return `${home}/.ai-config-sync-manager/status-details/${stamp}.txt`;
}

function pruneRetention(dir, keep) {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir).sort();
  if (entries.length <= keep) return;
  for (const name of entries.slice(0, entries.length - keep)) {
    rmSync(join(dir, name), { recursive: true, force: true });
  }
}

function statusTableRows(entries, ignoreRules = []) {
  return entries.flatMap((entry) => {
    const rows = [];

    for (const item of entry.unsupported ?? []) {
      rows.push(statusTableRow(entry, "unsupported", item, "manual review", ignoreRules));
    }

    for (const item of entry.missingInCodex ?? []) {
      rows.push(
        statusTableRow(entry, "missing in Codex", item, statusAction(entry, "codex"), ignoreRules)
      );
    }

    for (const item of entry.missingInClaude ?? []) {
      rows.push(
        statusTableRow(entry, "missing in Claude", item, statusAction(entry, "claude"), ignoreRules)
      );
    }

    for (const item of entry.conflicts ?? []) {
      rows.push(statusTableRow(entry, "conflict", item, "sync area", ignoreRules));
    }

    if (rows.length === 0) {
      rows.push(statusTableRow(entry, "content differs", entry.area, "sync area", ignoreRules));
    }

    return rows;
  });
}

function statusTableRow(entry, change, item, action, ignoreRules = []) {
  const selector = statusSelector(entry.area, item);
  const command =
    action === "manual review"
      ? "manual review"
      : `ai-config-sync sync --scope ${entry.scope} --include ${shellQuote(selector)} --apply`;

  return {
    scope: entry.scope,
    area: entry.area,
    risk: entry.risk,
    change,
    item: statusDisplayItem(entry, item),
    action,
    command,
    details: statusDetails(entry, change),
    preview: statusPreview(entry, change, item, ignoreRules),
    target: statusTarget(change, action),
    symbol: statusSymbol(change, action),
  };
}

function statusDisplayItem(entry, item) {
  const quality =
    entry.itemQualities?.[item] ??
    entry.itemQualities?.[item.replace(/^(allow|ask|deny):/, "")] ??
    entry.mappingQuality;
  return quality ? `${item} [${quality}]` : item;
}

function statusTarget(change, action) {
  if (action === "copy Claude -> Codex" || action === "delete from Codex") return "codex";
  if (action === "copy Codex -> Claude" || action === "delete from Claude") return "claude";
  if (change === "missing in Codex") return "codex";
  if (change === "missing in Claude") return "claude";
  return "review";
}

function statusSymbol(change, action) {
  if (action.startsWith("copy ")) return "+";
  if (action.startsWith("delete ")) return "-";
  if (change === "conflict" || change === "unsupported") return "!";
  return "~";
}

function statusDetails(entry, change) {
  const { from, to } = defaultSyncDirection();
  const fromLabel = from === "claude" ? "Claude" : "Codex";
  const toLabel = to === "claude" ? "Claude" : "Codex";
  if (change === "unsupported" && entry.area === "plugins") {
    return [
      `Plugin sync is unsupported.`,
      `Install Claude plugins: '/plugin install <name>@<source>' inside Claude Code.`,
      `Register Codex plugins: edit ${statusPathSummary(entry, "codex")} (~/.agents/plugins/marketplace.json) or use the Codex CLI.`,
      `Claude manifest: ${statusPathSummary(entry, "claude")}; Codex manifest: ${statusPathSummary(entry, "codex")}`,
    ].join(" ");
  }
  if (change === "unsupported")
    return `Skill symlink is unsupported and excluded from sync. Claude: ${statusPathSummary(entry, "claude")}; Codex: ${statusPathSummary(entry, "codex")}`;
  if (change === "missing in Codex")
    return `Claude has it; Codex missing. Claude: ${statusPathSummary(entry, "claude")} -> Codex: ${statusPathSummary(entry, "codex")}`;
  if (change === "missing in Claude")
    return `Codex has it; Claude missing. Codex: ${statusPathSummary(entry, "codex")} -> Claude: ${statusPathSummary(entry, "claude")}`;
  if (change === "conflict")
    return `Both hosts have this item with different content. Default sync updates ${toLabel} from ${fromLabel}. Claude: ${statusPathSummary(entry, "claude")}; Codex: ${statusPathSummary(entry, "codex")}`;
  return `Default sync updates ${toLabel} from ${fromLabel}. Claude: ${statusPathSummary(entry, "claude")} (${entry.claude}); Codex: ${statusPathSummary(entry, "codex")} (${entry.codex})`;
}

function statusPreview(entry, change, item, ignoreRules = []) {
  const { from, to } = defaultSyncDirection();
  const fromLabel = from === "claude" ? "Claude" : "Codex";
  const toLabel = to === "claude" ? "Claude" : "Codex";
  const terms = entryMaskTerms(entry, item, ignoreRules);

  if (change === "content differs" && entry.area === "instructions") {
    const targetContent =
      to === "claude" ? entry.claudeInstructionContent : entry.codexInstructionContent;
    const sourceContent =
      from === "claude" ? entry.claudeInstructionContent : entry.codexInstructionContent;
    const transformedSource = transformTextForHost(sourceContent ?? "", from, to);
    const overrides = activeOverridesForFilePair(entry.claudePath, entry.codexPath);
    const masked = maskBodiesForHosts(targetContent ?? "", transformedSource, to, from, overrides);
    return contentChangePreview(
      `${toLabel} current`,
      masked.target,
      `After apply from ${fromLabel}`,
      masked.source,
      terms
    );
  }

  if (change === "conflict" && entry.area === "skills") {
    const claudeSkillDir = join(entry.claudePath, item);
    const codexSkillDir = join(entry.codexPath, item);
    return skillDirChangePreview(
      claudeSkillDir,
      codexSkillDir,
      from,
      to,
      fromLabel,
      toLabel,
      terms
    );
  }

  if (change === "conflict" && entry.area === "agents") {
    const targetPath =
      to === "claude" ? entry.claudeAgentPaths?.[item] : entry.codexAgentPaths?.[item];
    const sourcePath =
      from === "claude" ? entry.claudeAgentPaths?.[item] : entry.codexAgentPaths?.[item];
    const targetContent = agentPreviewContentFromPath(targetPath, to);
    const rawSource = agentPreviewContentFromPath(sourcePath, from);
    const sourceContent =
      from === "claude"
        ? transformTextForHost(rawSource, "claude", "codex")
        : transformTextForHost(stripAgentMigrationPreamble(rawSource), "codex", "claude");
    const overrides = activeManifestOverridesForPair(targetPath, sourcePath, to);
    const masked = maskBodiesForHosts(targetContent, sourceContent, to, from, overrides);
    return contentChangePreview(
      `${toLabel} current`,
      masked.target,
      `After apply from ${fromLabel}`,
      masked.source,
      terms
    );
  }

  if (change === "conflict" && entry.area === "mcp") {
    const claudeServers = readClaudeMcpServerDetails(entry.claudeMcpPaths ?? entry.claudePath);
    const codexServers = readCodexMcpServerDetails(entry.codexMcpPaths ?? entry.codexPath);
    const targetServer = to === "claude" ? claudeServers[item] : codexServers[item];
    const sourceServer = from === "claude" ? claudeServers[item] : codexServers[item];
    const targetContent = renderCodexMcpServers({ [item]: targetServer ?? {} });
    const sourceContent = renderCodexMcpServers({ [item]: sourceServer ?? {} });
    return contentChangePreview(
      `${toLabel} current`,
      targetContent,
      `After apply from ${fromLabel}`,
      sourceContent,
      terms
    );
  }

  return [];
}

function entryMaskTerms(entry, item, ignoreRules) {
  if (!Array.isArray(ignoreRules) || ignoreRules.length === 0) return [];
  return uniqueStrings([
    ...applicableTermRules(ignoreRules, entry, item, "claude"),
    ...applicableTermRules(ignoreRules, entry, item, "codex"),
  ]);
}

function statusPathSummary(entry, host) {
  if (host === "claude") {
    return (
      instructionPathSummary(entry.claudeInstructionPaths, entry.claudeInstructionCheckedPaths) ??
      firstClaudeMcpDisplayPath(entry.claudeMcpPaths) ??
      entry.claudePath
    );
  }

  const base =
    instructionPathSummary(entry.codexInstructionPaths, entry.codexInstructionCheckedPaths) ??
    firstStatusPath(entry.codexMcpPaths) ??
    entry.codexPath;

  if (entry.area === "permissions" && entry.codexPath && permissionItemsTouchRules(entry)) {
    return `${base} + ${codexRulesPath(entry.codexPath)}`;
  }

  return base;
}

function permissionItemsTouchRules(entry) {
  const buckets = [entry.missingInCodex, entry.missingInClaude, entry.conflicts];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const itemName of bucket) {
      if (typeof itemName !== "string") continue;
      const { bucket: permBucket, value } = parsePermissionItem(itemName);
      if (codexPrefixRuleForPermission(permBucket, value)) return true;
    }
  }
  return false;
}

function instructionPathSummary(sourcePaths, checkedPaths) {
  if (!Array.isArray(checkedPaths) || checkedPaths.length === 0)
    return firstStatusPath(sourcePaths);
  const sources =
    Array.isArray(sourcePaths) && sourcePaths.length > 0 ? sourcePaths.join(", ") : "none";
  return `sources: ${sources}; checked: ${checkedPaths.join(", ")}`;
}

function firstStatusPath(paths) {
  return Array.isArray(paths) && paths.length > 0 ? paths[0] : null;
}

function statusAction(entry, missingTarget) {
  const { from, to } = defaultSyncDirection();
  if (missingTarget === to) {
    return `copy ${toLabel(from)} -> ${toLabel(to)}`;
  }
  return `delete from ${toLabel(to)}`;
}

function statusSelector(area, item) {
  if (!item || item === area) return area;
  return `${area}:${item}`;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function renderCompactStatus(report) {
  const lines = [
    `status: ${report.summary}`,
    `direction=${report.direction.from}->${report.direction.to} scopes=${report.scopes.join(",")} include=${report.include.length ? report.include.join(",") : "all"} exclude=${report.exclude.length ? report.exclude.join(",") : "none"}${formatCompactIgnoreSegment(report.statusIgnoreRules, report.statusIgnored)}`,
  ];

  for (const entry of report.entries) {
    lines.push(`${entry.scope}/${entry.area} [${entry.risk}] ${statusItems(entry).join("; ")}`);
  }

  return lines.join("\n");
}

function renderTreeStatus(report) {
  const lines = [
    "AI Config Sync Manager status",
    `Default sync direction: ${report.direction.from} -> ${report.direction.to}`,
  ];

  const hasIgnoreRules =
    Array.isArray(report.statusIgnoreRules) && report.statusIgnoreRules.length > 0;
  const hasHidden = typeof report.statusIgnored === "number" && report.statusIgnored > 0;
  if (report.statusIgnorePath && (hasIgnoreRules || hasHidden)) {
    lines.push(
      formatStatusIgnoreLine(
        report.statusIgnorePath,
        report.statusIgnoreRules,
        report.statusIgnored
      )
    );
  }

  lines.push(report.summary);

  for (const [scope, scopeEntries] of groupBy(report.entries, "scope")) {
    lines.push(`${scope}/`);

    for (const [area, areaEntries] of groupBy(scopeEntries, "area")) {
      lines.push(`  ${area}/`);

      for (const entry of areaEntries) {
        lines.push(`    [${entry.risk}] ${entry.summary}`);
        for (const item of statusItems(entry)) {
          lines.push(`      ${item}`);
        }
      }
    }
  }

  return lines.join("\n");
}

function statusItems(entry) {
  if (entry.missingInCodex || entry.missingInClaude || entry.conflicts) {
    return [
      ...(entry.missingInCodex ?? []).map(
        (name) =>
          `missing-in-codex: ${formatQualityItem(entry, name)} | details: ${statusDetails(entry, "missing in Codex")}`
      ),
      ...(entry.missingInClaude ?? []).map(
        (name) =>
          `missing-in-claude: ${formatQualityItem(entry, name)} | details: ${statusDetails(entry, "missing in Claude")}`
      ),
      ...(entry.conflicts ?? []).map(
        (name) =>
          `conflict: ${formatQualityItem(entry, name)} | details: ${statusDetails(entry, "conflict")}`
      ),
    ];
  }

  return [
    `${entry.area}: claude=${entry.claude}, codex=${entry.codex} [${entry.mappingQuality ?? "unsupported"}] | details: ${statusDetails(entry, "content differs")}`,
  ];
}

function formatQualityItem(entry, item) {
  const quality =
    entry.itemQualities?.[item] ?? entry.itemQualities?.[item.replace(/^(allow|ask|deny):/, "")];
  return quality ? `${item} [${quality}]` : item;
}

function groupBy(entries, key) {
  const groups = new Map();

  for (const entry of entries) {
    const value = entry[key];
    const group = groups.get(value) ?? [];
    group.push(entry);
    groups.set(value, group);
  }

  return groups;
}

function emptySelectors() {
  return { include: [], exclude: [] };
}

function addSelectors(selectors, token, value) {
  if (!value) throw new Error(`Missing value for ${token}`);
  const target = token === "--include" ? selectors.include : selectors.exclude;

  for (const raw of value.split(",")) {
    const selector = parseSelector(raw);
    if (selector) target.push(selector);
  }
}

function parseSelector(raw) {
  const value = raw.trim();
  if (!value) return null;

  const separator = value.indexOf(":");
  const area = separator === -1 ? value : value.slice(0, separator);
  const item = separator === -1 ? null : value.slice(separator + 1);

  if (!area || item === "") {
    throw new Error(`Invalid selector: ${raw}. Use area or area:item.`);
  }

  return {
    area,
    item,
  };
}

function renderSelectors(selectors) {
  return selectors.map((selector) =>
    selector.item ? `${selector.area}:${selector.item}` : selector.area
  );
}

function filterEntries(entries, selectors) {
  return entries
    .filter((entry) => isIncluded(entry, selectors.include))
    .map((entry) => filterEntryItems(entry, selectors))
    .filter((entry) => entry && !isExcluded(entry, selectors.exclude));
}

function filterIgnoredEntries(entries) {
  const source = ignoreListSource();
  const rules = Array.isArray(source.data.exclude) ? source.data.exclude : [];
  if (rules.length === 0) return { entries, ignored: 0, path: source.path, rules: [] };

  let ignored = 0;
  const filteredEntries = [];

  for (const entry of entries) {
    const filtered = filterIgnoredEntry(entry, rules);
    if (!filtered) {
      ignored += entryItems(entry).length;
    } else {
      ignored += entryItems(entry).length - entryItems(filtered).length;
      filteredEntries.push(filtered);
    }
  }

  return { entries: filteredEntries, ignored, path: source.path, rules };
}

function filterIgnoredEntry(entry, rules) {
  if (!entry.missingInCodex && !entry.missingInClaude && !entry.conflicts && !entry.unsupported) {
    return ignoreRulesMatchEntry(rules, entry, entry.area) ? null : entry;
  }

  const filtered = { ...entry };
  filtered.unsupported = (entry.unsupported ?? []).filter(
    (item) => !ignoreRulesMatchEntry(rules, entry, item)
  );
  filtered.missingInCodex = (entry.missingInCodex ?? []).filter(
    (item) => !ignoreRulesMatchEntry(rules, entry, item)
  );
  filtered.missingInClaude = (entry.missingInClaude ?? []).filter(
    (item) => !ignoreRulesMatchEntry(rules, entry, item)
  );
  filtered.conflicts = (entry.conflicts ?? []).filter(
    (item) => !ignoreRulesMatchEntry(rules, entry, item)
  );
  filtered.itemQualities = filterItemQualities(entry.itemQualities ?? {}, [
    ...filtered.unsupported,
    ...filtered.missingInCodex,
    ...filtered.missingInClaude,
    ...filtered.conflicts,
  ]);

  if (
    filtered.unsupported.length === 0 &&
    filtered.missingInCodex.length === 0 &&
    filtered.missingInClaude.length === 0 &&
    filtered.conflicts.length === 0
  )
    return null;
  return filtered;
}

function ignoreRulesMatchEntry(rules, entry, item) {
  return rules.some((rule) => ignoreRuleMatchesEntry(rule, entry, item));
}

function ignoreRuleMatchesEntry(rule, entry, item) {
  const normalized = normalizeIgnoreRule(rule);
  if (!normalized) return false;
  // term-bearing rules are line-level masks applied during compare, not entry-level ignores.
  if (normalized.term) return false;
  if (!ignoreRuleScopeMatchesEntry(normalized, entry, item)) return false;
  if (!normalized.path) return true;
  const paths = entryRulePaths(entry, item, normalized.host);
  return paths.some((path) => pathMatchesIgnoreRule(path, normalized.path));
}

function ignoreRuleScopeMatchesEntry(normalized, entry, item) {
  if (normalized.scope && normalized.scope !== entry.scope) return false;
  if (normalized.area && normalized.area !== entry.area) return false;
  if (normalized.item && !itemMatchesSelector(item, normalized.item)) return false;
  if (normalized.host && normalized.host !== "claude" && normalized.host !== "codex") return false;
  return true;
}

function applicableTermRules(rules, entry, item, host) {
  if (!Array.isArray(rules) || rules.length === 0) return [];
  const terms = [];
  for (const rule of rules) {
    const normalized = normalizeIgnoreRule(rule);
    if (!normalized || !normalized.term) continue;
    if (normalized.host && host && normalized.host !== host) continue;
    if (!ignoreRuleScopeMatchesEntry(normalized, entry, item)) continue;
    if (normalized.path) {
      const paths = entryRulePaths(entry, item, normalized.host || host);
      if (!paths.some((path) => pathMatchesIgnoreRule(path, normalized.path))) continue;
    }
    terms.push(normalized.term);
  }
  return uniqueStrings(terms);
}

function maskLinesContaining(content, terms) {
  if (!terms || terms.length === 0) return content;
  if (typeof content !== "string") return content;
  return content
    .split("\n")
    .filter((line) => !terms.some((term) => term && line.includes(term)))
    .join("\n");
}

function expandTermsBothDirections(terms) {
  if (!Array.isArray(terms) || terms.length === 0) return [];
  const set = new Set();
  for (const term of terms) {
    if (typeof term !== "string" || !term) continue;
    set.add(term);
    const forward = transformTextForHost(term, "claude", "codex");
    if (typeof forward === "string" && forward && forward !== term) set.add(forward);
    const reverse = transformTextForHost(term, "codex", "claude");
    if (typeof reverse === "string" && reverse && reverse !== term) set.add(reverse);
  }
  return Array.from(set);
}

function normalizeIgnoreRule(rule) {
  if (typeof rule === "string" && rule.trim()) return parseIgnoreStringRule(rule.trim());
  if (!rule || typeof rule !== "object") return null;
  return {
    scope: typeof rule.scope === "string" ? rule.scope : null,
    area: typeof rule.area === "string" ? rule.area : null,
    item: typeof rule.item === "string" ? rule.item : null,
    host: typeof rule.host === "string" ? rule.host : null,
    path: typeof rule.path === "string" ? rule.path : null,
    term: typeof rule.term === "string" ? rule.term : null,
  };
}

function parseIgnoreStringRule(value) {
  const selector = value.includes(":") && !value.includes("/") ? parseSelector(value) : null;
  return selector
    ? { scope: null, area: selector.area, item: selector.item, host: null, path: null, term: null }
    : { scope: null, area: null, item: null, host: null, path: value, term: null };
}

function entryRulePaths(entry, item, host) {
  const paths = [];
  const claudeMcpFiles = (entry.claudeMcpPaths ?? []).map(claudeMcpSourceFile);
  if (!host || host === "claude") {
    paths.push(
      entry.claudePath,
      ...(entry.claudeInstructionPaths ?? []),
      ...(entry.claudeInstructionCheckedPaths ?? []),
      ...claudeMcpFiles
    );
    if (entry.area === "skills" && item)
      paths.push(join(entry.claudePath, item), join(entry.claudePath, item, "SKILL.md"));
    if (entry.area === "agents" && item) paths.push(join(entry.claudePath, `${item}.md`));
  }
  if (!host || host === "codex") {
    paths.push(
      entry.codexPath,
      ...(entry.codexInstructionPaths ?? []),
      ...(entry.codexInstructionCheckedPaths ?? []),
      ...(entry.codexMcpPaths ?? [])
    );
    if (entry.area === "skills" && item)
      paths.push(join(entry.codexPath, item), join(entry.codexPath, item, "SKILL.md"));
    if (entry.area === "agents" && item) {
      const flat = item.includes("/") ? item.split("/").pop() : item;
      paths.push(join(entry.codexPath, `${flat}.toml`));
    }
  }
  return uniqueStrings(paths.filter(Boolean));
}

function pathMatchesIgnoreRule(path, pattern) {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedPattern = expandHome(pattern).replaceAll("\\", "/");
  if (normalizedPath === normalizedPattern || normalizedPath.endsWith(normalizedPattern))
    return true;
  if (!/[*?]/.test(normalizedPattern)) return false;
  return globToRegExp(normalizedPattern).test(normalizedPath);
}

function expandHome(value) {
  return value.startsWith("~/") ? `${home}/${value.slice(2)}` : value;
}

function globToRegExp(glob) {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        pattern += ".*";
        index += 1;
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += escapeRegExp(char);
    }
  }
  return new RegExp(`^${pattern}$`);
}

function ignoreListSource() {
  for (const path of ignoreListCandidates()) {
    if (existsSync(path)) return { path, data: readJsonFile(path, { exclude: [] }) };
  }
  return { path: projectIgnoreListPath(), data: { exclude: [] } };
}

function ignoreListCandidates() {
  return [projectIgnoreListPath(), `${home}/.ai-config-sync-manager/rules/status-ignore.json`];
}

function projectIgnoreListPath() {
  return join(resolve(process.cwd()), ".ai-config-sync-manager/status-ignore.json");
}

function isIncluded(entry, include) {
  if (include.length === 0) return true;
  return include.some((selector) => selectorMatchesEntry(selector, entry));
}

function isExcluded(entry, exclude) {
  return exclude.some((selector) => selectorMatchesEntry(selector, entry));
}

function selectorMatchesEntry(selector, entry) {
  if (selector.area !== entry.area) return false;
  if (!selector.item) return true;
  return entryItems(entry).some((item) => itemMatchesSelector(item, selector.item));
}

function filterEntryItems(entry, selectors) {
  if (!entry.missingInCodex && !entry.missingInClaude && !entry.conflicts && !entry.unsupported)
    return entry;

  const includes = selectors.include.filter(
    (selector) => selector.area === entry.area && selector.item
  );
  const excludes = selectors.exclude.filter(
    (selector) => selector.area === entry.area && selector.item
  );
  const includeItems = includes.map((selector) => selector.item);
  const excludeItems = excludes.map((selector) => selector.item);
  const filtered = { ...entry };

  filtered.unsupported = filterItems(entry.unsupported ?? [], includeItems, excludeItems);
  filtered.missingInCodex = filterItems(entry.missingInCodex ?? [], includeItems, excludeItems);
  filtered.missingInClaude = filterItems(entry.missingInClaude ?? [], includeItems, excludeItems);
  filtered.conflicts = filterItems(entry.conflicts ?? [], includeItems, excludeItems);
  filtered.itemQualities = filterItemQualities(entry.itemQualities ?? {}, [
    ...filtered.unsupported,
    ...filtered.missingInCodex,
    ...filtered.missingInClaude,
    ...filtered.conflicts,
  ]);

  if (
    filtered.unsupported.length === 0 &&
    filtered.missingInCodex.length === 0 &&
    filtered.missingInClaude.length === 0 &&
    filtered.conflicts.length === 0
  )
    return null;
  return filtered;
}

function filterItemQualities(itemQualities, items) {
  return Object.fromEntries(
    Object.entries(itemQualities).filter(([item]) =>
      items.some((selected) => itemMatchesSelector(item, selected))
    )
  );
}

function filterItems(items, includeItems, excludeItems) {
  return items.filter((item) => {
    if (
      includeItems.length > 0 &&
      !includeItems.some((includeItem) => itemMatchesSelector(item, includeItem))
    )
      return false;
    return !excludeItems.some((excludeItem) => itemMatchesSelector(item, excludeItem));
  });
}

function itemMatchesSelector(item, selector) {
  const normalizedItem = item.replace(/^(allow|ask|deny):/, "");
  if (item === selector || normalizedItem === selector) return true;
  if (!/[*?]/.test(selector)) return false;
  const pattern = globToRegExp(selector);
  return pattern.test(item) || pattern.test(normalizedItem);
}

function entryItems(entry) {
  if (entry.missingInCodex || entry.missingInClaude || entry.conflicts || entry.unsupported) {
    return [
      ...(entry.unsupported ?? []),
      ...(entry.missingInCodex ?? []),
      ...(entry.missingInClaude ?? []),
      ...(entry.conflicts ?? []),
    ];
  }

  return [entry.area];
}

function directionalItems(entry, to) {
  const conflicts = entry.area === "mcp" ? (entry.conflicts ?? []) : [];
  if (to === "codex") return [...(entry.missingInCodex ?? []), ...conflicts];
  if (to === "claude") return [...(entry.missingInClaude ?? []), ...conflicts];
  return entryItems(entry);
}

function createSyncPlan(options, mode) {
  const ignoreSource = ignoreListSource();
  const ignoreRules = (ignoreSource.data?.exclude ?? []).filter(Boolean);
  const filtered = filterIgnoredEntries(
    filterEntries(diffScope(options.scope, ignoreRules), options.selectors)
  );
  const entries = filtered.entries;
  const baseline = readSyncState(options.scope);
  const callArchive = [];
  const operationOptions = { ...options, callArchive, ignoreRules: filtered.rules ?? [] };
  const operations = entries
    .flatMap((entry) => createOperations(entry, operationOptions))
    .filter(Boolean);
  const backupRoot = `${home}/.ai-config-sync-manager/backups/${new Date().toISOString().replaceAll(":", "-")}`;

  const vocabFindings = filterVocabFindings(
    lintScopeForVocab(options.scope),
    options.selectors,
    filtered.rules ?? []
  );

  return {
    from: options.from,
    to: options.to,
    route: options.routeExplicit ? "explicit" : "auto",
    scope: options.scope,
    mode,
    statePath: syncStatePath(options.scope),
    hasBaseline: Boolean(baseline),
    include: renderSelectors(options.selectors.include),
    exclude: renderSelectors(options.selectors.exclude),
    selectors: options.selectors,
    ignorePath: filtered.path,
    ignoreRules: filtered.rules ?? [],
    ignored: filtered.ignored,
    canApply: true,
    backupRoot,
    callArchive,
    callArchivePath: join(backupRoot, "unsupported-calls.json"),
    operations,
    vocabFindings,
    results: [],
    ledger: [],
    writesStarted: false,
  };
}

function createOperations(entry, options) {
  if (entry.statusOnly) return [];

  const { from, to } = options;
  const missingInTarget =
    to === "codex" ? (entry.missingInCodex ?? []) : (entry.missingInClaude ?? []);
  const missingInSource =
    to === "codex" ? (entry.missingInClaude ?? []) : (entry.missingInCodex ?? []);
  const conflicts = entry.conflicts ?? [];
  const operations = [];

  if (missingInTarget.length > 0) {
    operations.push(createOperationForItems(entry, from, to, missingInTarget, options));
  }

  if (missingInSource.length > 0) {
    operations.push(createDeleteOperation(entry, from, to, missingInSource));
  }

  if (conflicts.length > 0 || operations.length === 0) {
    operations.push(createOperation(entry, from, to, options));
  }

  return operations;
}

function createOperationForItems(entry, from, to, itemNames, options) {
  const scoped = {
    ...entry,
    missingInCodex: to === "codex" ? itemNames : [],
    missingInClaude: to === "claude" ? itemNames : [],
  };
  return createOperation(scoped, from, to, options);
}

function createDeleteOperation(entry, from, to, itemNames) {
  const deletableAreas = ["mcp", "permissions", "hooks", "skills", "agents"];
  if (!deletableAreas.includes(entry.area)) {
    return {
      scope: entry.scope,
      area: entry.area,
      risk: "manual",
      action: "delete-items",
      from,
      to,
      itemNames,
      backupRequired: true,
      approvalRequired: true,
    };
  }

  const targetPath = to === "claude" ? entry.claudePath : entry.codexPath;
  const sourcePath = from === "claude" ? entry.claudePath : entry.codexPath;
  const skillTargetIndex =
    entry.area === "skills"
      ? to === "claude"
        ? (entry.claudeSkillIndex ?? {})
        : (entry.codexSkillIndex ?? {})
      : undefined;
  return {
    scope: entry.scope,
    area: entry.area,
    risk: entry.risk,
    action: "delete-items",
    from,
    to,
    sourcePath,
    targetPath,
    sourceMcpPaths: from === "claude" ? entry.claudeMcpPaths : entry.codexMcpPaths,
    targetMcpPaths: to === "claude" ? entry.claudeMcpPaths : entry.codexMcpPaths,
    itemNames,
    serverNames: entry.area === "mcp" ? itemNames : undefined,
    skillNames: entry.area === "skills" ? itemNames : undefined,
    skillTargetIndex,
    agentNames: entry.area === "agents" ? itemNames : undefined,
    itemQualities: operationItemQualities(entry, itemNames),
    backupRequired: true,
    approvalRequired: false,
  };
}

function createOperation(entry, from, to, options = {}) {
  const sourcePath = from === "claude" ? entry.claudePath : entry.codexPath;
  const targetPath = to === "claude" ? entry.claudePath : entry.codexPath;

  if (entry.area === "permissions" || entry.area === "hooks") {
    const itemNames =
      entry.area === "permissions"
        ? permissionOperationItems(directionalItems(entry, to))
        : directionalItems(entry, to);
    if (itemNames.length === 0) return null;

    if (!existsSync(sourcePath)) {
      return {
        scope: entry.scope,
        area: entry.area,
        risk: "manual",
        action: "source-missing",
        sourcePath,
        targetPath,
        backupRequired: false,
        approvalRequired: true,
      };
    }

    return {
      scope: entry.scope,
      area: entry.area,
      risk: entry.risk,
      action: "merge-settings-items",
      from,
      to,
      sourcePath,
      targetPath,
      itemNames,
      itemQualities: operationItemQualities(entry, itemNames),
      patchPreview: settingsItemPatchPreview(entry.area, from, to, sourcePath, itemNames),
      reviewNotes: entry.area === "permissions" ? permissionReviewNotes(itemNames) : [],
      backupRequired: true,
      approvalRequired: false,
    };
  }

  if (entry.area === "mcp") {
    const sourceMcpPaths =
      from === "claude"
        ? (entry.claudeMcpPaths ?? [sourcePath])
        : (entry.codexMcpPaths ?? [sourcePath]);
    const targetMcpPaths =
      to === "claude"
        ? (entry.claudeMcpPaths ?? [targetPath])
        : (entry.codexMcpPaths ?? [targetPath]);

    if (!mcpSourceExists(sourceMcpPaths)) {
      return {
        scope: entry.scope,
        area: entry.area,
        risk: "manual",
        action: "source-missing",
        sourcePath,
        targetPath,
        backupRequired: false,
        approvalRequired: true,
      };
    }

    return {
      scope: entry.scope,
      area: entry.area,
      risk: entry.risk,
      action: "merge-mcp-servers",
      from,
      to,
      sourcePath,
      targetPath,
      sourceMcpPaths,
      targetMcpPaths,
      serverNames: directionalItems(entry, to),
      itemQualities: operationItemQualities(entry, directionalItems(entry, to)),
      patchPreview: mcpPatchPreview(
        sourceMcpPaths,
        targetMcpPaths,
        from,
        to,
        directionalItems(entry, to)
      ),
      backupRequired: true,
      approvalRequired: false,
    };
  }

  if (entry.area === "instructions") {
    const instructionContent = transformTextForHost(
      from === "claude" ? entry.claudeInstructionContent : entry.codexInstructionContent,
      from,
      to,
      { callArchive: options.callArchive }
    );
    recordVocabFindings(options.callArchive, lintHostVocab(instructionContent, to), from, to);
    if (!existsSync(sourcePath) && !instructionContent) {
      return {
        scope: entry.scope,
        area: entry.area,
        risk: "manual",
        action: "source-missing",
        sourcePath,
        targetPath,
        backupRequired: false,
        approvalRequired: true,
      };
    }

    const targetContent =
      to === "claude"
        ? (entry.claudeInstructionContent ?? "")
        : (entry.codexInstructionContent ?? "");
    const sourceContent = instructionContent ?? fileText(sourcePath);
    const overrides = activeOverridesForFilePair(entry.claudePath, entry.codexPath);
    const masked = maskBodiesForHosts(targetContent, sourceContent, to, from, overrides);
    return {
      scope: entry.scope,
      area: entry.area,
      risk: entry.risk,
      action: instructionContent ? "write-instructions" : "copy-file",
      sourcePath,
      targetPath,
      content: instructionContent,
      termMappingPath: terminologyMapPath(),
      targetTemplatePath: targetTemplatePath(),
      changePreview: contentChangePreview(
        `${toLabel(to)} current`,
        masked.target,
        `After apply from ${fromLabel(from)}`,
        masked.source,
        entryMaskTerms(entry, entry.area, options.ignoreRules ?? [])
      ),
      backupRequired: true,
      approvalRequired: false,
    };
  }

  if (entry.area === "skills") {
    const missing = to === "claude" ? (entry.missingInClaude ?? []) : (entry.missingInCodex ?? []);
    const conflicts = entry.conflicts ?? [];
    const skillNames = [...missing, ...conflicts];
    const sourceIndex =
      from === "claude" ? (entry.claudeSkillIndex ?? {}) : (entry.codexSkillIndex ?? {});
    return {
      scope: entry.scope,
      area: entry.area,
      risk: entry.risk,
      action: "copy-missing-skills",
      from,
      to,
      sourcePath,
      targetPath,
      skillNames,
      skillSourceIndex: sourceIndex,
      overwriteSkillNames: conflicts,
      itemQualities: operationItemQualities(entry, skillNames),
      termMappingPath: terminologyMapPath(),
      targetTemplatePath: targetTemplatePath(),
      changePreview: skillChangePreview(
        sourcePath,
        targetPath,
        conflicts,
        from,
        sourceIndex,
        entry,
        options.ignoreRules ?? []
      ),
      backupRequired: true,
      approvalRequired: false,
    };
  }

  if (entry.area === "agents") {
    const missing = to === "claude" ? (entry.missingInClaude ?? []) : (entry.missingInCodex ?? []);
    const conflicts = entry.conflicts ?? [];
    const agentNames = [...missing, ...conflicts];
    if (agentNames.length === 0) return null;

    return {
      scope: entry.scope,
      area: entry.area,
      risk: entry.risk,
      action: "merge-agents",
      from,
      to,
      sourcePath,
      targetPath,
      agentNames,
      overwriteAgentNames: conflicts,
      itemQualities: operationItemQualities(entry, agentNames),
      agentsMapPath: agentsMapPath(),
      termMappingPath: terminologyMapPath(),
      targetTemplatePath: targetTemplatePath(),
      changePreview: agentChangePreview(
        sourcePath,
        targetPath,
        conflicts,
        from,
        to,
        entry.claudeAgentPaths ?? {},
        entry.codexAgentPaths ?? {},
        entry,
        options.ignoreRules ?? []
      ),
      backupRequired: true,
      approvalRequired: false,
    };
  }

  return {
    scope: entry.scope,
    area: entry.area,
    risk: entry.risk,
    action: "manual-review",
    sourcePath,
    targetPath,
    backupRequired: true,
    approvalRequired: false,
  };
}

function operationItemQualities(entry, items) {
  return Object.fromEntries(
    items.map((item) => [
      item,
      entry.itemQualities?.[item] ??
        entry.itemQualities?.[item.replace(/^(allow|ask|deny):/, "")] ??
        "unsupported",
    ])
  );
}

function permissionReviewNotes(itemNames) {
  const notes = [];

  for (const itemName of itemNames) {
    const { bucket, value } = parsePermissionItem(itemName);
    const pattern = bashPattern(value);

    if (pattern?.risky) {
      notes.push(
        `${value}: broad, interpreter, shell-wrapper, network, or destructive command will be written as a prefix_rule; review before apply`
      );
      continue;
    }

    if (bucket === "allow" && value === "WebFetch") {
      notes.push(
        `${value}: maps to config.toml web_search = "live"; reverse sync will normalize to WebSearch (lossy)`
      );
      continue;
    }

    if (isAgentPermission(value) && !(bucket === "allow" && value === "Agent")) {
      notes.push(
        `${value}: unsupported on Codex (no spawn_agent gate); archived under unsupported-calls.json`
      );
      continue;
    }

    if (itemMappingQuality("permissions", itemName) === "approximate") {
      notes.push(
        `${value}: maps to a broad Codex approval policy; review before relying on equivalent behavior`
      );
    } else if (itemMappingQuality("permissions", itemName) === "unsupported") {
      notes.push(`${value}: unsupported permission mapping; preserved as metadata only`);
    }
  }

  return notes;
}

function settingsItemPatchPreview(area, from, to, sourcePath, itemNames) {
  if (area === "permissions") return permissionPatchPreview(to, itemNames);
  if (area === "hooks") return hookPatchPreview(from, to, sourcePath, itemNames);
  return [];
}

function permissionPatchPreview(to, itemNames) {
  return itemNames.map((itemName) => {
    const { bucket, value } = parsePermissionItem(itemName);
    const changes = [];

    if (to === "claude") {
      changes.push(`settings.json permissions.${bucket}: add ${JSON.stringify(value)}`);
      return { item: itemName, action: "merge-settings-item", changes };
    }

    if (isAgentPermission(value)) {
      if (bucket === "allow" && value === "Agent") {
        changes.push("no-op (codex default already permits spawn_agent)");
      } else {
        changes.push("archive unsupported permission to unsupported-calls.json");
      }
      return { item: itemName, action: "merge-settings-item", changes };
    }

    if (["Write", "Edit", "MultiEdit"].includes(value)) {
      changes.push('config.toml sandbox_mode = "workspace-write"');
    }
    if (bucket === "allow" && (value === "WebSearch" || value === "WebFetch")) {
      changes.push('config.toml web_search = "live"');
    }
    if (bucket === "ask") {
      changes.push('config.toml approval_policy = "on-request"');
    }
    const mcp = parseMcpPermission(value);
    if (mcp) {
      if (isMcpServerScopePermission(mcp)) {
        if (bucket === "deny") {
          changes.push(`config.toml [mcp_servers.${mcp.server}] enabled_tools = []`);
        } else {
          changes.push(
            `config.toml [mcp_servers.${mcp.server}] (no-op; codex defaults already allow every tool)`
          );
        }
      } else {
        const approvalMode = bucket === "deny" ? "deny" : bucket === "ask" ? "prompt" : "approve";
        changes.push(
          `config.toml [mcp_servers.${mcp.server}.tools.${mcp.tool}] approval_mode = ${JSON.stringify(approvalMode)}`
        );
        if (bucket === "allow") {
          changes.push(
            `config.toml [mcp_servers.${mcp.server}] enabled_tools += ${JSON.stringify(mcp.tool)}`
          );
        } else if (bucket === "deny") {
          changes.push(
            `config.toml [mcp_servers.${mcp.server}] disabled_tools += ${JSON.stringify(mcp.tool)}`
          );
        }
      }
    }
    const rule = codexPrefixRuleForPermission(bucket, value);
    if (rule) {
      changes.push(`rules/default.rules ${rule}`);
    }
    if (changes.length === 0 || itemMappingQuality("permissions", itemName) === "metadata-only") {
      changes.push(`managed metadata permissions.${bucket} = ${JSON.stringify(value)}`);
    }

    return { item: itemName, action: "merge-settings-item", changes };
  });
}

function hookPatchPreview(from, to, sourcePath, itemNames) {
  const sourceValues =
    to === "codex" && from === "claude" ? claudeManagedValues("hooks", sourcePath, itemNames) : {};

  return itemNames.map((itemName) => {
    const changes = [];

    if (to === "claude") {
      changes.push(`settings.json hooks.${itemName}: add or merge`);
    } else {
      changes.push("config.toml [features] hooks = true");
      const groups = sourceValues[itemName];
      changes.push(
        Array.isArray(groups) && groups.every(isCodexNativeHookGroup)
          ? `config.toml [[hooks.${itemName}]] native command hook entries`
          : `managed metadata hooks.${itemName}`
      );
    }

    return { item: itemName, action: "merge-settings-item", changes };
  });
}

function renderSyncPlan(plan) {
  const lines = [
    "AI Config Sync Manager sync",
    `Route: ${plan.route === "auto" ? `auto (diff-directed, default ${plan.from} -> ${plan.to})` : `${plan.from} -> ${plan.to}`}`,
    `Scope: ${plan.scope}`,
    `Mode: ${plan.mode}`,
    `Include: ${plan.include.length ? plan.include.join(", ") : "all"}`,
    `Exclude: ${plan.exclude.length ? plan.exclude.join(", ") : "none"}`,
    formatPlanIgnoreLine(plan.ignorePath, plan.ignoreRules, plan.ignored),
    `Backup root: ${plan.backupRoot}`,
  ];

  if (plan.operations.length === 0) {
    lines.push("No sync operations planned.");
  }

  for (const operation of plan.operations) {
    lines.push("");
    lines.push(`[${operation.risk}] ${operation.scope}/${operation.area}: ${operation.action}`);
    lines.push(`  Source: ${operation.sourcePath}`);
    lines.push(`  Target: ${operation.targetPath}`);
    lines.push(`  Backup required: ${operation.backupRequired ? "yes" : "no"}`);
    lines.push(`  Approval required: ${operation.approvalRequired ? "yes" : "no"}`);
    if (operation.skillNames?.length) {
      lines.push(`  Skills: ${formatOperationItems(operation, operation.skillNames).join(", ")}`);
    }
    if (operation.itemNames?.length && operation.area !== "skills") {
      lines.push(`  Items: ${formatOperationItems(operation, operation.itemNames).join(", ")}`);
    }
    if (operation.serverNames?.length) {
      lines.push(
        `  MCP servers: ${formatOperationItems(operation, operation.serverNames).join(", ")}`
      );
    }
    if (operation.termMappingPath) {
      lines.push(`  Term mapping: ${operation.termMappingPath}`);
    }
    if (operation.targetTemplatePath) {
      lines.push(`  Target templates: ${operation.targetTemplatePath}`);
    }
    if (operation.reviewNotes?.length) {
      lines.push("  Review notes:");
      for (const note of operation.reviewNotes) {
        lines.push(`    - ${note}`);
      }
    }
    if (operation.patchPreview?.length) {
      lines.push("  Patch preview:");
      for (const patch of operation.patchPreview) {
        lines.push(`    - ${patch.item ?? patch.server}: ${patch.action}`);
        for (const change of patch.changes) {
          lines.push(`      ${change}`);
        }
      }
    }
    if (operation.changePreview?.length) {
      lines.push("  Change preview:");
      for (const line of operation.changePreview) {
        lines.push(`    ${line}`);
      }
    }
    if (operation.skillNames && operation.skillNames.length === 0) {
      lines.push("  Skills: none missing in target direction");
    }
  }

  if (Array.isArray(plan.vocabFindings) && plan.vocabFindings.length > 0) {
    lines.push("");
    lines.push(...renderVocabFindings(plan.vocabFindings));
  }

  if (plan.mode === "apply" && plan.results.length > 0) {
    lines.push("");
    lines.push("Apply results:");
    for (const result of plan.results) {
      lines.push(`  ${result.status}: ${result.message}`);
    }
    if (Array.isArray(plan.callArchive) && plan.callArchive.length > 0) {
      lines.push(`Calls archive: ${plan.callArchivePath}`);
    }
  } else {
    lines.push("");
    lines.push("Dry-run only. No files were modified.");
  }

  return lines.join("\n");
}

function renderSyncPlans(plans) {
  return plans.map(renderSyncPlan).join("\n\n");
}

function formatOperationItems(operation, items) {
  return items.map((item) => {
    const quality =
      operation.itemQualities?.[item] ??
      operation.itemQualities?.[item.replace(/^(allow|ask|deny):/, "")];
    return quality ? `${item} [${quality}]` : item;
  });
}

function terminologyMapPath() {
  return terminologyMapSource().path;
}

function targetTemplatePath() {
  return targetTemplateSource().path;
}

function terminologyMapSource() {
  return loadLayeredRule(terminologyMapCandidates(), { layers: [] }, mergeTerminologyMap);
}

function terminologyMapCandidates() {
  return [
    join(resolve(process.cwd()), "rules/terminology-map.json"),
    `${home}/.ai-config-sync-manager/rules/terminology-map.json`,
    join(runtimeRoot, "rules/terminology-map.json"),
  ];
}

function targetTemplateSource() {
  return loadLayeredRule(targetTemplateCandidates(), { templates: [] }, mergeTargetTemplates);
}

function targetTemplateCandidates() {
  return [
    join(resolve(process.cwd()), "rules/host-target-templates.json"),
    `${home}/.ai-config-sync-manager/rules/host-target-templates.json`,
    join(runtimeRoot, "rules/host-target-templates.json"),
  ];
}

function transformTextForHost(value, from, to, options = {}) {
  return applyTermMappings(
    applyTargetTemplates(applyCallTransforms(value, from, to, options.callArchive), from, to),
    from,
    to
  );
}

function callTemplatesData() {
  return callTemplatesSource().data;
}

function callTemplatesSource() {
  return loadLayeredRule(
    callTemplatesCandidates(),
    { supported: [], unsupported: [] },
    mergeCallTemplates
  );
}

function callTemplatesCandidates() {
  return [
    join(resolve(process.cwd()), "rules/call-templates.json"),
    `${home}/.ai-config-sync-manager/rules/call-templates.json`,
    join(runtimeRoot, "rules/call-templates.json"),
  ];
}

function hostStrictVocabSource() {
  return loadLayeredRule(
    hostStrictVocabCandidates(),
    { claude_only: [], codex_only: [], claude_only_patterns: [] },
    mergeHostStrictVocab
  );
}

function hostStrictVocabCandidates() {
  return [
    join(resolve(process.cwd()), "rules/host-strict-vocab.json"),
    `${home}/.ai-config-sync-manager/rules/host-strict-vocab.json`,
    join(runtimeRoot, "rules/host-strict-vocab.json"),
  ];
}

function mergeHostStrictVocab(base, override) {
  const out = {
    claude_only: [...(base.claude_only ?? [])],
    codex_only: [...(base.codex_only ?? [])],
    claude_only_patterns: [...(base.claude_only_patterns ?? [])],
  };
  for (const key of ["claude_only", "codex_only", "claude_only_patterns"]) {
    const add = Array.isArray(override?.[key]) ? override[key] : [];
    for (const item of add) {
      if (typeof item === "string" && item && !out[key].includes(item)) out[key].push(item);
    }
  }
  return out;
}

function paraphraseMapSource() {
  return loadLayeredRule(
    paraphraseMapCandidates(),
    { claude_only: {}, codex_only: {} },
    mergeParaphraseMap
  );
}

function paraphraseMapCandidates() {
  return [
    join(resolve(process.cwd()), "rules/paraphrase-map.json"),
    `${home}/.ai-config-sync-manager/rules/paraphrase-map.json`,
    join(runtimeRoot, "rules/paraphrase-map.json"),
  ];
}

function mergeParaphraseMap(base, override) {
  const out = {
    claude_only: { ...(base.claude_only ?? {}) },
    codex_only: { ...(base.codex_only ?? {}) },
  };
  for (const key of ["claude_only", "codex_only"]) {
    const add = override?.[key];
    if (!add || typeof add !== "object") continue;
    for (const [token, paraphrase] of Object.entries(add)) {
      if (typeof token !== "string" || !token) continue;
      if (typeof paraphrase !== "string" || !paraphrase) continue;
      out[key][token] = paraphrase;
    }
  }
  return out;
}

function paraphraseOverridesSource() {
  return loadLayeredRule(
    paraphraseOverridesCandidates(),
    { overrides: [] },
    mergeParaphraseOverrides
  );
}

function paraphraseOverridesCandidates() {
  return [
    join(resolve(process.cwd()), "rules/paraphrase-overrides.json"),
    `${home}/.ai-config-sync-manager/rules/paraphrase-overrides.json`,
    join(runtimeRoot, "rules/paraphrase-overrides.json"),
  ];
}

function mergeParaphraseOverrides(base, override) {
  const baseList = Array.isArray(base.overrides) ? base.overrides : [];
  const overlayList = Array.isArray(override?.overrides) ? override.overrides : [];
  const byId = new Map();
  for (const entry of baseList) {
    if (entry && typeof entry === "object" && typeof entry.id === "string")
      byId.set(entry.id, entry);
  }
  for (const entry of overlayList) {
    if (entry && typeof entry === "object" && typeof entry.id === "string")
      byId.set(entry.id, entry);
  }
  return { overrides: [...byId.values()] };
}

function activeParaphraseOverrides() {
  const list = paraphraseOverridesSource().data?.overrides ?? [];
  const active = [];
  const stale = [];
  for (const entry of list) {
    if (!isParaphraseOverrideShape(entry)) continue;
    const status = paraphraseOverrideStatus(entry);
    if (status === "active") active.push(entry);
    else stale.push({ ...entry, _staleReason: status });
  }
  return { active, stale };
}

function isParaphraseOverrideShape(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    typeof entry.id === "string" &&
    entry.id &&
    typeof entry.claude_path === "string" &&
    entry.claude_path &&
    typeof entry.codex_path === "string" &&
    entry.codex_path &&
    Number.isInteger(entry.claude_line) &&
    entry.claude_line >= 1 &&
    Number.isInteger(entry.codex_line) &&
    entry.codex_line >= 1 &&
    typeof entry.claude_text === "string" &&
    typeof entry.codex_text === "string"
  );
}

function paraphraseOverrideStatus(entry) {
  const claudePath = expandHome(entry.claude_path);
  const codexPath = expandHome(entry.codex_path);
  if (!existsSync(claudePath)) return "stale:claude-missing";
  if (!existsSync(codexPath)) return "stale:codex-missing";
  const claudeLine = readHostBodyLine(entry.area, "claude", claudePath, entry.claude_line);
  const codexLine = readHostBodyLine(entry.area, "codex", codexPath, entry.codex_line);
  if (claudeLine !== entry.claude_text) return "stale:claude-text";
  if (codexLine !== entry.codex_text) return "stale:codex-text";
  return "active";
}

function readHostFileBody(area, host, path) {
  if (!path || !existsSync(path)) return "";
  if (area === "agents") {
    if (host === "claude") return parseClaudeAgentFile(path).body ?? "";
    return parseCodexAgentFile(path).developer_instructions ?? "";
  }
  return readFileSync(path, "utf8");
}

function writeHostFileBody(area, host, path, newBody) {
  if (area === "agents") {
    if (host === "claude") {
      const parsed = parseClaudeAgentFile(path);
      writeFileSync(path, serializeClaudeAgentFile(parsed.frontmatter, newBody));
    } else {
      const parsed = parseCodexAgentFile(path);
      writeFileSync(path, serializeCodexAgentFile({ ...parsed, developer_instructions: newBody }));
    }
    return;
  }
  writeFileSync(path, newBody);
}

function readHostBodyLine(area, host, path, lineNumber) {
  if (!Number.isInteger(lineNumber) || lineNumber < 1) return null;
  const body = readHostFileBody(area, host, path);
  if (!body) return null;
  const lines = body.split(/\r?\n/);
  return lineNumber <= lines.length ? lines[lineNumber - 1] : null;
}

function findCounterpartLineByText(area, host, path, expectedText, preferredLineNumber) {
  if (typeof expectedText !== "string") return null;
  const body = readHostFileBody(area, host, path);
  if (!body) return null;
  const lines = body.split(/\r?\n/);
  const matches = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === expectedText) matches.push(i + 1);
  }
  if (matches.length === 0) return null;
  const anchor = Number.isInteger(preferredLineNumber) ? preferredLineNumber : matches[0];
  let best = matches[0];
  let bestDelta = Math.abs(best - anchor);
  for (const lineNumber of matches) {
    const delta = Math.abs(lineNumber - anchor);
    if (delta < bestDelta) {
      best = lineNumber;
      bestDelta = delta;
    }
  }
  return best;
}

function activeOverridesForFilePair(claudePath, codexPath) {
  if (!claudePath || !codexPath) return [];
  const expectedClaude = expandHome(claudePath);
  const expectedCodex = expandHome(codexPath);
  const { active } = activeParaphraseOverrides();
  return active.filter(
    (entry) =>
      pathsEqualOrSkillManifestAlias(entry.claude_path, expectedClaude) &&
      pathsEqualOrSkillManifestAlias(entry.codex_path, expectedCodex)
  );
}

function pathsEqualOrSkillManifestAlias(leftPath, rightPath) {
  const left = expandHome(leftPath);
  const right = expandHome(rightPath);
  if (left === right) return true;
  const leftSlash = left.lastIndexOf("/");
  const rightSlash = right.lastIndexOf("/");
  if (leftSlash === -1 || rightSlash === -1) return false;
  if (left.slice(0, leftSlash) !== right.slice(0, rightSlash)) return false;
  return (
    isSkillManifestBasename(left.slice(leftSlash + 1)) &&
    isSkillManifestBasename(right.slice(rightSlash + 1))
  );
}

function maskBodyAtLine(body, lineNumber, expectedText, sentinel) {
  if (typeof body !== "string" || !body) return body ?? "";
  if (!Number.isInteger(lineNumber) || lineNumber < 1) return body;
  const lines = body.split(/\r?\n/);
  if (lineNumber > lines.length) return body;
  if (lines[lineNumber - 1] !== expectedText) return body;
  lines[lineNumber - 1] = sentinel;
  return lines.join("\n");
}

function maskBodiesWithOverrides(claudeBody, codexBody, overrides) {
  if (!Array.isArray(overrides) || overrides.length === 0) {
    return { claudeBody: claudeBody ?? "", codexBody: codexBody ?? "" };
  }
  let left = claudeBody ?? "";
  let right = codexBody ?? "";
  for (const entry of overrides) {
    const sentinel = ` PO:${entry.id} `;
    left = maskBodyAtLine(left, entry.claude_line, entry.claude_text, sentinel);
    right = maskBodyAtLine(right, entry.codex_line, entry.codex_text, sentinel);
  }
  return { claudeBody: left, codexBody: right };
}

function maskBodiesForHosts(targetBody, sourceBody, targetHost, sourceHost, overrides) {
  if (!Array.isArray(overrides) || overrides.length === 0) {
    return { target: targetBody ?? "", source: sourceBody ?? "" };
  }
  let target = targetBody ?? "";
  let source = sourceBody ?? "";
  for (const entry of overrides) {
    const sentinel = ` PO:${entry.id} `;
    const targetLine = targetHost === "claude" ? entry.claude_line : entry.codex_line;
    const targetText = targetHost === "claude" ? entry.claude_text : entry.codex_text;
    const sourceLine = sourceHost === "claude" ? entry.claude_line : entry.codex_line;
    const sourceText = sourceHost === "claude" ? entry.claude_text : entry.codex_text;
    target = maskBodyAtLine(target, targetLine, targetText, sentinel);
    source = maskBodyAtLine(source, sourceLine, sourceText, sentinel);
  }
  return { target, source };
}

function activeManifestOverridesForPair(targetPath, sourcePath, targetHost) {
  if (!targetPath || !sourcePath) return [];
  const claudePath = targetHost === "claude" ? targetPath : sourcePath;
  const codexPath = targetHost === "codex" ? targetPath : sourcePath;
  return activeOverridesForFilePair(claudePath, codexPath);
}

function skillManifestPathFor(basePath, skillName) {
  if (!basePath || !skillName) return null;
  const skillPath = join(basePath, skillName);
  const manifest = findSkillManifest(skillPath);
  if (manifest) return manifest;
  if (existsSync(skillPath) && !lstatSync(skillPath).isDirectory()) return skillPath;
  return null;
}

function lintHostVocab(text, targetHost) {
  const findings = [];
  const value = String(text ?? "");
  if (!value) return findings;
  const wrongSide =
    targetHost === "claude" ? "codex_only" : targetHost === "codex" ? "claude_only" : null;
  if (!wrongSide) return findings;
  const data = hostStrictVocabSource().data ?? {};
  const tokens = Array.isArray(data[wrongSide]) ? data[wrongSide] : [];
  // claude_only_patterns are namespace prefixes (e.g. mcp__) only meaningful to flag on codex.
  const patterns =
    targetHost === "codex" && Array.isArray(data.claude_only_patterns)
      ? data.claude_only_patterns
      : [];

  const lines = value.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Skip ai-config-sync marker JSON so round-trip-preserved call names are not flagged.
    if (line.includes('"call":"')) continue;
    if (line.includes("ai-config-sync:")) continue;
    for (const token of tokens) {
      const re = new RegExp(`\\b${escapeRegExp(token)}\\b`, "g");
      let m;
      while ((m = re.exec(line)) !== null) {
        findings.push({ token, line: i + 1, col: m.index + 1, side: wrongSide });
      }
    }
    for (const pat of patterns) {
      const re = new RegExp(`\\b(${pat})[A-Za-z0-9_-]+\\b`, "g");
      let m;
      while ((m = re.exec(line)) !== null) {
        findings.push({ token: m[0], line: i + 1, col: m.index + 1, side: "claude_only" });
      }
    }
  }
  return findings;
}

function recordVocabFindings(archive, findings, from, to) {
  if (!Array.isArray(archive) || !Array.isArray(findings) || findings.length === 0) return;
  for (const f of findings) {
    pushArchiveEntry(archive, {
      direction: `${from}->${to}`,
      rule_id: "host-strict-vocab",
      call: f.token,
      action: "vocab-mismatch",
      original: `line ${f.line}: ${f.token}`,
      fields: { side: f.side, lineNumber: f.line, column: f.col },
      reason: `${f.token} is ${f.side.replace("_only", "-only")} — not callable on ${to}`,
    });
  }
}

function sanitizeAgentToolsField(toolsValue, targetHost) {
  const raw = String(toolsValue ?? "");
  if (!raw) return { sanitized: "", removed: [] };
  const data = hostStrictVocabSource().data ?? {};
  const wrongSide =
    targetHost === "claude" ? "codex_only" : targetHost === "codex" ? "claude_only" : null;
  const wrongTokens =
    wrongSide && Array.isArray(data[wrongSide]) ? new Set(data[wrongSide]) : new Set();
  const wrongPatterns =
    targetHost === "codex" && Array.isArray(data.claude_only_patterns)
      ? data.claude_only_patterns.map((p) => new RegExp(`^${p}`))
      : [];
  const tokens = raw
    .split(/\s*,\s*/)
    .map((t) => t.trim())
    .filter(Boolean);
  const removed = [];
  const kept = [];
  for (const t of tokens) {
    if (wrongTokens.has(t)) {
      removed.push(t);
      continue;
    }
    if (wrongPatterns.some((re) => re.test(t))) {
      removed.push(t);
      continue;
    }
    kept.push(t);
  }
  return { sanitized: kept.join(","), removed };
}

function lintAgentFileForVocab(path, host) {
  if (!existsSync(path)) return [];
  if (host === "claude") {
    const parsed = parseClaudeAgentFile(path);
    return lintHostVocab(parsed.body ?? "", host);
  }
  const parsed = parseCodexAgentFile(path);
  return lintHostVocab(parsed.developer_instructions ?? "", host);
}

function lintSkillManifestForVocab(path, host) {
  if (!existsSync(path)) return [];
  return lintHostVocab(readFileSync(path, "utf8"), host);
}

function lintInstructionFileForVocab(path, host) {
  if (!existsSync(path)) return [];
  return lintHostVocab(readFileSync(path, "utf8"), host);
}

function scanAgentsForVocab(dir, host, scope, findings) {
  if (!dir || !existsSync(dir)) return;
  const list = host === "claude" ? enumerateClaudeAgents(dir) : enumerateCodexAgents(dir);
  for (const agent of list) {
    for (const f of lintAgentFileForVocab(agent.path, host)) {
      findings.push({ scope, area: "agents", host, item: agent.name, path: agent.path, ...f });
    }
  }
}

function scanSkillsForVocab(dirs, host, scope, findings) {
  const list = Array.isArray(dirs) ? dirs : [dirs];
  for (const dir of list) {
    if (!dir || !existsSync(dir)) continue;
    for (const skillName of skillNames(dir)) {
      const manifest = findSkillManifest(join(dir, skillName));
      if (!manifest) continue;
      for (const f of lintSkillManifestForVocab(manifest, host)) {
        findings.push({ scope, area: "skills", host, item: skillName, path: manifest, ...f });
      }
    }
  }
}

function scanInstructionForVocab(path, host, scope, findings) {
  for (const f of lintInstructionFileForVocab(path, host)) {
    findings.push({ scope, area: "instructions", host, item: "instructions", path, ...f });
  }
}

function lintScopeForVocab(scope) {
  const paths = scope === "global" ? globalPaths() : projectPaths(process.cwd());
  const findings = [];
  scanAgentsForVocab(paths.claude.agents, "claude", scope, findings);
  scanAgentsForVocab(paths.codex.agents, "codex", scope, findings);
  scanSkillsForVocab(paths.claude.skillsPaths ?? [paths.claude.skills], "claude", scope, findings);
  scanSkillsForVocab(paths.codex.skillsPaths ?? [paths.codex.skills], "codex", scope, findings);
  scanInstructionForVocab(paths.claude.instructions, "claude", scope, findings);
  scanInstructionForVocab(paths.codex.instructions, "codex", scope, findings);
  for (const f of findings) f.recommended = suggestVocabReplacement(f);
  return findings;
}

function suggestVocabReplacement(finding) {
  const nativeHost = finding.side === "codex_only" ? "codex" : "claude";
  const fileHost = finding.host;
  if (nativeHost === fileHost) return null;
  // Term-mapping pass only — skip applyTargetTemplates/applyCallTransforms which expand
  // single tokens into verbose canonical phrases ("Claude Task-tool delegation") that
  // are noisy for an inline suggestion. Term rules give 1:1 token replacements.
  const probe = ` ${finding.token} `;
  const transformed = applyTermMappings(probe, nativeHost, fileHost);
  if (transformed === probe) return null;
  const stripped = transformed.replace(/^\s+|\s+$/g, "");
  return stripped && stripped !== finding.token ? stripped : null;
}

function filterVocabFindings(findings, selectors, ignoreRules) {
  return findings.filter((f) => {
    if (!includesArea(selectors, f.area, f.item)) return false;
    if (vocabFindingIgnored(f, ignoreRules)) return false;
    return true;
  });
}

function includesArea(selectors, area, item) {
  if (!selectors) return true;
  const includes = Array.isArray(selectors.include) ? selectors.include : [];
  const excludes = Array.isArray(selectors.exclude) ? selectors.exclude : [];
  if (excludes.some((s) => s.area === area && (!s.item || s.item === item))) return false;
  if (includes.length === 0) return true;
  return includes.some((s) => s.area === area && (!s.item || s.item === item));
}

function vocabFindingIgnored(finding, ignoreRules) {
  if (!Array.isArray(ignoreRules) || ignoreRules.length === 0) return false;
  for (const rule of ignoreRules) {
    if (typeof rule?.term === "string" && rule.term && finding.path.includes(rule.term))
      return true;
    if (rule?.area && rule.area === finding.area) {
      if (typeof rule.item === "string" && rule.item && rule.item === finding.item) return true;
      if (
        typeof rule.path === "string" &&
        rule.path &&
        finding.path.includes(rule.path.replace(/\*+/g, ""))
      )
        return true;
    }
  }
  return false;
}

function applyCallTransforms(value, from, to, archive) {
  const text = String(value ?? "");
  if (!text || from === to) return text;

  const data = callTemplatesData();
  const supported = Array.isArray(data?.supported) ? data.supported : [];
  const unsupported = Array.isArray(data?.unsupported) ? data.unsupported : [];

  if (from === "claude" && to === "codex") {
    return applyClaudeToCodexCallTransforms(text, supported, unsupported, archive);
  }
  if (from === "codex" && to === "claude") {
    return applyCodexToClaudeCallTransforms(text, supported, unsupported, archive);
  }
  return text;
}

function applyClaudeToCodexCallTransforms(text, supported, unsupported, archive) {
  let working = text;
  for (const rule of supported) {
    if (typeof rule?.claude_call !== "string" || !rule.claude_call) continue;
    working = transformClaudeCallsForward(working, rule, archive);
  }
  for (const rule of unsupported) {
    if (typeof rule?.claude_call !== "string" || !rule.claude_call) continue;
    working = stripClaudeCallsForward(working, rule, archive);
  }
  return working;
}

function applyCodexToClaudeCallTransforms(text, supported, unsupported, archive) {
  let working = stripManualReviewMarkersReverse(text);
  for (const rule of supported) {
    if (typeof rule?.codex_marker !== "string" || !rule.codex_marker) continue;
    working = transformCodexProseReverse(working, rule, archive);
  }
  for (const rule of unsupported) {
    if (typeof rule?.codex_marker !== "string" || !rule.codex_marker) continue;
    working = restoreStrippedCallsReverse(working, rule, archive);
  }
  return working;
}

function stripManualReviewMarkersReverse(text) {
  return String(text ?? "").replace(
    /<!--\s*ai-config-sync:manual-review\b[^>]*-->(?=\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\()/g,
    ""
  );
}

function transformClaudeCallsForward(text, rule, archive) {
  const callName = rule.claude_call;
  let result = "";
  let cursor = 0;

  while (cursor < text.length) {
    const match = findCallStart(text, callName, cursor);
    if (match === -1) {
      result += text.slice(cursor);
      break;
    }

    const openParen = text.indexOf("(", match + callName.length);
    if (openParen === -1) {
      result += text.slice(cursor);
      break;
    }

    const closeParen = findMatchingClose(text, openParen);
    if (closeParen === -1) {
      result += text.slice(cursor, match);
      result += emitManualReviewComment(callName, "unterminated call expression");
      result += text.slice(match);
      pushArchiveEntry(archive, {
        direction: "claude->codex",
        rule_id: rule.id ?? null,
        call: callName,
        action: "manual-review",
        original: text.slice(match),
        fields: null,
        reason: "unterminated call expression",
      });
      break;
    }

    const argText = text.slice(openParen + 1, closeParen);
    const fullCall = text.slice(match, closeParen + 1);
    const parsed = parseSingleObjectArgument(argText);

    result += text.slice(cursor, match);

    if (!parsed.ok) {
      result += emitManualReviewComment(callName, parsed.reason);
      result += fullCall;
      pushArchiveEntry(archive, {
        direction: "claude->codex",
        rule_id: rule.id ?? null,
        call: callName,
        action: "manual-review",
        original: fullCall,
        fields: null,
        reason: parsed.reason,
      });
      cursor = closeParen + 1;
      continue;
    }

    const aliasedFields = renameFieldKeys(parsed.fields, rule.field_aliases?.claude_to_codex);
    const rendered = renderCodexTemplate(rule.codex_template, aliasedFields);
    const markerPayload = JSON.stringify({ call: callName, fields: parsed.fields });
    const marker = `<!-- ${rule.codex_marker} ${markerPayload} -->`;
    result += `${marker}\n${rendered}`;
    pushArchiveEntry(archive, {
      direction: "claude->codex",
      rule_id: rule.id ?? null,
      call: callName,
      action: "transformed",
      original: fullCall,
      fields: parsed.fields,
      reason: null,
    });
    cursor = closeParen + 1;
  }

  return result;
}

function stripClaudeCallsForward(text, rule, archive) {
  const callName = rule.claude_call;
  let result = "";
  let cursor = 0;

  while (cursor < text.length) {
    const match = findCallStart(text, callName, cursor);
    if (match === -1) {
      result += text.slice(cursor);
      break;
    }

    const openParen = text.indexOf("(", match + callName.length);
    if (openParen === -1) {
      result += text.slice(cursor);
      break;
    }

    const closeParen = findMatchingClose(text, openParen);
    if (closeParen === -1) {
      result += text.slice(cursor, match);
      result += emitManualReviewComment(callName, "unterminated call expression");
      result += text.slice(match);
      pushArchiveEntry(archive, {
        direction: "claude->codex",
        rule_id: rule.id ?? null,
        call: callName,
        action: "manual-review",
        original: text.slice(match),
        fields: null,
        reason: "unterminated call expression",
      });
      break;
    }

    const argText = text.slice(openParen + 1, closeParen);
    const fullCall = text.slice(match, closeParen + 1);
    const parsed = parseSingleObjectArgument(argText);

    result += text.slice(cursor, match);

    if (!parsed.ok) {
      result += emitManualReviewComment(callName, parsed.reason);
      result += fullCall;
      pushArchiveEntry(archive, {
        direction: "claude->codex",
        rule_id: rule.id ?? null,
        call: callName,
        action: "manual-review",
        original: fullCall,
        fields: null,
        reason: parsed.reason,
      });
      cursor = closeParen + 1;
      continue;
    }

    const reason = typeof rule.reason === "string" ? rule.reason : "";
    const markerPayload = JSON.stringify({
      call: callName,
      fields: parsed.fields,
      reason,
    });
    result += `<!-- ${rule.codex_marker} ${markerPayload} -->`;
    pushArchiveEntry(archive, {
      direction: "claude->codex",
      rule_id: rule.id ?? null,
      call: callName,
      action: "stripped",
      original: fullCall,
      fields: parsed.fields,
      reason: reason || null,
    });
    cursor = closeParen + 1;
  }

  return result;
}

function transformCodexProseReverse(text, rule, archive) {
  const marker = rule.codex_marker;
  const escaped = escapeRegExp(marker);
  const markerPattern = new RegExp(`<!--\\s*${escaped}\\s+(\\{[\\s\\S]*?\\})\\s*-->`, "g");
  let result = "";
  let cursor = 0;

  for (const match of text.matchAll(markerPattern)) {
    const start = match.index;
    const end = start + match[0].length;
    result += text.slice(cursor, start);

    const payload = parseMarkerPayload(match[1]);
    if (!payload.ok) {
      result += match[0];
      pushArchiveEntry(archive, {
        direction: "codex->claude",
        rule_id: rule.id ?? null,
        call: null,
        action: "manual-review",
        original: match[0],
        fields: null,
        reason: payload.reason,
      });
      cursor = end;
      continue;
    }

    const callName = typeof payload.value.call === "string" ? payload.value.call : null;
    const fields = payload.value.fields;
    if (!callName || !fields || typeof fields !== "object") {
      result += match[0];
      pushArchiveEntry(archive, {
        direction: "codex->claude",
        rule_id: rule.id ?? null,
        call: callName,
        action: "manual-review",
        original: match[0],
        fields: fields ?? null,
        reason: "marker payload missing call or fields",
      });
      cursor = end;
      continue;
    }

    const proseEnd = findReverseProseBlockEnd(text, end, marker, rule, fields);
    if (proseEnd === -1) {
      result += emitManualReviewComment(callName, "could not delimit rendered prose");
      result += match[0];
      pushArchiveEntry(archive, {
        direction: "codex->claude",
        rule_id: rule.id ?? null,
        call: callName,
        action: "manual-review",
        original: match[0],
        fields,
        reason: "could not delimit rendered prose",
      });
      cursor = end;
      continue;
    }

    const aliased = renameFieldKeys(fields, rule.field_aliases?.codex_to_claude);
    const reconstruction = `${callName}(${formatObjectLiteral(aliased)})`;
    result += reconstruction;
    pushArchiveEntry(archive, {
      direction: "codex->claude",
      rule_id: rule.id ?? null,
      call: callName,
      action: "restored",
      original: text.slice(start, proseEnd),
      fields,
      reason: null,
    });
    cursor = proseEnd;
  }

  result += text.slice(cursor);
  return result;
}

function restoreStrippedCallsReverse(text, rule, archive) {
  const marker = rule.codex_marker;
  const escaped = escapeRegExp(marker);
  const markerPattern = new RegExp(`<!--\\s*${escaped}\\s+(\\{[\\s\\S]*?\\})\\s*-->`, "g");
  let result = "";
  let cursor = 0;

  for (const match of text.matchAll(markerPattern)) {
    const start = match.index;
    const end = start + match[0].length;
    result += text.slice(cursor, start);

    const payload = parseMarkerPayload(match[1]);
    if (!payload.ok) {
      result += match[0];
      pushArchiveEntry(archive, {
        direction: "codex->claude",
        rule_id: rule.id ?? null,
        call: null,
        action: "manual-review",
        original: match[0],
        fields: null,
        reason: payload.reason,
      });
      cursor = end;
      continue;
    }

    const callName = typeof payload.value.call === "string" ? payload.value.call : null;
    const fields = payload.value.fields;
    if (!callName || !fields || typeof fields !== "object") {
      result += match[0];
      pushArchiveEntry(archive, {
        direction: "codex->claude",
        rule_id: rule.id ?? null,
        call: callName,
        action: "manual-review",
        original: match[0],
        fields: fields ?? null,
        reason: "marker payload missing call or fields",
      });
      cursor = end;
      continue;
    }

    if (rule.claude_call && callName !== rule.claude_call) {
      result += match[0];
      cursor = end;
      continue;
    }

    const reconstruction = `${callName}(${formatObjectLiteral(fields)})`;
    result += reconstruction;
    pushArchiveEntry(archive, {
      direction: "codex->claude",
      rule_id: rule.id ?? null,
      call: callName,
      action: "restored",
      original: match[0],
      fields,
      reason: null,
    });
    cursor = end;
  }

  result += text.slice(cursor);
  return result;
}

function findCallStart(text, callName, fromIndex) {
  const escaped = escapeRegExp(callName);
  const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${escaped}\\s*\\(`, "g");
  pattern.lastIndex = fromIndex;
  const match = pattern.exec(text);
  if (!match) return -1;
  return match.index + match[1].length;
}

function findMatchingClose(text, openParen) {
  const length = text.length;
  let depth = 0;
  let index = openParen;

  while (index < length) {
    const ch = text[index];

    if (ch === '"' || ch === "'" || ch === "`") {
      index = skipStringLiteral(text, index);
      if (index === -1) return -1;
      continue;
    }

    if (ch === "(" || ch === "{" || ch === "[") {
      depth += 1;
      index += 1;
      continue;
    }

    if (ch === ")" || ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0 && ch === ")") return index;
      if (depth < 0) return -1;
      index += 1;
      continue;
    }

    index += 1;
  }

  return -1;
}

function skipStringLiteral(text, start) {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    const ch = text[index];
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (ch === quote) return index + 1;
    index += 1;
  }
  return -1;
}

function parseSingleObjectArgument(argText) {
  const trimmed = argText.trim();

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const reader = { text: trimmed, index: 0 };
    const value = readObjectLiteral(reader);
    if (!value.ok) return value;
    skipWhitespace(reader);
    if (reader.index !== reader.text.length) {
      return { ok: false, reason: "extra tokens after object literal" };
    }
    return { ok: true, fields: value.value };
  }

  // Flat named-args form — Agent( description: ..., model: ..., prompt: ... ).
  // Wrap in synthetic braces and reparse with the same strict reader so only
  // genuine key:value lists succeed.
  const wrappedReader = { text: `{${trimmed}}`, index: 0 };
  const wrapped = readObjectLiteral(wrappedReader);
  if (wrapped.ok) {
    skipWhitespace(wrappedReader);
    if (wrappedReader.index === wrappedReader.text.length) {
      return { ok: true, fields: wrapped.value };
    }
  }

  return { ok: false, reason: "argument is not a single object literal" };
}

function readValue(reader) {
  skipWhitespace(reader);
  const ch = reader.text[reader.index];
  if (ch === undefined) return { ok: false, reason: "unexpected end of value" };
  if (ch === "{") return readObjectLiteral(reader);
  if (ch === "[") return readArrayLiteral(reader);
  if (ch === '"' || ch === "'" || ch === "`") return readStringLiteral(reader);
  if (ch === "-" || (ch >= "0" && ch <= "9")) return readNumberLiteral(reader);
  if (matchKeyword(reader, "true")) return { ok: true, value: true };
  if (matchKeyword(reader, "false")) return { ok: true, value: false };
  if (matchKeyword(reader, "null")) return { ok: true, value: null };
  return { ok: false, reason: `unsupported value token at offset ${reader.index}` };
}

function readObjectLiteral(reader) {
  if (reader.text[reader.index] !== "{") {
    return { ok: false, reason: "expected '{'" };
  }
  reader.index += 1;
  const fields = {};

  while (true) {
    skipWhitespace(reader);
    const ch = reader.text[reader.index];
    if (ch === undefined) return { ok: false, reason: "unterminated object literal" };
    if (ch === "}") {
      reader.index += 1;
      return { ok: true, value: fields };
    }

    const key = readObjectKey(reader);
    if (!key.ok) return key;

    skipWhitespace(reader);
    if (reader.text[reader.index] !== ":") {
      return { ok: false, reason: "expected ':' after object key" };
    }
    reader.index += 1;

    const value = readValue(reader);
    if (!value.ok) return value;
    fields[key.value] = value.value;

    skipWhitespace(reader);
    const next = reader.text[reader.index];
    if (next === ",") {
      reader.index += 1;
      continue;
    }
    if (next === "}") {
      reader.index += 1;
      return { ok: true, value: fields };
    }
    return { ok: false, reason: "expected ',' or '}' in object literal" };
  }
}

function readArrayLiteral(reader) {
  if (reader.text[reader.index] !== "[") {
    return { ok: false, reason: "expected '['" };
  }
  reader.index += 1;
  const items = [];

  while (true) {
    skipWhitespace(reader);
    const ch = reader.text[reader.index];
    if (ch === undefined) return { ok: false, reason: "unterminated array literal" };
    if (ch === "]") {
      reader.index += 1;
      return { ok: true, value: items };
    }

    const value = readValue(reader);
    if (!value.ok) return value;
    items.push(value.value);

    skipWhitespace(reader);
    const next = reader.text[reader.index];
    if (next === ",") {
      reader.index += 1;
      continue;
    }
    if (next === "]") {
      reader.index += 1;
      return { ok: true, value: items };
    }
    return { ok: false, reason: "expected ',' or ']' in array literal" };
  }
}

function readObjectKey(reader) {
  skipWhitespace(reader);
  const ch = reader.text[reader.index];
  if (ch === '"' || ch === "'" || ch === "`") {
    const value = readStringLiteral(reader);
    return value;
  }
  const start = reader.index;
  while (reader.index < reader.text.length) {
    const c = reader.text[reader.index];
    if (
      (c >= "A" && c <= "Z") ||
      (c >= "a" && c <= "z") ||
      (c >= "0" && c <= "9") ||
      c === "_" ||
      c === "$"
    ) {
      reader.index += 1;
    } else {
      break;
    }
  }
  if (reader.index === start) {
    return { ok: false, reason: `expected object key at offset ${start}` };
  }
  return { ok: true, value: reader.text.slice(start, reader.index) };
}

function readStringLiteral(reader) {
  const quote = reader.text[reader.index];
  if (quote !== '"' && quote !== "'" && quote !== "`") {
    return { ok: false, reason: "expected string quote" };
  }
  let index = reader.index + 1;
  let result = "";
  while (index < reader.text.length) {
    const ch = reader.text[index];
    if (ch === "\\") {
      const next = reader.text[index + 1];
      if (next === undefined) return { ok: false, reason: "dangling escape in string literal" };
      result += unescapeChar(next);
      index += 2;
      continue;
    }
    if (quote === "`" && ch === "$" && reader.text[index + 1] === "{") {
      return { ok: false, reason: "template literal interpolation is not supported" };
    }
    if (ch === quote) {
      reader.index = index + 1;
      return { ok: true, value: result };
    }
    result += ch;
    index += 1;
  }
  return { ok: false, reason: "unterminated string literal" };
}

function unescapeChar(ch) {
  if (ch === "n") return "\n";
  if (ch === "r") return "\r";
  if (ch === "t") return "\t";
  if (ch === "b") return "\b";
  if (ch === "f") return "\f";
  if (ch === "0") return "\0";
  return ch;
}

function readNumberLiteral(reader) {
  const start = reader.index;
  if (reader.text[reader.index] === "-") reader.index += 1;
  while (reader.index < reader.text.length) {
    const ch = reader.text[reader.index];
    if (
      (ch >= "0" && ch <= "9") ||
      ch === "." ||
      ch === "e" ||
      ch === "E" ||
      ch === "+" ||
      ch === "-"
    ) {
      reader.index += 1;
    } else {
      break;
    }
  }
  const slice = reader.text.slice(start, reader.index);
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(slice)) {
    return { ok: false, reason: `invalid number literal '${slice}'` };
  }
  return { ok: true, value: Number(slice) };
}

function matchKeyword(reader, keyword) {
  if (reader.text.slice(reader.index, reader.index + keyword.length) !== keyword) return false;
  const next = reader.text[reader.index + keyword.length];
  if (next !== undefined && /[A-Za-z0-9_$]/.test(next)) return false;
  reader.index += keyword.length;
  return true;
}

function skipWhitespace(reader) {
  while (reader.index < reader.text.length && /\s/.test(reader.text[reader.index])) {
    reader.index += 1;
  }
}

function renameFieldKeys(fields, aliases) {
  if (!fields || typeof fields !== "object" || !aliases) return { ...fields };
  const renamed = {};
  for (const key of Object.keys(fields)) {
    const aliasKey = typeof aliases[key] === "string" ? aliases[key] : key;
    renamed[aliasKey] = fields[key];
  }
  return renamed;
}

function renderCodexTemplate(template, fields) {
  if (typeof template !== "string") return "";
  // {{#each FIELD}}...{{/each}} expands once per entry against an array field, with the
  // inner template rendered against the entry as its own fields. Needed for TeamCreate's
  // `members: [...]` array, which fans out to one spawn_agent prose block per member.
  const fieldsObj = fields ?? {};
  const eachExpanded = template.replace(
    /\{\{#each\s+([A-Za-z_][A-Za-z0-9_]*)\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_, key, inner) => {
      const list = fieldsObj[key];
      if (!Array.isArray(list)) return "";
      return list.map((entry) => renderCodexTemplate(inner, entry ?? {})).join("");
    }
  );
  return eachExpanded.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, key) => {
    const value = fieldsObj[key];
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function formatObjectLiteral(fields) {
  const keys = Object.keys(fields ?? {});
  const parts = keys.map((key) => `${formatObjectKey(key)}: ${formatObjectValue(fields[key])}`);
  return `{ ${parts.join(", ")} }`;
}

function formatObjectKey(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function formatObjectValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function emitManualReviewComment(callName, reason) {
  const safeReason = String(reason ?? "")
    .replace(/-->/g, "--&gt;")
    .replace(/"/g, "'");
  return `<!-- ai-config-sync:manual-review reason="cannot parse ${callName} arguments: ${safeReason}" -->`;
}

function parseMarkerPayload(jsonText) {
  try {
    const value = JSON.parse(jsonText);
    if (value && typeof value === "object") return { ok: true, value };
    return { ok: false, reason: "marker payload is not an object" };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "marker JSON parse error",
    };
  }
}

function findReverseProseBlockEnd(text, markerEnd, marker, rule, fields) {
  const renderedProse = renderCodexTemplate(rule?.codex_template, fields ?? {});
  if (renderedProse) {
    const proseStart = consumeLeadingNewline(text, markerEnd);
    if (text.startsWith(renderedProse, proseStart)) {
      return proseStart + renderedProse.length;
    }
  }

  const escaped = escapeRegExp(marker);
  const nextMarkerMatch = text.slice(markerEnd).match(new RegExp(`<!--\\s*${escaped}`));
  if (nextMarkerMatch) return markerEnd + nextMarkerMatch.index;

  return -1;
}

function consumeLeadingNewline(text, index) {
  if (text[index] === "\n") return index + 1;
  if (text[index] === "\r" && text[index + 1] === "\n") return index + 2;
  return index;
}

function pushArchiveEntry(archive, entry) {
  if (!Array.isArray(archive)) return;
  archive.push(entry);
}

function applyTargetTemplates(value, from, to) {
  const text = String(value ?? "");
  if (!text || from === to) return text;

  const { data } = targetTemplateSource();
  const templates = targetTemplates(data);
  const replacements = [];

  for (const template of templates) {
    const aliases = Array.isArray(template?.aliases?.[from])
      ? template.aliases[from].filter((item) => typeof item === "string" && item)
      : [];
    const target = template?.target?.[to];
    if (aliases.length === 0 || typeof target !== "string" || !target) continue;

    for (const alias of aliases) replacements.push({ source: alias, target });
  }

  replacements.sort((left, right) => right.source.length - left.source.length);
  return replacements.reduce(
    (nextText, { source, target }) =>
      nextText.replace(new RegExp(escapeRegExp(source), "g"), target),
    text
  );
}

function targetTemplates(data) {
  if (Array.isArray(data?.templates)) return data.templates;
  return Array.isArray(data?.workflows) ? data.workflows : [];
}

function applyTermMappings(value, from, to) {
  const text = String(value ?? "");
  if (!text || from === to) return text;

  const { data } = terminologyMapSource();
  const rules = terminologyRules(data);
  const literalReplacements = [];
  let working = text;

  for (const rule of rules) {
    if (rule?.regex) {
      const pattern = rule[`${from}_pattern`];
      const replace = rule[`${to}_replace`];
      if (typeof pattern === "string" && pattern && typeof replace === "string") {
        working = working.replace(new RegExp(pattern, "g"), replace);
      }
      continue;
    }

    const sourceTerms = Array.isArray(rule?.[from])
      ? rule[from].filter((item) => typeof item === "string" && item)
      : [];
    const targetTerms = Array.isArray(rule?.[to])
      ? rule[to].filter((item) => typeof item === "string" && item)
      : [];
    if (sourceTerms.length === 0 || targetTerms.length === 0) continue;

    const target = targetTerms[0];
    for (const source of sourceTerms) literalReplacements.push({ source, target });
  }

  literalReplacements.sort((left, right) => right.source.length - left.source.length);
  return literalReplacements.reduce(
    (nextText, { source, target }) =>
      nextText.replace(new RegExp(escapeRegExp(source), "g"), target),
    working
  );
}

function terminologyRules(data) {
  const layered = Array.isArray(data?.layers)
    ? data.layers.flatMap((layer) => (Array.isArray(layer?.rules) ? layer.rules : []))
    : Array.isArray(data?.rules)
      ? data.rules
      : [];
  return [...modelTerminologyRules(), ...layered];
}

function toLabel(host) {
  return host === "claude" ? "Claude" : "Codex";
}

function fromLabel(host) {
  return toLabel(host);
}

function fileText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function skillChangePreview(
  sourcePath,
  targetPath,
  skillNames,
  from,
  sourceIndex = {},
  entry = null,
  ignoreRules = []
) {
  const lines = [];
  const to = from === "claude" ? "codex" : "claude";
  for (const skillName of skillNames) {
    const sourceDir = sourceIndex[skillName] ?? sourcePath;
    const sourceRaw = skillPreviewContent(sourceDir, skillName);
    const targetRaw = skillPreviewContent(targetPath, skillName);
    const terms = entry ? entryMaskTerms(entry, skillName, ignoreRules) : [];
    const targetManifest = skillManifestPathFor(targetPath, skillName);
    const sourceManifest = skillManifestPathFor(sourceDir, skillName);
    const overrides = activeManifestOverridesForPair(targetManifest, sourceManifest, to);
    // Two override layouts coexist: flat-prose lines (original mask-before-transform
    // works because the sentinel is inert text) and lines inside structured call
    // bodies like Agent({...prompt: <sentinel>...}) (mask-before-transform breaks
    // applyCallTransforms' parser and degrades to a manual-review marker). Try the
    // original order first; if that produced a parser fallback marker (or any other
    // visible diff), retry with transform-then-mask + post-transform paraphrase so
    // structured-block overrides also collapse to "No line-level preview available."
    const maskedFirst = maskBodiesForHosts(targetRaw, sourceRaw, to, from, overrides);
    const sourceFromMaskFirst = normalizeSkillManifestFrontmatter(
      transformTextForHost(maskedFirst.source, from, to),
      from,
      to,
      { stripHostOnly: true, normalizeModelAlias: true }
    );
    let previewLines = contentChangePreview(
      "Target current",
      maskedFirst.target,
      `After apply from ${fromLabel(from)}`,
      sourceFromMaskFirst,
      terms
    );
    const maskFirstClean =
      previewLines.length === 1 && previewLines[0] === "No line-level preview available.";
    if (overrides.length > 0 && !maskFirstClean) {
      let transformed = normalizeSkillManifestFrontmatter(
        transformTextForHost(sourceRaw, from, to),
        from,
        to,
        { stripHostOnly: true, normalizeModelAlias: true }
      );
      transformed = applyOverrideParaphrasesAtTargetLines(
        transformed,
        sourceManifest ?? "",
        targetManifest ?? "",
        from,
        to
      );
      const maskedSecond = maskBodiesForHosts(targetRaw, transformed, to, to, overrides);
      const fallbackLines = contentChangePreview(
        "Target current",
        maskedSecond.target,
        `After apply from ${fromLabel(from)}`,
        maskedSecond.source,
        terms
      );
      if (fallbackLines.length === 1 && fallbackLines[0] === "No line-level preview available.") {
        previewLines = fallbackLines;
      }
    }
    lines.push(`${skillName}: target will be replaced from ${fromLabel(from)}`);
    lines.push(...previewLines.map((line) => `  ${line}`));
  }
  return lines;
}

function skillPreviewContent(basePath, skillName) {
  const skillPath = join(basePath, skillName);
  const manifest = findSkillManifest(skillPath);
  if (manifest) return readFileSync(manifest, "utf8");
  if (existsSync(skillPath) && !lstatSync(skillPath).isDirectory())
    return readFileSync(skillPath, "utf8");
  return "";
}

// Iterate every file in a skill directory pair (manifest + references/* + …) so
// preview can surface diffs that live outside the manifest. Each file is hashed
// against its counterpart with the same masking pipeline used by skillDirsEquivalent
// so override-masked manifest lines stay invisible while raw differences in
// references/foo.md still render. Falls back to the legacy single-line message
// only when every file pair is equivalent or one side is missing.
function skillDirChangePreview(claudeSkillDir, codexSkillDir, from, to, fromLabel, toLabel, terms) {
  const targetDir = to === "claude" ? claudeSkillDir : codexSkillDir;
  const sourceDir = from === "claude" ? claudeSkillDir : codexSkillDir;
  const targetHost = to;
  const sourceHost = from;
  const PREVIEW_LINE_CAP = 30;

  const targetFiles = sortedSkillFiles(targetDir);
  const sourceFiles = sortedSkillFiles(sourceDir);
  const targetByNormalized = new Map(targetFiles.map((entry) => [entry.normalized, entry]));
  const sourceByNormalized = new Map(sourceFiles.map((entry) => [entry.normalized, entry]));
  const allNormalized = uniqueStrings([
    ...targetFiles.map((entry) => entry.normalized),
    ...sourceFiles.map((entry) => entry.normalized),
  ]).sort();

  const lines = [];
  let truncated = false;

  for (const normalized of allNormalized) {
    if (lines.length >= PREVIEW_LINE_CAP) {
      truncated = true;
      break;
    }

    const targetEntry = targetByNormalized.get(normalized);
    const sourceEntry = sourceByNormalized.get(normalized);
    const displayName = targetEntry?.raw ?? sourceEntry?.raw ?? normalized;

    if (!targetEntry) {
      lines.push(`${displayName}: only on ${fromLabel}`);
      continue;
    }
    if (!sourceEntry) {
      lines.push(`${displayName}: only on ${toLabel}`);
      continue;
    }

    const targetAbs = join(targetDir, targetEntry.raw);
    const sourceAbs = join(sourceDir, sourceEntry.raw);
    const overrides = activeManifestOverridesForPair(targetAbs, sourceAbs, targetHost);
    const targetContent = (
      overrides.length > 0
        ? readSkillFileMaskedForHash(targetDir, targetEntry.raw, targetHost, overrides)
        : readSkillFileForHash(targetDir, targetEntry.raw)
    ).toString("utf8");
    let sourceContent = (
      overrides.length > 0
        ? readSkillFileMaskedForHash(sourceDir, sourceEntry.raw, sourceHost, overrides)
        : readSkillFileForHash(sourceDir, sourceEntry.raw)
    ).toString("utf8");
    if (isTextMappingFile(sourceAbs) && isTextMappingFile(targetAbs)) {
      sourceContent = normalizeSkillFileText(
        transformTextForHost(sourceContent, sourceHost, targetHost),
        sourceEntry.raw,
        sourceAbs
      );
    }

    if (targetContent === sourceContent) continue;

    const fileChanges = contentChangePreview(
      `${toLabel} current`,
      targetContent,
      `After apply from ${fromLabel}`,
      sourceContent,
      terms
    );
    if (fileChanges.length === 1 && fileChanges[0] === "No line-level preview available.") continue;

    lines.push(`${displayName}:`);
    for (const line of fileChanges) {
      lines.push(`  ${line}`);
      if (lines.length >= PREVIEW_LINE_CAP) {
        truncated = true;
        break;
      }
    }
  }

  if (truncated) lines.push("... additional file diffs not shown");
  if (lines.length === 0) return ["No line-level preview available."];
  return lines;
}

function agentChangePreview(
  sourceDir,
  targetDir,
  agentNames,
  from,
  to,
  claudeAgentPaths = {},
  codexAgentPaths = {},
  entry = null,
  ignoreRules = []
) {
  const lines = [];
  const sourcePaths = from === "claude" ? claudeAgentPaths : codexAgentPaths;
  const targetPaths = to === "claude" ? claudeAgentPaths : codexAgentPaths;
  for (const agentName of agentNames) {
    lines.push(`${agentName}: target will be replaced from ${fromLabel(from)}`);
    const targetContent =
      agentPreviewContentFromPath(targetPaths[agentName], to) ||
      agentPreviewContent(targetDir, agentName, to);
    const sourceRaw =
      agentPreviewContentFromPath(sourcePaths[agentName], from) ||
      agentPreviewContent(sourceDir, agentName, from);
    const transformedSource =
      from === "claude"
        ? transformTextForHost(sourceRaw, "claude", "codex")
        : transformTextForHost(stripAgentMigrationPreamble(sourceRaw), "codex", "claude");
    const terms = entry ? entryMaskTerms(entry, agentName, ignoreRules) : [];
    const overrides = activeManifestOverridesForPair(
      targetPaths[agentName],
      sourcePaths[agentName],
      to
    );
    const masked = maskBodiesForHosts(targetContent, transformedSource, to, from, overrides);
    lines.push(
      ...contentChangePreview(
        "Target current",
        masked.target,
        `After apply from ${fromLabel(from)}`,
        masked.source,
        terms
      ).map((line) => `  ${line}`)
    );
  }
  return lines;
}

function agentPreviewContentFromPath(path, host) {
  if (!path || !existsSync(path)) return "";
  if (host === "claude") {
    return parseClaudeAgentFile(path).body ?? "";
  }
  return parseCodexAgentFile(path).developer_instructions ?? "";
}

function agentPreviewContent(baseDir, agentName, host) {
  if (!baseDir) return "";
  if (host === "claude") {
    const direct = join(baseDir, `${agentName}.md`);
    if (existsSync(direct)) {
      const parsed = parseClaudeAgentText(readFileSync(direct, "utf8"));
      return parsed.body;
    }
    // Fallback for folder-grouped layouts (e.g. baseDir/group/agentName.md). Match by
    // canonical frontmatter name to handle the case where the file stem differs from
    // the canonical agent name.
    if (existsSync(baseDir)) {
      for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const groupDir = join(baseDir, entry.name);
        const guess = join(groupDir, `${agentName}.md`);
        if (existsSync(guess)) {
          return parseClaudeAgentFile(guess).body ?? "";
        }
        for (const child of readdirSync(groupDir, { withFileTypes: true })) {
          if (!child.isFile() || !child.name.endsWith(".md")) continue;
          const childPath = join(groupDir, child.name);
          const stem = child.name.slice(0, -3);
          const parsed = parseClaudeAgentFile(childPath);
          const canonical = canonicalAgentName(parsed.frontmatter?.name, stem);
          if (canonical === agentName) return parsed.body ?? "";
        }
      }
    }
    return "";
  }

  const flatName = agentName.includes("/") ? agentName.split("/").pop() : agentName;
  const tomlPath = join(baseDir, `${flatName}.toml`);
  if (!existsSync(tomlPath)) return "";
  return parseCodexAgentText(readFileSync(tomlPath, "utf8")).developer_instructions ?? "";
}

function copySkillWithMappings(source, target, from, to, options = {}) {
  if (!existsSync(source)) return;

  const stat = lstatSync(source);
  if (!stat.isDirectory()) {
    copyFileWithMappings(source, target, from, to, options);
    return;
  }

  copySkillTreeWithMappings(source, target, from, to, options);
  normalizeSkillManifestCasing(target, to);
}

function copySkillTreeWithMappings(source, target, from, to, options) {
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    const sourcePath = join(source, name);
    const targetPath = join(target, name);
    if (lstatSync(sourcePath).isDirectory()) {
      copySkillTreeWithMappings(sourcePath, targetPath, from, to, options);
    } else {
      copyFileWithMappings(sourcePath, targetPath, from, to, options);
    }
  }
}

// After copying a skill directory, rename the manifest (SKILL.md/skill.md) to match
// the destination host's canonical casing. Skills written with the wrong casing
// would not be discovered by the destination host's loader. Uses readdirSync to read
// actual entry names because existsSync case-folds on case-insensitive filesystems.
//
// On case-insensitive filesystems (APFS default, NTFS), renameSync(skill.md, SKILL.md)
// is a no-op — the FS treats both paths as the same inode, so the on-disk casing is
// preserved and the wrong-cased file remains. To force the case change we read the
// wrong-cased manifest into memory, delete it, then write the canonical name. This
// sidesteps FS case-sensitivity entirely and works on both APFS and ext4.
function normalizeSkillManifestCasing(skillDir, host) {
  if (!existsSync(skillDir)) return;
  const canonical = skillManifestBasename(host);
  const wrong = canonical === "SKILL.md" ? "skill.md" : "SKILL.md";

  const entries = readdirSync(skillDir);
  const hasCanonical = entries.includes(canonical);
  const hasWrong = entries.includes(wrong);
  if (!hasWrong) return;

  const wrongPath = join(skillDir, wrong);
  const canonicalPath = join(skillDir, canonical);

  if (hasCanonical) {
    // Both casings present as distinct entries (only possible on case-sensitive FS).
    // Drop the wrong-cased one to avoid duplicate manifests.
    rmSync(wrongPath, { force: true });
    return;
  }

  // Read body, delete original, write under canonical name. On case-insensitive FS,
  // the delete + write pair forces the on-disk entry to be replaced with the new
  // casing. On case-sensitive FS, this is equivalent to a rename.
  const body = readFileSync(wrongPath);
  rmSync(wrongPath, { force: true });
  writeFileSync(canonicalPath, body);
}

function copyFileWithMappings(source, target, from, to, options = {}) {
  mkdirSync(dirname(target), { recursive: true });
  if (isTextMappingFile(source)) {
    let text = transformTextForHost(readFileSync(source, "utf8"), from, to, options);
    text = applyOverrideParaphrasesAtTargetLines(text, source, target, from, to);
    recordVocabFindings(options?.callArchive, lintHostVocab(text, to), from, to);
    const sourceBasename = source.split("/").pop();
    if (isSkillManifestBasename(sourceBasename)) {
      text = normalizeSkillManifestFrontmatter(text, from, to, { normalizeModelAlias: true });
    }
    writeFileSync(target, text);
  } else {
    copyFileSync(source, target);
  }
}

// Reapply paraphrase override tokens after transformTextForHost so an override
// pinned to a specific target line (e.g. codex L58 `Review .codex/...`) is
// preserved across sync. Without this, transformTextForHost emits the un-paraphrased
// form (`Read .codex/...`) and writes that to disk, silently invalidating the
// override on the next status pass. Operates only on the target-host line numbers
// recorded in the override entry and applies each entry's token substitutions
// scoped to that single line so unrelated occurrences are not rewritten.
function applyOverrideParaphrasesAtTargetLines(
  text,
  sourcePath,
  targetPath,
  sourceHost,
  targetHost
) {
  const overrides = activeManifestOverridesForPair(targetPath, sourcePath, targetHost);
  if (!Array.isArray(overrides) || overrides.length === 0) return text;
  const lineKey = targetHost === "claude" ? "claude_line" : "codex_line";
  const lines = text.split(/\r?\n/);
  let mutated = false;
  for (const entry of overrides) {
    const lineNumber = entry?.[lineKey];
    if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > lines.length) continue;
    const tokens = Array.isArray(entry?.tokens) ? entry.tokens : [];
    if (tokens.length === 0) continue;
    const idx = lineNumber - 1;
    let line = lines[idx];
    let lineChanged = false;
    for (const t of tokens) {
      if (typeof t?.token !== "string" || !t.token) continue;
      if (typeof t?.paraphrase !== "string" || !t.paraphrase) continue;
      const re = new RegExp(`\\b${escapeRegExp(t.token)}\\b`, "g");
      if (!re.test(line)) continue;
      line = line.replace(new RegExp(`\\b${escapeRegExp(t.token)}\\b`, "g"), t.paraphrase);
      lineChanged = true;
    }
    if (lineChanged) {
      lines[idx] = line;
      mutated = true;
    }
  }
  return mutated ? lines.join("\n") : text;
}

// Re-serialize YAML frontmatter through the tolerant parser + quoting-aware serializer.
// Skill manifests authored against Claude's lenient loader can contain unquoted scalars
// with embedded `: ` (e.g. `description: First sentence. bias warning: edge case.`).
// YAML 1.2 strict parsers (Codex's loader) reject those. Reusing the existing helpers
// guarantees the destination's frontmatter is 1.2-compliant without changing parse or
// serialize behavior — only their application site.
function normalizeSkillManifestFrontmatter(text, from, to, options = {}) {
  if (!text.startsWith("---")) return text;
  const closing = text.indexOf("\n---", 3);
  if (closing === -1) return text;
  const { frontmatter, body } = parseClaudeAgentText(text);
  const stripHostOnly = options.stripHostOnly === true;
  if (stripHostOnly || (from === "codex" && to === "claude")) {
    for (const key of ["model_reasoning_effort", "model_thinking budget", "sandbox_mode"]) {
      delete frontmatter[key];
    }
  }
  if (options.normalizeModelAlias === true && typeof frontmatter.model === "string") {
    // Fallback to codex→claude when from/to are empty (called from normalizeYamlFrontmatter
    // for status-side equivalence comparison, where direction is unknown).
    const aliases = from && to ? modelAliasMap(from, to) : modelAliasMap("codex", "claude");
    if (aliases[frontmatter.model]) {
      frontmatter.model = aliases[frontmatter.model];
    }
  }
  return serializeClaudeAgentFile(frontmatter, body);
}

function normalizeYamlFrontmatter(text) {
  return normalizeSkillManifestFrontmatter(text, "", "", {
    stripHostOnly: true,
    normalizeModelAlias: true,
  });
}

function isTextMappingFile(path) {
  return /\.(md|mdx|txt|json|toml|yaml|yml|js|mjs|ts|tsx|jsx|py|sh|rules)$/i.test(path);
}

function contentChangePreview(beforeLabel, before, afterLabel, after, terms) {
  const beforeLines = previewLines(before);
  const afterLines = previewLines(after);
  const maxLines = Math.max(beforeLines.length, afterLines.length);
  const expandedTerms =
    Array.isArray(terms) && terms.length > 0 ? expandTermsBothDirections(terms) : [];
  const changes = [];

  for (let index = 0; index < maxLines; index += 1) {
    if (beforeLines[index] === afterLines[index]) continue;
    if (linesEquivalentForPreview(beforeLines[index], afterLines[index])) continue;
    if (
      expandedTerms.length > 0 &&
      lineContainsAnyTerm(beforeLines[index], expandedTerms) &&
      lineContainsAnyTerm(afterLines[index], expandedTerms)
    )
      continue;
    const pair = previewLinePair(beforeLines[index], afterLines[index]);
    changes.push(`- ${beforeLabel} L${index + 1}: ${pair.before}`);
    changes.push(`+ ${afterLabel} L${index + 1}: ${pair.after}`);
    if (changes.length >= 12) {
      changes.push(`... ${Math.max(0, maxLines - index - 1)} more line(s) not shown`);
      break;
    }
  }

  return changes.length > 0 ? changes : ["No line-level preview available."];
}

function linesEquivalentForPreview(before, after) {
  if (typeof before !== "string" || typeof after !== "string") return false;
  return normalizeComparableAgentPaths(before) === normalizeComparableAgentPaths(after);
}

function previewLines(value) {
  const lines = String(value ?? "").split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function previewLine(value) {
  if (value === undefined) return "<missing>";
  if (value === "") return "<blank>";
  return value.length > 140 ? `${value.slice(0, 137)}...` : value;
}

// Diff-aware truncation for paired before/after lines. Both windows share the
// same focus index (first divergence) so the visible slices stay column-aligned
// and the actual diff cannot scroll off the right edge of long lines.
function previewLinePair(before, after, maxWidth = 140) {
  if (before === undefined || after === undefined) {
    return { before: previewLine(before), after: previewLine(after) };
  }
  if (before === "" || after === "") {
    return { before: previewLine(before), after: previewLine(after) };
  }
  if (before.length <= maxWidth && after.length <= maxWidth) {
    return { before, after };
  }

  const minLen = Math.min(before.length, after.length);
  let focus = -1;
  for (let i = 0; i < minLen; i += 1) {
    if (before[i] !== after[i]) {
      focus = i;
      break;
    }
  }
  if (focus === -1) focus = minLen;

  return {
    before: windowAroundFocus(before, focus, maxWidth),
    after: windowAroundFocus(after, focus, maxWidth),
  };
}

function windowAroundFocus(text, focus, maxWidth) {
  if (text.length <= maxWidth) return text;
  const inner = maxWidth - 6;
  const half = Math.floor(inner / 2);
  let start = Math.max(0, focus - half);
  let end = Math.min(text.length, start + inner);
  start = Math.max(0, end - inner);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function lineContainsAnyTerm(line, terms) {
  if (typeof line !== "string") return false;
  return terms.some((term) => term && line.includes(term));
}

function applySyncPlan(plan) {
  pruneRetention(`${home}/.ai-config-sync-manager/backups`, BACKUP_RETENTION - 1);
  mkdirSync(plan.backupRoot, { recursive: true });
  plan.writesStarted = true;

  for (const operation of plan.operations) {
    if (operation.approvalRequired) {
      const message = `${operation.scope}/${operation.area} requires explicit approval`;
      plan.results.push({ status: "skipped", message });
      recordLedger(plan, {
        area: operation.area,
        item: operation.area,
        action: operation.action,
        status: "skipped",
        message,
      });
      continue;
    }

    try {
      if (operation.action === "copy-file") {
        applyCopyFile(plan, operation);
      } else if (operation.action === "write-instructions") {
        applyWriteInstructions(plan, operation);
      } else if (operation.action === "copy-missing-skills") {
        applyCopyMissingSkills(plan, operation);
      } else if (operation.action === "merge-agents") {
        applyMergeAgents(plan, operation);
      } else if (operation.action === "merge-settings-items") {
        applyMergeSettingsItems(plan, operation);
      } else if (operation.action === "merge-mcp-servers") {
        applyMergeMcpServers(plan, operation);
      } else if (operation.action === "delete-items") {
        applyDeleteItems(plan, operation);
      } else {
        const message = `${operation.scope}/${operation.area} action ${operation.action} is not implemented`;
        plan.results.push({ status: "skipped", message });
        recordLedger(plan, {
          area: operation.area,
          item: operation.area,
          action: operation.action,
          status: "skipped",
          message,
        });
      }
    } catch (error) {
      const message = `${operation.scope}/${operation.area}: ${error instanceof Error ? error.message : "unknown error"}`;
      plan.results.push({ status: "error", message });
      recordLedger(plan, {
        area: operation.area,
        item: operation.area,
        action: operation.action,
        status: "error",
        message,
      });
    }
  }

  applyVocabFixes(plan);

  if (plan.results.length === 0) {
    plan.results.push({ status: "noop", message: "No operations to apply" });
  }

  writeCallArchive(plan);

  if (plan.results.every((result) => result.status === "applied" || result.status === "noop")) {
    writeSyncState(plan.scope);
  }
}

function applyVocabFixes(plan) {
  const findings = filterVocabFindings(
    lintScopeForVocab(plan.scope),
    plan.selectors,
    plan.ignoreRules ?? []
  );
  const fixable = findings.filter((f) => f.recommended);
  if (fixable.length === 0) return;

  const byPath = new Map();
  for (const f of fixable) {
    if (!byPath.has(f.path)) byPath.set(f.path, { fileHost: f.host, items: [] });
    byPath.get(f.path).items.push(f);
  }

  for (const [path, info] of byPath) {
    if (!existsSync(path)) continue;
    const original = readFileSync(path, "utf8");
    const nativeHost = info.fileHost === "claude" ? "codex" : "claude";
    const updated = applyTermMappings(original, nativeHost, info.fileHost);
    if (updated === original) continue;
    const beforeHash = hashPath(path);
    const backupPathTaken = backupTargetPath(plan, path);
    backupPath(plan, path);
    writeFileSync(path, updated);
    const message = `vocab-fix: rewrote ${info.items.length} token(s) in ${path}`;
    plan.results.push({ status: "applied", message });
    recordLedger(plan, {
      area: "vocab",
      item: path,
      action: "vocab-fix",
      status: "applied",
      target: path,
      beforeHash,
      backupPath: backupPathTaken,
      message,
    });
  }
}

function writeCallArchive(plan) {
  if (!Array.isArray(plan.callArchive) || plan.callArchive.length === 0) return;
  mkdirSync(dirname(plan.callArchivePath), { recursive: true });
  writeFileSync(plan.callArchivePath, `${JSON.stringify(plan.callArchive, null, 2)}\n`);
}

function planIntentHash(plan) {
  const intent = (plan.operations ?? []).map((operation) => ({
    scope: operation.scope,
    area: operation.area,
    action: operation.action,
    from: operation.from,
    to: operation.to,
    itemNames: operation.itemNames ?? null,
    skillNames: operation.skillNames ?? null,
    agentNames: operation.agentNames ?? null,
    serverNames: operation.serverNames ?? null,
    targetPath: operation.targetPath ?? null,
  }));
  return `sha256:${createHash("sha256").update(JSON.stringify(intent)).digest("hex")}`;
}

function buildLedger(plan) {
  const items = plan.ledger ?? [];
  const summary = { applied: 0, skipped: 0, error: 0, noop: 0 };
  for (const item of items) {
    if (item.status in summary) summary[item.status] += 1;
  }
  return {
    plan_hash: planIntentHash(plan),
    mode: plan.mode,
    scope: plan.scope,
    writes_started: Boolean(plan.writesStarted),
    items,
    summary,
  };
}

function emitLedger(plans, options) {
  if (plans.length === 0) return;
  const ledgers = plans.map((plan) => buildLedger(plan));
  const output = ledgers.length === 1 ? ledgers[0] : { ledgers };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  const ledgerDir = `${home}/.ai-config-sync-manager/ledgers`;
  pruneRetention(ledgerDir, LEDGER_RETENTION - 1);
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(ledgerDir, `${basename(plans[0].backupRoot)}.json`), serialized);
  if (options.ledgerPath) {
    const resolved = resolve(expandHome(options.ledgerPath));
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, serialized);
  }
  if (options.ledgerJson) {
    process.stdout.write(serialized);
  }
}

function applyCopyFile(plan, operation) {
  if (!existsSync(operation.sourcePath)) {
    const message = `source missing: ${operation.sourcePath}`;
    plan.results.push({ status: "skipped", message });
    recordLedger(plan, {
      area: operation.area,
      item: operation.targetPath,
      action: operation.action,
      status: "skipped",
      message,
    });
    return;
  }

  mkdirSync(dirname(operation.targetPath), { recursive: true });
  const beforeHash = hashPath(operation.targetPath);
  const backupPathTaken = backupTargetPath(plan, operation.targetPath);
  backupPath(plan, operation.targetPath);
  copyFileSync(operation.sourcePath, operation.targetPath);
  const message = `copied ${operation.sourcePath} -> ${operation.targetPath}`;
  plan.results.push({ status: "applied", message });
  recordLedger(plan, {
    area: operation.area,
    item: operation.targetPath,
    action: operation.action,
    status: "applied",
    target: operation.targetPath,
    beforeHash,
    backupPath: backupPathTaken,
    message,
  });
}

function applyWriteInstructions(plan, operation) {
  mkdirSync(dirname(operation.targetPath), { recursive: true });
  const beforeHash = hashPath(operation.targetPath);
  const backupPathTaken = backupTargetPath(plan, operation.targetPath);
  backupPath(plan, operation.targetPath);
  writeFileSync(
    operation.targetPath,
    operation.content.endsWith("\n") ? operation.content : `${operation.content}\n`
  );
  const message = `wrote instructions ${operation.sourcePath} -> ${operation.targetPath}`;
  plan.results.push({ status: "applied", message });
  recordLedger(plan, {
    area: operation.area,
    item: operation.targetPath,
    action: operation.action,
    status: "applied",
    target: operation.targetPath,
    beforeHash,
    backupPath: backupPathTaken,
    message,
  });
}

function applyCopyMissingSkills(plan, operation) {
  mkdirSync(operation.targetPath, { recursive: true });
  const overwrite = new Set(operation.overwriteSkillNames ?? []);
  const sourceIndex = operation.skillSourceIndex ?? {};

  for (const skillName of operation.skillNames ?? []) {
    const sourceDir = sourceIndex[skillName] ?? operation.sourcePath;
    const source = join(sourceDir, skillName);
    const target = join(operation.targetPath, skillName);

    if (!existsSync(source)) {
      const message = `skill source missing: ${source}`;
      plan.results.push({ status: "skipped", message });
      recordLedger(plan, {
        area: operation.area,
        item: skillName,
        action: operation.action,
        status: "skipped",
        message,
      });
      continue;
    }

    const beforeHash = hashPath(target);
    let backupPathTaken = null;
    if (existsSync(target)) {
      if (!overwrite.has(skillName)) {
        const message = `skill already exists: ${target}`;
        plan.results.push({ status: "skipped", message });
        recordLedger(plan, {
          area: operation.area,
          item: skillName,
          action: operation.action,
          status: "skipped",
          target,
          beforeHash,
          message,
        });
        continue;
      }
      backupPathTaken = backupTargetPath(plan, target);
      backupPath(plan, target);
      rmSync(target, { recursive: true, force: true });
    }

    copySkillWithMappings(source, target, operation.from, operation.to, {
      callArchive: plan.callArchive,
    });
    const message = `${overwrite.has(skillName) ? "replaced" : "copied"} skill ${skillName}`;
    plan.results.push({ status: "applied", message });
    recordLedger(plan, {
      area: operation.area,
      item: skillName,
      action: operation.action,
      status: "applied",
      target,
      beforeHash,
      backupPath: backupPathTaken,
      message,
    });
  }
}

function applyMergeAgents(plan, operation) {
  mkdirSync(operation.targetPath, { recursive: true });
  const overwrite = new Set(operation.overwriteAgentNames ?? []);
  const sourceClaudeIndex =
    operation.from === "claude"
      ? new Map(enumerateClaudeAgents(operation.sourcePath).map((agent) => [agent.name, agent]))
      : null;
  const sourceCodexIndex =
    operation.from === "codex"
      ? new Map(enumerateCodexAgents(operation.sourcePath).map((agent) => [agent.name, agent]))
      : null;
  const existingClaudeIndex =
    operation.to === "claude"
      ? new Map(enumerateClaudeAgents(operation.targetPath).map((agent) => [agent.name, agent]))
      : null;
  const existingCodexIndex =
    operation.to === "codex"
      ? new Map(enumerateCodexAgents(operation.targetPath).map((agent) => [agent.name, agent]))
      : null;

  for (const agentName of operation.agentNames ?? []) {
    if (operation.to === "codex") {
      const sourceAgent = sourceClaudeIndex?.get(agentName);
      if (!sourceAgent) {
        const message = `agent source missing: ${agentName}`;
        plan.results.push({ status: "skipped", message });
        recordLedger(plan, {
          area: operation.area,
          item: agentName,
          action: operation.action,
          status: "skipped",
          message,
        });
        continue;
      }
      const targetPath = agentTargetPath(agentName, operation.targetPath, "codex", sourceAgent);
      const existingAgent =
        existingCodexIndex?.get(agentName) ??
        existingCodexIndex?.get(sourceAgent.name.split("/").pop());
      if (existingAgent && !overwrite.has(agentName)) {
        const message = `agent already exists: ${targetPath}`;
        plan.results.push({ status: "skipped", message });
        recordLedger(plan, {
          area: operation.area,
          item: agentName,
          action: operation.action,
          status: "skipped",
          target: targetPath,
          beforeHash: hashPath(targetPath),
          message,
        });
        continue;
      }

      const claudeParsed = parseClaudeAgentFile(sourceAgent.path);
      const existingFields = existingAgent ? parseCodexAgentFile(existingAgent.path) : {};
      const codexFields = mapAgentToCodex(claudeParsed, {
        preserveCodex: existingFields,
        fallbackName: agentName.split("/").pop(),
        callArchive: plan.callArchive,
      });
      mkdirSync(dirname(targetPath), { recursive: true });
      const beforeHash = hashPath(existingAgent ? existingAgent.path : targetPath);
      const backupPathTaken = existingAgent ? backupTargetPath(plan, existingAgent.path) : null;
      if (existingAgent) backupPath(plan, existingAgent.path);
      writeFileSync(targetPath, serializeCodexAgentFile(codexFields));
      const message = `${existingAgent ? "replaced" : "copied"} agent ${agentName} -> ${targetPath}`;
      plan.results.push({ status: "applied", message });
      recordLedger(plan, {
        area: operation.area,
        item: agentName,
        action: operation.action,
        status: "applied",
        target: targetPath,
        beforeHash,
        backupPath: backupPathTaken,
        message,
      });
      continue;
    }

    const sourceAgent =
      sourceCodexIndex?.get(agentName) ?? sourceCodexIndex?.get(agentName.split("/").pop());
    if (!sourceAgent) {
      const message = `agent source missing: ${agentName}`;
      plan.results.push({ status: "skipped", message });
      recordLedger(plan, {
        area: operation.area,
        item: agentName,
        action: operation.action,
        status: "skipped",
        message,
      });
      continue;
    }
    const existingAgent = existingClaudeIndex?.get(agentName);
    const targetPath = agentTargetPath(agentName, operation.targetPath, "claude", existingAgent);
    if (existingAgent && !overwrite.has(agentName)) {
      const message = `agent already exists: ${targetPath}`;
      plan.results.push({ status: "skipped", message });
      recordLedger(plan, {
        area: operation.area,
        item: agentName,
        action: operation.action,
        status: "skipped",
        target: targetPath,
        beforeHash: hashPath(targetPath),
        message,
      });
      continue;
    }

    const codexParsed = parseCodexAgentFile(sourceAgent.path);
    const existingClaude = existingAgent
      ? parseClaudeAgentFile(existingAgent.path)
      : { frontmatter: {}, body: "" };
    const claude = mapAgentToClaude(codexParsed, {
      preserveClaude: existingClaude.frontmatter,
      callArchive: plan.callArchive,
    });
    mkdirSync(dirname(targetPath), { recursive: true });
    const beforeHash = hashPath(existingAgent ? existingAgent.path : targetPath);
    const backupPathTaken = existingAgent ? backupTargetPath(plan, existingAgent.path) : null;
    if (existingAgent) backupPath(plan, existingAgent.path);
    writeFileSync(targetPath, serializeClaudeAgentFile(claude.frontmatter, claude.body));
    const message = `${existingAgent ? "replaced" : "copied"} agent ${agentName} -> ${targetPath}`;
    plan.results.push({ status: "applied", message });
    recordLedger(plan, {
      area: operation.area,
      item: agentName,
      action: operation.action,
      status: "applied",
      target: targetPath,
      beforeHash,
      backupPath: backupPathTaken,
      message,
    });
  }
}

function applyMergeSettingsItems(plan, operation) {
  mkdirSync(dirname(operation.targetPath), { recursive: true });
  const beforeHash = hashPath(operation.targetPath);
  const backupPathTaken = backupTargetPath(plan, operation.targetPath);
  backupPath(plan, operation.targetPath);
  if (operation.area === "permissions" && operation.to === "codex") {
    backupPath(plan, codexRulesPath(operation.targetPath));
  }

  if (operation.area === "permissions" && operation.to === "codex") {
    archiveUnsupportedAgentPermissions(plan, operation.itemNames ?? []);
  }

  if (operation.to === "claude") {
    mergeIntoClaudeSettings(
      operation.targetPath,
      operation.sourcePath,
      operation.from,
      operation.area,
      operation.itemNames ?? []
    );
  } else {
    mergeIntoCodexSettings(
      operation.targetPath,
      operation.sourcePath,
      operation.from,
      operation.area,
      operation.itemNames ?? []
    );
  }

  const message = `merged ${operation.area} item(s): ${(operation.itemNames ?? []).join(", ")}`;
  plan.results.push({ status: "applied", message });
  recordLedgerForBatch(plan, operation, operation.itemNames ?? [], {
    status: "applied",
    target: operation.targetPath,
    beforeHash,
    backupPath: backupPathTaken,
    message,
  });
}

// Batch mutations (settings/mcp/delete) touch a single target file for many items;
// emit one ledger entry per item sharing that file's before/after hash.
function recordLedgerForBatch(plan, operation, itemNames, shared) {
  const items = itemNames.length > 0 ? itemNames : [operation.area];
  for (const item of items) {
    recordLedger(plan, {
      area: operation.area,
      item,
      action: operation.action,
      status: shared.status,
      target: shared.target,
      beforeHash: shared.beforeHash,
      backupPath: shared.backupPath,
      message: shared.message,
    });
  }
}

function archiveUnsupportedAgentPermissions(plan, itemNames) {
  for (const itemName of itemNames) {
    const { bucket, value } = parsePermissionItem(itemName);
    if (!isAgentPermission(value)) continue;
    if (bucket === "allow" && value === "Agent") continue;

    pushArchiveEntry(plan.callArchive, {
      direction: "claude->codex",
      rule_id: null,
      call: null,
      action: "unsupported-permission",
      original: itemName,
      fields: { bucket, value },
      reason: "codex has no spawn_agent gate; permission cannot be expressed natively",
    });
  }
}

function applyMergeMcpServers(plan, operation) {
  mkdirSync(dirname(operation.targetPath), { recursive: true });
  const beforeHash = hashPath(operation.targetPath);
  const backupPathTaken = backupTargetPath(plan, operation.targetPath);
  backupPath(plan, operation.targetPath);

  if (operation.to === "codex") {
    mergeMcpIntoCodex(
      operation.targetPath,
      operation.sourceMcpPaths ?? operation.sourcePath,
      operation.from,
      operation.serverNames ?? []
    );
  } else {
    mergeMcpIntoClaude(
      operation.targetPath,
      operation.sourceMcpPaths ?? operation.sourcePath,
      operation.from,
      operation.serverNames ?? []
    );
  }

  const message = `merged MCP servers ${operation.from} -> ${operation.to}: ${(operation.serverNames ?? []).join(", ")}`;
  plan.results.push({ status: "applied", message });
  recordLedgerForBatch(plan, operation, operation.serverNames ?? [], {
    status: "applied",
    target: operation.targetPath,
    beforeHash,
    backupPath: backupPathTaken,
    message,
  });
}

function applyDeleteItems(plan, operation) {
  let deleteBeforeHash = null;
  let deleteBackupPath = null;
  if (operation.area === "skills") {
    deleteSkillItems(plan, operation);
  } else if (operation.area === "agents") {
    deleteAgentItems(plan, operation);
  } else {
    mkdirSync(dirname(operation.targetPath), { recursive: true });
    deleteBeforeHash = hashPath(operation.targetPath);
    deleteBackupPath = backupTargetPath(plan, operation.targetPath);
    backupPath(plan, operation.targetPath);

    if (operation.area === "mcp") {
      if (operation.to === "claude") {
        const claudeTargets = operation.targetMcpPaths ?? [operation.targetPath];
        for (const spec of claudeTargets) {
          const file = claudeMcpSourceFile(spec);
          if (existsSync(file)) backupPath(plan, file);
        }
        deleteClaudeMcpServers(claudeTargets, operation.serverNames ?? []);
      } else {
        deleteCodexMcpServers(operation.targetPath, operation.serverNames ?? []);
      }
    } else if (operation.area === "permissions") {
      if (operation.to === "claude") {
        deleteClaudePermissions(operation.targetPath, operation.itemNames ?? []);
      } else {
        const remainingClaudeItemNames = remainingClaudePermissionItems(operation.sourcePath);
        deleteCodexNativePermissionItems(
          operation.targetPath,
          operation.itemNames ?? [],
          remainingClaudeItemNames
        );
        deleteCodexManagedItems(operation.targetPath, operation.area, operation.itemNames ?? []);
      }
    } else if (operation.area === "hooks") {
      if (operation.to === "claude") {
        deleteClaudeHooks(operation.targetPath, operation.itemNames ?? []);
      } else {
        deleteCodexManagedItems(operation.targetPath, operation.area, operation.itemNames ?? []);
      }
    }
  }

  const pathSummary =
    operation.area === "permissions" && operation.to === "codex"
      ? summarizeCodexPermissionDeletePaths(operation.itemNames ?? [])
      : "";
  const message = `deleted ${operation.area} item(s) from ${operation.to}${pathSummary}: ${(operation.itemNames ?? []).join(", ")}`;
  plan.results.push({ status: "applied", message });

  // skills/agents delete is per-target; those branches record their own ledger entries above.
  if (operation.area !== "skills" && operation.area !== "agents") {
    recordLedgerForBatch(plan, operation, operation.itemNames ?? [], {
      status: "applied",
      target: operation.targetPath,
      beforeHash: deleteBeforeHash,
      backupPath: deleteBackupPath,
      message,
    });
  }
}

function summarizeCodexPermissionDeletePaths(itemNames) {
  let touchesRules = false;
  let touchesConfig = false;
  for (const itemName of itemNames) {
    const { bucket, value } = parsePermissionItem(itemName);
    if (codexPrefixRuleForPermission(bucket, value)) touchesRules = true;
    if (
      parseMcpPermission(value) ||
      ["Write", "Edit", "MultiEdit"].includes(value) ||
      (bucket === "allow" && (value === "WebSearch" || value === "WebFetch"))
    ) {
      touchesConfig = true;
    }
  }
  const paths = [touchesConfig && "config.toml", touchesRules && "rules/default.rules"].filter(
    Boolean
  );
  return paths.length ? ` (${paths.join(" + ")})` : "";
}

function deleteSkillItems(plan, operation) {
  const targetIndex = operation.skillTargetIndex ?? {};
  for (const skillName of operation.skillNames ?? operation.itemNames ?? []) {
    const targetDir = targetIndex[skillName] ?? operation.targetPath;
    const target = join(targetDir, skillName);
    if (!existsSync(target)) continue;
    const beforeHash = hashPath(target);
    const backupPathTaken = backupTargetPath(plan, target);
    backupPath(plan, target);
    rmSync(target, { recursive: true, force: true });
    recordLedger(plan, {
      area: operation.area,
      item: skillName,
      action: operation.action,
      status: "applied",
      target,
      beforeHash,
      backupPath: backupPathTaken,
      message: `deleted skill ${skillName}`,
    });
  }
}

function deleteAgentItems(plan, operation) {
  const targetIndex =
    operation.to === "claude"
      ? new Map(enumerateClaudeAgents(operation.targetPath).map((agent) => [agent.name, agent]))
      : new Map(enumerateCodexAgents(operation.targetPath).map((agent) => [agent.name, agent]));

  for (const agentName of operation.agentNames ?? operation.itemNames ?? []) {
    const existing = targetIndex.get(agentName) ?? targetIndex.get(agentName.split("/").pop());
    if (!existing) continue;
    const beforeHash = hashPath(existing.path);
    const backupPathTaken = backupTargetPath(plan, existing.path);
    backupPath(plan, existing.path);
    rmSync(existing.path, { force: true });
    recordLedger(plan, {
      area: operation.area,
      item: agentName,
      action: operation.action,
      status: "applied",
      target: existing.path,
      beforeHash,
      backupPath: backupPathTaken,
      message: `deleted agent ${agentName}`,
    });
  }
}

function mergeIntoClaudeSettings(targetPath, sourcePath, sourceHost, area, itemNames) {
  const target = readJsonFile(targetPath, {});

  if (area === "permissions") {
    target.permissions ??= {};
    for (const itemName of itemNames) {
      const { bucket, value } = parsePermissionItem(itemName);
      const list = Array.isArray(target.permissions[bucket]) ? target.permissions[bucket] : [];
      if (!list.includes(value)) list.push(value);
      target.permissions[bucket] = list;
    }
  }

  if (area === "hooks") {
    target.hooks ??= {};
    const sourceHooks =
      sourceHost === "codex"
        ? codexHookValues(sourcePath)
        : (readJsonFile(sourcePath, {}).hooks ?? {});

    for (const itemName of itemNames) {
      if (!target.hooks[itemName]) {
        target.hooks[itemName] = sourceHooks[itemName] ?? [];
      }
    }
  }

  writeFileSync(targetPath, `${JSON.stringify(target, null, 2)}\n`);
}

function mergeIntoCodexSettings(targetPath, sourcePath, sourceHost, area, itemNames) {
  if (sourceHost !== "claude") {
    throw new Error(`mergeIntoCodexSettings expected sourceHost "claude", got ${sourceHost}`);
  }

  const sourceValues = claudeManagedValues(area, sourcePath, itemNames);
  const text = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
  const managedValues = codexManagedFallbackValues(area, sourceValues, itemNames);
  let nextText = replaceManagedBlock(text, area, managedValues, itemNames, {
    dropMissingSelected: true,
  });

  if (area === "permissions") {
    nextText = applyCodexNativePermissionMapping(nextText, itemNames);
    writeCodexPermissionRules(codexRulesPath(targetPath), itemNames);
  }

  if (area === "hooks") {
    nextText = applyCodexNativeHookMapping(nextText, sourceValues, itemNames);
  }

  writeFileSync(targetPath, nextText);
}

function codexManagedFallbackValues(area, sourceValues, itemNames) {
  if (area === "permissions") return codexManagedPermissionFallbackValues(sourceValues, itemNames);
  if (area === "hooks") return codexManagedHookFallbackValues(sourceValues, itemNames);
  return sourceValues;
}

function codexManagedPermissionFallbackValues(sourceValues, itemNames) {
  const values = {};

  for (const itemName of itemNames) {
    const { bucket, value } = parsePermissionItem(itemName);
    if (hasExactCodexPermissionMapping(bucket, value)) continue;
    const key = permissionKey(itemName);
    if (sourceValues[key] !== undefined) values[key] = sourceValues[key];
  }

  return values;
}

function hasExactCodexPermissionMapping(bucket, value) {
  const mcp = parseMcpPermission(value);
  if (mcp) return true;
  if (bucket === "allow" && (value === "WebSearch" || value === "WebFetch")) return true;
  if (isAgentPermission(value)) return true;

  const prefixRule = codexPrefixRuleForPermission(bucket, value);
  return Boolean(prefixRule);
}

function isAgentPermission(value) {
  return value === "Agent" || /^Agent\(/.test(value);
}

function codexManagedHookFallbackValues(sourceValues, itemNames) {
  const values = {};

  for (const itemName of itemNames) {
    const groups = sourceValues[itemName];
    if (!Array.isArray(groups) || !groups.every(isCodexNativeHookGroup)) {
      if (sourceValues[itemName] !== undefined) values[itemName] = sourceValues[itemName];
    }
  }

  return values;
}

function isCodexNativeHookGroup(group) {
  const hooks = group?.hooks;
  return (
    Array.isArray(hooks) &&
    hooks.length > 0 &&
    hooks.every((hook) => hook?.type === "command" && typeof hook.command === "string")
  );
}

function claudeManagedValues(area, sourcePath, itemNames) {
  const data = readJsonFile(sourcePath, {});
  const values = {};

  if (area === "permissions") {
    for (const itemName of itemNames) {
      const { bucket, value } = parsePermissionItem(itemName);
      values[`${bucket}:${value}`] = { bucket, value };
    }
  }

  if (area === "hooks") {
    const hooks = data.hooks ?? {};
    for (const itemName of itemNames) {
      values[itemName] = hooks[itemName] ?? [];
    }
  }

  return values;
}

function codexHookValues(sourcePath) {
  if (!existsSync(sourcePath)) return {};
  const text = readFileSync(sourcePath, "utf8");
  return parseCodexNativeHooks(text);
}

function parseCodexNativeHooks(text) {
  const values = {};
  const lines = text.split(/\r?\n/);
  let currentEvent;
  let currentGroup = null;
  let currentHook = null;

  for (const line of lines) {
    const eventMatch = line.match(/^\s*\[\[hooks\.([A-Za-z0-9_-]+)\]\]\s*$/);
    if (eventMatch) {
      currentEvent = eventMatch[1];
      currentGroup = { hooks: [] };
      values[currentEvent] ??= [];
      values[currentEvent].push(currentGroup);
      currentHook = null;
      continue;
    }

    const hookMatch = line.match(/^\s*\[\[hooks\.([A-Za-z0-9_-]+)\.hooks\]\]\s*$/);
    if (hookMatch) {
      currentEvent = hookMatch[1];
      values[currentEvent] ??= [];
      currentGroup =
        currentGroup && values[currentEvent].includes(currentGroup) ? currentGroup : { hooks: [] };
      if (!values[currentEvent].includes(currentGroup)) values[currentEvent].push(currentGroup);
      currentHook = {};
      currentGroup.hooks.push(currentHook);
      continue;
    }

    const keyValue = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (!keyValue) continue;

    const [, key, rawValue] = keyValue;
    const value = parseTomlScalar(rawValue);

    if (currentHook) {
      currentHook[key] = value;
    } else if (currentGroup) {
      currentGroup[key] = value;
    }
  }

  return values;
}

function parseTomlScalar(value) {
  const trimmed = value.trim();
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return parseJsonLike(trimmed, trimmed.replace(/^"|"$/g, ""));
}

function replaceManagedBlock(text, area, sourceValues, itemNames, options = {}) {
  const begin = `# BEGIN ai-config-sync ${area}`;
  const end = `# END ai-config-sync ${area}`;
  const existing = parseManagedBlock(text, area);
  const merged = { ...existing };

  for (const itemName of itemNames) {
    const key = area === "permissions" ? permissionKey(itemName) : itemName;
    if (sourceValues[key] !== undefined) {
      merged[key] = sourceValues[key];
    } else if (options.dropMissingSelected) {
      delete merged[key];
    }
  }

  const pattern = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "m");

  if (Object.keys(merged).length === 0) {
    return pattern.test(text) ? text.replace(pattern, "").replace(/\s*$/, "\n") : text;
  }

  const lines = [
    begin,
    ...Object.entries(merged)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => managedLine(area, key, value)),
    end,
  ];
  const block = lines.join("\n");

  if (pattern.test(text)) {
    return text.replace(pattern, block);
  }

  return `${text.replace(/\s*$/, "")}\n\n${block}\n`;
}

function parseManagedBlock(text, area) {
  const begin = `# BEGIN ai-config-sync ${area}`;
  const end = `# END ai-config-sync ${area}`;
  const pattern = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}`, "m");
  const match = text.match(pattern);
  if (!match) return {};

  const tempPath = "__managed_block__";
  return area === "permissions"
    ? parsePermissionManagedLines(match[0])
    : parseHookManagedLines(match[0], tempPath);
}

function parsePermissionManagedLines(text) {
  const values = {};
  for (const match of text.matchAll(/^\s*#\s*permissions\.(allow|deny|ask)\s*=\s*(.+)$/gm)) {
    try {
      const value = JSON.parse(match[2]);
      values[`${match[1]}:${value}`] = { bucket: match[1], value };
    } catch {
      // Ignore malformed managed comments.
    }
  }
  return values;
}

function parseHookManagedLines(text) {
  const values = {};
  for (const match of text.matchAll(/^\s*#\s*hooks\.([A-Za-z0-9_-]+)\s*=\s*(.+)$/gm)) {
    try {
      values[match[1]] = JSON.parse(match[2]);
    } catch {
      values[match[1]] = [];
    }
  }
  return values;
}

function managedLine(area, key, value) {
  if (area === "permissions") {
    return `# permissions.${value.bucket} = ${JSON.stringify(value.value)}`;
  }

  return `# hooks.${key} = ${JSON.stringify(value)}`;
}

function parsePermissionItem(itemName) {
  const [maybeBucket, ...rest] = itemName.split(":");
  if (rest.length > 0 && ["allow", "deny", "ask"].includes(maybeBucket)) {
    return { bucket: maybeBucket, value: rest.join(":") };
  }
  return { bucket: "allow", value: itemName };
}

function permissionOperationItems(itemNames) {
  const bucketed = new Set(
    itemNames
      .filter((itemName) => /^(allow|ask|deny):/.test(itemName))
      .map((itemName) => itemName.replace(/^(allow|ask|deny):/, ""))
  );

  return itemNames.filter((itemName) => {
    if (/^(allow|ask|deny):/.test(itemName)) return true;
    return !bucketed.has(itemName);
  });
}

function applyCodexNativePermissionMapping(text, itemNames) {
  let nextText = text;
  const parsed = itemNames
    .map((itemName) => parsePermissionItem(itemName))
    .filter(({ value }) => !isAgentPermission(value));

  if (parsed.some(({ value }) => ["Write", "Edit", "MultiEdit"].includes(value))) {
    nextText = setTomlRootString(nextText, "sandbox_mode", "workspace-write");
  }

  if (
    parsed.some(
      ({ bucket, value }) => bucket === "allow" && (value === "WebSearch" || value === "WebFetch")
    )
  ) {
    nextText = setTomlRootString(nextText, "web_search", "live");
  }

  if (parsed.some(({ bucket }) => bucket === "ask")) {
    nextText = setTomlRootString(nextText, "approval_policy", "on-request");
  }

  nextText = applyCodexMcpToolApprovals(nextText, itemNames);

  return nextText;
}

function isCommandLikePermission(value) {
  return (
    value === "Bash" ||
    value.startsWith("Bash(") ||
    value === "WebFetch" ||
    value === "WebSearch" ||
    value === "Agent" ||
    value === "SendMessage" ||
    value.startsWith("mcp__")
  );
}

function setTomlRootString(text, key, value) {
  const line = `${key} = ${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, "m");

  if (pattern.test(text)) {
    return text.replace(pattern, line);
  }

  return `${line}\n${text}`;
}

function setTomlTableBoolean(text, table, key, value) {
  const tableLine = `[${table}]`;
  const valueLine = `${key} = ${value ? "true" : "false"}`;
  const tablePattern = new RegExp(`^\\[${escapeRegExp(table)}\\]\\n([\\s\\S]*?)(?=^\\[|$)`, "m");
  const match = text.match(tablePattern);

  if (!match) {
    return `${text.replace(/\s*$/, "")}\n\n${tableLine}\n${valueLine}\n`;
  }

  const body = match[1];
  const keyPattern = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, "m");
  const nextBody = keyPattern.test(body)
    ? body.replace(keyPattern, valueLine)
    : `${body.replace(/\s*$/, "")}\n${valueLine}\n`;

  return text.replace(tablePattern, `${tableLine}\n${nextBody}`);
}

function applyCodexMcpToolApprovals(text, itemNames) {
  let nextText = text;

  for (const itemName of itemNames) {
    const { bucket, value } = parsePermissionItem(itemName);
    const mcp = parseMcpPermission(value);
    if (!mcp) continue;

    if (isMcpServerScopePermission(mcp)) {
      // Server-level (or wildcard tool) permission. Codex defaults to allowing all tools, so
      // allow/ask are noops at the codex layer. deny needs an explicit empty enabled_tools to
      // forbid every tool on the server.
      if (bucket === "deny") {
        nextText = setTomlMcpServerArray(nextText, mcp.server, "enabled_tools", []);
      } else {
        nextText = ensureTomlMcpServerTable(nextText, mcp.server);
      }
      continue;
    }

    const approvalMode = bucket === "deny" ? "deny" : bucket === "ask" ? "prompt" : "approve";
    nextText = setTomlMcpToolApproval(nextText, mcp.server, mcp.tool, approvalMode);

    if (bucket === "allow") {
      nextText = appendTomlMcpServerArray(nextText, mcp.server, "enabled_tools", mcp.tool);
    } else if (bucket === "deny") {
      nextText = appendTomlMcpServerArray(nextText, mcp.server, "disabled_tools", mcp.tool);
    }
  }

  return nextText;
}

function setTomlMcpServerArray(text, server, key, values) {
  const tableLine = `[mcp_servers.${server}]`;
  const tablePattern = new RegExp(
    `^\\[mcp_servers\\.${escapeRegExp(server)}\\]\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`,
    "m"
  );
  const match = text.match(tablePattern);
  const line = `${key} = ${formatTomlStringArray(values)}`;

  if (!match) {
    return `${text.replace(/\s*$/, "")}\n\n${tableLine}\n${line}\n`;
  }

  const body = match[1];
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*\\[[^\\]]*\\]\\s*$`, "m");
  const nextBody = keyPattern.test(body)
    ? body.replace(keyPattern, line)
    : `${body.replace(/\s*$/, "")}\n${line}\n`;

  return text.replace(tablePattern, `${tableLine}\n${nextBody}`);
}

function ensureTomlMcpServerTable(text, server) {
  const tableLine = `[mcp_servers.${server}]`;
  const tablePattern = new RegExp(`^\\[mcp_servers\\.${escapeRegExp(server)}\\]\\n`, "m");
  if (tablePattern.test(text)) return text;
  return `${text.replace(/\s*$/, "")}\n\n${tableLine}\n`;
}

function appendTomlMcpServerArray(text, server, key, tool) {
  const tableLine = `[mcp_servers.${server}]`;
  const tablePattern = new RegExp(
    `^\\[mcp_servers\\.${escapeRegExp(server)}\\]\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`,
    "m"
  );
  const match = text.match(tablePattern);

  if (!match) {
    const line = `${key} = ${formatTomlStringArray([tool])}`;
    return `${text.replace(/\s*$/, "")}\n\n${tableLine}\n${line}\n`;
  }

  const body = match[1];
  const existing = parseTomlStringArray(body, key);
  if (existing.includes(tool)) return text;

  const merged = [...existing, tool];
  const line = `${key} = ${formatTomlStringArray(merged)}`;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*\\[[^\\]]*\\]\\s*$`, "m");
  const nextBody = keyPattern.test(body)
    ? body.replace(keyPattern, line)
    : `${body.replace(/\s*$/, "")}\n${line}\n`;

  return text.replace(tablePattern, `${tableLine}\n${nextBody}`);
}

function formatTomlStringArray(values) {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function setTomlMcpToolApproval(text, server, tool, approvalMode) {
  const table = `[mcp_servers.${server}.tools.${tool}]`;
  const line = `approval_mode = ${JSON.stringify(approvalMode)}`;
  const tablePattern = new RegExp(
    `^\\[mcp_servers\\.${escapeRegExp(server)}\\.tools\\.${escapeRegExp(tool)}\\]\\n([\\s\\S]*?)(?=^\\[|$)`,
    "m"
  );
  const match = text.match(tablePattern);

  if (!match) {
    return `${text.replace(/\s*$/, "")}\n\n${table}\n${line}\n`;
  }

  const body = match[1];
  const approvalPattern = /^approval_mode\s*=.*$/m;
  const nextBody = approvalPattern.test(body)
    ? body.replace(approvalPattern, line)
    : `${body.replace(/\s*$/, "")}\n${line}\n`;

  return text.replace(tablePattern, `${table}\n${nextBody}`);
}

function parseMcpPermission(value) {
  const withTool = value.match(/^mcp__([^_]+(?:_[^_]+)*)__([^_].*)$/);
  if (withTool) {
    return { server: withTool[1].replaceAll("_", "-"), tool: withTool[2] };
  }
  const serverOnly = value.match(/^mcp__([^_]+(?:_[^_]+)*)$/);
  if (serverOnly) {
    return { server: serverOnly[1].replaceAll("_", "-"), tool: null };
  }
  return null;
}

function isMcpServerScopePermission(mcp) {
  return mcp !== null && (mcp.tool === null || mcp.tool === "*");
}

function writeCodexPermissionRules(path, itemNames) {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = [];

  for (const itemName of itemNames) {
    const { bucket, value } = parsePermissionItem(itemName);
    const rule = codexPrefixRuleForPermission(bucket, value);
    if (!rule) continue;
    lines.push(rule);
  }

  if (lines.length === 0) return;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    replaceTextBlock(existing, "permissions-rules", uniqueStrings(lines).join("\n"))
  );
}

function replaceTextBlock(text, name, body) {
  const begin = `# BEGIN ai-config-sync ${name}`;
  const end = `# END ai-config-sync ${name}`;
  const block = `${begin}\n${body}\n${end}`;
  const pattern = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}`, "m");

  if (pattern.test(text)) {
    return text.replace(pattern, block);
  }

  return `${text.replace(/\s*$/, "")}\n\n${block}\n`;
}

// Strip `[mcp_servers.X]` (and `[mcp_servers.X.tools.Y]`) tables that live OUTSIDE the
// managed block, for X in `serverNames`. Used before re-rendering the managed block
// so the same server isn't declared twice (TOML duplicate-key error).
function stripTopLevelMcpServerTables(text, serverNames, blockName = "mcp-servers") {
  if (!text || !Array.isArray(serverNames) || serverNames.length === 0) return text;

  const begin = `# BEGIN ai-config-sync ${blockName}`;
  const end = `# END ai-config-sync ${blockName}`;
  const blockMatch = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}`, "m").exec(
    text
  );

  // Split into segments around the managed block so stripping never crosses the
  // BEGIN/END markers (otherwise a top-level table's body match could swallow them).
  const segments = blockMatch
    ? [
        { text: text.slice(0, blockMatch.index), strip: true },
        { text: blockMatch[0], strip: false },
        { text: text.slice(blockMatch.index + blockMatch[0].length), strip: true },
      ]
    : [{ text, strip: true }];

  const stripped = segments
    .map((segment) =>
      segment.strip ? stripMcpTablesFromSegment(segment.text, serverNames) : segment.text
    )
    .join("");

  // Collapse triple+ blank lines that may appear after removing tables, but preserve
  // a final newline if the original had one.
  const trailingNewline = /\n$/.test(text) ? "\n" : "";
  return stripped.replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "") + trailingNewline;
}

function stripMcpTablesFromSegment(segment, serverNames) {
  return serverNames.reduce((acc, name) => {
    // Match `[mcp_servers.X]` headers (NOT `[mcp_servers.X.tools.Y]` sub-tables —
    // those carry standalone tool-permission config the user may want to keep). The
    // body match consumes lines until the next TOML header (`[`) or a managed-block
    // marker (`# BEGIN/END ai-config-sync`), so it never accidentally swallows them.
    const pattern = new RegExp(
      `(^|\\n)\\[mcp_servers\\.${escapeRegExp(name)}\\][^\\n]*(?:\\n(?!\\[|# (?:BEGIN|END) ai-config-sync )[^\\n]*)*\\n?`,
      "g"
    );
    return acc.replace(pattern, (match, prefix) => (prefix === "\n" ? "\n" : ""));
  }, segment);
}

function codexPrefixRuleForPermission(bucket, value) {
  const pattern = bashPattern(value);
  if (!pattern) return null;

  const decision = bucket === "deny" ? "forbidden" : bucket === "ask" ? "prompt" : "allow";
  return `prefix_rule(pattern=${JSON.stringify(pattern.parts)}, decision=${JSON.stringify(decision)}, justification=${JSON.stringify(`Migrated from Claude ${bucket} permission ${value}.`)})`;
}

function bashPattern(value) {
  if (value === "Bash") return { risky: true, parts: ["bash"] };
  const match = value.match(/^Bash\((.*)\)$/);
  if (!match) return null;

  const raw = match[1]
    .trim()
    .replace(/:\*$/, " *")
    .replace(/\s+\*$/, "");
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { risky: true, parts: ["bash"] };

  const riskyCommands = new Set([
    "bash",
    "zsh",
    "sh",
    "python",
    "python3",
    "node",
    "rm",
    "sudo",
    "chmod",
    "chown",
    "curl",
    "wget",
  ]);
  return {
    risky: riskyCommands.has(parts[0]),
    parts,
  };
}

function parseManagedNativeHooks(text) {
  const begin = `# BEGIN ai-config-sync native-hooks`;
  const end = `# END ai-config-sync native-hooks`;
  const pattern = new RegExp(`${escapeRegExp(begin)}([\\s\\S]*?)${escapeRegExp(end)}`, "m");
  const match = pattern.exec(text);
  if (!match) return {};
  return parseCodexNativeHooks(match[1]);
}

function applyCodexNativeHookMapping(text, sourceValues, itemNames) {
  const existingValues = parseManagedNativeHooks(text);
  const merged = { ...existingValues };

  for (const itemName of itemNames) {
    if (sourceValues[itemName] !== undefined) {
      merged[itemName] = sourceValues[itemName];
    } else {
      delete merged[itemName];
    }
  }

  const hookLines = [];
  const eventNames = Object.keys(merged).sort();

  for (const eventName of eventNames) {
    const groups = merged[eventName];
    if (!Array.isArray(groups)) continue;

    for (const group of groups) {
      const commandHooks = Array.isArray(group.hooks)
        ? group.hooks.filter((hook) => hook?.type === "command" && typeof hook.command === "string")
        : [];
      if (commandHooks.length === 0) continue;

      hookLines.push(`[[hooks.${eventName}]]`);
      if (typeof group.matcher === "string") {
        hookLines.push(`matcher = ${JSON.stringify(group.matcher)}`);
      }

      for (const hook of commandHooks) {
        hookLines.push(`[[hooks.${eventName}.hooks]]`);
        hookLines.push('type = "command"');
        hookLines.push(`command = ${JSON.stringify(hook.command)}`);
        if (Number.isInteger(hook.timeout)) hookLines.push(`timeout = ${hook.timeout}`);
        if (typeof hook.statusMessage === "string") {
          hookLines.push(`statusMessage = ${JSON.stringify(hook.statusMessage)}`);
        }
      }
    }
  }

  if (hookLines.length === 0) return text;

  const withFeature = setTomlTableBoolean(text, "features", "hooks", true);
  return replaceTextBlock(withFeature, "native-hooks", hookLines.join("\n"));
}

function codexRulesPath(configPath) {
  return join(dirname(configPath), "rules/default.rules");
}

function mergeMcpIntoCodex(targetPath, sourcePath, sourceHost, serverNames) {
  const sourceServers = pickServers(
    sourceHost === "claude" ? readClaudeMcpServers(sourcePath) : readCodexMcpServers(sourcePath),
    serverNames
  );
  const targetServers = readCodexMcpServers(targetPath);
  const merged = { ...targetServers, ...sourceServers };
  const original = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
  // Strip top-level [mcp_servers.X] tables for any X we're about to render inside
  // the managed block — otherwise the same key appears twice and TOML rejects the file.
  const text = stripTopLevelMcpServerTables(original, Object.keys(merged), "mcp-servers");

  writeFileSync(targetPath, replaceTextBlock(text, "mcp-servers", renderCodexMcpServers(merged)));
}

function mergeMcpIntoClaude(targetPath, sourcePath, sourceHost, serverNames) {
  const sourceServers = mcpServersForClaude(
    pickServers(
      sourceHost === "codex" ? readCodexMcpServers(sourcePath) : readClaudeMcpServers(sourcePath),
      serverNames
    )
  );
  const { file, projectKey } = parseClaudeMcpSource(targetPath);
  const target = readJsonFile(file, {});
  if (projectKey) {
    target.projects ??= {};
    target.projects[projectKey] ??= {};
    target.projects[projectKey].mcpServers = {
      ...(target.projects[projectKey].mcpServers ?? {}),
      ...sourceServers,
    };
  } else {
    target.mcpServers = { ...(target.mcpServers ?? {}), ...sourceServers };
  }
  writeFileSync(file, `${JSON.stringify(target, null, 2)}\n`);
}

function deleteClaudeMcpServers(targetPath, serverNames) {
  const targets = Array.isArray(targetPath) ? targetPath : [targetPath];
  for (const spec of targets) {
    const { file, projectKey } = parseClaudeMcpSource(spec);
    if (!existsSync(file)) continue;
    const target = readJsonFile(file, {});
    const bag = projectKey ? target.projects?.[projectKey]?.mcpServers : target.mcpServers;
    if (!bag) continue;
    let mutated = false;
    for (const name of serverNames) {
      if (name in bag) {
        delete bag[name];
        mutated = true;
      }
    }
    if (mutated) writeFileSync(file, `${JSON.stringify(target, null, 2)}\n`);
  }
}

function deleteCodexMcpServers(targetPath, serverNames) {
  const text = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
  let nextText = text;

  for (const name of serverNames) {
    const serverPattern = new RegExp(
      `^\\[mcp_servers\\.${escapeRegExp(name)}\\]\\n[\\s\\S]*?(?=^\\[mcp_servers\\.|(?![\\s\\S]))`,
      "gm"
    );
    const toolsPattern = new RegExp(
      `^\\[mcp_servers\\.${escapeRegExp(name)}\\.tools\\.[^\\]]+\\]\\n[\\s\\S]*?(?=^\\[|(?![\\s\\S]))`,
      "gm"
    );
    nextText = nextText.replace(serverPattern, "").replace(toolsPattern, "");
  }

  writeFileSync(targetPath, nextText.replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n"));
}

function deleteClaudePermissions(targetPath, itemNames) {
  const target = readJsonFile(targetPath, {});
  target.permissions ??= {};

  for (const itemName of itemNames) {
    const { bucket, value } = parsePermissionItem(itemName);
    const list = Array.isArray(target.permissions[bucket]) ? target.permissions[bucket] : [];
    target.permissions[bucket] = list.filter((item) => item !== value);
  }

  writeFileSync(targetPath, `${JSON.stringify(target, null, 2)}\n`);
}

function deleteClaudeHooks(targetPath, itemNames) {
  const target = readJsonFile(targetPath, {});
  target.hooks ??= {};

  for (const itemName of itemNames) {
    delete target.hooks[itemName];
  }

  writeFileSync(targetPath, `${JSON.stringify(target, null, 2)}\n`);
}

function deleteCodexManagedItems(targetPath, area, itemNames) {
  const text = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
  const emptyValues = {};
  const nextText = replaceManagedBlock(text, area, emptyValues, itemNames, {
    dropMissingSelected: true,
  });
  writeFileSync(targetPath, nextText);
}

// Reads the source-side claude settings.json and returns every permission value
// (across allow/ask/deny buckets) that still exists. Used to decide whether
// top-level codex toggles (sandbox_mode, web_search) should be torn down after
// the items that justified them are removed.
function remainingClaudePermissionItems(sourcePath) {
  if (!sourcePath || !existsSync(sourcePath)) return [];
  const data = readJsonFile(sourcePath, {});
  const permissions = data?.permissions ?? {};
  return Object.values(permissions)
    .flat()
    .filter((value) => typeof value === "string");
}

// Mirror of the forward writer (applyCodexNativePermissionMapping +
// writeCodexPermissionRules): for each deleted item, strip its native
// counterpart from config.toml / default.rules. Top-level toggles only fall
// away when no remaining claude item still requires them.
function deleteCodexNativePermissionItems(configPath, deletedItemNames, remainingClaudeItemNames) {
  const rulesPath = codexRulesPath(configPath);
  let configText = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  let rulesText = existsSync(rulesPath) ? readFileSync(rulesPath, "utf8") : "";

  for (const itemName of deletedItemNames) {
    const { bucket, value } = parsePermissionItem(itemName);

    const pattern = bashPattern(value);
    if (pattern) {
      const decision = bucket === "deny" ? "forbidden" : bucket === "ask" ? "prompt" : "allow";
      rulesText = removePrefixRuleLine(rulesText, pattern.parts, decision);
    }

    const mcp = parseMcpPermission(value);
    if (mcp) {
      if (isMcpServerScopePermission(mcp)) {
        if (bucket === "deny") {
          configText = removeTomlMcpServerKey(configText, mcp.server, "enabled_tools");
        }
      } else {
        configText = removeFromTomlMcpServerArray(
          configText,
          mcp.server,
          "enabled_tools",
          mcp.tool
        );
        configText = removeFromTomlMcpServerArray(
          configText,
          mcp.server,
          "disabled_tools",
          mcp.tool
        );
        configText = removeTomlMcpToolBlock(configText, mcp.server, mcp.tool);
      }
    }
  }

  const remainingHasFsWrite = remainingClaudeItemNames.some((value) =>
    ["Write", "Edit", "MultiEdit"].includes(value)
  );
  if (!remainingHasFsWrite) {
    configText = removeTomlRootKey(configText, "sandbox_mode");
  }

  const remainingHasWeb = remainingClaudeItemNames.some(
    (value) => value === "WebSearch" || value === "WebFetch"
  );
  if (!remainingHasWeb) {
    configText = removeTomlRootKey(configText, "web_search");
  }

  // network_access under [sandbox_workspace_write] is intentionally not auto-removed:
  // it is also user-controllable and only the forward writer for WebFetch sets it.

  writeFileSync(configPath, configText);
  if (existsSync(rulesPath)) {
    writeFileSync(rulesPath, rulesText);
  }
}

// Match prefix_rule(...) lines by their (parts, decision) tuple instead of by an
// exact-string match against codexPrefixRuleForPermission's output. Real-world
// default.rules files vary in whitespace inside the JSON array and may omit the
// trailing justification= argument (and may grow new fields in the future); the
// tuple is the only stable identity. Drops at most one matching line per call so
// repeated deletes stay idempotent against the forward writer's one-line-per-emit
// semantics.
function removePrefixRuleLine(text, parts, decision) {
  if (!Array.isArray(parts)) return text;
  const target = JSON.stringify(parts);
  const lines = text.split(/\r?\n/);
  const filtered = [];
  let removed = false;

  for (const line of lines) {
    if (!removed) {
      const match = line.match(
        /^\s*prefix_rule\(\s*pattern\s*=\s*(\[[^\]]*\])\s*,\s*decision\s*=\s*"([^"]+)"/
      );
      if (match) {
        const lineParts = parseJsonLike(match[1], null);
        const lineCanonical = Array.isArray(lineParts) ? JSON.stringify(lineParts) : null;
        if (lineCanonical === target && match[2] === decision) {
          removed = true;
          continue;
        }
      }
    }
    filtered.push(line);
  }

  return filtered.join("\n");
}

function removeTomlRootKey(text, key) {
  const pattern = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=.*\\r?\\n?`, "m");
  return text.replace(pattern, "");
}

function removeTomlMcpServerKey(text, server, key) {
  const tablePattern = new RegExp(
    `^\\[mcp_servers\\.${escapeRegExp(server)}\\]\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`,
    "m"
  );
  const match = text.match(tablePattern);
  if (!match) return text;

  const body = match[1];
  const keyPattern = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=.*\\r?\\n?`, "m");
  if (!keyPattern.test(body)) return text;

  const nextBody = body.replace(keyPattern, "");
  return text.replace(tablePattern, `[mcp_servers.${server}]\n${nextBody}`);
}

function removeFromTomlMcpServerArray(text, server, key, tool) {
  const tablePattern = new RegExp(
    `^\\[mcp_servers\\.${escapeRegExp(server)}\\]\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`,
    "m"
  );
  const match = text.match(tablePattern);
  if (!match) return text;

  const body = match[1];
  const existing = parseTomlStringArray(body, key);
  if (!existing.includes(tool)) return text;

  const remaining = existing.filter((item) => item !== tool);
  const keyPattern = new RegExp(
    `^[ \\t]*${escapeRegExp(key)}[ \\t]*=\\s*\\[[^\\]]*\\][ \\t]*\\r?\\n?`,
    "m"
  );

  const nextBody =
    remaining.length === 0
      ? body.replace(keyPattern, "")
      : body.replace(keyPattern, `${key} = ${formatTomlStringArray(remaining)}\n`);

  return text.replace(tablePattern, `[mcp_servers.${server}]\n${nextBody}`);
}

function removeTomlMcpToolBlock(text, server, tool) {
  const blockPattern = new RegExp(
    `^\\[mcp_servers\\.${escapeRegExp(server)}\\.tools\\.${escapeRegExp(tool)}\\]\\n[\\s\\S]*?(?=^\\[|(?![\\s\\S]))`,
    "m"
  );
  return text.replace(blockPattern, "");
}

function pickServers(servers, names) {
  if (!names.length) return servers;
  return Object.fromEntries(Object.entries(servers).filter(([name]) => names.includes(name)));
}

function mcpPatchPreview(sourcePath, targetPath, sourceHost, targetHost, serverNames) {
  const sourceServers =
    sourceHost === "claude"
      ? readClaudeMcpServerDetails(sourcePath)
      : readCodexMcpServerDetails(sourcePath);
  const targetServers =
    targetHost === "claude"
      ? readClaudeMcpServerDetails(targetPath)
      : readCodexMcpServerDetails(targetPath);
  const selected = serverNames.length ? serverNames : Object.keys(sourceServers).sort();
  const patches = [];

  for (const name of selected) {
    const source = sourceServers[name];
    if (!source) continue;

    const target = targetServers[name];
    const changes = mcpServerChanges(source, target);
    if (changes.length === 0) continue;

    patches.push({
      server: name,
      action: target ? "update" : "add",
      changes,
    });
  }

  return patches;
}

function mcpServerChanges(source, target) {
  const changes = [];
  const isUpdate = Boolean(target);
  const fmt = (next, prev) =>
    isUpdate ? `${JSON.stringify(prev ?? null)} -> ${JSON.stringify(next)}` : JSON.stringify(next);

  for (const key of ["command", "url"]) {
    if (source[key] && source[key] !== target?.[key]) {
      changes.push(`${key}: ${fmt(source[key], target?.[key])}`);
    }
  }

  if (source.bearerTokenEnvVar && source.bearerTokenEnvVar !== target?.bearerTokenEnvVar) {
    changes.push(
      `bearer_token_env_var: ${fmt(source.bearerTokenEnvVar, target?.bearerTokenEnvVar)}`
    );
  }

  if (source.args?.length && JSON.stringify(source.args) !== JSON.stringify(target?.args ?? [])) {
    changes.push(`args: ${fmt(source.args, target?.args ?? [])}`);
  }

  for (const [key, value] of Object.entries(source.env ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (target?.env?.[key] !== value) {
      changes.push(`env.${key}: ${fmt(value, target?.env?.[key])}`);
    }
  }

  for (const [key, value] of Object.entries(source.headers ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (target?.headers?.[key] !== value) {
      changes.push(`headers.${key}: ${fmt(value, target?.headers?.[key])}`);
    }
  }

  for (const key of source.secretEnvKeys ?? []) {
    changes.push(`metadata-only env.${key}: skipped secret-like value`);
  }

  return changes;
}

function readClaudeMcpServerDetails(path) {
  if (Array.isArray(path)) {
    return path.reduce(
      (servers, item) => ({ ...servers, ...readClaudeMcpServerDetails(item) }),
      {}
    );
  }
  const { file, projectKey } = parseClaudeMcpSource(path);
  const data = readJsonFile(file, {});
  const raw = projectKey
    ? (data?.projects?.[projectKey]?.mcpServers ?? {})
    : (data.mcpServers ?? data.servers ?? {});
  return normalizeMcpServerDetails(raw);
}

function readCodexMcpServerDetails(path) {
  if (Array.isArray(path)) {
    return path.reduce((servers, item) => ({ ...servers, ...readCodexMcpServerDetails(item) }), {});
  }
  if (!existsSync(path)) return {};
  if (path.endsWith(".json")) {
    const data = readJsonFile(path, {});
    return normalizeMcpServerDetails(data.mcpServers ?? data.servers ?? {});
  }
  const text = readFileSync(path, "utf8");
  const servers = {};
  const tablePattern = /^\[mcp_servers\.([^\].]+)\]\n([\s\S]*?)(?=^\[mcp_servers\.|(?![\s\S]))/gm;

  for (const match of text.matchAll(tablePattern)) {
    const server = {};
    const body = match[2];
    const command = body.match(/^command\s*=\s*"([^"]*)"/m);
    const url = body.match(/^url\s*=\s*"([^"]*)"/m);
    const args = body.match(/^args\s*=\s*(\[.*\])/m);
    const env = body.match(/^env\s*=\s*(\{.*\})/m);
    const bearerTokenEnvVar = body.match(/^bearer_token_env_var\s*=\s*"([^"]*)"/m);

    if (command) server.command = command[1];
    if (url) server.url = url[1];
    if (args) server.args = parseJsonLike(args[1], []);
    if (env) server.env = parseInlineTomlObject(env[1]);
    if (bearerTokenEnvVar) server.bearerTokenEnvVar = bearerTokenEnvVar[1];
    servers[match[1]] = server;
  }

  return normalizeMcpServerDetails(servers);
}

function readClaudeMcpServers(path) {
  if (Array.isArray(path)) {
    return path.reduce((servers, item) => ({ ...servers, ...readClaudeMcpServers(item) }), {});
  }
  const { file, projectKey } = parseClaudeMcpSource(path);
  const data = readJsonFile(file, {});
  const raw = projectKey
    ? (data?.projects?.[projectKey]?.mcpServers ?? {})
    : (data.mcpServers ?? data.servers ?? {});
  return normalizeMcpServers(raw);
}

function readCodexMcpServers(path) {
  if (Array.isArray(path)) {
    return path.reduce((servers, item) => ({ ...servers, ...readCodexMcpServers(item) }), {});
  }
  if (!existsSync(path)) return {};
  if (path.endsWith(".json")) {
    const data = readJsonFile(path, {});
    return normalizeMcpServers(data.mcpServers ?? data.servers ?? {});
  }
  const text = readFileSync(path, "utf8");
  const servers = {};
  const tablePattern = /^\[mcp_servers\.([^\].]+)\]\n([\s\S]*?)(?=^\[mcp_servers\.|(?![\s\S]))/gm;

  for (const match of text.matchAll(tablePattern)) {
    const server = {};
    const body = match[2];
    const command = body.match(/^command\s*=\s*"([^"]*)"/m);
    const url = body.match(/^url\s*=\s*"([^"]*)"/m);
    const args = body.match(/^args\s*=\s*(\[.*\])/m);
    const env = body.match(/^env\s*=\s*(\{.*\})/m);
    const bearerTokenEnvVar = body.match(/^bearer_token_env_var\s*=\s*"([^"]*)"/m);

    if (command) server.command = command[1];
    if (url) server.url = url[1];
    if (args) server.args = parseJsonLike(args[1], []);
    if (env) server.env = parseInlineTomlObject(env[1]);
    if (bearerTokenEnvVar) server.bearerTokenEnvVar = bearerTokenEnvVar[1];
    servers[match[1]] = server;
  }

  return normalizeMcpServers(servers);
}

function normalizeMcpServers(servers) {
  return Object.fromEntries(
    Object.entries(normalizeMcpServerDetails(servers)).map(([name, value]) => [
      name,
      {
        ...(value.command ? { command: value.command } : {}),
        ...(value.url ? { url: value.url } : {}),
        ...(value.args?.length ? { args: value.args } : {}),
        ...(value.env && Object.keys(value.env).length > 0 ? { env: value.env } : {}),
        ...(value.bearerTokenEnvVar ? { bearerTokenEnvVar: value.bearerTokenEnvVar } : {}),
        ...(value.headers && Object.keys(value.headers).length > 0
          ? { headers: value.headers }
          : {}),
      },
    ])
  );
}

function normalizeMcpServerDetails(servers) {
  return Object.fromEntries(
    Object.entries(servers)
      .filter(([name, value]) => name && value && typeof value === "object")
      .map(([name, value]) => {
        const headers = normalizeMcpHeaders(value.headers);
        const bearerTokenEnvVar = mcpBearerTokenEnvVar(value, headers);
        const residualHeaders = mcpHeadersWithoutBearerTokenEnv(headers, bearerTokenEnvVar);
        return [
          name,
          {
            ...(typeof value.command === "string" ? { command: value.command } : {}),
            ...(typeof value.url === "string" ? { url: value.url } : {}),
            ...(Array.isArray(value.args)
              ? { args: value.args.filter((item) => typeof item === "string") }
              : {}),
            ...(value.env && typeof value.env === "object" ? { env: safeEnv(value.env) } : {}),
            ...(value.env && typeof value.env === "object"
              ? { secretEnvKeys: secretEnvKeys(value.env) }
              : {}),
            ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
            ...(Object.keys(residualHeaders).length > 0 ? { headers: residualHeaders } : {}),
          },
        ];
      })
  );
}

function normalizeMcpHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key, value]) => typeof key === "string" && typeof value === "string" && key
    )
  );
}

function mcpBearerTokenEnvVar(value, headers) {
  if (typeof value.bearerTokenEnvVar === "string" && value.bearerTokenEnvVar)
    return value.bearerTokenEnvVar;
  if (typeof value.bearer_token_env_var === "string" && value.bearer_token_env_var)
    return value.bearer_token_env_var;
  const authorization = headers.Authorization ?? headers.authorization;
  if (typeof authorization !== "string") return "";
  const match = authorization.match(/^Bearer\s+\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  return match?.[1] ?? "";
}

function mcpHeadersWithoutBearerTokenEnv(headers, bearerTokenEnvVar) {
  if (!bearerTokenEnvVar) return headers;
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key, value]) => !/^authorization$/i.test(key) || value !== `Bearer \${${bearerTokenEnvVar}}`
    )
  );
}

function mcpServersForClaude(servers) {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [name, mcpServerForClaude(server)])
  );
}

function mcpServerForClaude(server) {
  const headers = {
    ...(server.headers ?? {}),
    ...(server.bearerTokenEnvVar
      ? { Authorization: `Bearer \${${server.bearerTokenEnvVar}}` }
      : {}),
  };
  const type = server.command ? "stdio" : server.url ? "http" : null;
  return {
    ...(type ? { type } : {}),
    ...(server.command ? { command: server.command } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

function safeEnv(env) {
  const stripSecrets = stripSecretsEnabled();
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) => typeof value === "string" && (!stripSecrets || !isSecretEnvKey(key))
    )
  );
}

function isSecretEnvKey(key) {
  return /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(key);
}

function secretEnvKeys(env) {
  if (!stripSecretsEnabled()) return [];
  return Object.keys(env)
    .filter((key) => isSecretEnvKey(key))
    .sort();
}

// Opt-out for users who want the conservative behavior of stripping secret-like
// env values during MCP sync. Default copies them because both source and target
// live under the same user's home directory and the source already stores the
// secret in plaintext — stripping just makes the synced target nonfunctional.
function stripSecretsEnabled() {
  const value = process.env.AI_CONFIG_SYNC_STRIP_SECRETS;
  return typeof value === "string" && /^(1|true|yes)$/i.test(value.trim());
}

function renderCodexMcpServers(servers) {
  const lines = [];

  for (const [name, server] of Object.entries(servers).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    lines.push(`[mcp_servers.${name}]`);
    if (server.command) lines.push(`command = ${JSON.stringify(server.command)}`);
    if (server.url) lines.push('transport = "streamable_http"');
    if (server.url) lines.push(`url = ${JSON.stringify(server.url)}`);
    if (server.bearerTokenEnvVar)
      lines.push(`bearer_token_env_var = ${JSON.stringify(server.bearerTokenEnvVar)}`);
    if (server.args?.length) lines.push(`args = ${JSON.stringify(server.args)}`);
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push(
        `env = { ${Object.entries(server.env)
          .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
          .join(", ")} }`
      );
    }
  }

  return lines.join("\n");
}

function parseJsonLike(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseInlineTomlObject(value) {
  const env = {};
  for (const match of value.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/g)) {
    env[match[1]] = match[2];
  }
  return env;
}

function permissionKey(itemName) {
  const { bucket, value } = parsePermissionItem(itemName);
  return `${bucket}:${value}`;
}

function readJsonFile(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function readRuntimePackage() {
  const fallback = { name: "ai-config-sync-manager", version: "0.0.0" };
  const path = join(runtimeRoot, "package.json");
  if (!existsSync(path)) return fallback;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return {
      name: typeof data.name === "string" ? data.name : fallback.name,
      version: typeof data.version === "string" ? data.version : fallback.version,
    };
  } catch {
    return fallback;
  }
}

function loadLayeredRule(candidates, defaults, mergeFn) {
  let merged = JSON.parse(JSON.stringify(defaults));
  const layers = [];
  const orderedFromBase = [...candidates].reverse();
  for (const path of orderedFromBase) {
    if (!existsSync(path)) continue;
    const overlay = readJsonFile(path, defaults);
    merged = mergeFn(merged, overlay);
    layers.push(path);
  }
  const firstMatch = candidates.find((path) => existsSync(path));
  return {
    path: firstMatch ?? candidates[candidates.length - 1],
    layers,
    data: merged,
  };
}

function mergeTerminologyMap(base, overlay) {
  if (!overlay || typeof overlay !== "object") return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (key === "layers" || key === "rules") continue;
    merged[key] = value;
  }
  const baseLayers = Array.isArray(base.layers) ? base.layers : [];
  const overlayLayers = Array.isArray(overlay.layers) ? [...overlay.layers] : [];
  if (Array.isArray(overlay.rules) && overlay.rules.length > 0) {
    overlayLayers.push({ id: "_overlay_top_rules", rules: overlay.rules });
  }
  const layerIndex = new Map();
  const ordered = [];
  for (const layer of baseLayers) {
    const clone = { ...layer, rules: Array.isArray(layer.rules) ? [...layer.rules] : [] };
    ordered.push(clone);
    if (clone.id != null) layerIndex.set(clone.id, clone);
  }
  for (const overlayLayer of overlayLayers) {
    if (overlayLayer.id != null && layerIndex.has(overlayLayer.id)) {
      const baseLayer = layerIndex.get(overlayLayer.id);
      const baseRules = Array.isArray(baseLayer.rules) ? baseLayer.rules : [];
      const overlayRules = Array.isArray(overlayLayer.rules) ? overlayLayer.rules : [];
      const ruleIndex = new Map();
      const orderedRules = [];
      for (const rule of baseRules) {
        const clone = { ...rule };
        orderedRules.push(clone);
        if (clone.id != null) ruleIndex.set(clone.id, clone);
      }
      for (const overlayRule of overlayRules) {
        if (overlayRule.id != null && ruleIndex.has(overlayRule.id)) {
          Object.assign(ruleIndex.get(overlayRule.id), overlayRule);
        } else {
          const clone = { ...overlayRule };
          orderedRules.push(clone);
          if (clone.id != null) ruleIndex.set(clone.id, clone);
        }
      }
      const { rules: _ignored, ...rest } = overlayLayer;
      Object.assign(baseLayer, rest);
      baseLayer.rules = orderedRules;
    } else {
      const clone = {
        ...overlayLayer,
        rules: Array.isArray(overlayLayer.rules) ? [...overlayLayer.rules] : [],
      };
      ordered.push(clone);
      if (clone.id != null) layerIndex.set(clone.id, clone);
    }
  }
  merged.layers = ordered;
  return merged;
}

function mergeTargetTemplates(base, overlay) {
  if (!overlay || typeof overlay !== "object") return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (key === "templates") continue;
    merged[key] = value;
  }
  const baseTemplates = Array.isArray(base.templates) ? base.templates : [];
  const overlayTemplates = Array.isArray(overlay.templates) ? overlay.templates : [];
  const index = new Map();
  const ordered = [];
  for (const template of baseTemplates) {
    const clone = { ...template };
    ordered.push(clone);
    if (clone.id != null) index.set(clone.id, clone);
  }
  for (const overlayTemplate of overlayTemplates) {
    if (overlayTemplate.id != null && index.has(overlayTemplate.id)) {
      Object.assign(index.get(overlayTemplate.id), overlayTemplate);
    } else {
      const clone = { ...overlayTemplate };
      ordered.push(clone);
      if (clone.id != null) index.set(clone.id, clone);
    }
  }
  merged.templates = ordered;
  return merged;
}

function mergeCallTemplates(base, overlay) {
  if (!overlay || typeof overlay !== "object") return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (key === "supported" || key === "unsupported") continue;
    merged[key] = value;
  }
  merged.supported = mergeByIdShallow(base.supported, overlay.supported);
  merged.unsupported = mergeByIdShallow(base.unsupported, overlay.unsupported);
  return merged;
}

function mergeByIdShallow(baseList, overlayList) {
  const baseArr = Array.isArray(baseList) ? baseList : [];
  const overlayArr = Array.isArray(overlayList) ? overlayList : [];
  const index = new Map();
  const ordered = [];
  for (const item of baseArr) {
    const clone = { ...item };
    ordered.push(clone);
    if (clone.id != null) index.set(clone.id, clone);
  }
  for (const overlayItem of overlayArr) {
    if (overlayItem.id != null && index.has(overlayItem.id)) {
      Object.assign(index.get(overlayItem.id), overlayItem);
    } else {
      const clone = { ...overlayItem };
      ordered.push(clone);
      if (clone.id != null) index.set(clone.id, clone);
    }
  }
  return ordered;
}

function mergeAgentsMap(base, overlay) {
  if (!overlay || typeof overlay !== "object") return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (key === "fields" || key === "models" || key === "sandbox_modes") continue;
    merged[key] = value;
  }
  const baseFields = Array.isArray(base.fields) ? base.fields : [];
  const overlayFields = Array.isArray(overlay.fields) ? overlay.fields : [];
  const fieldIndex = new Map();
  const orderedFields = [];
  const fieldKey = (entry) => `${entry.claude ?? ""}→${entry.codex ?? ""}`;
  for (const field of baseFields) {
    const clone = { ...field };
    orderedFields.push(clone);
    fieldIndex.set(fieldKey(clone), clone);
  }
  for (const overlayField of overlayFields) {
    const key = fieldKey(overlayField);
    if (fieldIndex.has(key)) {
      Object.assign(fieldIndex.get(key), overlayField);
    } else {
      const clone = { ...overlayField };
      orderedFields.push(clone);
      fieldIndex.set(key, clone);
    }
  }
  merged.fields = orderedFields;

  const baseModels = base.models && typeof base.models === "object" ? base.models : {};
  const overlayModels =
    overlay.models && typeof overlay.models === "object" ? overlay.models : null;
  if (overlayModels) {
    const mergedModels = { ...baseModels };
    for (const [key, value] of Object.entries(overlayModels)) {
      if (key === "tiers") continue;
      mergedModels[key] = value;
    }
    mergedModels.tiers = mergeByIdShallow(baseModels.tiers, overlayModels.tiers);
    merged.models = mergedModels;
  } else if (Object.keys(baseModels).length > 0) {
    merged.models = { ...baseModels };
  }

  const baseSandboxModes =
    base.sandbox_modes && typeof base.sandbox_modes === "object" ? base.sandbox_modes : {};
  const overlaySandboxModes =
    overlay.sandbox_modes && typeof overlay.sandbox_modes === "object"
      ? overlay.sandbox_modes
      : null;
  if (overlaySandboxModes) {
    merged.sandbox_modes = { ...baseSandboxModes, ...overlaySandboxModes };
  } else if (Object.keys(baseSandboxModes).length > 0) {
    merged.sandbox_modes = { ...baseSandboxModes };
  }
  return merged;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function backupPath(plan, targetPath) {
  if (!existsSync(targetPath)) return;

  const backupTarget = join(plan.backupRoot, targetPath.replace(/^\/+/, ""));
  mkdirSync(dirname(backupTarget), { recursive: true });
  cpSync(targetPath, backupTarget, { recursive: true, dereference: false });
}

function backupTargetPath(plan, targetPath) {
  return existsSync(targetPath) ? join(plan.backupRoot, targetPath.replace(/^\/+/, "")) : null;
}

function recordLedger(plan, entry) {
  if (!plan.ledger) return;
  plan.ledger.push({
    scope: plan.scope,
    area: entry.area,
    item: entry.item,
    action: entry.action,
    status: entry.status,
    before_hash: entry.beforeHash ?? null,
    after_hash: entry.target ? hashPath(entry.target) : null,
    backup_path: entry.backupPath ?? null,
    message: entry.message,
  });
}

function diffScope(scope, ignoreRules = []) {
  const paths = scope === "global" ? globalPaths() : projectPaths(process.cwd());
  const entries = [];

  compareInstructions(
    entries,
    scope,
    paths.claude.instructions,
    paths.codex.instructions,
    paths.claude.instructionPaths,
    paths.codex.instructionPaths
  );
  compareSkillDirs(
    entries,
    scope,
    paths.claude.skills,
    paths.codex.skills,
    paths.claude.skillsPaths ?? [paths.claude.skills],
    paths.codex.skillsPaths ?? [paths.codex.skills],
    ignoreRules
  );
  compareAgents(entries, scope, paths.claude.agents, paths.codex.agents, ignoreRules);
  compareMcpServers(
    entries,
    scope,
    paths.claude.mcp,
    paths.codex.mcp,
    paths.claude.mcpPaths,
    paths.codex.mcpPaths
  );

  if (paths.claude.settings && paths.codex.settings) {
    compareSettingsItems(
      entries,
      scope,
      "permissions",
      paths.claude.settings,
      paths.codex.settings
    );
    compareSettingsItems(entries, scope, "hooks", paths.claude.settings, paths.codex.settings);
  }

  if (scope === "global") {
    comparePlugins(entries, scope, paths.claude.plugins, paths.codex.pluginMarketplace);
  }

  return entries;
}

function syncStatePath(scope) {
  const name =
    scope === "global"
      ? "global"
      : `project-${createHash("sha256").update(resolve(process.cwd())).digest("hex").slice(0, 16)}`;
  return `${home}/.ai-config-sync-manager/state/${name}.json`;
}

function readSyncState(scope) {
  const path = syncStatePath(scope);
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object") return null;

  if (parsed.schemaVersion === undefined) {
    console.error(
      `ai-config-sync: state ${path} missing schemaVersion; backfilled to ${STATE_SCHEMA_VERSION}`
    );
    parsed.schemaVersion = STATE_SCHEMA_VERSION;
    return parsed;
  }

  if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(
      `baseline state schema mismatch (expected ${STATE_SCHEMA_VERSION}, got ${parsed.schemaVersion}); back up and remove ${path} or upgrade the CLI`
    );
  }

  return parsed;
}

function writeSyncState(scope) {
  const path = syncStatePath(scope);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(createSyncState(scope), null, 2)}\n`);
}

function createSyncState(scope) {
  const paths = scope === "global" ? globalPaths() : projectPaths(process.cwd());
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    version: 1,
    scope,
    root: scope === "global" ? home : resolve(process.cwd()),
    updatedAt: new Date().toISOString(),
    areas: {
      mcp: {
        claude: Object.keys(readClaudeMcpServers(paths.claude.mcpPaths ?? paths.claude.mcp)).sort(),
        codex: Object.keys(readCodexMcpServers(paths.codex.mcpPaths ?? paths.codex.mcp)).sort(),
      },
      permissions: {
        claude: settingsItems("claude", "permissions", paths.claude.settings),
        codex: settingsItems("codex", "permissions", paths.codex.settings),
      },
      hooks: {
        claude: settingsItems("claude", "hooks", paths.claude.settings),
        codex: settingsItems("codex", "hooks", paths.codex.settings),
      },
      agents: {
        claude: enumerateClaudeAgents(paths.claude.agents)
          .map((agent) => agent.name)
          .sort(),
        codex: enumerateCodexAgents(paths.codex.agents)
          .map((agent) => agent.name)
          .sort(),
      },
      skills: {
        claude: [
          ...enumerateSkillIndex(paths.claude.skillsPaths ?? [paths.claude.skills]).keys(),
        ].sort(),
        codex: [
          ...enumerateSkillIndex(paths.codex.skillsPaths ?? [paths.codex.skills]).keys(),
        ].sort(),
      },
      // TODO: track instructions presence/hash per host once item-level diffs land for that area.
    },
  };
}

function globalPaths() {
  return {
    claude: {
      instructions: `${home}/.claude/CLAUDE.md`,
      instructionPaths: [`${home}/.claude/CLAUDE.md`, `${home}/.claude/settings.json`],
      skills: `${home}/.claude/skills`,
      skillsPaths: [`${home}/.claude/skills`],
      agents: `${home}/.claude/agents`,
      mcp: `${home}/.claude.json`,
      mcpPaths: [`${home}/.claude.json`],
      settings: `${home}/.claude/settings.json`,
      plugins: `${home}/.claude/plugins/installed_plugins.json`,
    },
    codex: {
      instructions: `${home}/.codex/AGENTS.md`,
      instructionPaths: [`${home}/.codex/AGENTS.md`, `${home}/.codex/config.toml`],
      skills: firstExisting([`${home}/.agents/skills`, `${home}/.codex/skills`]),
      skillsPaths: [`${home}/.agents/skills`, `${home}/.codex/skills`],
      agents: `${home}/.codex/agents`,
      mcp: `${home}/.codex/config.toml`,
      mcpPaths: [
        `${home}/.codex/config.toml`,
        `${home}/.codex/mcp.json`,
        `${home}/.codex/settings.json`,
      ],
      settings: `${home}/.codex/config.toml`,
      pluginMarketplace: `${home}/.agents/plugins/marketplace.json`,
    },
  };
}

function projectPaths(root) {
  return {
    claude: {
      instructions: `${root}/CLAUDE.md`,
      instructionPaths: [`${root}/CLAUDE.md`, `${root}/.claude/settings.json`],
      skills: `${root}/.claude/skills`,
      skillsPaths: [`${root}/.claude/skills`],
      agents: `${root}/.claude/agents`,
      mcp: `${root}/.mcp.json`,
      mcpPaths: [`${root}/.mcp.json`, claudeProjectLocalMcpSpec(root)],
      settings: `${root}/.claude/settings.json`,
    },
    codex: {
      instructions: `${root}/AGENTS.md`,
      instructionPaths: [`${root}/AGENTS.md`, `${root}/.codex/config.toml`],
      skills: firstExisting([`${root}/.agents/skills`, `${root}/.codex/skills`]),
      skillsPaths: [`${root}/.agents/skills`, `${root}/.codex/skills`],
      agents: `${root}/.codex/agents`,
      mcp: `${root}/.codex/config.toml`,
      mcpPaths: [
        `${root}/.codex/config.toml`,
        `${root}/.codex/mcp.json`,
        `${root}/.codex/settings.json`,
      ],
      settings: `${root}/.codex/config.toml`,
    },
  };
}

function firstExisting(paths) {
  return paths.find((path) => existsSync(path)) ?? paths[0];
}

function existingPaths(paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  return list.filter((path) => existsSync(claudeMcpSourceFile(path)));
}

function mcpSourceExists(paths) {
  return existingPaths(paths).length > 0;
}

// Claude MCP sources can be expressed as either a plain file path or a file with a
// `#projects:<absRoot>` suffix that points at `data.projects[absRoot].mcpServers`
// inside `~/.claude.json`. Encoding stays a plain string so existing string-based
// readers/writers continue to flow unchanged.
function claudeProjectLocalMcpSpec(root) {
  return `${home}/.claude.json#projects:${root}`;
}

function parseClaudeMcpSource(spec) {
  if (typeof spec !== "string") return { file: spec, projectKey: null };
  const marker = spec.indexOf("#projects:");
  if (marker === -1) return { file: spec, projectKey: null };
  return { file: spec.slice(0, marker), projectKey: spec.slice(marker + "#projects:".length) };
}

function claudeMcpSourceFile(spec) {
  return parseClaudeMcpSource(spec).file;
}

// Display helper: pick the MCP source whose underlying file actually contains
// servers. Falls back to the first existing source so status output never lies
// about which file we inspected.
function firstClaudeMcpDisplayPath(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  for (const spec of paths) {
    if (Object.keys(readClaudeMcpServers(spec)).length > 0) return formatClaudeMcpDisplayPath(spec);
  }
  return formatClaudeMcpDisplayPath(paths[0]);
}

function formatClaudeMcpDisplayPath(spec) {
  const { file, projectKey } = parseClaudeMcpSource(spec);
  return projectKey ? `${file} (projects.${projectKey})` : file;
}

function compareInstructions(
  entries,
  scope,
  claudePath,
  codexPath,
  claudePaths = [claudePath],
  codexPaths = [codexPath]
) {
  const claude = instructionState("claude", claudePaths);
  const codex = instructionState("codex", codexPaths);

  if (!claude.exists && !codex.exists) return;
  const overrides = activeOverridesForFilePair(claudePath, codexPath);
  const masked = maskBodiesWithOverrides(claude.content, codex.content, overrides);
  if (instructionsEquivalent(masked.claudeBody, masked.codexBody)) return;

  if (claude.hash !== codex.hash) {
    entries.push({
      scope,
      area: "instructions",
      risk: "safe",
      summary: "Instructions differ",
      claudePath,
      codexPath,
      claudeInstructionPaths: claude.paths,
      codexInstructionPaths: codex.paths,
      claudeInstructionCheckedPaths: claude.checkedPaths,
      codexInstructionCheckedPaths: codex.checkedPaths,
      claudeInstructionContent: claude.content,
      codexInstructionContent: codex.content,
      claude: claude.summary,
      codex: codex.summary,
      mappingQuality: "equivalent",
    });
  }
}

function instructionsEquivalent(claudeContent, codexContent) {
  return (
    transformTextForHost(claudeContent, "claude", "codex") === String(codexContent ?? "") ||
    transformTextForHost(codexContent, "codex", "claude") === String(claudeContent ?? "")
  );
}

function compareSkillDirs(
  entries,
  scope,
  claudeDir,
  codexDir,
  claudeDirs = [claudeDir],
  codexDirs = [codexDir],
  ignoreRules = []
) {
  const claudeIndex = enumerateSkillIndex(claudeDirs);
  const codexIndex = enumerateSkillIndex(codexDirs);
  const symlinkNames = uniqueStrings([
    ...enumerateSkillSymlinkIndex(claudeDirs).keys(),
    ...enumerateSkillSymlinkIndex(codexDirs).keys(),
  ]);
  const claude = [...claudeIndex.keys()].filter((name) => !symlinkNames.includes(name)).sort();
  const codex = [...codexIndex.keys()].filter((name) => !symlinkNames.includes(name)).sort();
  const missingInCodex = claude.filter((name) => !codexIndex.has(name));
  const missingInClaude = codex.filter((name) => !claudeIndex.has(name));
  const skillsCompareEntry = { scope, area: "skills", claudePath: claudeDir, codexPath: codexDir };
  const conflicts = claude
    .filter((name) => codexIndex.has(name))
    .filter(
      (name) =>
        !skillDirsEquivalent(
          join(claudeIndex.get(name), name),
          join(codexIndex.get(name), name),
          skillsCompareEntry,
          name,
          ignoreRules
        )
    );

  const claudeSkillIndex = Object.fromEntries(claudeIndex);
  const codexSkillIndex = Object.fromEntries(codexIndex);

  if (symlinkNames.length > 0) {
    entries.push({
      scope,
      area: "skills",
      risk: "manual",
      summary: "skill symlink unsupported",
      statusOnly: true,
      claudePath: claudeDir,
      codexPath: codexDir,
      claudeSkillIndex,
      codexSkillIndex,
      claude: `${claude.length} skill(s)`,
      codex: `${codex.length} skill(s)`,
      unsupported: symlinkNames,
      itemQualities: Object.fromEntries(symlinkNames.map((name) => [name, "unsupported"])),
    });
  }

  if (missingInCodex.length > 0 || missingInClaude.length > 0) {
    entries.push({
      scope,
      area: "skills",
      risk: "safe",
      summary: "skills missing in one host",
      claudePath: claudeDir,
      codexPath: codexDir,
      claudeSkillIndex,
      codexSkillIndex,
      claude: `${claude.length} skill(s)`,
      codex: `${codex.length} skill(s)`,
      missingInCodex,
      missingInClaude,
      itemQualities: itemQualities("skills", [...missingInCodex, ...missingInClaude]),
    });
  }

  if (conflicts.length > 0) {
    entries.push({
      scope,
      area: "skills",
      risk: "manual",
      summary: "skills conflict",
      claudePath: claudeDir,
      codexPath: codexDir,
      claudeSkillIndex,
      codexSkillIndex,
      claude: `${claude.length} skill(s)`,
      codex: `${codex.length} skill(s)`,
      conflicts,
      itemQualities: Object.fromEntries(conflicts.map((name) => [name, "unsupported"])),
    });
  }
}

function compareAgents(entries, scope, claudeDir, codexDir, ignoreRules = []) {
  const claudeAgents = enumerateClaudeAgents(claudeDir);
  const codexAgents = enumerateCodexAgents(codexDir);
  const claudeNames = claudeAgents.map((agent) => agent.name).sort();
  const codexNames = codexAgents.map((agent) => agent.name).sort();
  const claudeIndex = new Map(claudeAgents.map((agent) => [agent.name, agent]));
  const codexIndex = new Map(codexAgents.map((agent) => [agent.name, agent]));

  const missingInCodex = claudeNames.filter((name) => !codexIndex.has(name));
  const missingInClaude = codexNames.filter((name) => !claudeIndex.has(name));
  const agentsCompareEntry = { scope, area: "agents", claudePath: claudeDir, codexPath: codexDir };
  const conflicts = claudeNames
    .filter((name) => codexIndex.has(name))
    .filter(
      (name) =>
        !agentsEquivalent(
          claudeIndex.get(name),
          codexIndex.get(name),
          agentsCompareEntry,
          name,
          ignoreRules
        )
    );

  // Per-name path lookup for downstream preview/apply. Required because Claude agents
  // can live one folder deep (e.g. .claude/agents/code-writer/code-writer-logic.md);
  // a flat baseDir + ${name}.md guess misses them after canonical-name matching.
  const claudeAgentPaths = Object.fromEntries(
    claudeAgents.map((agent) => [agent.name, agent.path])
  );
  const codexAgentPaths = Object.fromEntries(codexAgents.map((agent) => [agent.name, agent.path]));

  if (missingInCodex.length > 0 || missingInClaude.length > 0) {
    entries.push({
      scope,
      area: "agents",
      risk: "safe",
      summary: "agents missing in one host",
      claudePath: claudeDir,
      codexPath: codexDir,
      claudeAgentPaths,
      codexAgentPaths,
      claude: `${claudeNames.length} agent(s)`,
      codex: `${codexNames.length} agent(s)`,
      missingInCodex,
      missingInClaude,
      itemQualities: itemQualities("agents", [...missingInCodex, ...missingInClaude]),
    });
  }

  if (conflicts.length > 0) {
    entries.push({
      scope,
      area: "agents",
      risk: "manual",
      summary: "agents conflict",
      claudePath: claudeDir,
      codexPath: codexDir,
      claudeAgentPaths,
      codexAgentPaths,
      claude: `${claudeNames.length} agent(s)`,
      codex: `${codexNames.length} agent(s)`,
      conflicts,
      itemQualities: Object.fromEntries(conflicts.map((name) => [name, "unsupported"])),
    });
  }
}

function comparePlugins(entries, scope, claudePluginsManifest, codexMarketplacePath) {
  if (scope !== "global") return;

  const claudePlugins = readClaudeInstalledPlugins(claudePluginsManifest);
  const codexPlugins = readCodexMarketplacePlugins(codexMarketplacePath);

  const SELF_MANAGED = new Set(["config-manager@ai-config-sync-manager", "ai-config-sync-manager"]);
  const claudeFiltered = claudePlugins.filter((name) => !SELF_MANAGED.has(name));
  const codexFiltered = codexPlugins.filter((name) => !SELF_MANAGED.has(name));

  if (claudeFiltered.length === 0 && codexFiltered.length === 0) return;

  const allNames = uniqueStrings([...claudeFiltered, ...codexFiltered]).sort();
  entries.push({
    scope,
    area: "plugins",
    risk: "manual",
    summary: "plugin sync unsupported",
    statusOnly: true,
    claudePath: claudePluginsManifest,
    codexPath: codexMarketplacePath,
    claude: `${claudeFiltered.length} plugin(s)`,
    codex: `${codexFiltered.length} plugin(s)`,
    unsupported: allNames,
    itemQualities: Object.fromEntries(allNames.map((name) => [name, "unsupported"])),
  });
}

function readClaudeInstalledPlugins(manifestPath) {
  if (!existsSync(manifestPath)) return [];
  try {
    const data = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!data?.plugins || typeof data.plugins !== "object") return [];
    return Object.keys(data.plugins);
  } catch {
    return [];
  }
}

function readCodexMarketplacePlugins(marketplacePath) {
  if (!existsSync(marketplacePath)) return [];
  try {
    const data = JSON.parse(readFileSync(marketplacePath, "utf8"));
    if (!Array.isArray(data?.plugins)) return [];
    return data.plugins.map((p) => p?.name).filter((n) => typeof n === "string" && n.length > 0);
  } catch {
    return [];
  }
}

function enumerateClaudeAgents(dir) {
  if (!dir || !existsSync(dir)) return [];
  const agents = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const path = join(dir, entry.name);
      const stem = entry.name.slice(0, -3);
      agents.push({
        name: canonicalAgentName(parseClaudeAgentFile(path).frontmatter?.name, stem),
        path,
        group: null,
      });
    } else if (entry.isDirectory()) {
      const groupDir = join(dir, entry.name);
      for (const child of readdirSync(groupDir, { withFileTypes: true })) {
        if (!child.isFile() || !child.name.endsWith(".md")) continue;
        const path = join(groupDir, child.name);
        const stem = child.name.slice(0, -3);
        agents.push({
          name: canonicalAgentName(parseClaudeAgentFile(path).frontmatter?.name, stem),
          path,
          group: entry.name,
        });
      }
    }
  }
  return agents;
}

function enumerateCodexAgents(dir) {
  if (!dir || !existsSync(dir)) return [];
  const agents = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".toml")) continue;
    const path = join(dir, entry.name);
    const stem = entry.name.slice(0, -5);
    agents.push({ name: canonicalAgentName(parseCodexAgentFile(path).name, stem), path });
  }
  return agents;
}

function canonicalAgentName(rawName, fallbackStem) {
  const candidate = typeof rawName === "string" ? rawName.trim() : "";
  const source = candidate || fallbackStem || "";
  return source.replace(/\//g, "-");
}

function agentsEquivalent(claudeAgent, codexAgent, entry, item, rules) {
  if (!claudeAgent || !codexAgent) return false;
  const claude = parseClaudeAgentFile(claudeAgent.path);
  const codex = parseCodexAgentFile(codexAgent.path);
  const terms = entry
    ? uniqueStrings([
        ...applicableTermRules(rules ?? [], entry, item, "claude"),
        ...applicableTermRules(rules ?? [], entry, item, "codex"),
      ])
    : [];
  const overrides = activeOverridesForFilePair(claudeAgent.path, codexAgent.path);
  const { claudeBody, codexBody } = maskBodiesWithOverrides(
    claude.body,
    codex.developer_instructions,
    overrides
  );
  return agentBodiesEqual(claudeBody, codexBody, terms);
}

function agentBodiesEqual(claudeBody, codexBody, terms) {
  const left = stripAgentMigrationPreamble(claudeBody ?? "").replace(/\n+$/, "");
  const right = stripAgentMigrationPreamble(codexBody ?? "").replace(/\n+$/, "");
  if (left === right) return true;
  if (transformTextForHost(left, "claude", "codex") === right) return true;
  if (transformTextForHost(right, "codex", "claude") === left) return true;

  if (terms && terms.length > 0) {
    const expandedTerms = expandTermsBothDirections(terms);
    const maskedLeft = maskLinesContaining(left, expandedTerms);
    const maskedRight = maskLinesContaining(right, expandedTerms);
    if (maskedLeft === maskedRight) return true;
    if (
      maskLinesContaining(transformTextForHost(left, "claude", "codex"), expandedTerms) ===
      maskedRight
    )
      return true;
    if (
      maskedLeft ===
      maskLinesContaining(transformTextForHost(right, "codex", "claude"), expandedTerms)
    )
      return true;
  }
  return false;
}

function stripAgentMigrationPreamble(text) {
  const pattern = agentMigrationPreamblePattern();
  return pattern ? String(text ?? "").replace(pattern, "") : String(text ?? "");
}

function agentMigrationPreamblePattern() {
  const source = agentsMapData().migration_preamble_pattern;
  if (typeof source !== "string" || !source) return null;
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

function parseClaudeAgentFile(path) {
  if (!existsSync(path)) return { frontmatter: {}, body: "" };
  const text = readFileSync(path, "utf8");
  return parseClaudeAgentText(text);
}

function parseClaudeAgentText(text) {
  if (!text.startsWith("---")) return { frontmatter: {}, body: text };
  const closing = text.indexOf("\n---", 3);
  if (closing === -1) return { frontmatter: {}, body: text };
  const header = text.slice(3, closing).replace(/^\r?\n/, "");
  const bodyStart = closing + 4;
  const body = text.slice(bodyStart).replace(/^\r?\n/, "");
  return { frontmatter: parseClaudeFrontmatter(header), body };
}

function parseClaudeFrontmatter(header) {
  const result = {};
  for (const rawLine of header.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (!key) continue;
    const rawValue = line.slice(separator + 1).trim();
    result[key] = parseFrontmatterScalar(rawValue);
  }
  return result;
}

function parseFrontmatterScalar(raw) {
  if (raw === "") return "";
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return parseJsonLike(raw, raw.slice(1, -1));
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

function serializeClaudeAgentFile(frontmatter, body) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null || value === "") continue;
    lines.push(`${key}: ${serializeYamlScalar(value)}`);
  }
  lines.push("---", "");
  const trailing = body.endsWith("\n") ? body : `${body}\n`;
  return `${lines.join("\n")}${trailing}`;
}

function parseCodexAgentFile(path) {
  if (!existsSync(path))
    return { name: "", description: "", model: "", developer_instructions: "" };
  return parseCodexAgentText(readFileSync(path, "utf8"));
}

function parseCodexAgentText(text) {
  const fields = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (!match) continue;
    fields[match[1]] = parseTomlScalar(match[2]);
  }
  return {
    name: fields.name ?? "",
    description: fields.description ?? "",
    model: fields.model ?? "",
    model_reasoning_effort: fields.model_reasoning_effort,
    sandbox_mode: fields.sandbox_mode,
    developer_instructions: fields.developer_instructions ?? "",
  };
}

function serializeCodexAgentFile(fields) {
  const lines = [];
  for (const key of [
    "name",
    "description",
    "model",
    "model_reasoning_effort",
    "sandbox_mode",
    "developer_instructions",
  ]) {
    const value = fields[key];
    if (value === undefined || value === null || value === "") continue;
    lines.push(`${key} = ${JSON.stringify(String(value))}`);
  }
  return `${lines.join("\n")}\n`;
}

function mapAgentToCodex(claude, options = {}) {
  const aliases = modelAliasMap("claude", "codex");
  const fm = claude.frontmatter ?? {};
  const rawBody = claude.body ?? "";
  const body = transformTextForHost(rawBody, "claude", "codex", {
    callArchive: options.callArchive,
  });
  recordVocabFindings(options.callArchive, lintHostVocab(body, "codex"), "claude", "codex");
  const fallbackName = (typeof options.fallbackName === "string" && options.fallbackName) || "";
  const name = (fm.name && String(fm.name).trim()) || fallbackName;
  const description =
    (fm.description && String(fm.description).trim()) ||
    extractDescriptionFromBody(rawBody) ||
    name;
  const codexFields = {
    name,
    description,
    model: aliases[fm.model] ?? fm.model ?? "",
    developer_instructions: body,
  };
  const sandboxMode = codexSandboxModeForClaudeTools(fm.tools);
  if (sandboxMode) codexFields.sandbox_mode = sandboxMode;
  if (options.preserveCodex?.model_reasoning_effort) {
    codexFields.model_reasoning_effort = options.preserveCodex.model_reasoning_effort;
  }
  return codexFields;
}

function extractDescriptionFromBody(body) {
  const text = String(body ?? "").replace(/\r\n/g, "\n");
  const paragraphs = text.split(/\n{2,}/);
  for (const paragraph of paragraphs) {
    const lines = paragraph
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    if (lines.length === 0) continue;
    const oneLine = lines.join(" ").replace(/\s+/g, " ").trim();
    if (!oneLine) continue;
    return oneLine.length > 200 ? `${oneLine.slice(0, 197).trimEnd()}...` : oneLine;
  }
  return "";
}

function mapAgentToClaude(codex, options = {}) {
  const aliases = modelAliasMap("codex", "claude");
  const body = transformTextForHost(
    stripAgentMigrationPreamble(codex.developer_instructions ?? ""),
    "codex",
    "claude",
    { callArchive: options.callArchive }
  );
  recordVocabFindings(options.callArchive, lintHostVocab(body, "claude"), "codex", "claude");
  const frontmatter = {
    name: codex.name ?? "",
    description: codex.description ?? "",
    model: aliases[codex.model] ?? codex.model ?? "",
  };
  const sandboxTools = claudeToolsForCodexSandboxMode(codex.sandbox_mode);
  if (sandboxTools) frontmatter.tools = sandboxTools;
  const preserved = options.preserveClaude ?? {};
  for (const key of ["tools", "color", "memory"]) {
    if (preserved[key] === undefined || preserved[key] === "") continue;
    if (key === "tools") {
      if (sandboxTools) continue;
      const { sanitized, removed } = sanitizeAgentToolsField(preserved.tools, "claude");
      if (sanitized) frontmatter.tools = sanitized;
      if (removed.length && Array.isArray(options.callArchive)) {
        pushArchiveEntry(options.callArchive, {
          direction: "preserve->claude",
          rule_id: "host-strict-vocab",
          call: "agent.tools",
          action: "vocab-mismatch-sanitized",
          original: preserved.tools,
          fields: { removed, kept: sanitized },
          reason: `tools field had codex-only tokens stripped: ${removed.join(", ")}`,
        });
      }
    } else {
      frontmatter[key] = preserved[key];
    }
  }
  return { frontmatter, body };
}

function claudeToolsForCodexSandboxMode(mode) {
  if (!agentFieldMapping("tools", "sandbox_mode")) return "";
  const tools = agentsMapData().sandbox_modes?.[mode]?.claude?.tools;
  if (Array.isArray(tools)) return tools.filter(Boolean).join(", ");
  return typeof tools === "string" ? tools : "";
}

function codexSandboxModeForClaudeTools(toolsValue) {
  if (!agentFieldMapping("tools", "sandbox_mode")) return "";
  const tools = splitAgentTools(toolsValue);
  if (tools.length === 0) return "";
  if (tools.some((tool) => ["Edit", "MultiEdit", "Write"].includes(tool))) return "workspace-write";
  const modes = agentsMapData().sandbox_modes ?? {};
  for (const [mode, spec] of Object.entries(modes)) {
    const mapped = splitAgentTools(spec?.claude?.tools);
    if (mapped.length === 0) continue;
    if (tools.every((tool) => mapped.includes(tool))) return mode;
  }
  return "";
}

function splitAgentTools(value) {
  if (Array.isArray(value)) return value.map((tool) => String(tool).trim()).filter(Boolean);
  return String(value ?? "")
    .split(/\s*,\s*/)
    .map((tool) => tool.trim())
    .filter(Boolean);
}

function agentFieldMapping(claude, codex) {
  const fields = agentsMapData().fields;
  if (!Array.isArray(fields)) return null;
  return fields.find((field) => field?.claude === claude && field?.codex === codex) ?? null;
}

function modelTiers() {
  const tiers = agentsMapData().models?.tiers;
  return Array.isArray(tiers) ? tiers : [];
}

function modelAliasMap(from, to) {
  const aliases = {};
  for (const tier of modelTiers()) {
    const sourceAlias = tier?.[from]?.alias;
    const targetAlias = tier?.[to]?.alias;
    if (
      typeof sourceAlias === "string" &&
      sourceAlias &&
      typeof targetAlias === "string" &&
      targetAlias
    ) {
      aliases[sourceAlias] = targetAlias;
    }
  }
  return aliases;
}

function modelTerminologyRules() {
  return modelTiers()
    .map((tier) => ({
      id: tier?.id ?? "model-tier",
      claude: [
        tier?.claude?.alias,
        ...(Array.isArray(tier?.claude?.terms) ? tier.claude.terms : []),
      ].filter((value) => typeof value === "string" && value),
      codex: [
        tier?.codex?.alias,
        ...(Array.isArray(tier?.codex?.terms) ? tier.codex.terms : []),
      ].filter((value) => typeof value === "string" && value),
    }))
    .filter((rule) => rule.claude.length > 0 && rule.codex.length > 0);
}

function agentsMapData() {
  return agentsMapSource().data;
}

function agentsMapPath() {
  return agentsMapSource().path;
}

function agentsMapSource() {
  return loadLayeredRule(
    agentsMapCandidates(),
    { fields: [], models: { tiers: [] } },
    mergeAgentsMap
  );
}

function agentsMapCandidates() {
  return [
    join(resolve(process.cwd()), "rules/agents-map.json"),
    `${home}/.ai-config-sync-manager/rules/agents-map.json`,
    join(runtimeRoot, "rules/agents-map.json"),
  ];
}

function agentTargetPath(name, baseDir, host, sourceAgent) {
  if (host === "codex") {
    const flatName = name.includes("/") ? name.split("/").pop() : name;
    return join(baseDir, `${flatName}.toml`);
  }

  if (sourceAgent?.group) {
    return join(baseDir, sourceAgent.group, `${sourceAgent.name.split("/").pop()}.md`);
  }
  if (name.includes("/")) {
    return join(baseDir, `${name}.md`);
  }
  return join(baseDir, `${name}.md`);
}

function compareMcpServers(
  entries,
  scope,
  claudePath,
  codexPath,
  claudePaths = [claudePath],
  codexPaths = [codexPath]
) {
  const claudeServers = readClaudeMcpServers(claudePaths);
  const codexServers = readCodexMcpServers(codexPaths);
  const claudeNames = Object.keys(claudeServers).sort();
  const codexNames = Object.keys(codexServers).sort();
  const missingInCodex = claudeNames.filter((name) => !codexNames.includes(name));
  const missingInClaude = codexNames.filter((name) => !claudeNames.includes(name));
  const conflicts = claudeNames
    .filter((name) => codexNames.includes(name))
    .filter(
      (name) => mcpServerSignature(claudeServers[name]) !== mcpServerSignature(codexServers[name])
    )
    .sort();

  if (missingInCodex.length === 0 && missingInClaude.length === 0 && conflicts.length === 0) return;

  entries.push({
    scope,
    area: "mcp",
    risk: conflicts.length > 0 ? "manual" : "safe",
    summary: "MCP servers differ",
    claudePath,
    codexPath,
    claudeMcpPaths: existingPaths(claudePaths),
    codexMcpPaths: existingPaths(codexPaths),
    claude: `${claudeNames.length} server(s)`,
    codex: `${codexNames.length} server(s)`,
    missingInCodex,
    missingInClaude,
    conflicts,
    itemQualities: itemQualities("mcp", [...missingInCodex, ...missingInClaude, ...conflicts]),
  });
}

function mcpServerSignature(server) {
  if (!server) return "";
  const env = Object.fromEntries(
    Object.entries(server.env ?? {}).sort(([left], [right]) => left.localeCompare(right))
  );
  const headers = Object.fromEntries(
    Object.entries(server.headers ?? {}).sort(([left], [right]) => left.localeCompare(right))
  );
  return JSON.stringify({
    command: server.command ?? null,
    url: server.url ?? null,
    args: server.args ?? [],
    env,
    bearerTokenEnvVar: server.bearerTokenEnvVar ?? null,
    headers,
  });
}

function compareSettingsItems(entries, scope, area, claudePath, codexPath) {
  const claude = settingsItems("claude", area, claudePath);
  const codex = settingsItems("codex", area, codexPath);
  let missingInCodex = settingsItemsMissingFrom(area, claude, codex);
  let missingInClaude = settingsItemsMissingFrom(area, codex, claude);

  if (area === "permissions") {
    // Server-scope `allow:mcp__<server>` round-trips through Codex as a noop (Codex defaults
    // to allowing every tool on a configured MCP server). If the codex side has the server
    // table without an explicit `enabled_tools = []` deny, treat the claude permission as
    // satisfied even though codex emits no item-level entry to capability-match against.
    const codexUnrestrictedServers = codexUnrestrictedMcpServers(codexPath);
    missingInCodex = missingInCodex.filter(
      (name) => !isServerScopeMcpAllowSatisfied(name, codexUnrestrictedServers)
    );
  }

  if (missingInCodex.length === 0 && missingInClaude.length === 0) return;

  entries.push({
    scope,
    area,
    risk: "manual",
    summary: `${label(area)} differ`,
    claudePath,
    codexPath,
    claude: `${claude.length} item(s)`,
    codex: `${codex.length} item(s)`,
    missingInCodex,
    missingInClaude,
    itemQualities: itemQualities(area, [...missingInCodex, ...missingInClaude]),
  });
}

function settingsItemsMissingFrom(area, sourceItems, targetItems) {
  if (area !== "permissions") {
    return sourceItems.filter((name) => !targetItems.includes(name));
  }

  const targetCapabilities = new Set(targetItems.map(permissionCapability));
  return sourceItems.filter((name) => {
    if (itemMappingQuality(area, name) === "unsupported") return false;
    return !targetCapabilities.has(permissionCapability(name));
  });
}

function codexUnrestrictedMcpServers(codexPath) {
  const servers = new Set();
  if (!codexPath || !existsSync(codexPath) || !codexPath.endsWith(".toml")) return servers;
  const text = readFileSync(codexPath, "utf8");
  const tablePattern = /^\[mcp_servers\.([^\]]+)\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/gm;

  for (const match of text.matchAll(tablePattern)) {
    if (match[1].includes(".")) continue;
    const enabledDeclared = hasTomlKey(match[2], "enabled_tools");
    const enabled = parseTomlStringArray(match[2], "enabled_tools");
    if (enabledDeclared && enabled.length === 0) continue; // explicit deny-all
    servers.add(match[1].replaceAll("-", "_"));
  }

  return servers;
}

function isServerScopeMcpAllowSatisfied(itemName, codexUnrestrictedServers) {
  const { bucket, value } = parsePermissionItem(itemName);
  if (bucket !== "allow") return false;
  const mcp = parseMcpPermission(value);
  if (!mcp || !isMcpServerScopePermission(mcp)) return false;
  return codexUnrestrictedServers.has(mcp.server.replaceAll("-", "_"));
}

function permissionCapability(itemName) {
  const { bucket, value } = parsePermissionItem(itemName);

  if (["Write", "Edit", "MultiEdit"].includes(value)) {
    return `${bucket}:filesystem-write`;
  }

  const mcp = parseMcpPermission(value);
  if (mcp) {
    if (isMcpServerScopePermission(mcp)) {
      return `${bucket}:mcp-server:${mcp.server}`;
    }
    return `${bucket}:mcp-tool:${mcp.server}:${mcp.tool}`;
  }

  const rule = codexPrefixRuleForPermission(bucket, value);
  if (rule) {
    return `${bucket}:bash-prefix:${rule}`;
  }

  if (value === "WebSearch" || value === "WebFetch") {
    return `${bucket}:web-search`;
  }

  return `${bucket}:${value}`;
}

function itemQualities(area, items) {
  return Object.fromEntries(items.map((item) => [item, itemMappingQuality(area, item)]));
}

function itemMappingQuality(area, item) {
  if (area === "mcp" || area === "skills" || area === "agents") return "exact";
  if (area === "hooks") return "equivalent";
  if (area !== "permissions") return "unsupported";

  const { bucket, value } = parsePermissionItem(item);
  if (parseMcpPermission(value)) return "exact";
  if (isAgentPermission(value)) return "unsupported";

  const rule = codexPrefixRuleForPermission(bucket, value);
  if (rule) return "exact";
  if (["Write", "Edit", "MultiEdit"].includes(value)) return "equivalent";
  if (bucket === "allow" && value === "WebSearch") return "exact";
  if (bucket === "allow" && value === "WebFetch") return "approximate";
  // SendMessage has no codex equivalent; the earlier branches already cover
  // every other command-like value (mcp__*, Agent, Bash, Bash(...), WebFetch,
  // WebSearch), so the only fall-through here is SendMessage itself.
  if (value === "SendMessage") return "unsupported";
  if (isCommandLikePermission(value)) return "metadata-only";

  return "unsupported";
}

function settingsItems(host, area, path) {
  if (!existsSync(path)) return [];

  if (host === "claude") {
    return claudeSettingsItems(area, path);
  }

  return codexSettingsItems(area, path);
}

function claudeSettingsItems(area, path) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));

    if (area === "permissions") {
      return uniqueStrings([
        ...permissionItems("allow", data.permissions?.allow),
        ...permissionItems("deny", data.permissions?.deny),
        ...permissionItems("ask", data.permissions?.ask),
      ]);
    }

    if (area === "hooks") {
      return Object.keys(data.hooks ?? {}).sort();
    }
  } catch {
    return [];
  }

  return [];
}

function permissionItems(prefix, values) {
  if (!Array.isArray(values)) return [];
  return values.filter((value) => typeof value === "string").map((value) => `${prefix}:${value}`);
}

function codexSettingsItems(area, path) {
  const text = readFileSync(path, "utf8");
  const items = [];

  if (area === "permissions") {
    for (const item of codexWebSearchPermissionItems(text)) {
      items.push(item);
    }
    for (const item of codexSandboxPermissionItems(text)) {
      items.push(item);
    }
    for (const item of codexNetworkAccessPermissionItems(text)) {
      items.push(item);
    }
    for (const item of codexRulePermissionItems(codexRulesPath(path))) {
      items.push(item);
    }
    for (const item of codexMcpApprovalItems(text)) {
      items.push(item);
    }
    for (const item of codexMcpToolListItems(text)) {
      items.push(item);
    }
  }

  if (area === "hooks") {
    for (const match of text.matchAll(/^\s*\[\[hooks\.([A-Za-z0-9_-]+)\]\]/gm)) {
      items.push(match[1]);
    }
  }

  return uniqueStrings(items);
}

function codexWebSearchPermissionItems(text) {
  const match = text.match(/^\s*web_search\s*=\s*"([^"]+)"/m);
  if (!match || match[1] !== "live") return [];
  return ["allow:WebSearch"];
}

function codexSandboxPermissionItems(text) {
  const sandbox = text.match(/^\s*sandbox_mode\s*=\s*"([^"]+)"/m);
  if (sandbox?.[1] === "workspace-write") {
    return ["allow:Write", "allow:Edit", "allow:MultiEdit"];
  }

  return [];
}

function codexNetworkAccessPermissionItems(text) {
  const tablePattern = /^\[sandbox_workspace_write\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m;
  const match = text.match(tablePattern);
  if (!match) return [];

  const network = match[1].match(/^\s*network_access\s*=\s*(true|false)\b/m);
  if (network?.[1] !== "true") return [];

  return ["allow:WebFetch"];
}

function codexRulePermissionItems(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const items = [];

  for (const match of text.matchAll(
    /prefix_rule\(pattern=(\[[^)]*?\]),\s*decision="(allow|prompt|forbidden)"/g
  )) {
    const parts = parseJsonLike(match[1], []);
    if (!Array.isArray(parts) || parts.some((part) => typeof part !== "string")) continue;

    const bucket = match[2] === "forbidden" ? "deny" : match[2] === "prompt" ? "ask" : "allow";
    const isBareBash = parts.length === 0 || (parts.length === 1 && parts[0] === "bash");
    const value = isBareBash ? "Bash" : `Bash(${parts.join(" ")}:*)`;
    items.push(`${bucket}:${value}`);
  }

  return items;
}

function codexMcpApprovalItems(text) {
  const items = [];
  const tablePattern =
    /^\[mcp_servers\.([^\].]+)\.tools\.([^\]]+)\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/gm;

  for (const match of text.matchAll(tablePattern)) {
    const approval = match[3].match(/^approval_mode\s*=\s*"([^"]+)"/m);
    if (!approval) continue;

    const bucket = approval[1] === "deny" ? "deny" : approval[1] === "prompt" ? "ask" : "allow";
    items.push(`${bucket}:mcp__${match[1].replaceAll("-", "_")}__${match[2]}`);
  }

  return items;
}

function codexMcpToolListItems(text) {
  const items = [];
  const tablePattern = /^\[mcp_servers\.([^\]]+)\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/gm;

  for (const match of text.matchAll(tablePattern)) {
    if (match[1].includes(".")) continue; // skip nested tables like mcp_servers.<server>.tools.<tool>
    const server = match[1].replaceAll("-", "_");
    const enabled = parseTomlStringArray(match[2], "enabled_tools");
    const disabled = parseTomlStringArray(match[2], "disabled_tools");
    const enabledDeclared = hasTomlKey(match[2], "enabled_tools");

    for (const tool of enabled) {
      items.push(`allow:mcp__${server}__${tool}`);
    }
    for (const tool of disabled) {
      items.push(`deny:mcp__${server}__${tool}`);
    }

    // An explicit empty `enabled_tools = []` is a server-scope deny.
    if (enabledDeclared && enabled.length === 0) {
      items.push(`deny:mcp__${server}`);
    }
  }

  return items;
}

function hasTomlKey(text, key) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, "m");
  return pattern.test(text);
}

function parseTomlStringArray(text, key) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(\\[[^\\]]*\\])`, "m");
  const match = text.match(pattern);
  if (!match) return [];

  const values = parseJsonLike(match[1], []);
  return Array.isArray(values) ? values.filter((value) => typeof value === "string") : [];
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function skillNames(dir) {
  if (!existsSync(dir)) return [];
  // The marker file pins Codex's vendored "system" skill bundle (.system/). When a
  // marker is present at the root we are scanning into, treat the dir as opaque so
  // its contents never enumerate as user skills.
  if (existsSync(join(dir, ".codex-system-skills.marker"))) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .sort();
}

function skillSymlinkNames(dir) {
  if (!existsSync(dir)) return [];
  if (existsSync(join(dir, ".codex-system-skills.marker"))) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .sort();
}

// First-wins union: earlier dirs in the list take precedence for duplicate skill names.
function enumerateSkillIndex(dirs) {
  const list = Array.isArray(dirs) ? dirs : [dirs];
  const index = new Map();
  for (const dir of list) {
    if (!dir) continue;
    for (const name of skillNames(dir)) {
      if (!index.has(name)) index.set(name, dir);
    }
  }
  return index;
}

function enumerateSkillSymlinkIndex(dirs) {
  const list = Array.isArray(dirs) ? dirs : [dirs];
  const index = new Map();
  for (const dir of list) {
    if (!dir) continue;
    for (const name of skillSymlinkNames(dir)) {
      if (!index.has(name)) index.set(name, dir);
    }
  }
  return index;
}

// Skill manifest filename differs by host: Claude uses lowercase skill.md, Codex uses SKILL.md.
// Authors may have mixed-case skills on either side; helpers explicitly check both casings.
function skillManifestBasename(host) {
  return host === "claude" ? "skill.md" : "SKILL.md";
}

function findSkillManifest(skillDir, hostHint) {
  if (!skillDir || !existsSync(skillDir)) return null;
  let entries;
  try {
    entries = readdirSync(skillDir);
  } catch {
    return null;
  }
  const present = new Set(entries);
  for (const name of skillManifestLookupOrder(hostHint)) {
    if (present.has(name)) return join(skillDir, name);
  }
  return null;
}

function skillManifestFilenames() {
  const rules = terminologyRules(terminologyMapSource().data);
  const rule = rules.find((r) => r?.id === "skill-manifest-filename");
  return {
    claude: typeof rule?.claude_replace === "string" ? rule.claude_replace : "skill.md",
    codex: typeof rule?.codex_replace === "string" ? rule.codex_replace : "SKILL.md",
  };
}

function skillManifestLookupOrder(hostHint) {
  const { claude, codex } = skillManifestFilenames();
  return hostHint === "claude" ? [claude, codex] : [codex, claude];
}

function isSkillManifestBasename(name) {
  const { claude, codex } = skillManifestFilenames();
  return name === claude || name === codex;
}

function instructionState(host, paths) {
  const checkedPaths = Array.isArray(paths) ? paths : [paths];
  const sources = instructionSources(host, paths);
  if (sources.length === 0)
    return {
      exists: false,
      hash: "missing",
      summary: "missing",
      paths: [],
      checkedPaths,
      content: "",
    };

  const content = sources
    .map((source) => source.content)
    .join("\n--- ai-config-sync instruction source ---\n");
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  return {
    exists: true,
    hash,
    summary: `${sources.length} source(s) sha256:${hash}`,
    paths: sources.map((source) => source.path),
    checkedPaths,
    content,
  };
}

function instructionSources(host, paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  return list.flatMap((path) => instructionSource(host, path)).filter(Boolean);
}

function instructionSource(host, path) {
  if (!path || !existsSync(path)) return [];
  if (path.endsWith(".json")) return jsonInstructionSources(host, path);
  if (path.endsWith(".toml")) return tomlInstructionSources(path);
  return [{ path, content: readFileSync(path, "utf8") }];
}

function jsonInstructionSources(host, path) {
  const data = readJsonFile(path, {});
  const values = [];

  for (const key of [
    "instructions",
    "instruction",
    "systemPrompt",
    "system_prompt",
    "appendSystemPrompt",
    "append_system_prompt",
  ]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) {
      values.push({ path: `${path}#${key}`, content: value });
    }
  }

  if (host === "codex") {
    for (const key of ["developer_instructions", "user_instructions"]) {
      const value = data[key];
      if (typeof value === "string" && value.trim()) {
        values.push({ path: `${path}#${key}`, content: value });
      }
    }
  }

  return values;
}

function tomlInstructionSources(path) {
  const text = readFileSync(path, "utf8");
  const values = [];

  for (const key of [
    "instructions",
    "instruction",
    "developer_instructions",
    "user_instructions",
  ]) {
    const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.+)$`, "m");
    const match = text.match(pattern);
    if (!match) continue;

    const value = parseTomlScalar(match[1]);
    if (typeof value === "string" && value.trim()) {
      values.push({ path: `${path}#${key}`, content: value });
    }
  }

  return values;
}

// Replace a skill manifest basename with a casing-neutral sentinel so two skills
// with identical content but differing manifest casing (skill.md vs SKILL.md)
// share a single normalized path.
function normalizeSkillPath(file) {
  const segments = file.split("/");
  const last = segments[segments.length - 1];
  if (!isSkillManifestBasename(last)) return file;
  return [...segments.slice(0, -1), "__skill_manifest__.md"].join("/");
}

// Pair each raw skill file path with its normalized form, then sort by the
// normalized path so claude (skill.md) and codex (SKILL.md) iterate the same
// logical files in the same order before hashing.
function sortedSkillFiles(path) {
  return directoryFiles(path)
    .map((raw) => ({ raw, normalized: normalizeSkillPath(raw) }))
    .sort((a, b) => (a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : 0));
}

// Read a skill file's bytes for hashing, canonicalizing YAML frontmatter when the
// file is a skill manifest (skill.md / SKILL.md). Claude's lenient YAML loader
// tolerates unquoted colon-containing scalars while Codex's strict 1.2 loader does
// not — our forward writer quotes them, so the same logical manifest can have
// byte-different forms on each side. Hashing the canonical form makes those
// quote-only diffs invisible to skillDirsEquivalent without mutating source files.
function readSkillFileForHash(path, raw) {
  const absolute = join(path, raw);
  const content = readFileSync(absolute);
  if (!isTextMappingFile(absolute)) return content;
  return Buffer.from(normalizeSkillFileText(content.toString("utf8"), raw, absolute), "utf8");
}

function normalizeSkillFileText(text, raw, absolute) {
  if (!isTextMappingFile(absolute)) return text;
  const basename = raw.split("/").pop();
  const normalized = isSkillManifestBasename(basename) ? normalizeYamlFrontmatter(text) : text;
  return normalizeComparableAgentPaths(normalized);
}

// Apply override masks to RAW skill-file text using the override's raw-file
// line numbers, then normalize. Status comparison relies on normalized
// frontmatter for equivalence, but override line numbers are recorded
// against raw file lines (paraphrase --apply writes raw lines). Masking
// after normalize would silently miss the target line because frontmatter
// normalization can shift body line numbers (e.g. codex SKILL.md heading
// L9 -> L7 once host-only fields like model_reasoning_effort and
// sandbox_mode are stripped).
function readSkillFileMaskedForHash(path, raw, host, overrides) {
  const absolute = join(path, raw);
  const content = readFileSync(absolute);
  if (!isTextMappingFile(absolute)) return content;
  const root = expandHome(path);
  const pathKey = host === "claude" ? "claude_path" : "codex_path";
  const lineKey = host === "claude" ? "claude_line" : "codex_line";
  const textKey = host === "claude" ? "claude_text" : "codex_text";
  const fileOverrides = (overrides ?? []).filter((entry) =>
    overrideMatchesSkillFile(entry[pathKey], root, raw)
  );
  let text = content.toString("utf8");
  for (const entry of fileOverrides) {
    const sentinel = ` PO:${entry.id} `;
    text = maskBodyAtLine(text, entry[lineKey], entry[textKey], sentinel);
  }
  return Buffer.from(normalizeSkillFileText(text, raw, absolute), "utf8");
}

function normalizeComparableAgentPaths(text) {
  return String(text ?? "")
    .replace(
      /(~?\/?)\.claude\/agents\/(?:[A-Za-z0-9_-]+\/)*([A-Za-z0-9_.{}-]+)\.md/g,
      "$1.__ai_config_sync_agent__/$2"
    )
    .replace(
      /(~?\/?)\.codex\/agents\/([A-Za-z0-9_.{}-]+)\.toml/g,
      "$1.__ai_config_sync_agent__/$2"
    );
}

// Like directoryHash but normalizes the skill manifest filename so that two skills
// with identical content but differing manifest casing (skill.md vs SKILL.md) hash equal.
function skillContentHash(path) {
  if (!existsSync(path)) return "missing";
  const hash = createHash("sha256");

  for (const { raw, normalized } of sortedSkillFiles(path)) {
    hash.update(normalized);
    hash.update(readSkillFileForHash(path, raw));
  }

  return hash.digest("hex").slice(0, 12);
}

function skillDirsEquivalent(claudePath, codexPath, entry, item, rules) {
  const claudeHash = skillContentHash(claudePath);
  const codexHash = skillContentHash(codexPath);
  if (claudeHash === codexHash) return true;
  if (transformedSkillContentHash(claudePath, "claude", "codex") === codexHash) return true;
  if (transformedSkillContentHash(codexPath, "codex", "claude") === claudeHash) return true;

  if (entry) {
    const terms = expandTermsBothDirections(
      uniqueStrings([
        ...applicableTermRules(rules ?? [], entry, item, "claude"),
        ...applicableTermRules(rules ?? [], entry, item, "codex"),
      ])
    );
    if (terms.length > 0) {
      if (
        maskedSkillContentHash(claudePath, "claude", "codex", terms) ===
        maskedSkillContentHash(codexPath, "codex", "codex", terms)
      )
        return true;
      if (
        maskedSkillContentHash(claudePath, "claude", "claude", terms) ===
        maskedSkillContentHash(codexPath, "codex", "claude", terms)
      )
        return true;
    }
  }

  const overrides = activeSkillOverridesForDirPair(claudePath, codexPath);
  if (overrides.length > 0) {
    const codexOverridden = overriddenSkillContentHash(codexPath, "codex", overrides);
    const claudeOverridden = overriddenSkillContentHash(claudePath, "claude", overrides);
    if (claudeOverridden === codexOverridden) return true;
    // Override sentinels (` PO:<id> `) survive transformTextForHost untouched, so
    // a transform layered on top of paraphrase masking can close the remaining
    // gap when transform AND override are jointly required for equivalence.
    if (
      overriddenTransformedSkillContentHash(claudePath, "claude", "codex", overrides) ===
      codexOverridden
    )
      return true;
    if (
      overriddenTransformedSkillContentHash(codexPath, "codex", "claude", overrides) ===
      claudeOverridden
    )
      return true;
  }

  const lineTerms = entry ? entryMaskTerms(entry, item, rules ?? []) : [];
  if (skillDirsLineEquivalent(claudePath, codexPath, "claude", "codex", lineTerms)) return true;
  if (skillDirsLineEquivalent(claudePath, codexPath, "codex", "claude", lineTerms)) return true;
  return false;
}

function skillDirsLineEquivalent(claudeSkillDir, codexSkillDir, from, to, terms = []) {
  const targetDir = to === "claude" ? claudeSkillDir : codexSkillDir;
  const sourceDir = from === "claude" ? claudeSkillDir : codexSkillDir;
  const targetHost = to;
  const sourceHost = from;

  const targetFiles = sortedSkillFiles(targetDir);
  const sourceFiles = sortedSkillFiles(sourceDir);
  const targetByNormalized = new Map(targetFiles.map((entry) => [entry.normalized, entry]));
  const sourceByNormalized = new Map(sourceFiles.map((entry) => [entry.normalized, entry]));
  const allNormalized = uniqueStrings([
    ...targetFiles.map((entry) => entry.normalized),
    ...sourceFiles.map((entry) => entry.normalized),
  ]).sort();

  for (const normalized of allNormalized) {
    const targetEntry = targetByNormalized.get(normalized);
    const sourceEntry = sourceByNormalized.get(normalized);
    if (!targetEntry || !sourceEntry) return false;

    const targetAbs = join(targetDir, targetEntry.raw);
    const sourceAbs = join(sourceDir, sourceEntry.raw);
    let targetContent = readSkillFileForHash(targetDir, targetEntry.raw).toString("utf8");
    let sourceContent = readSkillFileForHash(sourceDir, sourceEntry.raw).toString("utf8");

    const fileOverrides = activeManifestOverridesForPair(targetAbs, sourceAbs, targetHost);
    if (fileOverrides.length > 0) {
      const masked = maskBodiesForHosts(
        targetContent,
        sourceContent,
        targetHost,
        sourceHost,
        fileOverrides
      );
      targetContent = masked.target;
      sourceContent = masked.source;
    }
    if (isTextMappingFile(sourceAbs) && isTextMappingFile(targetAbs)) {
      sourceContent = transformTextForHost(sourceContent, sourceHost, targetHost);
    }

    let changes = contentChangePreview(
      "Target current",
      targetContent,
      "After apply",
      sourceContent,
      terms
    );
    if (changes.length === 1 && changes[0] === "No line-level preview available.") continue;

    // Mask-before-transform fails when an override line sits inside a structured
    // call body (e.g. Agent({...prompt: <sentinel>...})) because the sentinel breaks
    // applyCallTransforms' parser. Retry with transform-first + post-transform
    // paraphrase token application; if that yields target/source equivalence, the
    // override is valid even though the simpler ordering above could not see it.
    if (fileOverrides.length > 0 && isTextMappingFile(sourceAbs) && isTextMappingFile(targetAbs)) {
      const rawTarget = readSkillFileForHash(targetDir, targetEntry.raw).toString("utf8");
      let rawSource = readSkillFileForHash(sourceDir, sourceEntry.raw).toString("utf8");
      rawSource = transformTextForHost(rawSource, sourceHost, targetHost);
      rawSource = applyOverrideParaphrasesAtTargetLines(
        rawSource,
        sourceAbs,
        targetAbs,
        sourceHost,
        targetHost
      );
      const masked = maskBodiesForHosts(
        rawTarget,
        rawSource,
        targetHost,
        targetHost,
        fileOverrides
      );
      changes = contentChangePreview(
        "Target current",
        masked.target,
        "After apply",
        masked.source,
        terms
      );
      if (changes.length === 1 && changes[0] === "No line-level preview available.") continue;
    }
    return false;
  }

  return true;
}

function transformedSkillContentHash(path, from, to) {
  if (!existsSync(path)) return "missing";
  const hash = createHash("sha256");

  for (const { raw, normalized } of sortedSkillFiles(path)) {
    const absolute = join(path, raw);
    const canonical = readSkillFileForHash(path, raw);
    const content = isTextMappingFile(absolute)
      ? Buffer.from(
          normalizeSkillFileText(
            transformTextForHost(canonical.toString("utf8"), from, to),
            raw,
            absolute
          ),
          "utf8"
        )
      : canonical;
    hash.update(normalized);
    hash.update(content);
  }

  return hash.digest("hex").slice(0, 12);
}

function maskedSkillContentHash(path, sourceHost, targetHost, terms) {
  if (!existsSync(path)) return "missing";
  const hash = createHash("sha256");

  for (const { raw, normalized } of sortedSkillFiles(path)) {
    const absolute = join(path, raw);
    const canonical = readSkillFileForHash(path, raw);
    let content;
    if (isTextMappingFile(absolute)) {
      const text =
        sourceHost === targetHost
          ? canonical.toString("utf8")
          : normalizeSkillFileText(
              transformTextForHost(canonical.toString("utf8"), sourceHost, targetHost),
              raw,
              absolute
            );
      content = Buffer.from(maskLinesContaining(text, terms), "utf8");
    } else {
      content = canonical;
    }
    hash.update(normalized);
    hash.update(content);
  }

  return hash.digest("hex").slice(0, 12);
}

function activeSkillOverridesForDirPair(claudeDir, codexDir) {
  if (!claudeDir || !codexDir) return [];
  const claudeRoot = expandHome(claudeDir);
  const codexRoot = expandHome(codexDir);
  const { active } = activeParaphraseOverrides();
  return active.filter(
    (entry) =>
      expandHome(entry.claude_path).startsWith(`${claudeRoot}/`) &&
      expandHome(entry.codex_path).startsWith(`${codexRoot}/`)
  );
}

function overriddenSkillContentHash(path, host, overrides) {
  if (!existsSync(path)) return "missing";
  const hash = createHash("sha256");
  for (const { raw, normalized } of sortedSkillFiles(path)) {
    hash.update(normalized);
    hash.update(readSkillFileMaskedForHash(path, raw, host, overrides));
  }
  return hash.digest("hex").slice(0, 12);
}

// Like overriddenSkillContentHash but applies transformTextForHost AFTER masking.
// Closes the gap where a skill needs BOTH paraphrase override (to mask diverging
// prose) AND host-vocabulary transform (e.g. opus -> gpt-5.5) to be equivalent.
// Mask sentinels (` PO:<id> `) are simple ASCII tokens not present in any
// terminology-map / paraphrase-map rule, so transform leaves them intact.
function overriddenTransformedSkillContentHash(path, sourceHost, targetHost, overrides) {
  if (!existsSync(path)) return "missing";
  const hash = createHash("sha256");
  for (const { raw, normalized } of sortedSkillFiles(path)) {
    const absolute = join(path, raw);
    const masked = readSkillFileMaskedForHash(path, raw, sourceHost, overrides);
    const content = isTextMappingFile(absolute)
      ? Buffer.from(
          normalizeSkillFileText(
            transformTextForHost(masked.toString("utf8"), sourceHost, targetHost),
            raw,
            absolute
          ),
          "utf8"
        )
      : masked;
    hash.update(normalized);
    hash.update(content);
  }
  return hash.digest("hex").slice(0, 12);
}

// Match a paraphrase override entry's recorded path against the on-disk skill
// file. Skill manifests are case-insensitive (skill.md vs SKILL.md) on macOS,
// so an override registered with one casing must still match a directory
// listing that returns the other.
function overrideMatchesSkillFile(overridePath, dirRoot, fileRaw) {
  if (typeof overridePath !== "string" || !overridePath) return false;
  const expanded = expandHome(overridePath);
  if (expanded === `${dirRoot}/${fileRaw}`) return true;
  const lastSlash = expanded.lastIndexOf("/");
  if (lastSlash === -1) return false;
  if (expanded.slice(0, lastSlash) !== dirRoot) return false;
  const overrideBase = expanded.slice(lastSlash + 1);
  return isSkillManifestBasename(overrideBase) && isSkillManifestBasename(fileRaw);
}

function directoryFiles(root, prefix = "") {
  if (!existsSync(root)) return [];

  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(root, entry.name);

      if (entry.isDirectory()) {
        return directoryFiles(absolute, relative);
      }

      if (entry.isFile()) {
        return [relative];
      }

      return [];
    })
    .sort();
}

function label(area) {
  return area.replaceAll("-", " ");
}

async function runConnect() {
  const state = connectState();
  const results = await registerMissingIntegrations(state);
  const nextState = connectState();

  console.log("AI Config Sync Manager connect");
  console.log(`Runtime root: ${runtimeRoot}`);
  console.log(`Config root: ${formatPathState(nextState.configRoot)}`);
  console.log(`Status ignore: ${formatPathState(nextState.statusIgnore)}`);

  for (const result of results) {
    console.log(`${result.status}: ${result.message}`);
  }
}

function connectState() {
  return {
    configRoot: `${home}/.ai-config-sync-manager`,
    statusIgnore: `${home}/.ai-config-sync-manager/rules/status-ignore.json`,
  };
}

async function registerMissingIntegrations(state) {
  const results = [];

  tryConnectAction(results, "initialized config root", () => {
    ensureDirectoryRoot(state.configRoot);
  });

  tryConnectAction(results, "initialized status ignore", () => {
    writeDefaultStatusIgnore(state.statusIgnore);
  });

  if (claudeHostInstalled()) {
    await tryConnectActionAsync(results, "registered Claude plugin", async () => {
      await installClaudePlugin();
    });
  } else {
    results.push({
      status: "skipped",
      message:
        "Claude host not detected (~/.claude missing); rerun connect after installing Claude Code",
    });
  }

  if (codexHostInstalled()) {
    await tryConnectActionAsync(results, "registered Codex plugin", async () => {
      await installCodexPlugin();
    });
  } else {
    results.push({
      status: "skipped",
      message:
        "Codex host not detected (~/.codex and ~/.agents both missing); rerun connect after installing Codex",
    });
  }

  return results;
}

function claudeHostInstalled() {
  return existsSync(`${home}/.claude`);
}

function codexHostInstalled() {
  return existsSync(`${home}/.codex`) || existsSync(`${home}/.agents`);
}

function ensureDirectoryRoot(path) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(
      `${path} is a symlink; remove it before using this path as the user config root`
    );
  }

  mkdirSync(path, { recursive: true });
}

function writeDefaultStatusIgnore(path) {
  if (existsSync(path)) {
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, exclude: [] }, null, 2)}\n`);
}

function tryConnectAction(results, message, action) {
  try {
    action();
    results.push({ status: "ok", message });
  } catch (error) {
    results.push({
      status: "blocked",
      message: `${message}: ${error instanceof Error ? error.message : "unknown error"}`,
    });
  }
}

async function tryConnectActionAsync(results, message, action) {
  try {
    await action();
    results.push({ status: "ok", message });
  } catch (error) {
    results.push({
      status: "blocked",
      message: `${message}: ${error instanceof Error ? error.message : "unknown error"}`,
    });
  }
}

async function installClaudePlugin() {
  const marketplaceSource = join(runtimeRoot, "dist/claude-marketplace");
  if (!existsSync(marketplaceSource)) {
    throw new Error(`Claude marketplace bundle missing at ${marketplaceSource}`);
  }
  execIdempotent(`claude plugin marketplace add "${marketplaceSource}"`);
  execIdempotent("claude plugin install config-manager@ai-config-sync-manager");
}

async function installCodexPlugin() {
  const sourceBundle = join(runtimeRoot, "dist/codex-plugin");
  if (!existsSync(sourceBundle)) {
    throw new Error(`Codex plugin bundle missing at ${sourceBundle}`);
  }
  const pluginPath = `${home}/.agents/plugins/${CODEX_PLUGIN_NAME}`;
  rmSync(pluginPath, { recursive: true, force: true });
  cpSync(sourceBundle, pluginPath, { recursive: true, dereference: false });
  upsertCodexUserMarketplace(`./${CODEX_PLUGIN_NAME}`);
  enableCodexPluginConfig();
}

function execIdempotent(command) {
  try {
    execSync(command, { stdio: "inherit" });
  } catch (error) {
    // Host CLI missing (ENOENT) or shell-reported "command not found" (status 127):
    // surface so connect reports blocked. Other non-zero exits are treated as
    // already-registered / already-installed so re-running connect is idempotent.
    if (error?.code === "ENOENT" || error?.status === 127) {
      throw error;
    }
    // Real failures still print to stderr via stdio: inherit and are detected
    // by the next step or status command.
  }
}

function upsertCodexUserMarketplace(pluginPath) {
  const marketplacePath = `${home}/.agents/plugins/marketplace.json`;
  let data = {};
  if (existsSync(marketplacePath)) {
    try {
      data = JSON.parse(readFileSync(marketplacePath, "utf8"));
    } catch {
      data = {};
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    data = {};
  }

  data.name ??= CODEX_MARKETPLACE_NAME;
  data.interface ??= { displayName: "Local Plugins" };
  const existingPlugins = Array.isArray(data.plugins) ? data.plugins : [];

  const entry = {
    name: CODEX_PLUGIN_NAME,
    source: { source: "local", path: pluginPath },
    policy: {
      installation: "INSTALLED_BY_DEFAULT",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  };

  data.plugins = [...existingPlugins.filter((p) => p?.name !== CODEX_PLUGIN_NAME), entry];

  mkdirSync(dirname(marketplacePath), { recursive: true });
  writeFileSync(marketplacePath, `${JSON.stringify(data, null, 2)}\n`);
}

function enableCodexPluginConfig() {
  const configPath = `${home}/.codex/config.toml`;
  const pluginId = `${CODEX_PLUGIN_NAME}@${CODEX_MARKETPLACE_NAME}`;
  const tableHeader = `[plugins.${JSON.stringify(pluginId)}]`;
  const enabledLine = "enabled = true";
  const block = `${tableHeader}\n${enabledLine}\n`;

  let body = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const tablePattern = new RegExp(
    `(^|\\n)\\[plugins\\.${escapeRegExp(JSON.stringify(pluginId))}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`
  );
  const match = body.match(tablePattern);

  if (match) {
    const section = match[2].match(/^enabled\s*=/m)
      ? match[2].replace(/^enabled\s*=.*$/m, enabledLine)
      : `${match[2].trimEnd()}\n${enabledLine}\n`;
    body = body.replace(tablePattern, `${match[1]}${tableHeader}\n${section}`);
  } else {
    body = `${body.trimEnd()}${body.trimEnd() ? "\n\n" : ""}${block}`;
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, body.endsWith("\n") ? body : `${body}\n`);
}

function formatPathState(path) {
  if (!existsSync(path)) return `${path} (missing)`;
  const stat = lstatSync(path);
  return `${path}${stat.isSymbolicLink() ? " (symlink)" : ""}`;
}

/**
 * Parse `sync` subcommand argv into a SyncOptions object.
 * @param {string[]} argv
 * @returns {SyncOptions}
 */
function parseSync(argv) {
  const direction = defaultSyncDirection();
  let from = direction.from;
  let to = direction.to;
  let routeExplicit = false;
  let dryRun = false;
  let apply = false;
  let planJson = false;
  let ledgerJson = false;
  let ledgerPath = null;
  let scope = null;
  const selectors = emptySelectors();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") {
      dryRun = true;
    } else if (token === "--apply") {
      apply = true;
    } else if (token === "--plan-json") {
      planJson = true;
    } else if (token === "--ledger-json") {
      ledgerJson = true;
    } else if (token === "--ledger") {
      ledgerPath = argv[index + 1];
      if (!ledgerPath) throw new Error("Missing value for --ledger");
      index += 1;
    } else if (token === "--from" || token === "--to") {
      const value = argv[index + 1];
      if (!hosts.has(value)) throw new Error(`Missing or invalid value for ${token}`);
      routeExplicit = true;
      if (token === "--from") from = value;
      if (token === "--to") to = value;
      index += 1;
    } else if (token === "--scope") {
      scope = parseScopes(argv[index + 1], true);
      index += 1;
    } else if (token === "--include" || token === "--exclude") {
      addSelectors(selectors, token, argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown option for sync: ${token}`);
    }
  }

  if (dryRun && apply) throw new Error("Choose either --dry-run or --apply, not both.");
  if (from === to) throw new Error("--from and --to must be different hosts.");

  const scopes = scope ?? ["global", "project"];
  return {
    from,
    to,
    routeExplicit,
    apply,
    planJson,
    ledgerJson,
    ledgerPath,
    scope: scopes[0],
    scopes,
    selectors,
  };
}

function parseScopes(value, allowAll) {
  if (allowAll && (!value || value === "all")) return ["global", "project"];
  if (value === "global" || value === "project") return [value];
  throw new Error(
    allowAll
      ? "Supported scopes are global, project, and all."
      : "Supported sync scopes are global and project."
  );
}

function noOptions(argv, command) {
  if (argv.length > 0) throw new Error(`${command} does not accept options.`);
}

function isHelp(argv) {
  return argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h");
}

function printHelp() {
  console.log(`Usage:
  ai-config-sync connect
  ai-config-sync connect --help
  ai-config-sync status
  ai-config-sync status --help
  ai-config-sync status --json
  ai-config-sync status --compact
  ai-config-sync status --tree
  ai-config-sync status --scope global|project|all
  ai-config-sync status --include skills:foo,mcp:notion --exclude permissions:Bash
  ai-config-sync sync --dry-run
  ai-config-sync sync --help
  ai-config-sync sync --plan-json
  ai-config-sync sync --scope global|project|all --dry-run
  ai-config-sync sync --scope global|project|all --apply
  ai-config-sync sync --include instructions,skills:foo,mcp:notion --exclude permissions:Bash --dry-run
  ai-config-sync sync --from claude --to codex
  ai-config-sync sync --from codex --to claude
  ai-config-sync reference
  ai-config-sync reference --help
  ai-config-sync reference --output ~/.ai-config-sync-manager/reference.md
  ai-config-sync paraphrase
  ai-config-sync paraphrase --help
  ai-config-sync paraphrase --apply
  ai-config-sync paraphrase --map "Read=Inspection,Write=Author" --apply
  ai-config-sync paraphrase --scope global --include agents:code-structure-analyst --apply`);
}

function printConnectHelp() {
  console.log(`Usage:
  ai-config-sync connect

Checks Claude and Codex installation state, registers missing local host integrations when possible, and prints manual actions when writes are blocked.

Options:
  -h, --help  Show connect help`);
}

function printStatusHelp() {
  console.log(`Usage:
  ai-config-sync status [options]

Options:
  --json                         Print the full status report as JSON
  --compact                      Print one compact line per diff entry
  --tree                         Print scope/area/item tree output
  --scope global|project|all     Limit status scope
  --include area[:item][,...]    Include only selected areas or items
  --exclude area[:item][,...]    Exclude selected areas or items
  ignore file                    <project>/.ai-config-sync-manager/status-ignore.json, then ~/.ai-config-sync-manager/rules/status-ignore.json
  rule fields                    scope, area, item, host, path (file path/glob), term (line-level mask in compare)
  -h, --help                     Show status help

Examples:
  ai-config-sync status --scope project --tree
  ai-config-sync status --include skills:foo,mcp:notion --exclude permissions:Bash`);
}

function printSyncHelp() {
  console.log(`Usage:
  ai-config-sync sync [options]

Options:
  --dry-run                      Preview planned operations without writing files (default)
  --apply                        Apply planned operations with backups
  --plan-json                    Print the sync plan as JSON
  --ledger-json                  Print the apply ledger as JSON to stdout (--apply only)
  --ledger <path>                Write the apply ledger JSON to <path> (--apply only)
  --from claude|codex            Source host (overrides AI_CONFIG_SYNC_HOST)
  --to claude|codex              Target host (overrides AI_CONFIG_SYNC_HOST)
  --scope global|project|all     Limit sync scope
  --include area[:item][,...]    Include only selected areas or items
  --exclude area[:item][,...]    Exclude selected areas or items
  ignore file                    <project>/.ai-config-sync-manager/status-ignore.json, then ~/.ai-config-sync-manager/rules/status-ignore.json
  rule fields                    scope, area, item, host, path (file path/glob), term (line-level mask in compare)
  -h, --help                     Show sync help

Defaults:
  sync without --scope            Uses global and project scopes
  sync without --from/--to        AI_CONFIG_SYNC_HOST=codex sets codex -> claude; otherwise claude -> codex

Examples:
  ai-config-sync sync --scope project --include mcp:notion --dry-run
  ai-config-sync sync --scope project --include mcp:notion --apply
  ai-config-sync sync --from codex --to claude --include permissions:Bash --plan-json`);
}

function parseReference(argv) {
  let output = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--output") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --output");
      output = value;
      index += 1;
    } else {
      throw new Error(`Unknown option for reference: ${token}`);
    }
  }

  return { output };
}

function printReferenceHelp() {
  console.log(`Usage:
  ai-config-sync reference [options]

Prints a markdown reference of every command, area, risk level, mapping quality, sync action verb, terminology layer, hidden marker, and known file location.

Options:
  --output <path>   Write the reference markdown to <path> (parent directories are created)
  -h, --help        Show reference help

Examples:
  ai-config-sync reference
  ai-config-sync reference --output ~/.ai-config-sync-manager/reference.md`);
}

function parseParaphrase(argv) {
  let apply = false;
  let json = false;
  let scopes = ["global", "project"];
  let nonInteractive = false;
  let register = false;
  const cliMap = { claude_only: {}, codex_only: {} };
  const selectors = emptySelectors();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") {
      apply = true;
    } else if (token === "--json") {
      json = true;
    } else if (token === "--non-interactive") {
      nonInteractive = true;
    } else if (token === "--register") {
      register = true;
    } else if (token === "--scope") {
      const value = argv[index + 1];
      scopes = parseScopes(value, true);
      index += 1;
    } else if (token === "--include" || token === "--exclude") {
      addSelectors(selectors, token, argv[index + 1]);
      index += 1;
    } else if (token === "--map") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --map");
      parseParaphraseMapArg(value, cliMap);
      index += 1;
    } else {
      throw new Error(`Unknown option for paraphrase: ${token}`);
    }
  }

  return { apply, json, scopes, nonInteractive, register, cliMap, selectors };
}

function parseParaphraseMapArg(value, target) {
  const data = hostStrictVocabSource().data ?? {};
  const claudeTokens = new Set(Array.isArray(data.claude_only) ? data.claude_only : []);
  const codexTokens = new Set(Array.isArray(data.codex_only) ? data.codex_only : []);
  for (const segment of value.split(",")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    let side = null;
    let body = trimmed;
    const sideMatch = trimmed.match(/^(claude_only|codex_only):(.+)$/);
    if (sideMatch) {
      side = sideMatch[1];
      body = sideMatch[2];
    }
    const eq = body.indexOf("=");
    if (eq < 0) throw new Error(`Invalid --map entry: ${trimmed} (expected token=paraphrase)`);
    const token = body.slice(0, eq).trim();
    const paraphrase = body.slice(eq + 1).trim();
    if (!token || !paraphrase) throw new Error(`Invalid --map entry: ${trimmed}`);
    if (!side) {
      if (claudeTokens.has(token)) side = "claude_only";
      else if (codexTokens.has(token)) side = "codex_only";
      else
        throw new Error(
          `--map token "${token}" not in host-strict-vocab; prefix with claude_only: or codex_only:`
        );
    }
    target[side][token] = paraphrase;
  }
}

async function runParaphrase(options) {
  const { apply, scopes, selectors, cliMap, nonInteractive } = options;
  const ignoreSource = ignoreListSource();
  const ignoreRules = (ignoreSource.data?.exclude ?? []).filter(Boolean);

  const allFindings = scopes.flatMap((scope) =>
    filterVocabFindings(lintScopeForVocab(scope), selectors, ignoreRules)
  );
  const manualFindings = allFindings.filter((f) => !f.recommended);

  const fileMap = paraphraseMapSource().data ?? { claude_only: {}, codex_only: {} };
  const effectiveMap = mergeParaphraseMap(fileMap, cliMap);
  const newMapEntries = mergeParaphraseMap({ claude_only: {}, codex_only: {} }, cliMap);

  const skipped = [];
  const pendingTokenMap = new Map();

  const fileWork = new Map();
  for (const f of manualFindings) {
    const paraphrase = effectiveMap[f.side]?.[f.token];
    if (!paraphrase) {
      const key = `${f.side}:${f.token}`;
      const acc = pendingTokenMap.get(key) ?? { token: f.token, side: f.side, count: 0 };
      acc.count += 1;
      pendingTokenMap.set(key, acc);
      continue;
    }
    queueParaphraseFinding(fileWork, f, paraphrase);
  }
  let pending = [...pendingTokenMap.values()];

  if (apply && pending.length > 0 && !nonInteractive && process.stdin.isTTY) {
    for (const p of pending) {
      const answer = await promptParaphraseToken(p);
      if (!answer) {
        skipped.push({ token: p.token, side: p.side, reason: "user-skipped" });
        continue;
      }
      effectiveMap[p.side][p.token] = answer;
      newMapEntries[p.side][p.token] = answer;
      for (const f of manualFindings) {
        if (f.token === p.token && f.side === p.side) {
          queueParaphraseFinding(fileWork, f, answer);
        }
      }
    }
    pending = [];
  }

  const applied = [];
  const overridesToRegister = [];

  for (const [path, info] of fileWork) {
    if (!existsSync(path)) {
      skipped.push({ path, reason: "file-missing" });
      continue;
    }
    const originalBody = readHostFileBody(info.area, info.host, path);
    const originalLines = originalBody.split(/\r?\n/);
    const updatedLines = [...originalLines];

    const byLine = new Map();
    for (const f of info.findings) {
      if (!byLine.has(f.line)) byLine.set(f.line, []);
      byLine.get(f.line).push(f);
    }

    const lineChanges = [];
    for (const [lineNumber, list] of byLine) {
      if (lineNumber < 1 || lineNumber > originalLines.length) continue;
      const before = originalLines[lineNumber - 1];
      let after = before;
      const tokens = [];
      for (const f of list) {
        const re = new RegExp(`\\b${escapeRegExp(f.token)}\\b`, "g");
        if (!re.test(after)) continue;
        after = after.replace(new RegExp(`\\b${escapeRegExp(f.token)}\\b`, "g"), f.paraphrase);
        tokens.push({ token: f.token, paraphrase: f.paraphrase });
      }
      if (after !== before) {
        lineChanges.push({ lineNumber, before, after, tokens });
        updatedLines[lineNumber - 1] = after;
      }
    }

    if (lineChanges.length === 0) continue;

    const counterpart = findCounterpartFile(info);
    const counterpartHost = info.host === "claude" ? "codex" : "claude";

    for (const change of lineChanges) {
      const directLine = counterpart
        ? readHostBodyLine(info.area, counterpartHost, counterpart.path, change.lineNumber)
        : null;
      const directMatched = directLine !== null && directLine === change.before;

      let cpLine = directLine;
      let cpLineNumber = directMatched ? change.lineNumber : null;
      let counterpartMatched = directMatched;

      if (counterpart && !directMatched) {
        const fallbackLineNumber = findCounterpartLineByText(
          info.area,
          counterpartHost,
          counterpart.path,
          change.before,
          change.lineNumber
        );
        if (fallbackLineNumber !== null) {
          cpLineNumber = fallbackLineNumber;
          cpLine = change.before;
          counterpartMatched = true;
        }
      }

      const claudePath = info.host === "claude" ? path : (counterpart?.path ?? null);
      const codexPath = info.host === "codex" ? path : (counterpart?.path ?? null);
      const claudeLine =
        info.host === "claude" ? change.lineNumber : (cpLineNumber ?? change.lineNumber);
      const codexLine =
        info.host === "codex" ? change.lineNumber : (cpLineNumber ?? change.lineNumber);
      const claudeText = info.host === "claude" ? change.after : counterpartMatched ? cpLine : null;
      const codexText = info.host === "codex" ? change.after : counterpartMatched ? cpLine : null;
      const overrideId = `${info.scope}-${info.area}-${sanitizeOverrideIdSegment(info.item)}-${info.host}-L${change.lineNumber}`;

      const record = {
        path,
        host: info.host,
        scope: info.scope,
        area: info.area,
        item: info.item,
        line: change.lineNumber,
        before: change.before,
        after: change.after,
        tokens: change.tokens,
        counterpart_path: counterpart?.path ?? null,
        counterpart_line: counterpartMatched ? cpLineNumber : null,
        counterpart_text: cpLine,
        counterpart_matched: counterpartMatched,
        override_id: overrideId,
      };

      if (!counterpartMatched) {
        skipped.push({
          path,
          line: change.lineNumber,
          reason: counterpart ? "counterpart-line-mismatch" : "counterpart-file-not-found",
          ...record,
        });
        continue;
      }

      applied.push(record);

      if (apply && claudePath && codexPath) {
        overridesToRegister.push({
          id: overrideId,
          scope: info.scope,
          area: info.area,
          item: info.item,
          claude_path: claudePath,
          codex_path: codexPath,
          claude_line: claudeLine,
          codex_line: codexLine,
          claude_text: claudeText,
          codex_text: codexText,
          tokens: change.tokens,
          registered_at: new Date().toISOString(),
        });
      }
    }

    if (apply) {
      const updated = updatedLines.join("\n");
      writeHostFileBody(info.area, info.host, path, updated);
    }
  }

  if (apply) {
    if (overridesToRegister.length > 0) registerParaphraseOverrides(overridesToRegister);
    if (
      Object.keys(newMapEntries.claude_only).length > 0 ||
      Object.keys(newMapEntries.codex_only).length > 0
    ) {
      persistParaphraseMap(newMapEntries);
    }
  }

  return {
    mode: apply ? "apply" : "dry-run",
    scopes,
    total: manualFindings.length,
    applied,
    skipped,
    pendingTokens: pending,
  };
}

// Register-only paraphrase: skip the lint stage and instead diff claude/codex
// files line-by-line. For each diff line, test whether the effective
// paraphrase map (file + cli --map) equates the two sides; if so, append an
// override entry without touching either source file. Use case: codex (or
// claude) was pre-paraphrased outside the CLI so lintHostVocab finds zero
// strict-vocab tokens, and no override would otherwise be registered.
async function runParaphraseRegister(options) {
  const { apply, scopes, selectors, cliMap } = options;
  const ignoreSource = ignoreListSource();
  const ignoreRules = (ignoreSource.data?.exclude ?? []).filter(Boolean);

  const fileMap = paraphraseMapSource().data ?? { claude_only: {}, codex_only: {} };
  const effectiveMap = mergeParaphraseMap(fileMap, cliMap);
  const newMapEntries = mergeParaphraseMap({ claude_only: {}, codex_only: {} }, cliMap);

  const matched = [];
  const skipped = [];
  const overridesToRegister = [];

  for (const scope of scopes) {
    const items = enumerateScopeItemsForRegister(scope, selectors, ignoreRules);
    for (const item of items) {
      const claudeBody = readHostFileBody(item.area, "claude", item.claudePath);
      const codexBody = readHostFileBody(item.area, "codex", item.codexPath);
      const claudeLines = claudeBody.split(/\r?\n/);
      const codexLines = codexBody.split(/\r?\n/);
      const len = Math.min(claudeLines.length, codexLines.length);

      for (let i = 0; i < len; i += 1) {
        const claudeText = claudeLines[i];
        const codexText = codexLines[i];
        if (claudeText === codexText) continue;
        if (transformTextForHost(claudeText, "claude", "codex") === codexText) continue;
        if (transformTextForHost(codexText, "codex", "claude") === claudeText) continue;

        const equivalence = checkParaphraseMapEquivalence(claudeText, codexText, effectiveMap);
        if (!equivalence.equivalent) {
          skipped.push({
            scope,
            area: item.area,
            item: item.item,
            line: i + 1,
            claudePath: item.claudePath,
            codexPath: item.codexPath,
            reason: "mapping-not-equivalent",
            claudeText,
            codexText,
          });
          continue;
        }

        const lineNumber = i + 1;
        const overrideId = `${scope}-${item.area}-${sanitizeOverrideIdSegment(item.item)}-register-L${lineNumber}`;
        const record = {
          id: overrideId,
          scope,
          area: item.area,
          item: item.item,
          claude_path: item.claudePath,
          codex_path: item.codexPath,
          claude_line: lineNumber,
          codex_line: lineNumber,
          claude_text: claudeText,
          codex_text: codexText,
          tokens: equivalence.tokens,
          registered_at: new Date().toISOString(),
        };
        matched.push(record);
        overridesToRegister.push(record);
      }
    }
  }

  if (apply) {
    if (overridesToRegister.length > 0) registerParaphraseOverrides(overridesToRegister);
    if (
      Object.keys(newMapEntries.claude_only).length > 0 ||
      Object.keys(newMapEntries.codex_only).length > 0
    ) {
      persistParaphraseMap(newMapEntries);
    }
  }

  return {
    mode: apply ? "register-apply" : "register-dry-run",
    scopes,
    matched,
    skipped,
  };
}

function enumerateScopeItemsForRegister(scope, selectors) {
  const paths = scope === "global" ? globalPaths() : projectPaths(process.cwd());
  const items = [];

  const claudeAgents = enumerateClaudeAgents(paths.claude.agents);
  const codexAgents = enumerateCodexAgents(paths.codex.agents);
  const claudeAgentByName = new Map(claudeAgents.map((a) => [a.name, a]));
  const codexAgentByName = new Map(codexAgents.map((a) => [a.name, a]));
  const agentNames = new Set([...claudeAgentByName.keys(), ...codexAgentByName.keys()]);
  for (const name of agentNames) {
    if (!includesArea(selectors, "agents", name)) continue;
    const ca = claudeAgentByName.get(name);
    const co = codexAgentByName.get(name);
    if (!ca || !co) continue;
    items.push({ scope, area: "agents", item: name, claudePath: ca.path, codexPath: co.path });
  }

  const claudeSkillsDirs = paths.claude.skillsPaths ?? [paths.claude.skills];
  const codexSkillsDirs = paths.codex.skillsPaths ?? [paths.codex.skills];
  const claudeSkillManifest = new Map();
  for (const dir of claudeSkillsDirs) {
    if (!dir || !existsSync(dir)) continue;
    for (const name of skillNames(dir)) {
      if (claudeSkillManifest.has(name)) continue;
      const manifest = findSkillManifest(join(dir, name), "claude");
      if (manifest) claudeSkillManifest.set(name, manifest);
    }
  }
  const codexSkillManifest = new Map();
  for (const dir of codexSkillsDirs) {
    if (!dir || !existsSync(dir)) continue;
    for (const name of skillNames(dir)) {
      if (codexSkillManifest.has(name)) continue;
      const manifest = findSkillManifest(join(dir, name), "codex");
      if (manifest) codexSkillManifest.set(name, manifest);
    }
  }
  const skillSet = new Set([...claudeSkillManifest.keys(), ...codexSkillManifest.keys()]);
  for (const name of skillSet) {
    if (!includesArea(selectors, "skills", name)) continue;
    const cm = claudeSkillManifest.get(name);
    const om = codexSkillManifest.get(name);
    if (!cm || !om) continue;
    items.push({ scope, area: "skills", item: name, claudePath: cm, codexPath: om });
  }

  if (
    includesArea(selectors, "instructions", "instructions") &&
    paths.claude.instructions &&
    existsSync(paths.claude.instructions) &&
    paths.codex.instructions &&
    existsSync(paths.codex.instructions)
  ) {
    items.push({
      scope,
      area: "instructions",
      item: "instructions",
      claudePath: paths.claude.instructions,
      codexPath: paths.codex.instructions,
    });
  }

  return items;
}

// Test whether the effective paraphrase map equates two diverging lines. A
// real conflict often combines two layers: a terminology rule (`.claude/` →
// `.codex/`) AND a paraphrase token (`Read` → `Inspect`). The pre-check in
// the caller already silences pure-terminology lines, so here we layer the
// terminology transform first and then apply the paraphrase tokens — only
// the tokens that survived past terminology end up in the override entry.
function checkParaphraseMapEquivalence(claudeText, codexText, effectiveMap) {
  const claudeOnly = effectiveMap.claude_only ?? {};
  const codexOnly = effectiveMap.codex_only ?? {};

  const tokensA = [];
  const claudeBase = transformTextForHost(claudeText, "claude", "codex");
  const claudeAll = applyParaphraseTokens(claudeBase, claudeOnly, tokensA);
  if (claudeAll === codexText && tokensA.length > 0) return { equivalent: true, tokens: tokensA };

  const tokensB = [];
  const codexBase = transformTextForHost(codexText, "codex", "claude");
  const codexAll = applyParaphraseTokens(codexBase, codexOnly, tokensB);
  if (codexAll === claudeText && tokensB.length > 0) return { equivalent: true, tokens: tokensB };

  if (
    (tokensA.length > 0 || tokensB.length > 0) &&
    claudeAll === codexBase &&
    claudeBase === codexAll
  ) {
    return { equivalent: true, tokens: [...tokensA, ...tokensB] };
  }

  return { equivalent: false };
}

function applyParaphraseTokens(text, tokenMap, recorded) {
  let out = text;
  for (const [token, paraphrase] of Object.entries(tokenMap)) {
    if (typeof token !== "string" || !token) continue;
    if (typeof paraphrase !== "string" || !paraphrase) continue;
    const re = new RegExp(`\\b${escapeRegExp(token)}\\b`, "g");
    if (!re.test(out)) continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(token)}\\b`, "g"), paraphrase);
    recorded.push({ token, paraphrase });
  }
  return out;
}

function renderParaphraseRegister(result) {
  const lines = [
    "AI Config Sync Manager paraphrase --register",
    `Mode: ${result.mode}`,
    `Scopes: ${result.scopes.join(", ")}`,
    `Matched: ${result.matched.length} line pair(s)`,
    `Skipped: ${result.skipped.length} line pair(s)`,
  ];

  if (result.matched.length > 0) {
    lines.push("");
    lines.push("Will register:");
    for (const entry of result.matched) {
      const tokens = entry.tokens.map((t) => `${t.token}→${t.paraphrase}`).join(", ");
      lines.push(
        `  - ${entry.scope}/${entry.area}: ${entry.item} (claude L${entry.claude_line} ↔ codex L${entry.codex_line})`
      );
      lines.push(`    tokens: ${tokens || "<none>"}`);
      lines.push(`    claude: ${previewLine(entry.claude_text)}`);
      lines.push(`    codex:  ${previewLine(entry.codex_text)}`);
    }
  }

  if (result.skipped.length > 0) {
    lines.push("");
    lines.push("Skipped (mapping does not equate):");
    const cap = 20;
    for (const entry of result.skipped.slice(0, cap)) {
      lines.push(
        `  - ${entry.scope}/${entry.area}: ${entry.item} L${entry.line} — ${entry.reason}`
      );
      lines.push(`    claude: ${previewLine(entry.claudeText)}`);
      lines.push(`    codex:  ${previewLine(entry.codexText)}`);
    }
    if (result.skipped.length > cap) lines.push(`  ... +${result.skipped.length - cap} more`);
  }

  if (result.mode === "register-dry-run") {
    lines.push("");
    lines.push("Run with --apply to register overrides without rewriting files.");
  } else {
    lines.push("");
    lines.push(`Overrides registered to: ${paraphraseOverridesHomePath()}`);
  }

  return lines.join("\n");
}

function queueParaphraseFinding(fileWork, f, paraphrase) {
  if (!fileWork.has(f.path)) {
    fileWork.set(f.path, {
      host: f.host,
      area: f.area,
      item: f.item,
      scope: f.scope,
      findings: [],
    });
  }
  fileWork.get(f.path).findings.push({ ...f, paraphrase });
}

function sanitizeOverrideIdSegment(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9_.-]+/g, "_");
}

function findCounterpartFile(info) {
  const paths = info.scope === "global" ? globalPaths() : projectPaths(process.cwd());
  const counterpartHost = info.host === "claude" ? "codex" : "claude";
  if (info.area === "agents") {
    const dir = paths[counterpartHost].agents;
    if (!dir || !existsSync(dir)) return null;
    const list =
      counterpartHost === "claude" ? enumerateClaudeAgents(dir) : enumerateCodexAgents(dir);
    const match = list.find(
      (a) => a.name === info.item || a.name.split("/").pop() === info.item.split("/").pop()
    );
    return match ? { path: match.path } : null;
  }
  if (info.area === "skills") {
    const dirs = paths[counterpartHost].skillsPaths ?? [paths[counterpartHost].skills];
    for (const dir of dirs) {
      if (!dir || !existsSync(dir)) continue;
      const skillDir = join(dir, info.item);
      if (!existsSync(skillDir)) continue;
      const manifest = findSkillManifest(skillDir, counterpartHost);
      if (manifest) return { path: manifest };
    }
    return null;
  }
  if (info.area === "instructions") {
    const path = paths[counterpartHost].instructions;
    return path && existsSync(path) ? { path } : null;
  }
  return null;
}

async function promptParaphraseToken(p) {
  return await new Promise((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const sideLabel = p.side.replace("_only", "-only");
    const occurrences = `${p.count} occurrence${p.count === 1 ? "" : "s"}`;
    rl.question(
      `paraphrase token "${p.token}" [${sideLabel}, ${occurrences}] as (empty to skip): `,
      (answer) => {
        rl.close();
        resolveAnswer(answer.trim() || null);
      }
    );
  });
}

function paraphraseOverridesHomePath() {
  return `${home}/.ai-config-sync-manager/rules/paraphrase-overrides.json`;
}

function paraphraseMapHomePath() {
  return `${home}/.ai-config-sync-manager/rules/paraphrase-map.json`;
}

function registerParaphraseOverrides(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const path = paraphraseOverridesHomePath();
  const data = readJsonFile(path, { version: 1, overrides: [] });
  const overrides = Array.isArray(data.overrides) ? data.overrides : [];
  const filtered = overrides.filter(
    (existing) => !entries.some((entry) => existing?.id === entry.id)
  );
  const next = { version: 1, overrides: [...filtered, ...entries] };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
}

function persistParaphraseMap(newEntries) {
  const path = paraphraseMapHomePath();
  const data = readJsonFile(path, { version: 1, claude_only: {}, codex_only: {} });
  const next = {
    version: 1,
    claude_only: { ...(data.claude_only ?? {}), ...(newEntries.claude_only ?? {}) },
    codex_only: { ...(data.codex_only ?? {}), ...(newEntries.codex_only ?? {}) },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
}

function renderParaphrase(result, options) {
  const lines = [
    "AI Config Sync Manager paraphrase",
    `Mode: ${result.mode}`,
    `Scopes: ${result.scopes.join(", ")}`,
    `Manual mismatches scanned: ${result.total}`,
  ];
  lines.push(`Applied: ${result.applied.length} line change(s)`);
  if (result.skipped.length > 0) lines.push(`Skipped: ${result.skipped.length}`);
  if (result.pendingTokens.length > 0) {
    lines.push("");
    lines.push("Tokens needing a paraphrase mapping (no entry in paraphrase-map.json):");
    for (const p of result.pendingTokens) {
      lines.push(
        `  - ${p.token} [${p.side.replace("_only", "-only")}] (${p.count} occurrence${p.count === 1 ? "" : "s"})`
      );
    }
    lines.push("Provide via `--map token=paraphrase` or run with TTY for interactive prompt.");
  }
  if (result.applied.length > 0) {
    lines.push("");
    lines.push("Changes:");
    for (const change of result.applied) {
      lines.push(
        `  - ${change.scope}/${change.area}: ${change.item} (${change.host} L${change.line})`
      );
      lines.push(`    file: ${change.path}`);
      lines.push(`      - before: ${change.before}`);
      lines.push(`      + after:  ${change.after}`);
      if (change.counterpart_path) {
        lines.push(
          `    counterpart: ${change.counterpart_path} L${change.counterpart_line ?? "?"} (${change.counterpart_matched ? "matched" : "mismatch"})`
        );
      }
    }
  }
  if (result.skipped.length > 0) {
    lines.push("");
    lines.push("Skipped:");
    for (const item of result.skipped) {
      const where = item.path
        ? `${item.path}${item.line ? `:L${item.line}` : ""}`
        : `${item.token ?? ""}`;
      lines.push(`  - ${item.reason}: ${where}`);
    }
  }
  if (result.mode === "dry-run") {
    lines.push("");
    lines.push("Run with --apply to rewrite files and register overrides.");
  } else {
    lines.push("");
    lines.push(`Overrides registered to: ${paraphraseOverridesHomePath()}`);
    if (
      options.cliMap &&
      (Object.keys(options.cliMap.claude_only).length > 0 ||
        Object.keys(options.cliMap.codex_only).length > 0)
    ) {
      lines.push(`Map updated: ${paraphraseMapHomePath()}`);
    }
  }
  return lines.join("\n");
}

function printParaphraseHelp() {
  console.log(`Usage:
  ai-config-sync paraphrase [options]

Rewrites manual-review vocab mismatches in agent/skill/instruction files using rules/paraphrase-map.json (token-to-paraphrase) and registers per-line overrides so the result is masked from future status diffs and equivalence checks. Both directions are processed: claude-only tokens in codex files become codex-side paraphrases, codex-only tokens in claude files become claude-side paraphrases.

Options:
  --apply                        Rewrite files, append entries to paraphrase-overrides.json, and persist any new mappings to paraphrase-map.json (defaults to dry-run preview)
  --register                     Skip rewriting; diff claude/codex line-by-line and register an override entry for each line pair the effective map equates. Use when one side was pre-paraphrased outside the CLI.
  --json                         Print the result as JSON
  --non-interactive              Skip the TTY prompt for tokens missing from paraphrase-map.json
  --map token=paraphrase[,...]   Inline token-to-paraphrase mappings (prefix with claude_only: or codex_only: when the token is ambiguous)
  --scope global|project|all     Limit paraphrase scope (default: global+project)
  --include area[:item][,...]    Include only selected areas or items
  --exclude area[:item][,...]    Exclude selected areas or items
  -h, --help                     Show paraphrase help

Behavior:
  - Only manual-review findings (those without a sync auto-fix) are rewritten — sync auto-fixes are still handled by \`sync --apply\`.
  - Each rewritten line is paired with the counterpart host file's same-numbered line; if the counterpart line text does not match the pre-rewrite text exactly, the line is skipped (logged under skipped) so a partial override is never registered.
  - Stale overrides (counterpart text drifted) are auto-invalidated at status time, restoring the conflict.
  - With \`--register\`, no source files are touched. The CLI inspects same-numbered claude/codex line pairs that disagree, applies the effective map (file + --map) one direction at a time, and registers an override only when the mapping makes both sides byte-equal. Lines covered by terminology rules are already silenced and skipped.

Examples:
  ai-config-sync paraphrase
  ai-config-sync paraphrase --apply
  ai-config-sync paraphrase --map "Read=Inspection,Write=Author" --apply
  ai-config-sync paraphrase --scope global --include agents:code-structure-analyst --apply
  ai-config-sync paraphrase --register --include skills:commit-insight-pipeline --map "Read=Inspect,Write=Emit" --apply`);
}

function generateReferenceMarkdown() {
  return [
    "# AI Config Sync Manager Reference",
    "",
    "Generated reference for every command, area, risk level, mapping quality, sync action verb, terminology layer, hidden marker, and known file location.",
    "",
    referenceCommandsSection(),
    referenceAreasSection(),
    referenceRiskLevelsSection(),
    referenceMappingQualitiesSection(),
    referenceSyncActionsSection(),
    referenceTerminologyLayersSection(),
    referenceParaphraseSection(),
    referenceHiddenMarkersSection(),
    referenceDefaultDirectionSection(),
    referenceFileLocationsSection(),
  ].join("\n");
}

function referenceCommandsSection() {
  return [
    "## Commands",
    "",
    "### `connect`",
    "",
    "Checks Claude and Codex installation state, registers missing local host integrations when possible, and prints manual actions when writes are blocked.",
    "",
    "- `-h, --help` — Show connect help",
    "",
    "### `status`",
    "",
    "Print diff status between Claude and Codex configuration.",
    "",
    "- `--json` — Print the full status report as JSON",
    "- `--compact` — Print one compact line per diff entry",
    "- `--tree` — Print scope/area/item tree output",
    "- `--scope global|project|all` — Limit status scope",
    "- `--include area[:item][,...]` — Include only selected areas or items",
    "- `--exclude area[:item][,...]` — Exclude selected areas or items",
    "- `-h, --help` — Show status help",
    "",
    "### `sync`",
    "",
    "Plan or apply synchronization between Claude and Codex configuration.",
    "",
    "- `--dry-run` — Preview planned operations without writing files (default)",
    "- `--apply` — Apply planned operations with backups",
    "- `--plan-json` — Print the sync plan as JSON",
    "- `--from claude|codex` — Source host (overrides AI_CONFIG_SYNC_HOST)",
    "- `--to claude|codex` — Target host (overrides AI_CONFIG_SYNC_HOST)",
    "- `--scope global|project|all` — Limit sync scope",
    "- `--include area[:item][,...]` — Include only selected areas or items",
    "- `--exclude area[:item][,...]` — Exclude selected areas or items",
    "- `-h, --help` — Show sync help",
    "",
    "### `reference`",
    "",
    "Print this markdown reference document.",
    "",
    "- `--output <path>` — Write the reference markdown to `<path>` (parent directories are created)",
    "- `-h, --help` — Show reference help",
    "",
    "### `paraphrase`",
    "",
    "Recover bidirectional manual-review vocab mismatches by rewriting host-native tokens into shared paraphrases. Records each rewrite as a paraphrase override so future status/sync runs treat both sides as in sync. Stale overrides whose anchor lines no longer match are auto-invalidated.",
    "",
    "- `--apply` — Persist rewrites, paraphrase map entries, and override archive (default is dry-run)",
    "- `--register` — Skip the rewrite stage; diff claude/codex line-by-line and register an override entry for each line pair the effective map equates. Use when one side was pre-paraphrased outside the CLI so `lintHostVocab` finds nothing to rewrite.",
    "- `--json` — Emit the full paraphrase report as JSON",
    "- `--non-interactive` — Skip the TTY prompt for unmapped tokens (still emits them under `pendingTokens`)",
    '- `--map "token=paraphrase[,...]"` — Provide one or more inline token→paraphrase mappings (CLI overrides paraphrase-map.json)',
    "- `--scope global|project|all` — Limit paraphrase scope",
    "- `--include area[:item][,...]` — Include only selected areas or items",
    "- `--exclude area[:item][,...]` — Exclude selected areas or items",
    "- `-h, --help` — Show paraphrase help",
    "",
  ].join("\n");
}

function referenceAreasSection() {
  return [
    "## Areas",
    "",
    "Areas are the canonical buckets diffed and synced between hosts.",
    "",
    "- `instructions` — Top-level instruction file (`CLAUDE.md` ↔ `AGENTS.md`).",
    "- `skills` — Skill directories under `.claude/skills` and `.codex/skills` (one folder per skill).",
    "- `agents` — Subagent definitions: Claude markdown frontmatter under `.claude/agents` ↔ Codex TOML under `.codex/agents`.",
    "- `mcp` — MCP server registrations (`.mcp.json`, `.claude.json`, `settings.json` ↔ `config.toml [mcp_servers.*]`).",
    "- `permissions` — Tool/bash/web permission rules (`settings.json` permissions ↔ Codex `[approvals]` / `default.rules`).",
    "- `hooks` — Lifecycle hook configuration (`settings.json` hooks ↔ Codex `[[hooks.Event]]` blocks).",
    "",
  ].join("\n");
}

function referenceRiskLevelsSection() {
  return [
    "## Risk levels",
    "",
    "- `safe` — Apply automatically; the source meaning is fully preserved on the target.",
    "- `manual` — Hold for explicit review; mapping is lossy or the source file is missing. Apply will skip operations marked `approvalRequired: true` until rerun explicitly.",
    "",
  ].join("\n");
}

function referenceMappingQualitiesSection() {
  return [
    "## Mapping qualities",
    "",
    "Per-item indicator of how well one host's meaning is preserved on the other side.",
    "",
    "- `exact` — Same value, same semantics on both hosts.",
    "- `equivalent` — Different shape, identical effect (for example `CLAUDE.md` ↔ `AGENTS.md` instructions).",
    "- `approximate` — Closest-fit mapping; behavior is similar but not identical (broad approval policies, prefix rules).",
    "- `metadata-only` — The wrapper is preserved but inner behavior cannot be enforced on the target host.",
    "- `unsupported` — No mapping exists; the item is left for manual review.",
    "",
  ].join("\n");
}

function referenceSyncActionsSection() {
  return [
    "## Sync action verbs",
    "",
    "Plan operations carry an `action` field that `applySyncPlan` dispatches on.",
    "",
    "- `copy-file` — Copy a single file from source host to target host.",
    "- `write-instructions` — Write transformed instruction content (after term/template/call rewrites) to the target instruction file.",
    "- `copy-missing-skills` — Copy skill directories that are missing on the target, overwriting any conflicting skill bodies.",
    "- `merge-agents` — Translate Claude agent frontmatter ↔ Codex agent TOML and write per-agent files.",
    "- `merge-settings-items` — Merge permission or hook items into the target settings file.",
    "- `merge-mcp-servers` — Merge MCP server entries into the target host's MCP config.",
    "- `delete-items` — Delete items from the target that the baseline shows were removed on the source.",
    "- `source-missing` — Source path does not exist; flagged manual and skipped on apply.",
    "- `manual-review` — Area has no automatic mapping; surfaced for the user to handle.",
    "",
    "### Status output symbols",
    "",
    "- `+` — Item will be added on the target (copy from source).",
    "- `-` — Item will be removed on the target (baseline-tracked deletion).",
    "- `~` — Item exists on both hosts but content differs (will be overwritten on apply).",
    "- `!` — Conflict that requires manual review.",
    "",
  ].join("\n");
}

function referenceTerminologyLayersSection() {
  const layers = terminologyMapSource().data?.layers;
  const lines = [
    "## Terminology layers",
    "",
    "Terminology rules live in `rules/terminology-map.json` (override at `~/.ai-config-sync-manager/rules/terminology-map.json` or `<project>/rules/terminology-map.json`). Each layer groups rules that rewrite host-specific vocabulary when transforming text between Claude and Codex.",
    "",
  ];

  if (Array.isArray(layers) && layers.length > 0) {
    for (const layer of layers) {
      const layerId = typeof layer?.id === "string" ? layer.id : "(unnamed layer)";
      const description = typeof layer?.description === "string" ? layer.description : "";
      lines.push(`### \`${layerId}\``);
      lines.push("");
      if (description) {
        lines.push(description);
        lines.push("");
      }
      const rules = Array.isArray(layer?.rules) ? layer.rules : [];
      if (rules.length === 0) {
        lines.push("- (no rules)");
      } else {
        for (const rule of rules) {
          const id = typeof rule?.id === "string" ? rule.id : "(unnamed rule)";
          const isRegex = Boolean(rule?.regex);
          lines.push(`- \`${id}\`${isRegex ? " — regex rule" : ""}`);
        }
      }
      lines.push("");
    }
  } else {
    lines.push("- (terminology map unavailable)");
    lines.push("");
  }

  lines.push("### `model` (from `rules/agents-map.json`)");
  lines.push("");
  lines.push(
    "Model alias rules come from `rules/agents-map.json` `models.tiers` rather than the terminology map."
  );
  lines.push("");
  const tiers = Array.isArray(agentsMapData()?.models?.tiers) ? agentsMapData().models.tiers : [];
  if (tiers.length === 0) {
    lines.push("- (no model tiers)");
  } else {
    for (const tier of tiers) {
      const id = typeof tier?.id === "string" ? tier.id : "(unnamed tier)";
      const claudeAlias = typeof tier?.claude?.alias === "string" ? tier.claude.alias : "?";
      const codexAlias = typeof tier?.codex?.alias === "string" ? tier.codex.alias : "?";
      lines.push(`- \`${id}\` — \`${claudeAlias}\` ↔ \`${codexAlias}\``);
    }
  }
  lines.push("");

  return lines.join("\n");
}

function referenceParaphraseSection() {
  return [
    "## Paraphrase",
    "",
    "Paraphrase recovers bidirectional manual-review vocab mismatches that the terminology map cannot translate (host-native tokens listed in `rules/host-strict-vocab.json`). It rewrites both sides to a shared paraphrase and registers an override so subsequent status runs treat the pair as in sync.",
    "",
    "### Map and override files",
    "",
    "- `rules/paraphrase-map.json` — Token→paraphrase entries grouped under `claude_only` / `codex_only`. Layered with the same precedence as terminology rules: `<project>/rules/paraphrase-map.json` → `~/.ai-config-sync-manager/rules/paraphrase-map.json` → `<repo>/rules/paraphrase-map.json`.",
    "- `rules/paraphrase-overrides.json` — Override archive of accepted rewrites; each entry pins host paths, line numbers, anchor texts, and the rewriting tokens. Same layered precedence as the map.",
    "",
    "### Counterpart matching",
    "",
    "For each rewrite the paraphrase command resolves the counterpart line on the other host:",
    "",
    "1. Read the counterpart file at the same line number; accept when text matches `before` exactly.",
    "2. Otherwise scan the counterpart body for any line whose text equals `before`; pick the candidate closest to the original line number.",
    "3. If neither step finds a match the rewrite is skipped with `counterpart-line-mismatch` (or `counterpart-file-not-found` when the counterpart file is missing).",
    "",
    "### Override staleness",
    "",
    "Overrides are auto-invalidated when the pinned anchor text no longer matches the current file content, so manual edits on either host cleanly retire the recorded pairing without leaving stale entries.",
    "",
  ].join("\n");
}

function referenceHiddenMarkersSection() {
  return [
    "## Hidden markers",
    "",
    "HTML comment markers the call compiler emits inside transformed text. They round-trip on a reverse sync and are not user-visible during normal use.",
    "",
    "- `ai-config-sync:agent-call` — Supported call transformed (Claude `Agent({...})` ↔ Codex prose `spawn_agent`).",
    "- `ai-config-sync:stripped` — Unsupported call removed (`TaskCreate`, `TaskUpdate`, `TeamCreate`); original archived under the backup root.",
    "- `ai-config-sync:manual-review` — Call left intact because it could not be parsed; needs manual translation.",
    "",
  ].join("\n");
}

function referenceDefaultDirectionSection() {
  return [
    "## Default direction precedence",
    "",
    "1. Explicit `--from <host>` / `--to <host>` flags on `sync`.",
    "2. `AI_CONFIG_SYNC_HOST=codex` environment variable — sets default direction to `codex -> claude`.",
    "3. Otherwise the default is `claude -> codex`.",
    "",
    "`status` follows the same default direction so that `+/-/~` symbols and `details` text describe the apply that would run with no override.",
    "",
    "## Environment variables",
    "",
    "- `AI_CONFIG_SYNC_HOST=codex` — Set default sync direction to `codex -> claude`.",
    "- `AI_CONFIG_SYNC_HOME=<path>` — Override the home directory used for global config and state (primarily for tests).",
    "- `AI_CONFIG_SYNC_STRIP_SECRETS=1` — Opt in to defensively stripping MCP env values whose keys look like secrets (`TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `AUTH`). Default behavior copies them because the source already stores the secret in plaintext under the same user's home; enable this if your source config is exposed beyond that trust boundary (e.g. dotfiles committed to git that include `.codex/config.toml`).",
    "",
  ].join("\n");
}

function referenceFileLocationsSection() {
  return [
    "## File locations",
    "",
    "### User-writable",
    "",
    "- `~/.ai-config-sync-manager/state/<scope>.json` — Sync state baseline (one file per scope; project scope hashes the project root).",
    "- `~/.ai-config-sync-manager/backups/<timestamp>/...` — Backup root for each apply run.",
    "- `~/.ai-config-sync-manager/backups/<timestamp>/unsupported-calls.json` — Archive of stripped or manual-review calls (when applicable).",
    "- `~/.ai-config-sync-manager/status-details/<timestamp>.txt` — Full diff detail when status is collapsed.",
    "- `~/.ai-config-sync-manager/rules/agents-map.json` — Agent field and model alias rules (user customization point).",
    "- `~/.ai-config-sync-manager/rules/status-ignore.json` — Persistent ignore rules used by `status` and `sync`. Template at `<repo>/docs/status-ignore.example.json`.",
    "- `~/.ai-config-sync-manager/rules/paraphrase-map.json` — Persistent token→paraphrase entries learned from `paraphrase --apply` (layered: project/home/repo).",
    "- `~/.ai-config-sync-manager/rules/paraphrase-overrides.json` — Override archive of accepted paraphrase rewrites; each entry pins matched line numbers and texts so status treats both sides as in sync.",
    "",
    "### Bundled defaults (under the runtime root)",
    "",
    "- `<repo>/rules/terminology-map.json` — Bundled terminology defaults (override at home or project).",
    "- `<repo>/rules/host-target-templates.json` — Bundled target templates.",
    "- `<repo>/rules/call-templates.json` — Bundled SDK call transform templates.",
    "- `<repo>/rules/paraphrase-map.json` — Bundled paraphrase map defaults (override at home or project).",
    "- `<repo>/rules/paraphrase-overrides.json` — Bundled paraphrase override archive defaults (override at home or project).",
    "- `<repo>/rules/host-strict-vocab.json` — Host-native token list driving vocab-mismatch detection (`claude_only`, `codex_only`, `claude_only_patterns`).",
    "",
    "Override precedence for any rule file: `<project>/rules/<name>.json` → `~/.ai-config-sync-manager/rules/<name>.json` → `<repo>/rules/<name>.json`. Layers are merged by id (rule.id, template.id, areas key, fields claude+codex pair, models.tiers id) — partial overlays only need to declare the entries they want to add or change.",
    "",
  ].join("\n");
}
