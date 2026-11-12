# Magic Engine Reference Documentation (`src/lib/magic/docs/`)

This directory is the canonical reference hub for orchestrators and coding agents working on `src/lib/magic/`. Consult these documents before designing or modifying compiler or runtime modules and keep them updated as phases and rules fixes land.

## Essential Documents

| Document | Purpose & When to Consult / Update |
| :--- | :--- |
| [`ENGINE_INVARIANTS.md`](./ENGINE_INVARIANTS.md) | **Non-negotiable architectural and rules invariants.** Covers the IR wall (`oracleTextRead = 0`, `cardNameComparison = 0`, `legacyTextHelperCall = 0`, `cardNameInCode = 0`, rename invariance), evaluated characteristics (`CR 613`), the single zone-change funnel (`CR 400.7`, `directZoneMutation = 0`), simultaneity/LKI (`CR 603.10a, 704.8`), priority/APNAP (`CR 101.4, 500–514`), the 6-kind data-only choice protocol, determinism (`rngState` + `nextUid`), and monotonic ratchets. Read before writing any compiler or runtime code. |
| [`ENGINE_ARCHITECTURE_PLAN.md`](./ENGINE_ARCHITECTURE_PLAN.md) | **Master architecture plan.** Defines the `compiler/` → `ir.ts` → `runtime/` architecture (§2), the project decisions, the invariants and ratchet (§1), the Phase 11+ coverage loop, the testing strategy and the definition of done. Code comments that cite "plan section 2.x" refer to this file. The Phases 0–10 completion log moved to [`deprecated/`](./deprecated/ENGINE_PHASES_0-10_LOG.md) on 2026-11-12. |
| [`FULL_COVERAGE_STRUCTURE.md`](./FULL_COVERAGE_STRUCTURE.md) | **Structural recommendations for reaching full keyword and rules coverage (proposal, 2026-11-12).** Covers a general cast-option model in place of `castMode` (`CR 601.2`, `118.9`), pausable resolution (`CR 608.2`), a keyword registry that expands keywords into ordinary abilities (`CR 702`), object-model work for multi-faced/face-down/copy mechanics (`CR 707–734`), the grammar, splitting `engine.ts`, and verifiable support claims. Not scheduled; consult before designing work that touches casting, keywords or resolution. |
| [`COVERAGE.md`](./COVERAGE.md) | **Card compiler coverage report**, the single source for coverage numbers: fully supported cards and abilities across precons and the full Scryfall corpus, unsupported abilities by reason, and the top unparsed templates. Regenerate after any compiler change (and bump `COMPILER_VERSION` in `compiler/index.ts`) with `node scripts/magic-coverage.ts ~/data/scryfall/oracle-cards.jsonl.gz --out src/lib/magic/docs/COVERAGE.md`. |
| [`rules-audit/00-SUMMARY-AND-PRIORITIZED-GAPS.md`](./rules-audit/00-SUMMARY-AND-PRIORITIZED-GAPS.md) | **Comprehensive Rules (`CR 100–905`) audit summary and prioritized gap backlog (Tiers 1–4)**, synthesizing the 10 section audits below against [`src/lib/rules.txt`](../../rules.txt). Written 2026-11-09 and stale: its counts are known to be wrong and many listed gaps have since been fixed. Use it as a list of leads to verify, not as current status. |

## Documentation Audit (`audits/`)

[`audits/README.md`](./audits/README.md) is a 2026-11-12 audit of these documents against the code: wrong identifiers, wrong CR citations, stale coverage figures, and the staleness and arithmetic of `rules-audit/`. Its status section lists what has been fixed since, what was disputed, and what is still open.

## Detailed Comprehensive Rules Section Audits (`rules-audit/`)

> These reports were written at `917180b` (2026-11-09) and are stale; each file has a banner explaining how to use it.


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

## Deprecated (`deprecated/`)

Historical documents kept for reference. They are not maintained: file paths, line numbers and counts in them describe the code at the time they were written. Don't use them as a source of current behaviour.

| Document | What it was |
| :--- | :--- |
| [`deprecated/ENGINE_PHASES_0-10_LOG.md`](./deprecated/ENGINE_PHASES_0-10_LOG.md) | The 2026-11-08 baseline snapshot and the work lists and completion notes for Phases 0–10 and Steps A–F of the engine rewrite (all complete 2026-11-09), formerly §0 and §3 of `ENGINE_ARCHITECTURE_PLAN.md`. Code comments citing "Phase 6d", "Step E2" and similar refer to entries here. |
| [`deprecated/error_sources.md`](./deprecated/error_sources.md) | A generic list of hard-to-implement Magic rules areas, formerly `src/routes/magic/error_sources.md`. Superseded by the `rules-audit/` reports, which check each rule against the code. |
