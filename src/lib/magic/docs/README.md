# Magic Engine Reference Documentation (`src/lib/magic/docs/`)

This directory is the canonical reference hub for orchestrators and coding agents working on `src/lib/magic/`. Agents must consult these documents before designing or modifying compiler or runtime modules and keep them updated as phases and rules fixes land.

## Essential Documents

| Document | Purpose & When to Consult / Update |
| :--- | :--- |
| [`ENGINE_INVARIANTS.md`](./ENGINE_INVARIANTS.md) | **Non-negotiable architectural and rules invariants.** Covers the IR wall (`oracleTextRead = 0`, `cardNameComparison = 0`, rename invariance), evaluated characteristics (`CR 613`), the single zone-change funnel (`CR 400.7`), simultaneity/LKI (`CR 603.10a, 704.8`), priority/APNAP (`CR 101.4, 500–514`), the 6-kind choice protocol, determinism, and monotonic ratchets. Read before writing any compiler or runtime code. |
| [`ENGINE_ARCHITECTURE_PLAN.md`](./ENGINE_ARCHITECTURE_PLAN.md) | **Phased engine rewrite roadmap & agent log (Phases 0–10).** Defines the target `compiler/` + `runtime/` architecture, phase boundaries, verification rules, and per-phase completion notes. Each phase agent updates only its own section. |
| [`CR_DISCREPANCY_AUDIT.md`](./CR_DISCREPANCY_AUDIT.md) | **Exhaustive MTG Comprehensive Rules (`CR 100–905`) discrepancy catalog & Wave 3A–3E remediation plan.** Cross-references every discrepancy against [`src/lib/rules.txt`](../../rules.txt) with exact file/line pointers and wave assignments. Update status entries as Wave 3A–3E fixes land. |
| [`COVERAGE.md`](./COVERAGE.md) | **Card compiler coverage report** across precons and the full Scryfall card corpus (generated via `scripts/magic-coverage.ts --out src/lib/magic/docs/COVERAGE.md`). |
| [`COST-GRAMMAR.md`](./COST-GRAMMAR.md) | **Cost grammar diff report** (`scripts/magic-costs-diff.ts --out src/lib/magic/docs/COST-GRAMMAR.md`). |
| [`TRIGGER-GRAMMAR.md`](./TRIGGER-GRAMMAR.md) | **Trigger grammar diff report** (`scripts/magic-triggers-diff.ts --out src/lib/magic/docs/TRIGGER-GRAMMAR.md`). |
| [`EFFECT-GRAMMAR.md`](./EFFECT-GRAMMAR.md) | **Effect grammar diff report** (`scripts/magic-effects-diff.ts --out src/lib/magic/docs/EFFECT-GRAMMAR.md`). |
| [`STATIC-GRAMMAR.md`](./STATIC-GRAMMAR.md) | **Static & replacement grammar diff report** (`scripts/magic-statics-diff.ts --out src/lib/magic/docs/STATIC-GRAMMAR.md`). |
| [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) | **Historical pre-rewrite implementation log** (superseded by `ENGINE_ARCHITECTURE_PLAN.md`; kept for historical context). |
