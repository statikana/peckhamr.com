# MTG Engine Invariants (`ENGINE_INVARIANTS.md`)

This document defines the non-negotiable architectural, rules, and engineering invariants of the Magic: The Gathering engine in `src/lib/magic/`. Every compiler pass, runtime module, UI component, AI heuristic, and test suite must uphold these invariants.

---

## 1. The IR Wall: Complete Separation of Cards and Runtime

> **If it's a rule, it lives in the IR (`ir.ts`).** The runtime engine (`engine.ts`, `runtime/*.ts`, `ai.ts`, `ArenaTable.svelte`) must have zero awareness of specific cards or raw English Oracle text.

1. **Zero Runtime `oracleText` Reads (`oracleTextRead = 0`)**
   - Only `src/lib/magic/compiler/` may read `card.oracleText` or parse `card.typeLine` strings.
   - Once a card is compiled via `compileCard(card): CardDef`, all runtime systems (layers, replacements, triggers, costs, effects, legality checks, AI, and UI) operate exclusively on the typed IR in `src/lib/magic/ir.ts`.
2. **Zero Card-Name Dispatch (`cardNameComparison = 0`)**
   - No runtime branch, cost check, trigger check, layer rule, replacement effect, mana check, or AI heuristic may branch on `card.name === '...'` (not for *Laboratory Maniac*, *Reliquary Tower*, *Propaganda*, *Urborg, Tomb of Yawgmoth*, *Blood Moon*, *Opalescence*, *Obeka, Brute Chronologist*, *Treasure*, or *Seven Dwarves*).
   - Every card mechanic must be represented as a general IR construct (`StaticDef`, `ReplacementDef`, `TriggerDef`, `EffectStep`, `CostTerm`, `RuleModifier`, or deck-limit property).
   - Card names are compared at runtime **only** when a game rule semantically compares names:
     - The Legend Rule (`CR 704.5j`) comparing two legendary permanents' evaluated names.
     - Effects or filters that explicitly reference a name (`named?: string` in `ObjectFilter`, `"Partner with [Name]"` `CR 702.124f`, `"cards named ~"`).
3. **Rename Invariance (The Synthetic-Card Litmus Test)**
   - Replacing a card's name with an invented name (e.g. `"Glimmerfen Overseer"`) and substituting its self-references in Oracle text must produce an **identical** `CardDef` (modulo `name`) and **identical** runtime behavior.
   - Every bug fix and engine feature must be verified with both the canonical printed card and a synthetic card bearing an invented name.
4. **Pure, Context-Free Compilation**
   - `compileCard(card)` is a pure, deterministic function of the printed card fields (`name`, `manaCost`, `typeLine`, `oracleText`, `power`, `toughness`, `loyalty`, `colorIndicator`, `cardFaces`) and `COMPILER_VERSION`.
   - Compilation never reads `GameState`, commander color identity, or player state. Context-dependent quantities (e.g. `"one mana of any color in your commander's color identity"`, `"power equal to the number of Elves you control"`) compile to symbolic `ColorExpr` / `QuantityExpr` nodes resolved at runtime.
5. **Honest Support Surface (No Silent Drops)**
   - The compiler never silently ignores an unparsed clause. Any sentence or clause that fails to parse emits a `CompileDiagnostic` and populates `CardDef.unsupported: string[]` so deck validation and the UI can surface unsupported abilities transparently.

---

## 2. Evaluated Characteristics Over Printed Card Data (`CR 613`)

1. **Always Read Evaluated Characteristics on the Battlefield**
   - Runtime code must **never** read `perm.card.power`, `perm.card.toughness`, `perm.card.typeLine`, `perm.card.colors`, or `compileCard(perm.card).abilities` directly for a battlefield permanent without evaluating Layers 1–7d via `evaluatePermanent(state, perm)`.
2. **Strict CR 613 Layer Ordering, Timestamps & Dependencies**
   - Continuous effects are evaluated strictly in layer order (`1a` copiable values -> `1b` face-down -> `2` control -> `3` text -> `4` type -> `5` color -> `6` abilities -> `7a` CDAs -> `7b` P/T setting -> `7c` P/T modification & counters -> `7d` P/T switching).
   - Within each layer/sublayer, effects apply in dependency order (`CR 613.8`, e.g. *Blood Moon* before *Urborg*) and then timestamp order (`CR 613.7`).
   - Attaching an Aura, Equipment, or Fortification to a different object assigns a fresh timestamp to that attachment (`CR 613.7e`).
3. **Ability-Loss & Cross-Layer Persistence (`CR 613.1f, 613.6, 708.2a`)**
   - If `evaluatePermanent(state, perm).losesAllAbilities` is true (e.g. *Humility*, *Darksteel Mutation*, *Song of the Dryads* per `CR 305.7`) or `perm.isFaceDown` is true (`CR 708.2a`), the permanent's printed triggered, activated, static, and replacement abilities do not function—unless the continuous effect began applying in an earlier layer (`CR 613.6`).
4. **Layer 1 Copiable Values vs Layers 2–7d (`CR 707.2`)**
   - Copy effects (*Clone*) set `perm.copiableCard` (Layer 1) and **never** overwrite the physical card's printed `perm.card`.
   - Copying an object copies only Layer 1 characteristics (printed values + copy effects + face-down status + `"as ~ enters"` copiable choices), never counters, damage, tapped status, attached objects, or Layers 2–7d effects.
5. **All-Zone Characteristic-Defining Abilities (`CR 604.3, 208.2a, 702.73a`)**
   - Characteristic-defining abilities (such as Changeling `CR 702.73a`, Devoid, and `*/*` P/T CDAs `CR 208.2a`) function in **all zones** (`hand`, `library`, `graveyard`, `exile`, `command`, `stack`, and `battlefield`).
6. **Unclamped Signed Characteristics vs Action Clamping (`CR 107.1b, 208.5`)**
   - Evaluated power and toughness can be negative during layer calculation (so a `1/3` with `-3/-0` and `+2/+0` has power `0`, not `2`). Clamping to `0` happens only when an action uses the number for combat damage assignment (`CR 510.1a`), life gain/loss, token/counter creation, or card draw.
   - Non-creature permanents have `effectivePower: null` and `effectiveToughness: null` (`CR 208.3`), even if P/T is printed on the card (e.g. uncrewed Vehicles or creatures turned into non-creature lands).

---

## 3. Single Funnel for Zone Transitions & Object Identity (`CR 400.7`)

1. **Zero Direct Zone Array Mutations (`directZoneMutation = 0`)**
   - Only `src/lib/magic/runtime/zones.ts` (`moveObject`, `reorderZone`, `createToken`, `transferBattlefieldControl`) may push, pop, splice, or reassign zone arrays (`library`, `hand`, `battlefield`, `graveyard`, `exile`, `command`, `stack`).
2. **New Object Identity on Every Zone Change (`CR 400.7`)**
   - Whenever an object changes zones, `moveObject` increments `objectVersion`, assigns a new `timestamp`, and resets all transient battlefield state (`damageMarked`, `deathtouchDamageMarked`, `tapped`, `summoningSick`, `attachedToId`, `copiableCard`, `isFaceDown`, `transformed`, `usedLoyaltyThisTurn`, `goadedByPlayerIds`, `playableFromExileBy`).
   - **Exception (`CR 400.7b`):** A permanent spell resolving from `stack` to `battlefield` retains choices made on cast (`enteredWithX`, `castViaSuspend`) and increments `objectVersion` rather than resetting to `1`.
   - **Phasing is Not a Zone Change (`CR 702.26d`):** Phasing in or out toggles `phasedOut` in place without changing `objectVersion`, firing ETB/LTB triggers, or detaching Auras/Equipment.
3. **Owner-Zone & Controller Invariants (`CR 108.4a, 400.3`)**
   - Cards in `hand`, `graveyard`, or `library` are **always** placed in their `ownerId`'s zone (`CR 400.3`), regardless of who controlled the permanent on the battlefield.
   - In any zone other than `battlefield` or `stack`, `controllerId` is reset to `ownerId` (`CR 108.4a`).
   - Putting a card onto the `battlefield` defaults its controller to the **controller of the resolving spell/ability** unless the effect specifies otherwise (`CR 110.2a`).
4. **Zone-Type Legalities (`CR 111.7, 111.8, 304.4, 307.4`)**
   - An `Instant` or `Sorcery` card can never enter the `battlefield`; any instruction to move it there leaves it in its current zone (`CR 304.4 / 307.4`).
   - A token that leaves the `battlefield` ceases to exist as an SBA (`CR 704.5d`) and cannot change zones again before ceasing to exist (`CR 111.8`).
5. **Self-Reference by `instanceId` Only (`CR 201.5`)**
   - Self-references (`~`, `"this creature"`, `excludeSelf` for `"another creature"`) compare `instanceId` (and `objectVersion` when tracking across time), **never** `card.name` or `card.id`.

---

## 4. Simultaneity, Event Bus, Replacements & Look-Back-in-Time (`CR 603.10, 614, 704`)

1. **Single Replacement Pipeline (`CR 614.5, 614.16, 616.1`)**
   - Every replaceable game event (`moveZone`, `draw`, `damage`, `gainLife`, `addCounters`, `createTokens`, `untap`) passes through `applyReplacements` **before** mutating state.
   - Self-replacement effects apply first (`CR 614.16`), followed by control-changing and copy replacements (`CR 616.1b–c`).
   - Each replacement effect (`id`) may apply **at most once** to a given event (`CR 614.5`).
2. **Atomic Simultaneous Batches**
   - Multi-object destruction/exile/sacrifice (*Wrath of God*), combat damage assignment and dealing within a step (`CR 510.2`), multi-token creation (`CR 111.5`), and each pass of the State-Based Action loop (`CR 704.3`) execute as an atomic batch before triggers are evaluated.
   - In combat damage (`CR 510.2`), all attackers' and blockers' powers/damage packets are locked in *before* any Infect `-1/-1` counters or damage marks are applied.
3. **Leaves-the-Battlefield Look-Back-in-Time (`CR 603.6c, 603.10a`)**
   - Triggers that watch for `"dies"`, `"leaves the battlefield"`, `"put into a graveyard from the battlefield"`, or `"sacrificed"` evaluate against the **pre-batch board snapshot** (`CR 603.10a`), so permanents leaving the battlefield simultaneously see each other leave.
4. **Last Known Information (LKI) Snapshots (`CR 113.7a, 608.2h, 704.8`)**
   - When an ability is placed on the stack or a permanent leaves the battlefield, the engine snapshots the object's evaluated LKI (`power`, `toughness`, `colors`, `types`, `subtypes`, `keywords`, `counters`, `controllerId`).
   - During SBAs, LKI is captured **before** `+1/+1` and `-1/-1` counter annihilation (`CR 704.8`).
   - If an ability's source is no longer in the expected zone when the ability resolves, `sourceCharacteristic` reads the LKI snapshot (`CR 113.7a`), never falling back to printed `card.power` or `0`.

---

## 5. Priority, Turn Structure, Stack & APNAP Ordering (`CR 101.4, 117, 500–514, 601–608, 703, 704`)

1. **Turn-Based Actions Precede Step Triggers (`CR 703.3`)**
   - At the start of `untap` (phasing + untapping), `draw` (turn-based card draw), `declare_attackers`, `declare_blockers`, `combat_damage`, and `cleanup` (hand-size discard + damage/EOT clearing), the turn-based action happens **before** any `"At the beginning of [step]"` triggers are queued.
2. **SBA Loop Stabilization Before Trigger Flush (`CR 704.3`)**
   - Whenever a player would receive priority, `checkStateBasedActions` repeats in a loop until a pass performs zero actions. Only **after** the SBA loop stabilizes are waiting triggers placed on `state.stack`.
3. **APNAP Ordering Everywhere (`CR 101.4, 603.3b`)**
   - Simultaneous triggers controlled by different players are placed on the stack in **Active Player, Non-Active Player (APNAP)** turn order starting from `state.activePlayerIndex` (`CR 603.3b`).
   - Simultaneous multi-player instructions (`"Each player draws / discards / sacrifices..."`) iterate players in APNAP order (`CR 101.4`).
4. **Priority & Mana Pool Emptying (`CR 106.4, 500.2, 500.4`)**
   - Every step in which players receive priority (`upkeep`, `draw`, `main1`, `begin_combat`, `declare_attackers`, `declare_blockers`, `combat_damage`, `end_combat`, `main2`, `end_step`) waits until `state.stack.length === 0` and all active players pass priority in succession before advancing (`CR 500.2`).
   - Special actions (`play_land`, `suspend_card`) require priority and clear `passedPriorityPlayerIds` (`CR 117.3c`).
   - Every player's mana pool empties at the end of **every** step and phase (`CR 106.4 / 500.4`).
5. **Stack Resolution Lifecycle & Target Re-Validation (`CR 608.2b, 608.2c, 608.2n, 725.1b`)**
   - A resolving `StackItem` remains on `state.stack` until all of its `EffectStep` instructions and any interactive prompts have finished (`CR 608.2n`), ensuring `"End the turn"` (`CR 725.1b`) exiles the resolving spell itself.
   - On resolution, targets are re-checked against their recorded `targetObjectVersion`, zone, controller, type/subtype filter, and current Hexproof/Shroud/Protection (`CR 608.2b`). If all targets are now illegal, the spell/ability fizzles; if at least one target remains legal, it resolves and illegal targets are ignored.

---

## 6. Unified Choice Protocol & Resumable Execution

1. **Six Canonical Choice Shapes (`runtime/choices.ts`)**
   - Every player prompt is described by one of the 6 `ChoiceRequest` variants (`yesNo`, `chooseObjects`, `chooseMode`, `chooseNumber`, `orderObjects`, `chooseReplacement`) and answered via `{ type: 'choice', promptId, answer }`.
   - No card-specific prompt kinds or action payloads (e.g. `obeka_end_turn_choice`) may be added to `types.ts`.
2. **No Silent Arbitrary Fallbacks for Human Decisions**
   - Whenever the rules require a player choice (Legend Rule keep `CR 704.5j`, sacrifice `CR 701.19`, non-random discard `CR 701.8`, proliferate `CR 701.31`, replacement ordering `CR 616.1`, Commander zone choice `CR 903.9a/b`), a human player with $>1$ legal option (or a `yesNo` choice) must receive a `PendingPrompt`—never an automatic `.slice(0, count)` fallback.
3. **True Pause-and-Resume Execution**
   - When an `EffectStep` or `CostTerm` enqueues a `PendingPrompt` for a human player, the interpreter pauses immediately and stores the continuation frame on `GameState` so subsequent steps execute only **after** the player submits `{ type: 'choice' }`.

---

## 7. Serialization, Determinism, Caching & Ratchet Enforcement

1. **Pure JSON-Serializable `GameState`**
   - `GameState` must be 100% plain JSON (`number`, `string`, `boolean`, `null`, arrays, plain objects)—no functions, closures, class instances, `Map`, `Set`, or `WeakMap`.
   - `JSON.parse(JSON.stringify(state))` at any point in a game (including mid-prompt) must round-trip losslessly and play on identically.
2. **Seeded PRNG & Deterministic IDs**
   - All randomness (shuffling, starting player selection, `atRandom` discard/sacrifice/target selection) must draw from `nextRandom(state)` (`state.rngState`), never `Math.random()`.
   - Runtime ID generation (`uid(prefix, state)`) uses the deterministic per-state counter `state.nextUid`, never `Math.random()` or `Date.now()`.
   - Given the same `rngSeed` and sequence of `GameActionPayload` inputs, game execution and generated state are strictly deterministic.
3. **Layer Evaluation Cache Equivalence (`runtime/layerCache.ts`)**
   - `evaluatePermanent(state, perm)` caches layer breakdowns inside explicit `withStableLayerInputs(state, fn)` scopes keyed by a dynamic fingerprint of battlefield/stack/command state, attachments, counters, and timestamps.
   - Any cached query must return results identical to an uncached recomputation (enforced by `runtime/layers-cache.test.ts`).
4. **Monotonic Architecture Ratchet (`architecture.test.ts` & `architecture-allowances.json`)**
   - All five ratchet categories in `src/lib/magic/architecture-allowances.json`—`cardNameComparison`, `oracleTextRead`, `directZoneMutation`, `legacyTextHelperCall`, and `cardNameInCode`—are at **`0`** across every runtime, compiler, and `oracle.ts` module and must remain **`0`**.
