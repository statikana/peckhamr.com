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

### 2.14 Object model for multi-faced and face-down cards (`CR 707–712, 708, 716`)

*Status: design doc only (Track B4, written before implementation; no code changes in this package).*

Today the engine assumes one active face (`compileCard(card).faces[0]`) almost everywhere: [`normalizeScryfallCard`](file:///home/ryan/Documents/github/statikana/peckhamr.com/src/lib/magic/scryfall.ts) drops Scryfall `layout` and concatenates multi-face oracle texts with `"\n//\n"`, [`compileFaces`](file:///home/ryan/Documents/github/statikana/peckhamr.com/src/lib/magic/compiler/card.ts) flags any card with `backFace` or `"\n//\n"` as `unsupported('multiface')` (`895` cards in [`COVERAGE.md`](./COVERAGE.md)), ~40 runtime/compiler sites index `.faces[0]` directly, [`CardInstance`](file:///home/ryan/Documents/github/statikana/peckhamr.com/src/lib/magic/types.ts) only carries `transformed: boolean` (unused at runtime) and `isFaceDown?: boolean`, and [`sanitizeGameStateForViewer`](file:///home/ryan/Documents/github/statikana/peckhamr.com/src/lib/magic/engine.ts) leaks hidden face-down card identities on the battlefield, stack, and exile.

The sections below answer the five design questions required before implementation.

#### 1. Representation in `ScryfallCard`, `CardInstance` / `StackItem`, and the IR

- **`ScryfallCard` (`types.ts`, `scryfall.ts`):**
  - Add `layout?: CardLayout` (`'normal' | 'split' | 'flip' | 'transform' | 'modal_dfc' | 'adventure' | 'meld' | 'reversible_card'`; omit defaults to `'normal'`) and `faces?: ScryfallCardFace[]` (each entry holding `{ name, manaCost, cmc?, typeLine, oracleText, colors, colorIndicator?, keywords?, power?, toughness?, loyalty?, defense?, imageUrl, artCropUrl? }`).
  - Preserve `backFace` only as a normalized backward-compatibility projection from `faces[1]` when `faces.length === 2` (and stop flattening `oracleText` into `"\n//\n"` once `faces[]` is populated; legacy stored decks without `faces` can be lazily upgraded in memory from `backFace` + `oracleText.split('\n//\n')` with inferred `layout`).
  - Keep `colorIdentity` and top-level combined `cmc` at card level (`CR 903.4d` checks all faces for Commander color identity; top-level `cmc` on split cards keeps printed combined MV `CR 709.4b`).

- **IR (`ir.ts`, `compiler/card.ts`, `compiler/index.ts`):**
  - [`CardDefinition`](file:///home/ryan/Documents/github/statikana/peckhamr.com/src/lib/magic/ir.ts) already has `faces: FaceDefinition[]`. Add `layout?: CardLayout` and optional `colorIndicator?: ManaColor[]` / `frontManaValue?: number` metadata on [`FaceDefinition`](file:///home/ryan/Documents/github/statikana/peckhamr.com/src/lib/magic/ir.ts) / `Characteristics`.
  - Remove the top-of-function `multiface` bailout in `compileFaces` and compile **each** entry of `card.faces` independently into `FaceDefinition` (using `face.colors` / `colorIndicator` so back faces with no mana cost retain their color indicator!). Note: `compiledTriggerEffect`, `compiledStackItemEffects`, `abilityById`, and `RuleTree` read from a specified `faceIndex` (default `0`, or combined halves for split cards outside the stack) instead of assuming `.faces[0]`.
  - Add optional `meldPartnerName?: string` / `meldResult?: ScryfallCardFace` only when Meld (`CR 713`) is later scheduled; Meld (`CR 713.1a`, two physical cards becoming one battlefield object) should be deferred behind TDFCs, MDFCs, Split cards, Adventures, and Face-down cards.

- **Plain-JSON runtime state (`types.ts` — `CardInstance` & `StackItem`):**
  - Replace the boolean-only view on `CardInstance` with plain JSON state:
    - `activeFaceIndex?: number` (`0` = front/left/creature face, `1` = back/right/adventure face; `0 | 1` synced with legacy `transformed = (activeFaceIndex === 1)` for DFCs so existing saves stay readable, and `flip` state represented cleanly as `activeFaceIndex: 1`!).
    - `unlockedFaces?: number[]` (only for Room split cards `CR 709.5`, tracking `'left half unlocked'` / `'right half unlocked'` designations).
    - `copiableState?: { card: ScryfallCard; faceIndex?: number; fused?: boolean; isSingleFaceCopy?: boolean; faceDownOverride?: FaceDownSpec }` (replacing ad-hoc `copiableCard` / `printedCard` overrides cleanly so copying a back face creates a single-faced object `CR 707.8` / `712.6d`).
    - `faceDownSpec?: FaceDownSpec` (`{ kind: 'morph' | 'megamorph' | 'disguise' | 'manifest' | 'cloak' | 'cyberman' | 'other'; turnUpCost?: string; wardCost?: string; supertypes?: string[]; types?: string[]; subtypes?: string[]; power?: number; toughness?: number; colors?: ManaColor[]; knownToPlayerIds?: string[] }`) alongside `isFaceDown?: boolean` and a stable opaque `faceDownLabel?: string` (e.g. `'Face-Down #3'`) for `CR 708.6` differentiation without exposing hidden identity.
    - `adventureExile?: { ownerId: string }` (or extending `PlayableFromExilePermission` with `castFaceIndex: 0` per `CR 716.3d`: "on an adventure").
  - On `StackItem`, add `faceIndex?: number` (the chosen half/face on the stack `CR 709.3b`, `712.8c`, `716.2`), `fused?: boolean` (`CR 709.4d`), and `isFaceDown?: boolean` + `faceDownSpec?: FaceDownSpec` (`CR 708.4`).

#### 2. Which Face's Characteristics Apply in Each Zone

Introduce one pure resolver helper `resolveObjectFaces(card, objState, zone): ActiveFaceView` (used across `layers.ts`, `ruleTree.ts`, `costs.ts`, `triggers.ts`, `objectFilter.ts`, and `engine.ts` to replace all direct `.faces[0]` indexing):

| Card Layout | Hand / Library / Graveyard / Exile / Command | Stack (`StackItem`) | Battlefield (`CardInstance`) |
|---|---|---|---|
| **`transform` (`CR 712.6a–d`)** | Front face (`0`) only (`712.6a`). | `faceIndex` (`0` default `712.8`, `1` if cast transformed/converted `712.8a`). If `faceIndex === 1`, mana value comes from **front** face `manaCost` (`712.6b`, `202.3b`), or `0` if copy of back face. | `activeFaceIndex` (`0` or `1`). When `1` and not a copy, MV = front face MV (`712.6d`). |
| **`modal_dfc` (`CR 712.6a,e`)** | Front face (`0`) only (`712.6a`) for characteristic queries (cast/play legality checks chosen face `712.8b`, `712.9`). | Chosen `faceIndex` (`0` or `1`), using that face's own MV/colors/characteristics (`712.6e`). | Chosen `activeFaceIndex` (`0` or `1`); cannot transform (`712.7`). |
| **`split` (`CR 709.3–5`)** | Combined characteristics (`709.4`): union of types/subtypes/colors/abilities, sum of MVs (`709.4b`), matches **either** name (`709.4a`). | Chosen half `faceIndex` (`0` or `1`) only (`709.3b`), OR both combined if `fused: true` (`709.4d`, `702.102`). | N/A for normal instants/sorceries; for Rooms (`709.5`), shared type line + unlocked door designations filter each half's static/triggered/activated abilities & name/MC. |
| **`adventure` (`CR 716.1–4`)** | Main creature/permanent face (`0`) only (`716.4`); Adventure characteristics (`1`) do not exist in non-stack zones. | `0` (normal) or `1` (Adventure `716.2`); when `1` resolves cleanly, goes to **exile** with `CR 716.3d` cast-`faceIndex: 0` permission for its controller (`spellMods.exileAdventureOnResolve`). | Main face (`0`). |
| **`flip` (`CR 710`)** | Normal face (`0`) only (`710.2`). | Normal face (`0`) only. | `activeFaceIndex` (`0` or `1` once flipped; flips are one-way `710.3`). |
| **Any face-down spell/perm (`CR 708.2–4`)** | Normal face characteristics (only spells on stack and permanents on battlefield have face-down copiable characteristics `708.2`; exiled face-down cards have no characteristics unless explicitly looked at). | Copiable values come solely from `faceDownSpec` (default 2/2 colorless nameless creature, MV `0`, no types other than Creature `708.4`). | Copiable values come solely from `faceDownSpec` until turned face up (`708.8`). |

#### 3. Preserving Object Identity on Transform / Flip / Turn Face Up (`CR 712.15`, `708.8`)

- **Transform / Convert (`CR 712.15`, `CR 701.27c`):**
  - Transforming mutates `inst.activeFaceIndex` (`0 ↔ 1`) and `inst.transformed` in place on the existing `CardInstance`.
  - It MUST **not** bump `objectVersion`, MUST **not** call `leaveBattlefieldReset`, MUST **not** clear `counters`, `damageMarked`, `summoningSick`, `attachedToId` / attached Auras & Equipment (unless type-changing unattaches in next SBA check), continuous effects, or targeting references (`StackItem.targetObjectVersions` stays valid!).
  - It **does** allocate a fresh ability/layer change (call `noteLayerInputsChanged(state)` and `enteredTimestamp` stays the same per `CR 613.7` — transforming does NOT give a permanent a new timestamp!). Emit a `TransformedEvent` if `"When this permanent transforms"` triggers are added, and guard `CR 712.12a` (face-down DFCs can't transform) and `CR 712.13` (DFCs on battlefield can't be turned face down).
  - For **Daybound/Nightbound (`CR 702.145`)** or `"Exile ~, then return it to the battlefield transformed"`: blinking to exile and returning *does* create a new object (`bumpVersion: true`, `newTimestamp: true`) entering with `activeFaceIndex: 1` per `CR 712.11a`.
- **Turning face up (`CR 708.7–8, 708.11`):**
  - Turning a face-down permanent face up sets `isFaceDown = false`, clears `faceDownSpec`, restores normal copiable values (`CR 708.8` — preserving `copiableState` if it entered as a face-up/down Clone `CR 708.10`!), keeps `objectVersion`, counters, damage, and continuous effects, applies `"As [this] is turned face up"` before checking SBAs/triggers (`CR 708.11`), and calls `noteLayerInputsChanged(state)` + emits `TurnedFaceUpEvent` (`"When ~ is turned face up"`). Notice turning a permanent face up is a **special action** (`CR 116.2b`, doesn't use the stack!) paid via `PendingCostPayment`.

#### 4. Casting & Land Plays via Track B2 `CastOption` (`CR 708.4, 709.3, 712.8–9, 716.3`)

- Extend [`CastOption`](file:///home/ryan/Documents/github/statikana/peckhamr.com/src/lib/magic/types.ts) (plus a symmetrical `LandPlayOption` / `play_land { faceIndex }` or `fromZone` selection) instead of adding mechanic-specific cast modes:
  - **Add `faceIndex?: number` (`0 | 1`) and `fused?: boolean` onto `CastOption` and `cast_spell` `GameActionPayload`** (default `0`).
  - **Candidate generation (`enumerateCandidateCastOptions`):**
    - `modal_dfc` (`CR 712.8b`): emit options for face `0` (if spell) and face `1` (if spell), checking **only** the chosen face's castability, mana cost, timing, and targets (`CR 712.8c`); for `play_land` (`CR 712.9`), let land plays choose any face with type `'Land'` (`faceIndex: 0 | 1`).
    - `split` (`CR 709.3`): emit `face:0` (`option.id = 'face:0'`) and `face:1` (`option.id = 'face:1'`), plus `'fused'` (`CR 702.102`) from `'hand'` (`CR 709.4d`).
    - `adventure` (`CR 716.3`): emit `'face:0'` (creature/permanent) normally; from zones other than `adventureExile`, emit `'face:1'` (`spellMods.exileAdventureOnResolve = true` -> puts card into exile on resolution with owner-only permission restricted to `faceIndex: 0`!). When resolving the `face:1` Adventure spell cleanly (`CR 716.3d`), route `moveStackSpellToZone` to `'exile'` instead of `'graveyard'`; if countered/fizzled, it goes to graveyard as usual!
    - `transform` (`CR 712.8a,d`): normally only `face:0` (`CR 712.8`); Disturb/cast-transformed front-face abilities (`CR 712.8d`) emit an alternative cast option with `faceIndex: 1` (plus `exileOnLeaveStack` when Disturb applies).
    - **Face-down casts (`CR 708.4`, Morph/Disguise `{3}`):** emit `option.id = 'alt:morph'` / `'alt:disguise'` (`baseCost: { kind: 'alternative', manaCost: '{3}' }`, `spellMods: { castFaceDown: faceDownSpec }`) so cost reductions (e.g. Animar/Ugin) apply against `{3}` for a colorless creature spell (`CR 708.4`)!
  - **`validateChosenTargets`, `effectiveSpellManaCost`, and `finalizeCastSpell`** evaluate characteristics strictly from the chosen `CastOption.faceIndex` (or `faceDownSpec` when `castFaceDown` is set). No code in `ArenaTable.svelte` or `ai.ts` needs `'split'`, `'adventure'`, `'morph'`, or `'mdfc'` string branches: `castOptionsModal` already renders all `CastOption`s returned by `getCastOptions`!

#### 5. Layer Engine (`CR 613.1a, 707.2–3, 708.2`) & Client / Viewer Redaction (`CR 708.5, 712.4`)

- **Layers (`runtime/layers.ts`):**
  - Split current Layer 1 step ([`runtime/layers.ts`](file:///home/ryan/Documents/github/statikana/peckhamr.com/src/lib/magic/runtime/layers.ts#L1320-L1427)) cleanly into:
    - **Layer 1a (`CR 613.2a`):** Start from printed card `activeFaceIndex`, then apply copy effects (`perm.copiableState`, setting copiable card/face and `"except ..."` modifications). Copy effects copy the **face that's currently up** on a TDFC/MDFC/Room (`CR 707.2`, `712.6d`), whereas a Clone of a face-down permanent copies `{ 2/2 Creature }` (not the hidden front card!) and a permanent turned face-down after copying keeps the copy values underneath (`CR 708.10`).
    - **Layer 1b (`CR 613.2b`, `CR 708.2`):** If `inst.isFaceDown`, replace Layer 1a's copiable values with `inst.faceDownSpec` (default `2/2`, Creature, colorless, nameless, MV `0`, Ward `{2}` if Disguise, Artifact Creature if Cyberman, etc.), suppressing innate abilities/statics/CDAs of the hidden face.
  - **Layer cache (`runtime/layerCache.ts`):** Fingerprint `inst.activeFaceIndex` / `inst.unlockedFaces` / `inst.faceDownSpec` / `inst.copiableState` alongside `inst.isFaceDown` and `inst.copiableCard` so transforming, flipping, unlocking a Room, or turning face up deterministically invalidates the board snapshot.
  - **Other `.faces[0]` consumers:** Replace direct `.faces[0]` access across [`ruleTree.ts`](file:///home/ryan/Documents/github/statikana/peckhamr.com/src/lib/magic/ruleTree.ts), [`runtime/triggers.ts`](file:///home/ryan/Documents/github/statikana/peckhamr.com/src/lib/magic/runtime/triggers.ts), [`runtime/effects.ts`](file:///home/ryan/Documents/github/statikana/peckhamr.com/src/lib/magic/runtime/effects.ts), [`runtime/replace.ts`](file:///home/ryan/Documents/github/statikana/peckhamr.com/src/lib/magic/runtime/replace.ts), [`runtime/kicker.ts`](file:///home/ryan/Documents/github/statikana/peckhamr.com/src/lib/magic/runtime/kicker.ts), and [`engine.ts`](file:///home/ryan/Documents/github/statikana/peckhamr.com/src/lib/magic/engine.ts) with zone-aware helpers `activeFaceDefs(card, instOrItem, zone)`.

- **Viewer Redaction (`engine.ts` `sanitizeGameStateForViewer`) & Client UI (`ArenaTable.svelte`):**
  - **Fix `CR 708.5` hidden-information leak:** Today [`sanitizeGameStateForViewer`](file:///home/ryan/Documents/github/statikana/peckhamr.com/src/lib/magic/engine.ts#L11775-L11867) only filters `pendingZoneMoves` for `c.isFaceDown` and sends full battlefield/stack/exile `CardInstance.card` objects to opponents. Under `CR 708.5`:
    - When `viewerId !== perm.controllerId` (or `!faceDownSpec.knownToPlayerIds?.includes(viewerId)`), replace `c.card`, `c.printedCard`, `c.copiableCard`, and `c.copiableState` on any face-down battlefield permanent or face-down stack item with a scrubbed face-down `ScryfallCard` proxy (showing only `faceDownLabel` + `faceDownSpec` stats/Ward/types — **zero** real name, oracle text, mana cost, or art URL!).
    - For face-down exiled cards (Foretell, Hideaway, Bomat Courier, etc.), scrub `card` unless `viewerId` has explicit peek permission (`CR 406.3`).
    - When revealed on leaving battlefield/stack or game end (`CR 708.9`), clear `isFaceDown` before serialization or emit a reveal log entry so opponents see the revealed card cleanly.
  - **UI (`ArenaTable.svelte`):**
    - `CR 712.4`: when `viewer` may look at a double-faced/split/adventure card (in hand, command, graveyard, revealed exile, stack, or face-up battlefield), render a flip/face-inspect toggle in `inspectedCard` / card preview using `card.faces` / `card.backFace`, and display the active face art (`card.faces?.[inst.activeFaceIndex ?? 0]?.imageUrl ?? card.imageUrl`) on battlefield and stack permanents.
    - Face-down permanents render the `faceDownLabel` differentiation badge (`CR 708.6`) plus a controller-only "Peek / Turn Face Up" affordance when special-action `turn_face_up` costs are legal (`CR 708.5`, `708.7`).

#### Recommended Phasing (Deferred Implementation Spec)

1. **B4 Phase 1 (Representation & Viewer Redaction):** Populate `ScryfallCard.faces` + `layout` cleanly, replace raw `.faces[0]` calls with `resolveObjectFaces` / `activeFaceDefs`, separate Layer 1a/1b cleanly, and close the `CR 708.5` leak in `sanitizeGameStateForViewer`.
2. **B4 Phase 2 (`split`, `modal_dfc`, `adventure` casting & resolution):** Wire `CastOption.faceIndex` + Adventure exile loop (`CR 716.3d`) + Room designations (`CR 709.5`) + UI flip/preview toggle.
3. **B4 Phase 3 (`transform` + face-down Morph/Disguise/Manifest/Cloak):** Implement `TransformedEvent`, non-identity-changing transform (`CR 712.15`), special-action `turn_face_up` (`CR 708.7–11`), and `CR 708.9` reveal rules. *(Meld `CR 713` remains an optional Phase 4 follow-up.)*

---

### 2.15 High-Frequency Mechanics, Unified Optional Costs, Modal Abilities, & Vehicles (Track D)

**Motivation (`COVERAGE.md` @ `COMPILER_VERSION = 22`):** Five clusters dominate the remaining top unparsed / missing-action gaps across `35,062` Scryfall cards:
- **`"you may pay {COST}"` (#1: 298 cards) & `"unless <player> pays {COST}"` (#13: 70 cards, #37: 48 cards)** — `697` Scryfall cards (`525` unparsed) + `97/97` `"Counter target spell unless its controller pays {COST}"`.
- **`Crew N` (#2: 195 cards, 196/196 unparsed, `CR 702.122`)** — missing `state.timedContinuousEffects` Layer 4 animation and variable-cardinality subset-sum tap costs.
- **`Regenerate` (#3: 162 cards, 273/274 unparsed, `CR 701.19` / `614.8`)** — currently ignored in `NEUTRAL_SENTENCES`.
- **`"choose N —"` (#4: 156 cards, 612 unparsed modal cards, `CR 700.2`)** — triggered modals (`225`), activated modals (`31`), multi-target modes, `"choose the same mode more than once"`, and `"that hasn't been chosen this turn"`.
- **`"Draw a card, then discard a card."` (#8: 88, #53: 39, #86: 31 — `151/207` unparsed), `Goad` (`91`, `CR 701.15`), `Explore` (`60`, `CR 701.44`), `Map` (`CR 111.10s`), and `Connive` (`51`, `CR 701.50`)** — blocked on `CLAUSE_START` / `LOWER_START` missing `discard`, turn-based `untilYourNextTurn` cleanup, and `explore`/`connive` verbs.

#### Core Design Decisions

1. **Unified Clause Splitting & Turn-Based Expiration (`Slice 1`):**
   - Add `discard|discards|connive|connives|explore|explores|goad|goads|regenerate|regenerates` to both `CLAUSE_START` and `LOWER_START` (`compiler/effects.ts`), and generalize `NUMBER_WORDS` in `playerPredicate`.
   - Replace ad-hoc player-only cleanup with `expirePlayerUntilNextTurnEffects(state, playerId)` invoked both at `runBeginningOfTurn` (active player) AND for each skipped `lost` player in `completeTurnCleanupAndPassTurn` (`CR 800.4m`), expiring `perm.goadedByPlayerIds` (`CR 701.15a`, deduplicated per `CR 701.15d`) and player `untilYourNextTurn` flags accurately.
   - Share library reveal + interactive graveyard/draw/discard continuations across `explore` (`CR 701.44a–d`, empty library still completes `Explored`), `map` token (`CR 111.10s`, added to `PREDEFINED_TOKEN_DEFS`), and `connive` (`CR 701.50a–f`, `connive 0` is a no-op; multi-object connive/explore execute in APNAP order via `runIndexedBatch`; nonland discarded cards add `+1/+1` counters).

2. **Destruction Replacement Shields (`Regenerate`, `CR 701.19` / `CR 614.8`, `Slice 2a`):**
   - Store transient `regenerationShields?: number` and `cantBeRegeneratedThisTurn?: boolean` on `CardInstance` (`types.ts`), cleared in `clearEndOfTurnAndDamage` (`CR 514.2`) and reset on zone change (`runtime/zones.ts`).
   - Stop dropping `"It can't be regenerated."` / `"They can't be regenerated."` in `NEUTRAL_SENTENCES`; propagate `params.cantBeRegenerated = true` onto `destroy` steps and `cantBeRegeneratedThisTurn` where applicable.
   - Single helper `tryRegenerateInsteadOfDestroy(state, perm, canBeRegenerated)` intercepts BOTH effect destruction (`destroyPermanentByEffect` / `Run.destroy`) AND combat/SBA lethal damage / deathtouch destruction (`CR 704.5g–h`), NOT zero-toughness (`CR 704.5f`) or sacrifice/legend-rule (`CR 704.5j`): consumes 1 shield, removes all `damageMarked` and `deathtouchDamageMarked`, calls `tapPermanent`, and removes `perm` from combat (`CR 701.19a`).

3. **Unified `OptionalSpec` + `CostDef[]` Payment (`"you may pay {COST}"` & `"unless <player> pays {COST}"`, `Slice 2b`):**
   - Extend `OptionalSpec` (`ir.ts`) to `{ chooser: PlayerRef; cost?: CostDef[]; mode?: 'doIfPaid' | 'doUnlessPaid' }` and add `ifPrecedingDeclined?: number` alongside `ifPrecedingAccepted?: number` on `EffectStep` (shifted cleanly in `shiftStepTargets`).
   - Add `{ k: 'controllerOf'; of: ObjectRef }` to `PlayerRef` if absent so `"Counter target spell unless its controller pays {2}"` targets `{ k: 'target', index: 0 }` and prompts that spell's controller uniformly.
   - `Run.resolveOptional` delegates affordability & payment cleanly to `EffectPorts` using `{ isSpell: false }` `ManaSpendContext` (Powerstone/restricted mana CAN pay optional/tax costs), auto-declining when unaffordable, choosing sensibly for bots, and pausing humans with a `yesNo` / cost prompt; sets `stepDecisions[stepIndex] = paid` and executes the step iff `(mode === 'doUnlessPaid') ? !paid : paid`.
   - Scope guard: `"you may pay {COST} rather than ~'s mana cost"` (`CR 118.9`), `"As ~ enters, you may pay..."` (`CR 614.1c`), and targeted `"When you do, target..."` reflexive triggers remain cleanly marked unsupported until their own rules hooks exist rather than silently miscompiling targets.

4. **General Modal Abilities (`CR 700.2`, `Slice 3`):**
   - Share `modal?: ModalDef` across `SpellAbility`, `ActivatedAbility`, and `TriggeredAbility` (`ir.ts`), and extract one `expandModalEffects(modal, chosenModes)` builder in `compiler/index.ts`.
   - Extend `ModalDef` with `allowRepeat?: boolean` (`CR 700.2d`), `oncePerTurnUnique?: boolean`, `chooser?: 'controller' | 'opponent'` (`CR 700.2e`), and `upTo?: boolean`, and remove the artificial `mode.targets.length <= 1` limit while preserving linear target-slot shifting per chosen occurrence.
   - Support `CR 700.2b` triggered modal selection on stack entry (`trigger_modes` -> `trigger_targets` when legal modes exist, removing triggers with `< min` legal modes per `CR 603.3c`), activated modal mode selection (`activate_ability.chosenModes`), and UI/AI count pickers for repeatable modes (`CR 700.2d`).

5. **Layer 4/6/7b `TimedContinuousEffect` & Subset-Sum `Crew N` (`CR 702.122`, `Slice 4`):**
   - Add `state.timedContinuousEffects?: TimedContinuousEffect[]` (cleared at `clearEndOfTurnAndDamage`, evaluated in Layer 4/6/7b in `evaluatePermanent` in timestamp order `CR 613.7`), preserving existing types/subtypes/P/T when `addTypes: ['Artifact', 'Creature']` animates a Vehicle (`CR 205.1b, 702.122a`), and ensure `summoningSick` applies to non-creature permanents that entered this turn (`CR 302.6`).
   - Add subset-sum cost `{ k: 'tapSubsetSum'; minTotal: Amount; metric: 'power'; filter: ObjectFilter; excludeSelf?: boolean }` to `CostDef` (`ir.ts`) checked against evaluated Layer 7 power (`summoningSick` allowed per `CR 702.122a`, honoring `"can't crew Vehicles"` per `CR 702.122d`).
   - Register `'crew'` in `KEYWORD_REGISTRY` (`keywords.ts`), track `crewedByIds` / `BecomesCrewed` event on crew resolution (`CR 702.122c,e`), and support generic multi-object subset cost selection in `ArenaTable.svelte` and `ai.ts` with zero `'crew'` keyword literals.

---

### 2.16 High-Impact Coverage Mechanics: Dig, Devoid, Delayed Triggers, Linked Exile, Layer 2 Control, & Convoke/Delve (Track E)

**Motivation (`COVERAGE.md` @ `COMPILER_VERSION = 26`):** Six remaining high-frequency clusters dominate top unparsed templates and Commander gameplay gaps:
- **`"Put the rest on the bottom of your library in a random order."` (#1: `144` cards), `"Reveal the top N cards of your library."` (#33: `45`), and `"Put the rest on the bottom of your library in any order."` (#75: `32`)** — `dig` (`ir.ts`, `runtime/effects.ts`) already shuffles bottom-bound cards randomly when `restRandom: true`, but `compiler/effects.ts` only matches the exact single-sentence `"put up to one of them on top of your library and the rest..."` form rather than general 2–3 sentence look/reveal + filter-select + rest-to-bottom sequences.
- **`Devoid` (#2: `134` cards, `CR 702.114a`)** — Characteristic-defining ability that makes an object colorless in **all zones** (including outside the game) while leaving Commander color identity (`CR 903.4`) unaffected and ordered before non-CDA Layer 5 effects (`CR 613.3`).
- **`Convoke` (#3: `105` cards, `CR 702.51`) & `Delve` (#92: `29` cards, `CR 702.66`)** — Post-determination alternative mana-payment aids (`CR 601.2h`) applied after cost increases/reductions (`CR 601.2f`) and integrated into `CastOption`, `PendingCostPayment`, and keyword-blind UI/AI.
- **Generalized IR Delayed Triggers (`CR 603.7`) & Linked Exile (`CR 607.2a`, `610.3`)** — *"Sacrifice it at the beginning of the next end step"* (#36: `43` cards) and *Oblivion Ring / Banisher Priest* `"Exile target ... until ~ leaves the battlefield"` (`CR 610.3`). Today `DelayedTrigger` (`types.ts`) handles only `{ kind: 'exile' | 'lose' | 'draw' }` and cannot execute arbitrary IR `EffectStep[]`.
- **Layer 2 Continuous Control Changes (`CR 613.1b`, `613.7`, `302.6`)** — *"Gain control of target creature until end of turn"* (#61: `34` cards) and *"You control enchanted creature"* (#94: `28` cards). Currently Layer 2 is absent from `runtime/layers.ts` and `transferBattlefieldControl` mutates `controllerId` destructively without timestamp stacking or expiration restoration.

#### Core Design Decisions

1. **Generalized Top-N `Dig` (`Slice 1a`):**
   - Extend `EffectParams['dig']` (`ir.ts`) with optional `keepFilter?: ObjectFilter`, `keepLabel?: string`, `keepTo: 'libraryTop' | 'hand' | 'battlefield' | 'graveyard'`, `keepTapped?: boolean`, `revealAll?: boolean`, `revealKept?: boolean`, `rest: 'libraryBottom' | 'graveyard'`, and `restRandom?: boolean` (`restOrder: 'any' | 'random'`, preserving `restRandom` compatibility).
   - **Multi-sentence combining (`compiler/effects.ts`):** When a prior `dig` step (`"Look at the top N cards of your library."` / `"Reveal the top N cards of your library."`) is followed by:
     - a keep clause (`"You may reveal [a/an/up to N] [filter] from among them and put it/them into your hand."`, `"Put [up to] N [filter] card(s) from among them onto the battlefield [tapped] / into your hand / on top of your library..."`, `"Put one of them into your hand."`); and/or
     - a rest clause (`"(Then )?Put the rest on the bottom of your library in a random order."` / `"...in any order."` / `"...into your graveyard."`),
     combine them cleanly onto the active `dig` step! When the keep clause is absent and only `"Put the rest on the bottom..."` follows `"Look at the top N..."`, fail cleanly rather than dropping cards; conversely support `"Reveal the top N cards... Put all [filter] cards revealed this way into your hand and the rest on the bottom in any/random order"` when `keepAllMatching` is explicit.
   - **Runtime (`runtime/effects.ts` `Run.dig`, `engine.ts`):** When `revealAll`, log the revealed top `N` cards; filter selectable kept candidates by `keepFilter` via `matchesObjectFilter`; prompt humans cleanly with `chooseObjects` restricted to matching candidates (`min`/`max`, `zone: 'library'`); move `kept` cleanly through `moveFromZone` (handling battlefield ETB triggers or `keepTapped`, hand reveals `revealKept`, or `rearrangeLibrary`); put `rest` on bottom randomly (`nextRandom` Fisher-Yates when `restRandom`, already seeded on `state.rngState`) or in order (`orderObjects` prompt for human when `!restRandom && rest.length > 1 && restOrder === 'any'`). Pause cleanly via `effectResume` if `moveFromZone` hits a replacement prompt (`PendingZoneMove`).

2. **All-Zone `Devoid` (`CR 702.114a`, `CR 604.3`, `CR 613.3`, `Slice 1b`):**
   - Register `'devoid'` in `KEYWORD_REGISTRY` (`keywords.ts`, `CR: '702.114'`, `parameterKind: 'none'`, `grantable: false`, `status: 'implemented'`, `implementation: { kind: 'static', buildStatics: () => [{ k: 'continuous', layer: '5', affected: 'self', mod: { k: 'setColors', colors: [] } }] }`).
   - **CDA Ordering (`CR 613.3`):** On the battlefield (`runtime/layers.ts`), apply `Devoid` / CDA `layer: '5'` effects BEFORE non-CDA Layer 5 effects (and note: if the permanent loses all abilities in Layer 6, `CR 613.6` preserves Layer 5 colorlessness because Layer 5 applies before Layer 6!).
   - **All-Zone Evaluation (`CR 702.114a`, `604.3`):** Update `runtime/faces.ts` (`resolveObjectFaces` / helper `effectiveObjectColors`) and `runtime/layers.ts` (`buildOffBattlefieldBreakdown`) + `runtime/objectFilter.ts` (`matchesObjectFilter` color checks) so any card/stack/off-battlefield object with `'devoid'` evaluates its `colors` as `[]` in every zone (`hand`, `library`, `graveyard`, `exile`, `command`, `stack`), while leaving `card.color_identity` / `cardIdentityColors` untouched per `CR 202.2d, 903.4`!

3. **IR-Safe Delayed Triggers (`CR 603.7`) & Linked Exile (`CR 607.2a`, `CR 610.3`, `Slice 2`):**
   - **No IR in `GameState` (`ir.ts:5` invariant):** Never serialize `EffectStep[]` into `GameState`. Instead:
     - Store `{ kind: 'compiledDelayed'; sourceCard: ScryfallCard; faceIndex?: number; fused?: boolean; abilityKey: string; stepIndex: number; boundRefs?: Record<string, Array<{ id: string; objectVersion?: number; zone?: ZoneType }>> }` on `DelayedTrigger.delayedEffect` and `StackItem` (resolving the `EffectStep[]` dynamically via `compileCard(sourceCard)` + `abilityKey` + `stepIndex` on stack resolution, preserving exact compatibility with legacy `{ kind: 'exile' | 'lose' | 'draw' }`).
     - Extend `compiler/effects.ts` (`delayedTrigger(when)`) cleanly to handle standard trailing/leading delayed triggers (`the next end step`, `that turn's end step`, `the next turn's upkeep`, `the end of combat`) and pass compiled steps like `sacrifice`, `exile`, `destroy`, `bounce`, `draw`, `lose`, `damage`, etc., binding pronouns (`"it"` -> `boundRefs`).
     - In `engine.ts` (`resolveStackItemNow`) & `runtime/effects.ts` (`Run.delayed`): resolve `compiledDelayed` items by rehydrating `bindings` (`CR 603.7c`: if a bound object changed zones since creation or `objectVersion` differs from `expectedZone`, drop that ref cleanly so blinked objects are unaffected!) and executing the child `EffectStep[]` through the normal pausable `Run` loop.
     - Note `CR 603.7b`: one-shot `DelayedTrigger` removes itself once triggered (`state.delayedTriggers = remainingDelayed`), firing via `flushTriggers` / APNAP order cleanly.
   - **Linked Exile (`CR 610.3a–c` & `CR 607.2a`):**
     - Add optional fields on `CardInstance` (`types.ts`):
       - `exiledBy?: { sourceInstanceId: string; sourceObjectVersion: number; exileBatchId?: string }` (stamped on exiled card by `Run.exile` when exiled by a source object, cleared on leaving exile per `CR 400.7`).
       - `untilSourceLeavesReturn?: { sourceInstanceId: string; sourceObjectVersion: number; returnZone: ZoneType; returnControllerMode?: 'owner' | 'sourceController'; tapped?: boolean }` (stored on the exiled `CardInstance`, and cleared on leaving exile).
     - **Compiler (`ir.ts`, `compiler/effects.ts`, `compiler/filters.ts`, `compiler/interpretable.ts`):**
       - Support `"Exile target ... until ~ leaves the battlefield"` (`exile.untilSourceLeaves = { returnZone: 'battlefield', returnController: 'owner' }`, plus `tapped` if specified).
       - Support `"cards exiled with ~"` (`{ k: 'exiledWithSelf' }` filter predicate in `ObjectFilter`, matching `c.zone === 'exile' && c.exiledBy?.sourceInstanceId === source.instanceId && c.exiledBy?.sourceObjectVersion === (source.objectVersion ?? 1)`).
     - **Runtime (`runtime/effects.ts`, `runtime/zones.ts`, `engine.ts`):**
       - Enforce **`CR 610.3a–b`:** Before exiling with `untilSourceLeaves`, verify the source object is still on the battlefield with the exact `sourceObjectVersion` (`findPermanentOnBoard`); if it already left before resolution, the object is **not** exiled.
       - Enforce **`CR 610.3` / `610.3c`:** When a permanent leaves the battlefield (`moveObject` from `'battlefield'` in `runtime/zones.ts`, or a post-move hook invoked by `moveFromBattlefield` / `removePermanent`), find all cards across all players' `exile` zones whose `untilSourceLeavesReturn` matches `(leaving.instanceId, leavingVersion)` and move them back as an immediate one-shot effect (NOT a trigger!) to `returnZone` under `ownerId` (`CR 610.3c`, clearing `untilSourceLeavesReturn` and queuing cleanly if multiple return simultaneously per `CR 610.3d`).

4. **Layer 2 Continuous Control Changes (`CR 613.1b`, `CR 613.7`, `CR 302.6`, `Slice 3`):**
   - **Data Model (`ir.ts`, `types.ts`):**
     - Add `{ k: 'setController'; controller: PlayerRef }` to `LayerMod` (`ir.ts`, with `layer: '2'`), and `{ verb: 'gainControl'; params: { duration: 'endOfTurn' | 'permanent' | 'untilSourceLeaves'; untap?: boolean; addKeywords?: string[] } }`.
     - Add optional `layer2?: { controllerId: string; untilSourceLeaves?: { sourceInstanceId: string; sourceObjectVersion: number } }` to `TimedContinuousEffect` (`types.ts`, with `expires: 'endOfTurn' | 'never' | 'untilSourceLeaves'`).
   - **Evaluation Order (`runtime/layers.ts`, `runtime/layerCache.ts`):**
     - Each `PermWorkState` starts from `baseControllerId = inst.defaultControllerId ?? inst.controllerId` (set cleanly on battlefield entry `runtime/zones.ts`).
     - **Pass 0 (Layer 2, BEFORE Layer 4/5/6/7!):** Collect all active Layer 2 static modifiers (`"You control enchanted creature"` on attached Auras — respecting `strippedByAttachment`!) and `state.timedContinuousEffects` entries with `layer2` (pruning expired `untilSourceLeaves` entries when source left battlefield), sort strictly by `timestamp` (`CR 613.7`), and compute `work.effectiveControllerId` (which updates Layer 4/5/6/7 `"you control"` checks immediately!). Include `effectiveControllerId`, Layer 2 statics, and `eff.layer2` fields in `layerCache.ts` dynamic fingerprinting!
     - **Controller Array Sync (`syncBattlefieldControllers` in `runtime/zones.ts` / `engine.ts`):** After any spell/ability resolves, phase transitions (`clearEndOfTurnAndDamage` expires `endOfTurn` Layer 2 effects), or zone changes (Aura removed -> Layer 2 drops!), call `syncBattlefieldControllers(state)`: for any permanent whose `evaluated.controllerId !== perm.controllerId`, move it between `player.battlefield` arrays, set `perm.controllerId`, mark `perm.summoningSick = true` (`CR 302.6`, skipped only if the permanent gains Haste), and call `removeFromCombat(state, perm.instanceId)` (`CR 506.4`!). Notice `defaultControllerId` stays untouched so when temporary/Aura Layer 2 effects end, control snaps cleanly back to the earlier Layer 2 effect or `defaultControllerId`!
   - **Compiler (`compiler/statics.ts`, `compiler/effects.ts`):**
     - Compile `"You control enchanted creature/permanent/artifact/land."` (`CR 303.4` + Layer 2 static `'attachedTo'`, `layer: '2'`, `{ k: 'setController', controller: { k: 'you' } }`).
     - Compile `"Gain control of target creature [until end of turn]. [Untap that creature. It gains haste until end of turn.]"` (creating `TimedContinuousEffect` with `layer2.controllerId` + optional `untap` + Layer 6 `haste`, `duration: 'endOfTurn' | 'never'`).

5. **Keyword-Blind Spell Payment Aids: `Convoke` (`CR 702.51`) & `Delve` (`CR 702.66`) (`Slice 4`):**
   - Register `'convoke'` (`CR 702.51`, `parameterKind: 'none'`, `implementation: { kind: 'static' }`) and `'delve'` (`CR 702.66`, `parameterKind: 'none'`, `implementation: { kind: 'static' }`) in `KEYWORD_REGISTRY` (`keywords.ts`), and ensure `compiler/card.ts` compiles spells with `Convoke` / `Delve` cleanly.
   - **Generic Engine Data Contract (`types.ts`, `runtime/costs.ts`, `engine.ts`):**
     - Export `CastCostAid`: `{ id: string; label: string; kind: 'tapPermanent' | 'exileCard'; candidateIds: string[]; colorsByCandidate?: Record<string, ManaColor[]>; paysGeneric: number; maxTotalReduction?: number }`.
     - Add optional `paymentAids?: CastCostAid[]` on `CastOption`, and add `costAidIds?: Record<string, string[]>` + optional `costAidColorChoices?: Record<string, ManaColor>` on `cast_spell` `GameActionPayload` (`types.ts`).
     - **Payment & Validation (`CR 601.2f–h`, `CR 118.10`):** Determine total mana requirement `costReq` FIRST (`CR 601.2f` — after Affinity, Commander Tax, Thalia, Kicker, etc.). Validate `costAidIds` (no duplicates, legal candidates — untapped creature you control for `tapPermanent`; card in your graveyard other than `inst` for `exileCard`, capped by remaining colored/generic requirements, and reserved against `canPayManaAfterTaps` / `planCosts` so a creature cannot pay both Convoke and `{T}` mana `CR 118.10`). Execute aid payments cleanly inside `PendingCostPayment` (`tapPermanent` firing `BecomesTapped` triggers per `CR 702.51c`; `moveFromZone(..., 'graveyard', 'exile')` handling graveyard replacement pauses cleanly).
   - **Keyword-Blind UI (`ArenaTable.svelte`) & Bot AI (`ai.ts`):** Zero `'convoke'` or `'delve'` literals in `ArenaTable.svelte` or `ai.ts`. `ArenaTable.svelte` renders generic `"Optional Mana Payment"` toggles for `option.paymentAids` inside `castOptionsModal`; `ai.ts` uses `option.paymentAids` cleanly when remaining mana is short or excess graveyard fodder/non-mana untapped creatures exist.

6. **Snapshots, `COVERAGE.md`, Audit Docs, & Live App Verification:**
   - Bump `COMPILER_VERSION` cleanly starting `26` -> `27` in Slice 1, culminating in regenerated `compiler/__snapshots__/ir.json`, `COVERAGE.md`, updated `rules-audit/` rows, and live Chromium `/magic` check.

---

### 2.17 Land Animation, Copy Retargeting & Storm, Graveyard/Hand Abilities & Cast Keywords, Coercive Discard & Count Triggers, and Precon Closers (Track F)

**Motivation (`COVERAGE.md` @ `COMPILER_VERSION = 30`):** After Track E (`9,921 / 35,062 = 28.3%` cards, `127 / 140 = 90.7%` precons), the top remaining unparsed templates and 8 of the 13 remaining unsupported precon cards cluster around five clean, general rules primitives:
- **`"It's still a land."` (#1: `83` cards, `CR 205.1b`)** — Manlands (*Faerie Conclave*, *Hall of Storm Giants*, *Restless Vinestalk*) and land animators (*Llanowar Loamspeaker*, *Awaken the Ancient*). `TimedContinuousEffect` (`types.ts`, `runtime/layers.ts`) already supports `layer4`, `layer5`, `layer6`, and `layer7b`, while `animate` currently only emits `layer4.addTypes` for `Crew`.
- **`"You may choose new targets for the copy."` (#2: `82` cards, `CR 707.10`, `707.10b–c`, `707.10f`) & `Storm` (#37: `40` cards, `CR 702.40a–b`)** — `copySpell` (`runtime/effects.ts`) currently copies only targeted stack spells with fixed targets, lacks ability copying (`CR 707.10b`), lacks optional per-copy retargeting (`CR 707.10c`), and lacks LKI stack snapshots for cast-triggered self-copies (`Storm`, `"Whenever you cast ..., copy it"`).
- **Zone-Scoped Hand & Graveyard Activated Abilities (`"Discard ~"` #3: `79` cards / `Channel` #38: `39` cards, `"Return ~ from your graveyard to your hand."` #15: `56` cards, `Unearth {COST}` #14: `57` cards `CR 702.84a`) & Cast-Option Keywords (`Buyback` #63: `32` cards `CR 702.27a` + precon *Corpse Dance*, `Evoke` #77: `30` cards `CR 702.74a`, `Escape` #71: `31` cards `CR 702.138a–d`)** — All fit directly onto `ActivatedAbility.activationZones` and `CastOption` / `SpellModifications` with zero keyword literals in `ArenaTable.svelte` or `ai.ts`.
- **Coercive Hand Reveal & Chosen Discard (#6/#7/#81: `67+` cards, `CR 701.9, 701.20`) & Per-Turn Count / Cap / Batch Combat Triggers (#8: `67`, #24: `49`, #95: `27`, #96: `27`, `CR 603.2c, 603.2i`)** — *Thoughtseize* / *Duress* / *Gix's Caress*, `"Whenever you draw your second card each turn"`, `"Whenever you cast your second spell each turn"`, `"This ability triggers only once each turn"`, and `"Whenever one or more [filter] you control deal combat damage to a player"`.
- **General Primitives Closing 8 Precon Staples:** `Evolve` (`CR 702.100a–d`, *Fathom Mage*), trigger trailing `, where X is ...` (*Scourge of Valkas*), targeting non-mana spell taxes (*Terror of the Peaks*), off-battlefield/stack colorless rule modifiers (*Mycosynth Lattice*), conditional all-modes + target-player zone counts (*Jeska's Will*), multi-destination partitioned `dig` (*Expressive Iteration*), and extra combat/main phases (`CR 500.8`, *Hellkite Charger*).

#### Core Design Decisions

1. **Generalized Permanent Animation (`CR 205.1b`, `CR 613.1d–g`, `Slice 1a`):**
   - Extend `EffectParams` for `animate` (`ir.ts`) with optional `setPower?: Amount`, `setToughness?: Amount`, `setTypes?: string[]`, `addSubtypes?: string[]`, `setSubtypes?: string[]`, `setColors?: ManaColor[]`, `addColors?: ManaColor[]`, `addKeywords?: string[]`, `keepExistingTypes?: boolean` (`true` for `"It's still a land."` / `"in addition to its other types"`), and `duration?: 'endOfTurn' | 'permanent'`.
   - **Compiler (`compiler/effects.ts`, `compiler/statics.ts`, `compiler/interpretable.ts`):**
     - Combine `"([Until end of turn, ])?<subject> becomes a [P/T] [colors] [subtypes] creature [with <keywords>] [until end of turn][, where X is ...]."` + trailing `"It's still a land."` (or inline `"that's still a land"` / `"in addition to its other types"`) into one `animate` step with `addTypes: ['Creature']`, `addSubtypes`, `setColors` (when colors are stated without `"in addition"`), `addKeywords` (including parameterized keywords like `ward {3}` if supported or standard grantable keywords), and `setPower` / `setToughness` (`Amount`, evaluated at resolution per `CR 608.2h`!). When `"It's still a land"` / `"in addition to its other types"` is omitted (e.g. `"Target artifact becomes a 4/4 artifact creature"`), set `setTypes` / `setSubtypes` per `CR 205.1a–b`.
     - Compile Aura static `"Enchanted <land/subtype> is a N/N [colors] [subtypes] creature [with <keywords>]. It's still a land."` (*Awaken the Ancient*) into Layer 4 (`addTypes: ['Creature']`, `addSubtypes`), Layer 5 (`setColors`), Layer 6 (`grantKeyword`), and Layer 7b (`setPT`) continuous statics on `'attachedTo'`.
   - **Runtime (`runtime/effects.ts` `Run.animate`, `runtime/layers.ts`):** Evaluate `setPower` / `setToughness` `Amount`s at resolution, emit a `TimedContinuousEffect` (`expires: duration === 'permanent' ? 'never' : 'endOfTurn'`) populating `layer4`, `layer5`, `layer6`, and `layer7b`. Confirm `layerCache.ts` fingerprints all `TimedContinuousEffect` subfields (`layer4`, `layer5`, `layer6`, `layer7b`). Because `'Land'` and existing land subtypes/abilities are preserved (`CR 205.1b`), animated lands retain `{T}: Add ...` mana abilities while respecting `summoningSick` (`CR 302.6`) if they entered this turn without Haste!

2. **Spell & Ability Copying, Optional Retargeting (`CR 707.10`, `707.10b–c`, `707.10f`), & `Storm` (`CR 702.40a–b`, `Slice 1b`):**
   - **Stack Targeting & Copy IR (`ir.ts`, `types.ts`, `ruleTree.ts`, `engine.ts`):**
     - Extend `TargetSpec` stack filter (`stackKind?: 'spell' | 'ability' | 'activatedAbility' | 'triggeredAbility' | 'spellOrAbility'`, `permanentSpellOnly?: boolean`, `controller?: 'you' | 'opponent' | 'any'`) so `validateTargetLegality` can target spells AND non-mana activated/triggered abilities on `state.stack`.
     - Extend `copySpell` (or unify with `copyStackObject` / params on `copySpell` in `ir.ts`): `count?: Amount`, `mayChooseNewTargets?: boolean`, `exceptColors?: ManaColor[]`, `nonLegendary?: boolean`.
     - **Cast-Trigger Stack LKI (`CR 707.10`, `CR 608.2h`):** When `finalizeCastSpell` (`engine.ts`) or `finalizeActivateAbility` pushes `stackItem` onto `state.stack` and emits `SpellCast` / `AbilityActivated`, attach a plain-JSON snapshot of that `StackItem` (`triggerEventStackItem?: StackItem` on `PendingTrigger` / `SerializedPendingTrigger` / `StackItem`, sanitized cleanly if face-down). In `Run.copySpell`, when `step.subject` is `{ k: 'eventObject' }` or `{ k: 'self' }`, prefer the live `StackItem` on `state.stack` if still present, falling back to `ctx.item.triggerEventStackItem` LKI so countering the original Storm / cast-copied spell does **not** stop its copies from being created!
     - **`CR 707.10b` Ability vs Spell Identity:** If the copied `StackItem` is an ability (`orig.kind !== 'spell'`), preserve `orig.sourceInstanceId` and `orig.sourceObjectVersion` (`CR 707.10b`) and do **not** emit `SpellCopied`; if it is a spell (`orig.kind === 'spell'`), allocate a fresh `copyInstanceId`, mark `isCopy: true` (resolving permanent spell copies into tokens per `CR 707.10f`, already supported in `engine.ts:8890`), apply `exceptColors` / `nonLegendary` via `copiableState.except` if specified, and emit `SpellCopied`.
     - **`CR 707.10c` Pausable Retargeting:** When `mayChooseNewTargets` is true and the copy has ≥1 target slot (`targetSpecs` derived from `orig` + `orig.chosenModes`, keeping modes and X locked per `CR 707.10` & `CR 115.8`):
       - Use `runIndexedBatch` over `0 .. copyCount - 1` so multi-copy effects (`Storm`) pause cleanly per copy across JSON round-trips!
       - For a **human** controller, if at least one legal alternative target arrangement exists (or always when `orig.targets.length > 0`), prompt `yesNo` (`"Choose new targets for <Copy #k>?"`); if accepted, prompt target selection per slot via `chooseObjects` / choice candidates validated through `validateChosenTargets` (`CR 115.7d–e`), or keep `orig.targets` unchanged if declined (even if original targets are now illegal per `CR 707.10c`!).
       - For **bots**, keep helpful targets on self/allies and retarget harmful single-target spells/abilities away from eliminated/illegal/hexproof/own targets onto the highest-value legal opponent/permanent.
       - Push each finalized copy onto `state.stack` and emit `BecomesTargeted` for any permanent targets on that copy (`CR 702.21a` Ward, etc.).
   - **`Storm` (`CR 702.40a–b`, `keywords.ts`, `ir.ts`, `runtime/triggers.ts`):**
     - Add `{ k: 'otherSpellsCastThisTurn' }` (or snapshot `stormCount?: number` on `PendingTrigger` / `StackItem` when `'cast'` triggers, equal to `Math.max(0, (caster.spellsCastThisTurn ?? 1) - 1)` at the moment the spell was cast so spells cast *in response* to the Storm trigger do NOT inflate `stormCount`!).
     - Register `'storm'` in `KEYWORD_REGISTRY` (`CR: '702.40'`, `status: 'implemented'`, `parameterKind: 'none'`, `grantable: false`, `implementation: { kind: 'trigger', events: ['cast'], ... }`): each instance of Storm on a spell triggers separately when cast (`!isCopy`, `CR 702.40b`) and creates `stormCount` copies of that spell with `mayChooseNewTargets: true`.

3. **Zone-Scoped Hand/Graveyard Activated Abilities & Cast-Option Keywords (`Slice 2`):**
   - **Hand & Graveyard Activated Abilities (`compiler/costs.ts`, `compiler/card.ts`, `engine.ts`, `ArenaTable.svelte`, `ai.ts`):**
     - In `compiler/costs.ts`: support `"Discard ~"` -> `[{ k: 'discard', count: ONE, filter: 'self' }]`; support `"Exile N other [filter] cards from your graveyard"` -> `[{ k: 'exileFrom', zone: 'graveyard', count, filter: { ...filter, other: true } }]` (and in `runtime/costs.ts`, always exclude `ctx.source.instanceId` when `ctx.source` itself is in `'graveyard'` being cast or activated!).
     - In `compiler/card.ts`: strip `Channel —` ability word; set `activationZones: ['hand']` when an activated ability's cost has `{ k: 'discard', filter: 'self' }` (or `"Activate only if ~ is in your hand"`); set `activationZones: ['graveyard']` when an activated ability's cost has `{ k: 'exileFrom', zone: 'graveyard', filter: 'self' }`, when its effect returns/moves `self` from `'graveyard'` (`"Return ~ from your graveyard to your hand"` / `"...to the battlefield"`), or when restricted to `'graveyard'`.
     - Extend `findActivatedAbilityTarget` and `checkAbilityActivationLegalityInner` (`engine.ts`) to support `source.zone === 'graveyard'` (`actor.graveyard`, skipping battlefield-only ability-loss checks per `CR 113.6`).
     - Generalize `ArenaTable.svelte` (`getZoneActivatedAbilities(inst, 'hand' | 'graveyard')`, `zoneModal` graveyard buttons/badges, `handleCardClickInHandOrCommand` / `castOptionsModal`) and `ai.ts` to surface legal `'graveyard'` activated abilities with **zero** keyword string literals.
   - **`Unearth [cost]` (`CR 702.84a`):**
     - Register `'unearth'` in `KEYWORD_REGISTRY` (`CR: '702.84'`, `parameterKind: 'cost'`, `grantable: false`, `implementation: { kind: 'activated' }`): builds a sorcery-speed `'graveyard'` activated ability (`activationZones: ['graveyard']`, `timing: 'sorcery'`).
     - Add `unearthLeaveExile?: boolean` on `CardInstance` (`types.ts`, cleared in `leaveBattlefieldReset` `CR 400.7`) and `unearth: boolean` on `MoveStep` / `move` params (`ir.ts`): if `self` is still in `'graveyard'` with matching `sourceObjectVersion`, moves `self` to `'battlefield'`, sets `perm.unearthLeaveExile = true`, grants permanent Haste (`TimedContinuousEffect` `expires: 'never'`, `layer6: { addKeywords: ['haste'] }`), and creates a `DelayedTrigger` (`next end step` -> exile `perm`).
     - In `runtime/zones.ts` (`moveObject` / `resolveZoneChangeReplacements`): if `obj.zone === 'battlefield' && obj.unearthLeaveExile && dest !== 'exile'`, redirect `dest` to `'exile'` (`CR 702.84a`: `"If it would leave the battlefield, exile it instead of putting it anywhere else"` — note moving directly to `'exile'` via *Flickerwisp*/*Ephemerate* is NOT `"putting it anywhere else"` and proceeds normally!).
   - **`Buyback [cost]` (`CR 702.27a`), `Evoke [cost]` (`CR 702.74a`), & `Escape—[cost]` (`CR 702.138a–d`):**
     - **`Buyback`:** Register `'buyback'` in `KEYWORD_REGISTRY` (`parameterKind: 'cost'`, supporting mana & dash non-mana costs). Expose via `CastOption.optionalAdditionalCosts` (`id: 'buyback:0'`, `maxCount: 1`), setting `spellMods.returnToHandOnResolve = true` when paid. In `engine.ts` (`resolveStackItemNow`), when an Instant/Sorcery spell finishes resolving normally (`!item.isCopy`), if `item.spellMods?.returnToHandOnResolve && !item.spellMods?.exileOnLeaveStack`, move it to owner's `'hand'` instead of `'graveyard'` (`CR 702.27a`; countered or `CR 608.2b`-fizzled spells do NOT resolve so they still go to `'graveyard'`, and Flashback's `exileOnLeaveStack` overrides Buyback per `CR 702.34a`). Unlocks precon *Corpse Dance*.
     - **`Evoke`:** Register `'evoke'` in `KEYWORD_REGISTRY` (`parameterKind: 'cost'`, mana & dash costs like *Grief*). Expose `'alt:evoke'` `CastOption` (`spellMods.evoked = true` -> `perm.evoked = true` on battlefield entry, cleared on zone change `CR 400.7`) AND synthesize an innate ETB triggered ability (`event: 'enters'`, `object: 'self'`, `interveningIf: { k: 'evoked' }`, `effect: [sacrifice self]`, `CR 702.74a`) so controller orders Evoke sacrifice vs other ETB triggers (*Mulldrifter*, *Grief*) on the stack!
     - **`Escape`:** Register `'escape'` in `KEYWORD_REGISTRY` (`parameterKind: 'cost'`). Expose `'alt:escape'` `CastOption` from `'graveyard'` (`ownerId === actorId`, any non-land card type, `spellMods.escaped = true` -> `perm.escaped = true` on battlefield entry, cleared on zone change `CR 400.7`). Add `{ k: 'escaped' }` `Condition`, compile `"When ~ enters, sacrifice it unless it escaped"` (*Kroxa* / *Uro*), compile `"~ escapes with N [kind] counter(s) on it"` (`CR 702.138c`, ETB self-replacement gated on `escaped`), and compile `"~ escapes with [ability]"` (`CR 702.138d`).

4. **Coercive Hand Reveal/Discard (`CR 701.9, 701.20`) & Per-Turn Count / Cap / Batch Combat Triggers (`Slice 3`):**
   - **Coercive Hand Reveal & Chosen Discard (`ir.ts`, `compiler/effects.ts`, `runtime/effects.ts`, `engine.ts`):**
     - Extend `EffectParams` (`revealAndDiscard` verb or `chosenBy` / `revealHand` on `discard`) to represent `"<target player/opponent> reveals their hand. You [may] choose a [filter] card from it. [If you do, ]that player discards that card."` (preserving subsequent clauses like `"You lose 2 life."` or `"If you don't, ..."` via `stepDecisions`).
     - At execution: mark all cards currently in `targetPlayer.hand` as revealed (`knownToPlayerIds` for all active players until leaving `'hand'`, so `sanitizeGameStateForViewer` lets human viewers inspect them!) and log the revealed card names (`CR 701.20a`). Filter `targetPlayer.hand` via `matchesObjectFilter` (off-battlefield aware). If ≥1 card matches, prompt `you` with `chooseObjects` (`min: optional ? 0 : 1, max: 1`, `zone: 'hand'`) — or for bots select highest-MV matching card — then move the chosen card from `targetPlayer.hand` to `targetPlayer.graveyard` (`discardReason: 'discard'`, `graveyardReplacement: true`, pausable via `effectResume`!).
   - **Per-Turn Count, Once-Per-Turn (`CR 603.2i`), & Batch Combat Damage (`CR 603.2c`) Triggers (`types.ts`, `ir.ts`, `compiler/triggers.ts`, `runtime/triggers.ts`, `engine.ts`):**
     - Add `cardsDrawnThisTurn?: number` on `PlayerGameState` (`types.ts`), incremented per drawn card in `drawCards` (`engine.ts`) and reset to `0` at turn start alongside `playersDrawnThisTurn` and `spellsCastThisTurn`.
     - Add `nthThisTurn?: number` on `EventFilter` (`ir.ts`), compiling `"Whenever [player] draw(s) their second card each turn"` (`event: 'drawCard', nthThisTurn: 2`, matching when `drawer.cardsDrawnThisTurn === 2`) and `"Whenever [player] cast(s) their second spell each turn"` (`event: 'cast', nthThisTurn: 2`, matching when `!isCopy && caster.spellsCastThisTurn === 2`).
     - Add `onlyOncePerTurn?: boolean` on `TriggerDef` (`ir.ts`) and `triggeredOnceThisTurn?: string[]` on `GameState` (`types.ts`, keyed by `${source.obj.instanceId}:${source.obj.objectVersion ?? 1}:${abilityKey}`, reset at turn transitions), compiling trailing `"This ability triggers only once each turn."` (`CR 603.2i`; blinking increments `objectVersion` so the new permanent may trigger again per `CR 400.7`).
     - Emit a batch `CombatDamageBatchToPlayer` event (or `combatDamageToPlayerBatch` in `engine.ts` combat damage step after atomic assignment `CR 510.2`), compiling `"Whenever one or more [filter] you control deal combat damage to a player"` / `"...to an opponent"` (`#96: 27` cards, `CR 603.2c`: triggers once per damaged player, binding `eventPlayer` = damaged player).

5. **Precon & Staple Closers, Snapshots, `COVERAGE.md`, `rules-audit/`, & Live Browser Verification (`Slice 4`):**
   - **`Evolve` (`CR 702.100a–d`, *Fathom Mage*):** Register `'evolve'` in `KEYWORD_REGISTRY` (`status: 'implemented'`, `grantable: true`, `parameterKind: 'none'`, `implementation: { kind: 'trigger', events: ['enters'] }`) with `{ k: 'evolveCompare' }` intervening-if (`CR 603.4`) checked both on trigger and on resolution (comparing `entering` current/LKI power > `self` current power OR `entering` current/LKI toughness > `self` current toughness, requiring `self` to be a Creature per `CR 702.100c`, adding `+1/+1` counter on `self`, multiple instances triggering separately per `CR 702.100d`).
   - **Trailing `, where X is <amount>` in Triggered/Activated/Spell Effects (*Scourge of Valkas*):** Generalize trailing `, where X is <amount>` parsing in `compiler/effects.ts` so `X` inside effect clauses resolves to the parsed `Amount` (`{ k: 'count', ... }`, `{ k: 'stat', ... }`, etc.) across triggered, activated, and spell abilities.
   - **Targeting Additional Spell Costs (*Terror of the Peaks*):** Extend `costModifier` (`StaticDef` in `ir.ts`) with `additionalCosts?: CostDef[]` and `targetsSelf?: boolean` (`"Spells your opponents cast that target ~ cost an additional N life to cast"` / `"...cost {N} more to cast"`), enforced in `checkSpellCastOptionLegalityInner`, `getSpellCostRequirementForOption`, `planCosts`, and `PendingCostPayment` (`CR 601.2f`) whenever chosen `targets` reference `source.instanceId`.
   - **Off-Battlefield & Stack Colorless Rule Modifier (*Mycosynth Lattice*):** Compile `"All cards that aren't on the battlefield, spells, and permanents are colorless."` into Layer 5 `{ k: 'setColors', colors: [] }` on all permanents + `{ k: 'ruleModifier', rule: 'allOffBattlefieldAndSpellsColorless' }`, honored in `runtime/layers.ts` (`buildOffBattlefieldBreakdown`), `runtime/objectFilter.ts`, and stack spell color checks (`layerCache.ts` fingerprinted).
   - **Conditional Modal Choose-All & Target-Player Zone Count (*Jeska's Will*):** Add `conditionalChooseAll?: Condition` on `ModalDef` (`"Choose one. If you control a commander as you cast ~, you may choose both instead."`, allowing all modes when `evaluateCondition` holds at cast time `CR 700.2a`), and support `{ k: 'zoneCount', player: { k: 'targetPlayer', index }, zone }` in `compiler/effects.ts` (`"for each card in target opponent's hand"`).
   - **Multi-Destination Partitioned `Dig` (*Expressive Iteration*):** Extend `dig` (`ir.ts`, `compiler/effects.ts`, `runtime/effects.ts`) with optional `partitions?: Array<{ count: number; to: 'hand' | 'libraryBottom' | 'exile' | 'graveyard'; playableThisTurn?: boolean }>` executing sequential `chooseObjects` selections over the looked-at cards (`CR 608.2c`).
   - **Extra Combat & Main Phases (`CR 500.8`, *Hellkite Charger*):** Add LIFO `extraPhases?: Array<'combat' | 'main'>` on `GameState` (`types.ts`), `'extraCombatPhase'` verb (`followedByMain?: boolean`) + `"untap all attacking creatures"`, and pop `state.extraPhases` in `engine.ts` phase advancement (`end_combat` -> `begin_combat` resetting `state.combat` attackers/blockers when `'combat'` is popped!).
   - **Final Sweep:** Bump `COMPILER_VERSION` (`30` -> `31`..`34`), regenerate `compiler/__snapshots__/ir.json` and `COVERAGE.md`, update `ENGINE_INVARIANTS.md` & `rules-audit/` rows, and run live `vite dev` Chromium verification on `/magic` with `0` console/page errors.

---

### 2.18 Orthogonal Parallel Worktree Tracks: Sagas/Energy/Monarch, Fight/Impulse/Attached-LKI, & Cast/Special-Action CR 702 Keywords (Track P1–P3)

**Motivation:** While the `teamwork_preview` pipeline (`teamwork-mtg-engine` worktree) executes its 51-feature plan (`Precons 140/140`, damage prevention, blocking/evasion, conditional dual lands, Threshold/Metalcraft/Delirium, and 21 CR 702 keywords), three large, completely orthogonal Scryfall card clusters (`~1,400+` cards total) sit outside its feature manifest and decompose cleanly into three isolated git worktrees (`P1`, `P2`, `P3`) with additive IR/type extensions:

1. **Worktree Track P1 (`mtg_p1_sagas_energy` — Saga Cards `CR 715.1–4`, Energy `{E}` `CR 107.14`, & The Monarch `CR 726.1–5`):**
   - **Saga Cards (`CR 715.1–4`, `250` cards):**
     - Compile chapter ability lines (`I — <effect>`, `I, II — <effect>`, `I, II, III — <effect>`, `IV — <effect>`, `CR 715.2a–c`) into `TriggeredAbility` entries with `chapterNumbers: number[]` (`CR 715.2b`: `"When one or more lore counters are put on this Saga, if the number of lore counters on it was less than N and became at least N, [Effect]"` — if multiple lore counters are placed at once crossing `I` and `II`, both chapter triggers fire!). Keep `Read ahead` (`CR 702.155`) unsupported on Sagas that carry it so non-Read-ahead Sagas (`~235` cards) compile honestly.
     - Derive `finalChapterNumber` (`CR 715.2d`: greatest chapter number among chapter abilities the Saga currently has; `0` if it loses all abilities via Layer 6, preventing sacrifice per `CR 715.4`).
     - **`CR 715.3a` ETB Lore Counter:** As a Saga enters the battlefield, put `1` `lore` counter on it (`applySelfEtbReplacements` / `moveObject` onto battlefield, honoring counter replacement effects and emitting `CounterPlaced` with `prevCount` -> `newCount` so chapter `I` triggers).
     - **`CR 715.3b` Precombat Main Turn-Based Action:** Immediately at the start of the active player's precombat main phase (`main1` in `beginPhase`, before priority), put `1` `lore` counter on each phased-in Saga the active player controls.
     - **`CR 715.4` / `CR 704.5s` State-Based Action:** In `checkStateBasedActions`, sacrifice any Saga whose `lore` counter count `>= finalChapterNumber > 0` **only when** no chapter ability from that Saga (`sourceInstanceId === perm.instanceId && isChapterAbility`) is currently on `state.stack` or queued in `state.pendingTriggers`.
   - **Energy `{E}` Counters (`CR 107.14`, `CR 122.1f`, `144` cards):**
     - Add plain-JSON `energyCounters?: number` on `PlayerGameState` (`types.ts`), proliferatable alongside `poisonCounters` when `(player.energyCounters ?? 0) > 0` (`CR 701.34a`).
     - Parse `"Pay {E}..."` / `"Pay N {E}"` in `compiler/costs.ts` into `{ k: 'payEnergy', count: Amount }` (enforced in `runtime/costs.ts` `checkSimple` & `executeCostPaymentParts`, automatically composing with `OptionalSpec` for `"you may pay {E}{E}. If you do, ..."`).
     - Parse `"[You / Target player] get(s) {E}..."` into `{ verb: 'gainEnergy', player, amount }` (`compiler/effects.ts`, `runtime/effects.ts`) and `"{E}"` player counter amounts (`{ k: 'energyCount', player }`).
   - **The Monarch (`CR 726.1–5`, `CR 800.4k`, `67` cards):**
     - Add `monarchPlayerId?: string | null` on `GameState` (`types.ts`), `{ verb: 'becomeMonarch', player }`, `BecameMonarch` event (`"Whenever you become the monarch"`), and `{ k: 'isMonarch', player }` `Condition`.
     - Implement both inherent game-level triggered abilities (`CR 726.2`, pushed onto `state.stack` independent of any permanent): (a) at the beginning of the monarch's `end_step`, that player draws a card; (b) whenever a creature deals combat damage to the monarch, its controller becomes the monarch. Handle `CR 800.4k` succession if the monarch leaves a multiplayer game.

2. **Worktree Track P2 (`mtg_p2_fight_impulse_triggers` — Two-Target Fight/Bite `CR 701.14`, Multi-Turn/Free Impulsive Draw `CR 601.1a`, & Attached-LKI / Heroic Triggers `CR 603.10a`):**
   - **Two-Target Fight & Power-Damage "Bite" (`CR 701.14a–d`, `CR 120.3`, `CR 608.2b`, `313` cards):**
     - Compile two-target fight (`"Target creature you control fights [up to one] target creature [you don't control / an opponent controls]"`) enforcing `CR 701.14b` (if either target is illegal or not a creature on the battlefield at resolution, neither deals nor is dealt damage) and `CR 701.14c` (if a creature fights itself, it deals damage equal to its power to itself once, not twice).
     - Compile two-target & pronoun one-way power-damage "bite" (`"Target creature you control deals damage equal to its power to target [creature / creature or planeswalker / any target]"`, `"It deals damage equal to its power to ..."`), enforcing `CR 608.2b` (*an illegal target cannot perform actions*: if target #0 — your creature — is illegal/gone on resolution while target #1 remains legal, the spell still resolves without fizzling so trailing effects run, and target #0 deals `0` damage!).
     - Compile `"~ deals N damage to target player or planeswalker"` (`53` cards) and `"~ deals N damage to each creature and each player"` (`26` cards).
   - **Multi-Turn & Free-Cast Impulsive Draw (`CR 601.1a`, `CR 406`, `CR 118.9`, `219` cards):**
     - Extend `PlayableFromExilePermission` (`types.ts`) and `grantPlayFromExile` (`ir.ts`, `compiler/effects.ts`, `runtime/effects.ts`, `engine.ts`) with `duration: 'thisTurn' | 'untilEndOfYourNextTurn' | 'untilYourNextEndStep' | 'asLongAsExiled'`, `spellsOnly?: boolean` (`"may cast"` forbids lands vs `"may play"` allows lands respecting land drops `CR 305.2`), and `withoutPayingManaCost?: boolean` (`CR 118.9` `{0}` alternative cost `CastOption` from `'exile'`, X = 0 per `CR 107.3b`).
   - **Attached-Permanent LKI Death Triggers & Cast-Targeting Heroic Triggers (`CR 603.10a`, `CR 603.2`, `~125` cards):**
     - Compile `"When enchanted [creature/permanent/land] dies, ..."` and `"When equipped creature dies, ..."` (*Skullclamp*, *Kaya's Ghostform*, *Rancor*-style triggers), capturing LKI `attachedToId` at the moment of battlefield exit (`CR 603.10a` look-back in time before SBA unattachment) and binding `that card` (`eventObject`) so `"return that card to the battlefield under your control / its owner's control"` and `"draw two cards"` execute accurately.
     - Strip `Heroic —` ability word (`compiler/normalize.ts`) and compile `"Whenever you cast a spell that targets ~, ..."` (`event: 'cast'`, `!isCopy`, `targetsSelf: true`).

3. **Worktree Track P3 (`mtg_p3_orthogonal_keywords` — 9 Orthogonal `CR 702` Keywords Reusing CastOption / Special Action / Crew Infrastructure):**
   - Implement with **zero** keyword literals in `ArenaTable.svelte` or `ai.ts` (surfacing via generic `CastOption`, generic hand special actions, and `ActivatedAbility`):
     - **`Foretell [cost]` (`CR 702.143a–f`, `CR 116.2h`, `52` cards):** Priority special action during your turn paying `{2}` to exile face-down from `'hand'` (`knownToPlayerIds: [actorId]`, `foretoldTurnNumber`); `'exile:foretell'` `CastOption` on any later turn (`state.turnNumber > foretoldTurnNumber`) for `[cost]`.
     - **`Plot [cost]` (`CR 702.170a–d`, `CR 116.2k`, `34` cards):** Sorcery-speed special action paying `[cost]` to exile face-up from `'hand'` (`plottedTurnNumber`); `'exile:plot'` `CastOption` on a later turn (`withoutPayingManaCost`, sorcery timing even for Instants per `CR 702.170d`).
     - **`Saddle N` (`CR 702.171a–c`, `34` cards):** Sorcery-speed `ActivatedAbility` reusing `{ k: 'tapSubsetSum', metric: 'power', minTotal: N, other: true }`, setting `perm.saddledThisTurn = true` (cleared at cleanup / leave battlefield), emitting `BecomesSaddled`, and supporting `"Whenever ~ attacks while saddled"` (`saddled` filter/condition).
     - **`Entwine [cost]` (`CR 702.42a–b`, `31` cards):** `CastOption.optionalAdditionalCosts` (`id: 'entwine:0'`, `maxCount: 1`) choosing all modes of a modal spell when paid.
     - **`Disturb [cost]` (`CR 702.146a–b`, `CR 712.8c`, `25` cards):** `'alt:disturb'` `CastOption` from `'graveyard'` casting back face (`faceIndex: 1`, `transformed: true`), plus back-face `"If ~ would be put into a graveyard from anywhere, exile it instead"` static replacement.
     - **`Blitz [cost]` (`CR 702.152a–c`, `17` cards):** `'alt:blitz'` `CastOption` granting Haste, `"When this creature dies, draw a card"`, and end-step sacrifice `DelayedTrigger`.
     - **`Retrace` (`CR 702.81a`, `18` cards) & `Jump-start` (`CR 702.133a`, `13` cards):** `'graveyard:retrace'` (`discard a land card`) and `'graveyard:jumpstart'` (`discard a card` + `exileOnLeaveStack: true`) `CastOption`s.
     - **`Cumulative upkeep [cost]` (`CR 702.24a–b`, `61` cards):** Upkeep triggered ability placing `1` `age` counter on `self`, then sacrificing `self` unless controller pays `[cost] × ageCounters`.

4. **Merge Hygiene Across Parallel Worktrees:**
   - Keep `ir.ts`, `types.ts`, and `keywords.ts` additions strictly additive inside labeled `// --- Track P1 ---` / `P2` / `P3` sections.
   - Defer `COMPILER_VERSION` bump, `compiler/__snapshots__/ir.json`, and `docs/COVERAGE.md` regeneration to the unified post-merge integration commit on `engine-rewrite` (completed at `1b85366`, `COMPILER_VERSION = 34`, **`11,161 / 35,062 = 31.8%`** full Scryfall cards, **`33,783 / 64,844 = 52.1%`** abilities).

### 2.19 Modular UI Architecture (`U1–U4`) & Wave 2 Orthogonal Engine Worktrees (`P4–P6`)

*Status: active in parallel git worktrees off `1b85366` alongside `teamwork-mtg-engine`.*

#### Part A — Modular Svelte 5 UI Architecture (`src/lib/magic/ui/`, Tracks `U1–U4`)
- **UI Track U1 (`mtg_u1_board_hud`):** Single-pass O(B) `boardViewModel.ts` (eliminating O(B²) attachment scans and duplicate `evaluatePermanent` calls), read-only `autoTapPreview.ts`, upgraded `ManaSymbol.svelte` (`{E}`, `{Q}`, `{S}`, Phyrexian & split-hybrid glyphs), `HudBar.svelte` (exposing `first_strike_damage` & `end_combat` phase stops, Waiting-on-Opponent pill, `Space`/`Enter`/`Ctrl` hotkeys), `PlayerVitals.svelte` & `OpponentPod.svelte` (`monarchPlayerId` crown, `energyCounters` `{E}`, `experienceCounters`, all `restrictedMana` keys, shield badges, `radCounters` slot), and `PermanentCard.svelte` & `HandTray.svelte` (rendering all counter types including Saga `lore` + amber auto-tap hover glow).
- **UI Track U2 (`mtg_u2_targeting_modals`):** Pure `targetingController.ts` splitting multi-slot `TargetSpec[]` sequentially across all cast/ability/modal/drop entry points, enforcing `otherTarget` (`CR 115.3`), preserving locked-slot target arrows (`accumulatedTargets`), fixing `"up to"` (`minTargets === 0`) Skip/Confirm advancement, auto-opening `exile_card` & `graveyard_card` drawers, and extracting `TargetBanner`, `CastOptionsModal` (with `"Peek Battlefield"`), `ModePickerModal`, `XCostModal`, and `AbilityMenuModal`.
- **UI Track U3 (`mtg_u3_prompts_lobby`):** Pure `promptViewModel.ts` (cross-zone candidate lookup, face-down masking, generalized `orderObjects`, `CR 601.2d` divided-allocation math, 2-pile split state, searchable string-option ranking), `ChoicePromptModal.svelte` (with `"Peek Battlefield"`), `AllocationStepperWidget.svelte`, `SearchableOptionPicker.svelte`, `ZoneBrowserModal.svelte`, `RightDock.svelte`, `CardInspector.svelte`, shared `AltHoverPreview.svelte`, and decomposing `src/routes/magic/+page.svelte` into `src/lib/magic/ui/lobby/*.svelte`.
- **UI Track U4 (Post-Merge Shell Wiring):** Replaces monolithic sections of `ArenaTable.svelte` with U1–U3 components and verifies live `/magic` gameplay via headless Chromium.

#### Part B — Wave 2 Orthogonal Engine Worktrees (`Track P4`, `Track P5`, `Track P6`)
Strictly disjoint from `teamwork-mtg-engine` M1–M4 (`PROJECT.md`) and UI Tracks `U1–U3`:
1. **Track P4 (`mtg_p4_tuck_freeze_chosen_mana` — Library Tuck, Next-Untap Freeze + `Exert`, ETB Chosen Type/Color, & Combo/Filter/Verge Mana; `~182` single-blocker / `449` total cards):**
   - **Library Top / Bottom / Top-or-Bottom / Nth-from-Top (`CR 401.2`, `CR 401.4`, `CR 401.7`):** Extend `move` to `'library'` with `'top' | 'bottom' | 'topOrBottom' | { fromTop: number }` (clamping to bottom when `library.length < N` per `CR 401.7`, owner choice on `'topOrBottom'`, owner ordering when moving >=2 cards simultaneously per `CR 401.4`).
   - **Next-Untap Freeze & `Exert` (`CR 502.3`, `CR 611.2b`, `CR 701.43a–d`):** `doesntUntapNextUntapStep?: boolean` on `CardInstance` consumed in `engine.ts` untap step (`CR 502.3`) and cleared on zone change (`CR 400.7`); compile `"doesn't/don't untap during [its controller's / their / your] next untap step"` + `Exert` (`"exert [subject]"`, `"You may exert ~ as it attacks. When you do, [effect]"`).
   - **ETB Chosen Creature Type & Chosen Color (`CR 614.1c`, `CR 614.12`, `CR 105.4`, `CR 205.3m`):** Compile `"As ~ enters [tapped], choose a creature type / choose a color"` ETB replacements storing `chosenSubType?: string` / `chosenColor?: ManaColor` on `CardInstance`, wired into `ObjectFilter` (`"of the chosen type/color"`), Layer 6/7c lords, and mana production (`"Add one mana of the chosen color"`).
   - **Multi-Color Combination Mana + Filter Lands + Verge Lands (`CR 106.1a–b`, `CR 602.5b`, `CR 605.1a`):** Compile `"Add [N/X] mana in any combination of [colors / {W}, ...]"`, Filter-land multi-bundle mana choices (`"{W/B}, {T}: Add {W}{W}, {W}{B}, or {B}{B}."`), and Verge-land subtype activation conditions (`"Activate only if you control a [Sub1] or a [Sub2]."`).
2. **Track P5 (`mtg_p5_cr701_keyword_actions` — 8 Self-Contained `CR 701` Actions; `~126` single-blocker / `294` total cards):**
   - Implement in `src/lib/magic/runtime/keywordActions.ts` + `compiler/effects.ts`: **`Amass [Subtype] N`** (`CR 701.47a–d`), **`Incubate N`** (`CR 701.53a–c`, `CR 111.10i` DFC Incubator -> `0/0` Phyrexian artifact creature token), **`Populate`** (`CR 701.36a–b`, `CR 707.2`), **`Manifest` + `Cloak` + `Manifest dread`** (`CR 701.40`, `701.58`, `701.62`, turning manifested/cloaked creature cards face up via `turn_face_up` for their printed `manaCost` per `CR 701.40b` / `701.58b`), **`Monstrosity N`** (`CR 701.37a–c` + `"When ~ becomes monstrous"` + `"is monstrous"`), **`Bolster N`** (`CR 701.39a`), **`Support N`** (`CR 701.41a`), and **`Adapt N`** (`CR 701.46a`).
3. **Track P6 (`mtg_p6_striated_frames_and_cast_keywords` — Striated/Inset Frames & Cast/Hand Keywords; `~161` single-blocker / `340+` total cards):**
   - **Striated / Inset Permanent Frames (`src/lib/magic/runtime/striatedFrames.ts` + `compiler/card.ts`):** **`Station` / `STATION N+`** (`CR 722.1–4`, `CR 702.184a`), **`Level up` / `LEVEL N1-N2` / `N3+`** (`CR 711.1–7`, `CR 702.87a–c`), and **`Prototype`** (`CR 719.1–5`, `CR 702.160a–b`, Layer 1 characteristics override when `prototyped`).
   - **`kicker.ts` Optional-Additional-Cost Copy/Token Family:** **`Offspring`** (`CR 702.175`), **`Squad`** (`CR 702.157`), **`Replicate`** (`CR 702.56`), **`Conspire`** (`CR 702.78`), and **`Casualty N`** (`CR 702.153`).
   - **Pure `KEYWORD_REGISTRY` Hand/Counter/Exile Keywords:** **`Warp`** (`CR 702.185`), **`Vanishing`** (`CR 702.63`), **`Fading`** (`CR 702.32`), **`Transmute`** (`CR 702.53`), and **`Reinforce`** (`CR 702.77`).

### 2.20 Wave 3 Zero-Overlap Parallel Engine Worktrees (`Track P7`, `Track P8`, `Track P9`)

**Empirical Design (`~+1,795` deduplicated full-card unlocks on `oracle-cards.jsonl.gz`):** Each Wave 3 track owns a **strictly disjoint set of `compiler/` files** plus its own dedicated runtime module (`src/lib/magic/runtime/<trackModule>.ts` + `.test.ts`), touching shared files (`ir.ts`, `types.ts`, `engine.ts`, `runtime/effects.ts`) only via fenced `// --- Track P7|P8|P9 ---` union/delegation blocks:

1. **Track P7 (`mtg_p7_copy_prevention_effects` — `compiler/effects.ts`, `compiler/triggers.ts`, `compiler/interpretable.ts`, `runtime/copyPreventionAndEffects.ts`; `+561` solo full cards):**
   - **P7.1 Damage Prevention Shields & Burn/Combat Riders (`CR 615.1–12`, `CR 701.19`, `CR 614.1a`, `CR 509.1b`, `230` cards):**
     - `DamagePreventionShieldEntry` (`remaining: number | 'infinite'`, `combatOnly`, `targetKind`, `(targetId, targetObjectVersion)` `CR 400.7`, `fromSourceInstanceId`): `"Prevent all [combat] damage that would be dealt [to/by ...] this turn"` and `"Prevent the next N/X damage that would be dealt to [target/you/~] this turn"`. Enforces `CR 615.6` (prevented damage never happens) and `CR 615.12` (`damageCantBePrevented` neither prevents nor depletes `remaining`).
     - Burn/removal riders: `"It/They can't be regenerated"` (`CR 701.19`) and `"If [that creature/permanent/it] would die this turn, exile it instead"` (`CR 614.1a`, `(instanceId, objectVersion)` scoped).
     - Timed combat evasion/restriction steps: `"[Subject] can't be blocked [except by ...] this turn"` and `"[Subject] can't block this turn"` (`CR 509.1b`).
   - **P7.2 Token Copy & Temporary Layer 1a Copy (`CR 707.2`, `CR 707.4`, `CR 707.8a`, `CR 707.9a–d`, `30` solo / `67+` w/ P8):**
     - `"Create [a/N/X] token(s) that's [tapped and attacking and] a copy of [target/~/equipped/enchanted/it][, except ...]"` and `"[~/Target ...] becomes a copy of [target ...][, except ...] until end of turn"`.
     - Populates `CopiableState` (`TimedContinuousEffect.layer1a` for temporary copy; never mutates `perm.card`), strips Layer 7a P/T CDAs when `except` sets P/T (`CR 707.9d`), and preserves both faces on transforming DFC token copies (`CR 707.8a`).
   - **P7.3 Edict Sacrifice, Wheel / Random Discard, & `CR 601.2d` Divided Damage/Counters (`155` cards):**
     - `"[Target/Each player/opponent] sacrifices [a/N] [creature/artifact/enchantment/planeswalker/nonland permanent] [of their choice]"` (`CR 701.17`).
     - `"[Each/Target player / You] discards [their/your] hand, then draws [N / that many] cards"` + `"[Target/Each player/opponent] discards [N/X] cards at random"` (deterministic PRNG).
     - `CR 601.2d` announcement-time division (`TargetSpec.divideTotal`, `StackItem.targetDivisions`, `>= 1` per target, `CR 608.2b` partial-legality share preservation, pairing directly with UI Track U3 `AllocationStepperWidget.svelte`) + `"[Up to N] target creatures each get +X/+Y until end of turn"`.
   - **P7.4 Trigger Object-Filter Stats, Attached Combat/Damage Triggers, & Turn-History Intervening-If (`CR 603.2`, `CR 603.4`, `142` cards):**
     - Wire `power`, `toughness`, and `manaValue` in `RUNTIME_OBJECT_FIELDS` (`compiler/triggers.ts` + `runtime/triggers.ts`).
     - Wire `attachedTo` on `blocks`, `becomesBlocked`, `dealtDamage`, and `becomesTarget` (`'ability' | 'spellOrAbility'`).
     - Turn-history intervening-if conditions: `creatureDiedThisTurn` (*Morbid*), `attackedThisTurn` (*Raid*), `permanentLeftBattlefieldThisTurn` (*Revolt*), `lifeGainedThisTurn`, and `wasCast`.

2. **Track P8 (`mtg_p8_statics_layers_restrictions` — `compiler/statics.ts`, `compiler/costs.ts`, `runtime/staticsLayersAndRestrictions.ts`; `+884` solo full cards):**
   - **P8.1 `ObjectFilter` Completeness (`320` cards):** `notColors` (`nonwhite`/`nonblue`/`nonred`/`nongreen`), `multicolored` / `monocolored` (`CR 105.2`), `hasKeywords` / `lacksKeywords`, `hasCounters`, `toughness: Compare`, and `allTypes` (`artifact creature`, `enchantment creature`, `land creature` AND-semantics `CR 205.2b`).
   - **P8.2 Static Combat Evasion/Block Locks & Activated-Ability Locks (`CR 508.1c`, `CR 509.1a–c`, `CR 602.5a`, `207` cards):**
     - `cantBlockExcept`, `additionalBlockCount` (`1..N` / `'unlimited'`), `cantBeBlockedBy`, `cantBeBlockedExceptBy` (incl. `maxBlockers`), `mustBeBlockedIfAble` (`CR 509.1c` maximum-requirement assignment check), and `cantAttackUnlessDefenderControls`.
     - `cantActivateAbilities` (`allowManaAbilities: boolean`) on filtered permanents (*Collector Ouphe*, *Null Rod*) and `attachedTo` (*Arrest*, *Planar Disruption*).
   - **P8.3 Conditional Statics & All-Zone `*/*` Layer 7a CDAs (`CR 604.3`, `CR 208.2a`, `CR 613.4a`, `203` cards):**
     - Strip conditional static prefixes (`During your turn`, `Threshold`, `Metalcraft`, `Delirium` via `distinctCardTypesInZone`, `Ferocious`, `As long as you control ...`, `As long as ~ is tapped/untapped/equipped/enchanted/attacking`) into `StaticDef.condition`, evaluated against layer-consistent state up to `L - 1` (`CR 613.1`).
     - All-zone `*/*`, `*/N`, `N/*`, and `1+*` (`Tarmogoyf`) Layer 7a CDAs (`setBasePT`, `setBasePower`, `setBaseToughness`) evaluated both in `runtime/layers.ts` Layer 7a and off-battlefield in `runtime/objectFilter.ts` (`objectPower` / `objectToughness`, closing `ENGINE_INVARIANTS.md` §2.5).
   - **P8.4 Conditional ETB Dual Lands, Generalized *Clone*, & Top-of-Library / Graveyard Play (`CR 614.1c`, `CR 614.12`, `CR 707.5`, `CR 401.5`, `CR 601.3e`, `CR 305.1`, `173` cards):**
     - Fastlands, Slowlands, Checklands, Tango lands, Crowdlands, Shocklands (`entersTappedUnlessPayCost: pay 2 life`, auto-tapped when `life < 2` or life total can't change `CR 119.4`/`119.8`), and Reveal lands.
     - Generalized `enterAsCopy` (`optional`, `filter: ObjectFilter`, `tapped`, `except: CopyModificationSpec`).
     - `lookAtTopOfLibrary` (with `CR 401.5` mid-cast/activation lock while `pendingCostPayment` is active!), `revealTopOfLibrary`, `playFromTopOfLibrary` (`allowLands`, `spellFilter`), and `playLandsFromGraveyard`.

3. **Track P9 (`mtg_p9_keywords_wave3` — `keywords.ts`, `compiler/card.ts`, `runtime/keywordsWave3.ts`; 18 `CR 702` Keywords, `+328` solo full cards):**
   - **P9.1 Stack/Exile/Upkeep Cast & Triggered (`123` cards):** `Echo` (`CR 702.30a–b`, `cameUnderControlSinceLastUpkeep` re-armed on control change), `Madness` (`CR 702.35a–c`, `400.7k` discard-to-exile replacement + timing-ignoring cast trigger -> graveyard on decline), `Cascade` (`CR 702.85a–c`, dual MV check blocking expensive MDFC back faces), and `Rebound` (`CR 702.88a–c`, `castFromZone === 'hand'` check).
   - **P9.2 LKI Death-Return & Spirit Recovery (`64` cards):** `Soulshift N` (`CR 702.46a–b`), `Undying` (`CR 702.93a`), `Modular N` (`CR 702.43a–b`), and `Persist` (`CR 702.79a`) — snapshotting `preSbaCounters` before simultaneous `CR 704.5f` + `CR 704.5q` annihilation per **`CR 704.8`**!
   - **P9.3 Payment Aid, Alt-Cast, Combat Swap & GY Exile (`56` cards):** `Improvise` (`CR 702.126a–c` via generic `CastCostAid`), `Dash` (`CR 702.109a`), `Ninjutsu` + `Commander ninjutsu` (`CR 702.49a–d`, `CR 508.4` tapped-and-attacking swap without Commander tax `CR 903.8`), and `Scavenge` (`CR 702.97a` graveyard LKI power).
   - **P9.4 Combat Poison, ETB Choice/Counters & Cast Drain (`84` cards):** `Toxic N` (`CR 702.164a–c` static sum on >0 combat damage), `Bloodthirst N` (`CR 702.54a–c`), `Flanking` (`CR 702.25a–b`), `Fabricate N` (`CR 702.123a–b`), `Unleash` (`CR 702.98a`), `Extort` (`CR 702.101a–b` actual life lost), and `Riot` (`CR 702.136a–b` per-instance static ETB choice).

### 2.21 Wave 4 Parallel Worktree Plan (Tracks P10–P12, post-`v36` — targeting `~51%+` Scryfall)

Baseline entering Wave 4 (`COMPILER_VERSION = 36`): **`14,775 / 35,062` (`42.1%`) full game cards**, **`17,762` (`50.7%`) ignoring statics**, **`140 / 140` (`100.0%`) Commander Precon cards**, `0` compiler errors.

Wave 4 partitions the next **`+3,600+` deduplicated Scryfall cards** across **3 compiler-disjoint git worktrees**:

1. **Track P10 (`mtg_p10_reflexive_mana_actions` — exclusively owns `compiler/effects.ts`, `compiler/triggers.ts`, `compiler/interpretable.ts`, `runtime/reflexiveManaAndActions.ts`; `+2,008` cards):**
   - **P10.1 Reflexive Delayed Triggers & Expanded Optional Chains (`CR 603.12`, `CR 603.2d`):** `"When you do, ..."` / `"Whenever [event] this way, ..."` queued as a separate stack item with targets chosen when placed on the stack (using a plain-JSON `CompiledReflexiveLocator` — **zero IR in `GameState`**; never multiplied by `triggerMultiplier` per `CR 603.2d`), plus expanded `"You may <action> ... If you do / If you don't / Otherwise"` chains.
   - **P10.2 Mana Spending Restrictions, Unemptied Mana, & Quoted EOT/Token Ability Grants (`CR 106.6`, `CR 106.4`):** Generalized `ManaRestrictionSpec` (`onlyCast`, `onlyActivateAbilities`, `onlyCastOrActivate`, `notFor`), `retainUntil: 'endOfTurn' | 'endOfCombat'`, and quoted EOT (`gains "<ability>" until end of turn`) & token (`with "<ability>"`) ability grants via plain-JSON compiled locators.
   - **P10.3 Generalized `attach`, Multi-Zone/Opponent `search`, `dig`/`revealUntil`, Graveyard/LTB `exile`, & Stack `copySpell`/`copyAbility`/`counterSpell` (`CR 701.3a–d`, `CR 701.23b`, `CR 707.10`, `CR 614.15`).**
   - **P10.4 `CR 701` Keyword Actions, Coin Flips & Die Rolls (`CR 701.29, 701.30, 701.35, 701.56, 701.57, 701.59–61, 701.63, 701.68, 705, 706`):** `Discover N` (`CR 701.57a` double-MV check -> hand on decline), `Clash` (`CR 701.30c–d`), `Detain` (`CR 701.35a` blocks mana abilities too), `Suspect` (`CR 701.60c`), `Collect evidence N` (`CR 701.59`), `Forage` (`CR 701.61`), `Endure N` (`CR 701.63b`), `Time travel` (`CR 701.56`), `Blight N` (`CR 701.68b`), `Fateseal` (`CR 701.29`), Coin Flips (`CR 705`), and `d4..d20` Die-Roll Result Tables (`CR 706`).
   - **P10.5 Trigger Heads & Intervening-Ifs:** `attackedAndUnblocked` (`CR 509.1h`), `attacksAlone`/`minAttackers`, `becomesUntapped` (`CR 603.2e`), noncombat `damageDealt`, batch `cardsLeaveGraveyard` (`CR 603.10a`), `sacrificed`, `"creature dealt damage by ~ this turn dies"`, enchanted controller/player upkeep, `exploited` (`702.110b`), `scried`, `committedCrime` (`700.13`), `expended` (`700.14`), `"blocks or becomes blocked by [filter]"`, and conditions `castFromHand`, `opponentLostLifeThisTurn`, `lifeGainedThisTurnAtLeast`, `descendedThisTurn` (`700.11` cards only), `hadCounterOnIt`, `manaColorSpentToCast`, `opponentControlsMoreLands`.

2. **Track P11 (`mtg_p11_statics_dynamic_costs` — exclusively owns `compiler/statics.ts`, `compiler/costs.ts`, `runtime/staticsDynamicAndCosts.ts`; `+1,059` cards):**
   - **P11.1 Layer 6 Quoted Triggered/Static/Activated Grants & Compound Single-Line Statics (`CR 613.1f`, `CR 613.7e`, `CR 107.3j`):** `grantTriggered`, `grantStatic`, and `compound` `LayerMod[]` derived from compiled definitions with zero IR in `GameState`.
   - **P11.2 Dynamic Scaling Layer 7b/7c P/T & Generalized Cost Modifiers (`CR 700.8` Party bipartite `0..4`, Domain, `mul`, `attachmentsOn`, `CR 601.2f,h` colored/conditional/floor/alt-cast cost modifiers).**
   - **P11.3 Ability & Named Counters, External ETB Counter/Tap Replacements, Damage/Life/Untap/Hand/Draw Replacements & Card-Name Choice (`CR 122.1b,d`, `CR 614.7a`, `CR 614.12`, `CR 502.3`, `CR 510.1a`).**
   - **P11.4 Snow `{S}`, Phyrexian `{W/P}`/`{C/P}`/`{W/U/P}`, Twobrid `{2/W}`/`{C/W}` (`MV = 2` per `CR 202.3f`), & Non-Mana Costs (`bounce`, `mill`, generalized `removeCounters`/`exileFrom`).**

3. **Track P12 (`mtg_p12_frames_keywords_wave4` — exclusively owns `keywords.ts`, `compiler/card.ts`, `runtime/keywords-coverage-guard.test.ts`, `runtime/keywordsWave4.ts`; `+531` solo cards, `41` `CR 702` keywords):**
   - **P12.1 Permanent `additionalCastCost`, Generalized `Ward`/`Enchant`/`Equip`, `Class` (`CR 717`), `Case` (`CR 720` & `702.169`), `Spree` (`CR 702.172`) & `Tiered` (`CR 702.183`) & `Escalate` (`CR 702.120`) per-mode costs (`CR 700.2h`), and `Exhaust` (`CR 702.177`), `Boast` (`CR 702.142`), `Forecast` (`CR 702.57`).**
   - **P12.2 41 Wave 4 `CR 702` Keywords:** `Bestow` (`702.103`), `Backup` (`702.165`), `Myriad` (`702.116`), `Awaken` (`702.113`), `Encore` (`702.141`), `Renown` (`702.112`), `Embalm` (`702.128`), `Dredge` (`702.52`), `Champion` (`702.72`), `Split second` (`702.61`), `Miracle` (`702.94`), `Decayed` (`702.147`), `Devour` (`702.82`), `Mentor` (`702.134`), `Umbra armor` (`702.89`), `Enlist` (`702.154`), `Rampage` (`702.23`), `Eternalize` (`702.129`), `Aftermath` (`702.127`), `Firebending` (`702.189`), `Emerge` (`702.119`), `Harmonize` (`702.180`), `Sunburst` (`702.44`), `Mobilize` (`702.181`), `Spectacle` (`702.137`), `Surge` (`702.117`), `Ingest` (`702.115`), `Dethrone` (`702.105`), `Recover` (`702.59`), `Melee` (`702.121`), `Afflict` (`702.130`), `Escalate` (`702.120`), `Outlast` (`702.107`), `Training` (`702.149`), `Bargain` (`702.166`), `Graft` (`702.58`), `Undaunted` (`702.125`), `Mayhem` (`702.187`), `Web-slinging` (`702.188`), `Sneak` (`702.190`), and `Beam me up` (`702.196`).

### 2.22 Wave 5 Parallel Worktree Plan (Tracks P13–P15, post-`v37` — targeting `~62%–65%` Scryfall / `~66%–70%` Paper Eternal)

Wave 5 partitions the next **`+3,300–4,000` deduplicated Scryfall cards** (plus `19` false-positive frame bugfixes on Battles & Omens) across **3 compiler-disjoint git worktrees**, pre-assigning disjoint `runtime/layers.ts` `READ_*` bitmasks (`READ_P13 = 131072`, `READ_P14 = 262144`, `READ_P15 = 524288`):

1. **Track P13 (`mtg_p13_effects_triggers_designations` — exclusively owns `compiler/effects.ts`, `compiler/triggers.ts`, `compiler/interpretable.ts`, `runtime/effectsWave5.ts`; `+2,200–2,850` cards):**
   - **P13.1 Disjunctive/Relational `ObjectFilter`s, Dynamic `Amount`s, & `interpretable.ts` Unlocks:** `attackingOrBlocking`, `anyOfColors`, `excludedSubtypes`, `historic` (`CR 700.6`), `dealtDamageThisTurn`, `enteredThisTurn`, `controllerRef: 'defendingPlayer' | 'targetPlayer'`, `targetPlayerOrBattle`, dynamic `power`/`manaValue` comparisons vs `selfPower`/`xValue`/`countersOnSelf`; `devotionTo` (`CR 700.5`), `unlockedDoorsCount` (`CR 709.5`), `damageDealtThisWay`/`lifeLostThisWay`, `excessDamage`, `colorsAmongPermanents`, and `twice X` / `half rounded up/down`.
   - **P13.2 Cross-Turn Continuous Durations, Multi-Sentence Pronoun Chaining, Temporary Graveyard/Exile Cast Grants, `Exchange`, `takeExtraTurn`, Face-Down Actions, & Punisher `"unless"`:** `untilYourNextTurn` & `untilEndOfYourNextTurn` (`CR 611.2b`), pronoun chaining (`"It has \"...\""`, `"That token gains ..."`, `"Then that player shuffles"`), temporary cast permissions (`"You may cast target ... from your graveyard this turn"`, `"gains flashback until end of turn"`), `Exchange` (`CR 701.12` control/life/zones), `takeExtraTurn` (`CR 500.7`), `turnFaceDown`/`turnFaceUp`/`returnFaceDown` (`CR 708`), inline color/subtype/type choices, and punisher `"unless [player] pays / sacrifices / discards"`.
   - **P13.3 Planeswalker Emblems (`CR 114`), Remaining `CR 111.10` Tokens (incl. Roles `CR 704.5s`), `Double`/`Triple` (`CR 701.10–11`), Dungeons/Initiative/Ring (`CR 309, 701.49, 701.54, 727`), & Remaining `CR 701` Actions:** Emblems stored in `command` zone via plain-JSON locators / synthesized `ScryfallCard` (**zero IR in `GameState`**); predefined `Map`, `Lander`, `Shard`, `Walker`, `Junk`, `Gold`, `Eldrazi Spawn`/`Scion`, and all 7 `Role` Aura tokens (`CR 111.10k–r` + `CR 704.5s` SBA); `Double`/`Triple` power/toughness/counters/life; `The Ring tempts you` (`CR 701.54`), `Venture into the dungeon` / `Take the initiative` (`CR 309`, `701.49`, `727`), `Earthbend N` (`701.66`), `Airbend` (`701.65`), `Support N` (`701.41` extensions), `Learn` (`701.48`), `Villainous choice` (`701.55`), and `Vote` (`701.38`).
   - **P13.4 Trigger Filter/Condition Unification & Remaining Trigger Heads:** Sync `RUNTIME_OBJECT_FIELDS` & `RUNTIME_EVENT_FIELDS` in `compiler/triggers.ts` with `ObjectFilter` (`multicolored`, `monocolored`, `notColors`, `hasKeywords`, `lacksKeywords`, `hasCounters`, `allTypes`, `attacking`, `blocking`, `anyOf`, `historic`, `excludedSubtypes`, `oneOrMore` on `zoneChange`, `orSelf` on `turnFaceUp`); unify `parseCondition` with `parseStaticCondition` (`Threshold`, `Delirium`, `Descend 4/8`, `Coven`, `Corrupted`, `Ferocious`, `Formidable`, `Pack tactics`, `Void`, `Celebration`, `Adamant`, `hasCitysBlessing`, `maxSpeed`, `objectState`); add `doorUnlocked`/`roomFullyUnlocked` (*Eerie* `CR 709.5h–i`), *Valiant*, *Paradox*, cast-during-opponent-turn, cast-historic/kicked, `transforms`, *Survival*, and `becomesCrewed`/`becomesSaddled` extensions.

2. **Track P14 (`mtg_p14_statics_costs_wave5` — exclusively owns `compiler/statics.ts`, `compiler/costs.ts`, `runtime/staticsAndCostsWave5.ts`; `+650+` cards):**
   - **P14.1 Devotion Type-Removal, Self-Safe Aura Protection, Combat Damage Assignment Overrides, & Compound Conditional Statics:** Theros God Layer 4 `"As long as your devotion to ... is less than N, ~ isn't a creature"` (`CR 700.5`), `"This effect doesn't remove ~"` (`CR 702.16d`), `"assign its combat damage as though it weren't blocked"` (`CR 510.1c–d`), and remaining compound conditional Layer 6/7c statics.
   - **P14.2 Commander Designations, Relentless Deck-Size Overrides, Turn-Slotted Graveyard/Exile Play Statics, & Counter-Gated Untap Locks:** `"~ can be your commander."` (`CR 903.3a`), `"A deck can have any number of cards named ~."`, `"Once during each of your turns, you may play/cast [filter] from your graveyard / exile"` (*Muldrotha*/*Karador*/*Kess*), and counter-gated untap restrictions.
   - **P14.3 `"~ enters prepared"` (`CR 723`), *Phantom* Counter-Prevent Replacements, Source-Color Prevention Statics, `Strive` Per-Target Cost Increase, & Bounce-Land Pitch Alt-Costs.**
   - **P14.4 `Waterbend` (`CR 701.67`), `Behold` (`CR 701.64`), Multi-Counter+Sacrifice Costs, `-1/-1` Self-Counter Costs, Grandeur Discard-Same-Name, Discard-Hand, Put-Hand-Card-on-Library-Top, Tap-Enchanted, & Disjunctive `{A} or {B}:` Costs.**

3. **Track P15 (`mtg_p15_frames_battles_keywords_wave5` — exclusively owns `keywords.ts`, `compiler/card.ts`, `compiler/normalize.ts`, `compiler/support.ts`, `runtime/keywords-coverage-guard.test.ts`, `runtime/framesBattlesAndKeywordsWave5.ts`; `+470+` solo cards + `19` false-positive fixes):**
   - **P15.1 Battles & Sieges (`CR 310.1–12`), Rooms (`CR 709.5`), Preparation (`CR 723.1–5`), Omen (`CR 721.1–5`), Planeswalker `±X` Loyalty & `Compleated` (`CR 702.150`), & Activation/Cast Timing/Player Riders:** Full Battle `defense` counters, opponent `protectorId` + `CR 704.5w–x` SBA reassignment, attacking Battles & protector block rules, damage removing defense counters, `0`-defense SBA vs Siege exile-and-cast-transformed trigger (plus gating `Battle — Control Point` in `compiler/support.ts`); `'room'`/`'siege'`/`'battle'`/`'omen'`/`'case'`/`'class'` in `normalize.ts` `SELF_REFERENCE_TYPES`; `'prepare'` layout (`CR 723`) + `cast_preparation_copy`; Omen Face 1 shuffle-into-library on resolution (`CR 721.3d`); `±X` loyalty costs; and `"Activate only during your turn, before attackers are declared"` / `"Any player / Only any opponent may activate this ability"` / `"Activate only if [condition]"`.
   - **P15.2 Commander Partner Variants & Game-State Keywords:** `Choose a Background` (`702.124k`), `Doctor's companion` (`702.124m`), `Friends forever` (`702.124j`), `Partner—[text]` (`702.124f`), `Daybound`/`Nightbound` (`702.145`, `CR 732`), `Start your engines!` & `Max speed` (`702.178–179`), `Ascend` (`702.131`), and `Read ahead` (`702.155`).
   - **P15.3 & P15.4 Remaining Paper `CR 702` Keywords:** `Power-up` (`702.193`), `Gift` (`702.174`), `Splice` (`702.47`), `Cleave` (`702.148` compile-time bracket pre-split), `Craft` (`702.167`), `Reconfigure` (`702.151`), `Job select` (`702.182`), `Freerunning` (`702.173`), `Impending` (`702.176`), `Assist` (`702.132`), `Cipher` (`702.99`), `Increment` (`702.191`), `Provoke` (`702.39`), `Ripple` (`702.60`), `Ravenous` (`702.156`), `Paradigm` (`702.192`), `Amplify` (`702.38`), `Demonstrate` (`702.144`), `Prowl` (`702.76`), `Gravestorm` (`702.69`), `Living metal` (`702.161`) & `More than meets the eye` (`702.162`), `Snow/Legendary landwalk` (`702.14`), case-insensitive `[type]cycling`, `Transfigure` (`702.71`), and `Aura swap` (`702.65`).

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
