# MTG Engine: Master Architecture Plan: Cards as Data

**Status:** Phases 0–10 and Steps A–F are **complete** as of 2026-11-09 (`COMPILER_VERSION = 4`, all 5 architecture ratchet categories at `0`, legacy parser/adapter/ruleTree layer retired). Ongoing card coverage expansion continues under **Phase 11+** (§3) and Comprehensive Rules gap remediation is tracked in [`rules-audit/00-SUMMARY-AND-PRIORITIZED-GAPS.md`](./rules-audit/00-SUMMARY-AND-PRIORITIZED-GAPS.md).

**Goal:** the engine knows **what kinds of things abilities can do**, and nothing about specific
cards. Each card is compiled **once** from its Oracle text into a typed data structure (the
*Card IR*). At runtime the engine interprets that structure and never reads a card's name or rules
text. A card the compiler can't fully understand is **explicitly marked unsupported**; it never
half-works silently.

**Strategy:** incremental replacement. The game stays playable and the suite green after every phase.

---

## 0. Baseline snapshot (2026-11-08, working tree on top of `d991e75`)

These numbers drift; re-measure at the start of every phase.

| Metric | Value | Where |
|---|---|---|
| Lines: `engine.ts` / `ruleTree.ts` / `oracle.ts` / `types.ts` / `ai.ts` | 6839 / 2574 / 1762 / 683 / 393 | |
| Tests | 80 tests in 29 suites; **77 pass, 3 fail** | `magic.test.ts` |
| Literal card-name checks (`.name === '…'`) | engine.ts: 10, others: 0 | |
| Runtime `oracleText` reads outside the parser | engine.ts 34, ruleTree.ts 38, ai.ts 2 | |
| Direct zone mutations (`.battlefield.push(` etc.) | engine.ts: 72 | |
| `evaluatePermanent(` call sites | engine.ts 34, ai.ts 7, ruleTree.ts 3 | |
| Effect kinds handled in `executeParsedEffect` | 39 `case`s | |

**Failing tests at baseline, now resolved (Phase 0):**
- `C-Audit-3`: was a test bug (the helper starts every pool at 10 of each colour). Fixed; passes.
- `C/D-Audit-4`: marked `todo` → **Phase 5/6** (observer triggers ignore layer-4 subtypes). Its body
  also called `getSpellCostRequirement` with the wrong arguments; the calls are fixed, the behaviour
  isn't yet.
- `E3`: marked `todo` → **Phase 9** (`ai.ts` reads printed "can't be blocked").

## Project decisions (2026-11-08)

| Topic | Decision |
|---|---|
| Branch | All work on `engine-rewrite`, one commit (or more) per phase. |
| Comprehensive Rules | `src/lib/rules.txt` (effective 2026-11-06). Cite rules by number from this file. |
| Scryfall data | `~/data/scryfall/oracle-cards.jsonl.gz` (symlink to a dated file; gzipped JSON Lines, ~39k entries including tokens/art cards). **Never** copy it into the repo or into D1/R2. Refresh by downloading a new dated file and moving the symlink. |
| Compiled IR storage | **No D1 table.** The user wants to avoid Cloudflare storage costs and wholesale database rewrites when the IR format changes. Compile at runtime, cache per isolate, keyed by `oracleId + textHash + COMPILER_VERSION`. Phase 1 measures compile time for a 4×100-card game to confirm cold starts are acceptable. |
| Games in progress at deploy | **End them.** On deploy of an incompatible `engineVersion`, active games are finished with a system log entry; no compatibility path. |
| Unsupported abilities | **Decided (2026-11-08): allowed.** Unsupported activated/triggered/spell abilities resolve through the guided manual prompt; unsupported statics are shown as "not enforced". Lobby rule `rules.allowUnsupportedCards`, default **true**, lets a host block them. See §2.7. |
| Saved-deck coverage input | **Decided:** `scripts/magic-coverage.ts --decks <file>` reads a JSON export the user runs (`npx wrangler d1 execute cosmo_users --remote --json --command "SELECT id, commanders_json, cards_json FROM MagicDecks"`). The script never contacts Cloudflare. |
| Saved game state size | *Open, for the user; not scheduled.* A local lobby row was 516 KB because every `CardInstance` and `StackItem` embeds a full `ScryfallCard`. Storing card references (oracleId / printing id) instead could matter for Cloudflare storage costs. |
| UI testing | The user play-tests UI-affecting phases (especially Phase 8) and reports results. |
| CI | `.github/workflows/magic-engine.yml`: tests + ratchet + type check (magic files only) on every push touching the engine. |

### What the current code already does right (keep it)
- **`CardRuleTree` / `getCardRuleTree`** (`ruleTree.ts`) is a memoized compile step with
  actions, triggers and hooks. It's the right idea, and the new IR grows out of it.
- **`TriggerScope`, `TriggerCondition`, `StructuredTriggeredAbility`** (`types.ts`):
  intervening-if conditions are already modelled, and unrecognised conditions don't fire.
- **`moveStackSpellToZone`, `addCountersToPermanent`, LKI fields on `StackItem`, `castMode`.**
- **`guided_resolution`** prompt: a manual resolution path. It becomes the runtime fallback for
  unsupported abilities (see §2.7).
- **`LibrarySearchSpec`**: already a structured, parsed-once spec. It's the model for the rest.

### Root causes this plan removes
1. **Keyword-spotting parser.** `parseSpellOrAbilityEffects` runs ~40 independent
   `low.includes(...)` / regex checks over the whole text. It never knows what text it **didn't**
   understand, so effects silently go missing. It also loses sentence order (Lathril's effects come
   back as `gain_life` before `lose_life_opponents`), and it needs guards like
   `!low.includes('whenever')`.
2. **The runtime re-reads card text.** Static abilities, replacement effects, cast restrictions,
   layer effects and AI heuristics all regex `oracleText` during play (74+ sites). Every such site
   is card knowledge sitting in the engine.
3. **Effect kinds bundle verb and object together** (`destroy_target` vs `destroy_all_creatures`,
   `pump_self_eot` / `pump_target_eot` / `pump_team_eot`). Every new combination needs a new kind.
4. **`dynamicFormula` is a stringly-typed escape hatch** (`'count_subtype:Elf'`,
   `'devotion_blue_gte_library'`, `'top_creature_of_graveyard'`) that only special code understands.
5. **No referents.** A later step can't refer to an earlier step's result ("it", "that creature",
   "that many"). That's why Corpse Dance's delayed trigger needs a name-check skip.
6. **No central zone change and no event bus.** Triggers are dispatched by a set of
   `triggerOnX` functions called from wherever someone remembered to call them, so lands from
   searches missed ETB triggers, for example.
7. **Card-specific protocol messages.** `obeka_end_turn_choice` exists in both `PendingPrompt.kind`
   and `GameActionPayload`.
8. **Layer recomputation cost.** `evaluatePermanent` → `inspectCardContinuousBreakdown` regex-scans
   every permanent's text on every call, and is called from ~44 places, some inside loops.
9. **Hand-entered card data is wrong in places.** `precons.ts` gives Craterhoof "+3/+3", where the
   real card has "+X/+X where X is…", and a name check was papering over it.

---

## 1. Invariants (enforced, not aspirational)

1. **Only the compiler reads rules text.** `oracleText` may be read in: `src/lib/magic/compiler/**`,
   `oracle.ts` (until it's absorbed into the compiler), `search.ts` (Scryfall `o:` queries), and
   Svelte UI for **display only**. Nowhere else.
2. **The engine never compares card names.** It may *display* names (logs, prompts). The only
   name-related step is in the compiler: self-references are normalised to `~` (CARDNAME) before
   parsing.
3. **Every non-reminder character of a card's text is accounted for.** It's either consumed by an
   IR node (which records its source span) or reported as an unparsed span. An ability with
   unparsed spans is `unsupported`.
4. **The IR is never serialised into `GameState`.** Game state references cards. The IR is derived
   from them and cached.
5. **Every phase leaves the game playable and the test suite green**, except the baseline failures
   that other agents own.

### Ratchet test (Phase 0; this is what makes the invariants stick)
Add `src/lib/magic/architecture.test.ts`. It counts the following in `engine.ts`, `ruleTree.ts`,
`ai.ts` and any new runtime file:
- `/\.name\s*(===|!==)\s*['"]/` (literal name comparisons)
- `/oracleText/` (rules-text reads)
- `/\.(battlefield|graveyard|exile|hand|library|command)\.(push|unshift|splice)\(/` outside the
  zone module (direct zone mutation)

It fails if any count is **above** its allowance in a checked-in table
(`architecture-allowances.json`). Each phase lowers the allowance, and the final values are zero.
**Raising an allowance needs a written justification in the PR.** This stops concurrent agents from
re-adding card special cases while the migration is in progress.

---

## 2. Target architecture

```
Scryfall bulk data / deck JSON
          │  (ScryfallCard: name, typeLine, oracleText, …)
          ▼
┌───────────────────────┐   normalise (~ for self-refs, strip reminder text,
│ compiler/             │   split abilities & sentences)
│  lexer → grammar      │   parse each sentence with a real grammar
│  → CardDefinition IR  │   record source spans; collect unparsed spans
└───────────────────────┘
          │  CardDefinition (cached by oracleId + text hash + COMPILER_VERSION)
          ▼
┌───────────────────────────────────────────────────────────────────────┐
│ runtime/                                                              │
│  zones.ts      single moveObject() → emits ZoneChange events + LKI    │
│  events.ts     event bus; trigger matching from IR TriggerDefs        │
│  layers.ts     continuous effects from IR StaticDefs, cached per      │
│                state version (CR 613 order + timestamps/dependencies) │
│  replace.ts    replacement/prevention effects from IR (CR 614/616)    │
│  costs.ts      cost payment from IR CostDefs                          │
│  effects.ts    interpreter for IR EffectStep lists with bindings      │
│  choices.ts    generic choice protocol (targets, may, modes, N cards) │
│  stack.ts / turn.ts / combat.ts / sba.ts  (rules framework, no cards) │
└───────────────────────────────────────────────────────────────────────┘
          ▲                                   ▲
       ai.ts (reads IR + evaluated state)   ArenaTable.svelte (displays text,
                                             renders generic choices)
```

### 2.1 Card IR: type sketch (new file `src/lib/magic/ir.ts`, *not* `types.ts`)

Field-level detail is settled in the phases. This is the shape:

```ts
export interface CardDefinition {
  oracleId: string;
  compilerVersion: number;
  faces: FaceDefinition[];              // MDFC/adventure/split later; one face to start
}
export interface FaceDefinition {
  characteristics: { types: string[]; subtypes: string[]; supertypes: string[];
                     power?: Amount | number; toughness?: Amount | number; colors: ManaColor[] };
  spell?: SpellDef;                     // instants/sorceries: what resolving does
  abilities: AbilityDef[];
}
export type AbilityDef =
  | { kind: 'keyword'; keyword: KeywordDef; span: Span }          // Flying, Ward {2}, Equip {1}, Overload {6}{U}…
  | { kind: 'activated'; cost: CostDef[]; effect: EffectStep[]; timing: Timing; isMana: boolean; span: Span }
  | { kind: 'triggered'; trigger: TriggerDef; condition?: Condition; effect: EffectStep[]; span: Span }
  | { kind: 'static'; static: StaticDef; span: Span }
  | { kind: 'replacement'; replacement: ReplacementDef; span: Span }
  | { kind: 'unsupported'; text: string; span: Span; reason: string };

// ---- Filters: one selector language for targets, costs, counts, triggers and statics
export interface ObjectFilter {
  zone?: ZoneType | ZoneType[];
  types?: string[]; subtypes?: string[]; supertypes?: string[]; notTypes?: string[];
  controller?: 'you' | 'opponent' | 'any'; owner?: 'you' | 'opponent' | 'any';
  tapped?: boolean; token?: boolean; other?: boolean;  // "other" = not the source
  colors?: ManaColor[]; manaValue?: Compare; power?: Compare;
  attacking?: boolean; blocking?: boolean;
}
export interface PlayerFilter { relation: 'you' | 'opponent' | 'each_opponent' | 'any' | 'target'; }

// ---- Amounts: replaces dynamicFormula strings
export type Amount =
  | { k: 'const'; n: number }
  | { k: 'x' }
  | { k: 'count'; of: ObjectFilter }                       // "for each Elf you control"
  | { k: 'stat'; of: Ref; stat: 'power' | 'toughness' | 'manaValue' }
  | { k: 'devotion'; colors: ManaColor[] }
  | { k: 'resultCount'; of: BindingName }                  // "that many"
  | { k: 'life'; of: PlayerRef }
  | { k: 'sum' | 'min' | 'max'; args: Amount[] };

// ---- Costs
export type CostDef =
  | { k: 'mana'; cost: string } | { k: 'tapSelf' } | { k: 'untapSelf' }
  | { k: 'tapOthers'; count: Amount; filter: ObjectFilter }     // "Tap ten untapped Elves you control"
  | { k: 'sacrifice'; count: Amount; filter: ObjectFilter | 'self' }
  | { k: 'discard'; count: Amount; filter?: ObjectFilter; random?: boolean }
  | { k: 'payLife'; amount: Amount } | { k: 'loyalty'; delta: number }
  | { k: 'removeCounters'; counter: CounterType; count: Amount; from: 'self' | ObjectFilter }
  | { k: 'exileFrom'; zone: ZoneType; count: Amount; filter?: ObjectFilter };

// ---- Effects: an ORDERED list of verb steps whose results later steps can refer to
export interface EffectStep {
  verb: Verb;                        // 'destroy' | 'exile' | 'move' | 'draw' | 'damage' | 'gainLife'
                                     // | 'loseLife' | 'createToken' | 'putCounters' | 'search'
                                     // | 'pump' | 'grant' | 'tap' | 'untap' | 'copy' | 'counterSpell'
                                     // | 'addMana' | 'phaseOut' | 'extraTurn' | 'endTurn' | 'win' | 'lose' …
  subject: Selector;                 // who/what the verb acts on (target, all matching, self, a binding)
  actor?: PlayerRef;                 // who performs it ("its controller creates…", "target player draws")
  amount?: Amount;
  params?: Record<string, unknown>;  // verb-specific (token spec, zone, duration, counter type)
  optional?: { chooser: PlayerRef }; // "you may"
  bindAs?: BindingName;              // makes the result referable: "it", "that creature", "those cards"
  delayed?: { trigger: TriggerDef; effect: EffectStep[] };  // "At the beginning of the next end step, exile it"
  span: Span;
}
export type Selector =
  | { k: 'self' } | { k: 'binding'; name: BindingName }
  | { k: 'target'; index: number; spec: TargetSpec }
  | { k: 'all'; filter: ObjectFilter } | { k: 'player'; filter: PlayerFilter }
  | { k: 'eventObject' };            // the object the trigger was about ("that creature" in a trigger)

// ---- Triggers
export interface TriggerDef {
  event: EventKind;                  // 'zoneChange' | 'cast' | 'attacks' | 'blocks' | 'dealsDamage'
                                     // | 'phaseBegin' | 'counterPlaced' | 'becomesTarget' | 'attached' …
  filter: EventFilter;               // e.g. zoneChange{to:'battlefield', object: {types:['Land'], controller:'you'}}
  scope?: TriggerScope;              // existing type: controller_turn | each_turn | opponent_turn
  fromZone?: ZoneType;               // trigger functions from the graveyard (Nether Shadow) etc.
}
export type Condition =               // replaces the existing TriggerCondition union
  | { k: 'compare'; left: Amount; op: '>=' | '<=' | '=' | '>' | '<'; right: Amount }
  | { k: 'and' | 'or'; of: Condition[] } | { k: 'not'; of: Condition }
  | { k: 'graveyardAbove'; filter: ObjectFilter; count: number }  // CR 404.2-sensitive
  | { k: 'isTurnOf'; player: PlayerRef };

// ---- Statics & replacements
export type StaticDef =
  | { k: 'continuous'; layer: Layer; affected: ObjectFilter | 'attachedTo' | 'self'; mod: LayerMod; condition?: Condition }
  | { k: 'costModifier'; affects: SpellOrAbilityFilter; delta: CostDelta; who: PlayerFilter }
  | { k: 'ruleModifier'; rule: RuleModKind; who: PlayerFilter; params?: Record<string, unknown> }
      // e.g. 'noMaxHandSize','cantLose','opponentsCantWin','castOnlySorcerySpeed','oneSpellPerTurn',
      //      'castOnlyFromHand','castAsThoughFlash','attackTax','playerHexproof','searchControl'
  | { k: 'multiplier'; what: 'counters' | 'tokens' | 'triggers'; factor: number; filter: … };
export interface ReplacementDef {
  replaces: EventPattern;            // "would be put into a graveyard", "would draw … with empty library"
  with: EffectStep[] | { k: 'skip' } | { k: 'modify'; … };
  who?: PlayerFilter;
}
export interface Span { start: number; end: number }   // offsets into normalised oracle text
```

Design notes:
- **Verb × selector, not combined kinds.** `destroy` + `all{types:[Creature]}` replaces
  `destroy_all_creatures`; `pump` + `self` | `target` | `all{controller:you}` replaces three kinds.
- **Bindings** remove whole classes of hacks: "Exile target creature. Its controller gains life
  equal to its power" is `exile(target#0) bindAs:t` → `gainLife(actor: controllerOf(t, lki),
  amount: stat(t, power, lki))`. Corpse Dance becomes `move(top creature card of graveyard →
  battlefield) bindAs:r` → `grant(r, haste, eot)` → `delayed(nextEndStep, exile(r))`.
- **Keywords are data too.** The keyword table maps a keyword to its rules (`Overload` = an
  alternative cost whose `target` selectors become `all` with the same filter, CR 702.96). Adding a
  keyword never touches the engine.

### 2.2 Compiler (`src/lib/magic/compiler/`)
- **Normalise:** strip reminder text, replace the card's full name, its short name (before the
  comma) and "this creature/permanent/spell/card" with `~`. Split into abilities (lines) and
  sentences. Record offsets.
- **Parse with a real grammar**, either a hand-written recursive-descent parser over tokens or a
  parser-combinator. Not independent regex scans. Productions mirror Oracle templating: costs `:`
  effects; `When/Whenever/At` trigger `,` [intervening `if` …,] effects; "X spells you cast cost";
  "Creatures you control get/have"; "If … would …, … instead".
- **Coverage accounting:** every token is consumed by a production or ends up in an unparsed span.
  An ability with unparsed spans compiles to `{kind:'unsupported', text, reason}`. A card is
  `fullySupported` iff it has no unsupported abilities.
- **Cache:** `Map<oracleId + textHash + COMPILER_VERSION, CardDefinition>`. See §2.6 for persistence.

### 2.3 Runtime: zones and events
- One `moveObject(state, obj, toZone, opts)` performs **every** zone change. It captures LKI,
  applies replacement effects (§2.5), bumps `objectVersion`, assigns timestamps and **emits a
  `ZoneChange` event**.
- An event queue is collected during an action. After the action, trigger matching walks the
  `TriggerDef`s of objects in the relevant zones (battlefield, plus `fromZone` triggers such as the
  graveyard) and puts triggered abilities on the stack in APNAP order (CR 603.3b), re-checking
  intervening-if conditions on resolution (CR 603.4).
- `triggerOnEtb`, `triggerOnAttack`, `triggerOnSpellCast`, `triggerOnAttach` and the
  upkeep/end-step loops all become **event emission**.

### 2.4 Runtime: layers
- `computeContinuousState(state)` collects every `StaticDef{k:'continuous'}` from the IR of
  objects on the battlefield (and command zone where applicable), then applies layers 1–7d in
  CR 613 order with timestamps (dependency ordering, CR 613.8, can come later). It stores
  `EvaluatedPermanent` per object.
- **Cached by `state.version`**, a counter bumped on every mutation, so the
  `evaluatePermanent` call sites become map lookups. Ability-removal effects (layer 6) remove
  `AbilityDef`s from the evaluated object; everything downstream (triggers, costs, statics) reads
  evaluated abilities, so "lost all abilities" works everywhere automatically.

### 2.5 Runtime: replacement and rule modifiers
- `RuleModifier`s and `ReplacementDef`s replace the bespoke helpers `playerCannotLoseGame`,
  `playerCannotWinGame`, `checkGraveyardReplacementZone`,
  `checkGlobalCastPermissionsAndRestrictions`, `getLibrarySearchInterceptor`, hand-size checks, the
  attack tax and player hexproof. Each becomes one generic query:
  `activeRuleModifiers(state, kind, player)` / `applicableReplacements(state, event)`.
- When several replacements apply, the affected player/controller chooses (CR 616.1) via the choice
  protocol.

### 2.6 Persistence and deployment
- Games are saved as `MagicLobbies.game_state_json` in D1. Every `CardInstance.card` and
  `StackItem.card` embeds a full `ScryfallCard`. **Keep that for display, but never add IR to
  state.** The runtime looks up `CardDefinition` by `card.oracleId` (fall back to `card.id`) from
  the cache.
- The engine runs on Cloudflare Workers (`@sveltejs/adapter-cloudflare`). Module caches are
  per-isolate, so a cold start recompiles. **Decided:** no persisted IR (no D1 table); compile at
  runtime and cache in memory. **Measured in Phase 1:** 400 distinct cards (a 4×100-card game with no
  repeats, both caches empty) compile in ~40 ms in Node 24 (~0.1 ms/card). Not measured in workerd,
  but even several times slower is negligible next to a request, so **the per-isolate in-memory
  cache is enough**; no build-time bundle is needed. Revisit if the grammar compiler is much slower
  than the adapter.
- Add `GameState.engineVersion`. **Decided:** games created under an older version are ended at
  deploy with a system log entry.
- Shrinking state (storing printing IDs instead of full card objects) is a separate,
  optional cleanup and not required by this plan.

### 2.7 Unsupported cards: defined behaviour
- **Deck builder** (`+page.svelte`, `scryfall.ts` `validateCommanderDeck`): show a per-card badge
  "N abilities not automated", listing the unsupported spans.
- **At runtime**, a supported ability runs normally. An unsupported **activated/triggered/spell**
  ability goes on the stack as usual and resolves via the existing `guided_resolution` prompt,
  where the controller applies the effect manually. An unsupported **static/replacement** ability is
  shown on the card as "not enforced" and is logged once when the permanent enters.
- A lobby rule can block unsupported cards (`rules.allowUnsupportedCards`, default true).

### 2.8 Choices: generic protocol
- Replace card-specific prompt kinds (e.g. `obeka_end_turn_choice`) with a single choice model:
  `{ kind: 'yesNo' | 'chooseObjects' | 'chooseMode' | 'chooseNumber' | 'orderObjects' |
  'chooseReplacement', min, max, candidates, sourceAbility }`. Add a matching single
  `GameActionPayload` `{type:'choice', promptId, answer}`.
- **This is a client/server protocol change.** `ArenaTable.svelte` renders choices generically, and
  bots answer through the same interface in `ai.ts`.

---

## 3. Phases

Each phase lists: **owns** (files only this phase's agent edits; others treat them as read-only
while it runs), **entry**, **work**, **exit**, and **ratchet target**.

### Phase 0: Guardrails ✅ done 2026-11-08
- **Owns:** `architecture.test.ts`, `architecture-allowances.json` (new).
- **Done:**
  - Ratchet test added. It scans every non-exempt `.ts` file under `src/lib/magic`, recursively, so
    new files default to an allowance of 0. It fails if a count goes **up** or **down** without the
    table being updated, so progress is locked in. Verified that it catches a new file containing a
    name comparison.
  - CI workflow added (tests + ratchet + magic-only type check).
  - Baseline repaired: suite green (83 pass, 2 todo, 0 fail) and 0 type errors in magic files.
  - Two engine bugs that type checking exposed were fixed, each with a test written to fail first:
    - `castMode` was silently dropped by `checkSpellCastLegality`, `hasRequiredLegalTargets` and
      `validateChosenTargets`. An explicit overload cast with no X value was rejected for lacking a
      target, and an explicit normal cast with `xValue >= 1` skipped target checks. Now decided by
      `isOverloadCastMode` everywhere.
    - Player hexproof recognised only two exact phrases plus a Shalai name check. The C-Audit-5
      assertion passed without testing anything because its arguments were in the wrong order.
      Replaced by one grammar rule ("you" as a subject of "have hexproof") reading the copiable card.
- **Ratchet after Phase 0:** cardNameComparison engine.ts 9; oracleTextRead engine.ts 44,
  ruleTree.ts 38, ai.ts 2; directZoneMutation engine.ts 72.
- **Lesson for every phase:** `node --test` doesn't type-check. Always run the type check
  (`npx svelte-check --tsconfig ./tsconfig.json --output machine | grep 'src/lib/magic'`) as well;
  the wrong-argument calls above went unnoticed for that reason.
- **Not done (moved to Phase 1):** `scripts/magic-coverage.ts`.

### Phase 1: IR types, compiler shell, coverage tooling, key decisions ✅ done 2026-11-08
- *Baseline at start: 83 pass, 2 todo, 0 fail; ratchet unchanged from Phase 0.*
- **Owns:** `ir.ts` (new), `compiler/**` (new), `scripts/magic-coverage.ts`.
- **Entry:** Phase 0 done.
- **Work:**
  1. Define `ir.ts` per §2.1.
  2. Write `compileCard(card): CardDefinition`. **First as an adapter** that converts today's
     `CardRuleTree` + `parseStructuredTriggeredAbilities` + `parseActivatedAbilities` output into IR,
     marking as `unsupported` any line no existing parser claimed. No engine changes yet.
  3. **Coverage script:** streams `~/data/scryfall/oracle-cards.jsonl.gz` (path passed as an
     argument; gzipped JSON Lines, read with `zlib` + `readline`; **never committed**). Skip
     non-game layouts (`token`, `art_series`, `emblem`, `double_faced_token`, etc.) and report them
     separately. Compiles every card and writes a report:
     % of cards fully supported, % of abilities supported, and **unparsed spans clustered by
     normalised template** (numbers → `N`, subtypes → `<SUBTYPE>`, `~` kept), ranked by number of
     cards affected. Also reports the coverage of the cards in `precons.ts` and in all saved decks.
  4. **Data integrity test:** every card in `precons.ts` matches the bulk data's `oracle_text`,
     `type_line` and `mana_cost`. Fix the mismatches (Craterhoof at least).
  5. Write down the §2.6 decisions (cache/persist, `engineVersion` policy) and the §2.7 unsupported
     behaviour in this file.
- **Exit:** `compileCard` runs over the whole bulk file without throwing; the coverage report
  exists; IR snapshot tests exist for ~20 representative cards.
- **Ratchet:** unchanged.
- **Done:**
  - `ir.ts` per §2.1, with these settled details: instant/sorcery effects are an `AbilityDef` of kind
    `spell` (no separate `spell` field); `addMana` has `mana` (exact symbols) vs `manaChoice`
    (one of a set, or symbolic `'any'` / `'commanderIdentity'`, so IR never depends on the deck);
    `Selector` has `playerRef` and `none`; `UnsupportedAbility` carries a `reason`
    (`unparsed`, `keyword_not_implemented`, `static_not_compiled`, `multiface`) and the
    `unparsed` spans; CR 305.6 basic-land mana abilities are `intrinsic` with an empty span.
  - `compiler/normalize.ts` (reminder text, `~`, ability words, sentence spans),
    `compiler/adapter.ts` (legacy parser output → IR), `compiler/index.ts` (`compileCard`, cache,
    `COMPILER_VERSION`). Legacy parsers always get the raw card and a fixed WUBRG identity.
  - `scripts/magic-coverage.ts`; the report is `COVERAGE.md`. First run: 35,062 game cards,
    **0 compiler errors**, 12.6% fully supported (24.4% ignoring statics); precon cards 53.2%
    (76.3%). **These are legacy-claimed numbers, an upper bound**: a sentence counts as claimed if
    the legacy parser finds any effect in it, and that parser often drops part of a sentence
    (Felidar's "if you have 40 or more life", "+X/+X where X is…"). Real coverage comes only
    from the grammar.
  - `compiler/compiler.test.ts`: IR snapshots for 25 real precon cards + 3 synthetic cards
    (`__snapshots__/ir.json`, regenerate with `UPDATE_IR_SNAPSHOTS=1`), a rename-invariance test,
    span checks, and the precon integrity test against `precon-oracle.fixture.json` (generated
    from bulk data by the coverage script; the bulk file itself is never committed).
  - `precons.ts`: all **63** cards whose text differed from Oracle were replaced with Oracle text
    (Craterhoof, Toxic Deluge, Jeska's Will, Chaos Warp, Casualties of War, … plus "enters"
    templating). Legacy-parser output was diffed card by card before and after (getCardRuleTree,
    suspend, delayed triggers, mana, additional costs, structured triggers). Consequences:
    - Instants/sorceries the legacy parser no longer understands at all resolve through guided
      manual resolution: Toxic Deluge, Jeska's Will, Chaos Warp, Expressive Iteration.
    - §2.7 isn't wired into the runtime yet, so everything else that lost support **silently does
      less**: Scourge of Valkas's ETB trigger no longer fires; Crystalline Crawler has no ETB
      counters or mana ability (Converge isn't implemented); Sign in Blood draws for the caster
      and loses no life; Arcane Denial counters but its delayed draws don't happen; new activated
      abilities on Goldspan Dragon, Lathliss, Maskwood Nexus and Scourge of Valkas show up but
      may resolve with no effect.
    - Improvements: Craterhoof gets +X/+X; Lathril's combat-damage trigger now fires (see below).
    - Regressions found and fixed, each with a test written to fail first (test 31):
      reminder text doubled suspend costs (Rift Bolt `{R}{R}`); "draw two cards and lose 2 life"
      lost no life; "This land enters tapped." entered untapped; Menace's reminder text made a
      creature unblockable (engine and bots). The last two moved into `cardEntersTapped` /
      `cardHasPrintedUnblockable` in `oracle.ts`, lowering the ratchet (engine.ts 44 → 40,
      ai.ts 2 → 1).
    - "When this enchantment/Aura/artifact enters" wasn't a self-ETB trigger for the legacy
      parser; widened in `oracle.ts` (test 30 written to fail first).
    - Song of the Dryads now reads "is a colorless Forest land."; losing other types and
      rules-text abilities follows from CR 205.1a / 305.7, which the legacy layer code doesn't
      apply. D-Audit-1/2 now use a synthetic Aura with the explicit wording; **D-Audit-5** (real
      card) is `todo` → **Phase 6**.
  - Found, not fixed (→ **Phase 5**): `getCardRuleTree` splits a trigger header at the first
    comma, so an observer/combat-damage trigger written with a full name containing a comma
    ("Whenever Lathril, Blade of the Elves deals …") never matches. Current Oracle text uses the
    short name, so precon Lathril works; imported cards with older templating may not.
  - `--decks` checked against a synthetic export in the wrangler envelope; the local D1 has no
    decks, so the real saved-deck number needs the `--remote` export.
  - Suite: 122 pass (incl. 34 compiler tests), 3 todo, 0 fail; 0 magic type errors.
- **Follow-up: cost grammar (2026-11-08), alongside the adapter.** `compiler/costs.ts` is the
  first real grammar production: activated-ability costs and "As an additional cost to cast ~, …"
  sentences, with an object-phrase parser (`parseObjectPhrase`) that later productions can reuse.
  It does **not** feed `compileCard` or the engine yet; Phase 4 switches over after Phase 2 merges.
  `scripts/magic-costs-diff.ts` compares it with the adapter (report: `COST-GRAMMAR.md`):
  - 10,226 costs in the bulk data: 7,318 agree, **1,510 only the grammar understands** on lines the
    adapter claimed (sacrifice/discard/exile/remove-counter/tap-untapped costs), 1,071 neither.
    286 more sit on lines the legacy parser never made into an ability (202 of them the grammar
    parses); those are ability-level gaps, not cost gains. Precons: 33 agree, 2 grammar-only,
    nothing else.
  - The 21 "adapter only" and 20 "differ" rows are all the adapter (= the engine's
    `parseAdditionalCostsAndRestrictions`) over-claiming, so **these are live engine bugs for
    Phase 4**: "discard a card or pay 3 life" (Bitter Triumph) is enforced as *both*; "sacrifice a
    creature or pay {3}{B}" as a mandatory sacrifice; optional "you may sacrifice" as mandatory;
    "sacrifice a creature with power 4 or greater" as any creature; "an artifact or creature" as
    artifact only; "discard a card at random" as a chosen discard. Confirmed in the cast path
    (`engine.ts`, "Pay additional costs"): every part found is checked and paid. The engine also
    picks the sacrificed permanent (cheapest, tokens first) and the discarded cards (first in hand)
    itself instead of asking the player. No precon card is affected; imported cards are (Bitter
    Triumph, Bone Shards, Lightning Axe, Savage Order, …).
  - Not yet in the grammar (by cards affected): `Discard ~` (channel-style, 79), energy `{E}`
    (41+), keyword/ability-word prefixes before a cost ("Channel —", "Exhaust —", "Boast —"),
    counter kinds outside `CounterType` (spore, oil, quest, …), "Return … to its owner's hand",
    choices between costs, and conjunctive filters ("artifact creature", "Elf Warrior"), which
    `ObjectFilter`'s any-of lists can't express.
  - `ir.ts` (additive): `exileFrom.filter` may be `'self'`.
- **Follow-up: trigger-condition grammar (2026-11-08), alongside the adapter.** `compiler/triggers.ts`
  parses the head of a triggered ability and its intervening-if clause into `TriggerDef` +
  `Condition` and reports where the effect starts (for the effect grammar to pick up). Like the
  cost grammar, it doesn't feed `compileCard` or the engine yet; Phase 5 owns the switch-over.
  `scripts/magic-triggers-diff.ts` compares it with the adapter (report: `TRIGGER-GRAMMAR.md`); the
  two diff scripts share `scripts/magic-diff.ts`.
  - 15,888 trigger heads in the bulk data: the grammar parses **11,182 (70%)**; 2,982 agree with the
    adapter. Precons: 36 of 37 parsed; 27 agree, 4 differ, 1 adapter-only.
  - **Engine bugs for Phase 5** (all "differ" / "adapter only" rows are the legacy rule tree or
    `parseStructuredTriggeredAbilities` dropping part of the trigger):
    - "enters **or attacks**" / "enters **or dies**" / "attacks **or blocks**" fire on the first event
      only (50 + 15 + 4 cards, …);
    - "cast **or copy** an instant or sorcery spell" ignores copies: **precon Archmage Emeritus,
      Storm-Kiln Artist, Veyran**;
    - "combat damage to a player **or planeswalker**" ignores planeswalkers: **precon Grateful
      Apparition**;
    - "attacks **or becomes the target of a spell**" fires on attacks only: **precon Goldspan Dragon**;
    - qualifiers are ignored, so the trigger fires unconditionally: "while saddled", "and isn't
      blocked", "enters untapped", "attacks a player", "enters from your graveyard";
    - intervening-if clauses the rule tree doesn't model are dropped on cast triggers ("if at least
      four mana was spent to cast it"), so those fire every time;
    - a few lines are matched to the wrong event (Springheart Nantuko's landfall line becomes an
      "attached" trigger; Sanguine Soothsayer's attack trigger becomes an ETB).
  - Not yet in the grammar (long tail): face-up/morph, "second card/spell each turn", cycle,
    mutate, specialize, kicker and "this turn" conditions, "attacks alone", "deals damage to an
    opponent", sacrifice/discard/scry events.
  - `ir.ts` (additive): event kinds `becomesBlocked`, `becomesTapped`, `dealtDamage`, `drawCard`,
    `gainLife`; `EventFilter.object` may be `'attachedTo'`; `damageTo: 'playerOrPlaneswalker'`;
    `EventFilter.orCopy`; `TriggerDef.or` for "enters or attacks". `adaptCard`'s optional log is now
    `AdapterLog` (costs and triggers).
- **Follow-up: static and replacement-effect grammar (2026-11-08), alongside the adapter.**
  `compiler/statics.ts` parses static-ability sentences into `StaticDef` (continuous effects with
  their layer, cost modifiers, rule modifiers, restrictions, multipliers) and `ReplacementDef`, with
  22 unit tests in `compiler/statics.test.ts`. It does **not** feed `compileCard` or the engine yet;
  Phases 4, 5, 6 and 7 own the switch-over. `scripts/magic-statics-diff.ts` (report:
  `STATIC-GRAMMAR.md`) compares it (A) with the Phase 1 adapter (which only compiles cost-modifier
  and multiplier board hooks and leaves every other static line as `static_not_compiled`) and (B)
  with what the runtime (`evaluatePermanent`, the rule helpers in `ruleTree.ts`/`engine.ts`, and
  `cardEntersTapped`) actually does on synthetic probe boards:
  - **Part A (vs adapter):** 10,619 static lines in the bulk data: the grammar parses **3,142
    (30%)** — 47 agree, 0 grammar-only, 20 differ, 42 adapter-only, 0 neither, plus **3,075** on
    lines the adapter left as `static_not_compiled` (7,435 unparsed). Precons (48 lines): **40 of 48
    parsed** — 2 agree, 0 grammar-only, 2 differ (**Corpsejack Menace**, **Veyran, Voice of
    Duality**), 0 adapter-only, 0 neither, plus 36 parsed and 8 unparsed on unclaimed lines.
  - **Part B (vs runtime on probe boards):** 9,760 observable lines in the bulk data: **1,458
    agree**, **767 grammar-only**, **58 differ**, **613 adapter-only (runtime-only)**, 6,864
    neither. Precons (37 lines): **26 agree**, **2 grammar-only** (**Storm-Kiln Artist**; plus
    Chromatic Lantern, whose granted mana ability isn't probed on the board), **1 differ** (**Song
    of the Dryads**), **2 adapter-only** (**Maskwood Nexus** and **Opposition Agent**, whose
    multi-sentence lines have a second sentence outside the grammar while the runtime matches the
    first), 6 neither.
  - **Cross-check against Phase 6 known-wrong layer snapshots:**
    - **Song of the Dryads (CR 205.1a / 305.7, D-Audit-5):** caught directly as the 1 precon
      "differ" row in Part B (`Enchanted permanent is a colorless Forest land.`). Setting a basic
      land subtype removes rules-text abilities (`lostAllAbilities: true`), whereas
      `permanentHasLostAllAbilities` only strips abilities when the text literally says `loses all
      … abilities` (or for `nonbasic lands are …`).
    - **Blood Moon + Urborg dependency (CR 613.8):** each card agrees in isolation on a single-source
      probe board; the bug is the two-card layer-4 interaction (`inspectCardContinuousBreakdown`
      runs Pass B `each land is a Swamp in addition` after Pass A without checking that Urborg lost
      its abilities under Blood Moon).
    - **Negative power clamping (CR 107.1b):** `inspectCardContinuousBreakdown` clamps
      `effectivePower` at 0 (`Math.max(0, workingPower)`).
    - **Layer 5 (colour) and Layer 2 (control-changing):** confirmed unimplemented in
      `evaluatePermanent` (the grammar emits layer-5 `setColors` for Kenrith's Transformation, Song
      of the Dryads, Imprisoned in the Moon; the runtime drops colour changes).
  - **Live engine bugs revealed for Phase 6 (layers) and Phase 7 (replacements / rule modifiers),
    plus Phase 4/5 board hooks:**
    - **Precon Storm-Kiln Artist (`~ gets +1/+0 for each artifact you control`) is a no-op:**
      `inspectCardContinuousBreakdown` has no self `"for each"` P/T branch, so Storm-Kiln Artist
      stays 2/2 regardless of artifact count (also Nim Lasher, Gatebreaker Ram, …).
    - **Attached and anthem `"for each"` P/T modifiers ignore the count and apply a flat buff
      (`ruleTree.ts:1945, 2071`):** `/(?:equipped|enchanted) creature gets ([+-]\d+)\/([+-]\d+)/i`
      drops `for each …`, so `All That Glitters`, `Nettlecyst`, `Ethereal Armor`, `Blackblade
      Reforged`, `Pennon Blade`, `Improvised Arsenal`, `Strong Back`, `Malefic Scythe` always give a
      flat `+1/+1` (or `+2/+2`), and `Lashwrithe` (`for each Swamp`), `Granite Grip` (`for each
      Mountain`), `Armored Ascension`, `Claws of Valakut` buff even with **zero** matching lands.
      `Hold the Gates` (`Creatures you control get +0/+1 for each Gate you control and have
      vigilance`) gives a flat `+0/+1` with 0 Gates and drops `vigilance`.
    - **Reminder text on Auras/Equipment leaks fake keywords (`ruleTree.ts:1922`):** the attached
      keyword scanner reads raw `oracleText` without stripping reminder text. Granting `reach` with
      reminder text `*(It can block creatures with flying.)*` (`Spider Climb`, `Frog Tongue`,
      `Spidersilk Net`) also grants **flying**; granting `flying` with reminder text `*(It can't be
      blocked except by creatures with flying or reach.)*` (`Shimmering Wings`, `Future Flight`,
      `Experimental Armor`, `Mechanical Glider`) also grants **reach**.
    - **Negative or quoted keywords on Auras/Equipment are granted as static keywords
      (`ruleTree.ts:1922`):** `Sky Tether` (`Enchanted creature has defender and loses flying.`)
      **grants flying** instead of removing it; `Deviant Glee` (`… has "{R}: ~ gains trample until
      end of turn."`), `Lunarch Mantle` (`… gains flying until end of turn."`), and `Giant's Amulet`
      (`… has "~ has hexproof as long as it's untapped."`) permanently grant `trample`, `flying`, and
      `hexproof`.
    - **`"As long as …"` conditions on anthems and Auras/Equipment are ignored (`ruleTree.ts:1922,
      1945, 2071`):** `Weapons Trainer` (`… as long as you control an Equipment`), `Nadaar, Selfless
      Paladin` (`… as long as you've completed a dungeon`), `Abzan Runemark`, `Fists of the Demigod`,
      `Serra's Boon`, `Armament of Nyx`, `Rune of Sustenance` apply unconditionally.
    - **`Enchanted permanent gets +X/+Y` drops the P/T buff (`ruleTree.ts:1945`):** the regex only
      matches `equipped|enchanted creature gets`, so `Roadside Assistance`, `Silken Strength`,
      `Lightwheel Enhancements` grant the keyword but drop the P/T delta.
    - **Missing keywords and over-broad hexproof on attached grants (`ruleTree.ts:1066, 1930`):**
      `CANONICAL_COMBAT_KEYWORDS` omits `ward {N}`, `fear`, `intimidate`, `wither`, `horsemanship`,
      `shadow`, `prowess` (`Plate Armor`, `Winged Boots`, `Lavaspur Boots`, `Sheltered by Ghosts`,
      `Cursed Flesh`, `Blight Sickle`, `Nuka-Nuke Launcher`), while `\bhexproof\b` turns `hexproof
      from monocolored` (`Dragonfire Blade`) into unconditional `hexproof`.
    - **Multipliers drop their scope and cause (`ruleTree.ts:753, 766`):** **precon Corpsejack
      Menace** (creatures you control, `+1/+1` counters only) and **precon Veyran, Voice of Duality**
      (caused by casting/copying an instant or sorcery) compile to unscoped hooks; any card containing
      `triggers an additional time` (`Panharmonicon`, `Elesh Norn, Mother of Machines`, `Drivnod`,
      `Isshin`, `Wulfgar`, `Ancient Greenwarden`, `Roaming Throne`, `Harmonic Prodigy`, `Delney`, …)
      compiles to the same instant/sorcery-only trigger doubler, and `Devouring Hellion` (`… enters
      with twice that many +1/+1 counters`) becomes a board-wide counter doubler.
    - **Spell cost-modifier hook drops qualifiers, conditions, and `"for each"` scaling
      (`ruleTree.ts:724`):** `Bontu's / Kefnet's / Oketra's / Hazoret's / Rhonas's Monument` and
      `Obscuring Aether` drop colour / face-down filters and discount all creature spells; `Starnheim
      Courser` and `Mana Matrix` drop the first type in `A and B spells`; `Animar`, `Hamza`, `Rakdos,
      Lord of Riots`, `Mindsplice Apparatus`, `Magnus the Red`, `Mizzix`, `Font of Magic` drop `for
      each …` and apply a flat `{1}` discount; `Centaur Omenreader` and `Gran-Gran` ignore `as long
      as …`.
    - **`cardEntersTapped` (`oracle.ts`) ignores `"unless …"`:** every checkland/fastland/slowland
      (`~ enters tapped unless …` — `Glacial Fortress`, `Rockfall Vale`, `Mystic Sanctuary`, `Sodden
      Verdure`, …) always enters tapped; only shocklands (`pay 2 life`) are exempted.
  - **Not yet in the grammar:** `"As ~ enters, choose a creature type / color / opponent"` and
    shockland `"pay N life"` replacements; `"~ enters tapped unless …"` and kicked ETB counters;
    `"You may look at the top card of your library any time"` / `"Play with the top card … revealed"`
    / `"You may play an additional land …"`; evasion qualifiers (`"can't be blocked by creatures with
    power N or less"`, `"can't be blocked by more than N creature"`, `"can block only creatures with
    flying"`, `"must be blocked if able"`); Layer 2 control (`"You control enchanted creature"`);
    non-mana quoted ability grants and compound `"gets +X/+Y and has '<ability>'"` sentences; `"for
    each"` P/T in steps other than 1 (`"+2/+2 for each …"`, which needs multiplication in `Amount`)
    and non-self `"for each"` spell discounts (`Animar`, `Hamza`, `Mizzix`); trigger doublers scoped
    by source filter (`"ability of an Ally / Wizard / legendary creature you control"`, `Roaming
    Throne`) rather than triggering cause; conjunctive filters (`"Artifact creatures you control"`,
    `"Black creature spells"` where `parseObjectPhrase` needs subtype/type conjunctions); off-board
    characteristic/type clauses (**precon Maskwood Nexus** second sentence, **precon Mycosynth
    Lattice** second line); **precon Opposition Agent**'s exile-and-play replacement sentences,
    **precon Clone**, **precon Crystalline Crawler**, **precon Goldspan Dragon**'s Treasure mana
    grant, **precon Leyline of Anticipation**'s opening-hand ability, and **precon Terror of the
    Peaks**'s targeting ward-like life tax.
  - **`ir.ts` (additive, plus 4-line `notSupertypes`/`notSubtypes` export in `compiler/costs.ts`):**
    `ObjectFilter.notSupertypes` and `notSubtypes`; `Ref` `{ k: 'affected' }`; `LayerMod` variants
    `setSubtypes`, `allCreatureTypes`, `setColors`, `removeKeywords` (with `cantHaveOrGain`),
    `grantAbility`; `CostDelta.times`; `SpellOrAbilityFilter` `{ k: 'self' }`; `RuleModKind`
    `playerShroud`, `spendManaAsAnyColor`, `opponentsCantCastDuringYourTurn`; `StaticDef` variant
    `restriction` (`RestrictionKind`: `cantAttack`, `cantBlock`, `cantAttackOrBlock`,
    `cantBeBlocked`, `attacksEachCombat`, `blocksEachCombat`, `cantBeCountered`, `doesntUntap`);
    `condition` on `ruleModifier` and `multiplier`; `counter` and `cause` on `multiplier`; `tapped`,
    `counters`, and `condition` on `ReplacementDef`.

### Phase 2: Central zone changes and event bus (behaviour-preserving) ✅ done 2026-11-08
- **Status:** done on branch `engine-rewrite-phase2` (on top of `5fd62fe`); not yet merged.
- **Owns:** `runtime/zones.ts`, `runtime/events.ts` (new); zone-mutation sites in `engine.ts`.
- **Work:** route all 72 direct zone mutations through `moveObject`. Emit `ZoneChange`, `Cast`,
  `AttackDeclared`, `DamageDealt`, `PhaseBegin` and `CounterPlaced` events. **The existing
  `triggerOnX` functions remain** and are called from the event dispatcher, so behaviour doesn't
  change yet.
- **Exit:** suite green; the ratchet's zone-mutation count is 0 outside `zones.ts`; a test asserts
  that every zone change emits exactly one event.
- **Ratchet:** zone mutations → 0.
- **Results (2026-11-08):**
  - `directZoneMutation` engine.ts **72 → 0** (allowance lowered in the same commits). Other
    allowances unchanged. Suite: 163 tests, 160 pass, 3 todo, 0 fail; 0 magic type errors.
  - **Safety net first:** `runtime/golden.test.ts` plays four seeded all-bot games (fake clock and
    RNG) and compares with `runtime/__snapshots__/golden.json` (full final state, digests of
    intermediate states). Regenerate after an *intended* behaviour change with
    `UPDATE_GOLDEN_SNAPSHOTS=1 node --test src/lib/magic/runtime/golden.test.ts` and review the
    diff. `runtime/zones.pin.test.ts` (28 tests) pins each human-prompt/effect site the bots don't
    reach. Both were committed before the refactor; their expectations didn't change during it.
  - **`moveObject(state, obj, to, opts): ZoneType`** (`runtime/zones.ts`) does every zone change
    and emits exactly one `ZoneChange`. Nothing is implicit: `opts.from` (`{player, zone}` /
    `'anyBattlefield'` / `'stack'` / `'none'`), `toPlayer` (default owner), `insert`
    (`'end'`/`'start'`/index/`'deferred'`, or a function of the actual destination),
    `bumpVersion`, `newTimestamp`, `setZone`, `controllerId`, `leaveBattlefieldReset`,
    `detachAttachments`, `graveyardReplacement`, `commanderRedirect`, `ceaseToExist`
    (`'tokens'`/`'always'`), `beforeInsert`. `movePermanentToZone` is now a preset over it.
    Non-zone-changes live in the same file and emit nothing: `shuffleLibrary(player, keepTop)`,
    `setZoneOrder`, `rearrangeLibrary` (scry), `placeDeferred`, `transferBattlefieldControl`
    (elimination), `removeFromGame` (token clean-up, CR 800.4a), `mulliganRedraw`.
    `allocateTimestamp`, `createEmptyCounters`, `shuffleArray` moved here (engine.ts re-exports).
  - **Events** (`runtime/events.ts`) are transient: a `WeakMap<GameState, queue>`, never in
    `GameState` (so never saved to D1 or sent to clients, where they'd leak draws). Dispatch is
    synchronous; `applyGameAction` drains the queue when its outermost call returns. Ids come from
    a counter, not `Math.random`/`Date.now`. `subscribeEvents` is for tests.
    - `ZoneChange`: every `moveObject`. `Cast`: both cast sites → `triggerOnSpellCast`.
      `AttackDeclared` → `triggerOnAttack`. `CounterPlaced`: `addCountersToPermanent` →
      `triggerOnCounterPlaced` (extracted). `PhaseBegin`: `beginPhase()` at all 21 phase changes.
      `DamageDealt`: combat damage (both directions, trample), `applyDamageToTarget`,
      `damage_all_creatures`, `damage_each_opponent` (emit-only). `PhaseBegin` for `upkeep` and
      `end_step` dispatches to `runUpkeepTriggers` / `runEndStepTriggers` (the loops extracted
      unchanged from `runBeginningOfTurn` and `enterEndStep`); the stack checks after them stay
      inline. In `enterEndStep` the phase is now set just after its `emitVfx` (which doesn't read it).
  - `runtime/events.test.ts` replays ZoneChange events against an independent model of where every
    object is (seeded 2–4 bot games) and checks the real state after every event. Every entry
    point in `zones.pin.test.ts` is wrapped in the same check, so the human-prompt and effect sites
    bots don't reach are covered too; elimination is checked to emit no ZoneChange. Both fail if a
    site stops emitting (mutation-tested). Also checked: reorders emit nothing; `GameState` is
    plain data, survives `JSON.stringify`/`parse` mid-game and plays on identically.
  - **Preserved as explicit special cases** (they look like bugs; see below): the per-site
    version/timestamp differences; Treasure sacrifice is a bare removal (`ceaseToExist: 'always'`,
    `setZone: false`); suspend free cast leaves `zone === 'exile'`; `exile_all_graveyards` reverses
    order; the bot "search, shuffle, put on top" keeps found cards out of the library during the
    shuffle and ETB triggers (`insert: 'deferred'`); `return_self_from_graveyard` checks haste
    between removal and insertion (`beforeInsert`); mulligans still copy card objects.
- **Deferred to Phase 5:**
  - `triggerOnEtb` (10 call sites) and `triggerOnAttach` (2) stay **direct calls**. Dispatching
    them from `ZoneChange` would move them before each site's log line / `landsPlayedThisTurn++`,
    and would newly fire ETBs for `create_token` tokens and elimination control transfers.
  - Combat-damage-to-player triggers stay inline in `executeCombatDamageStep` (engine.ts:4757);
    they use locals of the damage loop. `DamageDealt` carries what Phase 5 needs.
  - Dies triggers stay at the `movePermanentToZone` call sites (destroy, wrath, SBA).
- **Bugs found, not fixed** (behaviour-preserving phase; each is pinned, so a fix must update its
  pin). Line numbers are at the end of Phase 2:
  - engine.ts:6467 `isTargetStillValid` has no `card_in_graveyard` branch, so a spell whose only
    targets are `card_in_graveyard` always fizzles.
  - engine.ts:3557 `create_token` → `createTokenOnBoard` (engine.ts:4220) never calls
    `triggerOnEtb`: no observer ETB or Landfall for tokens (`copy_target_permanent` tokens do).
  - CR 400.7 bookkeeping is inconsistent. Neither `objectVersion` nor timestamp changes for:
    search to hand (engine.ts:2124 human, 4133 bot), discard to hand size (2003 human, 4962 bot),
    London bottom (1889), commander → command zone (1975 prompt, 5176 bot SBA). Version bumped
    without a new timestamp: graveyard-target return/exile (2765), `return_from_graveyard_to_hand`
    (3122), `exile_all_graveyards` (3100). A resolving permanent spell is a fresh
    `createCardInstance` (2840) with `objectVersion` 1, lower than its stack `sourceObjectVersion`.
  - engine.ts:5368 `movePermanentToZone` doesn't reset `controllerId`, `summoningSick` or
    `usedLoyaltyThisTurn` when a permanent leaves the battlefield.
  - runtime/zones.ts:181 (`commanderRedirect`) sends a commander going to hand/library to the
    command zone only for bots; humans get no choice for those zones (CR 903.9a/b).
  - engine.ts:3100 `exile_all_graveyards` reverses each graveyard's order in exile.
  - engine.ts:1317 Treasure sacrifice for mana is a name check, skips the graveyard (no
    leaves-the-battlefield handling) and would remove a nontoken card named Treasure from the game.
  - engine.ts:3923 suspend free cast leaves the card's `zone` as `'exile'` while it's on the stack.
  - engine.ts:5270 `cleanupEliminatedPlayer` doesn't clear the eliminated player's graveyard or
    command zone, or their cards in other players' graveyards/hands/libraries (CR 800.4a).
  - engine.ts:4194 `autoFetchBasicLandToBattlefield` is dead code (no callers).

### Phase 3: Real grammar for effects, and the effect interpreter
- **Done (2026-11-08)** on branch `engine-rewrite-phase3` (on top of `6e4423e`), in parallel with
  Phases 4, 5 and 6.
- **Owns:** `compiler/effects.ts`, `runtime/effects.ts`; `executeParsedEffect` in `engine.ts`.
- **Work:** replace the adapter's effect translation with a grammar over sentences that produces
  ordered `EffectStep[]` with bindings and LKI. Write an interpreter covering every verb today's 39
  `case`s cover. Switch spell resolution and activated-ability resolution to the interpreter,
  **one verb at a time**: the old `executeParsedEffect` handles anything not yet migrated, and the
  coverage report shows which verbs are still on the old path.
- **Includes:** `Amount` replacing every `dynamicFormula` string, `actor` replacing
  `recipient`, delayed effects bound to bindings (removes the Corpse Dance skip), and the "Add one
  mana of any color that a land an opponent controls could produce" mana rule (currently
  approximated as any color).
- **Exit:** `executeParsedEffect` and `ParsedEffect` deleted; `parseSpellOrAbilityEffects` deleted
  or reduced to a compatibility wrapper used by tests only. Lathril's effect order is correct.
  `compiler/adapter.ts` (Phase 1 scaffolding) is deleted; don't add features to it beyond what
  measurement needs.
- **Ratchet:** name checks in effect code → 0 (`cardNameComparison.engine.ts` lowered 9 → 8).
- **Results (2026-11-08):**
  - **Sentence grammar (`compiler/effects.ts`, `compiler/effects.test.ts`):** recursive-descent
    sentence/clause parser (`parseEffectSentences`, `compileCardEffectSteps`, `compiledCardManaSteps`)
    handling ordered sentences, `then` / `, and` / `and you` / `where X is` continuations, modal
    bullets (`choose`), conditional guards (`if you do`, `unless`), cross-step bindings (`b0`, `b1`,
    …) for pronouns (`it`, `that <type>`, `its controller`, `that many`), LKI stats (`{ k: 'stat',
    useLKI: true }`), structured `Amount`, `actor` vs `subject`, delayed triggers bound to bindings
    (`delayedTrigger`), and CR 106.7 `manaChoice: 'opponentLandColors'`.
  - **Coverage (`scripts/magic-effects-diff.ts` → `EFFECT-GRAMMAR.md`):**
    - Precon pool (120 abilities): 61 same verbs as adapter, 13 grammar strictly richer, 3 grammar
      more specific, 28 grammar complete where adapter dropped sentences, 10 both incomplete, 0
      grammar regression, 5 diverge.
    - Scryfall bulk pool (34,190 abilities): 4,790 same, 2,031 grammar richer, 2,305 grammar more
      specific, 1,108 grammar only, 11,000 both incomplete, 3,472 adapter only, 9,484 diverge.
    - Interpreter switch-over (`canInterpretAbility` in `resolveSpellStackItem` and
      `resolveAbilityOnStack`): **52 / 62 precon spells + activated abilities** (and **4,565 / 16,448**
      across all game cards) resolve on `runtime/effects.ts`; all 30 verbs emitted by the grammar are
      interpreted.
  - **Effect interpreter (`runtime/effects.ts`, `runtime/effects.test.ts`):** `executeEffectSteps`
    evaluates `EffectStep[]` in sentence order with `Env` (`bindings`, `lki` snapshot captured before
    destructive zone changes, `eventObjectId`, `eventAmount`, `xValue`, `chosenModes`,
    `preferredColor`). Emits `ZoneChange`, `LifeChange`, `Draw`, `CounterChanged`, `TokenCreated`,
    `MarkersCommitted` through `runtime/events.ts`. Exposes `eventObjectId` and `eventAmount` on
    `EffectContext` so Phase 5 triggers can call `executeEffectSteps` directly.
  - **Bugs fixed and tested (with both real and synthetic/renamed cards):**
    1. **Lathril effect order:** `"Each opponent loses 10 life and you gain 10 life."` compiles and
       executes as `[loseLife(opponents, 10), gainLife(you, 10)]` in sentence order (previously gained
       life before opponents lost life).
    2. **Swords to Plowshares LKI controller & power:** captures `PermanentSnapshot` (evaluated
       power/toughness, mana value, controller, owner, types, counters) before `movePermanentToZone`
       moves the permanent to exile, so `its controller` and `its power` use Last Known Information
       (including counters/pumps that are cleared on leaving the battlefield). Also fixes `Reanimate`
       and `Feed the Swarm` LKI mana value life loss.
    3. **Corpse Dance via bindings (no card-name check):** compiles as `move` (`top: 1` of graveyard
       → `b0`), `grant` (`Haste` until EOT on `b0`), and `delayedTrigger` (`phaseBegin: end_step` →
       `exile(b0)`). Removed `if (item.card.name === 'Corpse Dance') continue;` from `engine.ts`
       (replaced with `item.parsedEffects.some((e) => e.dynamicFormula === 'top_creature_of_graveyard')`
       on the legacy fallback path), lowering `cardNameComparison.engine.ts` from 9 to 8.
    4. **CR 106.7 opponent land colors (`Exotic Orchard` / `Fellwar Stone`):** `opponentLandColors`
       inspects lands opponents control via `evaluatePermanent` basic land subtypes, layer-6 granted
       mana abilities (`inspectCardContinuousBreakdown`), and compiled mana abilities
       (`compiledCardManaSteps`), filtering out lands that lost all abilities and recursing at most
       once (`allowRecursiveChoice = false`) so two Exotic Orchards with no other lands produce no
       colored mana.
    5. **Graveyard card target legality (`isTargetStillValid`):** fixed `isTargetStillValid` in
       `engine.ts` to check `target.kind === 'graveyard_card' || target.kind === 'card_in_graveyard'`
       so targeted graveyard spells (`Reanimate`) validate properly in `checkSpellTargetValidity`.
    6. **Additional precon fixes on the interpreter:** `Anguished Unmaking` / `Night's Whisper` /
       `Read the Bones` / `Vampiric Tutor` life loss (`subject.k === 'none'` falling back to
       `step.actor`), `Sign in Blood` (`target player` draws 2 and loses 2 life), `Ancestral Vision`
       (`target player` draws 3), `Time Warp` (`target player` takes extra turn), `Toxic Deluge`
       (`-X/-X` until EOT), `Heroic Intervention` (Hexproof + Indestructible to permanents you
       control), and `Lathliss, Dragon Queen` (`+1/+0` to Dragons you control).
  - **Golden bot games snapshot (`runtime/__snapshots__/golden.json`):** regenerated; changes are
    caused by `Anguished Unmaking` (seed 1, Turn 5: Bot 0 now loses 3 life), `Night's Whisper` (seed
    99, Turn 5: Bot 0 now loses 2 life), and `Read the Bones` (seed 7, Turns 4 & 5: Bot 1 now loses
    2 life each time) executing their second sentence `"You lose N life."` on the interpreter, which
    emits log/VFX entries that advance the seeded PRNG before subsequent library shuffles.
  - **Deferrals to post-merge cleanup (Phase 10):** `executeParsedEffect`, `ParsedEffect`,
    `parseSpellOrAbilityEffects`, and `compiler/adapter.ts` are retained as the fallback for the 10
    remaining precon abilities (modal `Choose one or more` spells, multi-zone library manipulations
    like `Brainstorm` / `Chaos Warp` / `Expressive Iteration`, and layer-6 keyword-removal activated
    abilities on `Arcane Lighthouse` / `Bonds of Mortality` / `Shadowspear`) and because Phases 4 and
    5 run in parallel and still call them.

### Phase 4: Costs and activated abilities ✅ done 2026-11-08
- **Owns:** `compiler/costs.ts`, `runtime/costs.ts`; the cost/activation parts of `applyGameAction`,
  `checkAbilityActivationLegality`, `getSpellCostRequirement`, `evaluateActionNode`.
- **Work:** `CostDef[]` payment and legality, with `tapOthers` (any "tap N untapped <filter>"),
  sacrifice/discard/exile costs with choices, and alternative/additional costs. Cost modifiers come
  from `StaticDef{k:'costModifier'}`, with any type or subtype instead of the current fixed list in
  the spell-discount regex. Overload and similar keyword costs come from the keyword table.
  Mana abilities, including dynamic amounts (`count`, `stat(self, power)`), are interpreted from IR,
  which removes `getDynamicManaProducedAmount`'s text checks.
- **Exit:** no `costText` regex at runtime; baseline test `C-Audit-3` passes, if no other agent has
  fixed it already.
- **Results (2026-11-08, branch `engine-rewrite-phase4`):**
  - **Ratchet:** `cardNameComparison` `engine.ts` **9 → 8** (removed Treasure sacrifice name check);
    `oracleTextRead` `engine.ts` **40 → 38** (removed `getDynamicManaProducedAmount` regexes and
    cast-time `parseAdditionalCostsAndRestrictions(inst.card.oracleText)`). All new runtime files
    (`runtime/costs.ts`, `runtime/objectFilter.ts`) have 0 allowances.
  - **Suite:** 305 tests in 63 suites (**302 pass, 3 todo, 0 fail**; up from 267 baseline: +13
    compiler cost-choice/modifier grammar tests in `compiler/costs-choices.test.ts`, +25 runtime
    cost behaviour tests in `runtime/costs.test.ts`); 0 magic type errors.
  - **Compiler (`compiler/costs.ts`, `compiler/adapter.ts`, `ir.ts`):**
    - Added `CostDef` variants `choice` (`options: CostDef[][]`) and `optional` (`cost: CostDef[]`),
      `CostDelta.per?: Amount`, `SpellOrAbilityFilter` `{ k: 'self' }`, and transitional
      `legacyId` / `cost` / `costComplete` fields on `ActivatedAbility` / `UnsupportedAbility` so
      the runtime pays compiled IR costs even when an ability's effect is still on the legacy path.
    - Extended `compiler/costs.ts` with `pay {N}` options, `<cost> or <cost>` choices (preserving
      `or` inside object phrases such as `"sacrifice an artifact or creature"`), `"you may <cost>"`,
      `"with power/mana value N [or greater/less]"` conditions, and `parseCostModifierSentence`
      (arbitrary type/subtype, Eminence command+battlefield zones, `"This spell costs {N} less to
      cast for each ..."`). Wired into `compiler/adapter.ts` (`COMPILER_VERSION = 2`).
  - **Runtime (`runtime/objectFilter.ts`, `runtime/costs.ts`, `engine.ts`, `oracle.ts`, `ai.ts`):**
    - `runtime/objectFilter.ts` evaluates `ObjectFilter`, `Amount` (`const`, `x`, `count`, `stat`,
      `life`, `negate`, `sum`, `min`, `max`), and `Condition` against the live game state (using
      `evaluatePermanent` on the battlefield), without reading `oracleText` or card names.
    - `runtime/costs.ts` plans and pays `CostDef[]` in two steps (`planCosts` → `payPlannedCosts`)
      so nothing is paid unless the entire cost can be paid: `mana`, `tapSelf`, `untapSelf` (with
      CR 302.6 summoning-sickness checks on self only), `tapOthers` (excluding self only when
      `{T}` is also in the cost, CR 118.3), `sacrifice` (self or filter), `discard` (chosen or
      `random`, paid last per CR 601.2h), `payLife` (CR 119.4 `life >= amount`, CR 119.8
      `lifeTotalCannotChangeThisTurn`), `loyalty`, `removeCounters`, `exileFrom` (self or zone
      filter), `choice`, and `optional`. All zone changes route through `runtime/zones.ts`
      `moveObject`.
    - **Cost modifiers & keyword costs:** `effectiveSpellManaCost` (`runtime/costs.ts`) computes
      `getSpellCostRequirement` from IR `costModifiersOf(card)` (self-discounts, battlefield
      permanents that haven't phased out or lost all abilities, and command-zone Eminence) and
      `keywordCost(card, 'overload')` / `ALTERNATIVE_COST_KEYWORDS`.
    - **Dynamic mana & non-tap mana abilities:** `getDynamicManaProducedAmount` now evaluates
      `manaAbilityAmount(card, ab)` from the IR (`Amount` `count` / `stat`), returning 0 when a
      counted filter matches nothing. `oracle.ts` `parseActivatedAbilities` recognises mana
      abilities whose cost includes more than `{T}` (CR 605.1a, e.g. Treasure's
      `"{T}, Sacrifice this artifact: Add one mana of any color."`), while `tapOnlyManaAbilities`
      ensures auto-tap only taps `{T}`-only mana sources and never auto-sacrifices Treasures.
      Removed the `perm.card.name === 'Treasure'` special cases in `engine.ts` and
      `ArenaTable.svelte` and updated the `zones.pin.test.ts` Treasure pin.
  - **Bugs fixed (each tested in `runtime/costs.test.ts`):**
    1. Choice costs (`"discard a card or pay 3 life"`, `"sacrifice a creature or pay {3}{B}"`)
       paid only the chosen option instead of enforcing both.
    2. Optional additional costs (`"you may sacrifice an artifact"`) are optional instead of
       mandatory.
    3. Object-phrase conditions (`"a creature with power 4 or greater"`, `"with mana value X"`)
       and disjunctions (`"an artifact or creature"`) are enforced instead of dropped.
    4. `"discard a card at random"` picks uniformly at random at payment time (CR 601.2h) without
       prompting.
    5. When multiple legal options or candidate objects exist, the player chooses instead of the
       engine silently sacrificing/discarding the first/cheapest object.
    6. `"Tap N untapped <filter> you control"` works for any count and filter from the IR (not a
       hardcoded `"tap ten untapped elves"` regex), and allows tapping the source itself when `{T}`
       is not part of the cost.
    7. CR 119.4 (`life >= amount`, allowing paying down to 0 life) and CR 119.8
       (`lifeTotalCannotChangeThisTurn` prevents paying life) enforced consistently for both spells
       and activated abilities.
  - **How cost choices work (for Phase 8 to generalise):**
    - `GameActionPayload` (`cast_spell`, `activate_ability`, `tap_mana`) accepts an optional
      `costPayment?: CostPayment` (`{ options?: number[]; objects?: string[][] }`).
    - When a choice has only one legal option or `candidates.length === count`, `planCosts` selects
      it automatically.
    - When a human has an open choice, `askCostChoice` pushes a `PendingPrompt` of kind
      `'cost_choice'` carrying `pendingAction`, `costQuestion`, and either `costOptionLabels` or
      `candidateInstanceIds` + `countRequired`. Answering via `{ type: 'cost_choice', promptId,
      option, instanceIds, cancel }` merges the choice into `pendingAction.costPayment` and
      re-runs the action from scratch (or cancels cleanly with nothing paid). `ArenaTable.svelte`
      renders option buttons or the card selection grid for `cost_choice`.
    - Bots compute `costPayment` ahead of time via `chooseBotSpellCostPayment` (`ai.ts` →
      `chooseCostPayment` in `runtime/costs.ts`: declines optional costs, picks the first legal
      option, and chooses tokens-first then lowest-CMC objects).
  - **Snapshots:** `layers.snapshot.test.ts` and `runtime/golden.test.ts` pass unchanged (no precon
    card in the 4 seeded bot games triggers a different cost path).
  - **Deferred:**
    - Unifying `cost_choice` into the single generic choice protocol (`chooseMode` /
      `chooseObjects` / `yesNo`) → **Phase 8**.
    - Deleting legacy `parseAdditionalCostsAndRestrictions` in `oracle.ts` (still used for cast
      timing restrictions like `"Cast this spell only during combat"`) and `getCardRuleTree`'s
      legacy cost-modifier hooks (still used by `magic.test.ts` unit tests of `evaluateActionNode`
      / `collectActiveBoardHooks`) → **Phase 7 / Phase 10**.
    - Long-tail cost templates noted in `COST-GRAMMAR.md` (`Discard ~` channel costs, `{E}` energy,
      ability-word prefixes, `"Return ... to its owner's hand"`, removing counters from other
      permanents) → **Phase 11+**.

### Phase 5: Triggers via the event bus ✅ done 2026-11-08
- **Status:** done on branch `engine-rewrite-phase5`; not yet merged.
- **Owns:** `compiler/triggers.ts`, `runtime/triggers.ts`; the `triggerOnX` functions, the upkeep
  and end-step loops, combat damage triggers.
- **Work:** compile every trigger form into `TriggerDef` + `Condition`. Match events in one place;
  handle APNAP ordering with a choice prompt for ordering (CR 603.3b), intervening-if checked twice,
  `fromZone` triggers (graveyard), and trigger multipliers from statics. **Delete** all `triggerOnX`
  functions and the per-phase loops.
- **Exit:** every trigger test passes through the new path; Landfall works from every source by
  construction.
- **Results (2026-11-08):**
  - **Ratchet:** `oracleTextRead` in `engine.ts` **40 → 29** (-11; allowance lowered in
    `architecture-allowances.json`). `cardNameComparison` (9) and `directZoneMutation` (0)
    unchanged. `runtime/triggers.ts` has 0 `oracleTextRead`, 0 `cardNameComparison`, and 0
    `directZoneMutation`.
  - **Suite:** 288 tests, 286 pass, 2 todo (`D-Audit-5`, `E3`), 0 fail; 0 magic type errors.
    `runtime/triggers.test.ts` adds 21 tests (15 fail-first bug regressions + 6 rules/ordering pins).
    `C/D-Audit-4` in `magic.test.ts` now passes with its `{ todo }` marker removed.
  - **One trigger-matching engine (`runtime/triggers.ts`):**
    - Every emitted `GameEvent` (`ZoneChange`, `Cast`, `SpellCopied`, `AttackDeclared`,
      `BlockersDeclared`, `DamageDealt`, `PhaseBegin`, `CounterPlaced`, `BecameTarget`, `Attached`)
      dispatches to `matchTriggers(state, ev)`.
    - Candidate sources are collected in seat/zone order from `state.players` (skipping eliminated
      players, CR 800.4a, and phased-out permanents): battlefield permanents, graveyard cards whose
      compiled abilities specify `fromZone: 'graveyard'` (Nether Shadow, CR 404.2), the spell on the
      stack for `"When you cast ~"`, and the leaving permanent's `LeftBattlefieldInfo` look-back
      snapshot (`ev.lki` captured by `moveObject` in `runtime/zones.ts` before
      `leaveBattlefieldReset`) for leaves-the-battlefield / dies triggers (CR 603.10a).
    - Subject characteristics (`battlefieldSubject`) evaluate Layer 4 effective types and subtypes
      via `evaluatePermanent` (including `hasAllCreatureTypes` from Maskwood Nexus / Changeling) and
      check Layer 6 ability loss (`permanentHasLostAllAbilities` or `lki.lostAllAbilities`) before
      recording a match.
    - Intervening-if conditions (`Condition` in IR) are evaluated via `evaluateCondition` when the
      event is matched and re-checked on resolution (`flushTriggers` for inline triggers;
      `stackTriggerConditionHolds` in `resolveTopOfStack` via `StackItem.triggeredAbilityIndex`,
      CR 603.4).
    - Cast triggers apply `hook.trigger_multiplier` board hooks (Veyran, Voice of Duality).
    - `flushTriggers(state)` drains pending triggers in **APNAP order** (CR 603.3b): active player
      first, then other players in turn order (`apnap(state)`), with deterministic match-order
      tie-breaking within a player's simultaneous triggers. Beginning-of-step battlefield triggers
      are pushed onto `state.stack` in APNAP order (so the last non-active player's resolves first);
      inline triggers execute in reverse APNAP order (matching stack resolution order).
  - **Single-function effect wrapper for Phase 3 (`executeTriggerEffects` in `engine.ts`):**
    - `compiler/adapter.ts` attaches the per-line `LegacyTriggerExecution` (`effects`, `clause`,
      `legacyClaimed`) to each compiled ability via a `WeakMap` (`setLegacyTriggerExecution` in
      `compiler/triggers.ts`), never stored in `GameState`.
    - `executeTriggerEffects(state, controller, item)` in `engine.ts` is the single function that
      runs triggered ability effects via `executeParsedEffect`; swapping in Phase 3's IR effect
      interpreter later is a one-line change in `executeTriggerEffects` (and `resolveTopOfStack`).
  - **Capability gate (`runtimeTriggerProblem` in `compiler/triggers.ts`):**
    - Checks every `TriggerDef` (and its `or` alternatives) against `RUNTIME_EVENT_FIELDS`,
      `RUNTIME_OBJECT_FIELDS`, and `RUNTIME_PHASES`. Any trigger or qualifier the runtime cannot
      honour (`while saddled`, `and isn't blocked`, `attacks a player`, `enters untapped`, or an
      unparsed intervening-if condition) is compiled as `kind: 'unsupported'` (`reason:
      'event_not_implemented'` or `'unparsed'`) with `legacyClaimed: false` so it never fires
      unconditionally.
  - **Deleted functions and loops in `engine.ts`:**
    - Deleted `triggerOnEtb`, `triggerOnAttach`, `triggerOnSpellCast`, `triggerOnAttack`,
      `triggerOnCounterPlaced`, `runUpkeepTriggers`, `runEndStepTriggers`,
      `executeTriggeredCardEffects`, `matchesTriggerScope`, `evaluateTriggerCondition`, the inline
      `on_combat_damage_player` trigger loop in `executeCombatDamageStep`, and the manual
      `parseTriggeredEffects(card, 'dies')` calls at destroy, wrath, and SBA sites.
    - Kept `runSuspendUpkeep` (CR 702.62a keyword action before upkeep trigger matching) and
      `runDelayedEndStepTriggers` (Final Fortune / Corpse Dance `state.delayedTriggers` until Phase 3
      replaces delayed effects).
    - Replaced the 10 `triggerOnEtb` and 2 `triggerOnAttach` sites (plus `createTokenOnBoard`,
      `declare_blockers`, `executeCombatDamageStep`, destroy/wrath/SBA) with `emitEvent` +
      `flushTriggers(state)` positioned after each site's log line and state update
      (`landsPlayedThisTurn++`), preserving log ordering; elimination control transfers
      (`transferBattlefieldControl`) emit no `ZoneChange` and fire no triggers.
  - **Bugs fixed (each covered in `runtime/triggers.test.ts` and `magic.test.ts`):**
    1. Created tokens (`createTokenOnBoard`) now emit `ZoneChange` and flush triggers, firing self
       ETB, observer ETB, and Landfall triggers.
    2. `"Or"` triggers (`TriggerDef.or`: `"enters or attacks"`, `"enters or dies"`, `"attacks or
       blocks"`) match every listed event alternative instead of only the first.
    3. `"Cast or copy"` (`EventFilter.orCopy` on `SpellCopied` events) fires Archmage Emeritus,
       Storm-Kiln Artist, and Veyran (with Veyran doubling).
    4. Combat damage to a planeswalker (`atkEntry.defenderPlaneswalkerId` in
       `executeCombatDamageStep`) removes loyalty counters (CR 120.3c) and emits `DamageDealt` with
       `targetKind: 'permanent'`, firing `"player or planeswalker"` triggers (Grateful Apparition)
       while not firing `"combat damage to a player"` triggers.
    5. Goldspan Dragon's `"or becomes the target of a spell"` fires on `BecameTarget` emitted when a
       spell is cast targeting the permanent.
    6. Unsupported trigger qualifiers (`"while saddled"`, `"and isn't blocked"`, `"attacks a
       player"`, `"enters untapped"`) are rejected by `runtimeTriggerProblem` and marked
       `unsupported` instead of firing unconditionally.
    7. Cast triggers with unmodelled intervening-if clauses (`"if at least four mana was spent to
       cast it"`) are marked `unsupported` instead of dropping the condition and firing
       unconditionally.
    8. Multi-sentence cards whose effect text mentions another event (Springheart Nantuko's Landfall
       line mentioning `"attached to a creature you control"`, Sanguine Soothsayer's attack trigger
       granting `"When this permanent enters, draw a card"`) are matched only on their own trigger
       head's event, never on `Attached` or `ZoneChange`.
    9. `C/D-Audit-4` (`magic.test.ts`): observer ETB triggers (Marwyn) use Layer 4 effective
       subtypes from `evaluatePermanent` (Maskwood Nexus); also added Puresteel Paladin to
       `precons.ts` / `precon-oracle.fixture.json` and propagated `Equip {0}` to `costText` in
       `getEffectiveActivatedAbilities`.
  - **Golden snapshot diff (`runtime/__snapshots__/golden.json`):**
    - Regenerated with `UPDATE_GOLDEN_SNAPSHOTS=1`. Across all 4 seeded bot games, every board
      state, zone, permanent, counter, life total, timestamp, turn, and winner is identical; the
      only diff lines are the unified `TriggerHost` log labels (`"End Step trigger"` → `"End Step
      Trigger"`, `"(on_combat_damage_player)"` → `"(Combat Damage Trigger)"`, `"(Observer ETB)
      triggered when ..."` → `"(ETB Trigger) triggered for ..."`) and the intermediate state digests
      that hash `state.log`.
  - **Deferred to later phases:**
    - Player-chosen ordering among a single player's simultaneous triggers (CR 603.3b) and moving
      all remaining `'inline'` trigger modes onto the stack → Phase 8 (choice protocol).
    - Replacing `executeTriggerEffects`'s `ParsedEffect` loop and `state.delayedTriggers` with the
      IR effect interpreter → Phase 3.
    - Emitting `BecameTarget` for activated/triggered abilities (`targetedBy: 'ability'` /
      `'spellOrAbility'`) and `becomesTapped` / `gainLife` / `drawCard` events → long-tail coverage.

### Phase 6: Layer engine from IR, with caching ✅ done 2026-11-08 (branch `engine-rewrite-phase6`)

#### Phase 6a: layer evaluation caching ✅ done 2026-11-08 (branch `engine-rewrite-perf`)
Interim performance fix ahead of Phase 6 proper. Results are unchanged: layer snapshots and golden
games pass without regenerating.
- **Problem:** every `evaluatePermanent` / `inspectCardContinuousBreakdown` /
  `permanentHasLostAllAbilities` call re-scanned every permanent's text and attached Auras, nesting
  O(n²)–O(n³) regex work per call. A 4-bot game took **40–64 s CPU per bot tick at 60–69
  permanents**, which can't run on Workers.
- **Strategy:** there's no `state.version` yet, because mutations aren't centralised.
  - `runtime/layerCache.ts` keeps a **board snapshot per `GameState` in a `WeakMap`**, never inside
    the state. Each public query re-validates it with an O(n) identity/field fingerprint:
    - players array, each player's object, `lost`, `playerId`, and battlefield array identity and
      length;
    - per battlefield object: the object itself, `instanceId`, `phasedOut`, `attachedToId`,
      `enteredTimestamp`, `card`, `copiableCard`, `isFaceDown`, `controllerId`.

    A mismatch rebuilds the snapshot. The snapshot holds the active list, the timestamp order, an
    attachment index, memoised Aura-stripping and lost-all-abilities results, and source lists
    filtered by pattern.
  - In `ruleTree.ts`, regex, lowercase and line-split work goes through **pure memos keyed by the
    string**, which can't go stale.
  - Per-target inputs are still evaluated on every call: counters, temporary/switched P/T, granted
    keywords, suspend, CDA counts (graveyards).
  - Card objects are assumed immutable. The engine replaces them wholesale, which the fingerprint
    sees.
- **Checks:**
  - `MAGIC_LAYER_CACHE_CHECK=1` (or `=verbose`) recomputes every query on a fresh snapshot and
    throws on any difference.
  - Full suite under the flag: ~412k checks, 0 mismatches.
  - Full seeded 4-bot games, seeds 1 and 2, checked against the reference on every call:
    377,545 + 390,716 = 768,261 checks, 0 mismatches.
  - `runtime/layerCache.test.ts` mutates boards between evaluations and compares against fresh.
- **Timing (Node 24, `measure.mts`, CPU per bot tick):**

  | Permanents | seed 1 before (median / max) | seed 1 after | seed 2 before | seed 2 after |
  |---|---|---|---|---|
  | 0–9 | 400 ms | 80 ms | 414 ms | 84 ms |
  | 30–39 | 5.9 s | 153 ms | 9.0 s | 125 ms |
  | 50–59 | 29.3 s | 125 ms | 30.0 s | 97 ms |
  | 60–69 | 50.7 s / 59.6 s | 161 / 265 ms | 44.8 s / 64.1 s | 179 / 199 ms |

  Phase 6 timing baseline, one full `evaluatePermanent` pass over 60 permanents: ~230 ms →
  **~1 ms**.
- **Ratchet:** `oracleText` reads in `ruleTree.ts` went from 38 to 14.

#### Phase 6b: IR layer engine (`runtime/layers.ts` + `compiler/statics.ts`) ✅ done 2026-11-08 (branch `engine-rewrite-phase6`)
- **Owns:** `runtime/layers.ts`, `runtime/layers.test.ts`, `runtime/layerCache.ts`,
  `runtime/layerCache.test.ts`; `inspectCardContinuousBreakdown`, `permanentHasLostAllAbilities`,
  `evaluatePermanent`, `getAttachedAbilityStrippingAuraSources` in `ruleTree.ts`;
  `compiler/statics.ts`, `compiler/adapter.ts` (`adaptStatic`), `compiler/index.ts`,
  `scripts/magic-statics-diff.ts`, `layers.snapshot.json`.
- **Summary of changes:**
  - Wired `parseStaticAbility` into `adaptStatic` in `compiler/adapter.ts` (emitting `StaticAbility`
    and `ReplacementAbility` IR nodes and recording `LegacyStaticClaim`s in `AdapterLog.statics`),
    fixed `adaptActivated` to ignore colons inside quotation marks (`Chromatic Lantern`,
    `Imprisoned in the Moon`), bumped `COMPILER_VERSION` from 2 to 3, and updated
    `scripts/magic-statics-diff.ts` to read `log.statics`.
  - Extended `compiler/statics.ts` to normalize curly apostrophes (`\u2019`), parse
    `"loses all other card types and creature types"` and `"with/has base power and toughness N/M"`
    clauses in `attachedTypeChange` (`Kenrith's Transformation`), handle optional second `"base"`
    and off-battlefield continuation clauses in `globalChanges` (`Maskwood Nexus`), support
    `"You, <a/>, and <b/> have <keywords>"` for any keyword list in `ruleModifiers`, and parse
    `"you control a <color1> or <color2> permanent"` in `parseStaticCondition` (`Abzan Runemark`).
  - Implemented `src/lib/magic/runtime/layers.ts` evaluating Layers 1, 4, 5, 6, 7a, 7b, 7c, and 7d
    from compiled `CardDefinition`s (`compileCard`) with zero `oracleText` reads and zero card-name
    comparisons. Replaced lines 1045–2572 of `ruleTree.ts` with re-exports from `runtime/layers.ts`
    (deleting `layerCardText` and all regex layer helpers while leaving the Phase 7 rule-modifier
    helpers untouched).
  - Cached the full board evaluation (`byInstance` map of `EvaluatedPermanent`,
    `CardContinuousBreakdown`, and `lostAllAbilities`) on `BoardSnapshot.memo` keyed by a dynamic
    fingerprint (`state.version`, turn/active player, life/hand/graveyard, and per-permanent
    tapped/counters/temp P/T/switched P/T/suspend/grantedKeywords), making repeated
    `evaluatePermanent` calls O(1) object-reference lookups (~0.8 ms per 60-permanent pass, ~14 µs
    per permanent). Deleted the obsolete pre-Phase-6 `runtime/layerReference.test.ts`.
  - Fixed all 8 documented layer bugs and verified with fail-first tests in
    `runtime/layers.test.ts` (both real precon cards and synthetic cards with invented names):
    1. **Song of the Dryads (CR 205.1a & 305.7):** setting a basic land type (`setTypes` with `Land`
       and a basic land subtype) removes rules-text abilities and replaces prior card types on both
       creatures and Opalescence-animated enchantments (`D-Audit-5` enabled and passing in
       `magic.test.ts`).
    2. **Blood Moon + Urborg dependency (CR 613.8):** Layer 4 subtype-overwriting effects
       (`setSubtypes` on nonbasic lands) apply before global additive subtype effects (`addTypes`),
       stripping Urborg's ability so lands are not also Swamps.
    3. **Negative power (CR 107.1b):** `effectivePower` and `EvaluatedPermanent.power` preserve
       negative values (a 2/2 with -3/-0 reports `-1/2`, and a subsequent +2/+0 brings it to `1/2`),
       while toughness remains clamped at 0 for display.
    4. **Multi-type and subtype-qualified P/T & keyword grants:** `"Artifact creatures you control"`,
       `"Attacking creatures you control"`, `"Tapped creatures you control"` evaluated via generic
       `matchesLayerFilter` on `ObjectFilter`.
    5. **For-each P/T scaling (`Storm-Kiln Artist`):** `"~ gets +1/+0 for each artifact you control"`
       evaluated via `Amount` (`{ k: 'count', of: ... }`) in Layer 7c.
    6. **Conditional static abilities (`Abzan Runemark`):** `StaticDef.condition` evaluated via
       `evaluateLayerCondition` in Layer 6/7c.
    7. **CR 205.1b type retention:** enforced by `statics.ts` (`attachedTypeChange` requires explicit
       prior-type removal text when setting `"artifact creature"`).
    8. **Asymmetric P/T modifiers:** `+2/+0`, `+1/+0`, `-3/-0` evaluated generically via separate
       `power` and `toughness` `Amount`s.
- **Snapshot diff (`layers.snapshot.json`):**
  - Regenerated with `UPDATE_LAYER_SNAPSHOTS=1`. 36 of 40 scenarios are 100% unchanged; the only 4
    scenarios with diffs are the 4 documented `knownWrong` bug fixes (`aura/song-of-the-dryads-oracle-text`,
    `opalescence/song-of-the-dryads-on-animated-enchantment`, `lands/blood-moon`,
    `grants/equipment-and-auras`).
- **Ratchet (`architecture-allowances.json`):**
  - `oracleTextRead["ruleTree.ts"]` lowered `14 → 13` (`layerCardText` deleted).
  - `runtime/layers.ts` has 0 `oracleTextRead`, 0 `cardNameComparison`, and 0 `directZoneMutation`.

#### Phase 6c: cache validation regression fix ✅ done 2026-11-09 (branch `engine-rewrite-perf2`)
Results are unchanged: layer snapshots and golden games pass without regenerating.
- **Problem:** after 6b and Phase 7, evaluation was cheap but *validation* wasn't. Every query
  re-walked the board (snapshot fingerprint) and rebuilt the 6b dynamic fingerprint as a fresh
  array, and Phase 7's `activePermanents` asked `permanentHasLostAllAbilities` once per permanent.
  That made rule-modifier scans O(n²) and SBA / mana-ability scans O(n²)–O(n³). Bot turns at 60–69
  permanents took 1.3–1.8 s.
- **Strategy:** there's still no `state.version`, because mutations aren't funnelled.
  - `abilityActivePermanents(state)` in `runtime/layers.ts` validates once and returns the
    ability-active permanents (with `compileCard` results), memoised on the board layer cache.
    `replace.ts`'s `activePermanents` uses it.
  - The dynamic fingerprint is compared in place, without allocating.
  - **Stable-input scopes** in `runtime/layerCache.ts`: inside
    `withStableLayerInputs(state, fn)`, the first query validates and later ones reuse that
    result. `fn` must be synchronous and must not change a fingerprinted input unless it calls
    `noteLayerInputsChanged(state)` straight after. `moveObject` (via `whileLayerInputsChange`,
    which also suspends trust for the duration) and the other zone funnels drop trust as
    defense in depth.
  - Scoped regions:
    - `activeRuleModifiers` and `hasRestriction`;
    - the `engine.ts` `getEffectiveActivatedAbilities` wrapper;
    - the auto-tap candidate scan;
    - SBA step 0 (LKI pre-scan), and steps 2–4 with a note after each `attachedToId = null`.
    - Batch moves and step 1 (counter annihilation) stay unscoped.
- **Checks:**
  - Under `MAGIC_LAYER_CACHE_CHECK`, every trusted hit is re-validated and a violation throws
    (`layerCacheCheckStats().scopeChecks`).
  - `abilityActivePermanents` is cross-checked against the original per-player scan.
  - `runtime/layerCache.scope.test.ts` mutates boards inside and outside scopes (noted, un-noted,
    via funnels, mid-change, nested, SBAs, a seeded game).
- **Timing (Node 24, `measure.mts`, max CPU per bot tick):** 60–69 permanents, seed 1:
  1.82 s → 214 ms; seed 2: 1.62 s → 202 ms. 90–99 permanents, seed 1: 2.47 s → 686 ms (a combat
  tick in which ~30 permanents die, so most of the cost is real re-evaluation); seed 2:
  2.79 s → 398 ms.

#### Phase 6d: second cache regression fix ✅ done 2026-11-09 (branch `engine-rewrite-perf3`)
Results are unchanged: layer snapshots and golden games pass without regenerating, and six seeded
4-bot games (seeds 1–6) hash identically, tick by tick, to `bddf961`.
- **Problem:** read-only queries added after 6c ran outside any trust scope, each doing an O(n)
  validation, often once per permanent. The board was also re-evaluated far more often than
  needed, for two reasons:
  - the untap step and attacker tapping interleaved `tapped` writes with layer queries, so each
    write invalidated the cache for the next permanent's check;
  - the dynamic fingerprint keyed every evaluation on tapped state, life, hand and graveyard sizes,
    the turn and the active player, even when no static ability read them.

  On top of that, V8 kept deoptimising and recompiling the single ~850-line board evaluation
  (TurboFan compiles of ~150 ms each).
- **Strategy:** there is still no `state.version`.
  - **Untap and attack decisions are hoisted.** CR 502.3 and 508.1f make these simultaneous, so
    "doesn't untap" and vigilance are decided in one scope before any permanent changes. Before
    committing, an in-loop assertion confirmed this agrees with the old order across the suite
    and six games.
  - **One scope per read-only entry point:**
    - `checkSpellCastLegality`, `checkAbilityActivationLegality`, `checkLandPlayLegality`,
      `validateTargetLegality`, `getAllLegalTargetsForRequirement` and `hasRequiredLegalTargets`;
    - `effectiveSpellManaCost` and `effectiveAbilityManaCost`;
    - `matchTriggers`;
    - SBA step 7's can't-lose scan;
    - `ai.ts`: `hasRestriction`, `hasAnyLegalInstantResponse`, `chooseBotTriggerTargets`, and each
      bot decision pass. `applyGameAction` always runs outside the scopes.

    `canPayManaAfterTaps`, which taps hypothetically, notes the change before and after.
  - **Read-tracked fingerprint.** The evaluation records which non-board inputs it read, and the
    fingerprint keeps only those:
    - a `tapped` filter;
    - life;
    - zone sizes (`cardsIn`, now including library, exile and command);
    - graveyard contents;
    - the active player (`isTurnOf`).

    Each permanent's own counters, temporary P/T, switch, suspend and granted keywords are always
    fingerprinted. The evaluation is a deterministic function of what it reads, so unchanged
    reads mean an unchanged result.
  - **The evaluation is split into one function per pass,** moved verbatim.
  - **Pure memos:**
    - `compileCard` keeps a `WeakMap` from each card object to its definition, re-checking every
      field the key reads;
    - `hasSubType` uses a per-type-line subtype set.
- **Checks:**
  - Full suite under `MAGIC_LAYER_CACHE_CHECK=verbose`: 875/875 pass, 2,377,578 checks
    (1,159,691 scope checks). The 2 mismatches are the two deliberate stale-scope tests.
  - Seeded games under the cross-check, 0 mismatches:
    - seed 1: 1,713,025 checks (848,507 scope checks);
    - seed 2: 2,165,257 checks (1,073,666 scope checks).
  - New tests: `runtime/layerCache.phase6d.test.ts`.
- **Timing (Node 24, `measure.mts`, max CPU per bot tick, median of 3 runs, same machine and
  session):**

  | Permanents | seed 1 before | seed 1 after | seed 2 before | seed 2 after |
  |---|---|---|---|---|
  | 60–69 | 207 ms | 58 ms | 291 ms | 83 ms |
  | 70–79 | 275 ms | 94 ms | 379 ms | 129 ms |
  | 80–89 | 258 ms | 105 ms | 281 ms | 81 ms |
  | 100–109 | 357 ms | 88 ms | 506 ms | 114 ms |

  `measure.mts` counts process CPU, including V8's GC and compiler threads. The worst main-thread
  wall time per tick fell from ~230 / 365 ms to ~50 ms.

### Phase 7: Replacement effects and rule modifiers ✅ done 2026-11-08 (branch `engine-rewrite-phase7`)
- **Owns:** `runtime/replace.ts`; the rule helpers at the end of `ruleTree.ts`, draw-from-empty,
  hand size, attack tax, player hexproof in `engine.ts`.
- **Work:** per §2.5. Includes the `{N}` attack tax (not fixed `{2}`) and searches controlled by an
  opponent as a generic `ruleModifier` + replacement.
- **Exit:** those helpers deleted; `ruleTree.ts` contains no rules-text reads.
- **Completed:**
  - **Test counts:** 397 tests, 395 pass, 2 todo (`E3`, `D-Audit-5`), 0 fail (`11` new tests in
    `runtime/replace.test.ts` plus new grammar tests in `compiler/statics.test.ts`). Layer snapshots
    (`layers.snapshot.test.ts`) and golden bot games (`runtime/golden.test.ts`) pass unchanged.
  - **Ratchet (`architecture-allowances.json`):**
    - `cardNameComparison["engine.ts"]`: `7 → 2` (deleted hardcoded `laboratory maniac`,
      `reliquary tower`, `thought vessel`, `ghostly prison`, `propaganda`, `corpsejack menace`;
      only `sol ring` and `arcane signet` remain in `pickAutoPlayCard`).
    - `oracleTextRead["engine.ts"]`: `27 → 21` (deleted regex checks in `playerHasHexproofFrom`,
      `playerHasShroud`, `declare_attackers`, and `runCleanupStep`, plus dead
      `autoFetchBasicLandToBattlefield`).
    - `oracleTextRead["ruleTree.ts"]`: `14 → 8` (deleted the 5 regex rule/replacement helper bodies
      at the end of `ruleTree.ts` and re-exported them from `runtime/replace.ts`; lines 1–2573 of
      `ruleTree.ts` untouched for Phase 6).
    - `runtime/replace.ts` has 0 allowances across all ratchet categories.
  - **Compiler & Adapter (`compiler/statics.ts`, `compiler/adapter.ts`, `compiler/index.ts`):**
    - Wired `parseStaticAbility` into `adaptStatic` (with `LegacyStaticClaim` audit logging and
      `adaptSpell` support for `"~ can't be countered."`); bumped `COMPILER_VERSION` to `3` and
      regenerated `compiler/__snapshots__/ir.json`.
    - Extended `compiler/statics.ts` for Opposition Agent's 2nd line (`searchControl` params),
      full-sentence Grand Abolisher (`opponentsCantCastDuringYourTurn`), 2-subject `"You and
      <affected> have <hexproof|shroud>"`, `"<filter> spells can't be countered"`, and negative
      lookbehind on `AS_LONG_AS_SUFFIX` for `"for as long as"`.
  - **Runtime (`runtime/replace.ts`) & Bug fixes (each covered in `runtime/replace.test.ts`):**
    1. Empty-library draw replacement (`replaceEmptyLibraryDraw`) evaluated from compiled
       `ReplacementDef` (`event: 'draw'` with `cardsIn(library, you) = 0`) instead of card name
       `"laboratory maniac"`, respecting Layer 6 ability removal (Humility).
    2. Generic `{N}` attack tax (`getAttackTaxGeneric`) sums `ruleModifier: 'attackTax'` across all
       active permanents controlled by the defending player instead of hardcoded `{2}` / card names.
    3. Unlimited hand size (`playerHasNoMaxHandSize`) evaluated from `ruleModifier: 'noMaxHandSize'`
       on any permanent instead of card names `"reliquary tower"` / `"thought vessel"`, respecting
       Humility.
    4. Player hexproof (`playerHasHexproofFrom`) and shroud (`playerHasShroud`) evaluated from
       compiled `ruleModifier`s with condition evaluation (`"As long as it's your turn, you have
       hexproof"`).
    5. `playerCannotLoseGame` and `playerCannotWinGame` evaluated from `ruleModifier: 'cantLose'` /
       `'cantWin'` with condition evaluation.
    6. `checkGlobalCastPermissionsAndRestrictions` enforces `opponentsCantCastDuringYourTurn`,
       `castSpellCountLimit`, and type-filtered `castAsThoughFlash` (e.g. Yeva for green creatures
       only vs Vedalken Orrery for all spells).
    7. `getLibrarySearchInterceptor` evaluates `ruleModifier: 'searchControl'` across opponents'
       active permanents in CR 613.7 timestamp order.
    8. Combat and untap restrictions (`hasRestriction`: `cantAttack`, `cantBlock`,
       `cantAttackOrBlock`, `attacksEachCombat`, `blocksEachCombat`, `doesntUntap`) and uncounterable
       spells (`spellCannotBeCountered`: self `cantBeCountered` on stack spells and battlefield
       static grants like `"Creature spells you control can't be countered"`).
    9. `cardEntersTapped` (re-exported from `oracle.ts`) checks compiled self-ETB replacement IR so
       conditional `"~ enters tapped unless ..."` check-lands no longer unconditionally enter tapped;
       `applySelfEtbReplacements` applies `"~ enters with N <counter> counters on it"` multiplied by
       `counterMultiplier`.
    10. Scoped multipliers: `counterMultiplier` (checks `def.counter` and `def.filter` so Corpsejack
        Menace only doubles `+1/+1` counters on creatures you control, while Doubling Season doubles
        all counters on permanents you control), `tokenMultiplier` (wired into `engine.ts` and
        `runtime/effects.ts`), and `triggerMultiplier` (wired into `runtime/triggers.ts` for cast /
        `SpellCopied`, ETB / dies with LKI, and attack triggers).

### Phase 8: Generic choice protocol and UI ✅ done 2026-11-08
- **Status:** done on branch `engine-rewrite-phase8`; not yet merged.
- **Owns:** `runtime/choices.ts`, `PendingPrompt`/`GameActionPayload` in `types.ts`,
  `ArenaTable.svelte` prompt rendering, the bot choice code in `ai.ts`.
- **Work:** per §2.8. Migrate prompt kinds one at a time behind the new `choice` action; delete
  `obeka_end_turn_choice`. Bump `engineVersion`.
- **Exit:** no card-specific prompt or action types; UI renders all choices generically.
- **Results (2026-11-08, branch `engine-rewrite-phase8`):**
  - **Ratchet:** `runtime/choices.ts` has 0 `oracleTextRead`, 0 `cardNameComparison`, and 0
    `directZoneMutation`; existing allowances in `architecture-allowances.json` unchanged (`engine.ts`
    8 / 27 / 0).
  - **Suite:** 398 tests in 89 suites (**396 pass, 2 todo, 0 fail**; up from 386 baseline: +12 tests
    in `runtime/choices.test.ts`); 0 magic type errors; `layers.snapshot.test.ts` and
    `runtime/golden.test.ts` pass unchanged.
  - **`GameState.engineVersion` (§2.6):** added `ENGINE_VERSION = 1` and `GameState.engineVersion`
    (`types.ts`, `createInitialGameState` in `engine.ts`). `applyGameActionInner` ends any active or
    mulligan game whose `engineVersion` is missing or mismatches `ENGINE_VERSION`, setting
    `status = 'finished'` and logging a `'system'` message explaining that the game ended due to an
    engine update.
  - **Generic choice protocol (`runtime/choices.ts`, `types.ts`, `engine.ts`):**
    - Added the six generic `ChoiceRequest` / `ChoiceAnswer` kinds (`yesNo`, `chooseObjects`,
      `chooseMode`, `chooseNumber`, `orderObjects`, `chooseReplacement`), `PendingPrompt.choice`,
      `PendingPrompt.purpose`, and `{ type: 'choice', promptId, answer?, cancel?, operations? }` in
      `GameActionPayload`.
    - Migrated every prompt creation site (`mulligan`, `london_bottom`, `commander_zone_choice`,
      `end_turn`, `cost_choice`, `search_library`, `scry_choice`, `discard_to_hand_size`,
      `guided_resolution`, `legend_rule`, and custom `enqueueChoicePrompt` callbacks) to populate a
      generic `choice` descriptor and resolve through a single validated handler
      (`validateChoiceAnswer` + `normalizePromptAction` in `runtime/choices.ts`).
    - Deleted `'obeka_end_turn_choice'` from `PendingPromptKind`, `GameActionPayload`, `engine.ts`,
      and `ArenaTable.svelte`; end-the-turn effects now push a generic `yesNo` prompt with
      `purpose: 'end_turn'`. Kept thin compatibility aliases for legacy action payloads
      (`commander_zone_choice`, `scry_resolve`, `search_library_pick`, `discard_cards`,
      `guided_resolve`, `cost_choice`, `legend_rule_keep`) so existing pin tests continue to work.
  - **Generic UI (`ArenaTable.svelte`) and bots (`ai.ts`, `runtime/choices.ts`):**
    - `ArenaTable.svelte` derives `myChoice = effectivePromptChoice(myPrompt, gameState)` and renders
      all prompts by `myChoice.kind` (`yesNo`, `chooseObjects`, `chooseMode`, `chooseNumber`,
      `orderObjects`, `chooseReplacement`), dispatching `{ type: 'choice', promptId, answer }`.
    - `runAutomatedPriorityAndBots` (`ai.ts`) answers pending bot prompts via `chooseBotAnswer` and
      `{ type: 'choice', promptId, answer }`.

### Phase 9: AI on IR ✅ done 2026-11-08
- **Owns:** `ai.ts`, `runtime/ai.test.ts`.
- **Work:** heuristics read evaluated abilities and the IR (e.g. "can't be blocked" is an evaluated
  static, so it's removed under Humility automatically). No `oracleText` reads.
- **Exit:** ratchet `oracleText` in `ai.ts` → 0; baseline test `E3` passes, if no other agent has
  fixed it already.
- **Results (2026-11-08, branch `engine-rewrite-phase9`):**
  - **Ratchet:** `oracleTextRead` in `ai.ts` **1 → 0** (`cardNameComparison`: 0, `directZoneMutation`: 0).
  - **Adapter wiring (`compiler/adapter.ts`, `compiler/index.ts`):** wired `parseStaticAbility` into
    `adaptStatic` (`COMPILER_VERSION = 3`) so `compileCard` emits compiled `StaticAbility` and
    `ReplacementAbility` IR nodes, and updated `scripts/magic-statics-diff.ts` (`AdapterLog.statics`)
    and `compiler/__snapshots__/ir.json`.
  - **AI heuristics (`ai.ts`, `runtime/ai.test.ts`):**
    - `hasRestriction(state, perm, restriction)` evaluates `StaticDef{k:'restriction'}` (`cantBeBlocked`,
      `cantBlock`, `cantAttack`, `cantAttackOrBlock`) across active battlefield permanents (self,
      attached Auras/Equipment, and `ObjectFilter` board statics), checking `evaluatePermanent(state,
      source).losesAllAbilities` and `evaluateCondition(def.condition, ctx)`.
    - Replaced `cardHasPrintedUnblockable` and `oracleText` spell-classification checks in `ai.ts`
      with IR queries (`compileCard`, `compileSpellEffects`, `cardSpellTargetSpec`).
    - Baseline test `E3` in `magic.test.ts` passes with its `{ todo }` marker removed; added 5 tests
      in `runtime/ai.test.ts`. `layers.snapshot.test.ts` and `runtime/golden.test.ts` pass unchanged.

### Phase 10: Delete the legacy layer ✅ done 2026-11-09 (branch `engine-rewrite-f`)

**Correction (coordinating session, 2026-11-09).** The "done" claim below was based on the original
three ratchet rules, which the code satisfied by moving rules-text reads into `oracle.ts`, which is
exempt. At 93b78a8:
- Runtime code still calls legacy text parsers 52 times: 29 in `engine.ts`, 21 in `ruleTree.ts`
  (`getCardRuleTree` is built from text), and 2 in `ai.ts`. Examples: `parseSpellOrAbilityEffects`,
  `getPermanentManaProduction`, `getCardRulesText(card).toLowerCase().includes(...)`.
- Card names remain in code: 9 occurrences, e.g. `spellExilesSelfOnResolution` matches "teferi's
  protection" / "time stop"; the generic end-turn prompt is titled "End the Turn? (Obeka, Brute
  Chronologist)".
- `executeTriggerEffects` still runs triggered abilities through `executeParsedEffect`.
- `ParsedEffect`, `executeParsedEffect`, `compiler/adapter.ts` and the legacy `oracle.ts` parsers all
  still exist.

**Ratchet strengthened (step A, 2026-11-09).** `architecture.test.ts` adds two rules:
- `legacyTextHelperCall`: calls from runtime files to any `oracle.ts` export not on the checked
  text-free list, plus `getCardRuleTree`. New exports count automatically.
- `cardNameInCode`: precon card names in runtime, `oracle.ts` or compiler code outside comments.

Honest baseline: `legacyTextHelperCall` engine.ts 29, ruleTree.ts 21, ai.ts 2; `cardNameInCode`
engine.ts 7, oracle.ts 2. **Phase 10's exit now also requires both to be 0.**

**Remaining roadmap (agreed with the user, 2026-11-09):**
- A. Honest ratchet. ✅ (above)
- B. Cache-validation performance regression (1.2–1.7 s per bot turn at 60–69 permanents, against
  161–265 ms after Phase 6a). Branch `engine-rewrite-perf2`, recorded as Phase 6c. ✅
- C. Run triggered-ability effects on the IR interpreter (`runtime/effects.ts`). ✅
- D. Put all triggers on the stack (today only phase-begin battlefield triggers use it; the rest
  resolve inline, against CR 603.3), with player-chosen ordering via `orderObjects`. The user
  play-tests this. ✅
- E. Unsupported abilities per §2.7: allowed by default; resolved through the guided manual prompt;
  deck-builder warning; lobby rule to block them. ✅
- F. Real Phase 10: migrate the remaining runtime callers to IR, then delete the legacy layer;
  `legacyTextHelperCall` and `cardNameInCode` reach 0. ✅

Then an ultra code review of the branch, doc clean-up, and push.

#### Steps C+D: triggers on the IR interpreter and the stack (branch `engine-rewrite-triggers`, 2026-11-09)

**Step C (commit 9fa9809): trigger effects on the IR interpreter.**
- `compiler/adapter.ts` compiles each triggered ability's effect clause (after the trigger head and
  any intervening-if) with the effect grammar (`parseEffects(..., 'triggered')`), attached to the
  compiled ability and exposed as `RuntimeTrigger.effect` / `compiledTriggerEffect(card,
  abilityIndex)` in `compiler/index.ts` (cached with the CardDefinition; the runtime never reads text).
- Event referents: "it" / "that creature" → `eventObject`; "that player" → new `PlayerRef`
  `{k:'eventPlayer'}` (unless an earlier clause chose a target player); "that many" / "that much" →
  `eventAmount` (new productions: draw that many cards, gain/lose that much life, deals that much
  damage); "the entering creature's power" → `stat` of `eventObject`.
- `StackItem` records the event (`eventObjectId`, `eventObjectVersion`, `eventPlayerId`,
  `eventAmount`, `eventStackItemId`, `eventLki`), never in `targets`. `eventObject` reads LKI once the
  object left the battlefield (CR 608.2h) and stops at a new object (CR 400.7). The legacy fallback
  gets its old `targets[0]` from the transitional `legacyEventTarget` (delete in step F).
- Triggers the grammar fully understands but the legacy parser never claimed now fire too; the
  engine filters out abilities it can't execute (`TriggerHost.canExecute`).

**Step D: every trigger on the stack.**
- `runtime/triggers.ts` `modeFor`: every triggered ability uses the stack (CR 603.3) except triggered
  mana abilities (CR 605.1b), detected as abilities on the new `TappedForMana` event (emitted by the
  `tap_mana` action; grammar "Whenever you tap a land for mana", "Whenever enchanted land is tapped
  for mana") whose effect only adds mana; they resolve immediately (CR 605.4a).
- Placement waits until a player would receive priority: `withTriggersDeferred` wraps stack
  resolution (`resolveTopOfStack`) and the turn-based actions of `beginPhase` (combat damage is
  followed by SBAs, then triggers), CR 603.3 / 704.3.
- Targets are chosen as the ability is put on the stack, from the compiled `TargetSpec`s
  (`putTriggerOnStack` in `engine.ts`; candidates from `matchesObjectFilter` + shroud / hexproof /
  protection). Bots choose via `ai.ts chooseBotTriggerTargets`; humans get a `chooseObjects` prompt
  (`purpose: 'trigger_targets'`) unless the choice is forced. A required target with no legal
  candidate removes the ability with a log line (CR 603.3d). On resolution the targets are re-checked
  against the same specs (CR 608.2b).
- A human with several simultaneous triggers orders them with an `orderObjects` prompt (`purpose:
  'trigger_order'`, `topIds[0]` resolves first, CR 603.3b); bots and single triggers get no prompt;
  APNAP across players is unchanged.
- "You may" (a leading optional clause with the controller as chooser): asked on resolution (`yesNo`,
  `purpose: 'trigger_may'`); the ability stays on the stack meanwhile (CR 608.2n). Bots decide via
  `ai.ts botAcceptsOptionalTrigger`.
- All three prompts are plain data (`PendingPrompt.triggerStackItemId`, `triggerTargetSpecIndex`),
  answered in `handlePromptResolution`, so they survive the server's JSON round trip between requests
  (no `enqueueChoicePrompt` callbacks).
- Removed the Felidar `'life_40_or_more'` hack and `StackItem.interveningIfClause` (the one
  non-additive `types.ts` change, explicitly requested); the general intervening-if re-check stays.
- Safety: a stack-size cap (300) and a per-turn cap (200 triggered abilities,
  `GameState.triggersPlacedThisTurn`) stop runaway retrigger loops, with a log line; `applyGameAction`
  flushes pending triggers before returning. The lobby server runs
  the bot loop with a 1,500-step budget (`SERVER_MAX_BOT_STEPS`, logs when hit); tests and golden
  games keep the 240-step default. Humans auto-pass over their own triggered abilities when they have
  no legal response (Full Control off), as on MTG Arena.
- UI (`ArenaTable.svelte`): `chooseObjects` renders player and stack-item candidates; a
  `trigger_order` branch lists the stack items with ◀/▶.
- Interpreter coverage (`scripts/magic-trigger-interpreter.ts`): precon 29 / 34 triggered abilities
  (3 targeted); bulk 3,184 / 5,001 (644 targeted). Still legacy among precons: Ward, Miirym's copy,
  Nether Shadow (zone move of itself), Thassa's Oracle, The Ur-Dragon.
- Deferred: `BecameTarget` for abilities, `TappedForMana` from auto-tapping during payment, "if you
  do" and optional clauses after the first step, delayed triggers still pushed by
  `runDelayedEndStepTriggers` (on the stack, not ordered with other triggers).

#### Step E1: unsupported-ability warnings and lobby rule ✅ done 2026-11-09 (branch `engine-rewrite-unsupported`)
- **Helper:** `compiler/support.ts`. `cardSupportReport(card)` returns `{ fullySupported, unsupported:
  [{ face, text, reason, span, unparsed }] }`, where `unparsed` holds the fragments narrower than the
  whole ability. It is cached in a `WeakMap` keyed by the cached `CardDefinition`, so it follows
  `compileCard`'s key. `deckUnsupportedCards` lists a deck's affected cards, and
  `unsupportedCardsStartError` decides the lobby rule. `scripts/magic-coverage.ts` counts through
  the same helper, so the warning and COVERAGE.md agree. That also fixed a NaN for
  `event_not_implemented`.
- **Precons (compiler v3):** 33 of 140 precon cards have at least one unsupported ability (34
  abilities). COVERAGE.md still shows the v1 figure (65 of 139) until it's regenerated. Every precon
  deck has some (12, 8, 9 and 13 cards).
- **Deck builder:** a per-card badge "N abilities not automated" shows the ability text on hover.
  An expandable deck summary ("N cards have abilities that won't be automated") is kept separate
  from the legality notices. `validateCommanderDeck` is unchanged, so these cards are never illegal.
- **Lobby:** `LobbyRulesConfig.allowUnsupportedCards?` defaults to true, and an absent value counts
  as true. `start_game` in `api/lobby/+server.ts` refuses when the rule is false and any seat's deck
  (bots included) has such a card, naming the seat, deck and cards. Because every precon has one,
  blocking also blocks bot seats.
- **In game:** the `ArenaTable` inspector lists these abilities under "Not automated: resolved
  manually". Step E2 does the manual resolution and the "logged once on entering" behaviour for
  statics.

#### Step E2: manual resolution and data-only prompts (branch `engine-rewrite-e2`, 2026-11-09)
- **Data-only prompts.** `enqueueChoicePrompt` no longer takes a callback, and the `WeakMap`
  callback registry is deleted. A prompt says what answering it continues in
  `PendingPrompt.continuation` (plain data): `effect_choice` / `effect_resume` (a paused IR
  resolution, by stack item id and step index), `manual_resolution`, `manual_ability`, or `handler`
  (a named handler registered at module load). So a prompt answered after the lobby server reloads
  the state from JSON still continues. `runtime/prompts-roundtrip.test.ts` answers every human prompt
  kind on a `JSON.parse(JSON.stringify(state))` copy.
- **Pause and resume (CR 608.2n).** The IR interpreter pauses for a human's sacrifice or discard
  choice, and after a scry or search prompt that isn't the last step. The resume frame (step index,
  bindings with their LKI, answers) is stored in `StackItem.effectResume`. The steps are recompiled
  on resume, never stored. The item stays on the stack and resumes by id: triggers that fired
  before the pause sit above it and resolve first, which is a small deviation from CR 603.3.
  `StackItem.resolutionStarted` stops the resume from repeating the fizzle and intervening-if
  checks and the resolve VFX. That also fixes the double VFX on a "you may" trigger. Players choose
  in turn, then everything is sacrificed or discarded at once (CR 101.4). New grammar: "[each
  opponent / target player] sacrifice(s) N <objects>" and "[player] discard(s) N cards".
- **Manual resolution (section 2.7).** An instant or sorcery, an activated ability, or a card's
  triggered ability that the interpreter can't run is "not automated":
  - A human controller gets the `guided_resolution` prompt. It shows the ability's text (via
    `compiler/support.ts` `stackItemDisplayText`) and has an operation builder: move a card between
    any zones, life, damage, counters, draw, mill, tokens, tap and untap. The server validates the
    operations. The item finishes resolving afterwards, and the log says it was resolved manually.
    While legacy effects exist, the prompt also offers "Use the engine's approximation".
  - A bot uses the legacy effects if there are any. Otherwise it skips the ability and logs
    "<bot> (bot) skipped unsupported ability X".
  - Permanent spells, engine-made delayed triggers and Ward keep their current paths.
- **Triggers.** Every ability whose trigger head is understood now triggers and goes on the stack.
  The `canExecute` filter is gone, and only legacy effects the pre-Phase-5 engine ran count as a bot
  fallback. Abilities whose trigger can't be recognised, and unenforced statics, replacements and
  keywords, are logged once when the permanent enters, from the ZoneChange handler.
- **Escape hatch.** The action `{ type: 'resolve_manually', instanceId, abilityIndex? }` (the
  inspector's "Resolve manually" button) opens a guided prompt for any ability of a card the player
  controls while they have priority. It never uses the stack.
- **Inspector.** `UnsupportedAbilityReport.kind` gives each ability a label:
  - "Not automated: resolved manually" for spells, activated abilities and triggers;
  - "Not automated: apply it manually when it triggers" for triggers the engine can't recognise;
  - "Not enforced" for statics and keywords;
  - an approximation note for mana abilities.
- **Seeded randomness.** `runtime/random.ts`. `GameState.rngState` is seeded once at game creation,
  and shuffles and random costs use it. `uid()` still uses `Math.random` (ids only; deferred).
- Removed the unused `StackItem.interveningIfCondition`. The `legacyTextHelperCall` ratchet for
  engine.ts went from 29 to 28.

#### Step F results (branch `engine-rewrite-f`, 2026-11-09)
- **All five architecture ratchet categories at `0` (`architecture-allowances.json`):**
  `cardNameComparison`, `oracleTextRead`, `directZoneMutation`, `legacyTextHelperCall` (`28 / 21 / 2 → 0`),
  and `cardNameInCode` (`7 / 2 → 0`) are `0` across every runtime, compiler, and `oracle.ts` file.
- **Grammar compiler replaces the adapter (`compiler/card.ts`, `compiler/interpretable.ts`, `COMPILER_VERSION = 4`):**
  - `compiler/card.ts` compiles every card directly from normalized Oracle text through `parseCost` /
    `parseAdditionalCostSentence` (`compiler/costs.ts`), `parseTrigger` (`compiler/triggers.ts`),
    `parseEffects` (`compiler/effects.ts`), and `parseStaticAbility` (`compiler/statics.ts`),
    attaching `castAdditionalCosts`, `castRestrictions`, and `suspend: { timeCounters, cost }` on
    `CardFaceDef`.
  - `compiler/interpretable.ts` defines the single `isAbilityAutomated(ability)` /
    `stepsStaticallyInterpretable(steps)` predicate shared by `compileCard`, `definitionSupportReport`
    (`compiler/support.ts`), `staticallyInterpretable` (`runtime/effects.ts`), and the coverage script
    (`scripts/magic-coverage.ts`).
  - Unparsed spell faces still attach best-effort `targets: TargetSpec[]` (`extractUnparsedTargets`)
    to `UnsupportedAbility(id: 'cast')` so human players choose targets before manual resolution.
- **Precon automation expanded (zero regressions):**
  - Every one of the **125** precon abilities automated before Step F (82 `interpreter`, 13 `legacy`,
    30 `engine` in `compiler/automation.baseline.json`) is now automated directly on the IR, verified by
    both `compiler/automation.test.ts` (static IR check) and `runtime/step-f-automation.test.ts`
    (runtime execution test for all 125 abilities).
  - Precon abilities previously on the legacy fallback or uncompiled that now compile and execute on
    the IR: **Brainstorm** (`rearrangeTop` + `putHandOnTop`), **Ponder** (`rearrangeTop` + `may`
    `shuffle`), **Arcane Denial** (`createDelayedTrigger` up-to-N draw at next upkeep), **Thassa's
    Oracle** (`winGame` if `devotion >= cardsIn(library)`), **The Ur-Dragon** (`draw` + `may` put a
    permanent card from hand onto the battlefield), **Miirym, Sentinel Wyrm** (`copyPermanent`
    non-legendary token copy of `eventObject`), **Scourge of Valkas** (ETB/other-Dragon damage equal
    to `permanentsMatching` Dragons you control + `{R}: ~ gets +1/+0 until end of turn`), **Nether
    Shadow** (upkeep graveyard check with `graveyardCardsAbove >= 3` returning `self` to the
    battlefield), **Dack Fayden** (`-2: Gain control of target artifact`), **Lathliss, Dragon Queen**,
    **Risen Reef**, **Syr Konrad, the Grim**, **Bident of Thassa**, **Kess, Dissident Mage**, **Tivit,
    Seller of Secrets**, **Tymna the Weaver**, and **Windgrace's Judgment**.
- **Legacy layer deleted (~3,000 net lines removed across `oracle.ts`, `ruleTree.ts`, `engine.ts`, `compiler/adapter.ts`):**
  - Deleted `compiler/adapter.ts`.
  - Deleted `executeParsedEffect`, `ParsedEffect`, `ParsedEffectKind`, `ParsedActivatedAbility`,
    `TargetKind`, `parseSpellOrAbilityEffects`, `parseActivatedAbilities`,
    `parseStructuredTriggeredAbilities`, `parseTriggeredEffects`, `parseDelayedTriggersFromSpell`,
    `parseAdditionalCostsAndRestrictions`, `detectTargetRequirement`, `getPermanentManaProduction`,
    `parseSuspendClause`, `getCardRuleTree`, `clearRuleTreeCache`, `StackItem.legacyEventTarget`,
    `RuntimeTrigger.legacy`, `EvaluatedActivatedAbility.legacy`, and the `"Use the engine's
    approximation instead"` button/path (`PendingPrompt.hasLegacyApproximation`, `useApproximation`).
  - `oracle.ts` is reduced to a 261-line text-free module exporting only mana-symbol/cost utilities,
    type-line/counter helpers, and `parseLibrarySearchSpec` (used by `compiler/effects.ts`).
- **Legend Rule SBA (`CR 704.5j`) and deterministic `uid()` (invariant 7.2):**
  - When a human player controls 2+ legendary permanents with the same name, `runStateBasedActions`
    enqueues a `legend_rule` (`chooseObjects`) prompt allowing the human to choose which copy to keep;
    bots continue to keep the highest-scored copy automatically (`runtime/step-f-legend-uid.test.ts`).
  - `uid(prefix, state)` uses a deterministic per-state counter (`state.nextUid`) instead of
    `Math.random()` and `Date.now()`.
- **Regenerated `COVERAGE.md` (compiler v4, 35,062 Scryfall cards):**
  - All game cards: **6,873 / 35,062 (19.6%) fully supported** (up from 12.6% in v1), **10,267
    (29.3%) ignoring statics**, **24,363 / 62,490 (39.0%) abilities supported**, **0 compiler errors**,
    cold start **32 ms for 400 cards (0.08 ms/card)**.
  - Precon decks: **121 / 140 (86.4%) cards fully supported** (up from 53.2% in v1 and 76.4% in E1),
    **126 / 140 (90.0%) ignoring statics**, **207 / 226 (91.6%) abilities supported**.
- **Suite:** **862 tests pass, 0 todo, 0 fail**; **0 `svelte-check` errors** across `src/lib/magic` and
  `src/routes/magic`.

#### Ultra review fixes (slice 1: `engine.ts`, 2026-11-09)
- **Phase 1 — Hidden information & opaque instance IDs (`engine.ts`, `runtime/random.ts`, `types.ts`):**
  - `sanitizeGameStateForViewer` strips `rngState`, `nextUid`, and `idSalt` from all viewer clones and
    strips `effectResume` frames from stack items (`#4`).
  - Non-viewer `pendingPrompts` are redacted through an explicit public allowlist (`trigger_targets` on
    the battlefield, `trigger_order` on the stack), replacing private descriptions with `"Opponent is
    choosing…"`, stripping `candidateInstanceIds`, and emptying `choice` candidate lists (`#5` part 1).
    Hidden-to-hidden (`hand` ↔ `library`) manual zone moves log `"A card"`.
  - `createInitialGameState` derives a deterministic 32-bit `idSalt` from the initial RNG seed without
    advancing `rngState`, and `uid(prefix, state)` hashes `(idSalt, nextUid)` with a 32-bit bijective
    mixer in base-36 (`#5` part 2). Regenerated `runtime/__snapshots__/golden.json` with a 1-to-1
    instance-ID bijection verified across all 4 golden games.
- **Phase 2 — Load-time `engineVersion` gate (`engine.ts`, `src/routes/magic/api/lobby/+server.ts`):**
  - Exported `enforceEngineVersion(state)` and `enforceLobbyEngineVersion(lobby)` (`#3`), ending active
    or mulligan games with missing (`undefined`) or mismatched `engineVersion` once without duplicating
    log lines, and persisting the finished lobby state in `GET` and `POST /magic/api/lobby` before
    responding with `ok: true`.
- **Phase 3 — Rules bugs (`engine.ts`, `runtime/effects.ts`, `runtime/replace.ts`, `runtime/costs.ts`, `compiler/interpretable.ts`):**
  - Enforced `CR 115.3` target uniqueness per `TargetSpec` slice rather than globally across all modal
    or multi-spec targets, fixed modal error mode-number indexing, and fixed multi-spec target index
    selection (`#6`).
  - Stored triggered-ability targets per `TargetSpec` slot in `StackItem.targetsBySpec` so forced and
    prompted target specs always flatten in `specIndex` order and recompute `targetObjectVersions` when
    prompted targets are chosen (`#8`).
  - Added monotonic `GameState.turnSerial` (incremented on every normal or extra turn transition) and
    keyed `triggersPlacedThisTurn` on `turnSerial ?? turnNumber` (`#9`).
  - Converted chosen Phyrexian mana symbols (`{W/P}`, `{U/P}`, etc.) into 2 life each before auto-tapping
    (`CR 601.2f–h`), prompting humans via `cost_choice`, using a `life > 10` heuristic for bots, and
    enforcing static `playerLifeTotalCantChange` across Phyrexian mana, `payLife`, and Ward (`CR 119.8`,
    `#7`).
- **Phase 4 — Trigger loop detection & backstop (`engine.ts`, `types.ts`):**
  - Replaced the blunt 200-trigger cap (`#10`) with per-`(sourceInstanceId, abilityIndex)` cycle
    tracking across trigger resolution waves (`LOOP_TRIGGER_THRESHOLD = 30`, reset on voluntary player
    actions) using exact and token-normalized board fingerprints.
  - `computeLoopBoardFingerprints` includes per-player state (`life`, `poison`, `lost`, `library.length`,
    `hand.length`, sorted `commanderDamageTaken`) in both fingerprints plus permanent counters in `exactFp`,
    and `putTriggerOnStack` evaluates `cycled` non-stickily per cycle (`CR 104.4b`: a sequence that changes
    a game-ending resource such as draining life to 0 is not an unbreakable loop).
  - On detecting an optional (`"you may"`) loop (`CR 731.2b`), bots automatically decline the optional
    effect to break the loop; on detecting a mandatory loop (`CR 104.4b`), bots-only games end in a
    draw (`winnerPlayerId: null`) while human games prompt to either end in a draw or let the loop run
    30 more cycles.
  - Raised `MAX_TRIGGERS_PER_TURN` to `2000` (with `MAX_STACK_FOR_TRIGGERS = 300`); hitting either hard
    backstop logs loudly and pauses with a `guided_resolution` prompt instead of silently dropping
    triggers.
  - **Known limitation:** after the 2000-trigger backstop prompt, further triggers that turn are dropped
    (one `guided_resolution` prompt, no per-trigger log). Past stack size 300, triggers are dropped with
    a log line each. Not fixed here.
- **Phase 5 — False-positive guards (`ArenaTable.svelte`, `runtime/choices.ts`):**
  - Added `ALL_CHOICE_KINDS`, `ALL_PROMPT_PURPOSES`, `assertExhaustiveChoiceKind`, and a compile-time
    `_exhaustiveChoice: never` fallback in `ArenaTable.svelte` (`#2`).
- **Suite:** **921 tests pass, 0 fail** (including 25 new fail-first tests in `runtime/review-phase12.test.ts`,
  `runtime/review-phase3.test.ts`, and `runtime/review-phase4.test.ts`); all 5 architecture ratchet rules at
  `0`; `0` `svelte-check` errors.

#### Tier 2 — Track A: Compiler & Keyword Truthfulness (`CR 207.2c, 509.1b, 602.5b–c, 702.11d–e, 702.13b, 702.28b, 702.31b, 702.36b, 702.85a, 702.108a–b`, 2026-11-09)
- **Item 1 (`5a4b8f2`) — Canonical `CR 207.2c` ability-word allowlist (`compiler/normalize.ts`, `compiler/index.ts`):**
  - Restricted `ABILITY_WORD` stripping in `normalizeFace` to the 66 canonical ability words in `CR 207.2c` (`ABILITY_WORDS` set) and bumped `COMPILER_VERSION` `4 → 5`. Non-ability-word prefixes (`Solved —`, `Max speed —`, `Boast —`, `Exhaust —`, `Power-up —`) remain in `line.body` so they compile as `unsupported` (`fullySupported: false`) and never apply unconditionally on turn 1.
- **Item 2 (`39d3686`) — Activated-ability restrictions (`ir.ts`, `types.ts`, `compiler/effects.ts`, `compiler/card.ts`, `ruleTree.ts`, `runtime/zones.ts`, `engine.ts`):**
  - Compiled `ActivationRestriction` flags (`onceEachTurn`, `duringYourTurn`, `duringYourUpkeep`, `duringCombat`) onto `ActivatedAbility`, `UnsupportedAbility`, and `EffectiveActivatedAbility`, enforced them in `checkAbilityActivationLegalityInner` and activation handlers (`CR 602.5b, 602.5c`), and tracked once-each-turn activations per ability ID on `CardInstance.activatedAbilityIdsThisTurn` (persisting across control changes within the turn and resetting at turn boundaries and when leaving the battlefield).
- **Item 3 (`5dae1a1`) — Granted keywords enforcement (`compiler/card.ts`, `compiler/triggers.ts`, `compiler/index.ts`, `runtime/triggers.ts`, `runtime/layers.ts`, `engine.ts`, `ai.ts`):**
  - Enforced block legality for `Fear` (`CR 702.36b`), `Intimidate` (`CR 702.13b`), `Shadow` in both directions (`CR 702.28b`), and `Horsemanship` (`CR 702.31b`) in `declare_blockers`, `blocksEachCombat` checks, and bot blocker selection (`CR 509.1b`).
  - Enforced `Hexproof from [quality]` (`hasHexproofFromQuality`, `CR 702.11d`) in `permanentTargetable`, `validateTargetLegalityInner`, and `isTargetStillLegalOnResolution`, and stripped `hexproof from ...` items when `removeKeywords` removes `hexproof` (`CR 702.11e`).
  - Wired innate and continuous-effect-granted `Prowess` (`PROWESS_RUNTIME_TRIGGER` and `matchCast`, `CR 702.108a, 702.108b`) as a noncreature-cast triggered ability giving `+1/+1` until end of turn.
- **Item 4 (`583db73`) — Unsupported keywords on instants and sorceries (`compiler/card.ts`, `compiler/effects.ts`, `engine.ts`):**
  - Emitted `unsupported('keyword_not_implemented', ...)` in `compileFaces` for non-period keyword-style lines on instants/sorceries not matched by `keywordLine`/`triggerLine`/`activatedLine`, restricted `isNonEffectLine` to implemented spell keywords (`Overload`, `Suspend`, `Flash`, `Buyback`), and logged `enteringNotices(card)` on instant/sorcery `Cast` events via `noteUnautomatedOnCast`.
- **Suite:** **925 tests pass, 0 fail** (including 4 fail-first tests in `runtime/tier2a.test.ts`); all 5 architecture ratchet rules at `0`; `0` `svelte-check` errors.

*Original (superseded) entry:*
- **Work:** remove `CardRuleTree` (or keep it as a thin view over the IR for the inspector UI),
  `ParsedEffect`, `ParsedActivatedAbility`, `TargetKind`, `parseTriggeredEffects` and the remaining
  regex parsers in `oracle.ts` that the compiler doesn't use.
- **Exit:** ratchet allowances for `oracleText` and name checks are **0** for all runtime files.
  This is the point where the engine is fully separated from the cards.
- **Results (2026-11-08, branch `engine-rewrite-wave4`):**
  - **Ratchet (`architecture-allowances.json`):** `cardNameComparison`, `oracleTextRead`, and
    `directZoneMutation` are now **`0` across all runtime files** (`engine.ts`: `0 / 0 / 0`,
    `ruleTree.ts`: `0 / 0 / 0`, `ai.ts`: `0 / 0 / 0`, `runtime/**`: `0 / 0 / 0`).
  - **Wave 4 CR Completion (`runtime/wave4-cr-completion.test.ts`):** Closed the remaining 5
    Comprehensive Rules audit items (`CR 103.5 / 103.5c / 103.8a`, `CR 113.7a`, `CR 701.31a`,
    `CR 702.6a`, `CR 702.21a`) with 5 fail-first tests and 0 `svelte-check` errors.

### Phase 11+: The coverage loop (ongoing)
Repeat:
1. Run the coverage script.
2. Take the top unparsed template clusters, prioritising cards in saved decks.
3. Add the grammar production and, if needed, a new verb, cost, static or keyword.
4. Add an IR snapshot test plus one behaviour test using a **synthetic card with an invented
   name**.
5. Commit, then rerun.

Track "% of saved-deck cards fully supported" as the headline metric.

**Long-tail escape hatch:** some cards are true one-offs. For those, write a **hand-authored
`CardDefinition` JSON override** in `src/lib/magic/overrides/<oracleId>.json`. That is still data,
never engine code. Optionally, an offline LLM can draft overrides, but each must pass schema
validation **and** a behaviour test before it's committed. Generated output is never trusted
unreviewed.

---

## 4. Parallel work by multiple agents

- Phases 0 → 1 → 2 are sequential. After Phase 2, **3, 4, 5 and 6 can run in parallel**, because
  they own disjoint files and functions (see each phase's **Owns**). 7 depends on 2 and 6. 8 can
  start after 2. 9 depends on 6. 10 depends on all of them.
- New IR types go in `ir.ts`, not `types.ts`, so most agents never conflict on `types.ts`. Changes
  to `ir.ts` must be additive while parallel phases are running.
- Before starting a phase, an agent re-measures the baseline (§0), checks the ratchet, and notes in
  this file that it's working on the phase (one line under the phase heading).

## 5. Testing strategy

- **IR snapshot tests** (compiler): text → IR JSON for representative cards, plus synthetic cards
  with invented names, to prove the compiler isn't relying on names.
- **Behaviour tests** (runtime): existing `magic.test.ts` suites stay as the regression net.
  **Write each new test so it fails before its fix.**
- **Layer snapshots** before Phase 6 (see Phase 6 entry).
- **Coverage report** checked into CI as a number that must not decrease (another ratchet).
- **Architecture ratchet** (§1).

## 6. Risks and non-goals

- **Risk: the grammar takes longer than expected.** Mitigation: the Phase 1 adapter means the IR
  exists before the grammar is complete; the grammar replaces the adapter one ability type at a time.
- **Risk: behaviour drift during the layer rewrite.** Mitigation: snapshots before changing it.
- **Risk: concurrent agents add special cases.** Mitigation: the ratchet.
- **Risk: Workers cold-start compile cost.** Mitigation: measure in Phase 1, persist IR if needed.
- **Non-goals for this plan:** full coverage of all ~30k cards; layer dependency ordering
  (CR 613.8) beyond timestamps; MDFC/split/adventure/meld faces (the IR leaves room for `faces[]`);
  formats other than Commander.

## 7. Definition of done (whole plan)

1. Ratchet allowances are 0 for `oracleText` reads and name comparisons in every runtime file,
   and 0 for zone mutations outside `runtime/zones.ts`.
2. Every card either compiles fully or has its unsupported abilities listed and handled per §2.7.
3. The coverage report runs on the full bulk data. Coverage for saved-deck cards is tracked and
   does not decrease.
4. The suite is green, with every phase's new tests included.
5. Adding support for a new kind of ability means changing the compiler grammar and,
   at most, adding one new verb/cost/static to the runtime. **It never means adding a card name
   anywhere.**
