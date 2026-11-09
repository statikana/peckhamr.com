# Magic Engine Reference Documentation (`src/lib/magic/docs/`)

This directory is the canonical reference hub for orchestrators and coding agents working on `src/lib/magic/`. Consult these documents before designing or modifying compiler or runtime modules and keep them updated as phases and rules fixes land.

## Essential Documents

| Document | Purpose & When to Consult / Update |
| :--- | :--- |
| [`ENGINE_INVARIANTS.md`](./ENGINE_INVARIANTS.md) | **Non-negotiable architectural and rules invariants.** Covers the IR wall (`oracleTextRead = 0`, `cardNameComparison = 0`, `legacyTextHelperCall = 0`, `cardNameInCode = 0`, rename invariance), evaluated characteristics (`CR 613`), the single zone-change funnel (`CR 400.7`, `directZoneMutation = 0`), simultaneity/LKI (`CR 603.10a, 704.8`), priority/APNAP (`CR 101.4, 500–514`), the 6-kind data-only choice protocol, determinism (`rngState` + `nextUid`), and monotonic ratchets. Read before writing any compiler or runtime code. |
| [`ENGINE_ARCHITECTURE_PLAN.md`](./ENGINE_ARCHITECTURE_PLAN.md) | **Master architecture plan & completion log (Phases 0–10 + Steps A–F).** Defines the `compiler/` → `ir.ts` → `runtime/` architecture, phase boundaries, verification rules, and completion notes through Phase 10 / Step F (retirement of legacy parser/adapter/ruleTree layer) and into Phase 11+ (the ongoing coverage loop). |
| [`COVERAGE.md`](./COVERAGE.md) | **Card compiler coverage report (Compiler v4)** across precons (`121 / 140 = 86.4%` fully supported) and the 35,062-card Scryfall corpus (`6,873 / 35,062 = 19.6%` fully supported), generated via `npx tsx scripts/magic-coverage.ts ~/data/scryfall/oracle-cards.jsonl.gz --out src/lib/magic/docs/COVERAGE.md`. |
| [`rules-audit/00-SUMMARY-AND-PRIORITIZED-GAPS.md`](./rules-audit/00-SUMMARY-AND-PRIORITIZED-GAPS.md) | **Comprehensive Rules (`CR 100–905`) master audit summary & prioritized gap backlog (Tiers 1–4).** Synthesizes the 10 section-by-section audits (`01`–`10`) against [`src/lib/rules.txt`](../../rules.txt) across all 2,565 subrules (`585` implemented, `432` partial, `1,082` missing, `466` N/A) and ranks remaining core rules bugs, false-positive compiler support claims, and missing mechanics. |

## Detailed Comprehensive Rules Section Audits (`rules-audit/`)

| Section | Report | Rules Range |
| :--- | :--- | :--- |
| **01** | [`rules-audit/01-game-concepts.md`](./rules-audit/01-game-concepts.md) | `CR 100–123` — Game Concepts (priority, mana, numbers/X, costs, damage, life, draw, counters) |
| **02** | [`rules-audit/02-card-parts-types-zones.md`](./rules-audit/02-card-parts-types-zones.md) | `CR 200–408` — Card Parts, Card Types & Zones |
| **03** | [`rules-audit/03-turn-structure.md`](./rules-audit/03-turn-structure.md) | `CR 500–514` — Turn Structure & Combat Phase |
| **04** | [`rules-audit/04-spells-abilities-effects.md`](./rules-audit/04-spells-abilities-effects.md) | `CR 600–616` — Spells, Abilities, Continuous Effects, Layers (`CR 613`) & Replacements (`CR 614–616`) |
| **05** | [`rules-audit/05-general-and-keyword-actions.md`](./rules-audit/05-general-and-keyword-actions.md) | `CR 700–701` — General Rules & Keyword Actions (`Activate` through `Harness`) |
| **06** | [`rules-audit/06-keyword-abilities-1.md`](./rules-audit/06-keyword-abilities-1.md) | `CR 702.1–702.84` — Keyword Abilities Part 1 (`Deathtouch` through `Unearth`) |
| **07** | [`rules-audit/07-keyword-abilities-2.md`](./rules-audit/07-keyword-abilities-2.md) | `CR 702.85–702.196` — Keyword Abilities Part 2 (`Cascade` through `Sneak`) |
| **08** | [`rules-audit/08-tba-sba-copy.md`](./rules-audit/08-tba-sba-copy.md) | `CR 703–707` — Turn-Based Actions, State-Based Actions & Copying Objects/Spells |
| **09** | [`rules-audit/09-additional-rules-708-plus.md`](./rules-audit/09-additional-rules-708-plus.md) | `CR 708–734` — Face-Down, Split, DFC, Saga, Class, End the Turn, Monarch, Initiative, Rad |
| **10** | [`rules-audit/10-multiplayer-commander.md`](./rules-audit/10-multiplayer-commander.md) | `CR 800–905` — Multiplayer Rules (`CR 800`) & Commander (`CR 903`) |
