# MTG Engine Invariants (`ENGINE_INVARIANTS.md`)

This document defines the architectural, rules, and engineering invariants of the Magic: The Gathering engine in `src/lib/magic/`. New compiler passes, runtime modules, UI components, AI heuristics, and tests must uphold them.

Each invariant is a rule, not a description of the current code. Where the code doesn't yet meet one, a **Not yet enforced** note names the known gap. Don't widen a gap; close it when you touch that code. Gaps were last checked against the code on 2026-11-12 (see [`audits/`](./audits/README.md)).

Identifiers are from `ir.ts`, `types.ts` and `runtime/`; CR numbers are from [`src/lib/rules.txt`](../../rules.txt).

---

## 1. The IR Wall: Complete Separation of Cards and Runtime

> **If it's a rule, it lives in the IR (`ir.ts`).** The runtime engine (`engine.ts`, `runtime/*.ts`, `ai.ts`, `ArenaTable.svelte`) must have zero awareness of specific cards or raw English Oracle text.

1. **Zero Runtime `oracleText` Reads (`oracleTextRead = 0`)**
   - Only `src/lib/magic/compiler/` may read `card.oracleText` or parse rules text.
   - Once a card is compiled via `compileCard(card): CardDefinition`, all runtime systems (layers, replacements, triggers, costs, effects, legality checks, AI, and UI) operate on the typed IR in `ir.ts`.
   - The ratchet (`architecture.test.ts`) enforces this for `oracleText` in runtime files. It exempts `compiler/`, `oracle.ts`, `precons.ts`, `scryfall.ts`, `search.ts`, `types.ts` and tests, and doesn't scan `.svelte` files.
   - **Not yet enforced:**
     - `runtime/layers.ts` regex-scans the text of unsupported activated abilities (`ab.text`) for "gains [keyword]" and "your opponents control lose [keyword]". It turns the latter into an always-on static: Shadowspear, Arcane Lighthouse and Bonds of Mortality strip keywords continuously instead of on activation. The ratchet misses this because it only looks for `oracleText`.
     - Runtime and UI code still read `card.typeLine` strings in many places (`engine.ts`, `runtime/zones.ts`, `runtime/choices.ts`, `runtime/effects.ts`, `ArenaTable.svelte`) instead of evaluated types.
     - `oracle.ts` reads `oracleText` and `typeLine` outside `compiler/`.
2. **Zero Card-Name Dispatch (`cardNameComparison = 0`)**
   - No runtime branch, cost check, trigger check, layer rule, replacement effect, mana check, or AI heuristic may branch on `card.name === '...'`.
   - Every card mechanic must be represented as a general IR construct: an `AbilityDef`, `StaticDef` (including `{ k: 'ruleModifier', rule: RuleModKind }`), `ReplacementDef`, `TriggerDef`, `EffectStep` or `CostDef`.
   - Card names are compared at runtime **only** when a game rule semantically compares names:
     - The Legend Rule (`CR 704.5j`) comparing two legendary permanents' evaluated names.
     - Effects or filters that explicitly reference a name: `ObjectFilter.named`, "Partner with [name]" (`CR 702.124j`), "cards named ~".
   - **Not yet enforced:** deck-construction exceptions are name tables in `scryfall.ts` (`MULTI_COPY_CARDS`, `CAPPED_COPY_CARDS`), and `scryfall.ts` regex-scans `oracleText` for commander and partner text. There is no IR deck-limit property yet.
3. **Rename Invariance (The Synthetic-Card Litmus Test)**
   - Replacing a card's name with an invented name (e.g. `"Glimmerfen Overseer"`) and substituting its self-references in Oracle text must produce an **identical** `CardDefinition` (modulo `name`) and **identical** runtime behavior.
   - Every bug fix and engine feature must be verified with both the canonical printed card and a synthetic card bearing an invented name.
4. **Pure, Context-Free Compilation**
   - `compileCard(card)` is a pure, deterministic function of the printed card fields (`name`, `manaCost`, `typeLine`, `oracleText`, `power`, `toughness`, `loyalty`, `colors`, `backFace`) and `COMPILER_VERSION`.
   - Compilation never reads `GameState`, commander color identity, or player state. Context-dependent quantities compile to symbolic IR resolved at runtime: `Amount` for numbers ("power equal to the number of Elves you control") and `EffectParams.manaChoice` (`'any' | 'commanderIdentity' | 'opponentLandColors' | ManaColor[]`) for mana colors.
   - Bump `COMPILER_VERSION` (`compiler/index.ts`) whenever the IR produced for the same text could change.
5. **Honest Support Surface (No Silent Drops)**
   - The compiler never silently ignores a clause. Anything it can't compile, or the runtime can't run, becomes an `UnsupportedAbility` (`{ kind: 'unsupported', reason: UnsupportedReason, text, span, unparsed }`) in `FaceDefinition.abilities`. `CardDefinition.fullySupported` is false and `cardSupportReport` (`compiler/support.ts`) lists it, so deck validation and the UI surface it.
   - A keyword that stands for several abilities is only fully supported if all of them are. Example: "Partner with [name]" compiles to the `partner` keyword plus an unsupported triggered ability for its search (`CR 702.124j`).
   - Every keyword in `IMPLEMENTED_KEYWORDS` (`compiler/card.ts`) must have tests registered in `runtime/keywords-coverage-guard.test.ts`.

---

## 2. Evaluated Characteristics Over Printed Card Data (`CR 613`)

1. **Always Read Evaluated Characteristics on the Battlefield**
   - Runtime code must **never** read `perm.card.power`, `perm.card.toughness`, `perm.card.typeLine`, `perm.card.colors`, or `compileCard(perm.card)` abilities directly for a battlefield permanent without evaluating layers via `evaluatePermanent(state, perm)`.
2. **Strict CR 613 Layer Ordering, Timestamps & Dependencies**
   - Continuous effects are evaluated in layer order (`1a` copiable values -> `1b` face-down -> `2` control -> `3` text -> `4` type -> `5` color -> `6` abilities -> `7a` CDAs -> `7b` P/T setting -> `7c` P/T modification & counters -> `7d` P/T switching).
   - Within each layer/sublayer, effects apply in dependency order (`CR 613.8`, e.g. *Blood Moon* before *Urborg*) and then timestamp order (`CR 613.7`).
   - An Aura, Equipment, or Fortification receives a new timestamp each time it becomes attached to an object (`CR 613.7e`).
   - **Not yet enforced:**
     - `runtime/layers.ts` evaluates layers 1, 4, 5, 6 and 7a–7d. Control changes (layer 2) move the permanent between battlefields (`transferBattlefieldControl`), and text-changing effects (layer 3, `CR 612`) are unimplemented.
     - There is no general `CR 613.8` dependency system: layer 4 runs three fixed sub-passes (attached types, type overwrites, additive types and colors) and then timestamps.
3. **Ability-Loss & Cross-Layer Persistence (`CR 613.1f, 613.6, 708.2a`)**
   - If `evaluatePermanent(state, perm).losesAllAbilities` is true (e.g. *Humility*, *Darksteel Mutation*, *Song of the Dryads* per `CR 305.7`) or `perm.isFaceDown` is true (`CR 708.2a`), the permanent's printed triggered, activated, static, and replacement abilities do not function, unless the continuous effect began applying in an earlier layer (`CR 613.6`). Example: Changeling's creature types are added in layer 4 and survive layer-6 ability loss.
   - **Not yet enforced:** temporary keyword grants in `CardInstance.grantedKeywords` carry no timestamp, so a later "loses all abilities" effect doesn't strip them in timestamp order (`CR 613.7`).
4. **Layer 1 Copiable Values vs Layers 2–7d (`CR 707.2`)**
   - Copy effects (*Clone*) set `perm.copiableCard` (layer 1) and **never** overwrite the physical card's printed `perm.card`.
   - Copying an object copies only layer-1 characteristics (printed values + copy effects + face-down status + "as ~ enters" copiable choices), never counters, damage, tapped status, attached objects, or layer 2–7d effects.
5. **All-Zone Characteristic-Defining Abilities (`CR 604.3, 208.2a, 702.73a`)**
   - Characteristic-defining abilities (Changeling `CR 702.73a`, Devoid `CR 702.114a`, and `*/*` P/T CDAs `CR 208.2a`) function in **all zones** (`hand`, `library`, `graveyard`, `exile`, `command`, `stack`, and `battlefield`).
   - **Not yet enforced:**
     - Devoid is unimplemented (`keyword_not_implemented`).
     - Off-battlefield Changeling works in `runtime/objectFilter.ts` and layer breakdowns. The audit found it missing from library-search matching (`oracle.ts`), layer-7 graveyard subtype counts, and trigger subject matching (`runtime/triggers.ts`).
6. **Unclamped Signed Characteristics vs Action Clamping (`CR 107.1b, 208.5`)**
   - Evaluated power and toughness can be negative during layer calculation (so a `1/3` with `-3/-0` and `+2/+0` has power `0`, not `2`). Clamping to `0` happens only when an action uses the number for combat damage assignment (`CR 510.1a`), life gain/loss, token/counter creation, or card draw.
   - Non-creature permanents have no power or toughness (`CR 208.3`), even if P/T is printed on the card (e.g. uncrewed Vehicles or creatures turned into non-creature lands).
   - **Not yet enforced:** `runtime/layers.ts` clamps `effectiveToughness` to 0 during evaluation (only `unclampedToughness` keeps the raw value). Non-creatures report `null` P/T on the layer breakdown, but `0` on `EvaluatedPermanent`.

---

## 3. Single Funnel for Zone Transitions & Object Identity (`CR 400.7`)

1. **Zero Direct Zone Array Mutations (`directZoneMutation = 0`)**
   - Only `src/lib/magic/runtime/zones.ts` may push, pop, splice, or reassign player zone arrays (`library`, `hand`, `battlefield`, `graveyard`, `exile`, `command`). Its entry points include:
     - `moveObject`, the only zone change, which emits exactly one `ZoneChange` event;
     - `placeDeferred`;
     - `shuffleLibrary`, `setZoneOrder` and `rearrangeLibrary`;
     - `transferBattlefieldControl`;
     - `removeFromGame` and `mulliganRedraw`.
   - **Not yet enforced:** `state.stack` isn't managed by `zones.ts`; `engine.ts` and `runtime/effects.ts` push to and splice it directly.
2. **New Object Identity on Every Zone Change (`CR 400.7`)**
   - Whenever an object changes zones, it becomes a new object. It gets a new `objectVersion` and a new `enteredTimestamp`, and transient battlefield state resets: `damageMarked`, `deathtouchDamageMarked`, `tapped`, `counters`, `attachedToId`, `copiableCard`, `isFaceDown`, `transformed`, `usedLoyaltyThisTurn`, `goadedByPlayerIds`, `playableFromExileBy`.
   - **Exception (`CR 400.7d`, `107.3m`):** a permanent spell resolving from `stack` to `battlefield` keeps information about how it was cast (`enteredWithX`, `castViaSuspend`).
   - **Phasing is Not a Zone Change (`CR 702.26d`):** phasing in or out toggles `phasedOut` in place without changing `objectVersion`, firing ETB/LTB triggers, or detaching Auras/Equipment.
   - **Not yet enforced:** `moveObject` does nothing implicitly. Each caller opts in with `bumpVersion`, `newTimestamp` and `leaveBattlefieldReset`, so a call site that omits a flag skips that part. `leaveBattlefieldReset` doesn't reset `summoningSick`.
3. **Owner-Zone & Controller Invariants (`CR 108.4a, 400.3`)**
   - Cards in `hand`, `graveyard`, or `library` are **always** placed in their `ownerId`'s zone (`CR 400.3`), regardless of who controlled the permanent on the battlefield.
   - In any zone other than `battlefield` or `stack`, `controllerId` is reset to `ownerId` (`CR 108.4a`).
   - Putting a card onto the `battlefield` defaults its controller to the **controller of the resolving spell/ability** unless the effect specifies otherwise (`CR 110.2a`).
4. **Zone-Type Legalities (`CR 111.7, 111.8, 304.4, 307.4`)**
   - An `Instant` or `Sorcery` card can never enter the `battlefield`; any instruction to move it there leaves it in its current zone (`CR 304.4 / 307.4`).
   - A token that leaves the `battlefield` ceases to exist as an SBA (`CR 704.5d`) and cannot change zones again before ceasing to exist (`CR 111.8`).
5. **Self-Reference by `instanceId` Only (`CR 201.5`)**
   - Self-references (`~`, "this creature", and `ObjectFilter.other` for "another creature") compare `instanceId` (and `objectVersion` when tracking across time), **never** `card.name` or `card.id`.
   - For display, `~` is shown as the card prints it (`printedText`, `compiler/normalize.ts`). In a granted ability, "this artifact" refers to the object that has the ability, not the granting card.

---

## 4. Simultaneity, Event Bus, Replacements & Look-Back-in-Time (`CR 603.10, 614, 704`)

1. **Replacement Effects Before Mutation (`CR 614.5, 614.15, 616.1`)**
   - Every replaceable game event (zone changes, draws, damage, life gain, counter placement, token creation, untapping) consults the active `ReplacementDef`s **before** mutating state.
   - Self-replacement effects (`CR 614.15`) are chosen first (`CR 616.1a`), then control-changing and copy replacements (`CR 616.1b–c`).
   - Each replacement effect may apply **at most once** to a given event (`CR 614.5`).
   - **Not yet enforced:** there is no single pipeline. `runtime/replace.ts` has per-domain helpers:
     - `resolveZoneChangeReplacements`, `replaceEmptyLibraryDraw`, `cardEntersTapped` and `applySelfEtbReplacements`;
     - `resolveCounterReplacements`;
     - multipliers: `tokenMultiplier`, `counterMultiplier` and `triggerMultiplier`.

     Damage and untap use inline prevention/shield/stun checks rather than `ReplacementDef`s, and `replacementPriorityTier` doesn't model `CR 616.1b` control-changing ETB replacements.
2. **Atomic Simultaneous Batches**
   - Multi-object destruction/exile/sacrifice (*Wrath of God*), combat damage assignment and dealing within a step (`CR 510.2`), multi-token creation (`CR 111.5`), and each pass of the state-based action loop (`CR 704.3`) execute as an atomic batch before triggers are evaluated.
   - In combat damage (`CR 510.2`), all attackers' and blockers' damage is locked in *before* any infect/wither `-1/-1` counters or damage marks are applied.
3. **Leaves-the-Battlefield Look-Back-in-Time (`CR 603.6c, 603.10a`)**
   - Triggers that watch for "dies", "leaves the battlefield", "put into a graveyard from the battlefield", or "sacrificed" evaluate against the **pre-batch board snapshot** (`CR 603.10a`), so permanents leaving the battlefield simultaneously see each other leave.
4. **Last Known Information (LKI) Snapshots (`CR 113.7a, 608.2h, 704.8`)**
   - When an ability is placed on the stack or a permanent leaves the battlefield, the engine records the object's last known information (`StackItem.lkiPower`, `lkiToughness`, `lkiControllerId`, `lkiTypeLine`, and the pre-batch board snapshot).
   - During SBAs, LKI is captured **before** `+1/+1` and `-1/-1` counter annihilation (`CR 704.8`).
   - If an ability's source is no longer in the expected zone when the ability resolves, its characteristics come from LKI (`CR 113.7a`), never from printed `card.power` or `0`.

---

## 5. Priority, Turn Structure, Stack & APNAP Ordering (`CR 101.4, 117, 500–514, 601–608, 703, 704`)

1. **Turn-Based Actions Precede Step Triggers (`CR 703.3`)**
   - At the start of `untap` (phasing + untapping), `draw` (turn-based card draw), `declare_attackers`, `declare_blockers`, `first_strike_damage`, `combat_damage`, and `cleanup` (hand-size discard + damage/end-of-turn clearing), the turn-based action happens **before** any "At the beginning of [step]" triggers are queued.
2. **SBA Loop Stabilization Before Trigger Flush (`CR 704.3`)**
   - Whenever a player would receive priority, `checkStateBasedActions` repeats in a loop until a pass performs zero actions. Only **after** the SBA loop stabilizes are waiting triggers placed on `state.stack`.
3. **APNAP Ordering Everywhere (`CR 101.4, 603.3b`)**
   - Simultaneous triggers controlled by different players are placed on the stack in **Active Player, Non-Active Player (APNAP)** turn order starting from `state.activePlayerIndex` (`CR 603.3b`).
   - Simultaneous multi-player instructions ("Each player draws / discards / sacrifices...") iterate players in APNAP order (`CR 101.4`).
4. **Priority & Mana Pool Emptying (`CR 106.4, 500.2, 500.5`)**
   - Every step in which players receive priority (`upkeep`, `draw`, `main1`, `begin_combat`, `declare_attackers`, `declare_blockers`, `first_strike_damage`, `combat_damage`, `end_combat`, `main2`, `end_step`) waits until `state.stack.length === 0` and all active players pass priority in succession before advancing (`CR 500.2`).
   - Special actions (`play_land`, `suspend_card`) require priority and clear `passedPriorityPlayerIds` (`CR 117.3c`).
   - Every player's mana pool empties at the end of **every** step and phase (`CR 106.4 / 500.5`).
5. **Stack Resolution Lifecycle & Target Re-Validation (`CR 608.2b, 608.2c, 608.2n, 725.1b`)**
   - A resolving `StackItem` remains on `state.stack` until all of its `EffectStep` instructions and any interactive prompts have finished (`CR 608.2n`), ensuring "End the turn" (`CR 725.1b`) exiles the resolving spell itself.
   - On resolution, targets are re-checked against their recorded `targetObjectVersions`, zone, controller, type/subtype filter, and current Hexproof/Shroud/Protection (`CR 608.2b`). If all targets are now illegal, the spell/ability doesn't resolve; if at least one target remains legal, it resolves and illegal targets are ignored.
6. **Casting Choices Are Explicit (`CR 601.2b`)**
   - How a spell is cast (normal or an alternative cost such as Overload, `castMode` on the `cast_spell` action and `StackItem`) is an explicit choice sent by the client or bot. It is never inferred from another field such as `xValue`.

---

## 6. Unified Choice Protocol & Resumable Execution

1. **Six Canonical Choice Shapes (`runtime/choices.ts`)**
   - Every player prompt is described by one of the 6 `ChoiceRequest` variants (`yesNo`, `chooseObjects`, `chooseMode`, `chooseNumber`, `orderObjects`, `chooseReplacement`) and answered via `{ type: 'choice', promptId, answer }`.
   - No card-specific prompt kinds or action payloads may be added to `types.ts`.
2. **No Silent Arbitrary Fallbacks for Human Decisions**
   - Whenever the rules require a player choice, a human player with more than one legal option (or a `yesNo` choice) must receive a `PendingPrompt`, never an automatic `.slice(0, count)` fallback. This covers:
     - the Legend Rule keep (`CR 704.5j`);
     - sacrifice (`CR 701.21`);
     - non-random discard (`CR 701.9`);
     - proliferate (`CR 701.34`);
     - replacement ordering (`CR 616.1`);
     - the Commander zone choice (`CR 903.9a/b`).
3. **True Pause-and-Resume Execution**
   - When an effect or cost needs a human decision, execution pauses and stores a continuation on `GameState`, so later steps run only **after** the player submits `{ type: 'choice' }`.
   - **Not yet enforced:**
     - Effects pause (`StackItem.effectResume`) only for the prompting verbs: sacrifice, discard, proliferate, mana color choice, and some move/dig/scry/search steps.
     - An optional "you may" step that isn't a leading choice for the controller is compiled as unsupported (`compiler/interpretable.ts`: "the interpreter can't pause mid-ability").
     - Costs don't pause mid-payment: `planCosts` (`runtime/costs.ts`) asks its question before anything is paid, and the action is resubmitted with the answer.

---

## 7. Serialization, Determinism, Caching & Ratchet Enforcement

1. **Pure JSON-Serializable `GameState`**
   - `GameState` must be 100% plain JSON (`number`, `string`, `boolean`, `null`, arrays, plain objects): no functions, closures, class instances, `Map`, `Set`, or `WeakMap`.
   - `JSON.parse(JSON.stringify(state))` at any point in a game (including mid-prompt) must round-trip losslessly and play on identically.
2. **Seeded PRNG & Deterministic IDs**
   - All randomness (shuffling, starting player selection, `atRandom` discard/sacrifice/target selection) must draw from `nextRandom(state)` (`state.rngState`, `runtime/random.ts`), never `Math.random()`.
   - Runtime ID generation (`uid(prefix, state)`) uses the per-state counter `state.nextUid` salted with `state.idSalt`, never `Math.random()` or `Date.now()`.
   - Given the same `rngState` seed and sequence of actions, game execution is strictly deterministic.
   - **Not yet enforced:** wall-clock times are still written into state (`GameLogEntry.timestamp`, `StackItem.createdAt`, `turnStartedAt`, `priorityUpdatedAt`), so two replays aren't byte-identical without stripping them. Game logic must never branch on these fields.
3. **Layer Evaluation Cache Equivalence (`runtime/layerCache.ts`)**
   - Any cached layer query must return results identical to an uncached recomputation. Enforced by:
     - `runtime/layerCache.test.ts`, `layerCache.scope.test.ts` and `layerCache.phase6d.test.ts`;
     - `layers.snapshot.test.ts`;
     - the `MAGIC_LAYER_CACHE_CHECK=1` debug mode.
   - See [`ENGINE_ARCHITECTURE_PLAN.md`](./ENGINE_ARCHITECTURE_PLAN.md) §2.4 for how the cache is keyed.
4. **Monotonic Architecture Ratchet (`architecture.test.ts` & `architecture-allowances.json`)**
   - The five ratchet categories (`cardNameComparison`, `oracleTextRead`, `directZoneMutation`, `legacyTextHelperCall`, `cardNameInCode`) are at **`0`** in every scanned file and may only go down.
   - The ratchet doesn't scan `compiler/`, `oracle.ts`, `precons.ts`, `scryfall.ts`, `search.ts`, `types.ts`, tests or `.svelte` files for the first four. `cardNameInCode` checks precon card names only. A `0` is therefore not proof that §1 holds everywhere; see the gaps listed there.
