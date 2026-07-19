import { join } from "node:path";

const STATUS_ORDER = ["conflict", "unsupported", "claude-only", "codex-only", "in-sync"];

const STATUS_META = {
  "in-sync": { label: "In sync", color: "#22c55e" },
  conflict: { label: "Conflict", color: "#ef4444" },
  "claude-only": { label: "Claude only", color: "#9ca3af" },
  "codex-only": { label: "Codex only", color: "#9ca3af" },
  unsupported: { label: "Unsupported", color: "#f59e0b" },
};

export function buildBoardModel(report, inventory = [], describe = () => "") {
  const merged = new Map();

  for (const item of inventory) {
    const status = membershipStatus(item.inClaude, item.inCodex);
    if (!status) continue;
    merged.set(itemKey(item.scope, item.area, item.name), {
      area: item.area,
      scope: item.scope,
      name: item.name,
      status,
      claudePath: item.claudePath ?? "",
      codexPath: item.codexPath ?? "",
    });
  }

  for (const entry of report.entries ?? []) {
    overlayEntry(merged, entry);
  }

  const items = [...merged.values()];
  for (const item of items) item.description = safeDescribe(describe, item);

  const areas = [...groupByArea(items).values()]
    .map(buildAreaSection)
    .sort((a, b) => b.count - a.count);
  const statusCounts = mergeStatusCounts(areas.map((area) => area.statusCounts));

  return {
    title: "AI Config Sync Board",
    direction: report.direction ?? { from: report.source, to: report.target },
    scopes: report.scopes ?? [],
    generatedAt: new Date().toISOString(),
    areaSummary: areas.map((area) => ({ area: area.area, count: area.count })),
    statusSummary: STATUS_ORDER.filter((status) => statusCounts[status]).map((status) => ({
      status,
      count: statusCounts[status],
    })),
    areas,
  };
}

function itemKey(scope, area, name) {
  return `${scope}|${area}|${name}`;
}

function membershipStatus(inClaude, inCodex) {
  if (inClaude && inCodex) return "in-sync";
  if (inClaude) return "claude-only";
  if (inCodex) return "codex-only";
  return null;
}

function overlayEntry(merged, entry) {
  const apply = (names, status) => {
    for (const name of names ?? []) overlayItem(merged, entry, name, status);
  };
  apply(entry.conflicts, "conflict");
  apply(entry.missingInCodex, "claude-only");
  apply(entry.missingInClaude, "codex-only");
  apply(entry.unsupported, "unsupported");
}

function overlayItem(merged, entry, name, status) {
  const key = itemKey(entry.scope, entry.area, name);
  const existing = merged.get(key);
  if (existing) {
    existing.status = status;
    return;
  }
  merged.set(key, {
    area: entry.area,
    scope: entry.scope,
    name,
    status,
    claudePath: itemHostPath(entry, name, "claude"),
    codexPath: itemHostPath(entry, name, "codex"),
  });
}

function groupByArea(items) {
  const areaMap = new Map();
  for (const item of items) {
    const area = areaMap.get(item.area) ?? { area: item.area, items: [] };
    area.items.push(item);
    areaMap.set(item.area, area);
  }
  return areaMap;
}

function safeDescribe(describe, item) {
  try {
    return describe(item) ?? "";
  } catch {
    return "";
  }
}

function itemHostPath(entry, name, host) {
  if (entry.area === "agents") {
    const map = host === "claude" ? entry.claudeAgentPaths : entry.codexAgentPaths;
    return map?.[name] ?? (host === "claude" ? entry.claudePath : entry.codexPath) ?? "";
  }
  if (entry.area === "skills") {
    const index = host === "claude" ? entry.claudeSkillIndex : entry.codexSkillIndex;
    const base = index?.[name];
    if (base) return join(base, name);
  }
  return (host === "claude" ? entry.claudePath : entry.codexPath) ?? "";
}

function buildAreaSection(area) {
  const groups = new Map();
  for (const item of area.items) {
    const group = groups.get(item.scope) ?? { scope: item.scope, items: [] };
    group.items.push(item);
    groups.set(item.scope, group);
  }

  const orderedGroups = [...groups.values()]
    .map((group) => ({ scope: group.scope, items: sortItems(group.items) }))
    .sort((a, b) => a.scope.localeCompare(b.scope));

  return {
    area: area.area,
    count: area.items.length,
    statusCounts: countStatuses(area.items),
    groups: orderedGroups,
  };
}

function sortItems(items) {
  return [...items].sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      a.name.localeCompare(b.name)
  );
}

function countStatuses(items) {
  return items.reduce((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
}

function mergeStatusCounts(list) {
  return list.reduce((total, counts) => {
    for (const [status, count] of Object.entries(counts)) {
      total[status] = (total[status] ?? 0) + count;
    }
    return total;
  }, {});
}

export function renderBoardHtml(model) {
  const areaSummary = model.areaSummary
    .map((entry) => `${escapeHtml(entry.area)} ${entry.count}`)
    .join(" &middot; ");
  const statusSummary = model.statusSummary
    .map(
      (entry) =>
        `<span class="chip"><span class="dot" style="background:${STATUS_META[entry.status].color}"></span>${escapeHtml(
          STATUS_META[entry.status].label
        )} ${entry.count}</span>`
    )
    .join("");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(model.title)}</title>`,
    `<style>${boardStyles()}</style>`,
    "</head>",
    "<body>",
    "<header>",
    `<h1>${escapeHtml(model.title)}</h1>`,
    `<div class="meta">${escapeHtml(model.direction.from)} &rarr; ${escapeHtml(
      model.direction.to
    )} &middot; scopes: ${escapeHtml(model.scopes.join(", ") || "none")} &middot; ${escapeHtml(
      model.generatedAt
    )}</div>`,
    `<div class="meta areas">${areaSummary || "no items"}</div>`,
    `<div class="chips">${statusSummary}</div>`,
    '<input id="filter" type="text" placeholder="Filter by name or description…" autocomplete="off">',
    "</header>",
    '<main id="board">',
    model.areas.map(renderAreaSection).join(""),
    "</main>",
    `<script>${boardScript()}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function renderAreaSection(area) {
  const chips = STATUS_ORDER.filter((status) => area.statusCounts[status])
    .map(
      (status) =>
        `<span class="chip"><span class="dot" style="background:${STATUS_META[status].color}"></span>${area.statusCounts[status]}</span>`
    )
    .join("");

  return [
    '<section class="area">',
    `<h2>${escapeHtml(area.area)} <span class="count">${area.count}</span> <span class="chips">${chips}</span></h2>`,
    area.groups.map(renderGroup).join(""),
    "</section>",
  ].join("");
}

function renderGroup(group) {
  return [
    `<div class="group"><div class="scope-label">${escapeHtml(group.scope)}</div>`,
    group.items.map(renderItem).join(""),
    "</div>",
  ].join("");
}

function renderItem(item) {
  const meta = STATUS_META[item.status];
  const search = escapeHtml(`${item.name} ${item.description}`.toLowerCase());
  return [
    `<div class="item" data-search="${search}">`,
    '<div class="row">',
    `<span class="dot" style="background:${meta.color}"></span>`,
    `<span class="name">${escapeHtml(item.name)}</span>`,
    `<span class="desc">${escapeHtml(item.description)}</span>`,
    `<span class="badge">${escapeHtml(item.scope)}</span>`,
    "</div>",
    '<div class="detail" hidden>',
    `<div class="detail-status"><span class="dot" style="background:${meta.color}"></span>${escapeHtml(
      meta.label
    )}</div>`,
    item.description ? `<p>${escapeHtml(item.description)}</p>` : "",
    `<div class="path">Claude: ${escapeHtml(item.claudePath || "—")}</div>`,
    `<div class="path">Codex: ${escapeHtml(item.codexPath || "—")}</div>`,
    "</div>",
    "</div>",
  ].join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function boardStyles() {
  return [
    "*{box-sizing:border-box}",
    "body{margin:0;background:#0b0f14;color:#e5e7eb;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
    "header{position:sticky;top:0;background:#0b0f14;border-bottom:1px solid #1f2937;padding:16px 20px;z-index:1}",
    "h1{margin:0 0 4px;font-size:18px}",
    ".meta{color:#9ca3af;font-size:12px}",
    ".meta.areas{margin-top:4px;color:#cbd5e1}",
    ".chips{display:inline-flex;flex-wrap:wrap;gap:8px;margin-top:8px}",
    ".chip{display:inline-flex;align-items:center;gap:6px;background:#111827;border:1px solid #1f2937;border-radius:999px;padding:2px 10px;font-size:12px;color:#cbd5e1}",
    "#filter{margin-top:12px;width:100%;padding:8px 12px;background:#111827;border:1px solid #1f2937;border-radius:8px;color:#e5e7eb;font-size:14px}",
    "#filter:focus{outline:none;border-color:#2563eb}",
    "main{padding:12px 20px 40px}",
    ".area{margin-top:20px}",
    "h2{font-size:14px;margin:0 0 8px;display:flex;align-items:center;gap:8px;text-transform:capitalize}",
    "h2 .count{color:#6b7280;font-weight:400}",
    "h2 .chips{margin-top:0}",
    ".group{margin:0 0 10px}",
    ".scope-label{color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin:6px 0 2px}",
    ".item{border-bottom:1px solid #111827}",
    ".row{display:flex;align-items:center;gap:10px;padding:4px 6px;cursor:pointer;border-radius:6px}",
    ".row:hover{background:#111827}",
    ".dot{width:9px;height:9px;border-radius:50%;flex:none}",
    ".name{font-weight:500;flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".desc{color:#9ca3af;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}",
    ".badge{flex:none;font-size:11px;color:#9ca3af;background:#111827;border:1px solid #1f2937;border-radius:4px;padding:1px 6px}",
    ".detail{padding:8px 24px 12px;background:#0d131a;border-radius:6px;margin:2px 0 6px}",
    ".detail-status{display:flex;align-items:center;gap:6px;font-weight:500;margin-bottom:6px}",
    ".detail p{margin:0 0 8px;color:#cbd5e1}",
    ".path{color:#6b7280;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}",
  ].join("");
}

function boardScript() {
  return [
    "var filter=document.getElementById('filter');",
    "var items=Array.prototype.slice.call(document.querySelectorAll('.item'));",
    "filter.addEventListener('input',function(){",
    "var q=filter.value.trim().toLowerCase();",
    "for(var i=0;i<items.length;i++){",
    "var hit=!q||items[i].getAttribute('data-search').indexOf(q)!==-1;",
    "items[i].style.display=hit?'':'none';}});",
    "document.getElementById('board').addEventListener('click',function(e){",
    "var row=e.target.closest('.row');if(!row)return;",
    "var detail=row.nextElementSibling;if(detail)detail.hidden=!detail.hidden;});",
  ].join("");
}
