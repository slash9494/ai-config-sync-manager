const BOARD_TITLE = "AI Config Sync Board";

// Ordered by display priority (most-actionable first); STATUS_ORDER derives from this.
const STATUS_META = {
  conflict: { label: "Conflict", color: "#ef4444" },
  unsupported: { label: "Unsupported", color: "#f59e0b" },
  "claude-only": { label: "Claude only", color: "#3b82f6" },
  "codex-only": { label: "Codex only", color: "#a855f7" },
  "in-sync": { label: "In sync", color: "#22c55e" },
};

const STATUS_ORDER = Object.keys(STATUS_META);

export function buildBoardModel(
  { inventory = [], overlays = [], direction, scopes = [] },
  describe = () => ""
) {
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
      harness: item.harness ?? null,
    });
  }

  for (const overlay of overlays) applyOverlay(merged, overlay);

  const items = [...merged.values()];
  for (const item of items) item.description = safeDescribe(describe, item);

  const areas = [...groupByArea(items).values()]
    .map(buildAreaSection)
    .sort((a, b) => b.count - a.count);

  return {
    direction,
    scopes,
    generatedAt: new Date().toISOString(),
    areaSummary: areas.map((area) => ({ area: area.area, count: area.count })),
    statusSummary: orderedStatusSummary(mergeStatusCounts(areas.map((area) => area.statusCounts))),
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

function applyOverlay(merged, overlay) {
  const key = itemKey(overlay.scope, overlay.area, overlay.name);
  const existing = merged.get(key);
  if (existing) {
    existing.status = overlay.status;
    return;
  }
  merged.set(key, {
    area: overlay.area,
    scope: overlay.scope,
    name: overlay.name,
    status: overlay.status,
    claudePath: overlay.claudePath ?? "",
    codexPath: overlay.codexPath ?? "",
    harness: null,
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

function buildAreaSection(area) {
  const groups = new Map();
  for (const item of area.items) {
    const group = groups.get(item.scope) ?? { scope: item.scope, items: [] };
    group.items.push(item);
    groups.set(item.scope, group);
  }

  const groupByHarness = area.area === "agents";
  const orderedGroups = [...groups.values()]
    .map((group) => buildScopeGroup(group, groupByHarness))
    .sort((a, b) => a.scope.localeCompare(b.scope));

  const statusCounts = countStatuses(area.items);
  return {
    area: area.area,
    count: area.items.length,
    statusCounts,
    statusSummary: orderedStatusSummary(statusCounts),
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

function buildScopeGroup(group, groupByHarness) {
  if (!groupByHarness) return { scope: group.scope, items: sortItems(group.items) };
  return { scope: group.scope, harnessGroups: buildHarnessGroups(group.items) };
}

function buildHarnessGroups(items) {
  const byHarness = new Map();
  for (const item of items) {
    const harness = item.harness ?? null;
    const bucket = byHarness.get(harness) ?? { harness, items: [] };
    bucket.items.push(item);
    byHarness.set(harness, bucket);
  }
  return [...byHarness.values()]
    .map((bucket) => ({ harness: bucket.harness, items: sortItems(bucket.items) }))
    .sort(compareHarnessGroups);
}

// Ungrouped (root) agents render first, then named harnesses alphabetically.
function compareHarnessGroups(a, b) {
  if (a.harness === b.harness) return 0;
  if (a.harness === null) return -1;
  if (b.harness === null) return 1;
  return a.harness.localeCompare(b.harness);
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

function orderedStatusSummary(counts) {
  return STATUS_ORDER.filter((status) => counts[status]).map((status) => ({
    status,
    count: counts[status],
  }));
}

export function renderBoardHtml(model) {
  const areaSummary = model.areaSummary
    .map((entry) => `${escapeHtml(entry.area)} ${entry.count}`)
    .join(" &middot; ");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(BOARD_TITLE)}</title>`,
    `<style>${boardStyles()}</style>`,
    "</head>",
    "<body>",
    "<header>",
    `<h1>${escapeHtml(BOARD_TITLE)}</h1>`,
    `<div class="meta">${escapeHtml(model.direction.from)} &rarr; ${escapeHtml(
      model.direction.to
    )} &middot; scopes: ${escapeHtml(model.scopes.join(", ") || "none")} &middot; ${escapeHtml(
      model.generatedAt
    )}</div>`,
    `<div class="meta areas">${areaSummary || "no items"}</div>`,
    `<div class="chips">${renderStatusChips(model.statusSummary, true)}</div>`,
    `<div class="tabs">${renderAreaTabs(model.areaSummary)}</div>`,
    '<input id="filter" type="text" placeholder="Filter by name or description…" autocomplete="off">',
    "</header>",
    '<main id="board">',
    model.areas.map((area, index) => renderAreaSection(area, index === 0)).join(""),
    "</main>",
    `<script>${boardScript()}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function renderStatusChips(statusSummary, withLabel) {
  return statusSummary
    .map((entry) => {
      const meta = STATUS_META[entry.status];
      const text = withLabel ? `${escapeHtml(meta.label)} ${entry.count}` : `${entry.count}`;
      return `<span class="chip"><span class="dot" style="background:${meta.color}"></span>${text}</span>`;
    })
    .join("");
}

function renderAreaTabs(areaSummary) {
  return areaSummary
    .map(
      (entry, index) =>
        `<button type="button" class="tab${index === 0 ? " active" : ""}" data-tab="${escapeHtml(
          entry.area
        )}">${escapeHtml(entry.area)} <span class="tab-count">${entry.count}</span></button>`
    )
    .join("");
}

function renderAreaSection(area, active) {
  return [
    `<section class="area" data-area="${escapeHtml(area.area)}"${active ? "" : " hidden"}>`,
    `<h2>${escapeHtml(area.area)} <span class="count">${area.count}</span> <span class="chips">${renderStatusChips(
      area.statusSummary,
      false
    )}</span></h2>`,
    area.groups.map(renderGroup).join(""),
    "</section>",
  ].join("");
}

function renderGroup(group) {
  const body = group.harnessGroups
    ? group.harnessGroups.map(renderHarnessGroup).join("")
    : group.items.map(renderItem).join("");
  return `<div class="group"><div class="scope-label">${escapeHtml(group.scope)}</div>${body}</div>`;
}

function renderHarnessGroup(harnessGroup) {
  const label = harnessGroup.harness
    ? `<div class="harness-label">${escapeHtml(harnessGroup.harness)}</div>`
    : "";
  return `${label}${harnessGroup.items.map(renderItem).join("")}`;
}

function renderItem(item) {
  const meta = STATUS_META[item.status];
  const search = escapeHtml(
    `${item.name} ${item.description} ${item.harness ?? ""}`.trim().toLowerCase()
  );
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
    ".tabs{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}",
    ".tab{display:inline-flex;align-items:center;gap:6px;background:#111827;border:1px solid #1f2937;border-radius:6px;padding:4px 12px;color:#9ca3af;font-size:13px;cursor:pointer;text-transform:capitalize}",
    ".tab:hover{color:#e5e7eb}",
    ".tab.active{background:#1f2937;color:#e5e7eb;border-color:#2563eb}",
    ".tab-count{color:#6b7280;font-size:11px}",
    "#filter{margin-top:12px;width:100%;padding:8px 12px;background:#111827;border:1px solid #1f2937;border-radius:8px;color:#e5e7eb;font-size:14px}",
    "#filter:focus{outline:none;border-color:#2563eb}",
    "main{padding:12px 20px 40px}",
    ".area{margin-top:20px}",
    "h2{font-size:14px;margin:0 0 8px;display:flex;align-items:center;gap:8px;text-transform:capitalize}",
    "h2 .count{color:#6b7280;font-weight:400}",
    "h2 .chips{margin-top:0}",
    ".group{margin:0 0 10px}",
    ".scope-label{color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin:6px 0 2px}",
    ".harness-label{color:#818cf8;font-size:11px;font-weight:600;letter-spacing:.03em;margin:6px 0 2px 10px}",
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
    "var tabs=Array.prototype.slice.call(document.querySelectorAll('.tab'));",
    "var sections=Array.prototype.slice.call(document.querySelectorAll('.area'));",
    "function applyFilter(){",
    "var query=filter.value.trim().toLowerCase();",
    "for(var idx=0;idx<items.length;idx++){",
    "var hit=!query||items[idx].getAttribute('data-search').indexOf(query)!==-1;",
    "items[idx].style.display=hit?'':'none';}}",
    "function activateTab(area){",
    "for(var s=0;s<sections.length;s++){sections[s].hidden=sections[s].getAttribute('data-area')!==area;}",
    "for(var t=0;t<tabs.length;t++){tabs[t].classList.toggle('active',tabs[t].getAttribute('data-tab')===area);}}",
    "filter.addEventListener('input',applyFilter);",
    "tabs.forEach(function(tab){tab.addEventListener('click',function(){activateTab(tab.getAttribute('data-tab'));});});",
    "document.getElementById('board').addEventListener('click',function(event){",
    "var row=event.target.closest('.row');if(!row)return;",
    "var detail=row.nextElementSibling;if(detail)detail.hidden=!detail.hidden;});",
  ].join("");
}
