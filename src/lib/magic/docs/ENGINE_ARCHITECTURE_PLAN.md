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
