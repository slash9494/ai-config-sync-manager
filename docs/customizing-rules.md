# Customizing Rules

This tool uses 5 mapping rule files for Claude ↔ Codex conversion. Each file accepts a partial-overlay override file, so you can layer your own style on top of the bundled defaults without touching them.

## Override Precedence

When the same rule file exists in multiple locations, the precedence is:

| Rank        | Location                                      | Purpose               |
| ----------- | --------------------------------------------- | --------------------- |
| 1 (highest) | `<project-root>/rules/<name>.json`            | per-project override  |
| 2           | `~/.ai-config-sync-manager/rules/<name>.json` | machine-wide override |
| 3 (default) | `<install-path>/rules/<name>.json`            | bundled default       |

If a project override exists, it wins over the machine-wide one. The bundled default applies only to entries that no override touches.

## How Layered Merge Works

Each rule file supports **id-based deep merge**. Only the entries you write into the override file are overlaid on the bundle; everything else stays as the bundle ships it.

```
bundled default       user overlay          final result
─────────────         ──────────────        ──────────────
{ id: "A",        +  { id: "A",        →  { id: "A",
  foo: "base",         foo: "custom" }      foo: "custom",
  bar: "base" }                              bar: "base" }   ← untouched fields survive

{ id: "B",                              →  { id: "B",       ← bundle entry kept verbatim if no overlay
  foo: "base" }                              foo: "base" }      with that id

                       { id: "C",       →  { id: "C",       ← ids only in the overlay are appended
                         foo: "new" }        foo: "new" }
```

**Rule summary**

- Overlay entries with the same id are **shallow-merged at the field level** on top of the base entry.
- Bundle entries whose id is not in the overlay are **kept as-is**.
- Ids that exist only in the overlay are **appended at the end** of the array.
- Note: array-typed fields (e.g. `claude` / `codex` term lists) are **replaced wholesale** by the overlay value.

## When to write an override file

- When your prose uses a natural-language variant the bundle does not know (e.g. internal nickname "AI assistant" → Claude Code).
- When you want to add a custom delegation pattern that only your project uses.
- When you want to preserve a specific SDK call as a custom marker instead of stripping it (or vice versa).
- When `mcp` / `permissions` / `hooks` policy needs to differ from the bundle to fit your environment.
- When you want a new model tier alias to take effect before the bundle ships it.

---

## Per-File Recipes

### terminology-map.json

**Merge keys:** `layer.id` plus the `rule.id` within each layer.

Translates host-specific expressions in prose bidirectionally. To add internal jargon or project-specific phrasing, append a new rule to the `files` or `host-surfaces` layer, or replace the `terms` list of an existing rule.

**Recipe: add internal brand vocabulary**

When your team calls it "AI coding assistant" but it should map to Claude Code:

```json
// ~/.ai-config-sync-manager/rules/terminology-map.json
{
  "layers": [
    {
      "id": "files",
      "rules": [
        {
          "id": "agent-product",
          "claude": ["Claude Code", "AI coding assistant", "Claude"],
          "codex": ["Codex CLI", "coding CLI", "Codex"]
        }
      ]
    }
  ]
}
```

Overlay result: the `claude` array of the `agent-product` rule is replaced by the values above; the other rules (`instruction-file`, `global-settings-file`, etc.) are kept as the bundle ships them.

**Conversion example**

```
# Before (CLAUDE.md body)
For AI coding assistant settings, see .claude/settings.json.

# After sync → AGENTS.md body
For coding CLI settings, see .codex/config.toml.
```

**Recipe: add a new layer**

You can also add a layer the bundle does not have (e.g. internal security-policy vocabulary):

```json
{
  "layers": [
    {
      "id": "security-terms",
      "description": "internal security-policy vocabulary",
      "rules": [
        {
          "id": "review-gate",
          "claude": ["security review required"],
          "codex": ["approval-required", "manual-review gate"]
        }
      ]
    }
  ]
}
```

The bundled `files`, `host-surfaces`, `orchestration`, `permissions`, `hooks` layers are kept untouched, and `security-terms` is appended.

---

### host-target-templates.json

**Merge key:** `template.id`

Manages aliases and canonical targets for delegation / command / skill / hook surfaces. Use this when your project has its own delegation pattern, or when you want to add the command surface of a workflow tool like gstack.

**Recipe: add project-specific delegation surface aliases**

```json
// <project>/rules/host-target-templates.json
{
  "templates": [
    {
      "id": "delegation-surface",
      "aliases": {
        "claude": [
          "Task tool",
          "Task-tool delegation",
          "Claude subagent delegation",
          "gstack delegation"
        ],
        "codex": [
          "spawn_agent",
          "sub-agent delegation",
          "Codex worker/explorer delegation",
          "gstack worker"
        ]
      },
      "target": {
        "claude": "Claude Task-tool delegation",
        "codex": "Codex spawn_agent delegation"
      }
    }
  ]
}
```

The `aliases.claude` array of the `delegation-surface` template is replaced wholesale; the bundle's `command-surface`, `skill-surface`, and `hook-surface` templates are not affected.

**Recipe: add a new surface**

You can add a surface the bundle does not have (e.g. a pipeline trigger):

```json
{
  "templates": [
    {
      "id": "pipeline-trigger",
      "aliases": {
        "claude": ["CI trigger", "pipeline run"],
        "codex": ["codex pipeline run", "pipeline trigger"]
      },
      "target": {
        "claude": "CI trigger",
        "codex": "codex pipeline run"
      }
    }
  ]
}
```

---

### call-templates.json

**Merge key:** `id` (within each of the supported / unsupported arrays)

Rules for converting Claude SDK calls (e.g. `Agent(...)`, `TaskCreate(...)`) into Codex prose, or stripping them. Use this to add SDK calls the bundle does not know about, or to swap the default strip behavior for a custom marker.

**Recipe: add a new unsupported call (strip)**

When you want to flag the unknown `ScheduleCreate` call with a marker on the Codex side:

```json
// ~/.ai-config-sync-manager/rules/call-templates.json
{
  "unsupported": [
    {
      "id": "schedule-create",
      "claude_call": "ScheduleCreate",
      "codex_marker": "ai-config-sync:stripped",
      "reason": "Codex has no native schedule primitive"
    }
  ]
}
```

The bundle's `task-create`, `task-update`, and `team-create` strip rules remain intact.

**Recipe: promote an unsupported call to supported**

When a call the bundle strips should actually be converted in your environment, add it under `supported` with the same `id`:

```json
{
  "supported": [
    {
      "id": "task-create",
      "claude_call": "TaskCreate",
      "codex_marker": "ai-config-sync:task-call",
      "claude_template": "TaskCreate({{ARGS_JSON}})",
      "codex_template": "# Task\n{{title}}\n\n{{description}}\n",
      "field_aliases": {
        "claude_to_codex": { "title": "title", "description": "description" }
      }
    }
  ]
}
```

> Note: when the same `id` exists in both `supported` and `unsupported`, `supported` wins (the engine searches `supported` first). This holds regardless of bundle ordering.

---

### claude-to-codex.json / codex-to-claude.json

**Merge key:** the keys of the `areas` object (instructions / skills / mcp / permissions / hooks / commands)

Defines per-area policy for each sync direction. Use this when the bundle's `permissions` or `hooks` policy does not fit your environment — you swap out only the affected area.

**Recipe: lower the permissions area risk to safe**

```json
// <project>/rules/claude-to-codex.json
{
  "source": "claude",
  "target": "codex",
  "areas": {
    "permissions": {
      "risk": "safe",
      "mapping": "Claude permissions to Codex sandbox rules",
      "nativeTargets": {
        "Bash(<pattern>)": "rules/project.rules prefix_rule(pattern=[...], decision=allow)"
      }
    }
  }
}
```

The `instructions`, `skills`, `mcp`, `hooks`, and `commands` areas keep the bundled policy.

**Recipe: disable a specific area (codex → claude direction)**

To force `hooks` to manual review and prevent automatic application:

```json
// ~/.ai-config-sync-manager/rules/codex-to-claude.json
{
  "source": "codex",
  "target": "claude",
  "areas": {
    "hooks": {
      "risk": "manual",
      "mapping": "Always hold for manual review regardless of hook type"
    }
  }
}
```

---

### agents-map.json

**Merge keys:** `fields` is keyed by `(claude, codex)` pairs; `models.tiers` is keyed by `id`.

Manages agent field mappings and model tier aliases. Use this when you want to add a tier before the bundle ships it, or to attach in-house phrasing to an existing tier.

A tier's `claude` and `codex` objects are replaced wholesale, not merged field by field. `terms` decide which model values convert, so an overlay that lists only its own spellings drops the bundled ones — a model written in a dropped spelling then passes through unconverted. Repeat the bundled `terms` you still want alongside yours.

**Recipe: add an alias to the existing balanced-model tier**

```json
// ~/.ai-config-sync-manager/rules/agents-map.json
{
  "models": {
    "tiers": [
      {
        "id": "balanced-model",
        "claude": {
          "alias": "sonnet",
          "terms": ["sonnet(latest)", "Claude Sonnet", "Sonnet", "standard model"]
        },
        "codex": {
          "alias": "gpt-5.6-luna",
          "terms": ["gpt-5.4", "gpt-5.1-codex-mini", "GPT-5.6 Luna", "standard model"]
        }
      }
    ]
  }
}
```

The `mythos-class-model`, `latest-frontier-model`, and `small-fast-model` tiers and the `fields` array are kept as the bundle ships them.

**Recipe: add a new model tier**

To register a fine-tuned model the bundle does not know about:

```json
{
  "models": {
    "tiers": [
      {
        "id": "custom-ft-model",
        "claude": {
          "alias": "claude-ft-v1",
          "terms": ["Claude FT v1", "in-house fine-tuned"]
        },
        "codex": {
          "alias": "gpt-ft-v1",
          "terms": ["GPT FT v1", "in-house fine-tuned"]
        }
      }
    ]
  }
}
```

**Recipe: add a new agent field**

To map a new Codex `max_turns` field to Claude's `max_iterations`:

```json
{
  "fields": [
    {
      "claude": "max_iterations",
      "codex": "max_turns",
      "level": "approximate"
    }
  ]
}
```

The bundle's existing `fields` entries (name, description, body ↔ developer_instructions, model, tools, color, memory, etc.) are kept as-is.

---

## Tips

- **Write only the entries you want to change into the partial file.** If the id matches, it merges over the base; otherwise it appends. You don't have to copy the whole file to tweak it.
- **Array fields are replaced wholesale.** `claude` / `codex` term lists, `aliases` arrays, etc. are fully replaced by the overlay, so to keep bundle entries you must include them in the overlay too.
- **Bundle updates do not affect your overlays.** New ids in the bundle are appended after merging, and they coexist with your overlays unless they collide.
- **When the conversion result is unexpected,** check the diff with `ai-config-sync status`. If it's hard to trace which rule rewrote what, use the `--json` flag for verbose output.
- **Project overrides and machine-wide overrides can be used together.** If a project file exists it wins; otherwise we fall back to machine-wide → bundle.

## status-ignore.json is separate

`status-ignore.json` does not participate in layered merge. It is a user-data file: out of the three locations, **only the first one found is used** (first-match). It is not combined with the bundled default. For the schema, see `docs/status-ignore.example.json`.
