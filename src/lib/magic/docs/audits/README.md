# Documentation Audit of `src/lib/magic/docs/` (2026-11-12)

**Audited:** 2026-11-12 against `engine-rewrite` (`HEAD = ecd4a3e`) plus active uncommitted working-tree keyword/test changes  
**Scope:** All 16 non-deprecated documents in [`src/lib/magic/docs/`](../README.md) (`README.md`, `ENGINE_INVARIANTS.md`, `ENGINE_ARCHITECTURE_PLAN.md`, `FULL_COVERAGE_STRUCTURE.md`, `COVERAGE.md`, and `rules-audit/00`–`10`), verified against `src/lib/magic/**`, `src/lib/rules.txt`, `scripts/magic-*.ts`, `.github/workflows/magic-engine.yml`, and `ops/magic-backend/`. (`docs/deprecated/` intentionally ignored.)

---

## Status (updated 2026-11-12, after this audit)

**Acted on:**
- `COMPILER_VERSION` bumped to 8 and `COVERAGE.md` regenerated. The coverage script no longer cites `isAbilityAutomated` or "legacy-claimed upper bound".
- `ENGINE_INVARIANTS.md`: identifiers and the 7 CR numbers corrected. Each invariant that the code doesn't meet now carries a **Not yet enforced** note naming the gap (§1 items 1–2, §2 items 2–3 and 5–6, §3 items 1–2, §4.1, §6.3, §7.2 and §7.4).
- `ENGINE_ARCHITECTURE_PLAN.md` §2:
  - the module map now matches `runtime/`;
  - the layer cache is described as built;
  - the two deployment modes, `ENGINE_VERSION` and bot pacing are documented;
  - the post-Phase-10 mechanisms that the move to `deprecated/` orphaned (loop detection, deferred zone moves, hidden information, ability words) are restored as §2.9;
  - the overrides escape hatch and the CI coverage ratchet are marked not built.
- `FULL_COVERAGE_STRUCTURE.md`: §0 points at `COVERAGE.md` instead of copying numbers, and the Overload paragraph is in the past tense.
- `rules-audit/`: every section has a staleness banner, `00-SUMMARY` has a miscount banner, and the rows the 2026-11-12 keyword fixes touched are updated (702.21a–b, 702.26a, 702.26h, 702.62a, 702.62c, 702.96a, 702.124f, 702.124h–j, 704.5p, 903.5b, plus 611.2c, 613.1f, and 613.7b in `04`).
- Granted activated abilities (*Goldspan Dragon*, *Chromatic Lantern*, basic-land subtype grants) now compile and flow through `runtime/layers.ts` and `ruleTree.ts` as full `ActivatedAbility` IR (`COMPILER_VERSION = 9`), deleting the `/Add \{([WUBRGC])\}/` display-label regex.
- Activated keyword-removal abilities (*Shadowspear*, *Arcane Lighthouse*, *Bonds of Mortality*) now compile to IR `grant` steps (`COMPILER_VERSION = 10`) and resolve as timestamped `TimedKeywordEffect` entries; all `ab.text` regex/substring scans in `runtime/layers.ts` are gone and enforced at `0` by `abilityTextScan` in `architecture.test.ts`.
- Code, from [`04`](./04-in-flight-keyword-and-test-impact.md) §3:
  - "Partner with [name]" now compiles its search trigger as an unsupported ability (item 1);
  - `wither` is in `IMPLEMENTED_KEYWORDS` (item 2);
  - wither is grantable, with a full keyword test suite;
  - `phasing` is in `IMPLEMENTED_KEYWORDS`, `GRANTABLE_KEYWORDS`, `compiler/statics.ts` `KEYWORDS`, and `KEYWORD_LABELS` (`COMPILER_VERSION = 11`), with `CR 702.26h` direct+indirect phase-out fixed and a full `runtime/keywords-phasing.test.ts` suite (item 3);
  - unimplemented `evolve` and `cascade` are removed from `KEYWORD_LABELS` (`runtime/layers.ts`), `card.keywords` badge extraction is gated on implemented keywords, and `runtime/keywords-coverage-guard.test.ts` enforces sync with `IMPLEMENTED_KEYWORDS` (item 4);
  - the `plainswalker` typo is fixed;
  - two cards with the same partner—[text] ability can now pair (CR 702.124i). Found while checking 702.124f.
  - `attachObject` (`runtime/zones.ts`) now assigns a fresh `enteredTimestamp` on every attachment (`CR 613.7e`) and no-ops when already attached to the same host (`CR 701.3b`), closing the `ENGINE_INVARIANTS.md` §2.2 gap from [`01`](./01-top-level-docs-audit.md) §3.2 item 3.

**Disputed:** [`04`](./04-in-flight-keyword-and-test-impact.md) §3 item 5 (infect or wither plus deathtouch). The code is correct.

**Open:**
- reconciling `rules-audit/01`–`10` row by row (`03`);
- the scrambled CR 122 table in `01-game-concepts.md` and the summary arithmetic (`02`);
- the code-level gaps now listed as "Not yet enforced" in `ENGINE_INVARIANTS.md`.

---

## Audit Report Index

| Report | Coverage |
| :--- | :--- |
| **[`01-top-level-docs-audit.md`](./01-top-level-docs-audit.md)** | Line-by-line audit of `README.md`, `ENGINE_INVARIANTS.md`, `ENGINE_ARCHITECTURE_PLAN.md`, `FULL_COVERAGE_STRUCTURE.md`, and `COVERAGE.md`: 14 mismatched symbol/type/file names, aspirational vs. enforced invariants, orphaned post-Phase-10 design notes, missing dual-mode (`cloudflare` \| `homelab`) deployment docs, and live `COMPILER_VERSION = 7` coverage deltas. |
| **[`02-rules-audit-arithmetic-and-cr-citations.md`](./02-rules-audit-arithmetic-and-cr-citations.md)** | Verification of `rules-audit/00`–`10` count tables and CR citations against `src/lib/rules.txt`: mixed row/subrule units (`2,565` claimed vs. `1,560` rows / `2,988` CR rules), severe addition bugs in `02`, `03`, `06`, and `10`, 5 hallucinated + 8 omitted CR numbers in `01`, 7 wrong CR numbers in `ENGINE_INVARIANTS.md`, and the scrambled `### 122 Counters` table in `01`. |
| **[`03-rules-audit-staleness-and-reconciliation.md`](./03-rules-audit-staleness-and-reconciliation.md)** | Post-`917180b` staleness across ~136 commits (Step F, Phase 6d, Tiers 1–3, Review Phases 1–5, Review 2, Review 3, `9473dad`, `ecd4a3e`): unrecorded fixes in `00-SUMMARY`, itemized stale Top Gaps / CR rows / `"Silently skipped"` bullets in `01`–`10`, `283` line citations to deleted `compiler/adapter.ts`, and disposition of all 39 `## Legacy-only findings (verify after step F)` items. |
| **[`04-in-flight-keyword-and-test-impact.md`](./04-in-flight-keyword-and-test-impact.md)** | Exact documentation impact of the concurrent agent's active keyword fixes and 4 new `runtime/keywords-*.test.ts` suites (Overload, Suspend, Ward, Protection/Hexproof + Equipment SBA, Changeling, Partner, `GRANTABLE_KEYWORDS` + `printedText`), plus **5 remaining keyword truthfulness/consistency issues** uncovered in the code (`Partner with [Name]`, `wither`, `phasing`, `evolve`/`cascade` badges, and `deathtouchDamageMarked` on Infect/Wither). |

---

## Executive Summary: Top 10 Findings

1. **`ENGINE_INVARIANTS.md` Cites Non-Existent Identifiers & States Unimplemented Goals as Active Guarantees ([`01` §2–§3](./01-top-level-docs-audit.md))**
   - Uses 14 wrong or non-existent type/function/file names (`CardDef`, `CostTerm`, `RuleModifier`, `colorIndicator`/`cardFaces`, `ColorExpr`, `QuantityExpr`, `CompileDiagnostic`, `CardDef.unsupported`, `reorderZone`, `createToken`, `timestamp`, `excludeSelf`, `applyReplacements`, `sourceCharacteristic`, `rngSeed`, `runtime/layers-cache.test.ts`).
   - Claims general `CR 613.8` dependency ordering, `Devoid` all-zone CDAs, automatic `moveObject` resets (including `summoningSick`), a unified 7-event `applyReplacements` pipeline, and full mid-ability/mid-cost pause-and-resume—none of which match the actual implementation—while `scryfall.ts` still hardcodes card-name deck-limit tables (`'seven dwarves'`, `'relentless rats'`, etc.) that `ENGINE_INVARIANTS.md:15–16` explicitly claims do not exist.
2. **Extracting §3 of `ENGINE_ARCHITECTURE_PLAN.md` to `deprecated/` Orphaned Active Post-Phase-10 Architecture Docs ([`01` §4.1](./01-top-level-docs-audit.md))**
   - Between 2026-11-09 and 2026-11-11, current architectural designs (Phase 6d read-tracking layer cache, `CR 104.4b` loop fingerprinting + `2000`-trigger backstop, Review 2 `pendingZoneMoves` deferred replacement choices, `idSalt` + viewer prompt/secret redaction, `CR 207.2c/207.2d` ability/flavor-word normalization, `ENGINE_VERSION = 2`) were appended to §3 rather than §2. Moving §3 into `deprecated/` (*"Don't use them as a source of current behaviour"*) left §2 describing the superseded 2026-11-08 pre-implementation target (`state.version` layer cache, non-existent `runtime/{stack,turn,combat,sba}.ts`, Cloudflare/D1-only deployment).
3. **`COVERAGE.md` (and Mirrors in `README.md`, `ENGINE_ARCHITECTURE_PLAN.md`, `FULL_COVERAGE_STRUCTURE.md`) Is 3 Compiler Versions Behind ([`01` §4.3](./01-top-level-docs-audit.md))**
   - Docs report **`COMPILER_VERSION = 4`** (`6,873 / 35,062 = 19.6%` cards, `24,363 / 62,490 = 39.0%` abilities, `event_not_implemented = 525`).
   - Live codebase is **`COMPILER_VERSION = 7`** (**`7,393 / 35,062 = 21.1%`** cards, **`25,346 / 62,627 = 40.5%`** abilities, `event_not_implemented = 292`), and top unparsed templates `#12 Tap target creature.`, `#14 Prowess`, `#15 Whenever you gain life,`, and `#31 Whenever ~ becomes tapped,` in `COVERAGE.md` are already implemented. Also `README.md:12` instructs running `npx tsx` (`tsx` is not installed; use `node`), and `scripts/magic-coverage.ts:277` generates a reference to a non-existent `isAbilityAutomated` symbol.
4. **`rules-audit/01`–`10` Have Zero Git Commits Since `bddf961` (`917180b`), Leaving ~136 Commits Unreconciled ([`03` §1–§4](./03-rules-audit-staleness-and-reconciliation.md))**
   - Step F, Tiers 1–3, Review Phases 1–5, Review 2, Review 3, `9473dad`, and `ecd4a3e` resolved the vast majority of Top Gaps and `"Silently skipped"` items across `01`–`10` (e.g., 5/5 Top Gaps and 14/18 approximations in `01`; 8/12 Top Gaps in `03`; 9/12 silent skips in `04`; 8/9 silent-skip groups in `06`), yet every section report still displays pre-Step-F statuses, `283` citations to deleted `compiler/adapter.ts`, deleted `oracle.ts`/`ruleTree.ts` helpers, and 39 unclosed `"verify after step F"` bullets.
5. **`00-SUMMARY` §1 Mixes Row Counts with Subrule Counts and Inherits Major Addition Bugs from `02`, `03`, `06` & `10` ([`02` §1](./02-rules-audit-arithmetic-and-cr-citations.md))**
   - `02` claims `263` rows (`92/42/64/65`) when its table actually has **`176` rows** (`94/31/31/20`); `06` claims `56/42/153/11 = 262` when its subrules are **`65/29/178/5 = 277`**; `10` claims `25/17/9/194 = 245` when its subrules are **`32/21/12/238 = 303`** (N/A subrules alone total `238`); `03` undercounts subrules by `11` (`139` vs. `150`). Meanwhile `src/lib/rules.txt` (`L183–7145`) actually has **`2,988`** numbered CR rules/subrules across `1,560` table rows, not `2,565`.
6. **Scrambled CR Rule Citations in `01-game-concepts.md` (`### 122 Counters`) & 7 Wrong CR Numbers in `ENGINE_INVARIANTS.md` ([`02` §2](./02-rules-audit-arithmetic-and-cr-citations.md))**
   - `01-game-concepts.md` fabricates 5 non-existent CR numbers (`122.3a`, `122.6b`, `123.4a`, `123.7b`, `123.8b`), omits 8 real CR numbers, and scrambles nearly all of `CR 122.1d–122.8` (marking unimplemented `122.4` max-counters SBA as `implemented` stun counters, marking implemented `122.1f` 10+ poison SBA as `missing` finality counters, and mislabeling `122.7` as Proliferate instead of `CR 701.34`).
   - `ENGINE_INVARIANTS.md` miscites 7 CR numbers (`702.124f` → `702.124j`, `400.7b` → `400.7d`, `614.16` → `614.15`/`616.1a`, `500.4` → `500.5`, `701.19` → `701.21`, `701.8` → `701.9`, `701.31` → `701.34`).
7. **7 Cross-Document Contradictions Exist Across the 5 Top-Level Files ([Matrix Below](#cross-document-contradiction-matrix))**
   - Direct contradictions on mid-ability pause-and-resume, `CR 613.8` dependency ordering, layer caching, `runtime/{stack,turn,combat,sba}.ts`, `oracleText` read permissions, deployment architecture, and `COMPILER_VERSION`.
8. **Dual-Runtime Homelab Backend (`8be920a`) & Bot Pacing (`8e6580d`) Are Undocumented in `src/lib/magic/docs/` ([`01` §4.2](./01-top-level-docs-audit.md))**
   - `ENGINE_ARCHITECTURE_PLAN.md` still describes Cloudflare Workers + D1 as the sole execution/storage model and never links to [`ops/magic-backend/README.md`](../../../../ops/magic-backend/README.md) (`MAGIC_MODE = "cloudflare" | "homelab"`, Node 24 + `node:sqlite`, `KeyedMutex`) or `botSpeed` / `advance_bots`.
9. **Active Working-Tree Keyword Fixes Immediately Affect `06`, `07`, `08`, `10`, `FULL_COVERAGE_STRUCTURE.md` & `COVERAGE.md` ([`04` §1–§2](./04-in-flight-keyword-and-test-impact.md))**
   - Once the concurrent agent's changes commit, `FULL_COVERAGE_STRUCTURE.md:39–47` (uncommitted Overload warning), `07:89` (`702.96a`), `06:192–193` (`702.21a–b` Ward), `06:412–414` (`702.62a,c` Suspend), `08:73` (`704.5p` Equipment SBA), and `COVERAGE.md` (expanded `GRANTABLE_KEYWORDS`) must be updated together, and `COMPILER_VERSION` in `compiler/index.ts` will need a `7 → 8` bump.
10. **Five Keyword Truthfulness / Consistency Gaps Uncovered in Active Code ([`04` §3](./04-in-flight-keyword-and-test-impact.md))**
    - `"Partner with [Name]"` (`CR 702.124j`) now compiles as `fullySupported: true` in `compiler/card.ts:212,221,232` without an ETB search trigger; `'wither'` and `'phasing'` work at runtime but are missing from `IMPLEMENTED_KEYWORDS`; unimplemented `'evolve'` and `'cascade'` remain in `runtime/layers.ts` `KEYWORD_LABELS`; and `runtime/effects.ts:377–379` sets `deathtouchDamageMarked = true` even when Infect/Wither placed `-1/-1` counters instead of marking damage.

---

## Cross-Document Contradiction Matrix

| Topic | Document A Claim | Document B Claim | Actual Codebase Reality |
| :--- | :--- | :--- | :--- |
| **Mid-ability pause & resume** | `ENGINE_INVARIANTS.md:116–117`: Any `EffectStep` or `CostTerm` pauses immediately and saves a continuation frame. | `FULL_COVERAGE_STRUCTURE.md:79–90`: Interpreter *cannot* pause mid-ability; mid-sequence optional steps are rejected. | `FULL_COVERAGE_STRUCTURE.md` is right (`compiler/interpretable.ts:78,147`; `CostDef`s re-plan upfront rather than pausing). |
| **`CR 613.8` dependency ordering** | `ENGINE_INVARIANTS.md:36`: Effects apply in `CR 613.8` dependency order then timestamp order. | `ENGINE_ARCHITECTURE_PLAN.md:279,394–395` & `FULL_COVERAGE_STRUCTURE.md:160–161`: `CR 613.8` dependency ordering is an unimplemented non-goal. | `PLAN` & `FULL_COVERAGE_STRUCTURE` are right (`layers.ts` uses 3 fixed Layer-4 sub-passes + timestamps, no dependency graph). |
| **Layer cache design** | `ENGINE_ARCHITECTURE_PLAN.md:283`: Cached by `state.version` bumped on every mutation. | `ENGINE_INVARIANTS.md:130–132`: Caches inside `withStableLayerInputs` keyed on battlefield/stack/command/timestamps. | Neither: `layerCache.ts` always caches via `WeakMap<GameState, BoardSnapshot>` + read-tracked `dynamicFingerprint` (never `stack`); `withStableLayerInputs` only skips re-validation. |
| **Runtime module split** | `ENGINE_ARCHITECTURE_PLAN.md:3,127`: Phases 0–10 complete; lists `runtime/{stack,turn,combat,sba}.ts`. | `FULL_COVERAGE_STRUCTURE.md:33,134–139`: `engine.ts` is a ~10.9k-line monolith; extracting those 4 modules is unscheduled future work. | `FULL_COVERAGE_STRUCTURE.md` is right; `runtime/{triggers,layerCache,objectFilter,random}.ts` exist instead. |
| **`oracleText` & ratchet scope** | `ENGINE_INVARIANTS.md:12,133–134`: Only `compiler/` reads `oracleText`/`typeLine`; all 5 ratchet rules are `0` across runtime, `compiler/`, and `oracle.ts`. | `ENGINE_ARCHITECTURE_PLAN.md:75–77`: `oracle.ts`, `search.ts`, and Svelte UI may also read `oracleText`. | `architecture.test.ts:20–28` exempts `compiler/`, `oracle.ts`, `precons.ts`, `scryfall.ts`, `search.ts`, `types.ts`, `*.test.ts` from 4 rules, and never scans `.svelte`. |
| **`COMPILER_VERSION`** | `README.md:12`, `COVERAGE.md:3`, `ENGINE_ARCHITECTURE_PLAN.md:3`: Version `4`. | `00-SUMMARY:79,105`: Mentions bumps `4 → 5` and `5 → 6`. | `compiler/index.ts:17` is **`COMPILER_VERSION = 7`** (soon `8` after working-tree `compiler/effects.ts` changes). |
| **Deployment runtime** | `ENGINE_ARCHITECTURE_PLAN.md:28,296–306`: Cloudflare Workers + D1 only. | *(Compare `ops/magic-backend/README.md`)* | Dual-mode `MAGIC_MODE = "cloudflare" \| "homelab"` (`db.ts`, `hooks.server.ts`, Node 24 + `node:sqlite`). |

---

## Prioritized Remediation Plan (Recommended Order)

1. **Wait for the concurrent keyword/test agent to finish committing, then bump `COMPILER_VERSION` (`7 → 8`) and regenerate `COVERAGE.md`:**
   - Fix `scripts/magic-coverage.ts:277` (`isAbilityAutomated` → `staticallyInterpretable` / `definitionSupportReport`) and `L320` (`legacy-claimed upper bound`), optionally drop the obsolete `"Fully supported, ignoring statics"` column, and run `node scripts/magic-coverage.ts ~/data/scryfall/oracle-cards.jsonl.gz --out src/lib/magic/docs/COVERAGE.md`.
   - Stop duplicating volatile card/ability/subrule counts in `README.md` and `ENGINE_ARCHITECTURE_PLAN.md`—link to `COVERAGE.md` and `00-SUMMARY` as single sources of truth, and fix `npx tsx` → `node` in `README.md:12`.
2. **Repair `ENGINE_INVARIANTS.md` so every symbol, CR number, and invariant matches reality:**
   - Fix all 14 identifier/path mismatches (`CardDefinition`, `CostDef`, `Amount`, `UnsupportedAbility`, `enteredTimestamp`, `other`, `layerCache*.test.ts`, etc.) and all 7 wrong CR numbers ([`02` §2.1](./02-rules-audit-arithmetic-and-cr-citations.md)).
   - Separate **enforced invariants** from **known architectural gaps / future targets** (`scryfall.ts` deck-limit tables, `CR 613.8` dependencies, `Devoid`, opt-in `moveObject` flags, partial replacement coverage, non-pausable mid-ability `"you may"`, wall-clock `Date.now()` fields, actual `layerCache.ts` and `architecture.test.ts` behavior).
3. **Update `ENGINE_ARCHITECTURE_PLAN.md` §2 & `FULL_COVERAGE_STRUCTURE.md`:**
   - Rescue the 5 active post-Phase-10 design notes from `deprecated/ENGINE_PHASES_0-10_LOG.md` into `ENGINE_ARCHITECTURE_PLAN.md` §2 ([`01` §4.1](./01-top-level-docs-audit.md)), rewrite §§0–2 past-tense/current module lists (`triggers.ts`, `layerCache.ts`, `objectFilter.ts`, `random.ts`, `ENGINE_VERSION = 2`), add the dual-mode `homelab` backend link (`ops/magic-backend/README.md`) + `botSpeed` pacing, and update `FULL_COVERAGE_STRUCTURE.md:39–47` once Overload lands.
4. **Fix `01-game-concepts.md` `CR 122` scrambling + add a small table-counter check for `rules-audit/`:**
   - Re-align `01-game-concepts.md` (`CR 113.2c`, `120.6–120.10`, `121.2b–d`, `122.1d–122.9`, remove the 5 non-existent CRs, add the 8 omitted CRs) and resolve `02`'s overlapping rows (`201.1–201.2`, `300.1–300.2`) and non-standard status labels ([`02` §1–§2](./02-rules-audit-arithmetic-and-cr-citations.md)).
   - Reconcile `00`–`10` against post-`917180b` commits + the newly landed keyword fixes ([`03`](./03-rules-audit-staleness-and-reconciliation.md), [`04`](./04-in-flight-keyword-and-test-impact.md)), delete the `283` `compiler/adapter.ts` citations and 39 `"verify after step F"` bullets, and compute `00-SUMMARY` §1 automatically in both **table rows** and **expanded CR subrules** (`2,988` total in `src/lib/rules.txt:183–7145`) so manual addition errors cannot recur.
