# MTG Engine: Next Steps Spec

**Status:** spec, written 2026-11-12 against `engine-rewrite` at `ad82d00`, updated for **Track F** (`COMPILER_VERSION = 30` baseline). Track A (`A1`–`A4`), **B1**, **B2**, **B3**, **Cycling** (`CR 702.29`), **B4** (Phases 1–3: `0fc1211`, `8b772d5`, `91335a5`), **Track B Tokens/Investigate/Surveil** (`eab9015`), **Track D** (`f988d0c`), and **Track E** (`8cbb247`) are **done**.

**Purpose:** the recommended next work for the engine, written so that each work package can be handed to one agent. Track A is near-term fixes (complete). Track B is the structural work that full keyword and rules coverage needs (the reasoning is in [`FULL_COVERAGE_STRUCTURE.md`](./FULL_COVERAGE_STRUCTURE.md)). Track C keeps the docs honest as the code changes. Track E (`8cbb247`) knocked out top `dig`/`Devoid`/`delayed`/`linked exile`/`Layer 2`/`Convoke`/`Delve` templates; **Track F** targets the next largest `COVERAGE.md` (`v30`) template clusters and 8 of the 13 remaining unsupported precon cards.

**Order:**
1. ~~A1, A2, A3 and A4~~ — **done** (`b68ef55`, `dfbc69e`, `94b04de`, `972a90c`).
2. ~~B1, B2, B3, Cycling, B4, Track B Tokens, Track D, Track E~~ — **done**.
3. **Track F** (Slices 1–4) — **in progress**.
4. Track C rides along with every package.

---

## 0. Rules for every work package

- **Read first:** [`ENGINE_INVARIANTS.md`](./ENGINE_INVARIANTS.md) and [`ENGINE_ARCHITECTURE_PLAN.md`](./ENGINE_ARCHITECTURE_PLAN.md) §2. Never add card-name checks or runtime reads of rules text.
- **Comprehensive Rules lookup (`src/lib/rules/`):** Prefer the split, single-read CR section files in [`src/lib/rules/INDEX.md`](../../rules/INDEX.md) (every file `< 44 KB` and `< 760` lines, including [`701-INDEX.md`](../../rules/700-additional-rules/701-keyword-actions/701-INDEX.md), [`702-INDEX.md`](../../rules/700-additional-rules/702-keyword-abilities/702-INDEX.md), and [`glossary/`](../../rules/glossary/glossary-a-to-c.md)) over grepping or slicing the monolithic `src/lib/rules.txt`.
- **Tests:**
  - Run the full suite before starting, and record the result: `node --test 'src/lib/magic/**/*.test.ts'`. It takes about 40 s.
  - Every behaviour change gets a test that fails before the change. Use a real card where one fits, plus a synthetic card with an invented name.
  - Drive behaviour tests through `applyGameAction`, not internal helpers.
- **Type check:** `npm run check` must show no errors under `src/lib/magic/` or `src/routes/magic/`. Errors in other routes already exist; leave them alone.
- **Compiler changes:**
  - Bump `COMPILER_VERSION` (`compiler/index.ts`) and regenerate the IR snapshot (`UPDATE_IR_SNAPSHOTS=1 node --test src/lib/magic/compiler/compiler.test.ts`).
  - Regenerate the coverage report: `node scripts/magic-coverage.ts ~/data/scryfall/oracle-cards.jsonl.gz --out src/lib/magic/docs/COVERAGE.md`.
- **Golden snapshot** (`runtime/__snapshots__/golden.json`): regenerate only when behaviour legitimately changed. Read the diff, and say in the report which bot decisions changed and why.
- **Docs:** when a package closes a gap, do all three of the following:
  - remove or narrow the matching **Not yet enforced** note in `ENGINE_INVARIANTS.md`;
  - re-check the affected `rules-audit/` rows and mark them **Updated YYYY-MM-DD**;
  - update [`audits/README.md`](./audits/README.md) "Open" if the gap was listed there.
- **Commits:** one commit per work package, on `engine-rewrite`, `magic:` prefix. Don't push. Don't touch `src/routes/+page.svelte`.
- **Report:** what changed, the tests added, before and after suite counts, snapshot changes, and anything skipped or left as `todo`, with the reason.

---

## Track A: near-term fixes (✅ Done)

### A1. Granted activated abilities carry their IR (Goldspan Dragon) — ✅ Done (`dfbc69e`)

**Problem.** "Treasures you control have '{T}, Sacrifice this artifact: Add two mana of any one color.'" doesn't work. Two separate gaps:

1. **Compiler.** `parseGrantedManaAbility` (`compiler/statics.ts`) only accepts `"{cost}: Add {C}"`-style and "one mana of any color" abilities. Goldspan's line falls through to `static_not_compiled`.
2. **Runtime.** Granted abilities don't survive as data:
   - `runtime/layers.ts` turns a `grantAbility` mod into a display item (`grantItem(..., 'Mana Ability: Add {G}', ...)`), keeping only one color or "any".
   - `getEffectiveActivatedAbilities` (`ruleTree.ts`) regex-parses that label back into an ability (`/Add \{([WUBRGC])\}/`).

   So a granted ability with any other cost or effect can't exist. This is also a runtime read of display text, the same kind of leak the IR wall forbids.

**Goal.** A `grantAbility` static grants a real `AbilityDef`, and the affected permanent can activate it like an innate one.

**Scope.**
- **`compiler/statics.ts`:** parse a quoted activated ability with the normal activated-ability grammar (cost grammar plus effect grammar), not a mana-only special case. Self-references inside the quotes ("this artifact", "this creature", `~`) mean the object that has the ability (CR 201.5, 113.7), so they compile to `self`, not to the granting card.
- **Effect grammar:** "Add two mana of any one color" must compile: amount 2, one color chosen once. Check whether the existing `addMana` + `manaChoice: 'any'` step already handles amount > 1 with a single color choice. If not, extend it.
- **`runtime/layers.ts`:** carry the granted `AbilityDef` itself through the breakdown, with source and timestamp, not a label.
- **`ruleTree.ts` `getEffectiveActivatedAbilities`:**
  - build granted abilities from that `AbilityDef` through the same path as innate ones (`getCardActivatedAbilities`);
  - delete the label regex;
  - give each granted ability an id that is stable for as long as the grant lasts.
- **Mana payment:**
  - when a permanent has several mana abilities (a Treasure's own one plus Goldspan's), the player chooses which to activate;
  - auto-tap and `chooseBotSpellCostPayment` must consider the granted one;
  - check `tap_mana` in `engine.ts` and the mana-source UI in `ArenaTable.svelte`.
- **Existing grants:** Imprisoned in the Moon, Song of the Dryads, Urborg and Yavimaya-style land grants currently go through the label path. They must keep working through the new one.

**Out of scope.** Granted triggered and static abilities, unless they fall out naturally. Note what remains.

**Acceptance.**
- Goldspan Dragon (`STAPLE_CARDS`) compiles fully supported.
- With Goldspan on the battlefield, a Treasure can produce two mana of one chosen color by sacrificing itself. Without Goldspan, the same Treasure produces one.
- The choice between the two abilities is offered to a human. Bots and auto-tap prefer the two-mana ability when they need the mana.
- Removing Goldspan mid-turn removes the ability. A Treasure that loses all abilities has neither.
- The label regex in `ruleTree.ts` is gone. The land-grant cards above still pass their existing tests.
- A test with a synthetic granter ("Glimmerfen Hoardkeeper") behaves identically.

**Risks.** The breakdown shape is read by the UI inspector and `ai.ts`, so keep a display label alongside the `AbilityDef`. Watch layer-cache tests (`runtime/layerCache*.test.ts`) and run once with `MAGIC_LAYER_CACHE_CHECK=1`.

**Size:** M.

### A2. Shadowspear, Arcane Lighthouse and Bonds of Mortality: remove the text scan — ✅ Done (`94b04de`)

**Problem.** `runtime/layers.ts` (in the board evaluation, around the `ab.kind === 'unsupported' && ab.id?.startsWith('act_')` branch) does two things with the text of unsupported activated abilities:
- it regex-scans for "your opponents control lose [keyword]" and installs an **always-on** layer-6 static;
- it scans for "gains [keyword]" to fill `grantsKeywordViaAbility`.

The effect of the first scan: while Shadowspear is on the battlefield, opponents' permanents always lose hexproof and indestructible, though the card's ability is activated and lasts until end of turn. A `todo` in `runtime/keywords-protection-attachments.test.ts` records this.

**Goal.** These abilities are real activated abilities with an end-of-turn effect, and no runtime code reads ability text.

**Scope.**
- **IR:** add a way to remove keywords for a duration, for example a `removeKeywords` param on the `grant` verb (`EffectParams`, `ir.ts`), with `duration: 'endOfTurn'`, applied to a filter (`all` + "permanents your opponents control"). Keep it general; it must not be specific to hexproof.
- **Compiler:** compile "[Permanents | Creatures] your opponents control lose [keyword list] until end of turn." Check which of the three cards' full texts then compile fully, and report any that still don't.
- **Runtime:** apply the timed removal through layer 6 with a timestamp, so it interacts correctly with later grants (CR 613.7). Delete both text scans from `layers.ts`.
- **Guard:** extend `architecture.test.ts` with a rule that flags regex use over ability `.text` in runtime files, with an allowance of 0. Or document in the report why that isn't practical.

**Acceptance.**
- Without activating, opponents' hexproof creatures keep hexproof while Shadowspear is out.
- After paying {1}, they lose hexproof and indestructible until end of turn, and regain them next turn.
- The `todo` test becomes a passing test.
- No regex over `ab.text` remains in `runtime/`.
- The `ENGINE_INVARIANTS.md` §1.1 gap note for this is removed.

**Size:** S–M.

### A3. CR 613.7e: every attachment gets a new timestamp — ✅ Done (`b68ef55`)

**Problem.** Attaching an Equipment, Aura or Fortification to an object must give it a new timestamp each time (CR 613.7e). There are several attach sites, and they disagree:
- `runtime/effects.ts` (the `attach` verb) only allocates a timestamp when the Equipment was already attached elsewhere;
- `engine.ts` sets `attachedToId` directly in several places (search for `attachedToId = ` outside the unattach branches).

**Goal.** One helper attaches and timestamps, and every attach site uses it.

**Scope.** Add `attachObject(state, obj, hostId)` to `runtime/zones.ts`, or next to it. It sets `attachedToId`, allocates a new `enteredTimestamp`, and is a no-op when the object is already attached to that host (CR 701.3b). Route every attach site through it. Unattach sites stay as they are.

**Acceptance.**
- Two Equipment that set base P/T, equipped in either order: the later attachment wins, including on the first attachment.
- Re-equipping to the same creature does nothing.
- The golden snapshot is regenerated only if it changes. If it does, explain the change.

**Size:** S.

### A4. Keyword claim cleanup — ✅ Done (`972a90c`, added `phasing` with `runtime/keywords-phasing.test.ts` and synced `KEYWORD_LABELS`)

- **`KEYWORD_LABELS`** (`runtime/layers.ts`) contains unimplemented keywords (`evolve`, `cascade`, and possibly others). They render badges for mechanics that do nothing.
  - Before removing an entry, check its other uses: the same keys feed the "gains [keyword]" scan that A2 deletes, so do A4 after A2 or together with it.
  - Keep the labels in sync with `IMPLEMENTED_KEYWORDS`. A test that asserts every label key is implemented, or is explicitly display-only, is enough.
- **Phasing:** the untap step phases permanents in and out, but `phasing` isn't in `IMPLEMENTED_KEYWORDS`. Either:
  - add it with a full suite at the standard of `runtime/keywords-*.test.ts` (phasing in and out, indirect phasing of attachments, no zone-change triggers, CR 702.26);
  - or leave it out and note why in the coverage guard.

  Don't add it without tests.

**Size:** S.

---

## Track B: structural work

These four packages implement [`FULL_COVERAGE_STRUCTURE.md`](./FULL_COVERAGE_STRUCTURE.md) §1.1–1.4. B1 (pausable resolution) comes before B2 (cast options), which reverses that document's order. The reason: casting (CR 601.2) needs choices partway through (modes, targets, X, costs), and so do many abilities. With one pausable mechanism, B2 only has to define steps, not a second way to wait for a player.

Each B package starts with a short design note (a section added to `ENGINE_ARCHITECTURE_PLAN.md` §2) that a human reviews before any code is written.

### B1. Pausable resolution everywhere (CR 608.2, 601.2, 616.1) — ✅ Done

**Problem.**
- `StackItem.effectResume` pauses an ability only at the prompting verbs: sacrifice, discard, proliferate, mana color, and some move, dig, scry and search steps.
- `compiler/interpretable.ts` rejects a "you may" that isn't a leading choice for the controller ("the interpreter can't pause mid-ability"), so those abilities compile as unsupported.
- Costs don't pause: `planCosts` (`runtime/costs.ts`) asks before paying, and the action is resubmitted.
- Choices by a player other than the controller aren't supported.

**Goal.** Any effect step, cost step or rules procedure can stop for a choice by any player, store a JSON continuation on `GameState`, and resume exactly where it stopped.

**Design constraints.**
- The continuation is plain JSON (invariant §7.1) and is stripped by `sanitizeGameStateForViewer` (§2.9).
- It survives a server restart, because the homelab and Cloudflare backends both reload state from storage.
- One mechanism serves effects, costs, combat damage assignment, replacement ordering and SBA-time choices. Map each existing pause (`effectResume`, `pendingZoneMoves`, the combat damage prompts, `counter_replacement_choice`) onto it, or record why one stays separate.
- Bots answer through the same choice interface.
- Answers are validated against the prompt. A stale or forged answer is rejected.

**Acceptance.**
- An ability with a mid-sequence "you may" compiles supported and works. Example: "Draw a card. You may discard a card. If you do, ..."
- So does an ability where an opponent chooses. Example: "target opponent may ...".
- The "Partner with [name]" search trigger (CR 702.124j) is automated: target player may search for the named card. Remove its unsupported marker in `compiler/card.ts` and convert the `todo` in `runtime/keywords-casting.test.ts`.
- `JSON.parse(JSON.stringify(state))` taken mid-pause resumes identically. The prompt round-trip tests (`runtime/prompts-roundtrip.test.ts`) cover the new pauses.
- Report `COVERAGE.md` before and after. Expect the `unparsed` count to drop.

**Size:** L. Split it into slices: effects first, then costs, then rules procedures.

### B2. Cast options in place of `castMode` (CR 601.2, 118.9) — ✅ Done (Kicker deferred to B3)

**Problem.**
- `castMode: 'normal' | 'overload'` is threaded through about ten functions, the action payload and `StackItem`.
- `ALTERNATIVE_COST_KEYWORDS` has one entry.
- The UI has an Overload-specific modal.

Each further alternative or additional cost would repeat all of that. See `FULL_COVERAGE_STRUCTURE.md` §1.1.

**Goal.** The engine lists the legal ways to cast a card from where it is. The client and bots pick one by id, and casting runs CR 601.2a–h as explicit, pausable steps (B1).

**Design constraints.**
- A cast option is data:
  - the zone and the permission that allows the cast;
  - the base cost (printed, alternative, or none);
  - optional and required additional costs;
  - timing;
  - modifications to the spell: targets become "each", exile on resolution, enters with counters, and so on.
- The UI renders the options it is given and contains no keyword names. Bots choose among the same list.
- Migrate Overload onto the model first, and delete `castMode`. Then add **Flashback** as the proof that a new option needs no UI or AI changes. Add Kicker as a second proof if time allows; it is an additional cost.

**Acceptance.**
- No `'overload'` string literal remains in `ArenaTable.svelte` or `ai.ts`, and `castMode` is gone from `types.ts`.
- All existing Overload tests pass after being adapted to option ids, including the ones covering the UI path.
- Flashback works: cast from the graveyard and exiled on resolution or leaving the stack (CR 702.34). Its compiler entry moves to `IMPLEMENTED_KEYWORDS` with a full keyword suite.
- Verify both in the running app. The previous Overload fix did this with a headless-browser script against `vite dev`.

**Size:** L.

### B3. Keyword registry (CR 702) — ✅ Done

See [`ENGINE_ARCHITECTURE_PLAN.md`](./ENGINE_ARCHITECTURE_PLAN.md) §2.12 (`COMPILER_VERSION = 16`). Completed across three slices:
- Unified `KEYWORD_REGISTRY` (`src/lib/magic/keywords.ts`) deriving `IMPLEMENTED_KEYWORDS`, `KNOWN_KEYWORDS`, `STATIC_CONTINUOUS_KEYWORDS`, `GRANTABLE_KEYWORDS`, `KEYWORD_LABELS`, `ALTERNATIVE_COST_KEYWORDS`, and `GRANTED_TRIGGER_KEYWORD_EVENTS`, with generic Layer 6 granted-trigger emission (`runtime/triggers.ts`) and 1:1 coverage-guard enforcement (`runtime/keywords-coverage-guard.test.ts`).
- 7 pure-IR keywords (`battle cry`, `afterlife`, `bushido`, `living weapon`, `for mirrodin!`, `affinity`, and `exploit` `CR 702.110a`) + 3 thin-primitive combat keywords (`exalted`, `annihilator`, and 7 `landwalk` variants). (`Cycling` `CR 702.29` was implemented immediately after B3; see [`ENGINE_ARCHITECTURE_PLAN.md`](./ENGINE_ARCHITECTURE_PLAN.md) §2.13.)
- **Kicker & Multikicker** (`CR 702.33a–g`) wired via `CastOption.optionalAdditionalCosts`, `runtime/kicker.ts`, keyword-blind UI (`ArenaTable.svelte`) and AI (`ai.ts`), `CR 400.7` zone reset, conditional kicker targets (`CR 702.33g`), live `vite dev` Chromium verification, IR snapshots, and regenerated [`COVERAGE.md`](./COVERAGE.md) (`keyword_not_implemented`: `4,190 → 3,584`, `-606`).

**Size:** M–L.

### Cycling & Hand-Zone Activated Abilities (`CR 702.29`) — ✅ Done

See [`ENGINE_ARCHITECTURE_PLAN.md`](./ENGINE_ARCHITECTURE_PLAN.md) §2.13 (`COMPILER_VERSION = 17`). Completed across two slices:
- Generalized `activationZones?: ZoneType[]`, `{ k: 'discard', filter: 'self' }`, `effectiveAbilityManaCost` keyword matching, generic `[quality]cycling` parsing (`cycling`, `basic landcycling`, `landcycling`, `typecycling` via `parseObjectPhrase`), keyword-blind UI (`ArenaTable.svelte`) & bot AI (`ai.ts`).
- Added `CardDiscardedEvent` (`reason: 'cycle' | 'discard'`), `"When you cycle ~"` (`fromZone: 'any'`, `CR 702.29c`), `"cycles or discards"` (`CR 702.29d`), IR snapshots, live `vite dev` Chromium verification, and regenerated [`COVERAGE.md`](./COVERAGE.md) (`keyword_not_implemented`: `3,584 → 3,240`, `-344`).

### B4. Object model for multi-faced and face-down cards (CR 707–712, 708)

**Status:** Design doc written and approved in [`ENGINE_ARCHITECTURE_PLAN.md`](./ENGINE_ARCHITECTURE_PLAN.md) §2.14. No code changes in this package.

**Problem.**
- The engine assumes one face per card.
- `multiface` is its own unsupported reason, covering 895 abilities.
- Face-down permanents and the copy rules are partial.

**Goal of this package: a design doc only.** It goes in `ENGINE_ARCHITECTURE_PLAN.md` §2 and answers these questions:
- how faces are represented in `ScryfallCard`, `CardInstance` and the IR;
- which face's characteristics apply in each zone;
- how transforming keeps object identity (CR 712.15);
- how split, adventure and modal double-faced cards are cast (through B2's cast options);
- what changes in layers (layer 1 copiable values, layer 1b face-down) and in the client.

Implementation is a later spec.

**Size:** S (doc only).

---

## Track C: keep the docs true (ongoing ride-along)

- **Ride-along:** every package below updates the docs it affects (see §0).
- **Rules-audit reconciliation:** `rules-audit/01`–`10` are stale; see their banners. When a package touches a section, reconcile that section's rows for the area touched, not the whole file.
- **Separate small task (S):** replace the hand-typed totals in `rules-audit/00-SUMMARY-AND-PRIORITIZED-GAPS.md` §1 with numbers computed by a script from the section tables. Count both table rows and CR subrules. Then remove the miscount banner. See [`audits/02`](./audits/02-rules-audit-arithmetic-and-cr-citations.md) for the known errors, including the scrambled CR 122 table in `01-game-concepts.md`.

---

## Track D: High-Frequency Mechanics, Unified Optional Costs, Modal Abilities, & Vehicles — ✅ Done (`f988d0c`)

See [`ENGINE_ARCHITECTURE_PLAN.md`](./ENGINE_ARCHITECTURE_PLAN.md) §2.15 for the full design. Delivered in four reviewable slices (each keeping `oracleTextRead === 0` and UI/AI keyword-blind):

1. **Slice 1 (Draw/Discard Clause Fix, Goad `CR 701.15`, Explore `CR 701.44`, Map `CR 111.10s`, Connive `CR 701.50`):**
   - Fix `CLAUSE_START` / `LOWER_START` + `NUMBER_WORDS` for `discard`, `goad`, `explore`, `connive`, `regenerate`.
   - `goad` verb + deduplication (`CR 701.15d`) + `expirePlayerUntilNextTurnEffects` at turn start and skipped eliminated turns (`CR 701.15a`, `CR 800.4m`).
   - `explore` + `PREDEFINED_TOKEN_DEFS.map` (`CR 111.10s`) + `connive` / `connive N` (`CR 701.50`) + `Explored` / `Connived` triggers (`runIndexedBatch` APNAP order).
2. **Slice 2 (`Regenerate` `CR 701.19` + Unified `OptionalSpec` / `CostDef[]` Payment):**
   - `regenerationShields` + `cantBeRegenerated` + `tryRegenerateInsteadOfDestroy` on both effect destruction and lethal/deathtouch combat/SBA (`CR 614.8`, `CR 704.5g–h`).
   - Unified `OptionalSpec` (`cost`, `mode: 'doIfPaid' | 'doUnlessPaid'`) + `ifPrecedingDeclined` (`"If you don't,"`), powering `"you may pay {COST}"`, `"Counter target spell unless its controller pays {COST}"`, and `"sacrifice ~ unless you pay {COST}"`.
3. **Slice 3 (Modal Triggers, Activated Modals, Repeatable Modes `CR 700.2`):**
   - Share `ModalDef` across `SpellAbility`, `ActivatedAbility`, and `TriggeredAbility` with `allowRepeat`, `oncePerTurnUnique`, `chooser`, `upTo`, and `targets.length > 1` support.
   - `CR 700.2b` trigger modal selection on stack entry (`trigger_modes` -> `trigger_targets`), activated modal selection, and generic UI/AI mode pickers.
4. **Slice 4 (`Crew N` `CR 702.122` & Generalized `TimedContinuousEffect`):**
   - `state.timedContinuousEffects` evaluated cleanly in Layers 4/6/7b (`runtime/layers.ts`, `clearEndOfTurnAndDamage`, `CR 302.6` summoning sickness).
   - Subset-sum cost `{ k: 'tapSubsetSum', metric: 'power', ... }`, `KEYWORD_REGISTRY` `'crew'` entry, `BecomesCrewed` / `crewedByIds`, and keyword-blind UI/AI subset selection, followed by final `COVERAGE.md`, `rules-audit/`, and live Chromium `/magic` verification.

---

## Track E: Dig, Devoid, Delayed Triggers, Linked Exile, Layer 2 Control, & Convoke/Delve — ✅ Done (`COMPILER_VERSION = 30`)

See [`ENGINE_ARCHITECTURE_PLAN.md`](./ENGINE_ARCHITECTURE_PLAN.md) §2.16 for the full architecture spec. Dispatch sequentially in four slices (`oracleTextRead === 0`, `cardNameComparison === 0`, no IR serialized in `GameState`, UI/AI keyword-blind):

1. **Slice 1 (Generalized Top-N `Dig` & All-Zone `Devoid` `CR 702.114a`):**
   - Expand `dig` IR (`keepFilter`, `keepTo`, `keepTapped`, `revealAll`, `revealKept`, `keepAllMatching`, `restOrder: 'any' | 'random'`) + multi-sentence combining (`Look at the top N cards...` / `Reveal the top N cards...` + keep/reveal filter clause + `Put the rest on the bottom in a random order` / `in any order`) + `Run.dig` (`chooseObjects`, `orderObjects`, `nextRandom`, replacement-pausable moves).
   - Register `'devoid'` (`CR 702.114a`) in `KEYWORD_REGISTRY` as an all-zone Layer 5 CDA (`colors: []` in `layers.ts`, `faces.ts`, `objectFilter.ts`, `CR 613.3` ordering before non-CDA Layer 5 effects, `CR 903.4` color identity preserved).
2. **Slice 2 (IR-Safe Delayed Triggers `CR 603.7` & Linked Exile `CR 607.2a`, `610.3`):**
   - Add `compiledDelayed` locator (`sourceCard`, `faceIndex`, `fused`, `abilityKey`, `stepIndex`, `boundRefs`) on `DelayedTrigger` / `StackItem` (zero IR in `GameState`) supporting arbitrary delayed steps (`sacrifice`, `exile`, `destroy`, `bounce`, `draw`, `lose`, `damage`, etc.) across `next end step` / `that turn's end step` / `next turn's upkeep` / `end of combat` with `CR 603.7c` object/zone checks.
   - Add `exiledBy` (`CR 607.2a`) and `untilSourceLeavesReturn` (`CR 610.3a–d`) on `CardInstance`, `"Exile target ... until ~ leaves the battlefield"` (`CR 610.3` pre-exile source check + immediate one-shot return when source leaves battlefield), and `"cards exiled with ~"` filter (`{ k: 'exiledWithSelf' }`).
3. **Slice 3 (Layer 2 Continuous Control Changes `CR 613.1b`, `613.7`, `302.6`):**
   - Add `layer: '2'` `{ k: 'setController', controller: PlayerRef }` + `TimedContinuousEffect.layer2` (`expires: 'endOfTurn' | 'never' | 'untilSourceLeaves'`) and `gainControl` verb.
   - Evaluate Layer 2 in Pass 0 (`runtime/layers.ts`, timestamp order `CR 613.7`) BEFORE Layers 4–7; update `layerCache.ts` fingerprinting; run `syncBattlefieldControllers(state)` (`runtime/zones.ts` / `engine.ts`) so overlapping *Control Magic* + *Act of Treason* effects stack, transfer between battlefields with `summoningSick = true` (`CR 302.6`) + combat removal (`CR 506.4`), and revert accurately on expiration/removal.
4. **Slice 4 (`Convoke` `CR 702.51` & `Delve` `CR 702.66`, Snapshots, `COVERAGE.md`, & Live Verification):**
   - Register `'convoke'` (`CR 702.51`) and `'delve'` (`CR 702.66`) in `KEYWORD_REGISTRY`.
   - Expose generic `CastCostAid` (`paymentAids` on `CastOption`, `costAidIds` / `costAidColorChoices` on `cast_spell`), enforcing post-determination `CR 601.2f–h` reduction, `CR 118.10` no double-tap, `CR 702.51c` `BecomesTapped` triggers, `PendingCostPayment` pause safety, and keyword-blind UI (`ArenaTable.svelte`) + AI (`ai.ts`) with zero `'convoke'`/`'delve'` literals.
   - Bump `COMPILER_VERSION`, regenerate `compiler/__snapshots__/ir.json` & `COVERAGE.md`, update `rules-audit/` docs, and run live Chromium `/magic` verification.

---

## Track F: Land Animation, Copy Retargeting & Storm, Graveyard/Hand Abilities & Cast Keywords, Coercive Discard & Count Triggers, and Precon Closers

See [`ENGINE_ARCHITECTURE_PLAN.md`](./ENGINE_ARCHITECTURE_PLAN.md) §2.17 for the full architecture spec. Dispatch sequentially in four slices (`oracleTextRead === 0`, `cardNameComparison === 0`, zero IR serialized in `GameState`, UI/AI keyword-blind):

1. **Slice 1 (Land Animation `"It's still a land."` `CR 205.1b`, Spell/Ability Copy Retargeting `CR 707.10b–c,f`, & `Storm` `CR 702.40a–b`):**
   - Extend `animate` (`ir.ts`, `compiler/effects.ts`, `compiler/statics.ts`, `runtime/effects.ts`) to emit full `TimedContinuousEffect` (`layer4`, `layer5`, `layer6`, `layer7b`) for `"becomes a [P/T] [colors] [subtypes] creature [with <keywords>] [until end of turn][, where X is ...]. It's still a land."` and `"Enchanted <land> is a ... creature ... It's still a land."`, preserving `'Land'` type and land mana abilities (`CR 205.1b`) while honoring `summoningSick` (`CR 302.6`).
   - Support stack ability targeting (`TargetSpec.stackKind`), `CR 707.10b` ability copying (retaining original `sourceInstanceId` / `sourceObjectVersion`), `triggerEventStackItem` LKI snapshots for cast/activate-triggered self-copies (`CR 707.10`, `608.2h`), and pausable per-copy `mayChooseNewTargets` (`CR 707.10c`, `CR 115.7d–e`, emitting `BecomesTargeted` on copy stack entry).
   - Register `'storm'` (`CR 702.40a–b`) in `KEYWORD_REGISTRY` (cast trigger creating `stormCount` LKI-safe copies with `mayChooseNewTargets: true`, multiple instances triggering separately).
2. **Slice 2 (Hand/Graveyard Activated Abilities `Discard ~` / `Channel` / `Return ~ from graveyard`, `Unearth` `CR 702.84a`, `Buyback` `CR 702.27a`, `Evoke` `CR 702.74a`, & `Escape` `CR 702.138a–d`):**
   - Parse `"Discard ~"` (`{ k: 'discard', filter: 'self' }`) and `"Exile N other [filter] cards from your graveyard"` (`compiler/costs.ts`, `runtime/costs.ts`), strip `Channel —`, auto-infer `activationZones: ['hand']` / `['graveyard']` (`compiler/card.ts`), and wire `'graveyard'` activated abilities in `engine.ts`, `ArenaTable.svelte` (`zoneModal` / `castOptionsModal`), and `ai.ts` with zero keyword literals.
   - Implement `'unearth'` (`CR 702.84a`: sorcery-speed graveyard activation returning `self` to battlefield with permanent Haste, next-end-step exile `DelayedTrigger`, and `unearthLeaveExile` replacement redirecting non-exile battlefield exits to `'exile'`).
   - Implement `'buyback'` (`CR 702.27a`: `CastOption.optionalAdditionalCosts` setting `returnToHandOnResolve`, resolution-only return to hand overridden by `exileOnLeaveStack`, unlocking precon *Corpse Dance*), `'evoke'` (`CR 702.74a`: `'alt:evoke'` + ETB sacrifice trigger), and `'escape'` (`CR 702.138a–d`: `'alt:escape'` from graveyard + `{ k: 'escaped' }` condition + `"~ escapes with ..."` counters/abilities).
3. **Slice 3 (Coercive Hand Reveal/Discard `CR 701.9, 701.20` & Per-Turn Count / Once-Per-Turn / Batch Combat Damage Triggers `CR 603.2c, 603.2i`):**
   - Compile & execute `"<target player/opponent> reveals their hand. You [may] choose a [filter] card from it. [If you do, ]that player discards that card."` (public reveal logging + viewer `knownToPlayerIds`, `chooseObjects` over matching hand cards, bot threat selection, pausable `discardReason: 'discard'`, `stepDecisions`).
   - Track `cardsDrawnThisTurn` per player (`"Whenever [player] draw(s) their second card each turn"`), wire `spellsCastThisTurn === 2` (`"Whenever [player] cast(s) their second spell each turn"`), enforce `"This ability triggers only once each turn."` (`CR 603.2i` per `(instanceId, objectVersion, abilityKey)`), and add batch `"Whenever one or more [filter] you control deal combat damage to a player/opponent"` triggers (`CR 603.2c`).
4. **Slice 4 (Precon & Commander Closers: `Evolve` `CR 702.100`, Trigger `, where X is ...`, Targeting Cost Taxes, Off-Battlefield Colorless, Conditional Modal Both + Opponent Hand Count, Partitioned `Dig`, Extra Combat Phases `CR 500.8`, Snapshots, `COVERAGE.md`, & Live Verification):**
   - Implement `'evolve'` (`CR 702.100a–d`, *Fathom Mage*), general trailing `, where X is <amount>` in trigger/activated/spell effects (*Scourge of Valkas*), targeting non-mana/mana `costModifier` taxes (*Terror of the Peaks*), `allOffBattlefieldAndSpellsColorless` rule modifier (*Mycosynth Lattice*), `ModalDef.conditionalChooseAll` + target-player `zoneCount` (*Jeska's Will*), multi-destination `dig.partitions` (*Expressive Iteration*), and LIFO `state.extraPhases` (`CR 500.8`, *Hellkite Charger*).
   - Bump `COMPILER_VERSION`, regenerate `compiler/__snapshots__/ir.json` & `COVERAGE.md`, update `ENGINE_INVARIANTS.md` & `rules-audit/` docs, and run live `vite dev` Chromium `/magic` verification.

---

## Track P: Orthogonal Parallel Worktree Tracks (P1–P3 alongside `teamwork-mtg-engine`)

See [`ENGINE_ARCHITECTURE_PLAN.md`](./ENGINE_ARCHITECTURE_PLAN.md) §2.18 for the full architecture and CR specification. Each worktree branches cleanly off `engine-rewrite`, keeps `ir.ts` / `types.ts` / `keywords.ts` edits strictly additive, writes its own dedicated runtime test file, and defers `COMPILER_VERSION`, `ir.json`, and `COVERAGE.md` regeneration to the post-merge integration step:

1. **Track P1 (`mtg_p1_sagas_energy`) — ✅ Done (`5910db0`):** Saga Cards (`CR 715.1–4`), Energy `{E}` Counters (`CR 107.14`), & The Monarch (`CR 726.1–5`, `CR 800.4k`) -> `src/lib/magic/runtime/sagas-energy-monarch.test.ts`.
2. **Track P2 (`mtg_p2_fight_impulse_triggers`) — ✅ Done (`28a716f`):** Two-Target Fight & Power-Damage "Bite" (`CR 701.14`, `CR 608.2b`), Multi-Turn & Free-Cast Impulsive Draw (`CR 601.1a`, `CR 118.9`), & Attached-Permanent LKI Death (*Skullclamp*) + Cast-Targeting Heroic Triggers (`CR 603.10a`) -> `src/lib/magic/runtime/fight-impulse-attached-triggers.test.ts`.
3. **Track P3 (`mtg_p3_orthogonal_keywords`) — ✅ Done (`4c7e45e`):** `Foretell` (`CR 702.143`), `Plot` (`CR 702.170`), `Saddle` (`CR 702.171`), `Entwine` (`CR 702.42`), `Disturb` (`CR 702.146`), `Blitz` (`CR 702.152`), `Retrace` (`CR 702.81`), `Jump-start` (`CR 702.133`), & `Cumulative upkeep` (`CR 702.24`) -> `src/lib/magic/runtime/orthogonal-keywords-p3.test.ts`.
4. **UI Tracks `U1–U3` + `U4` (`ENGINE_ARCHITECTURE_PLAN.md` §2.19A):** Modular `src/lib/magic/ui/` decomposition, O(B) memoized board view-model, auto-tap hover preview, multi-slot sequential targeting state machine, `"Peek Battlefield"` prompt modals, future CR allocation/pile/picker widgets, and `src/routes/magic/+page.svelte` decomposition.
5. **Wave 2 Engine Tracks `P4–P6` (`ENGINE_ARCHITECTURE_PLAN.md` §2.19B):**
   - **Track P4 (`mtg_p4_tuck_freeze_chosen_mana`):** Library Top/Bottom/Top-or-Bottom/Nth-from-Top (`CR 401.2, 401.4, 401.7`), Next-Untap Freeze + `Exert` (`CR 502.3, 611.2b, 701.43`), ETB Chosen Creature Type & Color (`CR 614.12`), & Multi-Color Combo / Filter / Verge Mana (`CR 106.1a–b, 602.5b`) -> `src/lib/magic/runtime/tuck-freeze-chosen-mana-p4.test.ts`.
   - **Track P5 (`mtg_p5_cr701_keyword_actions`):** `Amass` (`701.47`), `Incubate` (`701.53`/`111.10i`), `Populate` (`701.36`), `Manifest`/`Cloak`/`Manifest dread` (`701.40`/`701.58`/`701.62`), `Monstrosity` (`701.37`), `Bolster` (`701.39`), `Support` (`701.41`), & `Adapt` (`701.46`) -> `src/lib/magic/runtime/keyword-actions-p5.test.ts`.
   - **Track P6 (`mtg_p6_striated_frames_and_cast_keywords`):** `Station` (`CR 722`/`702.184`), `Level up` (`CR 711`/`702.87`), `Prototype` (`CR 719`/`702.160`), `Offspring` (`702.175`), `Squad` (`702.157`), `Replicate` (`702.56`), `Conspire` (`702.78`), `Casualty` (`702.153`), `Warp` (`702.185`), `Vanishing` (`702.63`), `Fading` (`702.32`), `Transmute` (`702.53`), & `Reinforce` (`702.77`) -> `src/lib/magic/runtime/striated-frames-and-keywords-p6.test.ts`.
