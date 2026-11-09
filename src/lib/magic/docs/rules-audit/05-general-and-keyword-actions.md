# Rules audit: 700–701 General Rules and Keyword Actions (rules.txt lines 3204–3911)
Audited at engine-rewrite 917180b on 2026-11-09.

## Summary
- Counts: implemented 17, partial 12, missing 67, N/A 8 (across 104 rule/subrule groups covering all numbered rules in CR 700–701).
- Top gaps (most player-visible first):
  - **CR 700.2 / 700.2a–f** — Modal spells and abilities (`Choose one —`, charms, commands) parse into `ModalDef` in the compiler (`compiler/effects.ts:1166-1216`) but are rejected by `staticallyInterpretable` (`runtime/effects.ts:250`), have no mode-choice prompt at cast/trigger time, and on legacy fallback execute every mode's parsed effects at once — **M**.
  - **CR 701.14 / 701.26** — `fight`, `tap`, `untap`, and `tapOrUntap` are fully implemented in the IR interpreter (`runtime/effects.ts:971-1002, 1297-1337`), but `compiler/effects.ts` has **no grammar productions** that emit those verbs, so cards with "fights", "tap target ...", or "untap ..." never compile to IR — **S**.
  - **CR 701.34a** — `proliferate` is always invoked without `chosenIds` (`runtime/effects.ts:855`, `engine.ts:4888`), silently auto-choosing positive counters on the controller's permanents/self and negative counters (`-1/-1`, `stun`, `poison`) on opponents instead of prompting a human player — **S**.
  - **CR 701.15a–d** — Goad combat enforcement exists in `engine.ts:1765-1812` via `creature.goadedByPlayerIds`, but no compiler production or runtime effect ever sets `goadedByPlayerIds`, nothing expires goad at the goader's next turn (`701.15a`), and `engine.ts:1777` illegally blocks goaded creatures from attacking planeswalkers even when no non-goader player can be attacked (`701.15b`) — **S**.
  - **CR 701.25 / 701.16 / 701.44 / 701.50 / 701.57** — Common evergreen/deciduous Commander keyword actions **Surveil**, **Investigate** (Clue tokens), **Explore**, **Connive**, and **Discover** have no compiler productions or runtime handlers — **M**.
  - **CR 701.19 / 701.8c** — **Regenerate** is completely unimplemented (`compiler/adapter.ts:159-160` treats `"can't be regenerated"` as a no-op), so regeneration shields do not replace destruction, tap the creature, remove damage, or remove it from combat — **M**.
  - **CR 700.5 / 700.5a** — `devotion` calculation exists in `runtime/effects.ts:1659-1672`, but `compiler/effects.ts:1082` only compiles it for Thassa's Oracle's exact win condition; general devotion amounts ("equal to your devotion to ...") and Theros God type-changing statics (`700.5a`) are missing — **M**.
  - **CR 701.10 / 701.11** — **Double** and **Triple** (doubling/tripling a creature's power/toughness, doubling life totals, counters, mana pool, or damage dealt) have no effect grammar productions, IR verbs, or damage-doubling replacement hooks — **M**.
  - **CR 701.12a–h** — **Exchange** (exchanging control of two permanents, life totals, zones, or numerical stats with the all-or-nothing rule `701.12a`) is completely unimplemented — **M**.
  - **CR 701.27 / 701.28 / 701.40 / 701.58** — Double-faced **Transform** / **Convert** (`ir.ts:131` marks `multiface` unsupported) and face-down **Manifest** / **Cloak** (`701.40`, `701.58`, including the special action to turn face-down creatures face up for their mana cost) are unimplemented — **L**.
  - **CR 701.24c–f / 701.22c–d** — Standalone library shuffle effects ("Shuffle X into its owner's library"), simultaneous APNAP multi-player scry (`701.22c`), and triggers on scrying (`701.22d`) or shuffling (`701.24e–f`) are missing — **M**.
  - **CR 700.6 / 700.9 / 700.11 / 700.12 / 700.13** — Common modern batch/turn terms (**historic**, **modified**, **descended**, **outlaw**, **committing a crime**) are not recognised by `compiler/` or `runtime/objectFilter.ts` — **M**.

---

## Rule-by-rule

### 700.1 Events
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 700.1 | Anything that happens is an event; one happening may be treated as one event by one ability and multiple events by another | partial | `runtime/events.ts:139-149` defines transient `GameEvent`s (`ZoneChange`, `Cast`, `AttackDeclared`, `DamageDealt`, `PhaseBegin`, `CounterPlaced`, `BlockersDeclared`, `BecameTarget`, `SpellCopied`, `Attached`, `TappedForMana`). `compiler/triggers.ts:167` & `runtime/triggers.ts:575-597` fire `becomesBlocked` once per blocked attacker, but per-blocker "Whenever ~ becomes blocked by a creature" triggers are not parsed or emitted, and actions like scry, mill, discard, sacrifice, shuffle, and life gain/loss emit no dedicated event. |

### 700.2 Modal Spells and Abilities
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 700.2 | Bulleted mode list after `Choose ... —` defines a modal spell or ability | partial | `compiler/effects.ts:1166-1216` (`parseModal`) parses `Choose one —`, `Choose two —`, `Choose one or more —`, and `Choose up to two —` with `•` bullets into `ModalDef` (`ir.ts:227-237`), but `runtime/effects.ts:250` (`staticallyInterpretable`) returns `false` whenever `parse.modal` is present. |
| 700.2a–d, 700.2f | Choosing modes on cast/activate/trigger, per-mode target legality, repeated mode choices, target changes can't change modes | missing | `StackItem` (`types.ts:435-480`) and cast/activate actions have no `chosenModes` field or mode-selection prompt. Legacy `oracle.ts:996-1011` and `engine.ts:7626-7643` accept any target matching *any* modal branch without recording a mode; on legacy resolution, `oracle.ts:1061-1085` parses all mode lines together so bots execute all modes simultaneously (humans get guided resolution via `engine.ts:3936-3949`). |
| 700.2e, 700.2g–i | Non-controller mode choice, copying chosen modes, per-mode additional costs, pawprint `{P}` modes | missing | Not parsed or implemented; `compiler/costs.ts:226` explicitly rejects `{P}` pawprint symbols. |

### 700.3 Piles
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 700.3, 700.3a–d | Grouping objects into piles without leaving their zone | missing | No pile-splitting grammar, prompt, or runtime support in `compiler/` or `runtime/`. |

### 700.4 Dies
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 700.4 | "Dies" means "is put into a graveyard from the battlefield" | implemented | `compiler/triggers.ts:153-157` compiles both `dies` and `is put into a graveyard from the battlefield` to `zoneChange` with `{ from: 'battlefield', to: 'graveyard' }`; matched with LKI look-back in `runtime/triggers.ts:485-555`. |

### 700.5 Devotion
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 700.5 | Devotion to [color] and [color 1] and [color 2] counts matching mana symbols in mana costs of permanents you control | partial | `runtime/effects.ts:1659-1672` (`devotion`) accurately counts colored, hybrid, and Phyrexian mana symbols once per symbol across non-phased-out, face-up permanents controlled (`copiableCard ?? card`). However, `compiler/effects.ts:1082-1091` only compiles devotion for the exact Thassa's Oracle sentence (`if your devotion to <color> is greater than or equal to the number of cards in your library, you win the game`), and neither general devotion amounts nor two-color devotion phrases are parsed. |
| 700.5a | Devotion calculated after copy/control/text-changing effects and devotion modifiers, before Layer 4 type-changing effects | missing | `runtime/layers.ts` has no devotion-conditional type-changing effect (e.g., Theros Gods losing the Creature type when devotion is below N) and no static modifier for increasing devotion. |

### 700.6–700.17 Defined Terms and Turn Tracking
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 700.6 | "Historic" refers to legendary, artifact, or Saga | missing | Only UI deck search (`search.ts:239`) filters `historic`; `compiler/` and `runtime/objectFilter.ts` do not parse or match `historic`. |
| 700.7 | "This/that [something]" refers to that object even if it no longer has that characteristic | implemented | `runtime/effects.ts:492-498, 626-629, 695-701` (`bind`, `objects`, `refSnapshot`) resolves bindings by `instanceId` and `EffectBindingSnapshot` LKI without re-checking whether the object still matches the characteristic phrase that originally selected it. |
| 700.8, 700.8a–d | Party (up to one each of Cleric, Rogue, Warrior, Wizard) and full party | missing | Not parsed or implemented in `compiler/` or `runtime/`. |
| 700.9 | Modified permanents (counters, equipped, or enchanted by an Aura you control) | missing | Not parsed or implemented in `compiler/` or `runtime/objectFilter.ts`. |
| 700.10 | Permanent "that was activated this turn" | missing | Not tracked (`usedLoyaltyThisTurn` in `types.ts:364` only tracks loyalty abilities). |
| 700.11 | "Descended this turn" / number of times descended (permanent cards put into your graveyard from anywhere this turn) | missing | Not tracked in `PlayerGameState` or `runtime/zones.ts`. |
| 700.12, 700.12a | "Outlaw" (Assassin, Mercenary, Pirate, Rogue, and/or Warlock) | missing | Individual subtypes exist in `runtime/objectFilter.ts`, but the batch term `outlaw` is not parsed or expanded. |
| 700.13 | Committing a crime (targeting an opponent, something they control, or a card in their graveyard) | missing | `BecameTargetEvent` (`runtime/events.ts:114-122`) only fires for permanents on the battlefield; no crime trigger or tracking exists. |
| 700.14 | Expend N (cumulative mana spent to cast spells this turn reaching N) | missing | Cumulative mana spent on spells per turn is not tracked and `expend` triggers are not parsed. |
| 700.15 | "Enter[s]" is short for "enter[s] the battlefield" | implemented | `compiler/triggers.ts:144-152` and `compiler/statics.ts` handle `enters` / `enter` identically to `enters the battlefield`. |
| 700.16 | "Worthy" creatures (legendary, not a Villain, red and/or white) | missing | Not parsed or implemented. |
| 700.17 | "Faces a dilemma" (choosing one or more modes for a modal spell or ability) | missing | Not parsed or tracked. |

### 701.1 Keyword Actions General
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.1 | Keyword actions are specialized game verbs | N/A | Definitional rule (`rules.txt:3287`). |

### 701.2 Activate
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.2, 701.2a | Activate an activated ability (priority, controller-only, put on stack, pay costs) | implemented | `engine.ts:1589-1685` (`case 'activate_ability'`) verifies the permanent is on `actor.battlefield` (controller check), checks priority/timing in `checkAbilityActivationLegality`, pays IR costs via `planCosts`/`payPlannedCosts` (`runtime/costs.ts`), and pushes the ability onto `state.stack` (or resolves mana abilities immediately). |

### 701.3 Attach
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.3, 701.3a | Attach an Aura, Equipment, or Fortification to an object or player | partial | `compiler/effects.ts:820-826` and `runtime/effects.ts:906-925` implement `attach` only for the source permanent (`this.ctx.sourceId`) attaching to a target Creature you control, and `engine.ts:4039-4062` attaches Aura spells on resolution. Third-party attach effects ("Attach target Equipment to target creature"), attaching to players, Fortifications, and checking protection at attach-effect resolution are not implemented. |
| 701.3b | Illegal attach or attaching to the object it's already attached to does nothing | implemented | `runtime/effects.ts:910-913` checks both objects are on the battlefield, target is a creature you control, and returns early if `equipment.inst.attachedToId === found.inst.instanceId`. |
| 701.3c | Attaching on the battlefield to a different object gives a new timestamp | implemented | `runtime/effects.ts:917-921` and `engine.ts:5325-5327` (`triggerOnAttach`) allocate a new `enteredTimestamp` via `allocateTimestamp(state)` when an attachment attaches on the battlefield. |
| 701.3d | Unattach and "becoming unattached" | partial | SBA unattachment when the host leaves or becomes illegal is implemented (`engine.ts:6605-6642`), and `AttachedEvent` (`runtime/events.ts:132-138`) fires on attach, but there is no `unattach` effect verb in `compiler/effects.ts` / `ir.ts` and no `Unattached` event for "whenever ~ becomes unattached" triggers. |

### 701.4 Behold
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.4, 701.4a–b | Behold a [quality] (reveal from hand or choose controlled permanent) and "if a [quality] was beheld" | missing | Not parsed or implemented in `compiler/` or `runtime/`. |

### 701.5 Cast
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.5, 701.5a–b | Cast a spell / cast a card (move to stack, pay costs, requires priority) | implemented | `engine.ts:1357-1587` (`case 'cast_spell'`) checks timing and priority, validates targets, pays mana and additional costs via `runtime/costs.ts`, moves the card from hand/command/graveyard/exile to `state.stack`, and emits `CastEvent`. |

### 701.6 Counter
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.6, 701.6a–b | Counter a spell or ability (remove from stack, spell to owner's graveyard, no cost refund) | partial | `compiler/effects.ts:836-842`, `runtime/effects.ts:817-823`, and `engine.ts:5158-5185` (`counterStackItemByEffect`) counter target spells on the stack (honoring `cantBeCountered`, moving the spell to its owner's graveyard, and never refunding costs). However, countering activated or triggered abilities ("counter target activated or triggered ability") is not parsed by `compiler/costs.ts` / `compiler/effects.ts`. |

### 701.7 Create
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.7, 701.7a, 701.7c | Create one or more tokens with specified characteristics | implemented | `compiler/effects.ts:461-471`, `runtime/effects.ts:825-835`, and `engine.ts:5767-5792` (`createTokenOnBoard`) create tokens onto the battlefield via `moveObject(state, inst, 'battlefield', { from: 'none' })`. |
| 701.7b | Token creation replacements apply before continuous effects; ETB replacements apply after | implemented | `runtime/effects.ts:829` applies `tokenMultiplier` (`runtime/replace.ts:868-891`) before creating token instances; `moveObject` (`runtime/zones.ts:294-339`) applies `applyEtbReplacements` (`runtime/replace.ts:487-573`) using `evaluatePermanent` continuous effects as the token enters. |

### 701.8 Destroy
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.8, 701.8a–b | Destroy a permanent (move from battlefield to owner's graveyard; only via "destroy" or lethal/deathtouch SBA) | implemented | `compiler/effects.ts:827-835`, `runtime/effects.ts:770-803`, and `engine.ts:5188-5204` (`destroyPermanentByEffect`) check `Indestructible` and shield counters (`CR 122.1c`), then move the permanent to its owner's graveyard; lethal damage and deathtouch SBAs (`engine.ts:6547-6585`) do the same. |
| 701.8c | Regeneration effect replaces destruction | missing | No regeneration shields exist (`compiler/adapter.ts:159-160`). |

### 701.9 Discard
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.9, 701.9a–b | Discard a card (owner's hand to graveyard; affected player chooses unless random or another player chooses) | partial | `compiler/effects.ts:773-791`, `compiler/costs.ts:274-284`, `runtime/effects.ts:1419-1504`, and `runtime/costs.ts:370-371, 672-682` move discarded cards from hand to graveyard, prompt humans in APNAP order, and support seeded random discard (`atRandom`). Missing: effects where another player chooses which card a player discards (e.g., Thoughtseize) and a dedicated `CardDiscarded` event for discard triggers. |
| 701.9c | Discarded card put into a hidden zone without being revealed has undefined characteristics; illegal cost rollback | missing | `discardCard` (`runtime/effects.ts:1425-1434`) only handles graveyard-to-exile replacement; hidden-zone discard replacements and cost-payment rollback are not implemented. |

### 701.10 Double
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.10, 701.10a–f | Double a creature's power/toughness (including negative P/T), a player's life total, counters on a permanent/player, or mana in pool | missing | No compiler production or IR verb exists for one-shot doubling effects. (Static replacement multipliers for "twice that many counters/tokens" exist in `runtime/replace.ts:825-891`.) |
| 701.10g | Double an amount of damage a source would deal (replacement effect) | missing | `runtime/replace.ts` supports `counters`, `tokens`, and `triggers` multipliers (`ir.ts:581-587`), but has no damage-doubling replacement effect. |

### 701.11 Triple
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.11, 701.11a–c | Triple a creature's power and/or toughness (including negative P/T) | missing | Not parsed or implemented in `compiler/` or `runtime/`. |

### 701.12 Exchange
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.12, 701.12a–h | Exchange control, life totals, zones, numerical values, or text boxes (all-or-nothing rule) | missing | No `exchange` verb or parser exists in `compiler/`, `runtime/`, or `engine.ts`. |

### 701.13 Exile
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.13, 701.13a | Exile an object (move to exile from wherever it is) | implemented | `compiler/effects.ts:827-835`, `compiler/costs.ts:287-305`, `runtime/effects.ts:1506-1542`, and `runtime/zones.ts:242-359` (`moveObject` to `'exile'`) move objects from battlefield, graveyard, hand, library, or stack (`exileSelf`) to their owner's exile zone. |

### 701.14 Fight
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.14, 701.14a–d | Fight (each creature deals damage equal to power to the other; both must be on battlefield and creatures; self-fight = 2x power; non-combat damage) | partial | Runtime implements all four subrules in `runtime/effects.ts:1297-1337` (simultaneous non-combat `DamageDealt` with `combat: false`, checks both are on battlefield and `isCreature`, `fighterA.instanceId === fighterB.instanceId` deals `powerA * 2`, tested in `runtime/keywords-damage.test.ts:404-475`). However, `compiler/effects.ts` has **no grammar production** that emits `verb: 'fight'`, so no real card compiles to it. |

### 701.15 Goad
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.15, 701.15a–d | Goad (designation until goader's next turn; must attack if able and attack a player other than a goader if able; multiple goaders) | partial | `engine.ts:1765-1812` checks `creature.goadedByPlayerIds` (`types.ts:379`, cleared on zone change in `runtime/zones.ts:265`), but: (1) no compiler production or runtime effect ever sets `goadedByPlayerIds`; (2) nothing expires `goadedByPlayerIds` at the goader's next turn (`701.15a`); (3) `engine.ts:1777` (`Boolean(assign.defenderPlaneswalkerId)`) blocks attacking planeswalkers when a non-goader player exists, which matches `701.15b`, but goad cannot be applied by any card in play. |

### 701.16 Investigate
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.16, 701.16a | Investigate ("Create a Clue token") | missing | Not parsed in `compiler/effects.ts` or `oracle.ts`; no Clue token creation helper. |

### 701.17 Mill
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.17, 701.17a–b | Mill N cards (top of library to graveyard; capped at library size; can't pay mill cost > library size) | implemented | `compiler/effects.ts:448-453`, `runtime/effects.ts:1003-1017` (`Math.min(this.amount(step.amount), pl.library.length)` moving `pl.library[0]` to `'graveyard'`), and `runtime/costs.ts:431-436, 725-736` (`ctx.player.library.length < amount` cost check) enforce 701.17a–b. |
| 701.17c–d | Finding milled cards in public zones and querying characteristics of milled cards | missing | `runtime/effects.ts:1003-1017` does not bind milled cards via `this.bind(step, ...)` and no compiler productions reference or query cards milled by an earlier step. |

### 701.18 Play
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.18, 701.18a–e | Play a land (main phase, priority, empty stack, land-play limit, special action) / play a card | implemented | `engine.ts:1278-1355` (`case 'play_land'`) enforces active-player main phase, empty stack, and `landsPlayedThisTurn < maxLandsPerTurn` without using the stack, and supports playing lands or casting spells from exile via `playableFromExileBy`. |

### 701.19 Regenerate
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.19, 701.19a–c | Regenerate (replacement shield: remove marked damage, tap, remove from combat) | missing | Not parsed or implemented (`compiler/adapter.ts:159-160`). |

### 701.20 Reveal
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.20, 701.20a–e | Reveal / look at cards (remains in zone; reordered library cards stop being revealed and become new objects) | partial | `compiler/effects.ts:1019` (`lookAndReorder`) and `engine.ts:5207-5307` implement looking at the top N cards of a library, but there is no `reveal` cost/effect implementation (`compiler/costs.ts:82` lists `reveal` in `COST_VERBS` without a production) and `shuffleLibrary` / `rearrangeLibrary` (`runtime/zones.ts:381-412`) do not bump `objectVersion` on reordered library cards (`701.20d`). |

### 701.21 Sacrifice
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.21, 701.21a | Sacrifice a permanent (controller moves permanent they control from battlefield to owner's graveyard; not destruction) | implemented | `compiler/effects.ts:753-771`, `compiler/costs.ts:250-261`, `runtime/effects.ts:1339-1417`, and `runtime/costs.ts:365-369, 661-670` enforce `c.controllerId === actor.playerId` and `zone === 'battlefield'`, prompt humans in APNAP order, and move directly to `'graveyard'` without checking `Indestructible` or destruction replacements. |

### 701.22 Scry
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.22, 701.22a–b | Scry N (look at top N, put any number on bottom in any order and rest on top in any order; scry 0 is a no-op) | implemented | `compiler/effects.ts:455-459`, `runtime/effects.ts:1018-1025`, and `engine.ts:5207-5263, 2742-2790` (`scryOrRearrangeTop`, `rearrangeLibrary`) return early when `count <= 0` (`701.22b`) and split selected cards between top and bottom in any order (`701.22a`). |
| 701.22c–d | Multiple players scry in APNAP order and move simultaneously; "whenever a player scries" triggers after completion | missing | `engine.ts:5218-5263` immediately rearranges a bot's library while queueing prompts for humans, and no `Scry` event or trigger exists (`701.22d`). |

### 701.23 Search
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.23, 701.23a–b, 701.23d | Search a zone for a card; fail-to-find allowed only when searching a hidden zone for a stated quality (`701.23b`) vs mandatory find for a pure quantity (`701.23d`) | implemented | `compiler/effects.ts:472-477`, `runtime/effects.ts:1026-1033`, `oracle.ts:1716-1925`, and `engine.ts:5619-5765, 2520-2735` (`initiateLibrarySearch`) compute `canFailToFind = searchSpec.statedQuality || searchSpec.upTo || matchingCards.length === 0` (`engine.ts:5634-5635`) and set `choice.min = canFailToFind ? 0 : 1` (`engine.ts:5759`). |
| 701.23c, 701.23e–j | Search with undefined quality, reveal vs non-reveal, portion-of-zone replacement, multi-player APNAP simultaneous search, searching outside the game | missing | Only single-player library search (plus Opposition Agent interception in `engine.ts:5626-5666`) is supported; graveyard/hand search, Aven Mindcensor partial-zone search replacements, APNAP simultaneous multi-player search (`701.23i`), and wish effects (`701.23j`) are not implemented. |

### 701.24 Shuffle
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.24, 701.24a–b | Shuffle a library (seeded randomization; found cards placed on top after search aren't shuffled away) | implemented | `runtime/random.ts:30` (`shuffleWith` Fisher–Yates on seeded PRNG) and `runtime/zones.ts:381-390` (`shuffleLibrary(state, player, keepTop)`) together with `placeDeferred` (`engine.ts:5685-5706, 2628-2637`) keep found top-of-library cards out of the shuffle (`701.24b`). |
| 701.24c–g | Standalone shuffle effects, shuffling specific/empty sets of objects into library, and "whenever a library is shuffled" triggers | missing | No standalone `shuffle` verb exists in `ir.ts` / `compiler/effects.ts` (shuffling only runs inside `search` or `lookAndReorder` with `mayShuffle`), and no `LibraryShuffled` event or trigger exists (`701.24e–f`). |

### 701.25 Surveil
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.25, 701.25a–d | Surveil N (look at top N, put any number into graveyard and rest on top in any order) | missing | Not parsed in `compiler/` or `oracle.ts`; no prompt or runtime handler. |

### 701.26 Tap and Untap
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.26, 701.26a–b | Tap and Untap a permanent (only untapped permanents can be tapped; only tapped permanents can be untapped) | partial | Cost tapping/untapping (`compiler/costs.ts:224-225, 264-271`, `runtime/costs.ts:361-364, 386-396`) and runtime effect verbs `tap`/`untap` (`runtime/effects.ts:971-1002`, including stun counter replacement `CR 122.1d`) exist, and `compiler/triggers.ts:169` parses `becomes tapped`. However: (1) `compiler/effects.ts` has **no grammar production** that emits `verb: 'tap'`, `'untap'`, or `'tapOrUntap'`; (2) `runtime/effects.ts:984` sets `o.tapped = true` without checking `!o.tapped` or emitting an event for `becomesTapped` triggers. |

### 701.27–701.33 Transform, Convert, Fateseal, Clash, Planechase/Archenemy Actions
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.27, 701.27a–j | Transform a double-faced permanent | missing | `CardInstance.transformed` exists (`types.ts:365`), but multiface cards are marked `unsupported('multiface')` (`ir.ts:131`) and no transform action or back-face evaluation exists. |
| 701.28, 701.28a–h | Convert a double-faced permanent | missing | Same as 701.27; no convert action or multiface permanent support. |
| 701.29, 701.29a | Fateseal N | missing | Not parsed or implemented. |
| 701.30, 701.30a–d | Clash | missing | Not parsed or implemented. |
| 701.31, 701.31a–d | Planeswalk (Planechase variant) | N/A | Planechase casual variant (`CR 901`), outside Commander scope. |
| 701.32, 701.32a–c | Set in Motion (Archenemy variant) | N/A | Archenemy casual variant (`CR 904`), outside Commander scope. |
| 701.33, 701.33a–b | Abandon (Archenemy variant) | N/A | Archenemy casual variant (`CR 904`), outside Commander scope. |

### 701.34 Proliferate
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.34, 701.34a | Proliferate (choose any number of permanents and/or players with counters; give each one additional counter of each kind it already has) | partial | `compiler/effects.ts:812-815`, `runtime/effects.ts:854-856`, and `engine.ts:5794-5876` (`executeProliferate`) compile and execute `proliferate` across permanent counters and player `poison` / `experienceCounters` / `energyCounters`. However, both `runtime/effects.ts:855` and `engine.ts:4888` call `executeProliferate(state, controller)` **without** `chosenIds`, silently using the bot heuristic for human players instead of prompting (`CR 701.34a`). |
| 701.34b | Proliferate in Two-Headed Giant (shared poison counters) | N/A | Two-Headed Giant variant (`CR 810`), outside free-for-all Commander scope. |

### 701.35–701.72 Remaining Keyword Actions
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 701.35, 701.35a | Detain a permanent until your next turn | missing | Not parsed or implemented. |
| 701.36, 701.36a–b | Populate (choose a creature token you control and create a copy) | missing | `copyPermanentAsToken` exists (`engine.ts:5131-5155`), but `populate` is not parsed or implemented. |
| 701.37, 701.37a–c | Monstrosity N and `monstrous` designation | missing | Not parsed or implemented. |
| 701.38, 701.38a–d | Vote (turn-order voting, multiple votes) | missing | Not parsed or implemented. |
| 701.39, 701.39a | Bolster N (creature you control with least toughness) | missing | Not parsed or implemented. |
| 701.40, 701.40a–h | Manifest a card (2/2 face-down creature; turn face up for mana cost at any time with priority) | missing | `CardInstance.isFaceDown` exists (`types.ts:380`), but neither `manifest` nor turning a face-down creature face up is implemented. |
| 701.41, 701.41a | Support N (+1/+1 counter on each of up to N other target creatures / target creatures) | missing | Not parsed or implemented. |
| 701.42, 701.42a–c | Meld | missing | Not parsed or implemented (`multiface` non-goal in `ir.ts:131`). |
| 701.43, 701.43a–d | Exert a permanent (doesn't untap during your next untap step; optional attack cost) | missing | Listed in `compiler/costs.ts:82` (`COST_VERBS`) for splitting cost clauses, but has no cost production or runtime support. |
| 701.44, 701.44a–d | Explore (reveal top card: land to hand, else +1/+1 counter and may graveyard) | missing | Not parsed or implemented. |
| 701.45, 701.45a | Assemble a Contraption (Unstable set) | N/A | Silver-bordered / Unstable mechanic (`rules.txt:3707`). |
| 701.46, 701.46a | Adapt N (if no +1/+1 counters on it, put N +1/+1 counters on it) | missing | Not parsed or implemented. |
| 701.47, 701.47a–d | Amass [subtype] N | missing | `Army` subtype is in `runtime/objectFilter.ts`, but `amass` is not parsed or implemented. |
| 701.48, 701.48a | Learn (may discard to draw, or wish for a Lesson) | missing | Not parsed or implemented. |
| 701.49, 701.49a–d | Venture into the Dungeon / Venture into [quality] | missing | Not parsed or implemented. |
| 701.50, 701.50a–f | Connive / Connive N | missing | Not parsed or implemented. |
| 701.51, 701.51a–c | Open an Attraction | N/A | Unfinity Attraction deck mechanic. |
| 701.52, 701.52a | Roll to Visit Your Attractions | N/A | Unfinity Attraction deck mechanic. |
| 701.53, 701.53a–b | Incubate N (double-faced Incubator artifact token with N +1/+1 counters) | missing | Not parsed or implemented. |
| 701.54, 701.54a–e | The Ring Tempts You (Ring-bearer designation and The Ring emblem tiers 1–4) | missing | Not parsed or implemented. |
| 701.55, 701.55a–d | Face a Villainous Choice | missing | Not parsed or implemented. |
| 701.56, 701.56a | Time Travel (add/remove time counters on controlled permanents and owned suspended cards) | missing | `time` counters and suspend exist (`types.ts:276`), but `time travel` is not parsed or implemented. |
| 701.57, 701.57a–c | Discover N (exile until nonland MV <= N; cast free or put in hand; rest to bottom randomly) | missing | Not parsed or implemented. |
| 701.58, 701.58a–h | Cloak a card (2/2 face-down creature with ward {2}; turn face up for mana cost) | missing | Not parsed or implemented. |
| 701.59, 701.59a–c | Collect Evidence N (exile graveyard cards with total MV >= N; linked abilities) | missing | Listed in `compiler/costs.ts:82` (`COST_VERBS`), but has no cost production or runtime support. |
| 701.60, 701.60a–d | Suspect a creature (`suspected` designation grants menace and "can't block") | missing | Not parsed or implemented. |
| 701.61, 701.61a | Forage ("Exile three cards from your graveyard or sacrifice a Food") | missing | Listed in `compiler/costs.ts:82` (`COST_VERBS`), but has no cost or effect production. |
| 701.62, 701.62a–b | Manifest Dread (look at top 2, manifest 1, put other into graveyard) | missing | Not parsed or implemented. |
| 701.63, 701.63a–b | Endure N (create N/N Spirit token unless you put N +1/+1 counters on permanent) | missing | Not parsed or implemented. |
| 701.64, 701.64a–b | Harness (`harnessed` designation on permanent) | missing | Not parsed or implemented. |
| 701.65, 701.65a–b | Airbend (exile permanents/spells; owner may cast from exile for `{2}`) | missing | Not parsed or implemented. |
| 701.66, 701.66a–b | Earthbend N (target land becomes 0/0 creature with haste and N +1/+1 counters; returns tapped on death/exile) | missing | Not parsed or implemented. |
| 701.67, 701.67a–c | Waterbend [cost] (tap untapped artifacts/creatures to pay generic mana in waterbend cost) | missing | Listed in `compiler/costs.ts:82` and `compiler/adapter.ts:152`, but unimplemented in cost parser and runtime. |
| 701.68, 701.68a–d | Blight N (put N -1/-1 counters on a creature you control) | missing | Listed in `compiler/costs.ts:82` (`COST_VERBS`), but unimplemented in cost/effect parsers and runtime. |
| 701.69, 701.69a | Heal damage marked on a permanent | missing | Not parsed or implemented (`'heal'` in `types.ts:721` is only a VFX label for player life gain). |
| 701.70, 701.70a | Recruit (draw, discard; if nonland discarded, create 1/1 white Human Soldier token) | missing | Not parsed or implemented. |
| 701.71, 701.71a | Empower Jace N | missing | Not parsed or implemented. |
| 701.72, 701.72a–c | Assimilate (gain control / put onto battlefield with +1/+1 counter as Borg artifact creature) | missing | Not parsed or implemented. |

---

## Silently skipped / approximated behaviour
- **Proliferate auto-chooses for human players (`CR 701.34a`)**: `executeProliferate` (`engine.ts:5794-5876`) accepts an optional `chosenIds?: string[]` parameter, but both the IR interpreter (`runtime/effects.ts:855`) and legacy resolution (`engine.ts:4888`) call `executeProliferate(state, controller)` without `chosenIds`. When `chosenIds` is omitted, `executeProliferate` never opens a prompt for a human controller; it automatically proliferates `['+1/+1', 'loyalty', 'charge', 'shield', 'lore', 'time']` on the controller's permanents, `experienceCounters`/`energyCounters` on the controller, and `['-1/-1', 'stun']` and `poison` on opponents. A human player cannot choose to proliferate `-1/-1` counters on their own creature (e.g., for death/persist synergies), proliferate an ally's counters in multiplayer, or decline proliferating a counter type on an already-chosen permanent.
- **Can't-be-regenerated clauses are silently dropped (`CR 701.19`, `CR 701.8c`)**: `compiler/adapter.ts:159-160` strips `/^(?:it|they) can't be regenerated\.$/i` as a no-op comment because regeneration is not implemented.
- **Multi-player Scry executes bots immediately instead of simultaneously in APNAP order (`CR 701.22c`)**: In `runtime/effects.ts:1018-1025` and `engine.ts:5207-5263`, when multiple players scry at once, bot players immediately reorder their libraries inside the loop while human players have `scry_choice` prompts queued for later resolution.
- **Tapping via IR `tap` verb does not check whether the permanent was already tapped (`CR 701.26a`)**: `runtime/effects.ts:983-984` unconditionally assigns `o.tapped = true` without checking `!o.tapped` first or emitting an event for `becomesTapped` triggers.

---

## Legacy-only findings (verify after step F)
- **Modal spell target validation and all-modes execution (`CR 700.2`)**: In `oracle.ts:996-1011` and `engine.ts:7626-7643`, modal spells validate chosen targets against *any* branch in `modalBranches` without recording which mode was chosen. When resolved via the legacy path (`executeParsedEffect` in `engine.ts:4296`, or when a human chooses the legacy fallback in guided resolution at `engine.ts:2843`), `parseSpellOrAbilityEffects` (`oracle.ts:1061-1085`) extracts effects across the entire spell text, causing bots to execute every mode of a modal spell at once.
- **Tap / untap spell effects (`CR 701.26`)**: Only legacy `oracle.ts` (`tap_target`, `untap_target`, `tap_all_opponents_creatures`, `untap_all_controlled`) and `executeParsedEffect` in `engine.ts` parse and resolve tap/untap instructions on cards; `compiler/effects.ts` has no production emitting the IR `tap`, `untap`, or `tapOrUntap` verbs even though `runtime/effects.ts:971-1002` implements them.
- **Devotion to Blue in legacy `executeParsedEffect` (`CR 700.5`)**: `oracle.ts:1385-1392` and `engine.ts:4397-4411` (`dynamicFormula: 'devotion_blue_gte_library'`) implement a legacy Thassa's Oracle check that uses raw regex `perm.card.manaCost.match(/U/g)` (which ignores `copiableCard` and face-down status, unlike the IR helper `devotion` in `runtime/effects.ts:1659-1672`).
