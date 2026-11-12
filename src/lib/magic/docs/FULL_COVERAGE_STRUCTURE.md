# MTG Engine: Structural Recommendations for Full Rules Coverage

**Status:** proposal, written 2026-11-12 against `engine-rewrite` (`ecd4a3e`). Nothing here is
implemented or scheduled. It answers one question: if the engine is eventually to cover every keyword
(`CR 702`) and every rule, what has to change in the program's structure first?

**Basis:** a survey of the module layout, `ir.ts`, [`COVERAGE.md`](./COVERAGE.md) and the
[`rules-audit/`](./rules-audit/00-SUMMARY-AND-PRIORITIZED-GAPS.md) reports, plus a close read of the
Overload cast path. It is not a line-by-line review of `engine.ts`. Check each claim against the code
before acting on it.

**What stays:** the cards-as-data skeleton in [`ENGINE_ARCHITECTURE_PLAN.md`](./ENGINE_ARCHITECTURE_PLAN.md)
(`compiler/` → `ir.ts` → `runtime/`, the single zone-change funnel, the event bus, the layer engine,
replacement effects, the data-only choice protocol and the architecture ratchet) and everything in
[`ENGINE_INVARIANTS.md`](./ENGINE_INVARIANTS.md). The recommendations below are about what will stop
scaling on the way from today's coverage to full coverage.

---

## 0. Where the engine is today

Current numbers live in one place each, so they don't drift here:
- card and ability coverage, and unsupported abilities by reason: [`COVERAGE.md`](./COVERAGE.md)
  (regenerate with `node scripts/magic-coverage.ts`);
- Comprehensive Rules status by section:
  [`rules-audit/00-SUMMARY-AND-PRIORITIZED-GAPS.md`](./rules-audit/00-SUMMARY-AND-PRIORITIZED-GAPS.md),
  which is stale and known to miscount; see its banner.

The order of magnitude, as of 2026-11-12:
- about a fifth of all cards are fully supported, and about 40% of abilities;
- unparsed text is the largest single cause of unsupported abilities, about five times the number
  caused by unimplemented keywords;
- 30 keywords are implemented, against about 165 more that the parser recognises;
- `engine.ts` is about 11,000 lines.

**The Overload example.** At `ecd4a3e`, Overload was in `IMPLEMENTED_KEYWORDS` and the engine
supported `castMode: 'overload'`, but a human couldn't cast a spell overloaded:
`handleCardClickInHandOrCommand` (`ArenaTable.svelte`) only opened the X modal when
`spellChoosesX(card)` was true, so an Overload card was always sent as a normal cast. The tests
passed because they reached Overload through an `xValue >= 1` fallback the UI couldn't trigger. The
fix replaced the fallback with an explicit `castMode` from the UI and bots and added a cast-mode
modal. That fix is correct, but it is also more Overload-specific code, which is what §1.1 is about.

---

## 1. Recommendations

Listed in recommended order. Items 1–2 change core interfaces that everything else builds on. Item 3
makes each new keyword cheap. Item 4 is structural work that gets more expensive the longer it waits.
Items 5–7 can run alongside the others.

### 1.1 A general "ways to cast" model in place of `castMode` (`CR 601.2`, `118.9`)

**Problem.** `castMode: 'normal' | 'overload'` is a two-value union threaded through about ten
function signatures (`isOverloadCastMode`, `getSpellCostRequirement`, `chooseBotSpellCostPayment`,
`validateChosenTargets`, `hasRequiredLegalTargets`, `checkSpellCastLegality`, the `cast_spell` action,
`StackItem`). `ALTERNATIVE_COST_KEYWORDS` (`runtime/costs.ts`) has one entry. The UI carries
Overload-specific code, and the Overload fix added more of it (a dedicated cast-mode modal). Flashback, Evoke, Dash, Escape, Foretell, Kicker, Buyback, Madness, Prototype
(`CR 719.3`, already noted in the audit as blocked on `castMode`) and the rest would each repeat that
pattern across the engine, the AI and the UI.

**Recommendation.**
- The engine enumerates the legal **cast options** for a card in a zone. An option is data: the zone
  it is cast from and the permission that allows it, the base cost (printed or alternative), optional
  and mandatory additional costs, timing, and modifications to the spell (targets become "each", exile
  on resolution, enters with counters, sacrificed at end of turn).
- Casting runs `CR 601.2a–h` as an explicit pipeline of steps: choose option, modes, targets, X and
  other variables, determine total cost, pay. Each step that needs a decision uses the existing choice
  protocol.
- The `cast_spell` action names an option id. The UI renders whatever options the engine returns and
  never knows a keyword's name, which is the invariant that would have prevented the Overload bug.
- The AI picks among the same options.

### 1.2 Every resolution pausable at any step (`CR 608.2`)

**Problem.** `interpretable.ts` documents that "the interpreter can't pause mid-ability": an optional
step that isn't a leading "you may" for the controller makes the ability unsupported. `effectResume`
covers some cases (sacrifice, discard). Full rules need a player decision at almost any point: during
cost payment, when ordering replacement effects (`CR 616.1`), in the middle of an effect, or for a
player other than the controller.

**Recommendation.** One serialisable continuation for cast, activation, resolution, combat damage
assignment, state-based actions and turn-based actions, so that any rule can stop for a choice and
resume from stored state. Build it before adding more verbs; each verb written against the current
model has to be revisited later.

### 1.3 Keywords expand into ordinary abilities (`CR 702`)

**Problem.** `KeywordDef` (`ir.ts`) is a flat record of optional fields (`cost`, `param`, `n`,
`costDefs`, `equipFilter`, `enchantFilter`, `enchantPlayer`), and each keyword's behaviour is spread
across `compiler/card.ts`, `compiler/statics.ts`, `compiler/triggers.ts`, `runtime/layers.ts`,
`runtime/effects.ts`, `runtime/costs.ts` and `engine.ts`. `hasKeyword` (`engine.ts`) takes a string.
About 165 keywords the parser recognises are unimplemented.

**Recommendation.** A keyword registry with one entry per keyword: its parameters, its CR number, and
the abilities it expands to. `CR 702` defines most keywords as shorthand for a static, triggered or
activated ability or an alternative cost: Annihilator is an attack trigger, Cycling is an activated
ability from hand, Flashback is a cast option (§1.1) plus an exile replacement. The runtime then keeps
a small set of primitive keywords, roughly the evasion and combat-damage ones, and everything else is
IR the interpreter already runs. This is what the plan's "Keywords are data too" (§2.1) promises;
today it holds only for cost lookup.

### 1.4 Object-model work before the long tail (`CR 707–734`)

Some mechanics aren't keywords; they change what a card or permanent is. Each touches zones, layers
and the stack, and each gets more expensive with every feature built on the single-face assumption.

- **Multi-faced cards**: transforming and modal double-faced cards, split cards, adventures, meld.
  `multiface` is its own unsupported reason (895 abilities) and the plan lists these as a non-goal
  (§6) while leaving room in `faces[]`.
- **Face-down permanents and spells** (`CR 708`: Morph, Disguise, Manifest, Cloak).
- **Copying** (`CR 707`) in full, including copiable values and copies of permanent spells.
- **Text-changing effects** (`CR 612`, layer 3): the audit marks them missing, and Overload is
  approximated with a boolean flag instead.
- **The card frames in `CR 708–734`**: the audit shows 204 subrules missing in that range.

### 1.5 The grammar is the main bottleneck

Unparsed text accounts for 24,585 unsupported abilities, against 4,448 for unimplemented keywords. The
compiler files lean heavily on regular expressions (about 150 regex uses in `compiler/effects.ts`
alone), which gets fragile as templates multiply and overlap.

**Recommendation.** Consider a tokenizer plus a real parser over one shared vocabulary of object
filters, amounts, durations and player references, so that a phrase parsed in a cost also parses in a
trigger or a static. Keep the Phase 11+ loop (top unparsed templates, saved-deck cards first) for
choosing what to add next.

### 1.6 Split `engine.ts` along the rulebook

`engine.ts` is 10,887 lines and `ArenaTable.svelte` is 6,636. Modules that follow the Comprehensive
Rules, such as casting (`CR 601`), resolution (`CR 608`), combat (`CR 506–511`), state-based actions
(`CR 704`), turn structure (`CR 500–514`) and Commander (`CR 903`), map directly onto the audit
reports and let several agents work in parallel without colliding (plan §4). The UI splits the same
way once it renders engine-provided options and prompts instead of mechanic-specific code.

### 1.7 Support claims that can't be faked

The audit already flagged cards marked `fullySupported: true` whose mechanics were silently dropped,
and Overload was listed as implemented while unreachable from the UI.

**Recommendation.**
- Tie each keyword registry entry (§1.3) to its tests and its CR rule; a guard test fails when a
  keyword has no tests. The coverage report reads from the registry.
- Add a small number of scripted full-game tests that use the same action path the UI uses, so that a
  mechanic the engine supports but no client can invoke shows up as a failure.
- Remove conventions that let a test reach a mechanic by a route the UI doesn't have (the `xValue >= 1`
  Overload fallback at `ecd4a3e` is the example).

---

## 2. What this document doesn't cover

- No schedule or phase breakdown; if any of this is adopted, add phases to
  `ENGINE_ARCHITECTURE_PLAN.md` §3 in the usual format.
- No decision on formats other than Commander, or on the plan's stated non-goals (§6). Full coverage
  would require revisiting the multi-face and `CR 613.8` dependency non-goals.
- Performance: none of the recommendations has been measured against the layer cache or the Workers
  cold-start budget.
