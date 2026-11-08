# MTG Engine: Master Architecture Plan: Cards as Data

**Supersedes** `IMPLEMENTATION_PLAN.md` as the long-term roadmap. Don't delete or edit that file;
other agents may still be finishing items from it. Where the two conflict, this plan wins.

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
- **Next (suggested):** begin the real grammar with one narrow area, costs (`compiler/costs.ts`,
  including "Tap N untapped <filter> you control"), run it alongside the adapter and compare outputs
  over the card pool rather than replacing the adapter wholesale.

### Phase 2: Central zone changes and event bus (behaviour-preserving)
- **Status:** in progress (2026-11-08, branch `engine-rewrite-phase2`).
- **Owns:** `runtime/zones.ts`, `runtime/events.ts` (new); zone-mutation sites in `engine.ts`.
- **Work:** route all 72 direct zone mutations through `moveObject`. Emit `ZoneChange`, `Cast`,
  `AttackDeclared`, `DamageDealt`, `PhaseBegin` and `CounterPlaced` events. **The existing
  `triggerOnX` functions remain** and are called from the event dispatcher, so behaviour doesn't
  change yet.
- **Exit:** suite green; the ratchet's zone-mutation count is 0 outside `zones.ts`; a test asserts
  that every zone change emits exactly one event.
- **Ratchet:** zone mutations → 0.

### Phase 3: Real grammar for effects, and the effect interpreter
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
- **Ratchet:** name checks in effect code → 0.

### Phase 4: Costs and activated abilities
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

### Phase 5: Triggers via the event bus
- **Owns:** `compiler/triggers.ts`, `runtime/triggers.ts`; the `triggerOnX` functions, the upkeep
  and end-step loops, combat damage triggers.
- **Work:** compile every trigger form into `TriggerDef` + `Condition`. Match events in one place;
  handle APNAP ordering with a choice prompt for ordering (CR 603.3b), intervening-if checked twice,
  `fromZone` triggers (graveyard), and trigger multipliers from statics. **Delete** all `triggerOnX`
  functions and the per-phase loops.
- **Exit:** every trigger test passes through the new path; Landfall works from every source by
  construction.

### Phase 6: Layer engine from IR, with caching
- **Owns:** `runtime/layers.ts`; `inspectCardContinuousBreakdown`, `permanentHasLostAllAbilities`,
  `evaluatePermanent` in `ruleTree.ts`.
- **Entry:** before rewriting, add **snapshot tests** of the evaluated state (types, P/T, keywords,
  abilities, with the source attributed) for every card the current layer code handles. Add
  `state.version`.
- **Work:** compile continuous statics (anthems, lords, "enchanted creature is a … with base P/T",
  Humility-style removal, "nonbasic lands are …", Opalescence-style type-adding, keyword removal)
  into `StaticDef`. Write `computeContinuousState` per §2.4. Keep `inspectCardContinuousBreakdown`'s
  output shape for the UI inspector.
- **Exit:** snapshots unchanged (or changed only where a rules bug was fixed and documented);
  layer code has no `oracleText` reads; `evaluatePermanent` is O(1) after the first call per state
  version. Baseline test `C/D-Audit-4` passes, if no other agent has fixed it already.

### Phase 7: Replacement effects and rule modifiers
- **Owns:** `runtime/replace.ts`; the rule helpers at the end of `ruleTree.ts`, draw-from-empty,
  hand size, attack tax, player hexproof in `engine.ts`.
- **Work:** per §2.5. Includes the `{N}` attack tax (not fixed `{2}`) and searches controlled by an
  opponent as a generic `ruleModifier` + replacement.
- **Exit:** those helpers deleted; `ruleTree.ts` contains no rules-text reads.

### Phase 8: Generic choice protocol and UI
- **Owns:** `runtime/choices.ts`, `PendingPrompt`/`GameActionPayload` in `types.ts`,
  `ArenaTable.svelte` prompt rendering, the bot choice code in `ai.ts`.
- **Work:** per §2.8. Migrate prompt kinds one at a time behind the new `choice` action; delete
  `obeka_end_turn_choice`. Bump `engineVersion`.
- **Exit:** no card-specific prompt or action types; UI renders all choices generically.

### Phase 9: AI on IR
- **Owns:** `ai.ts`.
- **Work:** heuristics read evaluated abilities and the IR (e.g. "can't be blocked" is an evaluated
  static, so it's removed under Humility automatically). No `oracleText` reads.
- **Exit:** ratchet `oracleText` in `ai.ts` → 0; baseline test `E3` passes, if no other agent has
  fixed it already.

### Phase 10: Delete the legacy layer
- **Work:** remove `CardRuleTree` (or keep it as a thin view over the IR for the inspector UI),
  `ParsedEffect`, `ParsedActivatedAbility`, `TargetKind`, `parseTriggeredEffects` and the remaining
  regex parsers in `oracle.ts` that the compiler doesn't use.
- **Exit:** ratchet allowances for `oracleText` and name checks are **0** for all runtime files.
  This is the point where the engine is fully separated from the cards.

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
