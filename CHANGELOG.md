# Ai-config-sync-manager

## v0.1.8 (unreleased)

### 🚀 Features

- **board**: add an HTML inventory board of both hosts colored by sync status (#35, #36). A new read-only `board` subcommand renders every skill, agent, hook, and MCP server from Claude and Codex into a single self-contained HTML page (no external requests, zero runtime deps), reusing the existing `status` engine for diff data. Items split into per-area tabs and are colored by sync state — green in-sync, red conflict, blue Claude-only, purple Codex-only, amber unsupported — with agents grouped under their harness (the `agents/` subfolder). A filter box narrows by name, description, or harness. The board opens in the default browser by default (`--no-open` to skip). The renderer is a pure module (`bin/util/board-html.mjs`); the CLI normalizes the engine's diff shape into an overlay DTO so the renderer never reaches into engine internals. Overlays are restricted to the four inventoried areas and honor status-ignore rules, so the board never contradicts `status`; the browser opener is a detached fire-and-forget `spawn` (with a no-op error listener) so a missing or wedged opener never blocks or crashes the CLI.

## v0.1.7 (2026-07-12)

### 🛠 Chore

- **rules/agents-map**: bump `models.tiers` to the current frontier (#31) — latest-frontier `Opus 4.7 → 4.8` and `gpt-5.5 → gpt-5.6`, balanced tier gains `Claude Sonnet 5`. Version-independent aliases (`opus`/`sonnet`) keep old configs mapping; the `terms` lists carry the new display names so free-text terminology mapping rewrites the new model names too.
- **snapshots**: refresh Claude/Codex upstream snapshots and record the resulting uncovered keys (#31). Claude changelog/settings-schema and Codex config-schema/releases are updated; 47 new upstream keys that have no cross-host mapping are registered as intentional drops in `rules/upstream-known-unsupported.json` (each with `reason`/`decided_in`/`decided_at`/`direction`/`recheck_after`) so they stop reappearing as drift noise.

## v0.1.6 (2026-07-09)

### 🐛 Bug Fixes

- **sync/backup**: back up correctly when the target lives on a Windows drive root (#28). `backupPath` mirrored the target under the backup root after stripping only a leading `/`, which never removes a `C:\` drive — so on Windows the leftover `:`/`\` produced an invalid path segment, `mkdir` failed, and the backup (plus the `--apply` that depends on it) aborted. The backup path is now derived through `parse`/`relative` with a sanitized drive label (`E:\ → E`); POSIX layout is preserved byte-for-byte, so Linux/macOS backups are unchanged. Thanks to @VVeb1250 for the report and fix.

## v0.1.5 (2026-06-27)

### 🚀 Features

- **sync/apply-ledger**: record a per-item apply ledger with sha256 attestation (#13). Every `sync --apply` now writes `~/.ai-config-sync-manager/ledgers/<timestamp>.json` capturing, for each operation, its `scope`/`area`/`item`/`action`/`status`, the `before_hash` and `after_hash` of the on-disk target (full sha256, no truncation — distinct from the casing-normalized 12-char `skillContentHash` family so the ledger attests exact bytes), the `backup_path` taken, a `plan_hash`, and a run `summary`. Coverage spans every apply path including `vocab-fix` rewrites, with `before_hash` captured before the mutation. The directory-tree hash walk skips symlinks to avoid infinite recursion on cyclic links. `--ledger <path>` writes an extra copy to an arbitrary path and `--ledger-json` prints the ledger to stdout (both `--apply` only); the default ledger directory is pruned FIFO to `LEDGER_RETENTION` (300).

## v0.1.4 (2026-06-21)

### 🚀 Features

- **sync/call-templates**: promote `TeamDelete` from unsupported to `supported`, mapping a Claude `TeamDelete({ team_name })` call to a Codex teardown prose line through a new `ai-config-sync:team-delete-call` marker. Mirrors the v0.1.3 `TeamCreate` rule so the bare-call form finally has a conversion path: `terminology-map` excludes bare calls via the `(?!\s*\()` lookahead and defers them to `call-templates.json`, which previously had no `TeamDelete` entry — so the call fell through both layers and left a permanent phantom `TeamDelete → multiple spawn_agent invocations` vocab auto-fix that no sync path ever resolved. Reverse sync round-trips the marker back to `TeamDelete({...})`.
- **status**: always write the per-run detail file and print its path, not only when diff entries or vocab findings exist. `renderStatus` previously gated `writeStatusDetailFile` behind `hasDetail = entries > 0 || vocabFindings > 0`, so a clean run — or one carrying only stale paraphrase overrides — produced no detail file, leaving stale entries impossible to inspect from disk. `STATUS_DETAILS_RETENTION` pruning already bounds file growth.

### 🐛 Bug Fixes

- **sync/terminology**: stop the generic `claude-codex-prefix` catchall from rewriting `.claude/rules` references to `.codex/rules` (#15). The rule swapped any `.claude/<rest>` prefix to `.codex/<rest>`, collapsing `.claude/rules` (path-scoped guidance docs Claude Code loads by file match, `paths:` frontmatter) into `.codex/rules` (Codex `prefix_rule` command-approval policy) — unrelated concepts, so the synced `AGENTS.md` pointed at non-existent files and the terminology map masked it as a no-diff equivalence. `rules` is now carved out of the catchall in both directions via the same negative-lookahead that already protects `settings.json`/`mcp.json`/`config.toml`; the `\b` boundary keeps it precise so a non-exact segment like `.claude/rulesfoo/...` still falls through to the generic swap.
- **status/host-vocab**: drop the `Task*` family (`TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`) from `host-strict-vocab.json` `claude_only`. `lintHostVocab` matches tokens with a bare `\bTOKEN\b` and no bare-call lookahead, so a `TaskCreate(...)` call sitting in a Codex file was flagged as a vocab mismatch and reported as an `auto-fix` — yet `terminology-map` excludes the bare-call form via `(?!\s*\()` and v0.1.3 removed `TaskCreate`/`TaskUpdate` from the template registry for verbatim pass-through, so no code path ever performed the advertised rewrite. Codex interprets (or skips) these tokens on its own; they must not be flagged.
- **status/skill equivalence**: fold the skill model alias to canonical in the masked and override hashes (#10, #14). `skillContentHash` normalized every manifest to the canonical (claude) model alias on read, but the sibling equivalence hashes (`maskedSkillContentHash`, `overriddenTransformedSkillContentHash`) applied `transformTextForHost` without folding the model token back, so a skill differing only by a model alias hashed differently and surfaced as a phantom manual-risk conflict in `status`. Running the post-transform text back through `normalizeSkillFileText` closes the gap left by the alias-keyed `normalizeModelAlias` — a tier _term_ like "Opus" stays unfolded on read and is only collapsed by the post-transform normalize. Follow-up to the v0.1.2 skill preview/copy alias normalization.
- **status/skill diff**: eliminate phantom `model:` lines in the `status` skill diff preview (#10, #14). `skillDirChangePreview` rendered the `<host> current` side from `readSkillFileForHash` (which folds the model alias to canonical, e.g. codex `gpt-5.5 → opus`) but built the `After apply` side from a bare `transformTextForHost` forward pass (`opus → gpt-5.5`) without folding back, so a skill with real body diffs still surfaced a spurious `- model: opus / + model: gpt-5.5` pair even though apply changes nothing on the target. The forward-transformed source is now wrapped in `normalizeSkillFileText(...)`, matching the canonical fold already used by `transformedSkillContentHash`, so equivalent model aliases collapse and only genuine differences render.

## v0.1.3 (2026-05-24)

### 🚀 Features

- **sync/call-templates**: parse Claude SDK calls authored in flat named-arg form (`Agent( description: ..., model: ..., prompt: ... )`), not just the braced object literal form. `parseSingleObjectArgument` now wraps the trimmed input in synthetic braces and reparses with the strict reader; the dominant style in real `SKILL.md` files no longer collapses to a manual-review marker.
- **sync/call-templates**: promote `TeamCreate` from `unsupported` to `supported`, mapping a Claude `TeamCreate({ team_name, members: [...] })` call to a per-member `multi_agent_v2.spawn_agent` prose block on the Codex side. `renderCodexTemplate` gains a `{{#each FIELD}}...{{/each}}` block expander to fan out the `members` array — one prose section per entry — with the inner template rendered against the entry as its own field bag. Reverse sync (codex→claude) reuses the existing supported-rule loop so the marker round-trips back into a `TeamCreate({...})` call.
- **sync/call-templates**: drop `TaskCreate` and `TaskUpdate` from the template registry entirely. When the surrounding skill prose already documents conditional skip (e.g. "optional / if exposed / otherwise skip"), the call can pass through verbatim and the destination host interprets it on its own — no stripped marker, no archive entry, no round-trip plumbing needed.

### 🛠 Migration

- Legacy codex `SKILL.md` files that already carry a `<!-- ai-config-sync:stripped {"call":"TaskCreate", ...} -->` marker from earlier versions are not rewritten by this release. On the next claude→codex apply the target file is replaced wholesale, so the marker disappears; codex→claude reverse syncs leave the marker in place (no rule to consume it). Cosmetic only — runtime behavior unaffected.

## v0.1.2 (2026-05-24)

### 🐛 Bug Fixes

- **sync/skill preview**: apply model alias normalization in the dry-run/status preview path. `skillPreview` called `normalizeYamlFrontmatter` without `from`/`to`, so the fallback `modelAliasMap("codex","claude")` could not translate `opus → gpt-5.5` for claude→codex previews. Users saw `+ After apply from Claude L4: model: opus` even though apply (fixed in v0.1.1's follow-up) would correctly write `gpt-5.5`. Both `skillPreview` call sites now call `normalizeSkillManifestFrontmatter` with the direction so the preview matches the apply result.
- **sync/skill copy**: `copyFileWithMappings` invoked `normalizeSkillManifestFrontmatter` without `normalizeModelAlias`, so a Claude `SKILL.md` authored with `model: opus` was copied to Codex verbatim instead of being rewritten to `model: gpt-5.5`. The mismatch then surfaced as a manual conflict on every subsequent sync because the destination host could not resolve the foreign alias. Direction-aware lookup (`modelAliasMap(from, to)`) replaces the hardcoded codex→claude map; the codex→claude fallback is kept for the status-side normalizer that intentionally invokes the helper without `from`/`to`.

### 🚀 Features

- **ci/upstream-compat**: harden the compat scan with an allowlist + nested keys + hash drift + recheck expiry + enum drift. Adds `rules/upstream-known-unsupported.json` (bidirectional entries with `reason`/`decided_in`/`decided_at`/`direction`/`schema_desc_hash`/`recheck_after`) so deliberate non-mappings stop reappearing as drift noise. A nested-path scan over `definitions.<Type>.properties.<field>` catches changes to `RawMcpServerConfig`, `HooksToml`, `NetworkProxyConfigToml`, and other `$ref`-targets the top-level scan misses. A hash-drift section flags allowlist entries whose recorded `schema_desc_hash` no longer matches the current upstream description, and a recheck-due section surfaces entries whose `recheck_after` date has passed — forcing periodic re-evaluation instead of permanent exclusion. An enum-drift section watches `sandbox_mode`/`approval_policy`/`web_search` and Claude hook event names, marking `STALE HARDCODED` entries when the value `bin/ai-config-sync.mjs` emits is no longer in the schema enum.
- **ci/upstream-compat**: mark triggered Layer 4 checklist items in the drift PR body. The static 7-entry checklist treated every line as equally relevant regardless of drift content. Keyword matchers now scan added lines from changelog/release diffs and append `_(triggered: …)_` markers to each item that actually applies, so reviewers can skip the irrelevant ones.

### 🛠 Chore

- **snapshots**: refresh Claude/Codex upstream snapshots — Claude changelog through v2.1.148, Codex schema/release snapshots (introduces `apps_mcp_product_sku`, `desktop`, `include_collaboration_mode_instructions`, `model_auto_compact_token_limit_scope`; intentionally unmapped — recorded in `rules/upstream-known-unsupported.json`).
- **docs**: reorder `AGENTS.md` pre-work reading list to put `README.md` first, then `package.json` + `scripts/build-dist.mjs`, with direct source as the last resort.

## v0.1.1 (2026-05-14)

### 🐛 Bug Fixes

- **codex hooks**: rename the native hooks feature flag from `codex_hooks` to `hooks` to match the upstream codex schema rename (openai/codex@0d9a5d2, shipped in codex-cli 0.129.0). `bin/ai-config-sync.mjs` used to write `[features] codex_hooks = true`, leaving the toggle dead on current codex versions; native hooks now activate on apply.
- **vocab**: remove the `^mcp__` entry from `claude_only_patterns` in `rules/host-strict-vocab.json`. MCP tool naming (`mcp__<server>__<tool>`) is shared by both hosts — codex registers MCP servers under the same namespace (e.g. `[mcp_servers.playwright]` in `~/.codex/config.toml`), so flagging every `mcp__*` token on the codex side produced false-positive vocab-mismatch warnings on skills like `visual-bug-hunter` that legitimately call `mcp__playwright__*`. The key is retained empty for future host-specific namespace entries.

### 🚀 Features

- **ci/upstream-compat**: add a "removed upstream keys still referenced" pass to the upstream-compat drift PR. The existing ADDED-only compat scan (`comm -23`) silently passed upstream renames and removals — a top-level schema key deleted upstream but still referenced in `rules/*.json` or `bin/ai-config-sync.mjs` produced no signal. A new `comm -13` pass surfaces these as a dedicated PR body section so renames like `codex_hooks → hooks` are caught at drift time.

### 🛠 Chore

- **snapshots**: refresh Claude upstream snapshots (v2.1.140, v2.1.141) and Codex schema/release snapshots.

## v0.1.0 (2026-05-08)

First stable release. Consolidates the `0.1.0-beta.0` → `0.1.0-beta.6` series. No code changes from beta.6.

## v0.1.0-beta.6 (2026-05-08)

### 🐛 Bug Fixes

- **yaml frontmatter**: extract a strict-safe scalar guard at `bin/util/yaml-scalar.mjs` and route claude→codex sync serialization through it. Bare scalars starting with YAML 1.2 indicators (e.g. `globs: **/*.{js,ts,jsx,tsx,py,go,java}`) used to parse on Claude's lenient loader but trip Codex's strict 1.2 parser as aliases (`unidentified alias "*/*."`), dropping the whole frontmatter — including `name` — so the affected skill silently lost its identity on the Codex side. Guard covers rule [22] c-indicators (`- ? : , [ ] { } # & * ! | > ' " % @ \``), YAML 1.1 coercion compat (single-letter bools `y/Y/n/N`, `null/true/false/yes/no/on/off`variants, integers/floats/exponents/hex/octal/binary, special floats`.NaN/.inf`, ISO 8601 timestamps), and the `<<`merge key. Round-trip verified against`js-yaml`.

### 📝 Docs

- Add `AGENTS.md` (agent-facing project instruction) at the repo root, capturing the ESM/zero-deps conventions, test and build commands, and the yaml-scalar guard rule. `CLAUDE.md` is a symlink to `AGENTS.md` so claude-code reads the same source.

### 🛠 Chore

- Move `lint-staged` config to `.lintstagedrc.mjs` and filter symlinks via `lstatSync` before invoking `prettier`/`eslint`. Prettier 3 hard-errors on symlink arguments and ignores `.prettierignore` for explicit paths, so the previous `package.json` shorthand blocked staging `CLAUDE.md`.

## v0.1.0-beta.4 (2026-05-08)

### 🐛 Bug Fixes

- **connect**: switch Codex plugin install to user-marketplace direct manipulation. `codex plugin install` / `enable` non-interactive subcommands do not exist, and `policy.installation: "INSTALLED_BY_DEFAULT"` on a managed marketplace does not auto-install on `marketplace add`, so beta.3 left the plugin registered but inactive. `connect` now copies the bundle to `~/.ai-config-sync-manager/codex-plugin/` and upserts an entry into `~/.agents/plugins/marketplace.json` (user marketplace, default name `local-plugins`) using the openai/codex#17885 schema, then writes `[plugins."ai-config-sync-manager@local-plugins"] enabled = true` to `~/.codex/config.toml`. Beta.3 stale entries (`[marketplaces.ai-config-sync-manager]`, `[plugins."ai-config-sync-manager@ai-config-sync-manager"]`, `~/.ai-config-sync-manager/codex-marketplace/`) are not auto-cleaned — remove manually if upgrading.

## v0.1.0-beta.3 (2026-05-08)

### 🐛 Bug Fixes

- **connect**: fix Codex marketplace manifest path and schema to the official spec — manifest now lives at `<root>/.agents/plugins/marketplace.json` (not `.codex-plugin/marketplace.json`) and uses `interface.displayName`, `source: { source: "local", path: "./plugins/..." }`, and `policy: { installation: "INSTALLED_BY_DEFAULT", authentication: "ON_INSTALL" }`. `INSTALLED_BY_DEFAULT` triggers automatic plugin install on marketplace add. Resolves "invalid marketplace file: marketplace root does not contain a supported manifest" reported during beta.2 verification.

## v0.1.0-beta.2 (2026-05-08)

### 🐛 Bug Fixes

- **connect**: delegate plugin install to host CLIs (`claude plugin marketplace add` + `claude plugin install`, `codex plugin marketplace add` + `~/.codex/config.toml` enable table) instead of writing plugin manifests directly. Earlier betas wrote a guessed schema that Claude Code cleaned up on launch and Codex never activated; the marketplace appeared but the plugin never did.
- **connect**: every host CLI call is wrapped so a second `connect` run is a noop, and path arguments are quoted to survive whitespace in `$HOME`.

### 🛠 CI

- pre-push hook skips inside CI (`CI=true`), avoiding the duplicate test run that previously failed the release workflow's tag step.

## v0.1.0-beta.1 (2026-05-07)

### 🐛 Bug Fixes

- **connect**: also register the Claude marketplace in `~/.claude/plugins/known_marketplaces.json` so `installed_plugins.json` entries stay valid after `npm i -g` → `connect`. Without this Claude Code dropped the entry on launch and the plugin never appeared.
- **connect**: write Codex marketplace entries using the current schema so freshly registered plugins are picked up by Codex CLI.

## v0.1.0-beta.0 (2026-05-07)

Initial public beta. See README for the full feature surface.
