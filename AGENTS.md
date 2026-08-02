# AGENTS.md — AI Config Sync Manager

A zero-runtime-deps Node ESM CLI that compares, converts, and syncs Claude/Codex developer settings.
Primary entry point: `bin/ai-config-sync.mjs`.

---

## Pre-work reading order

1. `README.md` — user-facing CLI reference.
2. `package.json`, `scripts/build-dist.mjs` — confirm `scripts` and `files` policy.
3. Reading source directly is the last resort.

---

## YAML serialization rule (most important — always go through this)

**When serializing a YAML scalar or deciding whether it needs quoting, you MUST use the utility below.**

```js
import { serializeYamlScalar, yamlScalarRequiresQuoting } from "./util/yaml-scalar.mjs";
// in tests:
import { yamlScalarRequiresQuoting } from "../bin/util/yaml-scalar.mjs";
```

- **Forbidden** to write your own quote/escape logic. **Forbidden** to judge indicators directly with regex.
- **Forbidden** to add wrappers like `serializeFrontmatterScalar` (we have removed such wrappers before).
- When you find a new quoting edge case: add the rule to `bin/util/yaml-scalar.mjs` + add a unit case to `tests/yaml-scalar.test.mjs`.
- Reason: guarantee Claude (lenient YAML) ↔ Codex (strict YAML 1.2) round-trip. If even one site uses its own quoting, the strict parser fails to parse the entire frontmatter and fields like `name` go missing (this has actually happened).

---

## Code conventions

- ESM only. `.mjs` extension is required in import paths.
- double quotes, semicolons, function declarations.
- **No new external runtime dependencies** (zero-runtime-deps policy; devDependencies are allowed).
- Comments: one WHY line only — one reason, on one physical line, never wrapped onto a second. No WHAT or task references. If it does not fit, restate the reason more tersely; do not wrap. Comments written before this rule are still wrapped, so rewrite one only when you are already changing that code.
- Splitting `bin/ai-config-sync.mjs` is on hold. Cross-cutting helpers may be extracted into a separate `.mjs` under `bin/util/` (`yaml-scalar.mjs` is the precedent).

---

## Tests

- Framework: `node:test` + `node:assert/strict`.
- Locations: `tests/*.test.mjs` (unit/fixture), `tests/integration/codex-to-claude/*.test.mjs` (integration).
- Run all: `npm test`.
- Run one: `node --test tests/<file>.test.mjs`.
- Test names are behavior sentences (`test("agents sync apply ...", ...)`).
- New helpers must come with both a unit case and an integration case.

---

## Build / publish

- `npm run build:dist` → produces `dist/claude-marketplace`, `dist/codex-plugin`.
- Only the host-launcher (`scripts/lib/host-launcher.mjs`) is a wrapper; `bin/` ships as-is.
- `package.json` `files` includes the entire `bin/` → `bin/util/*.mjs` are auto-published.
- ESM relative imports resolve directly. No bundling step.

---

## Commits

- Conventional Commits: `fix:`, `feat:`, `test:`, `chore(...)`, `docs:`.
- Body should focus on WHY.
- The pre-commit hook (husky + lint-staged) must pass.
