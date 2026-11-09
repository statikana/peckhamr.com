# Rules audit: Additional Rules 708–734 (rules.txt lines 5752–6455)
Audited at engine-rewrite 917180b on 2026-11-09.

## Summary
- Counts: implemented 19, partial 45, missing 204, N/A 46 (total: 314 rules/subrules across CR 708–734).
- Top gaps (most player-visible first):
  1. **CR 715.2–715.4 (Saga cards)** — Sagas never enter with a lore counter (715.3a), never gain a lore counter at the beginning of precombat main phase (715.3c), have their chapter abilities explicitly rejected as unsupported by the compiler (`compiler/adapter.ts:245`), and are never sacrificed as a state-based action after their final chapter resolves (715.4) — **M**.
  2. **CR 712.1–712.16 (Double-faced cards: transform & modal DFCs)** — `compileCard` / `adaptCard` rejects any card with `backFace` as `unsupported('multiface')` (`compiler/adapter.ts:219-229`), `CardInstance.transformed` (`types.ts:365`) is only ever set to `false` and never read by `runtime/layers.ts`, players cannot choose which face of an MDFC to cast or play as a land (712.8b, 712.9), and `normalizeScryfallCard` merges both faces' type lines (`"Sorcery // Land"`) onto `card.typeLine` (`scryfall.ts:211`), causing MDFC spell/land cards to be treated as uncastable lands (`engine.ts:7929`) — **L**.
  3. **CR 726.1–726.5 (The Monarch)** — No `monarchPlayerId` state exists in `GameState`, and neither inherent triggered ability (end-step card draw and combat-damage monarch transfer, 726.2) nor multiplayer succession on player elimination (726.4) is implemented — **S**.
  4. **CR 716.1–716.5 (Adventurer cards)** — `normalizeScryfallCard` concatenates both faces' type lines (`"Creature — ... // Instant — Adventure"`) and oracle texts with `\n//\n` (`scryfall.ts:211-214`), causing `adaptCard` (`compiler/adapter.ts:219`) and `compiledStackItemEffects` (`compiler/effects.ts:1264`) to reject every Adventurer card as `multiface`, with no option to cast the Adventure half or go on an Adventure in exile (716.3, 716.3d) — **M**.
  5. **CR 709.1–709.5 (Split cards & Room cards)** — Split and Room cards have their oracle texts joined with `\n//\n` (`scryfall.ts:214`) and are rejected by `adaptCard` (`compiler/adapter.ts:219`); players cannot choose a half to cast (709.3), and Room unlocked designations (`left half unlocked` / `right half unlocked`) and special action unlock costs (709.5c–e) do not exist — **L**.
  6. **CR 717.1–717.4 (Class cards)** — Permanents have no class `level` designation (717.2b), `[Cost]: Level N` class level bars are not parsed as sorcery-speed level-up activated abilities or level-gated static abilities (717.2a), and non-level abilities on Classes are not separated from level striations — **M**.
  7. **CR 708.1–708.12 (Face-down spells and permanents)** — While `runtime/layers.ts:970-991` models Layer 1 characteristics for `perm.isFaceDown === true`, no production code, keyword (`morph`, `disguise`, `manifest`, `cloak`), or action ever sets `isFaceDown = true` or turns a permanent face up (708.7–708.8), `StackItem` has no `isFaceDown` support (708.4), copying a face-down permanent copies its printed face-up card (`engine.ts:4227, 5135`), and `matchesObjectFilter` checks `card.cmc` instead of `0` for face-down mana value (`runtime/objectFilter.ts:225`) — **M**.
  8. **CR 727.1–727.5 (The Initiative)** — No initiative designation or Undercity dungeon progression exists in `GameState`, and none of the three inherent triggered abilities (upkeep venture, combat-damage transfer, on-take venture) or player-elimination transfer rules are implemented — **M**.
  9. **CR 725.1a, 725.1c, 725.1d, 725.1f (Ending the turn edge cases)** — `endTheTurnImmediately` (`engine.ts:5388-5409`) does not discard pending un-stacked triggers from `runtime/triggers.ts` before starting (725.1a), flushes SBA triggers immediately onto the stack during 725.1c instead of deferring them to cleanup (725.1f), does not expire `'until_end_of_combat'` effects when ending the turn mid-combat (725.1d), and `activePlayerMayEndTurn` (`engine.ts:5103`) fails to set `result.turnEnded = true` in `runtime/effects.ts:950-954` and unconditionally forces bots to end their own turn — **S**.
  10. **CR 719.1–719.5 (Prototype cards)** — `prototype` is only listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:144`) as unimplemented; players cannot choose to cast a Prototype card using its alternative mana cost, color, power, and toughness (719.3) — **M**.
  11. **CR 720.1–720.3 (Case cards)** — No `solved` designation exists on `CardInstance`, `"To solve — [Condition]"` end-step triggers are not compiled (720.3a), and `"Solved — [Ability]"` abilities are not gated on solved status (720.3c) — **M**.
  12. **CR 729.1 (Rad counters)** — `CounterType` (`types.ts:188`) and `PlayerGameState` have no rad counter field, and the precombat main phase radiation mill/life-loss/counter-removal triggered ability is missing — **S**.
  13. **CR 732.1–732.2 (Day and Night)** — `GameState` has no `dayNight` designation, untap step (`engine.ts:5980`) never checks the previous turn's `spellsCastThisTurn` count to transition between day and night (732.2a–b), and `daybound`/`nightbound` are unimplemented (`compiler/adapter.ts:134, 143`) — **M**.
  14. **CR 724.1–724.9 (Controlling another player)** — Apart from `Opposition Agent` library-search interception (`runtime/replace.ts:443`, `engine.ts:5617`), full-turn player control (`Mindslaver`, `Emrakul, the Promised End`, `Worst Fears`) is unimplemented — **L**.

---

## Rule-by-rule

### 708. Face-Down Spells and Permanents

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 708.1 | Some cards allow spells and permanents to be face down | partial | `CardInstance.isFaceDown?: boolean` exists (`types.ts:376`) and is read in `runtime/layers.ts:970`, but no card effect, keyword (`morph`, `disguise`, `manifest`, `cloak`), or action in production code ever sets `isFaceDown = true` (only set directly in unit tests such as `runtime/sba.test.ts:503`, `layers.snapshot.test.ts:618`). |
| 708.2 | Face-down objects have only listed characteristics; those are copiable values | partial | `runtime/layers.ts:970-991` overrides Layer 1 characteristics for `isFaceDown` permanents, but `StackItem` has no `isFaceDown` property (`types.ts:456`), and copy effects (`engine.ts:4227`, `engine.ts:5135`) copy `original.copiableCard ?? original.card` without checking `original.isFaceDown`. |
| 708.2a | Default face-down permanent is a 2/2 creature with no text, name, subtypes, or mana cost | partial | `runtime/layers.ts:970-991` sets `baseTypeLine = 'Creature'`, `supertypes = []`, `types = ['Creature']`, `subtypes = []`, `colors = []`, `basePower = 2`, `baseToughness = 2`, `innateList = []`, and `runtime/layers.ts:712` returns `0` for `manaValue`. However, `runtime/objectFilter.ts:225` and `:274` read `card.cmc` directly without checking `obj.isFaceDown`, and `EvaluatedPermanent` does not blank `card.name` outside the Legend Rule skip at `engine.ts:6686`. |
| 708.2b | A face-down permanent can't be turned face down | missing | No effect or action turns permanents face down in the engine. |
| 708.3 | Objects put onto the battlefield face down turn face down before entering (no ETB triggers/statics) | partial | `runtime/triggers.ts:328` / `runtime/layers.ts:857, 989` skip innate abilities when `perm.isFaceDown` is already `true`, and `engine.ts:3309` (`if (obj.isFaceDown) return;`) skips `noteUnautomatedOnEnter`, but `moveObject` (`runtime/zones.ts:264`) unconditionally resets `obj.isFaceDown = false` on zone change and no effect puts objects onto the battlefield face down. |
| 708.4 | Objects cast face down turn face down before going on stack | missing | Casting face down (`morph`, `disguise`, etc.) is not implemented; `StackItem` (`types.ts:456`) has no `isFaceDown` field. |
| 708.5 | Controller may look at own face-down spells/permanents at any time; others cannot | missing | `sanitizeGameStateForViewer` (`engine.ts:8340`) does not redact `card` identity on `isFaceDown` permanents on the battlefield for opponents, and `ArenaTable.svelte` has no face-down battlefield rendering. |
| 708.6 | Differentiating multiple face-down spells/permanents (order, timestamps, attackers) | implemented | Every `CardInstance` has a unique `instanceId` and `enteredTimestamp` (`types.ts:352, 369`). |
| 708.7 | Controller may turn face-down permanent face up via ability/rules; spells normally can't | missing | No special action or effect turns a face-down permanent face up. |
| 708.8 | Turning face up restores normal copiable values; continuous effects remain; ETB abilities don't trigger | partial | If `perm.isFaceDown` is toggled from `true` to `false` on an existing battlefield permanent, `runtime/layerCache.ts:76, 105` invalidates the layer cache and `runtime/layers.ts:970` restores `baseCard` characteristics while keeping existing continuous effects and without re-emitting `ZoneChange`; however, no action or effect performs the turn-face-up transition. |
| 708.9 | Reveal face-down permanent/spell when leaving battlefield/stack, when player leaves game, or at end of game | missing | No reveal log or visibility hook exists for `isFaceDown` objects leaving the battlefield or at game end (`runtime/zones.ts:264` simply sets `obj.isFaceDown = false`). |
| 708.10 | Face-down permanent becoming a copy of another permanent keeps face-down characteristics until turned face up | implemented | `runtime/layerCache.ts:139` sets `entry.card = perm.copiableCard ?? perm.card`, and `runtime/layers.ts:970-991` applies `isFaceDown` overrides on top of `entry.card`; if `isFaceDown` later becomes `false`, `entry.card` evaluates `perm.copiableCard`. |
| 708.11 | "As [this permanent] is turned face up..." replacement abilities apply while turning face up | missing | Neither turning face up nor `"As this permanent is turned face up"` replacement effects (`runtime/replace.ts`) are implemented. |
| 708.12 | Revealing a face-down permanent for information uses its printed/unmodified characteristics | missing | No effect instructs revealing a face-down permanent or queries its unmodified characteristics. |

### 709. Split Cards

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 709.1 | Split cards have two faces on one card with normal Magic card back | partial | `normalizeScryfallCard` (`scryfall.ts:166-232`) normalizes `raw.card_faces` into `card` (front face name, combined `raw.type_line`, combined `raw.mana_cost`, oracle text joined by `\n//\n`) plus `card.backFace` (`faces[1]`). |
| 709.2 | Each split card is only one card in all zones (draw/discard counts as one) | implemented | A split card is a single `CardInstance` (`types.ts:351`) in hand/library/graveyard/exile. |
| 709.3 | Player chooses which half of a split card to cast before putting onto stack | missing | No choice of split half exists in `cast_spell` (`engine.ts:1440`); `adaptCard` (`compiler/adapter.ts:219`) and `compiledStackItemEffects` (`compiler/effects.ts:1264`) reject any card with `backFace` or `\n//\n` as `multiface`. |
| 709.3a | Only the chosen half is evaluated for casting legality and put onto the stack | missing | `checkSpellCastLegality` (`engine.ts:7920`) and `getSpellCostRequirement` (`engine.ts:619`) evaluate `inst.card.typeLine` and `inst.card.manaCost` for the whole `ScryfallCard`, never a chosen half. |
| 709.3b | On the stack, only the cast half's characteristics exist | missing | `StackItem` (`types.ts:456`) stores the entire `ScryfallCard` without tracking which half was cast. |
| 709.3c | Copy of a split card retains both halves and allows choosing a half when cast | missing | Copying cards outside the battlefield/stack and casting a chosen half of a split card are not implemented. |
| 709.4 | In every zone except the stack, split card characteristics are both halves combined | partial | `normalizeScryfallCard` (`scryfall.ts:185-192`) uses Scryfall's top-level `raw.type_line`, `raw.mana_cost`, `raw.cmc`, and `raw.colors` (which combine both halves on split cards), but sets `card.name` to `front.name` (`scryfall.ts:173`) instead of both names. |
| 709.4a | Split card has two names; choosing a card name chooses one; matches if either name matches | missing | `normalizeScryfallCard` (`scryfall.ts:173`) sets `card.name` to `faces[0].name` only (putting `faces[1].name` in `card.backFace.name`), and card-name choice effects are not implemented. |
| 709.4b | Combined mana cost, colors, and mana value off-stack; individual mana symbols preserved | partial | `normalizeScryfallCard` (`scryfall.ts:190-191`) preserves Scryfall's top-level `raw.mana_cost` (e.g. `{1}{U} // {1}{R}`), `raw.cmc`, and `raw.colors`, which `parseManaCost` / devotion can scan, though on-stack single-half mana value is missing. |
| 709.4c | Split card has each card type and each ability of both halves | partial | `card.typeLine` and `card.oracleText` contain both halves (`scryfall.ts:185-189`), but `buildCharacteristics` (`compiler/adapter.ts:1207`) splits `card.typeLine` on `—` only once (mixing types and `//` into `subtypes` when subtypes exist), and `adaptCard` (`compiler/adapter.ts:219`) bails out with `unsupported('multiface')`. |
| 709.4d | Fused split spell on the stack has combined characteristics of both halves | missing | `fuse` is only in `KNOWN_KEYWORDS` (`compiler/adapter.ts:137`) and is not implemented. |
| 709.5 | Split permanent cards with shared type line (Rooms): locked halves lose name, mana cost, and rules text on battlefield | missing | `Room` is listed in `ENCHANTMENT_SUBTYPES` (`runtime/layers.ts:150`, `runtime/objectFilter.ts:63`), but `adaptCard` rejects all multiface/split cards (`compiler/adapter.ts:219`) and `runtime/layers.ts` has no locked/unlocked half logic. |
| 709.5a | Each half of a shared-type-line split card shares the types and subtypes | missing | Room halves are not modeled in `ir.ts` or `runtime/layers.ts`. |
| 709.5b | Existence of each half of a shared-type-line object is part of copiable values even on stack | missing | Room halves are not modeled. |
| 709.5c | "Left half unlocked" and "right half unlocked" designations on battlefield permanents | missing | `CardInstance` (`types.ts:351`) has no unlocked-half designations. |
| 709.5d | Enters with left/right half unlocked if that half was cast; enters with neither if put onto battlefield without casting | missing | `resolveStackItemNow` (`engine.ts:4196`) and `moveObject` (`runtime/zones.ts:240`) have no Room unlock designation handling. |
| 709.5e | Special action to pay unlock cost of a locked half at sorcery speed | missing | No unlock special action exists in `GameActionPayload` (`types.ts:785`) or `engine.ts`. |
| 709.5f | Effect instructing a player to "unlock" half of a permanent | missing | No `unlock` verb exists in `compiler/effects.ts` or `runtime/effects.ts`. |
| 709.5g | Effect instructing a player to "lock" half of a permanent | missing | No `lock` verb exists in `compiler/effects.ts` or `runtime/effects.ts`. |
| 709.5h | Abilities triggering when a player unlocks a particular half | missing | No unlock trigger event exists in `runtime/events.ts` or `runtime/triggers.ts`. |
| 709.5i | Abilities triggering when a player "fully unlocks" a permanent | missing | No fully-unlocks trigger event exists in `runtime/events.ts` or `runtime/triggers.ts`. |
| 709.5j | A "door" of a Room permanent refers to a half of that permanent | missing | Room doors are not modeled in the compiler or runtime. |

### 710. Flip Cards

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 710.1 | Flip cards have a two-part frame on a single card with normal Magic card back | partial | `normalizeScryfallCard` (`scryfall.ts:166-232`) populates `backFace` from `raw.card_faces[1]` for Scryfall flip cards. |
| 710.1a | Top half contains normal name, text box, type line, P/T, and flip ability | partial | `normalizeScryfallCard` (`scryfall.ts:173, 198-205`) reads `front.name`, `front.power`, `front.toughness`, though `adaptCard` (`compiler/adapter.ts:219`) rejects any card with `backFace` as `unsupported('multiface')`. |
| 710.1b | Bottom half contains alternative name, text box, type line, and P/T used only on battlefield when flipped | missing | No `flipped` state or bottom-half evaluation exists in `types.ts` or `runtime/layers.ts`. |
| 710.1c | Flip card's color and mana cost don't change when flipped; external effects still apply | missing | Flipping a permanent is not implemented. |
| 710.2 | Outside battlefield and before flipping, only normal characteristics apply; once flipped, alternative characteristics apply | missing | While `normalizeScryfallCard` (`scryfall.ts:185`) sets `card.typeLine` to `raw.type_line` (`"Creature — Goblin Shaman // Legendary Creature — Goblin Shaman"`), leaking `Legendary` onto the unflipped card in all zones, flipping on the battlefield is not implemented. |
| 710.3 | Physical clarity of flipped vs. unflipped permanents when tapped/untapped | N/A | Physical card-orientation / table-marking rule. |
| 710.4 | Flipping is one-way; impossible to unflip; retains no memory on leaving battlefield | missing | Flipping is not implemented. |
| 710.5 | Player choosing a card name may choose a flip card's alternative name | missing | Choosing a card name is not implemented. |

### 711. Leveler Cards

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 711.1 | Leveler card has striated text box, three P/T boxes, and two level symbols | missing | Leveler striations and multiple P/T boxes are not parsed in `compiler/`. |
| 711.2 | Level symbol `{LEVEL N1-N2}` or `{LEVEL N3+}` is a keyword representing a static ability | missing | Neither `compiler/adapter.ts` nor `compiler/statics.ts` parses `{LEVEL ...}` symbols, and `'level'` is not in `CounterType` (`types.ts:188-196`). |
| 711.2a | `{LEVEL N1-N2} [Abilities] [P/T]` grants base P/T and abilities while level counters are in `[N1, N2]` | missing | Not parsed in `compiler/statics.ts` and not evaluated in `runtime/layers.ts`. |
| 711.2b | `{LEVEL N3+} [Abilities] [P/T]` grants base P/T and abilities while level counters are `>= N3` | missing | Not parsed in `compiler/statics.ts` and not evaluated in `runtime/layers.ts`. |
| 711.3 | Text box striations only demarcate which abilities and P/T belong to which level symbol | missing | Striation scoping is not implemented in `compiler/adapter.ts` (all lines in `oracleText` are parsed as always-on abilities). |
| 711.4 | Abilities not preceded by a level symbol (including level up) apply at all times | missing | `level up` is only in `KNOWN_KEYWORDS` (`compiler/adapter.ts:141`) as unimplemented. |
| 711.5 | With fewer than `N1` level counters, leveler creature has uppermost P/T | partial | `buildCharacteristics` (`compiler/adapter.ts:1217`) uses the printed top-level `card.power` and `card.toughness` unconditionally, which matches `< N1` only because level tiers are unimplemented. |
| 711.6 | In zones other than battlefield, leveler card has uppermost P/T | implemented | Off-battlefield P/T queries (`runtime/objectFilter.ts:106, 138`) read `card.power` / `card.toughness`, which Scryfall sets to the uppermost P/T box. |
| 711.7 | Class enchantments use class levels, not level counters (cross-reference to CR 717) | implemented | Definitional cross-reference; neither level counters nor class levels interact. |

### 712. Double-Faced Cards

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 712.1 | DFCs have two full Magic card faces and no Magic card back (nonmodal and modal DFCs) | partial | `normalizeScryfallCard` (`scryfall.ts:166-232`) populates `card.backFace` from `raw.card_faces[1]`, and `CardInstance.transformed` exists (`types.ts:365`), but `adaptCard` (`compiler/adapter.ts:219`) marks all cards with `backFace` as `unsupported('multiface')`. |
| 712.2 | Nonmodal DFCs have abilities that transform/convert or cast/enter transformed/converted | missing | No `transform` or `convert` effect verb exists in `ir.ts` (`compiler/effects.ts`), and `runtime/layers.ts` never reads `perm.transformed`. |
| 712.2a | Front-face symbol icons across sets | N/A | Physical card frame / printing iconography rule. |
| 712.2b | Back-face symbol icons across sets | N/A | Physical card frame / printing iconography rule. |
| 712.2c | Gray back-face P/T reminder text on front face has no game effect | N/A | Physical card frame reminder text rule. |
| 712.3 | Modal DFCs have two independent faces (or may also transform/convert) | missing | Modal DFC face selection and compilation are not implemented (`compiler/adapter.ts:219`). |
| 712.3a | Modal DFC front-face triangle icon | N/A | Physical card frame / printing iconography rule. |
| 712.3b | Modal DFC back-face double-triangle icon | N/A | Physical card frame / printing iconography rule. |
| 712.3c | Modal DFC lower-left hint bar is reminder text | N/A | Physical card frame reminder text rule. |
| 712.4 | Players allowed to look at a DFC may look at both sides | partial | `card.backFace` is included on `ScryfallCard` (`types.ts:85`) whenever the `CardInstance` is visible to a player, though `ArenaTable.svelte` has no flip-face inspector toggle on the table. |
| 712.5 | DFCs in hidden zones must be indistinguishable (opaque sleeves / substitute cards) | N/A | Physical card sleeve / substitute card rule (hidden zones are sanitized server-side in `engine.ts:8340`). |
| 712.6 | Each face of a DFC has its own set of characteristics | missing | `normalizeScryfallCard` (`scryfall.ts:185-189`) merges both faces' `type_line` (`raw.type_line`, e.g. `"Creature — Human // Creature — Werewolf"` or `"Sorcery // Land"`) and joins both faces' `oracle_text` with `\n//\n` onto the root `ScryfallCard`, rather than keeping front-face-only characteristics on the front face. |
| 712.6a | Outside battlefield/stack, a DFC has only front-face characteristics | partial | `normalizeScryfallCard` (`scryfall.ts:173, 190, 198`) uses `front.name`, `front.mana_cost`, `front.power`, and `front.toughness`, but uses `raw.type_line` (`"FrontType // BackType"`) and combined `oracleText` (`scryfall.ts:185-189`), so a `Sorcery // Land` MDFC in hand or graveyard is treated as having the `Land` type (`engine.ts:7870, 7929`). |
| 712.6b | Nonmodal DFC spell on stack has front-face characteristics unless cast transformed/converted (back face, front mana value) | missing | Casting transformed/converted is not implemented, and `card.typeLine` / `card.oracleText` on the stack mix both faces (`scryfall.ts:185-189`). |
| 712.6c | Double-faced permanent with front face up has only front-face characteristics | partial | `runtime/layers.ts:971` compiles `baseCard` (`faces[0]`), which uses `front.power`/`front.toughness`/`front.manaCost`, but `baseCard.typeLine` is the combined `"Front // Back"` string (`scryfall.ts:185`) and `adaptCard` (`compiler/adapter.ts:219`) suppresses all abilities with `unsupported('multiface')`. |
| 712.6d | Nonmodal DFC permanent with back face up has back-face characteristics and front-face mana value (0 if copy) | missing | `runtime/layers.ts` never checks `inst.transformed` or `baseCard.backFace`. |
| 712.6e | Modal DFC spell on stack or permanent on battlefield has only the characteristics of the face that's up | missing | Neither face selection nor back-face evaluation exists. |
| 712.7 | Only permanents represented by double-faced tokens and double-faced cards can transform or convert | missing | Transform/convert is not implemented. |
| 712.8 | Double-faced spell is cast with front face up by default | partial | Spells are cast using `inst.card`, which uses front-face cost and name (`scryfall.ts:173, 190`), though `adaptCard` marks the card unsupported (`compiler/adapter.ts:219`). |
| 712.8a | DFC cast "transformed" or "converted" goes on stack with back face up | missing | Not implemented (e.g. `More Than Meets the Eye` is unimplemented in `compiler/adapter.ts:142`). |
| 712.8b | Player casting a modal DFC chooses which face to cast before putting onto stack | missing | No face choice exists in `cast_spell` (`engine.ts:1440`). |
| 712.8c | Only the face that will be face up on the stack is evaluated for casting legality | missing | `checkSpellCastLegality` (`engine.ts:7929`) checks `if (inst.card.typeLine.includes('Land') && !inst.card.typeLine.includes('Creature'))`, which rejects casting the front-face `Instant` or `Sorcery` of any spell//land MDFC because `inst.card.typeLine` is `"Instant // Land"`! |
| 712.8d | Front-face ability allowing DFC to be cast transformed/converted is considered when evaluating cast legality | missing | Not implemented. |
| 712.9 | Player playing a modal DFC as a land chooses a land face and it enters with that face up | missing | Playing a `Sorcery // Land` MDFC as a land (`play_land`, `engine.ts:1357`) puts `inst.card` onto the battlefield with its front-face name (`"Agadeem's Awakening"`), front-face image, and `unsupported('multiface')` abilities instead of its back-face land. |
| 712.10 | Resolving DFC permanent spell enters battlefield with the same face up that was on the stack | missing | Back-face spells on the stack are not supported (`engine.ts:4196` always sets `transformed = false`). |
| 712.11 | DFC put onto battlefield from non-stack zone enters with front face up by default | implemented | `moveObject` (`runtime/zones.ts:263`) and `createCardInstance` (`engine.ts:253`) set `transformed = false`. |
| 712.11a | Effect putting DFC onto battlefield transformed/converted puts it with back face up; non-DFC stays in current zone | missing | No effect puts cards onto the battlefield transformed/converted. |
| 712.11b | Instruction to put DFC onto battlefield with instant/sorcery face up leaves it in current zone (or graveyard from stack) | missing | Not implemented. |
| 712.12 | DFC cast or entering face down has face-down characteristics | missing | Face-down casting/entering is not implemented. |
| 712.12a | While face down, a DFC permanent can't transform/convert; turning face up puts front face up | missing | Neither transform nor turning face up is implemented. |
| 712.13 | Double-faced permanents on the battlefield can't be turned face down | missing | Turning permanents face down is not implemented. |
| 712.14 | DFC exiled face down remains hidden | N/A | Physical substitute-card / sleeve rule; face-down exile is not modeled with physical cards. |
| 712.15 | Transforming/converting a DFC permanent doesn't make it a new object; continuous effects continue to apply | missing | Transform/convert is not implemented. |
| 712.16 | Choosing a card name may choose either face of a DFC but not both | missing | Card-name choice effects are not implemented. |

### 713. Meld Cards

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 713.1 | Meld cards have a Magic face on one side and half an oversized face on the other | missing | No meld handling exists anywhere in `src/lib/magic/`. |
| 713.1a | Ability exiles both meld counterparts and puts them onto battlefield combined as one permanent | missing | Not implemented. |
| 713.1b | Back faces of a meld pair only determine characteristics of the melded permanent on battlefield | missing | Not implemented. |
| 713.1c | Meld cards cannot be transformed or converted | missing | Neither meld nor transform is implemented. |
| 713.2 | Seven specific meld pairs | missing | None of the seven meld pairs (713.2a–g) are implemented. |
| 713.2a | Midnight Scavengers + Graf Rats -> Chittering Host | missing | Not implemented. |
| 713.2b | Hanweir Garrison + Hanweir Battlements -> Hanweir, the Writhing Township | missing | Not implemented. |
| 713.2c | Bruna, the Fading Light + Gisela, the Broken Blade -> Brisela, Voice of Nightmares | missing | Not implemented. |
| 713.2d | Phyrexian Dragon Engine + Mishra, Claimed by Gix -> Mishra, Lost to Phyrexia | missing | Not implemented. |
| 713.2e | The Mightstone and Weakstone + Urza, Lord Protector -> Urza, Planeswalker | missing | Not implemented. |
| 713.2f | Argoth, Sanctum of Nature + Titania, Voice of Gaea -> Titania, Gaea Incarnate | missing | Not implemented. |
| 713.2g | Fang, Fearless l'Cie + Vanille, Cheerful l'Cie -> Ragnarok, Divine Deliverance | missing | Not implemented. |
| 713.3 | Players allowed to look at a meld card may look at both sides | partial | Scryfall `card_faces` data is normalized into `card.backFace` (`scryfall.ts:230`), though meld pairs are not linked. |
| 713.4 | Meld cards in hidden zones must be indistinguishable (sleeves / substitute cards) | N/A | Physical card / tournament sleeve rule. |
| 713.5 | Front face of each meld card and combined back face each have their own characteristics | missing | Meld combined faces are not modeled. |
| 713.5a | Outside battlefield, a meld card has only front-face characteristics | partial | Scryfall single-card meld fronts have front-face characteristics on `ScryfallCard`, though abilities are not compiled for melding. |
| 713.5b | On battlefield with front face up, a meld card has only front-face characteristics | partial | Evaluated as a normal single-face card when on the battlefield unmelded. |
| 713.5c | Melded permanent has combined back-face characteristics and sum of front-face mana values (0 if copy) | missing | Not implemented. |
| 713.6 | Melding cards enter battlefield as a single permanent with back faces up | missing | Not implemented. |
| 713.7 | Meld cards on battlefield can't be turned face down; can be cast/enter face down | missing | Neither meld nor turning face down is implemented. |
| 713.8 | Melded permanent leaving battlefield triggers once as one permanent leaving and puts two cards into destination zone | missing | `CardInstance` cannot represent a multi-card permanent (`types.ts:351`). |
| 713.8a | Owner arranges the two cards in any order when put into graveyard or library | missing | Not implemented. |
| 713.8b | Player exiling a melded permanent determines relative timestamp order of the two cards | missing | Not implemented. |
| 713.8c | Effects finding the new object in destination zone find and act on both cards | missing | Not implemented. |
| 713.8d | Replacement effects on leaving battlefield / entering new zone apply to both cards (except commander rule 903.9b–c) | missing | Not implemented. |
| 713.8e | Counts as one object that changed zones, but two cards that changed zones | missing | Not implemented. |
| 713.9 | Choosing a card name may choose the combined back-face name | missing | Card-name choice is not implemented. |

### 714. Substitute Cards

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 714.1 | Substitute card is a physical game supplement with a normal Magic back | N/A | Physical paper supplement rule (digital engine uses `CardInstance` objects). |
| 714.2 | Substitute card must clearly indicate at least the front-face name | N/A | Physical paper supplement rule. |
| 714.2a | 2011–2018 checklist-style substitute cards | N/A | Physical paper supplement rule. |
| 714.2b | Core Set 2019 Nicol Bolas, the Ravager substitute card | N/A | Physical paper supplement rule. |
| 714.2c | Zendikar Rising+ write-in substitute cards | N/A | Physical paper supplement rule. |
| 714.3 | Actual DFC/meld card is set aside prior to game and must remain available | N/A | Physical paper supplement rule. |
| 714.4 | Substitute card is considered the card it represents for all game purposes | N/A | Physical paper supplement rule. |
| 714.5 | In a public zone, set aside the substitute card and use the actual card | N/A | Physical paper supplement rule. |

### 715. Saga Cards

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 715.1 | Saga card has striated text box with chapter symbols | partial | `'Saga'` is recognized in `ENCHANTMENT_SUBTYPES` (`runtime/layers.ts:147`, `runtime/objectFilter.ts:54`) and `SELF_NOUN_RE` (`compiler/normalize.ts:35`), and `'lore'` is in `CounterType` (`types.ts:195`), but chapter striations are not compiled. |
| 715.1a | Saga creatures have P/T box and independent abilities below the type line | missing | `compiler/adapter.ts:245` rejects chapter lines (`"I — ..."`, `"I, II — ..."`) as `triggerUnrecognised`, and Saga mechanics are missing. |
| 715.2 | Chapter symbol is a keyword ability representing a triggered chapter ability | missing | `compiler/adapter.ts:245-249` explicitly marks Saga chapter lines (`^(?:[IVX]+(?:\s*,\s*[IVX]+)*)\s*—\s*(.+)$`) as `unsupported('triggerUnrecognised')`. |
| 715.2a | Roman numerals `I`, `II`, `III`, ... represent chapter numbers 1, 2, 3, ... | missing | Not parsed into chapter numbers (`compiler/adapter.ts:246`). |
| 715.2b | `{rN}—[Effect]` triggers when one or more lore counters are put on Saga and count crosses from `< N` to `>= N` | missing | `runtime/triggers.ts` has no chapter threshold crossing check on `CounterPlaced` (`lore`). |
| 715.2c | `{rN1}, {rN2}—[Effect]` means separate `{rN1}—[Effect]` and `{rN2}—[Effect]` abilities | missing | Not compiled (`compiler/adapter.ts:246`). |
| 715.2d | Final chapter number is greatest value among chapter abilities it has (0 if none) | missing | No final chapter number computation exists in `compiler/` or `runtime/`. |
| 715.2e | Final chapter ability is the chapter ability with the final chapter number | missing | Not implemented. |
| 715.3 | Sagas use lore counters to track progress | partial | `CounterType` includes `'lore'` (`types.ts:195`), initialized to `0` (`runtime/zones.ts:102`) and supported by proliferate (`engine.ts:5806`) and manual counter UI (`ArenaTable.svelte:302`), but Sagas never automatically receive or trigger from lore counters. |
| 715.3a | Each Saga without read ahead enters with a lore counter (intrinsic replacement effect) | missing | `moveObject` (`runtime/zones.ts:272-310`) handles Planeswalker starting loyalty, Battle defense, and `etbCounters` replacement effects, but has no intrinsic rule putting a `lore` counter on an entering `Saga`. |
| 715.3b | Each Saga with read ahead chooses `[1..finalChapter]` as it enters and enters with that many lore counters | missing | `read ahead` is only in `KNOWN_KEYWORDS` (`compiler/adapter.ts:145`) as unimplemented. |
| 715.3c | As precombat main phase begins, active player puts a lore counter on each Saga they control with `>= 1` chapter abilities (turn-based action) | missing | `beginPhase(state, 'main1', activePlayer)` (`engine.ts:3250-3279`, `5902-5910`) performs no Saga lore-counter turn-based action. |
| 715.4 | SBA: Saga with `lore >= finalChapterNumber` (`>= 1` chapter abilities) and no chapter ability on stack is sacrificed | missing | `checkStateBasedActions` (`engine.ts:6538-7005`) has no Saga sacrifice SBA check. |

### 716. Adventurer Cards

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 716.1 | Adventurer cards have a two-part frame with an inset Adventure frame on the left | partial | `'Adventure'` is in `SPELL_SUBTYPES` (`runtime/layers.ts:158`, `runtime/objectFilter.ts:66`), and `normalizeScryfallCard` (`scryfall.ts:166-232`) puts `raw.card_faces[1]` into `card.backFace`. |
| 716.2 | Inset frame defines alternative characteristics while on the stack as an Adventure | missing | `normalizeScryfallCard` (`scryfall.ts:185-189`) concatenates both faces' type lines and joins both faces' oracle texts with `\n//\n`, causing `adaptCard` (`compiler/adapter.ts:219`) and `compiledStackItemEffects` (`compiler/effects.ts:1264`) to reject all Adventurer cards as `multiface`. |
| 716.2a | "Has an Adventure" refers to an object with Adventure alternative characteristics in any zone | missing | No object filter or condition checks for Adventure alternative characteristics (`runtime/objectFilter.ts`). |
| 716.2b | Adventure alternative characteristics are part of copiable values | missing | Not modeled in `Characteristics` (`ir.ts`). |
| 716.2c | Each adventurer card is only one card (draw/discard counts as one) | implemented | Represented as a single `CardInstance` (`types.ts:351`). |
| 716.3 | Player chooses whether to play an adventurer card normally or as an Adventure | missing | No cast-mode choice for Adventure exists in `cast_spell` (`engine.ts:1440`). |
| 716.3a | Casting as an Adventure evaluates only the alternative characteristics | missing | Not implemented. |
| 716.3b | While on the stack as an Adventure, the spell has only its alternative characteristics | missing | Not implemented. |
| 716.3c | Copy of an Adventure spell is also an Adventure with the alternative characteristics | missing | Not implemented. |
| 716.3d | Resolving Adventure spell is exiled instead of going to graveyard; controller may play it from exile (not as an Adventure) | missing | `resolveStackItemNow` (`engine.ts:4180`) sees `tLine.includes('Creature')` on the combined type line (`"Creature — ... // Instant — Adventure"`) and puts the card directly onto the battlefield as a creature even if the player intended the Adventure half; no exile-on-adventure replacement exists. |
| 716.4 | In every zone except the stack (as an Adventure), an adventurer card has only its normal characteristics | partial | `normalizeScryfallCard` (`scryfall.ts:173, 190, 198`) uses the creature face's `name`, `manaCost`, `power`, and `toughness`, but pollutes `card.typeLine` (`"Creature — ... // Instant — Adventure"`) and `card.oracleText` (`...\n//\n...`) with the Adventure half in all zones (`scryfall.ts:185-189`), so an Adventurer card in a graveyard erroneously matches `Instant`/`Sorcery` type checks! |
| 716.5 | Choosing a card name may choose an adventurer card's alternative name | missing | Card-name choice is not implemented. |

### 717. Class Cards

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 717.1 | Class card has striated text box containing two class level bars | partial | `'class'` is in `SELF_NOUN_RE` (`compiler/normalize.ts:35`), but `Class` is not even listed in `ENCHANTMENT_SUBTYPES` (`runtime/layers.ts:141-152`, `runtime/objectFilter.ts:49-65`) and class level bars are not parsed. |
| 717.2 | Class level bar represents both an activated ability and a static ability | missing | Neither `compiler/adapter.ts` nor `compiler/statics.ts` parses `[Cost]: Level N` bars. |
| 717.2a | `[Cost]: Level N — [Abilities]` means sorcery-speed activation from level `N-1` to `N` and static grant at level `>= N` | missing | Not parsed or enforced in `compiler/` or `runtime/layers.ts`. |
| 717.2b | Level is a non-copiable designation any permanent can have, retained even if it stops being a Class | missing | `CardInstance` (`types.ts:351`) has no `classLevel` or `level` field. |
| 717.2c | "To gain a Class level" means activating a class level bar ability | missing | No event or trigger exists for gaining a Class level (`runtime/events.ts`, `compiler/triggers.ts`). |
| 717.2d | A permanent without a level designation is treated as level 1 | missing | Permanent levels are not modeled. |
| 717.3 | Top text box section abilities of a Class apply at all times | partial | `adaptCard` (`compiler/adapter.ts:234`) parses the top ability paragraphs as normal abilities, though it also attempts to parse the level-2 and level-3 paragraphs without gating them on class level! |
| 717.4 | Leveler cards' level counters do not interact with Class cards' class levels | implemented | Definitional cross-reference; neither level counters nor class levels interact. |

### 718. Attraction Cards

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 718.1 | Attraction is an artifact subtype on nontraditional Astrotorium-backed cards with lit-up numbers | partial | `'Attraction'` is in `ARTIFACT_SUBTYPES` (`runtime/layers.ts:145`, `runtime/objectFilter.ts:44`), and `'visit'` is in `KNOWN_KEYWORDS` (`compiler/adapter.ts:149`), but Attraction decks and lit-up numbers are not implemented. |
| 718.2 | Supplementary Attraction deck in the command zone (shuffled before game begins) | missing | No supplementary Attraction deck exists in `PlayerGameState` (`types.ts:740`) or `MagicDeck` (`types.ts:100`). |
| 718.2a | Constructed Attraction deck rules (at least 10 singleton Attractions) | missing | Not checked in `scryfall.ts`. |
| 718.2b | Limited Attraction deck rules (at least 3 Attractions) | N/A | Limited format deck-construction rule (engine is Commander-only). |
| 718.3 | Effects cause an Attraction to enter the battlefield from the command zone ("Open an Attraction") | missing | `open an attraction` is not implemented in `compiler/effects.ts` or `runtime/effects.ts`. |
| 718.4 | Precombat main phase turn-based action: roll to visit your Attractions | missing | Not implemented in `beginPhase(state, 'main1', ...)` (`engine.ts:3250, 5902`). |
| 718.5 | "Visit —" triggered ability triggers when roll to visit matches a lit-up number | missing | `visit` is in `KNOWN_KEYWORDS` (`compiler/adapter.ts:149`) as unimplemented. |
| 718.6 | Replacement effect: Astrotorium-backed card going to zone other than battlefield/exile/command goes to command zone ("junkyard") | missing | Not implemented in `runtime/zones.ts` or `runtime/replace.ts`. |
| 718.6a | Junkyard is a single face-up pile in the command zone | missing | Not implemented. |

### 719. Prototype Cards

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 719.1 | Prototype cards have an inset frame with the prototype keyword and alternative mana cost, P/T | missing | `prototype` is in `KNOWN_KEYWORDS` (`compiler/adapter.ts:144`) as unimplemented (`unsupported('keyword')`); Scryfall's prototype line (`Prototype {1}{W} — 2/2`) is not parsed into alternative characteristics. |
| 719.2 | Inset mana cost, power, and toughness are alternative characteristics as a spell or permanent | missing | `Characteristics` (`ir.ts:17`) has no prototype alternative characteristics. |
| 719.2a | Prototype alternative characteristics are part of copiable values | missing | Not modeled. |
| 719.3 | Player chooses whether to cast a prototype card normally or as a prototyped spell | missing | `castMode` (`types.ts:468`) only supports `'normal' | 'overload'`. |
| 719.3a | Casting a prototyped spell evaluates only its alternative P/T and mana cost | missing | Not implemented. |
| 719.3b | Prototyped spell and permanent have alternative P/T, mana cost, and derived color(s) | missing | Not implemented. |
| 719.3c | Copy of a prototyped spell is also a prototyped spell with alternative characteristics | missing | Not implemented. |
| 719.3d | Copy of a prototyped permanent has the alternative P/T, mana cost, and color characteristics | missing | Not implemented. |
| 719.4 | Outside stack/battlefield (or when not cast prototyped), prototype card has only normal characteristics | implemented | Since prototype casting is not supported, prototype cards always use their normal `card.manaCost`, `card.power`, `card.toughness`, and `card.colors`. |
| 719.5 | Characteristics other than P/T, mana cost, and color remain the same when prototyped | N/A | Dependent on 719.3 (prototype casting is not implemented). |

### 720. Case Cards

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 720.1 | Case card illustration and bottom type line layout | N/A | Physical card frame layout rule (`'case'` is in `SELF_NOUN_RE` at `compiler/normalize.ts:35`, though `'Case'` is missing from `ENCHANTMENT_SUBTYPES` in `runtime/layers.ts:141-152`). |
| 720.2 | The Case frame has no additional rules meaning | implemented | Definitional rule; no special frame rules are applied unless ability text specifies them. |
| 720.3 | Case cards have `"To solve —"` and `"Solved —"` keyword abilities | missing | Neither `"To solve —"` nor `"Solved —"` is recognized in `compiler/adapter.ts`, `compiler/triggers.ts`, or `compiler/statics.ts`. |
| 720.3a | `"To solve — [Condition]"` means `"At the beginning of your end step, if [condition] and this Case is not solved, this Case becomes solved"` | missing | Not compiled in `compiler/triggers.ts` and no `solve` effect exists in `runtime/effects.ts`. |
| 720.3b | `Solved` is a non-copiable designation a permanent retains until it leaves the battlefield | missing | `CardInstance` (`types.ts:351`) has no `solved` designation. |
| 720.3c | `"Solved — [Ability text]"` functions only while the Case has the solved designation | missing | Not gated on solved status in `compiler/adapter.ts` or `runtime/layers.ts` / `runtime/triggers.ts`. |

### 721. Omen Cards

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 721.1 | Omen cards have a two-part frame with an inset Omen frame on the left | missing | `'Omen'` is not in `SPELL_SUBTYPES` (`runtime/layers.ts:154-160`, `runtime/objectFilter.ts:66`), and `normalizeScryfallCard` (`scryfall.ts:185-189`) merges `card_faces` with `\n//\n`, causing `adaptCard` (`compiler/adapter.ts:219`) to reject Omen cards as `multiface`. |
| 721.2 | Inset frame defines alternative characteristics while on the stack as an Omen | missing | Not modeled in `ir.ts` or `types.ts`. |
| 721.2a | "Has an Omen" refers to an object with Omen alternative characteristics in any zone | missing | Not implemented. |
| 721.2b | Omen alternative characteristics are part of copiable values | missing | Not implemented. |
| 721.2c | Each omen card is only one card (draw/discard counts as one) | implemented | Represented as a single `CardInstance` (`types.ts:351`). |
| 721.3 | Player chooses whether to cast an omen card normally or as an Omen | missing | No Omen cast mode exists in `cast_spell` (`engine.ts:1440`). |
| 721.3a | Casting as an Omen evaluates only the alternative characteristics | missing | Not implemented. |
| 721.3b | While on the stack as an Omen, the spell has only its alternative characteristics | missing | Not implemented. |
| 721.3c | Copy of an Omen spell is also an Omen with the alternative characteristics | missing | Not implemented. |
| 721.3d | As an Omen spell resolves, its controller shuffles it into its owner's library instead of graveyard | missing | `resolveStackItemNow` (`engine.ts:4178-4275`) has no Omen shuffle-into-library resolution rule. |
| 721.4 | Outside the stack (or when not cast as an Omen), an omen card has only its normal characteristics | partial | Uses front-face `name`, `manaCost`, `power`, `toughness` (`scryfall.ts:173, 190, 198`), but `card.typeLine` and `card.oracleText` concatenate both faces (`scryfall.ts:185-189`). |
| 721.5 | Choosing a card name may choose an omen card's alternative name | missing | Card-name choice is not implemented. |

### 722. Station Cards

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 722.1 | Station card has striated text box, P/T boxes, station symbols `{N+}`, and station keyword | partial | `'station'` is in `KNOWN_KEYWORDS` (`compiler/adapter.ts:151`) as unimplemented (`unsupported('keyword')`), and `'Spacecraft'` is checked in `scryfall.ts:201`, but station symbols and striations are not compiled. |
| 722.2 | Station symbol `{N+}` represents a static ability | missing | Not parsed in `compiler/adapter.ts` or `compiler/statics.ts`. |
| 722.2a | `{N+}[abilities]` grants `[abilities]` as long as the permanent has `>= N` charge counters | missing | Not parsed in `compiler/statics.ts` or evaluated in `runtime/layers.ts`. |
| 722.2b | `{N+}[abilities][P/T]` grants `[abilities]` and makes it a creature with base P/T `[P/T]` at `>= N` charge counters | missing | Not parsed in `compiler/statics.ts` or evaluated in `runtime/layers.ts`. |
| 722.2c | In any zone other than the battlefield, station cards do not have power or toughness | partial | If Scryfall sets top-level `power`/`toughness` on a Spacecraft/station card, `normalizeScryfallCard` (`scryfall.ts:198`) copies it onto `ScryfallCard` in all zones; if omitted by Scryfall, it is `undefined`. |
| 722.3 | Text box striations only demarcate which abilities and P/T box belong to which station symbol | missing | Striation scoping is not implemented in `compiler/adapter.ts`. |
| 722.4 | Abilities not preceded by a station symbol (including station keyword) apply at all times | partial | Top-level abilities are parsed normally, but the `station` keyword ability itself is unimplemented (`compiler/adapter.ts:151`). |

### 723. Preparation Cards

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 723.1 | Preparation cards have a two-part frame with an inset frame on the right | missing | Preparation cards and prepare spells are not modeled anywhere in `src/lib/magic/`. |
| 723.2 | Inset frame defines alternative characteristics for a spell copy | missing | If Scryfall returns `card_faces` for a preparation card, `normalizeScryfallCard` (`scryfall.ts:185-230`) merges them into `oracleText` with `\n//\n` and `backFace`, causing `adaptCard` (`compiler/adapter.ts:219`) to reject the card as `multiface`. |
| 723.2a | Inset frame is a "prepare spell"; "has a prepare spell" refers to the object in any zone | missing | Not implemented. |
| 723.2b | Prepare spell alternative characteristics are part of copiable values | missing | Not implemented. |
| 723.2c | Each preparation card is only one card (draw/discard counts as one) | implemented | Represented as a single `CardInstance` (`types.ts:351`). |
| 723.3 | Preparation cards can't be cast using the inset characteristics directly; used to create castable copies | missing | Not implemented. |
| 723.3a | Becoming "prepared" or entering prepared gives the "prepared" designation if it has a prepare spell and isn't already prepared | missing | `CardInstance` (`types.ts:351`) has no `prepared` designation. |
| 723.3b | Becoming "unprepared" removes the prepared designation | missing | Not implemented. |
| 723.3c | Gaining prepared or phasing in prepared creates a copy in exile with prepare spell characteristics that may be cast (removing prepared when cast) | missing | Not implemented. |
| 723.3d | Copy of a prepare spell is also a prepare spell | missing | Not implemented. |
| 723.4 | In every zone, a preparation card has only its normal characteristics | partial | Uses front-face `name`, `manaCost`, `power`, `toughness`, but `card.typeLine` and `card.oracleText` concatenate `card_faces` if multi-faced (`scryfall.ts:185-189`). |
| 723.5 | Choosing a card name may choose a preparation card's alternative name | missing | Card-name choice is not implemented. |

### 724. Controlling Another Player

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 724.1 | Controlling another player during that player's next actual turn lasts until the beginning of the following turn | missing | No turn-level player control (`Mindslaver`, `Worst Fears`, `Emrakul, the Promised End`) exists in `GameState` or `PlayerGameState` (`types.ts`). |
| 724.1a | Multiple player-controlling effects on the same player overwrite each other (latest timestamp wins) | partial | Not implemented for full-turn control; implemented for library-search control via timestamp sorting in `getLibrarySearchInterceptor` (`runtime/replace.ts:443-498`). |
| 724.1b | If a turn is skipped, pending player-controlling effects wait until the player actually takes a turn | missing | Full-turn player control is not implemented. |
| 724.2 | Limited-duration player control (`Word of Command` and `Opposition Agent`) | partial | `Opposition Agent` ("You control your opponents while they're searching their libraries") is implemented via `getLibrarySearchInterceptor` (`runtime/replace.ts:443`) and `initiateLibrarySearch` (`engine.ts:5617`); `Word of Command` is not implemented. |
| 724.3 | Only control of the player changes; objects keep their normal controllers; controlled player is still active player | partial | True during `Opposition Agent` search interception (`engine.ts:5617`, where `searchingPlayer` remains the owner/controller of their objects while `decisionPlayer` is the interceptor's controller); full-turn control is missing. |
| 724.4 | Game information visible to controlled player is visible to their controller; outside-the-game cards are not | partial | `sanitizeGameStateForViewer` (`engine.ts:8373-8383`) exposes `searchingPlayer.library` to the `Opposition Agent` controller while `search_library` prompt is active; full-turn hand/face-down visibility is missing. |
| 724.5 | Controller of another player makes all game choices and decisions for that player | partial | During `Opposition Agent` search (`engine.ts:5621`), `decisionPlayer` receives the `search_library` prompt and chooses the found card(s) or fail-to-find; full-turn decisions are missing. |
| 724.5a | Controller can use only the controlled player's resources to pay costs for that player | missing | Full-turn control / cost payment on behalf of a controlled player is not implemented. |
| 724.5b | Controller can't make non-game or tournament decisions for the controlled player | N/A | Out-of-game / tournament policy rule. |
| 724.6 | Controller can't make the controlled player concede; controlled player may still concede at any time | implemented | `concede` (`engine.ts:1161`) always acts on `actorId` (the seated player who sent the action) and is checked before any prompt or priority check. |
| 724.7 | Player-controlling effect may restrict or specify actions the controlled player takes | missing | `Word of Command` action restrictions are not implemented. |
| 724.8 | Player controlling another player continues to make their own choices and decisions | partial | True for `Opposition Agent` controller (`engine.ts:5621`); full-turn control is missing. |
| 724.9 | Effect giving a player control of themselves lets them make their own decisions as normal | missing | Self-control effects (e.g. `Aegis of Honor` / `Story Circle` style or `Mindslaver` on self) are not implemented. |

### 725. Ending Turns and Phases

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 725.1 | When an effect ends the turn, follow steps 725.1a–f in order | partial | Implemented in `endTheTurnImmediately` (`engine.ts:5388-5409`) and wired to IR verb `'endTurn'` (`runtime/effects.ts:949-957`, `compiler/effects.ts:785, 817`), with several subrule discrepancies below. |
| 725.1a | Triggered abilities that triggered before this process began but haven't been put on stack cease to exist | missing | `endTheTurnImmediately` (`engine.ts:5388`) does not clear `channel(state).pending` in `runtime/triggers.ts` before starting; any triggers queued earlier during the resolving spell/ability survive and are flushed onto the stack when `checkStateBasedActions` calls `flushTriggers(state)` at `engine.ts:7001`. |
| 725.1b | Exile every object on the stack, including the resolving object; non-card objects cease to exist at next SBA check | partial | `endTheTurnImmediately` (`engine.ts:5390-5393`) pops every item from `state.stack` and calls `moveStackSpellToZone(state, stk, 'exile')` (which exiles non-copy spell cards and drops abilities/copies). However, for `"the player whose turn it is may end the turn"` (`activePlayerMayEndTurn`, `engine.ts:5103`), `runtime/effects.ts:950-954` does not set `this.result.turnEnded = true` and does not pause resolution for the `end_turn` prompt, so `resolveStackItemNow` (`engine.ts:4175`) removes the resolving ability/spell normally before or after `endTheTurnImmediately`. |
| 725.1c | Check state-based actions; no player gets priority and no triggered abilities are put onto the stack | partial | `endTheTurnImmediately` calls `checkStateBasedActions(state)` (`engine.ts:5407`), but `checkStateBasedActions` unconditionally calls `flushTriggers(state)` at the end of its loop (`engine.ts:7001`), putting triggered abilities onto the stack prematurely during 725.1c instead of waiting until the cleanup step (725.1f). |
| 725.1d | Current phase/step ends; remove all creatures/planeswalkers from combat; skip straight to cleanup step (or start a new cleanup step if already in cleanup) | partial | `endTheTurnImmediately` (`engine.ts:5395-5408`) clears `state.combat.active`, `attackers`, and `declaredBlockersPlayerIds` and calls `runCleanupStep(state)`. However, it does not expire `'until_end_of_combat'` temporary effects or reset `damageDealtFirstStrike` / `damageDealtNormal` / `blockersDeclared` until `completeTurnCleanupAndPassTurn` (`engine.ts:6501`). |
| 725.1e | "At the beginning of the end step" triggered abilities don't trigger because the end step is skipped | implemented | `endTheTurnImmediately` (`engine.ts:5408`) calls `runCleanupStep(state)` directly, bypassing `enterEndStep` (`engine.ts:5417`). |
| 725.1f | Triggers from this process go on stack during cleanup step, granting priority and followed by another cleanup step; otherwise no priority in cleanup | partial | `completeTurnCleanupAndPassTurn` (`engine.ts:6430-6437`) flushes triggers and, if `state.stack.length > 0 || state.pendingPrompts.length > 0`, leaves `state.phase = 'cleanup'` and gives `activePlayer` priority, after which `advancePhase` (`engine.ts:5973`) runs another `runCleanupStep(state)`. However, if a human active player has `hand.length > maxHand` (`engine.ts:6395`), `beginPhase(state, 'cleanup', activePlayer)` runs `clearEndOfTurnAndDamage(state)` (`engine.ts:3264`) BEFORE the player discards to hand size. |
| 725.2 | Ending the combat phase (`Mandate of Peace`) follows steps 725.2a–g | missing | No `'endCombat'` effect verb or combat-ending function exists in `compiler/`, `runtime/`, or `engine.ts`. |
| 725.2a | Pending un-stacked triggers cease to exist when combat phase is ended by an effect | missing | Not implemented. |
| 725.2b | Exile every object on the stack, including the resolving object | missing | Not implemented. |
| 725.2c | Check state-based actions without priority or putting triggers on stack | missing | Not implemented. |
| 725.2d | Combat phase ends; remove all creatures/planeswalkers from combat; expire "until end of combat" effects; skip to next phase (usually postcombat main) | missing | Not implemented. |
| 725.2e | "At end of combat" abilities don't trigger because end of combat step is skipped | missing | Not implemented. |
| 725.2f | Triggers during the process are put on stack in the following phase | missing | Not implemented. |
| 725.2g | If an effect attempts to end the combat phase outside a combat phase, nothing happens | missing | Not implemented. |

### 726. The Monarch

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 726.1 | The monarch is a player designation; no monarch until an effect instructs a player to become the monarch | missing | No `monarch` field exists on `GameState` or `PlayerGameState` (`types.ts`), and `"you become the monarch"` is not parsed in `compiler/effects.ts`. |
| 726.2 | Two inherent triggered abilities: monarch's end-step draw and combat-damage monarch transfer | missing | Neither inherent trigger is implemented in `engine.ts` or `runtime/triggers.ts`. |
| 726.3 | Only one player can be the monarch at a time | missing | Not implemented. |
| 726.4 | If the monarch leaves the game, the active player (or next player in turn order) becomes the monarch | missing | `cleanupEliminatedPlayer` (`engine.ts:7035`) has no monarch transfer logic. |
| 726.5 | Continuous effects based on who is the monarch do nothing while there is no monarch | missing | No monarch conditions or filters exist in `compiler/statics.ts` or `runtime/layers.ts`. |

### 727. The Initiative

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 727.1 | The initiative is a player designation; no initiative until an effect instructs a player to take the initiative | missing | No `initiative` or dungeon state exists in `types.ts`, `compiler/`, or `runtime/`. |
| 727.2 | Three inherent triggered abilities: upkeep venture into Undercity, combat-damage transfer, and on-take venture into Undercity | missing | Neither the initiative nor `venture into the dungeon` / `Undercity` is implemented. |
| 727.3 | Only one player can have the initiative at a time | missing | Not implemented. |
| 727.4 | If the player with the initiative leaves the game, the active player (or next player in turn order) takes the initiative | missing | `cleanupEliminatedPlayer` (`engine.ts:7035`) has no initiative transfer logic. |
| 727.5 | Taking the initiative while already having it triggers the "whenever a player takes the initiative" ability without creating a second designation | missing | Not implemented. |

### 728. Restarting the Game

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 728.1 | One card (`Karn Liberated`) restarts the game; current game immediately ends with no winner/loser/draw and a new game starts | missing | No game-restart effect exists in `compiler/effects.ts`, `runtime/effects.ts`, or `engine.ts`. |
| 728.1a | Starting player in the new game is the controller of the spell/ability that restarted the game | missing | Not implemented. |
| 728.2 | All Magic cards involved in the restarted game (including phased-out permanents) return to their owners' decks | missing | Not implemented. |
| 728.3 | Players with fewer than 7 cards in library lose during first upkeep SBA check after drawing opening hand | missing | Restarting the game is not implemented (though empty-library draw SBA 704.5b is implemented in `engine.ts:6965`). |
| 728.4 | Effect restarting the game finishes resolving just before the first turn's untap step; triggers wait until upkeep priority | missing | Not implemented. |
| 728.5 | Effects may exempt certain cards from the restart procedure (they are not in their owner's deck as new game begins) | missing | Not implemented. |
| 728.5a | In Commander, a commander exempted from the restart procedure won't begin in the command zone, though it remains that deck's commander | missing | Not implemented. |
| 728.6 | Restarting a Magic subgame leaves the main game unaffected | N/A | `Shahrazad` subgames (CR 730) are banned in Commander and not applicable. |
| 728.7 | In a limited range of influence multiplayer game, restarting involves all players | N/A | Engine does not use the limited range of influence variant (CR 801). |

### 729. Rad Counters

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 729.1 | Rad counters on a player trigger at beginning of precombat main phase: mill N, lose 1 life and remove 1 rad counter per nonland milled | missing | `PlayerGameState` (`types.ts:740`) has `poison`, `experienceCounters`, and `energyCounters`, but no `radCounters`, and `beginPhase(state, 'main1', ...)` (`engine.ts:3250, 5902`) has no radiation trigger. |
| 729.1a | Life loss "from radiation" refers to life lost from the rad counter triggered ability | missing | Not implemented. |

### 730. Subgames

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 730.1 | One card (`Shahrazad`) allows players to play a Magic subgame | N/A | `Shahrazad` is banned in Commander (and all constructed formats); subgames are out of scope for this Commander engine. |
| 730.1a | Definition of subgame and main game | N/A | `Shahrazad` is banned in Commander. |
| 730.1b | Effects/definitions do not cross between main game and subgame | N/A | `Shahrazad` is banned in Commander. |
| 730.2 | Subgame zone creation and moving main-game libraries into subgame libraries | N/A | `Shahrazad` is banned in Commander. |
| 730.2a | Moving supplementary decks into subgame command zone | N/A | `Shahrazad` is banned in Commander. |
| 730.2b | Moving Vanguard cards into subgame command zone | N/A | Vanguard / `Shahrazad` not applicable. |
| 730.2c | Moving commanders from main-game command zone into subgame command zone | N/A | `Shahrazad` is banned in Commander. |
| 730.3 | Drawing 7 cards with `< 7` cards in subgame library causes upkeep SBA loss | N/A | `Shahrazad` is banned in Commander. |
| 730.4 | Objects in main game are outside the subgame | N/A | `Shahrazad` is banned in Commander. |
| 730.4a | Bringing cards from main game into subgame triggers main-game leave-zone triggers when main game resumes | N/A | `Shahrazad` is banned in Commander. |
| 730.4b | Player counters in main game and subgame are kept separate | N/A | `Shahrazad` is banned in Commander. |
| 730.5 | Ending a subgame shuffles subgame cards back into main-game libraries and finishes resolving the subgame effect | N/A | `Shahrazad` is banned in Commander. |
| 730.5a | Returning supplementary decks from subgame to main game | N/A | `Shahrazad` is banned in Commander. |
| 730.5b | Returning Vanguard card from subgame to main game | N/A | Vanguard / `Shahrazad` not applicable. |
| 730.5c | Returning commander from subgame command zone to main-game command zone | N/A | `Shahrazad` is banned in Commander. |
| 730.6 | Subgame within a subgame | N/A | `Shahrazad` is banned in Commander. |

### 731. Merging with Permanents

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 731.1 | Mutate causes an object to merge with a permanent (CR 702.140) | missing | `mutate` is in `KNOWN_KEYWORDS` (`compiler/adapter.ts:142`) as unimplemented (`unsupported('keyword')`); no permanent merging exists in `types.ts` or `engine.ts`. |
| 731.2 | Placing an object on top of or under a permanent creates a multi-component merged permanent | missing | `CardInstance` (`types.ts:351`) represents a single card/token and has no `components` stack. |
| 731.2a | Merged permanent has topmost component's characteristics plus all components' abilities (Layer 1 copiable effect) | missing | Not implemented in `runtime/layers.ts`. |
| 731.2b | Merging object leaves previous zone and becomes part of permanent without entering the battlefield | missing | Not implemented. |
| 731.2c | Merged permanent is the same object (retains control, continuous effects, counters, etc.) | missing | Not implemented. |
| 731.2d | Merged permanent containing a token is a token only if topmost component is a token | missing | Not implemented. |
| 731.2e | Face-up/face-down status of merged permanent is determined by topmost component | missing | Not implemented. |
| 731.2f | Turning a merged permanent face down/up turns all components face down/up | missing | Not implemented. |
| 731.2g | Face-down merged permanent containing an instant/sorcery card can't be turned face up (revealed instead) | missing | Not implemented. |
| 731.2h | Flip-card component in a flipped merged permanent uses its alternative characteristics | missing | Not implemented. |
| 731.2i | Merged permanent is not a DFC; transforming/converting it turns all transformable DFC components | missing | Not implemented. |
| 731.2j | Face-up merged permanent containing a DFC component can't be turned face down | missing | Not implemented. |
| 731.3 | Merged permanent leaving battlefield triggers once as one permanent leaving and puts all components into destination zone | missing | Not implemented. |
| 731.3a | Owner arranges components in any order when put into graveyard or library | missing | Not implemented. |
| 731.3b | Player exiling a merged permanent determines relative timestamp order of the cards | missing | Not implemented. |
| 731.3c | Effects finding the new object in destination zone find and act on all components | missing | Not implemented. |
| 731.3d | Replacement effects on leaving battlefield / entering new zone apply to all components (except commander rule 903.9b–c) | missing | Not implemented. |
| 731.3e | Card-only replacement effects apply to all components if topmost is non-token, or only card components if topmost is token | missing | Not implemented. |

### 732. Day and Night

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 732.1 | Day and night are game designations; starts with neither; once day or night, always one of the two | missing | `GameState` (`types.ts:795`) has no `dayNight` field; `daybound` and `nightbound` are only in `KNOWN_KEYWORDS` (`compiler/adapter.ts:134, 143`) as unimplemented. |
| 732.1a | "Day becomes night" and "night becomes day" mean losing the first designation and gaining the second | missing | Not implemented. |
| 732.2 | Second part of untap step checks previous turn to see if day/night changes | missing | `runBeginningOfTurn` (`engine.ts:5980-6110`) tracks `spellsCastThisTurn` (reset to `0` at line 6034) but never checks it during untap to transition between day and night. |
| 732.2a | If it's day and previous turn's active player cast 0 spells, it becomes night | missing | Not implemented. |
| 732.2b | If it's night and previous turn's active player cast 2+ spells, it becomes day | missing | Not implemented. |
| 732.2c | If it's neither day nor night, no check happens and it remains neither | implemented | Vacuously true (game is always neither day nor night). |

### 733. Taking Shortcuts

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 733.1 | Players use mutually understood shortcuts rather than explicitly identifying every priority pass | partial | The engine provides automated priority-passing shortcuts (`autoPassEmptyStack`, `fullControl`, `stopPhases` in `types.ts:769-771`, `engine.ts:1171-1183`, `ai.ts:191-215`, `ArenaTable.svelte:1872`), though arbitrary multi-action loop proposals (733.2) are not supported. |
| 733.1a | Shortcut rules are largely informal between human players | N/A | Informal human-communication rule. |
| 733.1b | Shortcut rules can repeat deterministic loops N times without performing each iteration manually | missing | Players cannot propose a N-iteration loop shortcut in the UI/engine (`ArenaTable.svelte`, `engine.ts`). |
| 733.1c | Tournament Rules govern shortcuts and loops in sanctioned tournaments | N/A | Tournament policy rule. |
| 733.2 | Procedure for proposing, shortening, and executing a multi-step shortcut | N/A | Informal multi-player verbal shortcut negotiation; in this digital engine, priority passes are automated via `stopPhases` / `fullControl` (`engine.ts:1171-1183`) and each game action is sent explicitly. |
| 733.2a | Proposing a deterministic sequence or loop of legal game choices ending at a priority point | N/A | Verbal shortcut proposal procedure. |
| 733.2b | Other players in turn order may accept or shorten the proposed sequence | N/A | Verbal shortcut proposal procedure. |
| 733.2c | Advancing to the ending point and requiring a different choice if shortened | N/A | Verbal shortcut proposal procedure. |
| 733.3 | Fragmented voluntary loops: active player (or first involved player in turn order) must make a different choice | missing | No repeated-state detection exists for voluntary player-action loops across priority rounds. |
| 733.4 | If a loop contains only mandatory actions, the game is a draw (CR 104.4b / 104.4f) | partial | `checkStateBasedActions` (`engine.ts:6541`) caps SBA fixpoint iterations at `maxIterations = 25` and `flushTriggers` (`runtime/triggers.ts:829`) caps inline trigger flushing at `guard < 1000`, preventing an infinite server hang, but when a mandatory loop hits those caps it silently stops iterating and continues the game instead of declaring a draw (`state.status = 'finished'; state.winnerPlayerId = null`)! |
| 733.5 | No player can be forced to take an action not called for by objects in the loop to break a mandatory loop | implemented | Neither `checkStateBasedActions` (`engine.ts:6538`) nor `flushTriggers` (`runtime/triggers.ts:823`) forces players to activate abilities or cast spells to break a loop. |
| 733.6 | In a loop with "[A] unless [B]", no player is forced to perform [B]; if declined, [A] continues as mandatory | implemented | Optional `"unless"` / `"you may"` choices (`runtime/choices.ts`, `engine.ts:2320`) never force the player to choose the loop-breaking branch. |

### 734. Handling Illegal Actions

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 734.1 | Illegal action or uncompletable action is reversed in full; payments are canceled; no triggers/effects fire; library-moving/shuffling/revealing actions cannot be reversed | implemented | `applyGameActionInner` (`engine.ts:1357-1700`) and `planCosts` (`runtime/costs.ts:496-565`) validate legality, targets (`validateTargetSelection`, `engine.ts:1465`), mana (`simulateOrExecuteAutoTap(..., false)`), and all additional costs BEFORE mutating the game state or paying any cost (`payPlannedCosts`, `engine.ts:1493`). If a cost requires player choices (`cost_choice`, `engine.ts:2348-2390`), `askCostChoice` pauses before any cost is paid or card moved; canceling the prompt (`normalized.cancel`, `engine.ts:2353`) or failing validation returns without having mutated mana, permanents, or zones, and no `emitEvent` / triggers fire. |
| 734.2 | When reversing illegal spells/abilities, the player who had priority retains it and may take another legal action or pass | implemented | Whenever `applyGameAction` returns `{ ok: false, error }` (`engine.ts:1123`) or a `cost_choice` prompt is canceled (`engine.ts:2353`), `state.priorityPlayerIndex` and `state.passedPriorityPlayerIds` remain unchanged, so the player retains priority and may take another action or pass. |

---

## Silently skipped / approximated behaviour

1. **Multiface cards (`backFace` or `\n//\n` in oracle text) silently merge type lines and drop abilities (`scryfall.ts:185-189`, `compiler/adapter.ts:219-229`, `engine.ts:7929`, `engine.ts:4180`)**:
   - `normalizeScryfallCard` (`scryfall.ts:185`) sets `card.typeLine` to Scryfall's top-level `raw.type_line` (`"FrontType // BackType"`) and joins `card_faces` oracle texts with `\n//\n` (`scryfall.ts:188`).
   - As a result, modal double-faced spell/land cards (e.g. `Agadeem's Awakening // Agadeem, the Undercrypt`, `typeLine: "Sorcery // Land"`) fail `checkSpellCastLegality` (`engine.ts:7929`: `if (inst.card.typeLine.includes('Land') && !inst.card.typeLine.includes('Creature')) return { ok: false, error: 'Lands cannot be cast as spells...' }`) and cannot be cast as spells at all! Conversely, when played as a land via `play_land` (`engine.ts:7870`), they enter the battlefield under their front-face Sorcery name with no mana ability because `adaptCard` (`compiler/adapter.ts:219`) replaces all abilities on any card with `card.backFace || card.oracleText.includes('\n//\n')` with a single `unsupported('multiface')` marker.
   - Similarly, Adventurer cards (`"Creature — ... // Instant — Adventure"`) and Omen cards have both types in `card.typeLine` in all zones, cannot be cast for their Adventure/Omen half, and if resolved as a spell (`engine.ts:4180`), always enter the battlefield as a permanent because `tLine.includes('Creature')` is true.
   - For bots (`engine.ts:3948-3952`), when an unautomated multiface spell or ability resolves, if `item.parsedEffects.length === 0` it logs `"(bot) skipped unsupported ability ..."` and does nothing; if `item.parsedEffects.length > 0`, the legacy parser runs effects scraped from **both** faces/halves combined (`scryfall.ts:188`).

2. **Class and Leveler cards execute higher-level abilities at level 1 (`compiler/adapter.ts:234-260`)**:
   - Because `compiler/adapter.ts` does not recognize `[Cost]: Level N — [Abilities]` striations (CR 717.2a) or `{LEVEL N1-N2}` symbols (CR 711.2a), any paragraph inside a Class or Leveler text box that happens to match a static, triggered, or activated ability grammar is compiled as an unconditional ability active immediately at level 1, while the level-up header line itself is marked `unsupported`.

3. **Sagas enter with 0 lore counters, never advance on `main1`, and are never sacrificed (`runtime/zones.ts:272`, `engine.ts:5902`, `engine.ts:6538`, `compiler/adapter.ts:245`)**:
   - A Saga cast onto the battlefield simply sits on the battlefield indefinitely as an inert enchantment with 0 lore counters unless the player manually adds lore counters and manually resolves its chapters via guided resolution.

4. **"The player whose turn it is may end the turn" (`Obeka, Brute Chronologist`) forces bots to end their turn and doesn't halt `resolveStackItemNow` (`engine.ts:5103-5124`, `runtime/effects.ts:950-954`)**:
   - In `activePlayerMayEndTurn` (`engine.ts:5105`), `if (activePlayer.playerId === controller.playerId || activePlayer.isBot)` immediately calls `endTheTurnImmediately(state, activePlayer.playerId)` without asking a bot active player whether it actually wants to end its own turn (even if an opponent activated Obeka during the bot's turn!).
   - In `runtime/effects.ts:950-954`, the `activePlayerMay` branch calls `p.activePlayerMayEndTurn(s, you)` and returns **without** setting `this.result.turnEnded = true`, so `resolveStackItemNow` (`engine.ts:4024, 4175`) continues running post-resolution cleanup even when `endTheTurnImmediately` already exiled the stack and ran the cleanup step.

5. **`endTheTurnImmediately` flushes pre-existing and SBA triggers prematurely (`engine.ts:5388-5409`, `engine.ts:7001`)**:
   - `endTheTurnImmediately` does not clear pending un-stacked triggers in `runtime/triggers.ts` before starting (violating CR 725.1a), and its call to `checkStateBasedActions(state)` at `engine.ts:5407` flushes triggers onto the stack immediately (violating CR 725.1c) before `runCleanupStep(state)` begins.

6. **Mandatory infinite loops silently terminate and continue the game instead of ending in a draw (`engine.ts:6541`, `runtime/triggers.ts:829`)**:
   - Per CR 733.4 / 104.4b, a loop of mandatory actions must end the game in a draw. Instead, `checkStateBasedActions` stops after `maxIterations = 25` (`engine.ts:6541`) and `flushTriggers` stops after `guard < 1000` (`runtime/triggers.ts:829`), leaving the game active in whatever partial state was reached when the iteration cap was hit.

7. **Face-down permanents copied or filtered by mana value leak printed characteristics (`engine.ts:4227`, `engine.ts:5135`, `runtime/objectFilter.ts:225, 274`)**:
   - Copying a face-down permanent (`engine.ts:4227, 5135`) copies `original.copiableCard ?? original.card` without checking `original.isFaceDown`, producing a face-up copy of the printed card instead of a 2/2 nameless creature (CR 708.2a).
   - `matchesObjectFilter` (`runtime/objectFilter.ts:225, 274`) checks `card.cmc` directly instead of `obj.isFaceDown ? 0 : card.cmc`.
   - `sanitizeGameStateForViewer` (`engine.ts:8340`) sends full `card` data for `isFaceDown` battlefield permanents to all players (CR 708.5).

---

## Legacy-only findings (verify after step F)

1. **`end_the_turn` and `may_end_the_turn` in `executeParsedEffect` (`engine.ts:4034-4037`, `engine.ts:4318-4326`, `oracle.ts`, `types.ts:310-311`)**:
   - Both the new IR interpreter (`runtime/effects.ts:949-957`, compiled by `compiler/effects.ts:785, 817`) and the legacy `executeParsedEffect` path (`engine.ts:4034, 4318`) call `endTheTurnImmediately` and `activePlayerMayEndTurn`. Deleting `executeParsedEffect` in step F will preserve `endTurn` via the IR interpreter, though the `this.result.turnEnded = true` bug on `activePlayerMay` in `runtime/effects.ts:950-954` will remain until fixed there.
2. **Legacy `parseOracleText` / `executeParsedEffect` on multiface/split cards (`engine.ts:3942-3954`, `oracle.ts`)**:
   - Currently, while `compiledStackItemEffects` returns `null` for any card with `backFace` or `\n//\n` (`compiler/effects.ts:1264`), a bot resolving such a card falls back to `item.parsedEffects` produced by legacy `oracle.ts` across the concatenated oracle text (`engine.ts:3942-3954`), or a human can click "Use engine approximation" (`item.manualResolution = 'legacy'`, `engine.ts:3936`). Once step F removes `oracle.ts` and `executeParsedEffect`, all multiface/split/adventure/omen cards will strictly require manual resolution for humans and will be skipped by bots until multiface IR support is added.
3. **`Saga` subtype recognition in `oracle.ts:1723`**:
   - Also present in `runtime/layers.ts:147` and `runtime/objectFilter.ts:54`, so subtype recognition is not legacy-only.
