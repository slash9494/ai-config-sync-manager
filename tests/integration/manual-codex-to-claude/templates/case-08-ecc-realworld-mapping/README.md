# case-08-ecc-realworld-mapping

Real-world fixture sourced from the public **everything-claude-code (ECC)** repo
(`affaan-m/everything-claude-code` @ `main`). Verifies that terminology mapping
and tool-paraphrase rules behave correctly against unmodified upstream content
that was authored without `ai-config-sync-manager` in mind.

Files captured verbatim from upstream:

- `.codex/AGENTS.md` — references `Hooks`, `Subagent Task tool`, `Skills`,
  `MCP`. The codex-to-claude sync should leave the `Task tool` token untouched
  on the claude side (claude-native vocabulary), and the codex side stays
  unchanged.
- `.codex/config.toml` — multi_agent + 6 MCP servers (manual_github,
  context7, manual_exa, memory, playwright, sequential-thinking). Two ids are
  prefixed `manual_*` per the parent README guidance to avoid colliding with
  the harness's `CODEX_CONFLICT_HOME` global config; remaining ids match
  upstream verbatim. The streamable_http exa entry also carries an explicit
  `transport` field that ECC upstream omits. It is kept only to prove the
  reader tolerates it: `transport` is not a Codex config key, and measuring
  codex-cli 0.144.1 shows `--strict-config` rejects it while a `url`-only
  table loads fine, so the writer no longer emits it.
- `.codex/agents/explorer.toml` — multi-agent role config layer.
- `.agents/skills/verification-loop/SKILL.md` — paraphrase-trigger keywords
  (`Claude Code sessions`, `PostToolUse hooks`, `/verify` slash command). When
  copied to `.claude/skills/verification-loop/skill.md`, the terminology layer
  rewrites the codex-only `/verify` reference.

Expected sync surfaces: `instructions`, `skills`, `mcp`.

Source: https://github.com/affaan-m/everything-claude-code (MIT-licensed,
trimmed to the subset relevant to mapping/paraphrase verification).

## Expected `status` result (post-`sync --apply`)

Without `setup.sh`, no paraphrase override is registered, so `status` reports 1 vocab finding.

```
No diff detected for global scope. 1 vocab mismatch(es) detected.
```

- entries: 0
- vocabFindings: 1
  - `codex skills/verification-loop L9 col 21: token="Skill" side=claude_only`
  - Cause: the `Skill` token inside `# Verification Loop Skill` at `.agents/skills/verification-loop/SKILL.md:9` is registered as claude-only in the host-strict-vocab dictionary, so its appearance on the codex side is flagged for manual review. The `.claude/skills/verification-loop/skill.md` side allows the same token, so it produces no finding.
- paraphraseOverrides: 0 active / 0 stale

Resolution: `paraphrase --apply --map "Skill=verification routine"` rewrites the codex-side token and registers the override (same flow as the case-09 setup). The remaining mappings in `MAPPING-NOTES.md` (`Codex CLI ↔ Claude Code`, `AGENTS.md ↔ CLAUDE.md`, `.codex/config.toml ↔ .claude/settings.json`, `.codex/agents/*.toml ↔ .claude/agents/*.md`) are all treated as equivalent and do not surface in `entries`.
