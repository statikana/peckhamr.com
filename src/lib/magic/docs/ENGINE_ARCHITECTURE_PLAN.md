# MTG Engine: Master Architecture Plan: Cards as Data

**Status:** Phases 0–10 and Steps A–F are **complete** as of 2026-11-09 (all 5 architecture ratchet categories at `0`, legacy text parser and adapter retired; `ruleTree.ts` and `oracle.ts` remain as thin helpers over the IR). For the current `COMPILER_VERSION` and coverage, see [`COVERAGE.md`](./COVERAGE.md). Ongoing card coverage expansion continues under **Phase 11+** (§3) and Comprehensive Rules gap remediation is tracked in [`rules-audit/00-SUMMARY-AND-PRIORITIZED-GAPS.md`](./rules-audit/00-SUMMARY-AND-PRIORITIZED-GAPS.md).

**Goal:** the engine knows **what kinds of things abilities can do**, and nothing about specific
cards. Each card is compiled **once** from its Oracle text into a typed data structure (the
*Card IR*). At runtime the engine interprets that structure and never reads a card's name or rules
text. A card the compiler can't fully understand is **explicitly marked unsupported**; it never
half-works silently.

**Strategy:** incremental replacement. The game stays playable and the suite green after every phase.

---

## 0. Baseline snapshot

The 2026-11-08 pre-rewrite baseline is historical; it moved to
[`deprecated/ENGINE_PHASES_0-10_LOG.md`](./deprecated/ENGINE_PHASES_0-10_LOG.md). For current numbers see
[`COVERAGE.md`](./COVERAGE.md) and [`FULL_COVERAGE_STRUCTURE.md`](./FULL_COVERAGE_STRUCTURE.md) §0.

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
*Historical (2026-11-08, before the rewrite): kept for the reasoning. Several types named here (`CardRuleTree`, `TriggerCondition`, `StructuredTriggeredAbility`) no longer exist.*

- **`CardRuleTree` / `getCardRuleTree`** (`ruleTree.ts`) is a memoized compile step with
  actions, triggers and hooks. It's the right idea, and the new IR grows out of it.
- **`TriggerScope`, `TriggerCondition`, `StructuredTriggeredAbility`** (`types.ts`):
  intervening-if conditions are already modelled, and unrecognised conditions don't fire.
- **`moveStackSpellToZone`, `addCountersToPermanent`, LKI fields on `StackItem`, `castMode`.**
- **`guided_resolution`** prompt: a manual resolution path. It becomes the runtime fallback for
  unsupported abilities (see §2.7).
- **`LibrarySearchSpec`**: already a structured, parsed-once spec. It's the model for the rest.

### Root causes this plan removes
*Historical (2026-11-08): the problems the rewrite removed. The functions named here are gone.*

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

## 2. Architecture

The diagram is the architecture as built. §2.1 is the original IR sketch; `ir.ts` is the source of truth where they differ.

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
│  zones.ts       single moveObject() → emits ZoneChange events + LKI   │
│  events.ts      event bus                                             │
│  triggers.ts    trigger matching from IR TriggerDefs                  │
│  layers.ts      continuous effects from IR StaticDefs (CR 613)        │
│  layerCache.ts  board snapshots + read-tracked cache for layers.ts    │
│  objectFilter.ts  ObjectFilter matching over evaluated objects        │
│  replace.ts     replacement effects and rule modifiers (CR 614/616)   │
│  costs.ts       cost planning and payment from IR CostDefs            │
│  effects.ts     interpreter for IR EffectStep lists with bindings     │
│  choices.ts     generic choice protocol (6 ChoiceRequest kinds)       │
│  random.ts      seeded PRNG and opaque ids                            │
└───────────────────────────────────────────────────────────────────────┘
          │
   engine.ts  stack, priority, turn structure, combat and SBAs. Still
              one ~11k-line module; splitting it is proposed in
              FULL_COVERAGE_STRUCTURE.md §1.6, not done.
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
- As built, `moveObject` does nothing implicitly: each caller opts in to `bumpVersion`,
  `newTimestamp` and `leaveBattlefieldReset` (see `ENGINE_INVARIANTS.md` §3.2). `state.stack` is
  still mutated outside `zones.ts`.

### 2.4 Runtime: layers
- `computeContinuousState(state)` collects every `StaticDef{k:'continuous'}` from the IR of
  objects on the battlefield (and command zone where applicable), then applies layers 1–7d in
  CR 613 order with timestamps (dependency ordering, CR 613.8, can come later). It stores
  `EvaluatedPermanent` per object.
- Ability-removal effects (layer 6) remove `AbilityDef`s from the evaluated object; everything
  downstream (triggers, costs, statics) reads evaluated abilities, so "lost all abilities" works
  everywhere automatically.
- **Caching, as built (Phases 6a–6d).** There is no `state.version`; the engine mutates state in
  place. Instead:
  - `layerCache.ts` keeps a `BoardSnapshot` per `GameState` in a `WeakMap` (never in state). It is
    re-validated against an O(n) fingerprint of each battlefield object's identity, controller,
    attachment, timestamp, card, copiable card and face-down status, and rebuilt on any mismatch.
  - `layers.ts` caches each board evaluation with a **read-tracked dynamic fingerprint**. The
    evaluation records which non-board inputs it actually read (tapped filters, life, zone sizes,
    and so on), and only those invalidate it. The stack is not part of the fingerprint.
  - Read-only entry points (legality checks, cost calculation, trigger matching, bot decisions) run
    inside `withStableLayerInputs(state, fn)`, which validates once per scope instead of once per
    query. `applyGameAction` always runs outside these scopes.
  - Equivalence with an uncached recomputation is tested (`runtime/layerCache*.test.ts`) and can be
    checked live with `MAGIC_LAYER_CACHE_CHECK=1`.
- Not built: layers 2 and 3 as layer passes, and `CR 613.8` dependency ordering (see
  `ENGINE_INVARIANTS.md` §2.2).

### 2.5 Runtime: replacement and rule modifiers
- Rule modifiers (`StaticDef` `{ k: 'ruleModifier', rule: RuleModKind }`) and `ReplacementDef`s
  back the queries for can't-lose, can't-win, cast permissions and restrictions, library-search
  interception, hand size, attack tax and player hexproof. The named helpers
  (`playerCannotLoseGame`, `checkGlobalCastPermissionsAndRestrictions`, `getLibrarySearchInterceptor`,
  ...) still exist in `runtime/replace.ts` as thin wrappers over `activeRuleModifiers(state, kind,
  player)` and `applicableReplacements(state, event)`.
- Replacements are applied per domain (zone changes, empty-library draws, ETB, counters, token and
  trigger multipliers), not through one pipeline; see `ENGINE_INVARIANTS.md` §4.1.
- When several replacements apply, the affected player/controller chooses (CR 616.1) via the choice
  protocol.

### 2.6 Persistence and deployment
- **Two deployment modes**, selected by `MAGIC_MODE` (`src/hooks.server.ts`, `db.ts`):
  `cloudflare` (default) runs `/magic/api/*` in the Worker against D1; `homelab` proxies it to a
  Node 24 service with `node:sqlite` and in-process per-lobby locking. Setup, migration and cutover:
  [`ops/magic-backend/README.md`](../../../../ops/magic-backend/README.md).
- Games are saved as `MagicLobbies.game_state_json` (D1 or SQLite). Every `CardInstance.card` and
  `StackItem.card` embeds a full `ScryfallCard`. **Keep that for display, but never add IR to
  state.** The runtime looks up `CardDefinition` by `card.oracleId` (fall back to `card.id`) from
  the cache.
- In `cloudflare` mode the engine runs on Workers (`@sveltejs/adapter-cloudflare`). Module caches
  are per-isolate, so a cold start recompiles. **Decided:** no persisted IR (no D1 table); compile at
  runtime and cache in memory. **Measured in Phase 1:** 400 distinct cards (a 4×100-card game with no
  repeats, both caches empty) compile in ~40 ms in Node 24 (~0.1 ms/card). Not measured in workerd,
  but even several times slower is negligible next to a request, so **the per-isolate in-memory
  cache is enough**; no build-time bundle is needed. Revisit if the grammar compiler is much slower
  than the adapter.
- `GameState.engineVersion` (`ENGINE_VERSION` in `types.ts`, currently 2): `enforceEngineVersion`
  ends a loaded game whose version is missing or different, with a system log entry. Bump it when a
  state shape change would break games in progress.
- **Bot pacing:** the `botSpeed` lobby rule paces bot actions. The server records when bots may act
  next and the client calls the `advance_bots` lobby action; see `ai.ts` (`botDelayMs`) and
  `ai-pacing.test.ts`.
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
- As built, `ChoiceRequest` (`types.ts`) is a discriminated union of the six kinds, each with its
  own fields, rather than one shape with `min`/`max`/`candidates`.

### 2.9 Runtime mechanisms added after Phase 10
These were designed during the post-Phase-10 reviews (2026-11-09 to 11-11). The full history is in
[`deprecated/ENGINE_PHASES_0-10_LOG.md`](./deprecated/ENGINE_PHASES_0-10_LOG.md); this is the
current design.

- **Loop detection (`CR 104.4b`, `731.2b`; `engine.ts`).**
  - Trigger loops are tracked per `(source, ability)` across resolution waves, comparing an exact
    and a token-normalised board fingerprint (`computeLoopBoardFingerprints`). The fingerprints
    include life, poison, library and hand size and commander damage, because a sequence that drains
    a game-ending resource isn't an unbreakable loop. Tracking resets on any voluntary player action.
  - An optional loop: bots decline the "you may". A mandatory loop: a bots-only game ends in a draw,
    and a game with humans asks whether to draw or let it run 30 more cycles.
  - Hard backstops: `MAX_TRIGGERS_PER_TURN = 2000` and `MAX_STACK_FOR_TRIGGERS = 300` log and pause
    with a manual-resolution prompt. Known limitation: triggers past the backstop that turn are
    dropped.
- **Deferred zone changes (`CR 616.1`; `runtime/zones.ts`).** When a zone change has two or more
  competing replacement effects for a human to order, the object leaves its zone but isn't placed:
  it is held in `state.pendingZoneMoves` with its LKI, no `ZoneChange` is emitted, and the move
  finishes when the `zone_replacement_choice` prompt is answered. State-based actions pause while a
  `chooseReplacement` prompt is pending.
- **Hidden information (`sanitizeGameStateForViewer`, `engine.ts`).**
  - Every viewer's copy has `rngState`, `nextUid`, `idSalt` and stack `effectResume` frames removed.
  - Other players' prompts are reduced to a public allowlist ("Opponent is choosing…", no
    candidates).
  - Instance ids are opaque: `uid` hashes `(idSalt, nextUid)`, so ids don't reveal creation order.
  - Moves between hidden zones are logged as "A card".
- **Ability and flavor words (`CR 207.2c–d`; `compiler/normalize.ts`).** A leading "Word — " is
  stripped as an ability or flavor word unless it is a rules term (`RULES_TERM_BLOCKLIST`, checked
  by `isAbilityOrFlavorWord`), so "Ward—Pay 3 life" and keyword actions aren't mistaken for one.

### 2.10 Pausable resolution everywhere (Track B1)

*Status: implemented in Track B1 (`types.ts`, `ir.ts`, `runtime/effects.ts`, `runtime/costs.ts`, `runtime/triggers.ts`, `runtime/zones.ts`, `runtime/choices.ts`, `engine.ts`).*

#### Why the prior pause model blocked Track B

Previously, the engine paused in several disconnected ways:
- `StackItem.effectResume` (`types.ts`) stored only `stepIndex`, `bindings`, and `answers: Record<string, string[]>`, re-running `steps[stepIndex]` from the top on resume (`runtime/effects.ts`). That broke if a step mutated state before pausing on a later object or player, keyed answers only by `playerId`, only accepted `chooseObjects`/`chooseMode` in `handlePromptResolution` (`engine.ts`), and left `PROMPTING_VERBS` unable to preserve remaining objects in a step if a replacement prompt fired mid-step.
- `compiler/interpretable.ts` rejected any `step.optional` after index 0 or with a non-`you` chooser, and had no representation for `"If you do, ..."`, forcing mid-ability `"you may"` and `"Partner with [name]"` (`CR 702.124j`) to compile as `unsupported`.
- `resumeStackItem` (`engine.ts`) flushed deferred triggers (`runtime/triggers.ts`) immediately when resolution paused because the trigger queue was in-memory only, placing triggers onto `state.stack` above a still-resolving item (`CR 603.3`, `CR 608.2`), and `handlePromptResolution` ran `checkStateBasedActions` before `resumeAfterPrompt` finished resolving (`CR 704.4`).
- Paying a cost had no mid-payment continuation if paying triggered a `zone_replacement_choice` / `commander_zone_choice`.
- Rules procedures managed ad-hoc continuations without a shared pause guard or resume loop.

#### Architecture (as built)

1. **Resumable `EffectResumeFrame` with sub-step cursor and typed answers (`CR 608.2`).**
   - `EffectResumeFrame` on `StackItem` is plain JSON:
     - `stepIndex: number`, `subStepIndex?: number` (tracks progress inside multi-actor or multi-object loops such as `runIndexedBatch` for multi-target/multi-object `destroy`/`exile`/`bounce`/`putCounters`/`sacrifice`/`discard`/`move`/`mill`, so earlier mutations never replay), and `phase?: 'optional' | 'step' | 'afterStep'`.
     - `bindings: Array<[string, EffectBindingSnapshot[]]>`, `exileSelf?: boolean`.
     - `answers: Record<string, ChoiceAnswer>` keyed by deterministic slot keys (supporting all 6 `ChoiceAnswer` kinds).
     - `stepDecisions?: Record<number, boolean>` recording whether optional step `i` was accepted, so conditional follow-up steps (`EffectStep.ifPrecedingAccepted?: number`, shifted cleanly by `shiftStepTargets` for modal spells) evaluate across pauses.
   - `handlePromptResolution` validates answers with `validateChoiceAnswer` against `prompt.choice` and stores typed `ChoiceAnswer` slots on `item.effectResume.answers`.

2. **Deferred triggers & SBAs across resolution pauses (`CR 603.3`, `CR 608.2n`, `CR 704.3–704.4`).**
   - `GameState.pendingTriggers?: SerializedPendingTrigger[]` persists deferred triggers in plain JSON across round-trips and restarts.
   - `isResolutionPaused(state)` (`runtime/triggers.ts`) checks active `StackItem.resolutionStarted`, `pendingCostPayment`, `pendingProcedure`, `pendingZoneMoves`, and blocking `chooseReplacement` prompts. While paused, `flushTriggers` persists waiting `'stack'` triggers into `state.pendingTriggers` and `checkStateBasedActions` defers (`CR 704.4`).
   - Once a resolving `StackItem` completes and leaves the stack (`CR 608.2n`), `checkStateBasedActions` stabilizes and `flushTriggers` places triggers in normal `CR 603.3b` APNAP order.
   - *Nested replacement pauses:* `pauseForNestedPrompts` and `linkPromptsToStackStep` (`runtime/effects.ts`, `runtime/zones.ts`) pause the step cleanly when a `zone_replacement_choice`, `commander_zone_choice`, or `counter_replacement_choice` fires mid-effect, returning control to the paused `StackItem` without running premature SBAs.

3. **IR & compiler support for mid-ability `"may"`, `"If you do"`, and `"Partner with [name]"` (`CR 702.124j`).**
   - `EffectStep.ifPrecedingAccepted?: number` (`ir.ts`) encodes `"If you do, ..."` / `"If that player does, ..."` / `"If they do, ..."`.
   - `compiler/interpretable.ts` permits `step.optional` at any `stepIndex` for any single `PlayerRef` chooser and on `search` (`CR 701.19`: declining skips searching and shuffling; searching and failing to find still shuffles).
   - `compiler/card.ts` compiles `"Partner with [name]"` directly to `partner` plus its `CR 702.124j` ETB library-search triggered ability (`ObjectFilter.named`, `LibrarySearchSpec.named`).

4. **Pausable `PendingCostPayment` (`CR 601.2`, `CR 602.2`).**
   - Pre-payment `askCostChoice` / `planCosts` (`runtime/costs.ts`, `engine.ts`) stays cancellable before anything is paid.
   - Committed execution runs through `GameState.pendingCostPayment` (`PendingCostPayment`: `parts: SerializedPlannedCost[]`, `tapsAndManaDone`, `nextPartIndex`, `nextObjectIndex`). If a `sacrifice`, `discard`, `exileFrom`, or `mill` part triggers `zone_replacement_choice` / `commander_zone_choice`, payment pauses at `(nextPartIndex, nextObjectIndex)` and resumes without re-paying tap/mana or completed parts before finalizing the cast/activation/`tap_mana`.

5. **Unified `ProcedureContinuation`, strict validation, bots, and redaction.**
   - `ProcedureContinuation` (`types.ts`) on `GameState.pendingProcedure` and `PendingPrompt.continuation` unifies non-stack pauses (`legend_rule`, `discard_to_hand_size`, `combat_damage_step`, `combat_damage_assignment`, `zone_replacement_choice`, `counter_replacement_choice`, `commander_zone_choice`, `clone_copy_choice`, `aura_library_attach_choice`, `ward_payment_choice`, and `end_turn`) through `resumeAfterPrompt` (`engine.ts`).
   - Strict validation (`runtime/choices.ts`, `engine.ts`): `validateChoiceAnswer` enforces `orderObjects` completeness; `handlePromptResolution` rejects wrong/foreign/stale `promptId`s, mismatched `effect_choice` continuations, stale `manual_resolution` / `trigger_targets` / `trigger_may`, invalid `cost_choice`, and forged/duplicate `london_bottom` IDs without mutating `pendingPrompts`.
   - Bots decide optional steps synchronously when prompted inline and answer queued `PendingPrompt`s via `{ type: 'choice' }` (`ai.ts`).
   - `sanitizeGameStateForViewer` (`engine.ts`) strips `pendingTriggers`, `pendingCostPayment`, `pendingProcedure`, and `stack[i].effectResume` from viewer copies.

---

### 2.11 Cast options in place of `castMode` (Track B2)

*Status: implemented in Track B2 (`types.ts`, `compiler/card.ts`, `runtime/costs.ts`, `runtime/effects.ts`, `engine.ts`, `ai.ts`, `ArenaTable.svelte`); optional Slice 3 (Kicker) deferred to Track B3 per user decision.*

#### Why `castMode` blocked further casting mechanics

Previously, casting options were hardcoded around a binary union:
- `castMode?: 'normal' | 'overload'` (`types.ts`) was threaded through `StackItem`, `PendingCostPayment`, the `cast_spell` action, `engine.ts`, `runtime/costs.ts`, `ai.ts`, and `ArenaTable.svelte` (`overloadModalCard`).
- `checkSpellCastLegalityInner` rejected `'graveyard'`, and `ArenaTable.svelte` inspected `keywordCost(inst.card, 'overload')` directly to open an Overload-specific modal.
- Adding **Flashback** (`CR 702.34`), **Kicker** (`CR 702.33`), and future casting mechanics under this pattern would multiply flags, modals, and bot special cases instead of driving them from data.

#### Architecture (as built)

1. **Data-driven `CastOption` enumeration (`types.ts`, `runtime/costs.ts`, `engine.ts`).**
   - `CastOption` (plain JSON) describes a legal way to cast a `CardInstance` from `fromZone`:
     - `id: string` (`'normal'`, `'alt:overload'`, `'alt:flashback'`, `'exile:permission'`, `'exile:suspend'`). UI and AI choose by `optionId` without naming keywords.
     - `label: string`, `costDisplay: string` rendered directly by UI modals (`castOptionsModal`, graveyard badges).
     - `fromZone: 'hand' | 'command' | 'exile' | 'graveyard'` and `permission: 'zone_default' | 'keyword_alt' | 'exile_permission'`.
     - `baseCost`: `{ kind: 'printed' } | { kind: 'alternative'; manaCost?: string; costDefs?: CostDef[] } | { kind: 'free' }` (handling both mana-only and non-mana/composite costs via `planCosts` and `PendingCostPayment`).
     - `mandatoryAdditionalCosts?: CostDef[]`, `optionalAdditionalCosts?: CastOptionOptionalCost[]` (extension slot ready for Track B3 Kicker), `timing: 'default' | 'instant_only'`.
     - `spellMods: SpellModifications` (`targetsBecomeEach`, `exileOnLeaveStack`, `entersWithCounters`, `sacrificeAtEndStep`, `castSummarySuffix`, `label`).
     - `choosesX: boolean` and `requiresTarget: boolean` derived engine-side for that option.
   - `getCastOptions(state, actorId, inst, fromZone): CastOption[]` returns the currently legal `CastOption`s under `withStableLayerInputs`. Special actions (`play_land`, `suspend_card`) remain separate (`CR 116`).
   - `castMode` was deleted completely from `types.ts`, `engine.ts`, `runtime/costs.ts`, `runtime/effects.ts`, `ai.ts`, and `ArenaTable.svelte`. `StackItem` and `PendingCostPayment` store `castOptionId`, `spellMods`, and `optionalCostCounts`.

2. **Generalized alternative-cost registry & Flashback compilation (`runtime/costs.ts`, `compiler/card.ts`).**
   - `ALTERNATIVE_COST_KEYWORDS` carries declarative metadata (`id`, `label`, `castSummarySuffix`, `stackBadgeLabel`, `zones`, `requiresZonePermission`, `spellTypes`, `targetsBecomeEach`, `exileOnLeaveStack`, `timing`) shared by `overload` (`CR 702.96`) and `flashback` (`CR 702.34a`: `'graveyard'` only, `ownerId === actorId`, `Instant` or `Sorcery` only, `exileOnLeaveStack: true`). `keywordAltCost(card, kwName)` splits mana vs non-mana `CostDef`s and formats `display`.
   - `compiler/card.ts` parses both `Flashback {mana}` and composite `Flashback—[cost].` via `parseCost` (populating `keyword.costDefs` or emitting `unsupported('unparsed', ...)`), adds `'flashback'` to `IMPLEMENTED_KEYWORDS`, and `compiler/index.ts` bumped `COMPILER_VERSION` (`12` → `13`).

3. **Pausable `CR 601.2b–h` casting pipeline & universal stack-exit replacement (`engine.ts`).**
   - `cast_spell` accepts `optionId?` alongside `targets`, `modes`, `xValue`, `optionalCostCounts`, and `costPayment`, resolving through `resolveCastOptionForAction`, pre-payment cancellable prompts (`CR 601.2` / `CR 734`), and `PendingCostPayment` (`CR 601.2h`), preserving `CR 118.9c` printed mana value and `CR 118.9d` cost modification rules.
   - `moveStackSpellToZone` (`engine.ts`) enforces `CR 702.34a` (`if (stackItem.spellMods?.exileOnLeaveStack) dest = 'exile'`) across normal resolution, `CR 608.2b` target fizzle, Counterspell, Ward, End the Turn, and player elimination.
   - `runtime/effects.ts` reads `item.spellMods?.targetsBecomeEach`.

4. **Keyword-agnostic UI (`ArenaTable.svelte`) and Bot AI (`ai.ts`).**
   - Both files contain zero `'overload'` or `'flashback'` string literals and zero `castMode` references.
   - `ArenaTable.svelte` uses `getCastOptions` for hand, command, exile, and graveyard (`playableGraveyardCount`, graveyard modal cast badges/buttons), opens `castOptionsModal` (**Choose How to Cast — ...**) when multiple options are available, and displays both `spellMods.castSummarySuffix` and `targets` on stack items.
   - `ai.ts` evaluates `getCastOptions` across `hand`, `command`, `exile`, and `graveyard`, choosing options from `spellMods` and submitting `optionId`.

#### Implementation slices

- **Slice 1 (CastOption model, Overload migration, delete `castMode`):** Implemented `CastOption` / `getCastOptions`, removed `castMode`, migrated `engine.ts`, `runtime/costs.ts`, `runtime/effects.ts`, `ai.ts`, `ArenaTable.svelte`, and existing Overload tests.
- **Slice 2 (Flashback & live app verification):** Compiled `'flashback'` (`COMPILER_VERSION = 13`), generalized `keywordAltCost` and `moveStackSpellToZone` `exileOnLeaveStack`, wired graveyard casting UI/AI, added full Flashback tests, and verified Overload + Flashback in the live app (`vite dev` headless Chrome check).
- **Deferred to Track B3:** Kicker (`CR 702.33`, using `CastOption.optionalAdditionalCosts`) will be implemented alongside the keyword registry in Track B3.

---

### 2.12 Keyword registry & Kicker (Track B3)

*Status: implemented in Track B3 across Slices 1–3 (`keywords.ts`, `runtime/kicker.ts`, `ir.ts`, `types.ts`, `ruleTree.ts`, `engine.ts`, `ai.ts`, `ArenaTable.svelte`, `compiler/`, `runtime/`, `COMPILER_VERSION = 16`), with `Exploit` (`CR 702.110a`) included and `Cycling` (`CR 702.29`) deferred past B3.*

#### Architecture (as built)

1. **Unified declarative `KEYWORD_REGISTRY` (`src/lib/magic/keywords.ts`).**
   - Exports one typed record keyed by canonical lower-case keyword name (`name: string`, `cr: string`, `parameterKind: 'none' | 'cost' | 'number' | 'quality' | 'cardName' | 'text'`, `displayLabel?: string`, `grantable: boolean`, `status: 'implemented' | 'unimplemented'`).
   - Declares each implemented keyword's compilation/runtime binding in one place via a discriminated `implementation` union:
     - `'primitive'`: enforced directly by existing runtime hooks (evasion, combat damage, cast timing, targeting restrictions), optionally carrying declarative metadata (e.g. evasion predicate).
     - `'castOption'`: metadata consumed by `runtime/costs.ts` / `getCastOptions` (e.g. `overload`, `flashback`, `kicker`, `multikicker`).
     - `'trigger'`: pure builder `(kw: KeywordDef) => TriggeredAbility[]` (or parameterized factory), unifying existing `ward` (`CR 702.21`) and `prowess` (`CR 702.108`) plus newly added triggered keywords.
     - `'static'`: pure builder `(kw: KeywordDef) => StaticDef[]` (e.g. `affinity`).
     - `'activated'`: pure builder `(kw: KeywordDef) => ActivatedAbility[]` (for parameterized activated keywords such as `equip`, future `cycling`).
   - **Eliminating duplicate lists:** `compiler/card.ts` derives `IMPLEMENTED_KEYWORDS` and `KNOWN_KEYWORDS` from `KEYWORD_REGISTRY`; `compiler/statics.ts` derives grantable static keywords from it; `compiler/effects.ts` derives `GRANTABLE_KEYWORDS` from `grantable: true`; `runtime/layers.ts` derives `KEYWORD_LABELS`; `runtime/costs.ts` derives `ALTERNATIVE_COST_KEYWORDS`; and `runtime/keywords-coverage-guard.test.ts` asserts 1:1 coverage against every implemented entry in `KEYWORD_REGISTRY`.
   - **Architecture ratchet compliance:** `src/lib/magic/keywords.ts` holds only structured IR builders and CR metadata — zero `oracleText` reads and zero card-name comparisons (`architecture.test.ts`). Test-only sample oracle lines stay in `runtime/keywords-coverage-guard.test.ts`.

2. **Uniform expansion of granted keyword abilities (`runtime/triggers.ts`).**
   - Today `runtime/triggers.ts` special-cases `PROWESS_RUNTIME_TRIGGER` when continuous Layer 6 effects grant `'prowess'`.
   - Replacing that special case with a generic `KEYWORD_REGISTRY` trigger lookup lets *any* `'trigger'` keyword granted by Layer 6 (`prowess`, `battle cry`, `bushido N`, `afflict N`, etc.) trigger identically to printed keywords without per-keyword branches in `runtime/triggers.ts`.

3. **Pure-IR keywords vs. thin runtime primitives (honest scoping).**
   Checking the candidate keywords named in `NEXT_STEPS_SPEC.md` §B3 against the actual IR (`ir.ts`), compiler, and `engine.ts` reveals which keywords expand purely to *existing* IR and which genuinely need small primitives:
   - **Pure-IR keywords (zero runtime changes — expand directly from `KEYWORD_REGISTRY` to existing IR):**
     1. **`Battle cry` (`CR 702.91a–b`):** `{ event: 'attacks', filter: { object: 'self' } }` → `pump` `{ k: 'all', filter: { types: ['Creature'], attacking: true, other: true } }` `+1/+0` `endOfTurn`.
     2. **`Afterlife N` (`CR 702.135a–b`):** `{ event: 'zoneChange', filter: { object: 'self', from: 'battlefield', to: 'graveyard' } }` → `createToken` `N` 1/1 `W/B` Spirit creature tokens with `flying`.
     3. **`Bushido N` (`CR 702.45a–b`):** `{ event: 'blocks', filter: { object: 'self' }, or: [{ event: 'becomesBlocked', filter: { object: 'self' } }] }` → `pump` `{ k: 'self' }` `+N/+N` `endOfTurn`.
     4. **`Living weapon` (`CR 702.92a`):** `{ event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } }` → `createToken` 0/0 `B` Phyrexian Germ (`bindAs: 'germ'`) → `attach` `{ k: 'binding', name: 'germ' }`. (`CR 704.3` SBAs wait until the trigger finishes resolving, so an Equipment granting +toughness keeps the 0/0 Germ alive.)
     5. **`For Mirrodin!` (`CR 702.163a`):** `{ event: 'zoneChange', filter: { object: 'self', to: 'battlefield' } }` → `createToken` 2/2 `R` Rebel (`bindAs: 'rebel'`) → `attach` `{ k: 'binding', name: 'rebel' }`.
     6. **`Affinity for [quality]` (`CR 702.41a–b`):** `StaticDef` `{ k: 'costModifier', affects: { k: 'self' }, delta: { mode: 'reduce', generic: 1, times: { k: 'count', of: { ...qualityFilter, controller: 'you', zone: 'battlefield' } } }, who: { relation: 'you' } }` (uses the already-implemented `affects.k === 'self'` path in `runtime/costs.ts`).
     7. *(Optional 7th)* **`Exploit` (`CR 702.110a`):** ETB trigger → optional `sacrifice` a creature (`CR 702.110b` companion triggers `"When ~ exploits a creature"` remain a separate future trigger rule).
   - **Candidates requiring small, explicit IR/runtime additions (should NOT be claimed as "no runtime changes"):**
     - **`Exalted` (`CR 702.83a–b`):** `matchAttack` (`runtime/triggers.ts`) does not yet filter on `attackers.length === 1`. Needs `alone?: boolean` on `EventFilter` (`ir.ts`) so `matchAttack` sets `eventObject` to that sole attacker when `attackers.length === 1`.
     - **`Annihilator N` (`CR 702.86a–b`):** `PlayerRef` (`ir.ts`) has no `'defendingPlayer'` variant (the audit in `rules-audit/03` notes this). Using `'opponent'` would break 4-player Commander. Needs `{ k: 'defendingPlayer' }` on `PlayerRef` plus propagating each attacker's `defendingPlayerId` through `matchAttack` → `RuntimeTrigger` → `StackItem`.
     - **`Landwalk` (`CR 702.14a–e`):** `getBlockerRestrictionReason` (`engine.ts`) only checks Flying, Fear, Intimidate, Shadow, and Horsemanship. Needs a Landwalk check inspecting whether the defending player controls a matching land (`[subtype]walk`, `landwalk`, `nonbasic landwalk`).
     - **`Cycling [cost]` / Typecycling (`CR 702.29a–f`):** `engine.ts` (`case 'activate_ability'`) only searches `actor.battlefield`. Cycling requires activating an ability from `'hand'`, a discard-this-card cost from `'hand'`, and hand-zone ability activation in `ArenaTable.svelte` / `ai.ts`. *(Better suited to its own focused follow-up or dedicated slice rather than piggybacking on pure-IR entries.)*

4. **Kicker & Multikicker (`CR 702.33a–h`).**
   - **Compiler & IR (`compiler/card.ts`, `compiler/effects.ts`, `ir.ts`):**
     - Parse `"Kicker [cost]"`, `"Kicker [cost 1] and/or [cost 2]"` (`CR 702.33b`), and `"Multikicker [cost]"` (`CR 702.33c`) via `parseCost` into `KeywordDef` (`costDefs`, optional kicker tag key).
     - Add `Condition` `{ k: 'kicked', tag?: string, minCount?: number }` (`CR 702.33d–f`) and `Amount` `{ k: 'kickedCount', tag?: string }`, updating all `evaluateCondition` / `evaluateAmount` evaluators (`runtime/objectFilter.ts`, `runtime/layers.ts`, `runtime/triggers.ts`, `runtime/effects.ts`) cleanly.
     - Compile `"if it was kicked"`, `"if ~ was kicked"`, `"if it was kicked with its [X] kicker"`, `"with N +1/+1 counters on it if it was kicked"`, and multikicker count clauses (`"with a +1/+1 counter on it for each time it was kicked"`) into `Condition` / `ReplacementDef` / `EffectStep`.
   - **Runtime & `CastOption.optionalAdditionalCosts` (`runtime/costs.ts`, `runtime/zones.ts`, `engine.ts`):**
     - `getCastOptions` populates `option.optionalAdditionalCosts` from `kicker` / `multikicker` keywords (`id: 'kicker:0'`, `'kicker:1'`, etc.; `maxCount: 1` for Kicker, `maxCount: 99` for Multikicker; `kickedTag`). Per `CR 118.9d` & `CR 702.33a`, kicker optional costs combine normally with alternative costs (e.g. Flashback) unless forbidden, and follow `CR 601.2b / 601.2f–h`.
     - `cast_spell` validates `optionalCostCounts` against the chosen `CastOption.optionalAdditionalCosts` (`0 <= count <= maxCount`), appends selected `costDefs` × count to the total cost planned through `planCosts` and `PendingCostPayment`, and stores `optionalCostCounts` on `StackItem`.
     - Conditional kicker targets (`CR 702.33g`): target clauses gated by a kicker condition are required/validated if and only if the corresponding kicker cost was declared as paid.
     - When a permanent spell resolves onto the battlefield (`engine.ts` + `runtime/zones.ts`), `StackItem.optionalCostCounts` seeds plain-JSON `kickedCount` / `kickedTags` on the resolving `CardInstance` before ETB replacements and ETB triggers fire; `runtime/zones.ts` clears kicker tracking whenever a permanent leaves the battlefield or stack (`CR 400.7`).
   - **Keyword-agnostic UI (`ArenaTable.svelte`) & Bot AI (`ai.ts`):**
     - UI renders generic optional additional cost checkboxes (`maxCount === 1`) / `− / +` steppers (`maxCount > 1`) from `CastOption.optionalAdditionalCosts` (`label`, `costDisplay`) before confirming targets / payment — zero `'kicker'` literals in `ArenaTable.svelte` or `ai.ts`.
     - Bot AI evaluates affordable `optionalAdditionalCosts` entries conservatively (paying when affordable and mana remains for higher-priority plays or when spell value improves).

#### Implementation slices

- **Slice 1 (Registry consolidation + 7 pure-IR keywords + generic granted triggers):** Created `src/lib/magic/keywords.ts`, derived all duplicated keyword lists (`IMPLEMENTED_KEYWORDS`, `KNOWN_KEYWORDS`, `STATIC_CONTINUOUS_KEYWORDS`, `GRANTABLE_KEYWORDS`, `KEYWORD_LABELS`, `ALTERNATIVE_COST_KEYWORDS`, `GRANTED_TRIGGER_KEYWORD_EVENTS`), generalized `runtimeTriggers` and Layer 6 granted-trigger emission (`runtime/triggers.ts`), and added 7 pure-IR keywords (`battle cry`, `afterlife`, `bushido`, `living weapon`, `for mirrodin!`, `affinity`, and `exploit` `CR 702.110a`).
- **Slice 2 (Small combat primitives — `Exalted`, `Annihilator`, `Landwalk`):** Added `EventFilter.alone`, `PlayerRef` `'defendingPlayer'`, and data-driven `Landwalk` evasion (`getBlockerRestrictionReason` + `landwalkFilter` for `landwalk`, `plainswalk`, `islandwalk`, `swampwalk`, `mountainwalk`, `forestwalk`, `nonbasic landwalk`).
- **Slice 3 (Kicker & Multikicker `CR 702.33`):** Added `runtime/kicker.ts`, `{ k: 'kicked' }` / `{ k: 'kickedCount' }` IR + all 4 runtime evaluators, `EffectStep.condition`, `TargetSpec.condition` (`CR 702.33g`), ETB replacements, `CR 400.7` zone reset (`runtime/zones.ts`), keyword-agnostic `CastOption.optionalAdditionalCosts` UI (`ArenaTable.svelte`) & bot AI (`ai.ts`), `COMPILER_VERSION = 16`, IR snapshots, live `vite dev` Chromium verification (*Quag Vampires*), and `COVERAGE.md` regeneration. Kicked spells with replacement `"instead"` clauses remain intentionally `unsupported` (`unparsed`).

---

### 2.13 Hand-zone activated abilities & Cycling (CR 702.29)

*Status: implemented across Slices 1–2 (`keywords.ts`, `ir.ts`, `types.ts`, `ruleTree.ts`, `engine.ts`, `ai.ts`, `ArenaTable.svelte`, `compiler/`, `runtime/`, `COMPILER_VERSION = 17`), with live `vite dev` Chromium verification and regenerated [`COVERAGE.md`](./COVERAGE.md).*

`CR 702.29a–f` introduces the first general non-battlefield activated ability in the engine. Rather than special-casing `'cycling'` in `engine.ts`, `ArenaTable.svelte`, or `ai.ts`, the design extends the `ActivatedAbility` / `EffectiveActivatedAbility` / `CostDef` model so any hand-activated ability works uniformly and future hand/graveyard activated abilities (Channel, Unearth, Forecast, Bloodrush) reuse the same machinery.

#### Architecture

1. **Zone-scoped activated abilities (`ir.ts`, `types.ts`, `ruleTree.ts`, `engine.ts`).**
   - Add `activationZones?: ZoneType[]` on `ActivatedAbility` (`ir.ts`) and `EffectiveActivatedAbility` (`types.ts`), defaulting to `['battlefield']`.
   - `getCardActivatedAbilities` (`ruleTree.ts`) keeps emitting every activated ability regardless of zone (`CR 702.29b`: cycling continues to exist on the battlefield and in all other zones).
   - Add `getHandActivatedAbilities(card)` or preserve the zone list through `buildEffectiveActivatedAbility` so `activate_ability` (`engine.ts`) and `checkAbilityActivationLegalityInner` (`engine.ts`) locate `action.instanceId` across `actor.battlefield` (existing default) **or** `actor.hand` when `ab.activationZones?.includes('hand')` matches, checking `zone === 'battlefield'` only for battlefield abilities and checking `!perm.phasedOut` on battlefield.
   - `case 'activate_ability'` must enforce zone match (a battlefield-only ability cannot be activated from hand; a hand-only ability such as Cycling cannot be activated from the battlefield).
   - Global ability-activation restrictions (`checkGlobalAbilityActivationRestrictions`, `CR 602.5b`) and `costContext` (`isSpell: false`) work from hand with `resolveCostSourceCard` (`engine.ts`) and `sourceCard` preserved on `PendingCostPayment` and the resulting `StackItem` (`CR 113.7a`, `CR 602.2b`). Because paying Cycling moves the card out of `actor.hand` (into `graveyard`, or `exile` under Rest in Peace if replacement triggers a `PendingCostPayment` pause), `finalizeActivateAbility` resolves `sourceCard` / LKI cleanly even after the card leaves hand.

2. **Discard-self cost & cost modifiers (`ir.ts`, `runtime/costs.ts`).**
   - Widen `CostDef` `{ k: 'discard', count: Amount; filter?: ObjectFilter | 'self'; random?: boolean }`.
   - When `filter === 'self'` in `planCosts` / `executeCostPaymentParts` (`runtime/costs.ts`): requires `ctx.source.zone === 'hand'` (and `!ctx.isSpell`), consumes zero user object choices (self is implicit, matching `sacrifice` / `exileFrom` `'self'`), moves `ctx.source` via `moveFromZone(ctx, ctx.source, 'hand', 'graveyard')` (`CR 701.9a`), and cleanly suspends inside `PendingCostPayment` if a graveyard replacement (`zone_replacement_choice`) pauses payment (Track B1 Slice 2). Under `CR 701.9c` / hidden-zone rule checks, discarding to pay a cost puts the card into a public zone unless replaced; replacement prompts preserve the state until resolved.
   - Generalize `effectiveAbilityManaCostInner` (`runtime/costs.ts`) from equip-only (`abilityId.startsWith('equip_')`) to check `mod.affects.k === 'ability'` by matching the ability's canonical keyword tag (`'equip'`, `'cycling'`, etc.), so `CR 702.29f` (*Fluctuator*-style `"Cycling abilities you activate cost {2} less"`, `"Activated abilities ... cost less"`) reduces both mana Cycling and Typecycling costs (`CR 702.29f`: typecycling costs are cycling costs).

3. **`KEYWORD_REGISTRY`, Cycling & Typecycling (`keywords.ts`, `compiler/card.ts`, `ruleTree.ts`, `ir.ts`).**
   - Implement `'cycling'` (`CR 702.29a`), `'basic landcycling'`, `'landcycling'`, `'typecycling'`, and subtype/quality cycling (`Plainscycling`, `Islandcycling`, `Swampcycling`, `Mountaincycling`, `Forestcycling`, `Slivercycling`, `Wizardcycling`, `Artifactcycling`, etc. per `CR 702.29e`).
   - Instead of hardcoding dozens of individual keyword names, extend `parseKeyword` / `keywordLine` (`compiler/card.ts`) so `[quality]cycling [cost]` (matching known cycling variants in `KEYWORD_REGISTRY` or any valid `ObjectFilter` parsed cleanly via existing `parseObjectPhrase` before `-cycling`) compiles into a structured `KeywordDef` with `costDefs` (via `parseCost`, supporting both mana costs like `{2}` and composite dash costs like `Cycling—Pay 2 life.` or `Cycling—Discard a card.`), optional `cyclingFilter?: ObjectFilter`, and `cyclingDesc?: string`. Anything unparseable before `cycling` or invalid cost falls back honestly to `unsupported('keyword_not_implemented', ...)`.
   - In `getCardActivatedAbilities` (`ruleTree.ts`), build the `EffectiveActivatedAbility` from `KEYWORD_REGISTRY` (`activationZones: ['hand']`, `timing: 'instant'`, `cost: [...costDefs, { k: 'discard', count: { k: 'const', n: 1 }, filter: 'self' }]`, effect: `[draw 1]` for Cycling or `[search(cyclingFilter, count: 1, destinations: [{ zone: 'hand' }], upTo: true, statedQuality: true)]` (`CR 702.29e`) for Typecycling). `Run.search` already handles `statedQuality` + `upTo` + reveal/shuffle cleanly; ensure `typecycling` search reveals the found card (`CR 702.29e`) cleanly in the log/notification and shuffles even on fail-to-find.

4. **Cycling events & triggers (`CR 702.29c–d`, `compiler/triggers.ts`, `runtime/triggers.ts`, `runtime/events.ts`, `ir.ts`).**
   - *Decision point for user:* include cycling triggers in the same work or limit Slice 1 to Cycling/Typecycling abilities and do triggers in Slice 2 (`CR 702.29c–d`: `"When you cycle ~"` on 50+ cards like *Deem Worthy*, *Astral Slide*, *Shark Typhoon*, *Decree of Silence*, plus `"Whenever a player cycles or discards a card"` -> triggers once `CR 702.29d`).
   - Recommended design for clean single-pass triggers:
     - Emit a `CardDiscardedEvent` (`kind: 'CardDiscarded'`, carrying `playerId`, `objectId`, `object`, `reason: 'discard' | 'cycle'`, `destZone`) when discarding via `executeCostPaymentParts` (`'discard'`) or `Run.discard` (and mark `reason: 'cycle'` specifically when discarding to pay a cycling/typecycling ability's discard-self cost, which satisfies `CR 702.29f` automatically).
     - Compile `"When you cycle ~"` into `{ event: 'cycle', filter: { object: 'self', player: { relation: 'you' } }, fromAnyZone: true }` (`CR 702.29c`: triggers from whatever zone the card winds up in after it's cycled — graveyard, or exile if replaced) and `"Whenever [player] cycles a card"` / `"Whenever [player] cycles or discards a card"` cleanly on `'cycle'` / `'discard'` events (`CR 702.29d`: `"cycles or discards"` compiles to one `{ event: 'discard', includeCycle: true }` trigger matching both `reason: 'discard'` and `reason: 'cycle'` once per event!).

5. **Keyword-agnostic UI (`ArenaTable.svelte`) & Bot AI (`ai.ts`).**
   - Zero `'cycling'` / `'typecycling'` literals in `ArenaTable.svelte` or `ai.ts`.
   - `ArenaTable.svelte`:
     - In `isCardPlayableNow(inst, 'hand')` (and `playableHandCount` / hand card highlight), treat a hand card as playable/actable whenever `getCardActivatedAbilities(inst.card)` (or a helper `getZoneActivatedAbilities(state, actor, inst, 'hand')` from `engine.ts` / `ruleTree.ts`) has any legal hand-zone ability (`ab.activationZones?.includes('hand') && checkAbilityActivationLegality(gameState, me.playerId, inst, ab).ok`).
     - In `handleCardClickInHandOrCommand(inst, 'hand')`, gather both `CastOption[]` (`getCastOptions`) and legal `EffectiveActivatedAbility[]` for `'hand'`. If only one hand ability and no cast/suspend options exist (or when multiple options exist, e.g. both normal cast and Cycling!), render them in `castOptionsModal` alongside cast options (e.g. a generic `"Activated Abilities"` button list showing `ab.label` / `ab.costText` that dispatches `activate_ability` or enters target selection), so players can always choose either to cast *Cast Out* / *Savai Triome* or activate its hand ability without bespoke card/keyword branching!
   - `ai.ts`:
     - Extend `hasAnyLegalInstantResponseInner` and `executeBotStep` to consider legal `'hand'` activated abilities conservatively: e.g. bots activate instant-speed hand card-draw / search abilities during an opponent's end step when holding unused mana (or when mana-flooded / mana-screwed before missing a land drop), without spending mana needed for castable spells on their own main phase — preserving existing `golden.json` bot games.

#### Implementation slices

- **Slice 1 (Hand-zone `ActivatedAbility`, discard-self cost, Cycling & Typecycling abilities, UI/AI):** Added `activationZones` & `costKeyword`, `discard { filter: 'self' }`, generalized `effectiveAbilityManaCost`, `KEYWORD_REGISTRY` + `[quality]cycling` parsing (`compiler/card.ts`, `buildCyclingAbility` in `keywords.ts`, `ruleTree.ts`), `engine.ts` hand-zone activation + LKI, and generic hand-ability support in `ArenaTable.svelte` & `ai.ts`.
- **Slice 2 (Cycling triggers `CR 702.29c–d`, `COMPILER_VERSION = 17`, `COVERAGE.md`, live browser check):** Added `CardDiscardedEvent` (`reason: 'cycle' | 'discard'`, preserved across `PendingZoneMove`), compiled `"When you cycle ~"` (`fromZone: 'any'`, `CR 702.29c`), `"cycles a [quality] card"` (`CR 702.29f`), and `"cycles or discards"` (`CR 702.29d`, single event match), verified in live `vite dev` Chromium UI (*Astral Blessing*), updated `ir.json`, and regenerated `COVERAGE.md`. *(Cleanup-step `discard_to_hand_size` in `engine.ts` does not yet emit `CardDiscarded`.)*

---

## 3. Phases

Each phase lists: **owns** (files only this phase's agent edits; others treat them as read-only
while it runs), **entry**, **work**, **exit**, and **ratchet target**.

### Phases 0–10 and Steps A–F ✅ done 2026-11-09

The work lists and completion notes for Phases 0–10 (including Steps A–F, the review-fix rounds and the
Tier 1–3 rules tracks) moved to
[`deprecated/ENGINE_PHASES_0-10_LOG.md`](./deprecated/ENGINE_PHASES_0-10_LOG.md). Code comments that cite
a phase or step ("Phase 6d", "Step E2") refer to that file.

### Phase 11+: The coverage loop (ongoing)
Repeat:
1. Run the coverage script.
2. Take the top unparsed template clusters, prioritising cards in saved decks.
3. Add the grammar production and, if needed, a new verb, cost, static or keyword.
4. Add an IR snapshot test plus one behaviour test using a **synthetic card with an invented
   name**.
5. Commit, then rerun.

Track "% of saved-deck cards fully supported" as the headline metric.

**Beyond the coverage loop:** the loop adds grammar and verbs one template at a time. The structural
changes that full keyword and rules coverage would need first (cast options in place of `castMode`,
pausable resolution, a keyword registry, multi-face and face-down objects) are proposed in
[`FULL_COVERAGE_STRUCTURE.md`](./FULL_COVERAGE_STRUCTURE.md) (2026-11-12, not scheduled).

**Long-tail escape hatch (not built):** some cards are true one-offs. For those, the plan is a
**hand-authored `CardDefinition` JSON override** in `src/lib/magic/overrides/<oracleId>.json`. Neither the
directory nor override loading in `compileCard` exists yet. That is still data,
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
- **Coverage report** checked into CI as a number that must not decrease (another ratchet). *Not built:* the bulk data isn't in the repo, so CI doesn't run `scripts/magic-coverage.ts`. Only precon automation is ratcheted, by `compiler/automation.test.ts` against `compiler/automation.baseline.json`.
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
