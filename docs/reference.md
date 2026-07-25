# AI Config Sync Manager Reference

Generated reference for every command, area, risk level, mapping quality, sync action verb, terminology layer, hidden marker, and known file location.

## Commands

### `connect`

Checks Claude and Codex installation state, registers missing local host integrations when possible, and prints manual actions when writes are blocked.

- `-h, --help` — Show connect help

### `status`

Print diff status between Claude and Codex configuration.

- `--json` — Print the full status report as JSON
- `--compact` — Print one compact line per diff entry
- `--tree` — Print scope/area/item tree output
- `--scope global|project|all` — Limit status scope
- `--include area[:item][,...]` — Include only selected areas or items
- `--exclude area[:item][,...]` — Exclude selected areas or items
- `-h, --help` — Show status help

### `sync`

Plan or apply synchronization between Claude and Codex configuration.

- `--dry-run` — Preview planned operations without writing files (default)
- `--apply` — Apply planned operations with backups
- `--plan-json` — Print the sync plan as JSON
- `--from claude|codex` — Source host (overrides AI_CONFIG_SYNC_HOST)
- `--to claude|codex` — Target host (overrides AI_CONFIG_SYNC_HOST)
- `--scope global|project|all` — Limit sync scope
- `--include area[:item][,...]` — Include only selected areas or items
- `--exclude area[:item][,...]` — Exclude selected areas or items
- `-h, --help` — Show sync help

### `reference`

Print this markdown reference document.

- `--output <path>` — Write the reference markdown to `<path>` (parent directories are created)
- `-h, --help` — Show reference help

### `paraphrase`

Recover bidirectional manual-review vocab mismatches by rewriting host-native tokens into shared paraphrases. Records each rewrite as a paraphrase override so future status/sync runs treat both sides as in sync. Stale overrides whose anchor lines no longer match are auto-invalidated.

- `--apply` — Persist rewrites, paraphrase map entries, and override archive (default is dry-run)
- `--register` — Skip the rewrite stage; diff claude/codex line-by-line and register an override entry for each line pair the effective map equates. Use when one side was pre-paraphrased outside the CLI so `lintHostVocab` finds nothing to rewrite.
- `--json` — Emit the full paraphrase report as JSON
- `--non-interactive` — Skip the TTY prompt for unmapped tokens (still emits them under `pendingTokens`)
- `--map "token=paraphrase[,...]"` — Provide one or more inline token→paraphrase mappings (CLI overrides paraphrase-map.json)
- `--scope global|project|all` — Limit paraphrase scope
- `--include area[:item][,...]` — Include only selected areas or items
- `--exclude area[:item][,...]` — Exclude selected areas or items
- `-h, --help` — Show paraphrase help

## Areas

Areas are the canonical buckets diffed and synced between hosts.

- `instructions` — Top-level instruction file (`CLAUDE.md` ↔ `AGENTS.md`).
- `skills` — Skill directories under `.claude/skills` and `.codex/skills` (one folder per skill).
- `agents` — Subagent definitions: Claude markdown frontmatter under `.claude/agents` ↔ Codex TOML under `.codex/agents`.
- `mcp` — MCP server registrations (`.mcp.json`, `.claude.json`, `settings.json` ↔ `config.toml [mcp_servers.*]`).
- `permissions` — Tool/bash/web permission rules (`settings.json` permissions ↔ Codex `[approvals]` / `default.rules`).
- `hooks` — Lifecycle hook configuration (`settings.json` hooks ↔ Codex `[[hooks.Event]]` blocks).

## Risk levels

- `safe` — Apply automatically; the source meaning is fully preserved on the target.
- `manual` — Hold for explicit review; mapping is lossy or the source file is missing. Apply will skip operations marked `approvalRequired: true` until rerun explicitly.

## Mapping qualities

Per-item indicator of how well one host's meaning is preserved on the other side.

- `exact` — Same value, same semantics on both hosts.
- `equivalent` — Different shape, identical effect (for example `CLAUDE.md` ↔ `AGENTS.md` instructions).
- `approximate` — Closest-fit mapping; behavior is similar but not identical (broad approval policies, prefix rules).
- `metadata-only` — The wrapper is preserved but inner behavior cannot be enforced on the target host.
- `unsupported` — No mapping exists; the item is left for manual review.

## Sync action verbs

Plan operations carry an `action` field that `applySyncPlan` dispatches on.

- `copy-file` — Copy a single file from source host to target host.
- `write-instructions` — Write transformed instruction content (after term/template/call rewrites) to the target instruction file.
- `copy-missing-skills` — Copy skill directories that are missing on the target, overwriting any conflicting skill bodies.
- `merge-agents` — Translate Claude agent frontmatter ↔ Codex agent TOML and write per-agent files.
- `merge-settings-items` — Merge permission or hook items into the target settings file.
- `merge-mcp-servers` — Merge MCP server entries into the target host's MCP config.
- `delete-items` — Delete items from the target that the baseline shows were removed on the source.
- `source-missing` — Source path does not exist; flagged manual and skipped on apply.
- `manual-review` — Area has no automatic mapping; surfaced for the user to handle.

### Status output symbols

- `+` — Item will be added on the target (copy from source).
- `-` — Item will be removed on the target (baseline-tracked deletion).
- `~` — Item exists on both hosts but content differs (will be overwritten on apply).
- `!` — Conflict that requires manual review.

## Terminology layers

Terminology rules live in `rules/terminology-map.json` (override at `~/.ai-config-sync-manager/rules/terminology-map.json` or `<project>/rules/terminology-map.json`). Each layer groups rules that rewrite host-specific vocabulary when transforming text between Claude and Codex.

### `files`

Host-specific config and instruction file names.

- `agent-product`
- `instruction-file`
- `global-settings-file`
- `mcp-config-file`
- `agent-file-path-grouped` — regex rule
- `agent-file-path` — regex rule
- `skill-file-path` — regex rule
- `skill-manifest-filename` — regex rule
- `claude-codex-prefix` — regex rule

### `host-surfaces`

Host UI and extension surfaces.

- `slash-command-term`
- `skill-surface-term`

### `orchestration`

Generic agent delegation and reasoning vocabulary. Workflow-specific intents live in host-target-templates.json.

- `reasoning-budget`
- `plan-mode`
- `subagent-term`
- `task-delegation`
- `agent-team`
- `team-create-call` — regex rule
- `task-create-call` — regex rule
- `send-message-call` — regex rule
- `exec-command-call` — regex rule

### `tool-paraphrase`

Paraphrase mappings for host-native tools that have no 1:1 cross-host equivalent. Each rule fires one-way (the host-native side carries the empty pattern). Risky common-word tokens (Read, Write, Edit, Glob, Grep, Skill, Monitor) are intentionally NOT included here because a bare-token regex would mis-fire on prose; they remain in host-strict-vocab manual-review until a stricter context anchor exists.

- `wait-agent-paraphrase` — regex rule
- `apply-patch-paraphrase` — regex rule
- `webfetch-paraphrase` — regex rule
- `websearch-paraphrase` — regex rule
- `notebookedit-paraphrase` — regex rule
- `toolsearch-paraphrase` — regex rule
- `enterplanmode-paraphrase` — regex rule
- `exitplanmode-paraphrase` — regex rule
- `enterworktree-paraphrase` — regex rule
- `exitworktree-paraphrase` — regex rule
- `schedulewakeup-paraphrase` — regex rule
- `pushnotification-paraphrase` — regex rule
- `croncreate-paraphrase` — regex rule
- `crondelete-paraphrase` — regex rule
- `cronlist-paraphrase` — regex rule
- `askuserquestion-paraphrase` — regex rule
- `remotetrigger-paraphrase` — regex rule
- `grep-paraphrase` — regex rule
- `glob-paraphrase` — regex rule

### `permissions`

Permission and sandbox vocabulary used in text instructions.

- `permission-term`
- `bash-permission-term`
- `workspace-write-term`
- `approval-policy-term`

### `commands`

Host CLI invocation vocabulary used in text instructions (headless / non-interactive forms).

- `headless-cli`

### `hooks-mcp`

Hook, MCP, and web access vocabulary used in text instructions.

- `hook-term`
- `command-hook-term`
- `mcp-tool-permission-term`
- `web-access-term`

### `model` (from `rules/agents-map.json`)

Model alias rules come from `rules/agents-map.json` `models.tiers` rather than the terminology map.

- `mythos-class-model` — `fable` ↔ `gpt-5.6-sol`
- `latest-frontier-model` — `opus` ↔ `gpt-5.6-terra`
- `balanced-model` — `sonnet` ↔ `gpt-5.6-luna`
- `small-fast-model` — `haiku` ↔ `gpt-5.4-mini`

The `alias` is what conversion writes. Each tier's `terms` are also accepted as model values, so superseded ids (`gpt-5.6`, `gpt-5.5`, `gpt-5.4`, `gpt-5.2`) and vendor-tagged variants (`gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, `gpt-5.1-codex`, `gpt-5-codex`) resolve to a tier instead of passing through unmapped. A token may appear in only one tier; an overlay wins because its tiers merge in last.

Accepting a spelling also makes it equivalent. A Codex file pinned to `gpt-5.5` and a Claude file on `opus` are the same tier, so `status` reports them in sync and `sync` never rewrites the pin to `gpt-5.6-terra`. That is the trade-off for converting superseded ids at all: a spelling cannot both convert to a tier and conflict with it. Change the pin by hand if you want the canonical id on disk.

## Paraphrase

Paraphrase recovers bidirectional manual-review vocab mismatches that the terminology map cannot translate (host-native tokens listed in `rules/host-strict-vocab.json`). It rewrites both sides to a shared paraphrase and registers an override so subsequent status runs treat the pair as in sync.

### Map and override files

- `rules/paraphrase-map.json` — Token→paraphrase entries grouped under `claude_only` / `codex_only`. Layered with the same precedence as terminology rules: `<project>/rules/paraphrase-map.json` → `~/.ai-config-sync-manager/rules/paraphrase-map.json` → `<repo>/rules/paraphrase-map.json`.
- `rules/paraphrase-overrides.json` — Override archive of accepted rewrites; each entry pins host paths, line numbers, anchor texts, and the rewriting tokens. Same layered precedence as the map.

### Counterpart matching

For each rewrite the paraphrase command resolves the counterpart line on the other host:

1. Read the counterpart file at the same line number; accept when text matches `before` exactly.
2. Otherwise scan the counterpart body for any line whose text equals `before`; pick the candidate closest to the original line number.
3. If neither step finds a match the rewrite is skipped with `counterpart-line-mismatch` (or `counterpart-file-not-found` when the counterpart file is missing).

### Override staleness

Overrides are auto-invalidated when the pinned anchor text no longer matches the current file content, so manual edits on either host cleanly retire the recorded pairing without leaving stale entries.

## Hidden markers

HTML comment markers the call compiler emits inside transformed text. They round-trip on a reverse sync and are not user-visible during normal use.

- `ai-config-sync:agent-call` — Supported call transformed (Claude `Agent({...})` ↔ Codex prose `spawn_agent`).
- `ai-config-sync:stripped` — Unsupported call removed (`TaskCreate`, `TaskUpdate`, `TeamCreate`); original archived under the backup root.
- `ai-config-sync:manual-review` — Call left intact because it could not be parsed; needs manual translation.

## Default direction precedence

1. Explicit `--from <host>` / `--to <host>` flags on `sync`.
2. `AI_CONFIG_SYNC_HOST=codex` environment variable — sets default direction to `codex -> claude`.
3. Otherwise the default is `claude -> codex`.

`status` follows the same default direction so that `+/-/~` symbols and `details` text describe the apply that would run with no override.

## Environment variables

- `AI_CONFIG_SYNC_HOST=codex` — Set default sync direction to `codex -> claude`.
- `AI_CONFIG_SYNC_HOME=<path>` — Override the home directory used for global config and state (primarily for tests).
- `AI_CONFIG_SYNC_STRIP_SECRETS=1` — Opt in to defensively stripping MCP env values whose keys look like secrets (`TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `AUTH`). Default behavior copies them because the source already stores the secret in plaintext under the same user's home; enable this if your source config is exposed beyond that trust boundary (e.g. dotfiles committed to git that include `.codex/config.toml`).

## File locations

### User-writable

- `~/.ai-config-sync-manager/state/<scope>.json` — Sync state baseline (one file per scope; project scope hashes the project root).
- `~/.ai-config-sync-manager/backups/<timestamp>/...` — Backup root for each apply run.
- `~/.ai-config-sync-manager/backups/<timestamp>/unsupported-calls.json` — Archive of stripped or manual-review calls (when applicable).
- `~/.ai-config-sync-manager/status-details/<timestamp>.txt` — Full diff detail when status is collapsed.
- `~/.ai-config-sync-manager/rules/agents-map.json` — Agent field and model alias rules (user customization point).
- `~/.ai-config-sync-manager/rules/status-ignore.json` — Persistent ignore rules used by `status` and `sync`. Template at `<repo>/docs/status-ignore.example.json`.
- `~/.ai-config-sync-manager/rules/paraphrase-map.json` — Persistent token→paraphrase entries learned from `paraphrase --apply` (layered: project/home/repo).
- `~/.ai-config-sync-manager/rules/paraphrase-overrides.json` — Override archive of accepted paraphrase rewrites; each entry pins matched line numbers and texts so status treats both sides as in sync.

### Bundled defaults (under the runtime root)

- `<repo>/rules/terminology-map.json` — Bundled terminology defaults (override at home or project).
- `<repo>/rules/host-target-templates.json` — Bundled target templates.
- `<repo>/rules/call-templates.json` — Bundled SDK call transform templates.
- `<repo>/rules/paraphrase-map.json` — Bundled paraphrase map defaults (override at home or project).
- `<repo>/rules/paraphrase-overrides.json` — Bundled paraphrase override archive defaults (override at home or project).
- `<repo>/rules/host-strict-vocab.json` — Host-native token list driving vocab-mismatch detection (`claude_only`, `codex_only`, `claude_only_patterns`).

Override precedence for any rule file: `<project>/rules/<name>.json` → `~/.ai-config-sync-manager/rules/<name>.json` → `<repo>/rules/<name>.json`. Layers are merged by id (rule.id, template.id, areas key, fields claude+codex pair, models.tiers id) — partial overlays only need to declare the entries they want to add or change.
