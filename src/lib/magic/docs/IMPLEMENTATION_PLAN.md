# MTG Engine: Revised Implementation Plan (v2)

This plan replaces the earlier "Comprehensive Codebase Audit & Unified Rules Engine Refactoring Plan".
That plan's overall direction (move card-name hardcodes into the grammar-driven `CardRuleTree`)
still holds. What changes here is the **order** of work, plus **three live bugs** it missed and
several claims that were wrong.

Files: `src/lib/magic/{engine.ts, ruleTree.ts, oracle.ts, types.ts, ai.ts, magic.test.ts}`,
`src/lib/magic/ArenaTable.svelte`.
Test command: `node --test src/lib/magic/magic.test.ts` (baseline: 57/57 passing).

Line numbers are from commit `d991e75` plus the current working tree. Re-locate code by function
name before editing.

---

## Ground rules (apply to every stage)

1. **Write a failing test first.** Before every fix, add a test to `magic.test.ts` that fails on the
   current code, then make it pass. The suite passes today while Felidar Sovereign wins at 20 life,
   so "57/57 green" is not evidence of correctness.
2. **Make the generic path correct before deleting a hardcode.** For several cards, the hardcoded
   branch is the *correct* behaviour and the generic parser is wrong (see Bugs 1 and 2). Delete a
   hardcoded branch only after a test proves the generic path handles that card, both for the real
   card and for a synthetic card with a new name made via `makeTestCard`.
3. **Ship one stage at a time** and run the full suite after each one. Don't combine stages into a
   single refactor.
4. **Don't change user-facing behaviour** beyond the fixes listed here.

---

## Stage A: Live bug fixes (small, do first)

### Bug A1: Felidar Sovereign wins at any life total (game-breaking)

- **Cause:** `parseTriggeredEffects` (`oracle.ts:1178`) takes everything after the first comma
  and passes it to `parseSpellOrAbilityEffects`. For
  `"At the beginning of your upkeep, if you have 40 or more life, you win the game."` the
  effect clause is `"if you have 40 or more life, you win the game."`. The condition is dropped
  and the result is `[{kind:'win_the_game'}]`. `runBeginningOfTurn` (`engine.ts:800`) then runs it
  through `executeTriggeredCardEffects`.
- **Repro (verified):** put Felidar Sovereign on P1's battlefield, set P1 life to 20, call
  `runBeginningOfTurn(state)`. Result: `status === 'finished'`, `winnerPlayerId === p1`.
- **Fix:**
  - In `parseTriggeredEffects`, detect an intervening-if clause (`/^if\b/i` at the start of the
    effect clause). Split it on the next comma into `condition` and `effect`.
  - Add `interveningIf?: TriggerCondition` to the parsed trigger result. For now this can be a new
    return shape or a sidecar field; keep `ParsedEffect[]` callers working.
  - Start with a small recognised set: `you have N or more life`,
    `you control N or more <type>s`, `<name> is in your graveyard with N or more creature cards above it`.
  - **If a condition is present but not recognised, return no effects.** Never execute the effect
    unconditionally.
  - Check the condition when the trigger fires **and again on resolution** (CR 603.4).
- **Tests:** Felidar at 20 life does not win. Felidar at 40 life wins. A synthetic
  `"if you have 40 or more life, draw a card"` creature draws only at 40+. An unrecognised
  `"if <nonsense>, you win the game"` does nothing.
- After this works, **remove the hardcoded Felidar branch** at `engine.ts:796` so the card isn't
  handled twice.

### Bug A2: "Your end step" triggers fire on every player's end step

- **Cause:** `enterEndStep` (`engine.ts:3355`) loops over every player's battlefield and pushes any
  `parseTriggeredEffects(perm.card, 'end_step')` result. It never checks the trigger's wording
  against the active player. Separately, the hardcoded Atraxa branch also runs, so on its
  controller's turn Atraxa proliferates twice: once immediately, once from the stack.
- **Repro (verified):** P1 controls Atraxa. `enterEndStep(state, state.players[1])` puts Atraxa's
  trigger on the stack during P2's end step. `enterEndStep(state, state.players[0])` adds one
  counter immediately and also stacks a proliferate trigger.
- **Fix:**
  - Make `parseTriggeredEffects` (or a new wrapper) report the trigger **scope**:
    `your end step` / `your upkeep` → controller's turn only; `the end step` / `each end step` /
    `each upkeep` → every turn; `each opponent's upkeep` → opponents' turns only.
  - In `enterEndStep`, fire a trigger only when its scope matches the active player.
  - Skip permanents where `permanentHasLostAllAbilities(perm, state).lost` (the generic end-step
    path currently doesn't check this).
  - Delete the hardcoded Atraxa branch (`engine.ts:3365-3375`).
- **Tests:** Atraxa proliferates exactly once (after the stack resolves) on its controller's end
  step, does nothing on an opponent's end step, and does nothing under Humility. A synthetic
  `"At the beginning of each end step, ..."` card fires on every player's turn.

### Bug A3: Overloaded Cyclonic Rift costs `{1}{U}` instead of `{6}{U}`

- **Cause:** `getSpellCostRequirement` (`engine.ts:438`) skips the rule tree for Rift with
  `xValue >= 1` and falls back to legacy code. That code calls
  `parseManaCost(inst.card.manaCost, …)`, which uses the **normal** cost.
- **Repro (verified):** `getSpellCostRequirement(p1, riftInHand, state, 1)` returns
  `generic: 1, U: 1`.
- **Fix:** if `xValue >= 1` and `getCardRuleTree(card).actions` has a `cast.overload` node, call
  `evaluateActionNode(state, playerId, inst, 'cast.overload', 0)` and use its cost. Check that
  `cast.overload` really compiles Rift's `Overload {6}{U}`; add a unit test for that.
- **Do not delete** the fallback block at `engine.ts:445-481` in this stage. It isn't dead code: it
  runs for overload and for any card without a `cast.normal` node. Stage C removes it once every
  path is covered.
- **Tests:** an overloaded Rift requires `{6}{U}` and a normal Rift `{1}{U}`. A synthetic card with
  `Overload {4}{R}` costs `{4}{R}` when overloaded.

### Bug A4: Upkeep triggers skip the stack

- `runBeginningOfTurn` runs upkeep triggers immediately via `executeTriggeredCardEffects`, while
  end-step triggers go on the stack. That violates CR 603.3: players get no chance to respond.
- **Fix:** push upkeep triggers onto the stack the same way `enterEndStep` does, using the
  scope and intervening-if from A1 and A2.
- **Check before changing:** turn and priority flow has to stop in upkeep while the stack is
  non-empty. Look at how `enterEndStep` gives priority and do the same. If that turns out to be
  too large a change, defer A4 to Stage C and note it. Don't half-implement it.

---

## Stage B: Correctness fixes that need no new grammar

### B1. Stack spells going to the wrong graveyard (CR 400.3)
- `counter_target_spell` (around `engine.ts:2765`) and `endTheTurnImmediately` (`engine.ts:3314`)
  look up `owner` by `controllerId`. That lookup decides **both** the destination graveyard **and**
  the commander check (`owner.commanderNames[...]`, `commanderCastCounts`), so both are wrong when
  the caster isn't the owner. One example is a card cast from exile through Opposition Agent.
- Extract `moveStackSpellToZone(state, stackItem, dest)` using `stackItem.ownerId ?? stackItem.controllerId`
  for the destination graveyard, the commander status and the cast count, and honour
  `checkGraveyardReplacementZone`. Use it in `resolveTopOfStack` (the paths near 2319 and 2496 already
  use `ownerId`, so match them), in `counter_target_spell` and in `endTheTurnImmediately`.
- **Test:** P1 casts P2's exiled card via Opposition Agent, P2 counters it, and the card ends up in
  **P2's** graveyard.

### B2. Board hooks stay active while their source is phased out or has lost its abilities
- `collectActiveBoardHooks` (`ruleTree.ts:601`) checks neither of these. Verified: a phased-out
  Goblin Electromancer still contributes `hook_electromancer`.
- Skip `perm.phasedOut` and `permanentHasLostAllAbilities(perm, state).lost`. Watch for import
  cycles between `ruleTree.ts` and `engine.ts`: if `permanentHasLostAllAbilities` lives in
  `engine.ts`, move it or pass it in.
- Command-zone hooks (eminence) are not affected by phasing or Humility. Leave that branch alone.
- **Tests:** phased-out Electromancer gives no discount. Electromancer under Humility gives no
  discount. The Ur-Dragon in the command zone still gives its discount.

### B3. Counter multipliers
- `add_counters_target` (`engine.ts:3142`) ignores Corpsejack Menace. `add_counters_team` (3121)
  and the code at 3851 check the card **by name**, against the **spell controller's** battlefield.
  The correct check is the **receiving permanent's controller's** battlefield, and it should skip
  sources that have lost their abilities.
- Add a single `addCountersToPermanent(state, perm, type, n)` that reads `hook.counter_multiplier`
  from `collectActiveBoardHooks` (fixed in B2) for the permanent's controller. Route every place that
  adds +1/+1 counters through it. Proliferate adds counters too, so it goes through the helper as
  well.
- Leave the `Fathom Mage` hardcode (3859) until Stage C provides a "counter put on ~" trigger.

### B4. Swords to Plowshares life gain goes to the owner, not the controller
- `engine.ts:3057` gives the life to `found.owner`. The card says "its controller". For now, fix it to
  use the controller of the permanent as it last existed on the battlefield (`lkiPower` is already
  computed before the move). Stage C replaces this with `recipient: 'target_controller'`.

### B5. Lands from search or auto-fetch skip ETB triggers
- `play_land` (`engine.ts:990`) never calls `triggerOnEtb`. It only runs a hardcoded Evolution Sage
  check. `autoFetchBasicLandToBattlefield` (`engine.ts:3778`) also never calls `triggerOnEtb`.
- Add a `triggerOnEtb` call to both. Don't put the Landfall grammar here; that belongs in C2. Just
  make sure every land that enters reaches `triggerOnEtb`.
- **Test:** Evolution Sage proliferates on a played land, a Farseek-fetched land and a
  Path-to-Exile-fetched land. Once C2 lands, swap Evolution Sage for a synthetic Landfall card.

---

## Stage C: Grammar-driven triggers (the original plan's core, re-sequenced)

For each trigger category: (1) add parser support, (2) add tests for the real hardcoded cards and
for a synthetic card, (3) route the engine through the `CardRuleTree` trigger path, (4) **then**
delete the hardcoded branches for those cards.

Suggested order, from least to most risky:

1. **End step / upkeep.** These are already partly generic after Stage A. Handle **Nether Shadow**:
   it triggers *from the graveyard*, so add a graveyard-zone scan for upkeep triggers whose text
   names the card itself (`if ~ is in your graveyard`). Graveyard order matters (CR 404.2), so
   keep the "creature cards above it" logic.
2. **ETB: self, observer and Landfall.** Includes `"Whenever another [nontoken] <Subtype> you control enters"`
   and `"Whenever a land you control enters"`. Then delete the `BESPOKE_ETB_CARDS` entries one at a
   time, each with a passing test.
3. **Spell-cast / Magecraft** (`triggerOnSpellCast`, `engine.ts:3882`). Veyran's trigger doubling
   should read `hook.trigger_multiplier`, not the card name.
4. **Attack triggers** (`triggerOnAttack`, `engine.ts:4212`) and **combat damage to a player**
   (`executeCombatDamageStep`, `engine.ts:4380`).
5. **Target-controller effects.** Add `recipient` to `ParsedEffect`. Beast Within / Generous Gift
   (`engine.ts:3002`) and Swords / Path (3057) become data. Path's search goes through
   `initiateLibrarySearch`, so Opposition Agent and human choice both work.
6. **Cost modifiers.** Remove the Ur-Dragon, Electromancer, Puresteel and Blasphemous Act hardcodes
   in `ruleTree.ts` once generic patterns cover them. Then delete the fallback at
   `engine.ts:445-481`, but only after Bug A3's overload routing is in place and every card in
   `precons.ts` returns a non-null `cast.normal` (add a test that iterates the card pool and checks
   this).
7. **Remove every Cyclonic Rift name check:** `engine.ts:438, 3069, 5541, 5682` **and**
   `ArenaTable.svelte:1194` (the UI check isn't in the original plan). Key the behaviour off
   "was cast with overload". Consider storing `castMode: 'normal' | 'overload'` on `StackItem`
   instead of overloading `xValue >= 1`, since that collides with real X spells.
8. **Dynamic mana** (Elvish Archdruid, Priest of Titania, Marwyn) duplicated in
   `simulateOrExecuteAutoTap` and `tap_mana`: extract one helper.

## Stage D: Continuous layer engine (highest risk; do last)

- `inspectCardContinuousBreakdown` (`ruleTree.ts:1145`) checks about 20 cards by name. Test
  coverage here is thin. Before refactoring, write **snapshot tests** recording
  P/T, keywords, types and abilities for each of those cards in a representative board state. Then
  generalise one card at a time.
- Order layer effects by timestamp and dependency (CR 613). Don't change the application order as a
  side effect of the refactor.

## Stage E: AI

- `ai.ts` reads the printed `card.typeLine` (lines 17, 123, 182, 229, 264, 309, 336) and doesn't
  skip phased-out permanents. Switch to `evaluatePermanent(state, perm)` plus `!perm.phasedOut`.
  This is low risk and can be done at any point after Stage A.

---

## Corrections to the original plan

| Original claim | Reality |
|---|---|
| `engine.ts:445-481` is dead code | It's the only overload path, and it has a bug (A3). Don't delete it until C6. |
| Deleting the Atraxa hardcode fixes Atraxa | It leaves the opponent's-turn bug (A2). The proposed test only checks the controller's own turn. |
| Hardcoded Felidar / Nether Shadow should just go generic | The generic parser makes Felidar win at 20 life (A1). Nether Shadow needs a graveyard-zone scan. |
| Intervening-if parsing is a feature to add | It's a prerequisite. Without it, deleting hardcodes causes regressions. It also needs a recheck on resolution (CR 603.4). |
| Owner/controller bug affects the destination graveyard | It also affects commander detection and cast count (B1). |
| Path to Exile only bypasses Opposition Agent | Auto-fetched lands skip **all** ETB triggers (B5). |
| Cyclonic Rift is hardcoded in 4 places | 5: `ArenaTable.svelte:1194` too. |
| Verification: "zero regressions on 57 tests" | Insufficient. Each fix needs a test that fails first. |

## Definition of done (per stage)

- Every new test failed before the fix and passes after it.
- `node --test src/lib/magic/magic.test.ts`: all tests pass.
- `npx svelte-check --tsconfig ./tsconfig.json`: no new errors in `src/lib/magic/` or `src/routes/magic/`.
- No hardcoded card-name branch was deleted without a test covering that card through the generic path.
