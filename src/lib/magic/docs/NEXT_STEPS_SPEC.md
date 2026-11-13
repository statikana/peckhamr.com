# MTG Engine: Next Steps Spec

**Status:** spec, written 2026-11-12 against `engine-rewrite` at `ad82d00`, updated after Track A (`972a90c`), Track B1 (`961b8e5`), Track B2 (`bd98235`), Track B3 (`9bd2f3f`), and **Cycling** (`COMPILER_VERSION = 17`). Track A (`A1`–`A4`), **B1**, **B2**, **B3**, and **Cycling** (`CR 702.29`) are **done**; **B4** (design doc only) is next.

**Purpose:** the recommended next work for the engine, written so that each work package can be handed to one agent. Track A is near-term fixes (complete). Track B is the structural work that full keyword and rules coverage needs (the reasoning is in [`FULL_COVERAGE_STRUCTURE.md`](./FULL_COVERAGE_STRUCTURE.md)). Track C keeps the docs honest as the code changes.

**Order:**
1. ~~A1, A2, A3 and A4~~ — **done** (`b68ef55`, `dfbc69e`, `94b04de`, `972a90c`).
2. ~~B1~~ — **done** (`961b8e5`, [`ENGINE_ARCHITECTURE_PLAN.md`](./ENGINE_ARCHITECTURE_PLAN.md) §2.10); ~~B2~~ — **done** (`bd98235`, [`ENGINE_ARCHITECTURE_PLAN.md`](./ENGINE_ARCHITECTURE_PLAN.md) §2.11); ~~B3~~ — **done** (`9bd2f3f`, [`ENGINE_ARCHITECTURE_PLAN.md`](./ENGINE_ARCHITECTURE_PLAN.md) §2.12); ~~Cycling (`CR 702.29`)~~ — **done** ([`ENGINE_ARCHITECTURE_PLAN.md`](./ENGINE_ARCHITECTURE_PLAN.md) §2.13); **B4** (design doc only) is next.
3. Track C rides along with every package.

---

## 0. Rules for every work package

- **Read first:** [`ENGINE_INVARIANTS.md`](./ENGINE_INVARIANTS.md) and [`ENGINE_ARCHITECTURE_PLAN.md`](./ENGINE_ARCHITECTURE_PLAN.md) §2. Never add card-name checks or runtime reads of rules text.
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

**Problem.**
- The engine assumes one face per card.
- `multiface` is its own unsupported reason, covering 895 abilities.
- Face-down permanents and the copy rules are partial.

**Goal of this package: a design doc only.** It goes in `ENGINE_ARCHITECTURE_PLAN.md` §2 and answers these questions:
- how faces are represented in `ScryfallCard`, `CardInstance` and the IR;
- which face's characteristics apply in each zone;
- how transforming keeps object identity (CR 712.18);
- how split, adventure and modal double-faced cards are cast (through B2's cast options);
- what changes in layers (layer 1 copiable values, layer 1b face-down) and in the client.

Implementation is a later spec.

**Size:** S (doc only).

---

## Track C: keep the docs true

- **Ride-along:** every package above updates the docs it affects (see §0).
- **Rules-audit reconciliation:** `rules-audit/01`–`10` are stale; see their banners. When a package touches a section, reconcile that section's rows for the area touched, not the whole file.
- **Separate small task (S):** replace the hand-typed totals in `rules-audit/00-SUMMARY-AND-PRIORITIZED-GAPS.md` §1 with numbers computed by a script from the section tables. Count both table rows and CR subrules. Then remove the miscount banner. See [`audits/02`](./audits/02-rules-audit-arithmetic-and-cr-citations.md) for the known errors, including the scrambled CR 122 table in `01-game-concepts.md`.
