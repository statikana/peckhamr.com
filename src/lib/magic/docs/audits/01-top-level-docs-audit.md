# 01 — Audit of Top-Level Reference Documentation

**Audited:** 2026-11-12 against `engine-rewrite` (`HEAD = ecd4a3e`) plus active uncommitted working-tree changes  
**Scope:** [`README.md`](../README.md), [`ENGINE_INVARIANTS.md`](../ENGINE_INVARIANTS.md), [`ENGINE_ARCHITECTURE_PLAN.md`](../ENGINE_ARCHITECTURE_PLAN.md), [`FULL_COVERAGE_STRUCTURE.md`](../FULL_COVERAGE_STRUCTURE.md), [`COVERAGE.md`](../COVERAGE.md) (`deprecated/` ignored)

---

## 1. Broken, Non-Existent, or Misrepresented File, Module, CLI & CI References

| Doc Citation | Claimed Path / Command / Check | Actual Codebase State |
| :--- | :--- | :--- |
| `ENGINE_INVARIANTS.md:132` | `runtime/layers-cache.test.ts` | **File does not exist.** Actual layer-cache test files are `src/lib/magic/runtime/layerCache.test.ts`, `src/lib/magic/runtime/layerCache.scope.test.ts`, and `src/lib/magic/runtime/layerCache.phase6d.test.ts` (plus `src/lib/magic/layers.snapshot.test.ts`). *(Note: `runtime/layerCache.ts:383` also cites a non-existent `layerReference.test.ts` in a comment.)* |
| `ENGINE_ARCHITECTURE_PLAN.md:127` | Target directory tree lists `runtime/stack.ts`, `runtime/turn.ts`, `runtime/combat.ts`, `runtime/sba.ts` | **None of those 4 modules exist.** Stack, turn structure, combat, and SBA logic still live inside the ~10.9k-line `src/lib/magic/engine.ts` monolith (as `FULL_COVERAGE_STRUCTURE.md:133–139` accurately notes). Conversely, 4 real runtime modules are **omitted** from the `ENGINE_ARCHITECTURE_PLAN.md:118–128` diagram: `runtime/triggers.ts`, `runtime/layerCache.ts`, `runtime/objectFilter.ts`, and `runtime/random.ts`. |
| `ENGINE_ARCHITECTURE_PLAN.md:360` | `src/lib/magic/overrides/<oracleId>.json` | **Directory does not exist**, and `compileCard` (`src/lib/magic/compiler/index.ts:93–124`) contains no override-loading code. (If retained as a future escape hatch, label it explicitly as unimplemented.) |
| `README.md:12` | `npx tsx scripts/magic-coverage.ts ~/data/scryfall/oracle-cards.jsonl.gz --out src/lib/magic/docs/COVERAGE.md` | **`tsx` is not installed in `package.json`.** Running `npx tsx ...` prompts interactively to download `tsx@4.23.15`. Node 24 runs TypeScript natively: `scripts/magic-coverage.ts:5,48` documents `node scripts/magic-coverage.ts <oracle-cards.jsonl.gz> --out src/lib/magic/docs/COVERAGE.md`. |
| `COVERAGE.md:7`, `scripts/magic-coverage.ts:277`, `00-SUMMARY:147` | `isAbilityAutomated` (`compiler/interpretable.ts`) | **Symbol `isAbilityAutomated` does not exist anywhere in `src/lib/magic/`.** `compiler/interpretable.ts` exports `staticallyInterpretable`, `triggerTargetsSupported`, `optionalPrefix`, `withoutOptional`, `INTERPRETED_VERBS`, and `PROMPTING_VERBS`; card/ability support reporting lives in `definitionSupportReport` and `cardSupportReport` (`compiler/support.ts:51,56`). |
| `ENGINE_ARCHITECTURE_PLAN.md:384, 403` | §5: *"Coverage report checked into CI as a number that must not decrease (another ratchet)"*; §7: *"Coverage for saved-deck cards is tracked and does not decrease."* | **Not true in CI.** `.github/workflows/magic-engine.yml` (`L1–48`) runs `node --test 'src/lib/magic/**/*.test.ts'` and magic-scoped `svelte-check`. It never runs `scripts/magic-coverage.ts` (since `~/data/scryfall/oracle-cards.jsonl.gz` is external to the repo) and never checks saved decks. Only built-in precon ability automation is ratcheted in CI via `compiler/automation.test.ts` + `compiler/automation.baseline.json`. *(Also `.github/workflows/magic-engine.yml:13–18` omits `src/lib/rules.txt` on `pull_request` and omits `scripts/**` on both triggers.)* |
| `ENGINE_ARCHITECTURE_PLAN.md:3` | *"legacy parser/adapter/ruleTree layer retired"* | `compiler/adapter.ts` was deleted in Step F (`e19ac12`), **but `src/lib/magic/ruleTree.ts` (~597 lines) and `src/lib/magic/oracle.ts` (~595 lines) still exist** and are actively imported by `engine.ts`, `ArenaTable.svelte`, and `+page.svelte` (`ruleTree.ts` wraps IR target/ability queries; `oracle.ts` provides mana parsing, token presets, and manual-resolution library search parsing). |

---

## 2. Mismatched Symbol, Type, Property & Function Names

### 2.1 `ENGINE_INVARIANTS.md` vs. Actual Codebase

`ENGINE_INVARIANTS.md` appears to have been drafted from conceptual names rather than checked against `src/lib/magic/ir.ts`, `types.ts`, and `runtime/*.ts`. Fourteen concrete identifier mismatches exist:

| Line(s) | Name Used in `ENGINE_INVARIANTS.md` | Actual Identifier in Codebase |
| :--- | :--- | :--- |
| `L13, 21, 27` | `CardDef` | `CardDefinition` (`src/lib/magic/ir.ts:18`, returned by `compileCard` in `compiler/index.ts:93`) |
| `L16, 117` | `CostTerm` | `CostDef` (`src/lib/magic/ir.ts:313`) |
| `L16` *(also `PLAN:287`)* | `RuleModifier` / *"deck-limit property"* | `RuleModKind` (`ir.ts:578`) inside `StaticDef` `{ k: 'ruleModifier', rule: RuleModKind, ... }` (`ir.ts:624`) and runtime `ActiveRuleModifier` (`runtime/replace.ts:174`). **No deck-limit property exists in `ir.ts`** (`scryfall.ts:27–42` hardcodes `MULTI_COPY_CARDS` and `CAPPED_COPY_CARDS`). |
| `L24` | `colorIndicator`, `cardFaces` on `card` | `ScryfallCard` (`src/lib/magic/types.ts:63–97`) has **`colors: ManaColor[]`** (`L71`) and **`backFace?: { ... }`** (`L88–96`); neither `colorIndicator` nor `cardFaces` exists on `ScryfallCard`. |
| `L25` | `ColorExpr`, `QuantityExpr` | Quantities use **`Amount`** (`ir.ts:295–309`); symbolic mana color choices use **`EffectParams['manaChoice']`** (`ManaColor[] \| 'any' \| 'commanderIdentity' \| 'opponentLandColors'`, `ir.ts:406`). |
| `L27` | `CompileDiagnostic`, `CardDef.unsupported: string[]` | Unsupported clauses compile to **`UnsupportedAbility`** (`{ kind: 'unsupported', reason: UnsupportedReason, text: string, span: Span, unparsed: Span[], ... }`, `ir.ts:154–191`) in `FaceDefinition.abilities: AbilityDef[]`, paired with `CardDefinition.fullySupported: boolean` (`ir.ts:27`) and `CardSupportReport` (`compiler/support.ts:46–50`). |
| `L55` | `reorderZone`, `createToken` in `runtime/zones.ts` | **Neither exists in `runtime/zones.ts`.** Actual `zones.ts` zone-mutating exports are `moveObject`, `placeDeferred`, `shuffleLibrary`, `setZoneOrder`, `rearrangeLibrary`, `transferBattlefieldControl`, `removeFromGame`, and `mulliganRedraw`. Token creation is `createTokenOnBoard` in `engine.ts` (exposed via `EffectPlatform.createToken`). |
| `L57` | `timestamp` on `CardInstance` | `CardInstance` field is **`enteredTimestamp`** (`types.ts:242`, `zones.ts:259`); `timestamp` only exists on `BoardEntry` / `EvaluatedPermanent`. |
| `L68` | `excludeSelf` | `ObjectFilter` field is **`other?: boolean`** (`ir.ts:244`, evaluated against `ctx.sourceId` in `runtime/objectFilter.ts:207`). |
| `L75` | `applyReplacements` over `moveZone`, `draw`, `damage`, `gainLife`, `addCounters`, `createTokens`, `untap` | **No `applyReplacements` function exists.** `runtime/replace.ts` exports narrow per-domain helpers (`applicableReplacements`, `resolveZoneChangeReplacements`, `replaceEmptyLibraryDraw`, `cardEntersTapped`, `applySelfEtbReplacements`, `applicableCounterReplacements`, `resolveCounterReplacements`, `counterMultiplier`, `tokenMultiplier`). `EventPattern['event']` (`ir.ts:652`) uses `'lifeGain'` (not `'gainLife'`) and has no `'createTokens'` or `'untap'` variants. |
| `L86` | `sourceCharacteristic` | No such function exists; LKI reads use `refSnapshot(ref, lki)` / `ObjectSnapshot` (`runtime/effects.ts:52,707–760`) and `StackItem.lkiPower` / `lkiToughness` / `lkiControllerId` / `lkiTypeLine` (`types.ts:440–443`). |
| `L129` | `rngSeed` | `GameState` stores **`rngState?: number`** and **`idSalt?: number`** (`types.ts:806–808`), seeded by `freshRngSeed()` (`runtime/random.ts:36`). |
| `L132` | `runtime/layers-cache.test.ts` | `runtime/layerCache.test.ts`, `runtime/layerCache.scope.test.ts`, `runtime/layerCache.phase6d.test.ts`. |

### 2.2 `ENGINE_ARCHITECTURE_PLAN.md` Drift vs. Actual Codebase

1. **Present-tense pre-rewrite prose left in §§0–2 (`L36–70`)**:
   - Even after moving the Phases 0–10 log to `deprecated/ENGINE_PHASES_0-10_LOG.md`, `ENGINE_ARCHITECTURE_PLAN.md:36–70` still says *"What the current code already does right (keep it)"* and *"Root causes this plan removes"* in the present tense, referencing deleted types and functions (`CardRuleTree`, `getCardRuleTree`, `TriggerCondition`, `StructuredTriggeredAbility`, `parseSpellOrAbilityEffects`, `dynamicFormula`, `obeka_end_turn_choice`).
2. **§2.1 IR Type Sketch (`L138–239`) & §2.8 Choice Sketch (`L322–325`) no longer match `ir.ts` / `types.ts`**:
   - `FaceDefinition` (`ir.ts:30–34`) has **no `spell?: SpellDef` field**; spells use `SpellAbility` (`{ kind: 'spell', ... }`) inside `abilities: AbilityDef[]`.
   - `FaceDefinition.characteristics` uses `power?: number; toughness?: number; ptDefinedByAbility?: boolean`, not `power?: Amount | number`.
   - `Selector` `{ k: 'target', index: number }` (`ir.ts:457`) does not embed `spec: TargetSpec` (target specs live on the ability's `targets: TargetSpec[]`).
   - `StaticDef` (`ir.ts:635–640`) includes a 5th variant `{ k: 'restriction', affected, restriction: RestrictionKind, condition? }`.
   - `ChoiceRequest` (`types.ts:503–523`) is a 6-variant discriminated union (`yesNo`, `chooseObjects`, `chooseMode`, `chooseNumber`, `orderObjects`, `chooseReplacement`) rather than `{ kind, min, max, candidates, sourceAbility }`.
3. **§2.5 Replacement Helper Claim (`L287–291`)**:
   - Claims `RuleModifier`s and `ReplacementDef`s *replace* `playerCannotLoseGame`, `playerCannotWinGame`, `checkGlobalCastPermissionsAndRestrictions`, and `getLibrarySearchInterceptor`. Those 4 functions still exist in `runtime/replace.ts:258,278,348,501` (re-exported by `ruleTree.ts:591–595`), now implemented on top of `activeRuleModifiers`.

---

## 3. `ENGINE_INVARIANTS.md` Claims vs. Actual Implementation

Several bullets in `ENGINE_INVARIANTS.md` state **aspirational targets or inaccurate behavior** as if they are currently enforced invariants. Agents consulting `ENGINE_INVARIANTS.md` before modifying code can be actively misled by the following discrepancies:

### 3.1 Section 1 — The IR Wall (`L9–28`)
- **Claim (`L12–16`):** *"Only `src/lib/magic/compiler/` may read `card.oracleText` or parse `card.typeLine` strings... No runtime branch... may branch on `card.name === '...'` (not for ... Treasure, or Seven Dwarves). Every card mechanic must be represented as a general IR construct (... or deck-limit property)."*
- **Actual Codebase:**
  1. **`scryfall.ts` (`L27–42, 187–194, 406–451, 564`)** hardcodes card-name tables `MULTI_COPY_CARDS` (`'relentless rats'`, `'rat colony'`, `'shadowborn apostle'`, `'persistent petitioners'`, `'dragon\'s approach'`, `'slime against humanity'`, `'hare apparent'`, `'tempest hawk'`) and `CAPPED_COPY_CARDS` (`'seven dwarves': 7`, `'nazgûl': 9`), and regex-scans raw `oracleText` for `'can be your commander'`, `'Friends forever'`, `'Doctor\'s companion'`, `'Choose a Background'`, and `'a deck can have any number of cards named'`.
  2. **`oracle.ts` (`L28–67, 406–445, 529–560`)** is outside `compiler/`, reads `oracleText` and `typeLine`, and tests `/\bTreasure\b/.test(spec.typeLine)` (`L52`).
  3. **Runtime & UI `typeLine` string reads** remain widespread in `runtime/zones.ts:264,340–350`, `runtime/choices.ts:670–677`, `runtime/effects.ts:183,1868–1975`, `engine.ts` (dozens of sites), and `ArenaTable.svelte:949,1013,1030,1356,1480,1503,1518` (checking `inst.card.typeLine.includes('Creature' | 'Land' | ...)` instead of evaluated types).

### 3.2 Section 2 — Layers, CDAs & Clamping (`L31–49`)
- **Claim (`L35–38`, Layer 2/3 & `CR 613.8` Dependencies):** Claims evaluation runs `1a -> 1b -> 2 control -> 3 text -> 4 -> 5 -> 6 -> 7a–7d` and applies effects in **`CR 613.8` dependency order** before timestamps, and assigns a fresh timestamp whenever attaching an Aura/Equipment/Fortification (`CR 613.7e`).
- **Actual Codebase:**
  1. `runtime/layers.ts:6` evaluates only `(1, 4, 5, 6, 7a, 7b, 7c, 7d)`. Layer 2 control changes mutate `player.battlefield` arrays directly (`transferBattlefieldControl`), and Layer 3 text-changing effects are unimplemented.
  2. **General `CR 613.8` dependency ordering is not implemented** (and is listed as an explicit non-goal in `ENGINE_ARCHITECTURE_PLAN.md:394–395` and `FULL_COVERAGE_STRUCTURE.md:160–161`). `layers.ts` instead runs three fixed sub-passes in Layer 4 (`evaluateAttachedTypes` -> `evaluateTypeOverwrites` -> `evaluateAdditiveTypesAndColors`).
  3. **`CR 613.7e` attachment timestamp bug (`runtime/effects.ts:1247–1254`):** `attach` only allocates a fresh `enteredTimestamp` when `wasAttached` (`Boolean(equipment.inst.attachedToId)`) was already true; equipping a previously unattached Equipment leaves its old `enteredTimestamp` unchanged.
- **Claim (`L44–45`, All-Zone CDAs):** Claims `Changeling`, `Devoid`, and `*/*` P/T CDAs function in **all zones**.
- **Actual Codebase:**
  1. **`Devoid` (`CR 702.114a`) is completely unimplemented** (`'devoid'` is in `KNOWN_KEYWORDS`, not `IMPLEMENTED_KEYWORDS`; 133 cards fail on `Devoid` in `COVERAGE.md:41`).
  2. **Off-battlefield `Changeling`** works in `objectFilter.ts` and `layers.ts` `buildOffBattlefieldBreakdown`, **but is missing** in `matchesLibrarySearchSpec` (`oracle.ts:529–584`), Layer 7 graveyard subtype counts (`runtime/layers.ts:835–849`), and cast/graveyard trigger subject matching (`printedSubject` in `runtime/triggers.ts`).
- **Claim (`L46–48`, Unclamped Characteristics):** Claims evaluated P/T can remain negative in layer calculation and non-creatures have `null` P/T.
- **Actual Codebase:** `buildBoardResults` (`runtime/layers.ts:2008–2042`) clamps `effectiveToughness` and `EvaluatedPermanent.toughness` via `Math.max(0, ...)` inside layer evaluation (only `unclampedToughness` preserves negative values), and sets `EvaluatedPermanent.power` / `toughness` to `0` (not `null`) on non-creatures (`breakdown.effectivePower` / `effectiveToughness` are `null`).

### 3.3 Section 3 — Zone Transitions & `moveObject` (`L52–69`)
- **Claim (`L54–63`):** Claims `zones.ts` is the sole mutator of all zones including `stack`, and that `moveObject` automatically increments `objectVersion`, assigns a new `timestamp`, resets all transient state (including `summoningSick`), and resets `controllerId` to `ownerId` on every non-battlefield/stack move.
- **Actual Codebase:**
  1. `state.stack` is **not** managed by `runtime/zones.ts` (`zones.ts:24,42–43`); `engine.ts` and `runtime/effects.ts` mutate `state.stack` directly.
  2. `moveObject` (`runtime/zones.ts:20–21,57–70,226–260`) is **explicitly opt-in per caller** (*"moveObject does nothing implicitly: each caller states what its site did"*): `objectVersion` only bumps when `opts.bumpVersion: true`, `enteredTimestamp` only updates when `opts.newTimestamp: true`, and transient battlefield fields + `controllerId = ownerId` only reset when `opts.leaveBattlefieldReset: true` (and `summoningSick` is omitted from `finalizeZoneMove` at `zones.ts:234–256`).

### 3.4 Section 4 — Replacements (`L72–87`)
- **Claim (`L74–77`):** Claims every replaceable event (`moveZone`, `draw`, `damage`, `gainLife`, `addCounters`, `createTokens`, `untap`) passes through `applyReplacements` with `CR 614.16` [sic: `614.15`] self-replacement and `CR 616.1b–c` ordering.
- **Actual Codebase:** Only graveyard moves (`opts.graveyardReplacement`), empty-library draw, self-ETB/Clone ETB, `lifeGain` (added in `c7d6b79`), and counter placement consult `ReplacementDef`s; `damage` and `untap` use inline shield/protection/stun checks without `ReplacementDef`s, `tokenMultiplier` multiplies without `chooseReplacement`, and `replacementPriorityTier` (`runtime/replace.ts:715–732`) omits `CR 616.1b` control-changing ETB replacements (tiers `1`, `3`, `5` only).

### 3.5 Section 5 & Section 6 — Step List & Pause-and-Resume (`L91–118`)
- **`first_strike_damage` step omitted (`L93, 100`):** `GamePhase` (`types.ts:24`) includes `'first_strike_damage'`, which both step lists omit.
- **Pause-and-resume overstated (`L116–117`):**
  - `CostDef`s do **not** pause mid-payment with a continuation frame; `planCosts` (`runtime/costs.ts:8–9,577`) asks a `CostQuestion` *before* paying any cost and re-runs the entire cast/activate action once answered.
  - `EffectStep`s only pause on a specific subset of prompting verbs (`sacrifice`, `discard`, `proliferate`, `addMana` with color choice, certain `move` / `dig` / `scry` / `search` / `lookAndReorder` steps). Mid-ability `"you may"` choices are **explicitly rejected as unsupported** in `compiler/interpretable.ts:78,147` (*"the interpreter can't pause mid-ability"*), directly contradicting `ENGINE_INVARIANTS.md:116–117` and matching `FULL_COVERAGE_STRUCTURE.md:79–90`.

### 3.6 Section 7 — Determinism, Layer Cache & Ratchet Scope (`L121–134`)
- **Wall-clock fields in `GameState` (`L122–129`):** While gameplay decisions use `rngState` and `nextUid`, `Date.now()` is still written into `GameState` (`GameLogEntry.timestamp`, `StackItem.createdAt`, `state.turnStartedAt`, `state.priorityUpdatedAt`), so replaying a seed + action sequence at two wall-clock times does not produce byte-identical JSON without stripping timestamps.
- **Layer cache post-Phase-6d architecture (`L130–132`):** `evaluatePermanent` **always** caches via `WeakMap<GameState, BoardSnapshot>` + read-tracked `dynamicFingerprint` (`runtime/layerCache.ts:1–81`, `runtime/layers.ts:966–1026`), never includes `state.stack` in its fingerprint, and uses `withStableLayerInputs(state, fn)` only to skip re-validating fingerprints inside a read-only call (`trustedState === state`).
- **Architecture ratchet scope (`L133–134`):** `architecture.test.ts:20–28,160–168` **exempts** `compiler/**`, `oracle.ts`, `precons.ts`, `scryfall.ts`, `search.ts`, `types.ts`, and `*.test.ts` from the first 4 rules (`cardNameComparison`, `oracleTextRead`, `directZoneMutation`, `legacyTextHelperCall`), applies `cardNameInCode` only against precon card names (not arbitrary cards like *Seven Dwarves* or tokens like *Treasure*), and never scans `.svelte` files (`ArenaTable.svelte`).
- **7 wrong CR citations in `ENGINE_INVARIANTS.md`:** Detailed in [`02-rules-audit-arithmetic-and-cr-citations.md`](./02-rules-audit-arithmetic-and-cr-citations.md) §2.1.

---

## 4. `ENGINE_ARCHITECTURE_PLAN.md`, `COVERAGE.md` & `FULL_COVERAGE_STRUCTURE.md` Audit

### 4.1 Active Post-Phase-10 Architectural Knowledge Orphaned in `deprecated/`
In the current uncommitted working tree, moving `ENGINE_ARCHITECTURE_PLAN.md` §0 and §3 (1,367 lines) to `deprecated/ENGINE_PHASES_0-10_LOG.md` while marking `deprecated/` as *"Don't use them as a source of current behaviour"* (`README.md:32`) orphaned several **post-Phase-10 design decisions and known limitations** that were recorded only inside §3 between 2026-11-09 and 2026-11-11 (`9f0a8b2`, `99bae0f`, `8e53287`, `852b8d5`, `02de16f`, `d46ab0d`), while leaving §2 describing the superseded 2026-11-08 pre-implementation target:
1. **Phase 6d read-tracking layer cache** (`WeakMap<GameState, BoardSnapshot>` + `dynamicFingerprint` + read-only `withStableLayerInputs` trust scopes) — §2.4 (`L283`) still says *"Cached by `state.version`, a counter bumped on every mutation."*
2. **Review Phase 4 `CR 104.4b / 731` loop detection** (`computeLoopBoardFingerprints` including player state, non-sticky cycle detection, and the `MAX_TRIGGERS_PER_TURN = 2000` backstop known limitation).
3. **Review 2 `pendingZoneMoves` deferred zone-change replacement architecture** (pausing SBAs while `chooseReplacement` is pending and redacting hidden/face-down origins in `sanitizeGameStateForViewer`).
4. **Review Phases 1–2 security & redaction model** (`idSalt` opaque base-36 `instanceId`s, stripping `rngState`/`nextUid`/`idSalt`/`effectResume`, redacting opponent prompts, and `ENGINE_VERSION = 2` load-time enforcement).
5. **Review 2 `CR 207.2c / 207.2d` ability-word and flavor-word normalization rule** (`isAbilityOrFlavorWord` + `RULES_TERM_BLOCKLIST` in `compiler/normalize.ts`).

### 4.2 Dual-Runtime Deployment & Bot Pacing Omitted from `ENGINE_ARCHITECTURE_PLAN.md`
- **Homelab Node + SQLite Backend (`8be920a`):** `ENGINE_ARCHITECTURE_PLAN.md:28,31,296–306` describes a Cloudflare Workers + D1-only architecture. Since `8be920a`, Magic supports `MAGIC_MODE = "cloudflare" | "homelab"` (`src/hooks.server.ts:159–195`, `src/lib/magic/db.ts`, `ops/magic-backend/README.md`, `scripts/migrate-magic-*.mjs`), where Workers can proxy `/magic/api/*` to a single-process Node 24 + `node:sqlite` server with in-process `KeyedMutex` lobby serialization. Neither `README.md` nor `ENGINE_ARCHITECTURE_PLAN.md` links to `ops/magic-backend/README.md`.
- **Paced AI Bot Execution (`8e6580d`):** `botSpeed` host rule, server-side `bot_resume_at` / `advance_bots`, CAS `saveLobby`, and deterministic `botDelayMs` (`ai.ts`, `ai-pacing.test.ts`) are undocumented in `src/lib/magic/docs/`.

### 4.3 `COVERAGE.md`, `README.md` & `FULL_COVERAGE_STRUCTURE.md` Live Metrics Delta

Running `node scripts/magic-coverage.ts ~/data/scryfall/oracle-cards.jsonl.gz` live at `COMPILER_VERSION = 7` shows that `COVERAGE.md` (and the figures copied into `README.md:12` and `FULL_COVERAGE_STRUCTURE.md:24–30`) is **3 compiler versions behind**:

| Metric | Documented (`COVERAGE.md` / `README.md` / `FULL_COVERAGE_STRUCTURE.md`) | Live Codebase (`node scripts/magic-coverage.ts`, 2026-11-12) | Delta |
| :--- | ---: | ---: | ---: |
| `COMPILER_VERSION` | `4` | **`7`** (`compiler/index.ts:17`) | `+3` versions |
| All game cards (`35,062`) — Fully supported | `6,873` (`19.6%`) | **`7,393` (`21.1%`)** | **`+520` cards (`+1.5 pp`)** |
| All game cards — Ignoring statics *(obsolete pre-Phase-6 metric)* | `10,267` (`29.3%`) | **`10,828` (`30.9%`)** | `+561` cards |
| Abilities supported | `24,363 / 62,490` (`39.0%`) | **`25,346 / 62,627` (`40.5%`)** | **`+983` abilities (`+1.5 pp`)** |
| Unsupported: `unparsed` | `24,585` | **`24,067`** | `-518` |
| Unsupported: `keyword_not_implemented` | `4,448` | **`4,419`** | `-29` |
| Unsupported: `static_not_compiled` | `7,674` | **`7,608`** | `-66` |
| Unsupported: `multiface` | `895` | **`895`** | `0` |
| Unsupported: `event_not_implemented` | `525` | **`292`** | **`-233` (`-44.4%`)** |
| Precon decks (`140` cards) | `121` (`86.4%`), `207/226` abilities | **`121` (`86.4%`), `207/226` abilities** | Net `0` |
| Unimplemented `KNOWN_KEYWORDS` (`FULL_COVERAGE_STRUCTURE.md:98`) | *"About 150"* | **`177`** (`206` unique `KNOWN_KEYWORDS` minus `29` `IMPLEMENTED_KEYWORDS`) | `+27` |
| Regex literals in `compiler/effects.ts` (`FULL_COVERAGE_STRUCTURE.md:125`) | *"about 150"* | **`~172`** | `+22` |

- **Stale Top-100 Unparsed Templates in `COVERAGE.md`:** Templates `#12 Tap target creature.` (101 cards), `#14 Prowess` (86 cards), `#15 Whenever you gain life,` (84 cards), and `#31 Whenever ~ becomes tapped,` (61 cards) in `COVERAGE.md` are **already implemented** and absent from live unparsed output.
- **Obsolete `"Fully supported, ignoring statics"` column (`COVERAGE.md:11,15`, `scripts/magic-coverage.ts:59–60,104`) & stderr label (`scripts/magic-coverage.ts:320`):** `"Ignoring statics"` was a Phase 1–5 transition metric (*"which Phases 6/7 compile"*), and `scripts/magic-coverage.ts:320` still logs `(legacy-claimed upper bound)` to stderr long after Step F retired the legacy adapter.
- **`FULL_COVERAGE_STRUCTURE.md:39–47` Working-Tree Lifecycle Warning:** Accurately describes the `ecd4a3e` Overload UI bug and notes the uncommitted fix in the working tree; as soon as the concurrent agent commits, lines `39–47` (and `151–152`) must be updated to past tense so they do not claim Overload is still uncommitted.
