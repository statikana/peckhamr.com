# Comprehensive Rules (`CR 100–905`) Master Audit Summary & Prioritized Gap List

Audited against `engine-rewrite` (`917180b` and reconciled post-Step-F at `9ac8423`) on 2026-11-09 across 10 parallel section audits covering every numbered rule in [`src/lib/rules.txt`](../../../rules.txt) (lines 183–7151).

---

## 1. Section-by-Section Summary

| Section | Report | Rules Range | Implemented | Partial | Missing | N/A | Total Rows/Subrules |
| :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: |
| **01** | [`01-game-concepts.md`](./01-game-concepts.md) | `CR 100–123` (lines 183–1278) | 210 | 79 | 124 | 90 | 503 |
| **02** | [`02-card-parts-types-zones.md`](./02-card-parts-types-zones.md) | `CR 200–408` (lines 1279–2113) | 92 | 42 | 64 | 65 | 263 (362 rules) |
| **03** | [`03-turn-structure.md`](./03-turn-structure.md) | `CR 500–514` (lines 2114–2455) | 42 | 43 | 48 | 6 | 139 |
| **04** | [`04-spells-abilities-effects.md`](./04-spells-abilities-effects.md) | `CR 600–616` (lines 2456–3203) | 91 | 113 | 100 | 15 | 319 |
| **05** | [`05-general-and-keyword-actions.md`](./05-general-and-keyword-actions.md) | `CR 700–701` (lines 3204–3911) | 17 | 12 | 67 | 8 | 104 |
| **06** | [`06-keyword-abilities-1.md`](./06-keyword-abilities-1.md) | `CR 702.1–702.84` (lines 3912–4654) | 56 | 42 | 153 | 11 | 262 |
| **07** | [`07-keyword-abilities-2.md`](./07-keyword-abilities-2.md) | `CR 702.85–702.196` (lines 4655–5487) | 12 | 11 | 261 | 18 | 302 |
| **08** | [`08-tba-sba-copy.md`](./08-tba-sba-copy.md) | `CR 703–707` (lines 5488–5751) | 21 | 28 | 52 | 13 | 114 |
| **09** | [`09-additional-rules-708-plus.md`](./09-additional-rules-708-plus.md) | `CR 708–734` (lines 5752–6455) | 19 | 45 | 204 | 46 | 314 |
| **10** | [`10-multiplayer-commander.md`](./10-multiplayer-commander.md) | `CR 800–905` (lines 6456–7151) | 25 | 17 | 9 | 194 | 245 |
| **Total** | | **`CR 100–905`** | **585** | **432** | **1,082** | **466** | **2,565** |

> [!NOTE]
> Most of the **1,082 `missing`** subrules sit in the long tail of set-specific keyword actions (`CR 701`), keyword abilities (`CR 702`), and specialized card frames (`CR 708–734`). The highest-priority findings are the **bugs in already-implemented mechanics**, **false-positive compiler support claims** (cards marked `fullySupported: true` whose mechanics are silently dropped), and **silent auto-decisions** that skip required player choices.

---

## 2. Prioritized Master Gap List

### Tier 1: Core Rules Bugs in Active Mechanics (High Impact, Small–Medium Fixes)

These are bugs where a mechanic the engine actively supports produces the wrong game state according to the Comprehensive Rules:

1. **[FIXED; SBA shield-counter subclaim DISPUTED] Combat damage bypasses the unified damage pipeline (`CR 120.3d, 120.4, 122.1c, 122.6, 510.2, 702.16e, 702.80a, 702.90c`)** — **Size: M**
   - Fixed in `executeCombatDamageStep` (`engine.ts`), `runtime/effects.ts`, and `compiler/statics.ts`: exported `sourceDamageInfo`, `permanentProtectedFromSource`, `dealDamageToPermanent`, `dealDamageToPlayer`, and `applyLifelinkGain` with a `combat` flag, and routed all combat damage through them after computing simultaneous combat damage assignments (`CR 510.1–510.2`).
   - Combat damage now enforces Protection (`CR 702.16e`), Wither (`CR 702.80a`), shield-counter damage prevention (`CR 122.1c`), `damagePreventionShield` (`CR 615.7`), static `lifeTotalCantChange` rule modifiers (`CR 119.7`), and `addCountersToPermanent` on Infect/Wither `-1/-1` counters (`CR 122.6, 702.90c`).
   - **Disputed audit subclaim (`CR 122.1c` in lethal-damage/deathtouch SBAs):** `CR 122.1c` (`src/lib/rules.txt:1187`) states *"If this permanent would be destroyed as the result of an effect, instead remove a shield counter from it"* and *"If damage would be dealt to this permanent, prevent that damage and remove a shield counter from it."* Destruction by a state-based action under `CR 704.5g/h` is a rule, not *"the result of an effect"*, so shield counters must **not** replace lethal-damage or deathtouch SBAs; only the damage-prevention half of `CR 122.1c` applies to combat damage.

2. **[FIXED] Attacked planeswalker leaving combat redirects attacker's damage to the defending player (`CR 506.4c, 510.1b, 702.19f`)** — **Size: S**
   - Fixed in `executeCombatDamageStep`, `simulateCombatForecast`, `checkStateBasedActions`, `phaseOutPermanent` (`engine.ts`), and `removeFromCombat` (`runtime/zones.ts`): when an attacked planeswalker leaves the battlefield, phases out, changes controller, or stops being a planeswalker, unblocked attackers deal 0 combat damage (`CR 506.4c, 510.1b`) and Trample attackers assign all combat damage to their blockers (or 0 if no blockers remain) without redirecting excess damage to the defending player (`CR 702.19f`).

3. **[FIXED] Permanents leaving the battlefield or losing creature type are never removed from `state.combat` (`CR 506.4, 506.4a`)** — **Size: S**
   - Fixed in `moveObject` (`runtime/zones.ts`) via `removeFromCombat` and in `checkStateBasedActions` (`engine.ts`) for permanents that stop being creatures or become battles, while preserving `wasBlocked` on attackers whose blockers leave combat (`CR 510.1c`).

4. ~~**Extra turns overwrite `activePlayerIndex` and skip intermediate players' normal turns (`CR 500.7`)**~~ — **Fixed (`lastNormalTurnPlayerIndex` saved on extra-turn entry and used to resume normal turn order)**
   - In `completeTurnCleanupAndPassTurn` (`engine.ts`), popping an extra turn from `extraTurnQueue` now records `state.lastNormalTurnPlayerIndex` before switching `activePlayerIndex`, and resumes normal turn order from that seat once `extraTurnQueue` empties.

5. **[FIXED] `end_turn` UI action jumps from any phase straight to `end_step`/`cleanup` without passing priority (`CR 500.2, 508.1d, 513.1, 703.4i`)** — **Size: M**
   - Fixed in `case 'end_turn':` and `case 'pass_priority':` (`engine.ts`) via `findMandatoryAttackerViolation`: ending the turn (or passing out of `declare_attackers` without declaring attackers) enforces mandatory attack requirements (`attacksEachCombat` and Goad, exempting opponents with Propaganda/Ghostly Prison attack taxes per `CR 508.1d`) and steps sequentially through remaining phases/steps via `advancePhaseOrStep`, executing step turn-based actions (such as drawing for turn in `draw`), flushing step-begin triggers, and stopping whenever triggers/prompts exist or a player holds `fullControl`, `!autoPassEmptyStack`, or an explicit step stop (such as `'end_step'`).

6. ~~**Colorless commander / no commander `manaChoiceColors` falls back to all 5 colors (`CR 106.5, 903.4f`)**~~ — **Fixed (`commanderIdentity` returns `[]` when colorless/absent while staying a mana ability; `'any'` separated from `'commanderIdentity'` in `manaStepProduction`)**
   - `manaChoiceColors` (`runtime/effects.ts`), `opponentLandColors` / `manaStepProduction` (`ruleTree.ts`), and `tap_mana` (`engine.ts`) now produce 0 mana when a player has a colorless commander or no commander, and `manaStepProduction` returns all 5 colors for `'any'`.

7. ~~**Last-player-standing win is blocked by `playerCannotWinGame` (`CR 104.2a vs 104.3h`)**~~ — **Fixed (`CR 104.2a` last-player-standing win overrides effects precluding winning)**
   - In `checkStateBasedActions` (`engine.ts`), when all other players have left the game (`remaining.length === 1`), the remaining player now wins immediately regardless of `playerCannotWinGame` per `CR 104.2a` ("overrides all effects that would preclude that player from winning the game"). (`CR 104.3h` only applies to Limited Range of Influence.)

8. ~~**Multiple trigger-multiplier effects multiply (`2 * 2 = 4`) instead of adding (`1 + 1 + 1 = 3`) (`CR 603.2d`)**~~ — **Fixed (`triggerMultiplier` adds `def.factor - 1` per effect)**
   - `triggerMultiplier` (`runtime/replace.ts`) now computes `times += Math.max(0, def.factor - 1)` ("triggers an additional time") per `CR 603.2d`.

9. ~~**Layer 4 `setTypes` / `setSubtypes` drops `Basic`/`Snow` supertypes and non-land types on artifact lands (`CR 205.1a–b, 205.4b, 305.7`)**~~ — **Fixed (`setTypes` / `setSubtypes` preserve all supertypes and `setSubtypes` preserves non-land card types and subtypes)**
   - In `runtime/layers.ts`, `evaluateAttachedTypes` (`setTypes`) and `evaluateTypeOverwrites` (`setSubtypes`) now preserve all supertypes (`Basic`, `Legendary`, `Snow`, `World`, `Ongoing`), and `setSubtypes` preserves existing card types (`Artifact`, `Creature`) and non-land subtypes per `CR 205.1a`, `205.4b`, and `305.7`.

10. ~~**Permanent spell copies (`item.isCopy`) vanish on resolution instead of becoming token permanents (`CR 111.13, 608.3f, 707.10f`)**~~ — **Fixed (`resolveStackItemNow` puts resolving permanent spell copies onto the battlefield as tokens)**
    - `resolveStackItemNow` (`engine.ts`) now enters resolving permanent spells with `item.isCopy === true` onto the battlefield as token permanents (`isToken: true`, without applying token creation multipliers per `CR 111.13` / `608.3f`), while instant/sorcery spell copies still cease to exist.

11. ~~**`Enchant player` Auras (Curses) fail to attach on resolution and immediately die to SBAs (`CR 303.4b–c, 702.5c, 704.5m`)**~~ — **Fixed (player-enchanting Auras compile, target players, attach on resolution, and validate all Enchant abilities under SBAs)**
    - `compiler/card.ts` and `ruleTree.ts` now compile `Enchant player` / `Enchant opponent` / `Enchant you` into `enchantPlayer` target specs, `resolveStackItemNow` (`engine.ts`) attaches Auras to player targets (`item.targets[0]?.kind === 'player'`), and `checkStateBasedActions` (`engine.ts`) validates both player attachments (`isAuraPlayerAttachmentLegal`) and multi-`Enchant` requirements (`CR 702.5c`).

12. ~~**Eliminated player cleanup mishandles stolen permanents, stack spells, and active-player mid-turn elimination (`CR 800.4a, 800.4c, 800.4j`)**~~ — **Fixed (`defaultControllerId` tracking, stack spell exile/owner removal, and active-less turn continuation)**
    - `CardInstance` now tracks `defaultControllerId` on battlefield entry (`CR 110.2`), so `cleanupEliminatedPlayer` (`engine.ts`) returns control-changed permanents to their default controller while exiling foreign-owned permanents whose default controller left the game (`CR 800.4a, 800.4c`), exiles foreign-owned spells on the stack controlled by the eliminated player while removing stack objects owned by the eliminated player (`CR 800.4a`), and continues the turn to completion without an active player via `givePriorityToActiveOrNextPlayer` (`CR 800.4j`).

---

### Tier 2: False-Positive Compiler Support & Silently Skipped Player Choices (Invariants 1.5 & 6.2)

These are places where the compiler claims a card is `fullySupported: true` (suppressing deck-builder warnings and manual resolution) while silently dropping rules constraints, or where the runtime makes a choice on behalf of a human player without prompting:

1. **`Solved —`, `Max speed —`, `Boast —`, `Exhaust —`, and `Power-up —` stripped as ability words and executed unconditionally (`CR 702.142a, 702.169b–d, 702.177a, 702.178a, 702.193a`)** — **Size: S**
   - `ABILITY_WORD` in `compiler/normalize.ts:39` (`/^[A-Z][A-Za-z' -]*? — (?=[A-Z•])/`) strips any capitalized em-dash prefix before parsing. Case cards (`Solved —`), Aetherdrift cards (`Max speed —`), and word-cost `Boast`/`Exhaust`/`Power-up` abilities compile as `fullySupported: true` and apply/activate unconditionally from Turn 1.

2. **Activation and cast restrictions matched in `RESTRICTION_SENTENCES` (`CR 601.3, 602.5b`)** — **Size: S**
   - `compiler/card.ts` wires spell-level `castRestrictions` (`"Cast ~ only during combat."`, `"Cast ~ only during your turn."`, `"Cast ~ only before attackers are declared."`), which `checkSpellCastLegality` now enforces on `CardFaceDef`. However, `compiler/effects.ts` still strips activated-ability timing/frequency sentences (`"Activate only once each turn."`, `"Activate only during your upkeep."`, `"Activate only as a sorcery."` when not parsed into `sorcerySpeed` / `oncePerTurn`) without enforcing `"Activate only during your upkeep"`.

3. **Granted `Prowess`, `Fear`, `Intimidate`, `Shadow`, `Horsemanship`, and `Hexproof from [quality]` compile as `fullySupported: true` and show UI badges, but are never enforced (`CR 702.11d, 702.13, 702.28, 702.31, 702.36, 702.108a`)** — **Size: S**
   - `compiler/statics.ts:93-135` and `runtime/layers.ts:178-212` compile and display these keywords on permanents, but `declare_blockers`, `hasKeyword(inst, 'Hexproof', state)`, and spell-cast triggers ignore them.

4. **Unsupported keywords on Instants & Sorceries are silently skipped with no log or manual prompt (`CR 702.85a, 702.88a, etc.`)** — **Size: S**
   - `parseSpellText` (`compiler/effects.ts`) skips non-period keyword lines (`Cascade`, `Rebound`, `Cipher`, `Demonstrate`, `Casualty`, etc.), and `noteUnautomatedOnEnter` only fires when a permanent enters the battlefield.

5. **Human player choices silently auto-decided (`Invariant 6.2`)**:
   - **Commander to hand or library (`CR 903.9b`, `runtime/zones.ts:224-231`)** — only redirects for `owner?.isBot`; humans are never prompted and their commander goes straight to hand/library (and non-battlefield moves omit `commanderRedirect: true`). **Size: S**
   - **Proliferate (`CR 701.34a`, `runtime/effects.ts`, `engine.ts`)** — always called without `chosenIds`, heuristically proliferating without prompting the human controller. **Size: S**
   - **Ward (`CR 702.21a`, `engine.ts`)** — automatically taps lands/mana or pays life for a human opponent without asking if they want to decline and let the spell be countered; non-mana/non-life Ward costs parse as `{0}` and succeed for free. **Size: S**
   - **Replacement effect ordering (`CR 616.1`, `runtime/replace.ts:724-750`)** — picks the first matching replacement in board order instead of prompting with `chooseReplacement`. **Size: M**
   - **Multi-blocker & Trample combat damage assignment (`CR 510.1c, 702.19b`, `engine.ts`)** — auto-assigns minimum lethal damage in blocker array order without prompting the attacker. **Size: M**
   - **Mana color choice (`CR 105.4`, `runtime/effects.ts`) & Hybrid/Phyrexian payment (`CR 118.13a`, `engine.ts`)** — auto-picks `preferredColor` / `allowed[0]` and auto-pays mana before 2 life without prompting. **Size: S/M**
   - **Clone untargeted ETB (`CR 707.5`, `engine.ts`)** — auto-picks the highest-CMC creature on the board if untargeted. **Size: S**
   - **Auras entering the battlefield without being cast (`CR 303.4f–g`, `runtime/effects.ts`)** — enters unattached and dies to SBAs instead of prompting the controller to attach it to a legal object. **Size: M**

---

### Tier 3: Missing Event Bus Wiring, Grammar Productions & Filter Expressiveness

1. **Auto-tapping lands during cost payment skips `TappedForMana` (`CR 106.12, 605.3a`)** — **Size: S**
   - `simulateOrExecuteAutoTap` (`engine.ts:813-832`) mutates `perm.tapped = true` and `manaPool` directly without emitting `TappedForMana`, skipping triggered mana abilities (*Mirari's Wake*, *Crypt Ghast*).

2. **`GainLife`, `CardDrawn`, and `BecomesTapped` events are never emitted (`CR 119.9, 121.2, 603.2`)** — **Size: M**
   - `compiler/triggers.ts` parses `"Whenever you gain life"`, `"Whenever you draw a card"`, and `"Whenever ~ becomes tapped"`, but `compiler/triggers.ts:417` flags `gainLife` / `drawCard` / `becomesTapped` as `event_not_implemented` and `runtime/events.ts` never emits them. Additionally, `state.playersDrawnThisTurn` (`engine.ts:918`) is never cleared at turn transitions, and ETB counters (`engine.ts:4245-4263`) don't emit `CounterPlaced`.

3. **`fight`, `tap`, `untap`, and `tapOrUntap` exist in `runtime/effects.ts` but have no grammar productions in `compiler/effects.ts` (`CR 701.14, 701.26`)** — **Size: S**
   - The IR interpreter (`runtime/effects.ts:971-1002, 1297-1337`) implements all four verbs, and `copySpell` (`CR 707.10`) has the reverse issue (compiled in `compiler/effects.ts:901-906`, missing in `runtime/effects.ts`).

4. **Commander-specific IR queries (`CR 903.3d, 903.3e, 702.124k`)** — **Size: M**
   - `ObjectFilter`, `Amount`, and `Condition` lack `isCommander?: boolean` and cross-zone commander checks, blocking Background enchantments (`"Commander creatures you own have ..."`), free commander spells (`"If you control a commander, you may cast ~ without paying its mana cost"`), *Jeska's Will* *(being addressed in Step F/precons)*, and `"times you've cast your commander from the command zone"` scaling.

5. **`Grand Abolisher` ability-activation lock (`CR 602.5b`)** — **Size: S**
   - `"During your turn, your opponents can't cast spells or activate abilities of artifacts, creatures, or enchantments"` compiles to `opponentsCantCastDuringYourTurn` (`compiler/statics.ts:382-385`), which is checked in `checkGlobalCastPermissionsAndRestrictions` (`engine.ts:7941`) but never checked in `checkAbilityActivationLegality` (`engine.ts:8055`).

6. **Off-battlefield `*/*` CDAs (`CR 208.2a, 604.3`) & face-down mana value (`CR 202.3a, 708.2a`)** — **Size: S/M**
   - `buildOffBattlefieldBreakdown` (`runtime/layers.ts:1887-1890`) returns `null` P/T instead of evaluating Layer 7a CDAs in non-battlefield zones; `matchesObjectFilter` (`runtime/objectFilter.ts:225, 274`) reads `card.cmc` directly instead of `0` for `isFaceDown` permanents and ignores `xValue` on stack spells (`CR 202.3e`).

7. **Declare attackers / blockers step turn-based action ordering & off-turn human priority (`CR 508.1, 509.1, 703.3`)** — **Size: M**
   - Entering `declare_attackers` (`engine.ts:5906-5909`) and `declare_blockers` (`engine.ts:5913-5920`) grants priority before the turn-based declaration action; and `runAutomatedPriorityAndBots` (`ai.ts:191-206`) auto-passes priority for a human on an opponent's turn when the stack is empty even if the human holds castable instants (unless Full Control is on), ignoring `priorityPlayer.stopPhases`.

---

### Tier 4: Unimplemented Mechanics & Keywords Common in Commander (Phase 11+ Roadmap)

1. **Modal spells & abilities (`CR 700.2`)** — Mode choice prompt (`chooseMode`) on cast/trigger/resolution *(Step F is adding modal support for precon spells like Casualties of War and Farewell)*.
2. **Vehicles & `Crew N` / `Living metal` / `Saddle N` (`CR 301.7, 702.122, 702.161, 702.171`)** — Continuous Layer 4 type-animation effect (`becomes an artifact creature until end of turn`) and `tapOthers` total-power cost filter.
3. **Linked Exile (`CR 607.2a, 610.3`)** — `"Exile target ... until ~ leaves the battlefield"` (*Banisher Priest*, *Oblivion Ring*, *Grasp of Fate*) and `"cards exiled with ~"` tracking.
4. **Continuous effects from resolving spells/abilities (`CR 611.2`)** — Timestamped continuous-effect objects on `GameState` for Layer 2 control changes (*Act of Treason*, *Control Magic*), Layer 4/5 type/color changes, Layer 7b base P/T setting, and `"for as long as ..."` durations.
5. **Predefined tokens beyond Treasure (`CR 111.10a–x`)** — **Clue**, **Food**, **Blood**, **Map**, **Powerstone**, **Junk**, **Lander** token definitions in `compiler/effects.ts`.
6. **High-frequency keyword actions (`CR 701`)** — **Surveil** (`701.25`), **Investigate** (`701.16`), **Explore** (`701.44`), **Connive** (`701.50`), **Discover** (`701.57`), **Goad** (`701.15` application & expiration), **Regenerate** (`701.19`).
7. **High-frequency keyword abilities (`CR 702`)** — **Cascade** (`702.85`), **Flashback** (`702.34`), **Kicker** (`702.33`), **Cycling** (`702.29`), **Convoke** (`702.51`), **Delve** (`702.66`), **Undying** (`702.93`), **Persist** (`702.79`), **Toxic** (`702.164`), **Myriad** (`702.116`), **Landwalk** (`702.14`).
8. **Sagas (`CR 715`), Classes (`CR 717`), and Double-Faced / Split / Adventure Cards (`CR 709, 712, 716`)** — Lore counters & chapter triggers, class levels, and multi-face card casting/transformation.
9. **Monarch (`CR 726`) & Initiative (`CR 727`)** — Game-state designations and inherent triggers.

---

## 3. Step F Reconciliation (`eea6386` / `9ac8423`)

Step F (Phase 10) has been merged into `engine-rewrite`, resolving or retiring the following items noted in the individual section reports (`01` through `10`):
- **Resolved in Step F:**
  - **`CR 704.5j` Legend Rule human choice prompt:** Human controllers now receive a `legend_rule` (`chooseObjects`) prompt when controlling 2+ legendary permanents with the same evaluated name (`runtime/step-f-legend-uid.test.ts`).
  - **Deterministic `uid(prefix, state)` (`Invariant 7.2`):** Uses `state.nextUid` instead of `Math.random()` and `Date.now()`.
  - **Single `isAbilityAutomated` predicate (`compiler/interpretable.ts`):** `compileCard`, `cardSupportReport`, `staticallyInterpretable`, and `scripts/magic-coverage.ts` share one source of truth.
  - **Precon abilities migrated from legacy fallback to IR (`runtime/step-f-automation.test.ts`):** *Arcane Denial*, *Brainstorm*, *Ponder*, *Casualties of War*, *Farewell*, *Miirym, Sentinel Wyrm*, *Nether Shadow*, *Thassa's Oracle*, *The Ur-Dragon*, *Scourge of Valkas*, *Dack Fayden*, *Lathliss*, *Risen Reef*, *Syr Konrad*, *Bident of Thassa*, *Kess*, *Tivit*, *Tymna*, and *Windgrace's Judgment*.
  - **IR-native Equip (`CR 702.6a`), Ward (`CR 702.21a`), Suspend (`CR 702.62`), extra land plays (`CR 305.2`), spell self-exile, additional costs, and spell cast restrictions.**
- **Deleted in Step F:**
  - `compiler/adapter.ts`, `executeParsedEffect`, `parseSpellOrAbilityEffects`, `parseActivatedAbilities`, `parseStructuredTriggeredAbilities`, `parseTriggeredEffects`, `getCardRuleTree`, and all regex text parsers in `oracle.ts` and `ruleTree.ts`. Any findings listed under `## Legacy-only findings (verify after step F)` at the bottom of reports `01` through `10` that existed solely inside those deleted legacy parsers are now retired.
