# Rules audit: 2. Parts of a Card, 3. Card Types, 4. Zones (rules.txt lines 1279–2113)
Audited at engine-rewrite 917180b on 2026-11-09.

## Summary
- Counts: implemented 92, partial 42, missing 64, N/A 65 (across 263 rule/subrule rows covering all 362 numbered rules in CR 200–408).
- Top gaps (most player-visible first):
  1. **CR 301.7 / 301.7a–b (Vehicles & Crew)** — Vehicles cannot be crewed or animated into creatures (`crew` is in `KNOWN_KEYWORDS` only in `compiler/adapter.ts:133`, and no `animate`/`becomes` verb exists in `ir.ts` or `runtime/effects.ts`) — **M**.
  2. **CR 303.4 / 303.4b–c (Auras enchanting players / Curses)** — Resolving an Aura spell only attaches when `item.targets[0]?.kind === 'permanent'` (`engine.ts:4241-4243`), and SBA attachment validation only checks `findPermanentOnBoard` (`engine.ts:6619-6634`), so `Enchant player` Auras (Curses) enter unattached and are immediately put into the graveyard — **S**.
  3. **CR 303.4f–i (Auras entering the battlefield without being cast)** — Putting an Aura onto the battlefield from a graveyard/library/hand (`runtime/effects.ts:1565-1571`, `engine.ts:5043-5048`) neither prompts the controller to choose a legal object/player to enchant (303.4f) nor keeps the Aura in its previous zone if no legal object exists (303.4g); it enters with `attachedToId = null` and dies to SBAs — **M**.
  4. **CR 205.4d / 704.5j (Legend rule choice)** — When a player controls two or more legendary permanents with the same name, `checkStateBasedActions` (`engine.ts:6695-6702`) silently keeps the last array element (`list[list.length - 1]`) and puts earlier ones into the graveyard without prompting the controller — **S**.
  5. **CR 300.2a / 305.9 (Dryad Arbor & MDFC land/spell legality)** — `checkSpellCastLegality` blocks lands with `inst.card.typeLine.includes('Land') && !inst.card.typeLine.includes('Creature')` (`engine.ts:7929`), which allows Land Creatures (`Dryad Arbor`) to be cast as spells and blocks noncreature/land MDFCs (`Valakut Awakening // Valakut Stoneforge`) from being cast as spells because Scryfall's combined `typeLine` contains `'Land'` (`scryfall.ts:165`) — **S**.
  6. **CR 205.1a–b / 205.4b / 305.7 (Layer 4 type/subtype overwriting drops supertypes and prior types)** — In `runtime/layers.ts:1120-1125` (`setTypes`) and `1183-1185` (`setSubtypes`, e.g. Blood Moon), the rewritten `effectiveTypeLine` only preserves `Legendary`, dropping `Basic`/`Snow`/`World` supertypes (205.4b) and dropping non-land card types like `Artifact` on artifact lands (`Seat of the Synod` under Blood Moon loses `isArtifact` at `layers.ts:1789`) — **S**.
  7. **CR 202.3d–e (Mana value of X spells on the stack, split cards, and face-down objects)** — Mana value queries read static `card.cmc` (`runtime/objectFilter.ts:225,274`, `runtime/effects.ts:435,536,687`) instead of adding `xValue * xCount` for spells on the stack (202.3e) or returning `0` for face-down permanents in `objectFilter.ts` (202.3a) — **S**.
  8. **CR 301.5c (Equipment that becomes a creature or equips illegal target)** — Equipment SBA (`engine.ts:6636-6646`) and `attach`/`equip_target` (`runtime/effects.ts:906-924`, `engine.ts:4564-4592`) do not check whether the Equipment itself has become a creature (without Reconfigure) or prevent an Equipment from equipping itself — **S**.
  9. **CR 205.4e (Legendary instants and sorceries)** — `checkSpellCastLegality` (`engine.ts:7901-8053`) never checks that a player controls a legendary creature or legendary planeswalker before casting a legendary instant or sorcery (`Kamahl's Druidic Vow`, `Urza's Ruinous Blast`) — **S**.
  10. **CR 208.2a / 208.4b (Off-battlefield CDA P/T and base P/T queries)** — Characteristic-defining abilities (`*/*`) are only evaluated on the battlefield in Layer 7a (`runtime/layers.ts:1326-1342`); off-battlefield `buildOffBattlefieldBreakdown` (`layers.ts:1887-1890`) returns `null` (0), and `Amount` has no `basePower`/`baseToughness` stat (208.4b) — **M**.
  11. **CR 309 (Dungeons) & CR 310 (Battles / Sieges)** — Only the `Battle` type name is recognised in type lines (`runtime/zones.ts:161`, `compiler/adapter.ts:78`); defense counters, protectors, attacking battles, Siege transform triggers, and venturing into the dungeon are completely unimplemented — **L**.
  12. **CR 401.5 / 406.3 / 406.6 (Top-of-library play/reveal, face-down exile, linked exile)** — Playing with the top card of the library revealed/playable (`Future Sight`, `Bolas's Citadel`), face-down exile permissions/inspection (`406.3`), and linked `exiled with ~` object tracking (`406.6`) are not implemented in the IR runtime — **L**.
  13. **CR 401.4 / 404.3 (Simultaneous library/graveyard ordering)** — When multiple cards are put into a library or graveyard at the same time (e.g. `sbaGraveyardBatch` in `engine.ts:6755-6816`, `destroy` / `discard` in `runtime/effects.ts:795-797,1500-1502`), their owner is not prompted to choose their relative order — **S**.

---

## Rule-by-rule

### 200 General
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 200.1–200.2 | Parts of a card; parts that are characteristics | implemented (definitional) | Represented on `ScryfallCard` (`types.ts:61-95`) and `Characteristics` (`ir.ts:36-46`, `compiler/adapter.ts:1207-1227`). |
| 200.3 | Non-card objects (tokens, copies) have only characteristic parts | implemented | Token creation (`oracle.ts:72-104`) and `copiableCard` (`types.ts:368`, `runtime/layers.ts:969`) carry only characteristic fields. |

### 201 Name
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 201.1–201.2 | Printed name; English Oracle name used | implemented | `scryfall.ts:153` normalizes `ScryfallCard.name` from Oracle data. |
| 201.2a | Same name if at least one name in common; face-down (no name) shares no name | partial | Face-down permanents are skipped in the Legend Rule (`engine.ts:6686`, citing CR 201.2a), but `evaluatePermanent` sets `effectiveName: 'Face-Down Creature'` (`runtime/layers.ts:1075,2085`) instead of empty/no name, and split/DFC multi-name matching is not implemented. |
| 201.2b–201.2c | Objects with different names; different name than another object | missing | No filter, condition, or amount in `ir.ts` or `runtime/objectFilter.ts` checks "with different names" or "different name than". |
| 201.3, 201.3a–c | Interchangeable names (Universes Within / Godzilla equivalents) | missing | `ScryfallCard` (`types.ts:61-95`, `scryfall.ts:153`) tracks `name` and `oracleId`, but deck validation (`scryfall.ts:449-470`) and runtime name checks compare `card.name` rather than `oracleId`. |
| 201.4, 201.4a–g | Choosing a card name (Oracle reference, characteristics, split/flip/DFC/meld/adventure) | missing | No `chooseCardName` prompt or choice kind exists in `types.ts` or `runtime/choices.ts`. |
| 201.5 | Text referring to object by its own name means `this` object | implemented | `replaceSelfReferences` in `compiler/normalize.ts:57-63` replaces the card's name with `~` (`{ k: 'self' }`). |
| 201.5a | Granted ability referring to first ability's source by name refers to that specific object | missing | No granted-ability source-binding mechanism exists in `ir.ts` or `runtime/layers.ts`. |
| 201.5b | Gained ability referring to original object's name refers to the new object | implemented | Because `compiler/normalize.ts:57-63` normalizes self-name references to `~` at compile time, any ability evaluated on another permanent resolves `self` to that permanent. |
| 201.5c | Shortened legendary name ("Name" before comma in "Name, Title") means full name | implemented | `selfNames` in `compiler/normalize.ts:46-51` extracts `name.slice(0, comma)` and replaces it with `~`. |
| 201.6 | Secondary title bar / alternate promotional name has no gameplay effect | N/A | Scryfall Oracle data supplies the canonical Oracle name (`scryfall.ts:153`). |

### 202 Mana Cost and Color
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 202.1, 202.1a | Mana cost symbols; spending mana matching colored/colorless/generic/Phyrexian symbols | implemented | `parseManaCost` (`oracle.ts:141-206`), `resolveFlexibleManaRequirement` (`oracle.ts:208-295`), and `effectiveSpellManaCost` (`runtime/costs.ts:114-240`). |
| 202.1b | Objects with no mana cost have an unpayable mana cost; lands played without paying | partial | `checkSpellCastLegality` (`engine.ts:8011-8016`) blocks casting `manaCost === ''` cards from hand, but only checks `fromZone === 'hand'` (a card with `manaCost === ''` given a generic exile/graveyard play permission without "without paying its mana cost" would pay `{0}`). |
| 202.2, 202.2a–d | Object color from mana cost, colorless default, multicolored, hybrid/Phyrexian colors | implemented | `ScryfallCard.colors` (`scryfall.ts:171`) and `buildCharacteristics` (`compiler/adapter.ts:1215`) populate `W/U/B/R/G` from Scryfall Oracle data (which derives color from mana cost including hybrid/Phyrexian). |
| 202.2e | Color indicator defines color | implemented | Scryfall's `colors` array (`scryfall.ts:171`) includes color indicators (e.g. Pact of Negation, Dryad Arbor) and is used in `compiler/adapter.ts:1215` and `runtime/layers.ts:977`. |
| 202.2f | Continuous effects changing/adding/removing color | implemented | Layer 5 `setColors` and `addColors` in `runtime/layers.ts:1143-1148,1247-1275` (`compiler/statics.ts` compiles color-setting/adding statics). |
| 202.3 | Mana value equals total amount of mana in mana cost | implemented | `ScryfallCard.cmc` (`types.ts:66`, `scryfall.ts:198`) and `parseManaCost(...).totalCmc` (`oracle.ts:203`). |
| 202.3a | Mana value of object with no mana cost is 0 (including face-down permanents and tokens) | partial | `runtime/layers.ts:712` returns `0` for `refPerm.isFaceDown`, and tokens created by `oracle.ts:80` have `cmc: 0`; however, `runtime/objectFilter.ts:225,274` and `runtime/effects.ts:687` read `card.cmc` directly without checking `inst.isFaceDown`, and token copies created via `copyPermanentAsToken` (`engine.ts:5181`) keep the copied permanent's `cmc` (which is correct per 707.2, except for back faces per 202.3b). |
| 202.3b | Mana value of transforming DFC back face uses front face; copy of back face has MV 0 | missing | DFCs and transformation are unsupported (`compiler/adapter.ts:219-228`, `engine.ts:253`). |
| 202.3c | Mana value of melded permanent is sum of front faces; copy has MV 0 | N/A | No meld cards are supported (`compiler/adapter.ts:219`). |
| 202.3d | Mana value of split card off-stack vs on-stack | missing | Split cards are rejected as `unsupported('multiface')` (`compiler/adapter.ts:219-228`), and `StackItem` has no chosen-half mana value override. |
| 202.3e | Mana value of `{X}` spell is 0 off-stack and includes chosen X on the stack | partial | Off-stack `card.cmc` treats X as 0, and `parseManaCost` (`oracle.ts:199-203`) adds `xCount * xValue` to `totalCmc`, but stack/object filters (`runtime/objectFilter.ts:225`, `engine.ts:3359,3368`) read `card.cmc` without adding `item.xValue`. |
| 202.3f | Hybrid mana symbol mana value uses largest component (e.g. `{2/B}` = 2) | implemented | `parseManaCost` in `oracle.ts:176-184` adds `hybridExtraCmc += numVal - 1` for `{2/W}` symbols; Scryfall's `cmc` also follows 202.3f. |
| 202.3g | Phyrexian mana symbol contributes 1 to mana value | implemented | `parseManaCost` in `oracle.ts:170-187` counts `{W/P}` as 1 colored symbol toward `totalCmc`. |
| 202.4 | Additional costs are not part of mana cost (don't change mana value) | implemented | Additional costs are tracked separately in `spellAdditionalCost` (`runtime/costs.ts:70-78`) and do not alter `card.cmc`. |

### 203 Illustration
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 203.1 | Illustration has no effect on gameplay | N/A (definition) | `imageUrl` and `artCropUrl` (`types.ts:75-76`) are UI-only. |

### 204 Color Indicator
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 204.1–204.2 | Color indicator defines object's colors | implemented | Included in `ScryfallCard.colors` (`scryfall.ts:171`) and Layer 1 initialization (`runtime/layers.ts:977`). |

### 205 Type Line
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 205.1 | Type line contains card types, subtypes, and supertypes | implemented | Parsed in `buildCharacteristics` (`compiler/adapter.ts:1207-1216`) and `runtime/objectFilter.ts:72-86`. |
| 205.1a | Setting card types/subtypes replaces existing ones of that category; correlated subtypes removed when type lost | partial | Layer 4 `setTypes` (`runtime/layers.ts:1119-1126`) and `setSubtypes` (`layers.ts:1173-1188`) overwrite types/subtypes, but `setSubtypes` hardcodes `effectiveTypeLine = "${target.prefixLegendary}Land — ..."` (`layers.ts:1184`), which strips non-land card types (e.g. `Artifact` on an Artifact Land) and non-land subtypes instead of replacing only land subtypes. |
| 205.1b | Type-changing effects that retain prior types ("in addition to its other types", "artifact creature") | partial | `compiler/statics.ts:519` and `runtime/layers.ts:1198-1227` (`addTypes`) implement additive types for static abilities, and `layers.ts:1406-1431` handles attached "becomes a [subtype] artifact creature". One-shot resolving animation effects ("becomes a X/X ... creature until end of turn") are missing from `ir.ts` and `runtime/effects.ts`. |
| 205.2a–c | Card types list; multi-type objects satisfy all their types; tokens/copies have card types | implemented | `compiler/adapter.ts:77-87`, `runtime/layers.ts:1788-1793`, `runtime/objectFilter.ts:154-169`. |
| 205.3a–b | Subtypes printed after long dash; single words except "Time Lord" and Planes | implemented | `splitSubtypes` in `runtime/layers.ts:83-89` and `runtime/objectFilter.ts:73-86` explicitly preserve two-word `Time Lord` (citing CR 205.3m) and split other subtypes on whitespace. |
| 205.3c–d | Subtypes correlated to card types; object can't gain subtype without corresponding card type | partial | `NON_CREATURE_SUBTYPES` in `runtime/layers.ts:120-162` and `runtime/objectFilter.ts:29-70` separates creature subtypes from land/artifact/enchantment/planeswalker/spell subtypes, and `layers.ts:1806` checks `tLine.includes('Creature')` for `hasAllCreatureTypes`; however, `addSubtypeToTypeLine` (`layers.ts:219-225,1217-1226`) does not verify that `target.types` contains the correlated card type before adding a subtype (205.3d). |
| 205.3e | Choosing a subtype requires choosing a single valid subtype for that card type | missing | No `chooseSubtype` / "choose a creature type" prompt or runtime handler exists (`types.ts`, `runtime/choices.ts`). |
| 205.3f | Oracle card reference determines current subtypes | implemented | Uses Scryfall Oracle `type_line` (`scryfall.ts:165`). |
| 205.3g–k, 205.3m | Subtype lists: artifact (205.3g), enchantment (205.3h), land & basic land types (205.3i), planeswalker (205.3j), spell (205.3k), creature incl. "Time Lord" (205.3m) | implemented | `NON_CREATURE_SUBTYPES` and `BASIC_LAND_SUBTYPES` in `runtime/layers.ts:118-162` and `runtime/objectFilter.ts:29-70`; `splitSubtypes` (`layers.ts:83-89`) handles `Time Lord`. |
| 205.3n, 205.3p, 205.3r | Planar types (205.3n), Dungeon subtype Undercity (205.3p), types with no subtypes (205.3r) | N/A | Planechase, Archenemy, Vanguard, Conspiracy, and Dungeons are not supported. |
| 205.3q | Battle subtype: Siege | partial | Recognized as a subtype string in `compiler/normalize.ts:35` and `runtime/objectFilter.ts`, but Siege mechanics (CR 310.12) are unimplemented. |
| 205.4a | Supertypes list (`Basic`, `Legendary`, `Ongoing`, `Snow`, `World`) | implemented | `SUPERTYPES` in `compiler/adapter.ts:75`, `compiler/costs.ts:48`, `compiler/statics.ts:71`. |
| 205.4b | Supertype is independent of card type and subtype; changing types/subtypes preserves supertypes | partial | `addCardTypeToTypeLine` (`runtime/layers.ts:227-234`) preserves supertypes, but `setTypes` (`layers.ts:1122-1125`) and `setSubtypes` (`layers.ts:1184`) overwrite `effectiveTypeLine` using only `target.prefixLegendary`, dropping `Basic`, `Snow`, and `World` supertypes. |
| 205.4c | `Basic` supertype defines basic vs nonbasic land | implemented | Checked via `supertypes` / `typeLine.includes('Basic')` in `runtime/objectFilter.ts:146-152` and `oracle.ts:1671`. |
| 205.4d | `Legendary` supertype subjects permanent to legend rule | partial | Checked in `engine.ts:6683-6702`, but auto-keeps newest instead of prompting controller (see 704.5j). |
| 205.4e | `Legendary` instant or sorcery casting restriction | missing | Not checked in `checkSpellCastLegality` (`engine.ts:7901-8053`). |
| 205.4f | `World` supertype subjects permanent to world rule (704.5k) | missing | `World` is in `SUPERTYPES` (`compiler/adapter.ts:75`), but `checkStateBasedActions` (`engine.ts:6538-7033`) has no world-rule SBA. |
| 205.4g | `Snow` supertype defines snow permanent | partial | `Snow` is parsed as a supertype in `compiler/adapter.ts:75`, `compiler/costs.ts:48`, `compiler/statics.ts:71` and matched by `runtime/objectFilter.ts:146-152`, but `{S}` snow mana costs/payments are not implemented in `oracle.ts:141-206`. |
| 205.4h | `Ongoing` scheme supertype | N/A | Archenemy variant not supported. |

### 206 Expansion Symbol
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 206.1–206.2, 206.4–206.5 | Expansion symbol and rarity have no gameplay effect; any printing legal | N/A (definition) | `setCode` and `rarity` (`types.ts:77-78`) are metadata only. |
| 206.3, 206.3a–c | Set-expansion errata lists (City in a Bottle, Golgothian Sylex, Apocalypse Chime) | N/A | None of these three cards are implemented. |

### 207 Text Box
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 207.1–207.2, 207.2a–b | Rules text; reminder text in parentheses and flavor text have no game function | implemented | `stripReminderText` in `compiler/normalize.ts:53-55` strips parenthesized reminder text; Scryfall `oracle_text` excludes flavor text (`scryfall.ts:166-169`). |
| 207.2c–d | Ability words and flavor words in italics before an em dash have no special rules meaning | implemented | `ABILITY_WORD` regex in `compiler/normalize.ts:39,108-120` strips ability/flavor words before ` — ` so the body is compiled normally. |
| 207.3–207.5 | Watermarks, Planechase chaos symbol, Cryptic Spires | N/A | Physical/Planechase/Cryptic Spires draft card not applicable. |

### 208 Power/Toughness
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 208.1 | Printed P/T; modified or set by continuous effects | implemented | `buildCharacteristics` (`compiler/adapter.ts:1217-1225`) and Layer 7 in `runtime/layers.ts:1317-1748`. |
| 208.2, 208.2a | `*` P/T with characteristic-defining ability (CDA) functions in all zones; undefined values = 0 | partial | On the battlefield, Layer 7a evaluates `setBasePT` CDAs (`runtime/layers.ts:1326-1342`), and `evaluateLayerAmount` defaults unknown values to 0. Off the battlefield, `buildOffBattlefieldBreakdown` (`layers.ts:1881-1914`) and `matchesObjectFilter` (`runtime/objectFilter.ts:217-224`) do not evaluate Layer 7a CDAs, treating `*` as `null`/`0`. |
| 208.2b | `*` P/T set by ETB/turn-face-up replacement effect is 0 off-battlefield | partial | Off-battlefield `*` parses as `undefined` (`compiler/adapter.ts:1203-1204`) and defaults to `0`, but "enters as [choice of P/T]" replacement effects (e.g. Primal Clay) are not implemented. |
| 208.3 | Noncreature permanent has no P/T on battlefield; noncreature card off-battlefield has printed P/T | partial | On battlefield, `runtime/layers.ts:1318-1321` sets `workingPower = null` and `workingToughness = null` when `!isCreature`. However, `EvaluatedPermanent.power` and `.toughness` coerce `null` to `0` (`layers.ts:1798-1799`), and in `runtime/objectFilter.ts:217-224` off-battlefield Vehicles (`!typeLine.includes('Creature')`) fail `filter.power`/`filter.toughness` checks even though 208.3 says noncreature objects off the battlefield with printed P/T (Vehicles) have P/T. |
| 208.3a | Continuous P/T effects created on a noncreature permanent still exist and apply if it becomes a creature | partial | `tempPowerMod` and `tempToughnessMod` (`runtime/effects.ts:863-864`) and counters can be placed on any permanent and are applied in Layer 7c (`runtime/layers.ts:1726-1739`) once `isCreature` is true; however, global Layer 7b setters skip noncreatures (`layers.ts:1295`), which is fine since Layer 4 runs before Layer 7b. |
| 208.4, 208.4a | Effects setting "base power and/or toughness" apply in Layer 7b | implemented | Compiled as `layer: '7b', mod: { k: 'setBasePT' }` (`compiler/statics.ts:510-530`) and applied in timestamp order before Layer 7c (`runtime/layers.ts:1345-1356`). |
| 208.4b | Effects that check a creature's base power/toughness see Layer 7a/7b value ignoring Layer 7c | missing | `Amount` (`ir.ts:260`) only supports `stat: 'power' | 'toughness' | 'manaValue'`, and `CardContinuousBreakdown.basePower` (`runtime/layers.ts:1760`) stores printed Layer 1 P/T rather than post-7a/7b base P/T. |
| 208.5 | Creature with no value for power or toughness has 0 | implemented | `runtime/layers.ts:1323-1324`: `if (target.workingPower === null) target.workingPower = 0; if (target.workingToughness === null) target.workingToughness = 0;`. |

### 209 Loyalty
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 209.1 | Printed loyalty; enters the battlefield with that many loyalty counters | implemented | `runtime/zones.ts:273-286` (with `counterMultiplier`) and `engine.ts:230-232`. |
| 209.2 | Loyalty ability activation timing (main phase, stack empty, once per turn per permanent) | implemented | `checkAbilityActivationLegality` (`engine.ts:8130-8147`), `usedLoyaltyThisTurn` set on activation (`engine.ts:1645`) and reset at untap (`engine.ts:957`) and on leaving battlefield (`runtime/zones.ts:262`). |

### 210 Defense
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 210.1 | Battle printed defense; enters with defense counters | missing | `ScryfallCard` (`types.ts:61-95`) has no `defense` field, `CounterType` (`types.ts:188-196`) has no `'defense'` counter, and `runtime/zones.ts:273-286` only places loyalty counters. |

### 211–213 Hand Modifier, Life Modifier, Information Below the Text Box
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 211.1, 212.1 | Vanguard hand and life modifiers | N/A | Vanguard variant not supported. |
| 213.1, 213.1a–g | Collector number, rarity letter, promo text, set/language codes, artist credit, legal text | N/A (definition) | Collector metadata has no gameplay effect (201.3 interchangeable names covered under 201.3). |

---

### 300 General (Card Types)
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 300.1–300.2 | Card types list; multi-type objects combine aspects of each type | implemented | `compiler/adapter.ts:77-87`, `runtime/layers.ts:1788-1793`, `runtime/objectFilter.ts:154-169`. |
| 300.2a | Object that is both a land and another card type can only be played as a land, never cast | partial | `checkLandPlayLegality` (`engine.ts:7870`) allows any card whose `typeLine.includes('Land')` to be played as a land, and `checkSpellCastLegality` (`engine.ts:7929`) blocks `typeLine.includes('Land') && !typeLine.includes('Creature')` (covering Artifact Lands / Enchantment Lands), **but** fails for Land Creatures (`Dryad Arbor` can be cast as a spell) and misfires on noncreature MDFCs with a land back face (`scryfall.ts:165`). |
| 300.2b | Kindred card follows casting/resolution rules of its other card type | implemented | Casting (`engine.ts:7951`) and resolution (`engine.ts:4173-4178`) dispatch on `Instant`/`Sorcery`/permanent types regardless of `Kindred`/`Tribal` on the type line. |

### 301 Artifacts
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 301.1–301.2 | Casting artifact (main phase, stack empty, priority); resolves to battlefield | implemented | `checkSpellCastLegality` (`engine.ts:7951-7974`) and `resolveTopOfStack` (`engine.ts:4173-4265`). |
| 301.3–301.4 | Artifact subtypes; artifacts have no type-specific characteristics and may be colored | implemented | `compiler/adapter.ts:1207-1226`, `runtime/layers.ts:120-162`. |
| 301.5, 301.5a–b | Equipment subtype; attaches to creature; equip keyword attaches to creature you control | implemented | `compiler/adapter.ts:329-349` compiles `Equip` as a sorcery-speed activated ability with `attach` targeting `{ types: ['Creature'], controller: 'you' }`; resolved in `runtime/effects.ts:906-924` and `engine.ts:4564-4592`. |
| 301.5c | Equipment creature can't equip (unless reconfigure); can't equip itself; SBA unattaches illegal/nonexistent | partial | SBA unattaches Equipment if target is missing, not a creature, or has protection (`engine.ts:6636-6646`), and single `attachedToId` prevents equipping multiple creatures. **Missing**: neither `engine.ts:6636` nor `runtime/effects.ts:906-924` checks if the Equipment itself is a creature (`evalPerm.isCreature`) or if `equipment.inst.instanceId === found.inst.instanceId` (equipping itself). |
| 301.5d | Equipment controller is separate from equipped creature's controller; granted abilities activated by creature's controller | implemented | `attachedToId` (`types.ts:360`) does not change `controllerId` (`runtime/zones.ts:418-437`), and abilities granted to the equipped creature via Layer 6 (`runtime/layers.ts:1443-1474`) appear on the equipped creature (`getEffectiveActivatedAbilities` in `engine.ts:83-213`). |
| 301.5e | Equipment entering battlefield attached to illegal/undefined object enters unattached | implemented | Equipment enters with `attachedToId: null` (`engine.ts:248`). |
| 301.5f | "Equipped creature" refers to whatever creature the permanent is attached to | implemented | Compiled as `affected: 'attachedTo'` (`compiler/statics.ts`, `runtime/layers.ts:1382`). |
| 301.6 | Fortification subtype and Fortify keyword (attaches to land) | missing | `'Fortification'` is in `NON_CREATURE_SUBTYPES` (`runtime/layers.ts:143`) and `'fortify'` is in `KNOWN_KEYWORDS` (`compiler/adapter.ts:138`), but Fortify is not compiled or handled in SBAs (`engine.ts:6612`). |
| 301.7, 301.7a–b | Vehicle subtype and Crew keyword; printed P/T applies only when it becomes a creature | partial | `301.7a` is implemented on the battlefield (`runtime/layers.ts:1318-1321` nulls P/T when `!isCreature`, and `981-982` keeps `basePower`/`baseToughness` ready if it becomes a creature per `301.7b`), but `crew` (`compiler/adapter.ts:133`) and creature-animation effects are unimplemented so a Vehicle can never crew. |

### 302 Creatures
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 302.1–302.3 | Casting creature; resolves to battlefield; creature subtypes | implemented | `engine.ts:7951-7974`, `engine.ts:4173-4265`, `runtime/layers.ts:83-162`. |
| 302.4, 302.4a–c | Power and toughness characteristics; combat damage = power; lethal damage = toughness; continuous effects | implemented | `runtime/layers.ts:1318-1748`, combat damage in `engine.ts:6095-6350`, lethal damage SBA in `engine.ts:6662-6674`. |
| 302.5 | Creatures can attack and block | implemented | `declare_attackers` and `declare_blockers` in `engine.ts:1710-2080`. |
| 302.6 | Summoning sickness: creature can't attack or activate `{T}`/`{Q}` abilities unless controlled continuously since turn began (or haste) | implemented | `summoningSick` set on ETB (`engine.ts:238,4200`) and control change (`runtime/zones.ts:426`), cleared at untap step for active player (`engine.ts:956`), checked for `{T}`/`{Q}` costs in `runtime/costs.ts:393-395` (only when `evaluatePermanent(ctx.state, src).isCreature && src.summoningSick && !hasHaste`) and for attacking in `engine.ts:1762`. |
| 302.7 | Damage marked on creature; lethal damage SBA destroys; removed on regenerate and cleanup | implemented | Damage marking in `runtime/effects.ts:1166` and `engine.ts:6163`, SBA destruction in `engine.ts:6662-6674`, cleanup removal in `clearEndOfTurnAndDamage` (`engine.ts:6426`). |

### 303 Enchantments
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 303.1–303.3 | Casting enchantment; resolves to battlefield; enchantment subtypes | implemented | `engine.ts:7951-7974`, `engine.ts:4173-4265`, `runtime/layers.ts:120-162`. |
| 303.4, 303.4a–b | Aura subtype; requires a target defined by `Enchant` when cast; enters attached | partial | Permanent-targeting Auras require a target (`oracle.ts:1700-1735`) and enter attached on spell resolution (`engine.ts:4241-4243`). **Bug**: `engine.ts:4241` checks `item.targets[0]?.kind === 'permanent'`, so `Enchant player` Auras (Curses) never set `attachedToId` on resolution. |
| 303.4c | SBA puts Aura into owner's graveyard if attached to illegal/nonexistent object or player | partial | `checkStateBasedActions` (`engine.ts:6615-6635`) and `isAuraAttachmentLegal` (`engine.ts:6475-6532`) check permanent hosts, protection, controller, and types. **Bugs**: (1) `findPermanentOnBoard` fails for player hosts (`Enchant player`), immediately killing Curses; (2) `isAuraAttachmentLegal` does not check `enchant creature with ...` power/toughness/mana-value/tapped filters. |
| 303.4d | Aura can't enchant itself; Aura that is also a creature can't enchant anything (SBA); single host | partial | Single `attachedToId` enforces single host, but `isAuraAttachmentLegal` (`engine.ts:6475-6532`) and `checkStateBasedActions` (`engine.ts:6615-6635`) do **not** check `aura.instanceId === host.instanceId` or `evalPerm.isCreature` (an animated Aura creature stays attached instead of going to the graveyard). |
| 303.4e | Aura controller separate from enchanted object's controller; granted abilities activated by enchanted object's controller | implemented | `runtime/zones.ts:418-437` and `runtime/layers.ts:1443-1474` / `engine.ts:83-213`. |
| 303.4f–g | Aura entering battlefield without being cast: controller chooses legal host, or remains in previous zone (graveyard if from stack) | missing | Moving an Aura to the battlefield via reanimation/put effects (`runtime/effects.ts:1565-1571`, `engine.ts:5043-5048`) puts it onto the battlefield with `attachedToId = null`, where SBA 303.4c immediately sends it to the graveyard. |
| 303.4h | Non-Aura/Equipment/Fortification permanent entering attached enters unattached | implemented | `createCardInstance` (`engine.ts:248`) initializes `attachedToId: null` and non-attachment permanents have no attachment path. |
| 303.4i–k | Effect putting Aura onto battlefield attached to illegal host; attaching Aura on battlefield to illegal host; turning Aura face up | missing | No effect puts an Aura onto the battlefield attached or moves an Aura attachment on the battlefield (`runtime/effects.ts:906-924` `attach` is hardcoded to creatures you control for Equipment). |
| 303.4m | "Enchanted [object/player]" refers to attached object even if permanent isn't an Aura | implemented | Compiled as `affected: 'attachedTo'` (`compiler/statics.ts`, `runtime/layers.ts:1382`). |
| 303.5–303.6 | Saga (303.5) and Class (303.6) subtypes | missing | `'Saga'` and `'Class'` are in `NON_CREATURE_SUBTYPES` (`runtime/layers.ts:154-155`), but `compiler/adapter.ts:245-256` marks Saga chapters and Class levels as `unsupported`. |
| 303.7, 303.7a | Role Aura subtype and Role uniqueness SBA (one Role per controller per permanent) | missing | `'Role'` is in `NON_CREATURE_SUBTYPES` (`runtime/layers.ts:153`), but `checkStateBasedActions` (`engine.ts:6608-6703`) does not implement the Role SBA. |

### 304 Instants
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 304.1–304.2 | Casting instant any time player has priority; resolves then goes to owner's graveyard | implemented | `checkSpellCastLegality` (`engine.ts:7935,7951-7955`) and `resolveTopOfStack` (`engine.ts:4284-4288`). |
| 304.3 | Instant subtypes (spell types) | implemented | `NON_CREATURE_SUBTYPES` (`runtime/layers.ts:158-161`, `runtime/objectFilter.ts:66-69`). |
| 304.4 | Instants can't enter the battlefield; remain in previous zone instead | implemented | Enforced in `moveObjectInner` (`runtime/zones.ts:150-168`, citing CR 304.4 / 307.4). |
| 304.5 | "Any time you could cast an instant" means player has priority | implemented | `checkAbilityActivationLegality` (`engine.ts:8103-8105`). |

### 305 Lands
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 305.1 | Play a land during main phase when stack is empty and holding priority; special action (doesn't use stack) | implemented | `checkLandPlayLegality` (`engine.ts:7844-7899`) and `case 'play_land'` (`engine.ts:1278-1335`). |
| 305.2, 305.2a–b | Normally one land per turn; compare lands played with max lands allowed; ignore effects instructing illegal land play | partial | `actor.maxLandsPerTurn` + `getCardExtraLandPlays` compared against `actor.landsPlayedThisTurn` in `engine.ts:7887-7897`. `getCardExtraLandPlays` (`oracle.ts:121-131`) is a legacy regex on battlefield permanents; one-shot "You may play an additional land this turn" effects (Explore) do not increment `maxLandsPerTurn`. |
| 305.3 | Player can't play a land if it isn't their turn | implemented | `checkLandPlayLegality` (`engine.ts:7875-7877`). |
| 305.4 | "Putting" a land onto the battlefield is not playing a land and doesn't count toward land limit | implemented | Library search / ramp effects call `moveObject(..., 'battlefield', ...)` directly without incrementing `landsPlayedThisTurn` (`engine.ts:2610-2625`, `runtime/effects.ts:1565`). |
| 305.5–305.6 | Land subtypes; basic land types (`Plains`, `Island`, `Swamp`, `Mountain`, `Forest`) grant intrinsic `{T}: Add` mana abilities | implemented | `BASIC_LAND_MANA` in `compiler/adapter.ts:236-241` and `BASIC_LAND_MANA_BY_SUBTYPE` in `runtime/layers.ts:110-118,1625-1670` (grants intrinsic mana abilities when a land has or gains a basic land subtype). |
| 305.7 | Setting a land's subtype to basic land type(s) removes rules-text abilities and old land types; preserves card types and supertypes | partial | `runtime/layers.ts:1128-1134` (attached `setTypes`) and `1183-1188` (global `setSubtypes`) strip innate abilities and grant the new basic land mana ability (`layers.ts:1625-1670`). **Bug**: `layers.ts:1184` rewrites `effectiveTypeLine` to `${target.prefixLegendary}Land — ${st.mod.subtypes.join(' ')}`, which removes `Basic`/`Snow` supertypes and removes `Artifact`/`Creature` card types from `effectiveTypeLine` (violating "Setting a land's subtype doesn't add or remove any card types (such as creature) or supertypes (such as basic, legendary, and snow)"). |
| 305.8 | Any land with supertype `Basic` is a basic land; others are nonbasic even with basic land types | implemented | `runtime/objectFilter.ts:146-152` checks supertypes (`Basic`) separately from land subtypes. |
| 305.9 | Object that is both a land and another card type can be played only as a land, never cast | partial | Same as CR 300.2a (`engine.ts:7870,7929` fails for Land Creatures and noncreature/land MDFCs). |

### 306 Planeswalkers
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 306.1–306.3 | Casting planeswalker; resolves to battlefield; planeswalker subtypes | implemented | `engine.ts:7951-7974`, `engine.ts:4173-4265`, `runtime/layers.ts:120-162`. |
| 306.4 | Planeswalkers use the legend rule (old planeswalker uniqueness rule removed) | implemented | Handled by the normal `Legendary` SBA in `engine.ts:6683-6702`. |
| 306.5, 306.5a–c | Loyalty characteristic; enters with printed loyalty counters (replacement effect); battlefield loyalty = loyalty counters | implemented | `compiler/adapter.ts:1219-1222`, `runtime/zones.ts:273-286` (applies `counterMultiplier` on entering battlefield), and `perm.counters.loyalty`. |
| 306.5d | Loyalty abilities activated at sorcery speed once per turn per permanent | implemented | `checkAbilityActivationLegality` (`engine.ts:8130-8147`) and `runtime/costs.ts:61,407-409`. |
| 306.6 | Planeswalkers can be attacked | missing | `declare_attackers` in `engine.ts:1710-1880` and `AttackAssignment` (`types.ts:471-476`: `defendingPlayerId: string`) only allow attacking players, not planeswalkers! |
| 306.7 | Old noncombat damage redirection rule removed | implemented (N/A) | No obsolete redirection rule exists. |
| 306.8 | Damage dealt to a planeswalker removes that many loyalty counters | implemented | `runtime/effects.ts:1157-1160` (`target.counters.loyalty = Math.max(0, (target.counters.loyalty || 0) - dmg)`) and `engine.ts:8342-8343`. |
| 306.9 | SBA: Planeswalker with 0 loyalty is put into owner's graveyard | implemented | `checkStateBasedActions` (`engine.ts:6675-6677`). |

### 307 Sorceries
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 307.1–307.3 | Casting sorcery (main phase, stack empty, priority); resolves then goes to graveyard; spell subtypes | implemented | `checkSpellCastLegality` (`engine.ts:7951-7974`), `resolveTopOfStack` (`engine.ts:4284-4288`), `runtime/layers.ts:158-161`. |
| 307.4 | Sorceries can't enter the battlefield; remain in previous zone instead | implemented | Enforced in `moveObjectInner` (`runtime/zones.ts:150-168`). |
| 307.5, 307.5a | "As a sorcery" timing means active player's main phase with empty stack and priority | implemented | `checkAbilityActivationLegality` (`engine.ts:8117-8128`). (`307.5a` checking whether a spell was cast any time a sorcery couldn't have been cast is not used by any supported card.) |

### 308 Kindreds
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 308.1–308.3 | Kindred (formerly Tribal) shares creature subtypes and follows other card type's casting/resolution rules | implemented | Both `'Kindred'` and `'Tribal'` are in `CARD_TYPES` (`compiler/adapter.ts:82,86`), and `NON_CREATURE_SUBTYPES` (`runtime/layers.ts:120-162`) leaves all creature subtypes available to Kindred cards. |

### 309 Dungeons
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 309.1–309.7 | Dungeon cards, venture into the dungeon, command zone placement, room triggers, dungeon completion SBA | missing | Completely unimplemented (no `venture` keyword action or dungeon state in `types.ts`, `engine.ts`, or `runtime/`). |

### 310 Battles
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 310.1–310.3 | Casting battle; resolves to battlefield; battle subtype `Siege` | partial | Battles can be cast at sorcery speed and resolve onto the battlefield (`engine.ts:4178`, `runtime/zones.ts:161`), and `Battle` is recognized in filters (`compiler/costs.ts:39`, `compiler/statics.ts:63`). |
| 310.4, 310.4a–c | Defense characteristic; enters with printed defense counters | missing | `ScryfallCard` has no `defense` field and `zones.ts` does not place defense counters. |
| 310.5–310.8 | Battles can be attacked; damage removes defense counters; 0-defense SBA | missing | Combat only attacks players (`types.ts:471-476`), damage does not remove defense counters (`runtime/effects.ts:1156-1173`), and SBAs do not check battle defense (`engine.ts:6657-6681`). |
| 310.9, 310.9a–g, 310.10–310.11 | Battle protector choice, attacking/blocking rules, battle attachment SBA, invalid protector SBA | missing | No protector field or logic exists on `CardInstance` (`types.ts:346-384`). |
| 310.12, 310.12a–b | Siege opponent protector choice; 0-defense exile-and-cast-transformed trigger | missing | Unimplemented. |

### 311–315 Planes, Phenomena, Vanguards, Schemes, Conspiracies
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 311.1–311.7 | Plane cards (Planechase variant) | N/A | Non-Commander casual variant (Planechase) not supported. |
| 312.1–312.7 | Phenomenon cards (Planechase variant) | N/A | Non-Commander casual variant (Planechase) not supported. |
| 313.1–313.7 | Vanguard cards (Vanguard variant) | N/A | Non-Commander casual variant (Vanguard) not supported. |
| 314.1–314.7 | Scheme cards (Archenemy variant) | N/A | Non-Commander casual variant (Archenemy) not supported. |
| 315.1–315.7 | Conspiracy cards (Conspiracy Draft limited variant) | N/A | Limited draft variant not supported. |

---

### 400 General (Zones)
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 400.1 | Seven normal zones (`library`, `hand`, `battlefield`, `graveyard`, `stack`, `exile`, `command`) | implemented | `ZoneType` (`types.ts:5-12`) and `PlayerZone` (`runtime/zones.ts:22`). Per-player arrays hold `library`, `hand`, `battlefield`, `graveyard`, `exile`, and `command`; `state.stack` is shared (`types.ts:747`). |
| 400.2 | Public zones vs hidden zones (`library`, `hand`) | implemented | Enforced by UI/lobby serialization and `GUIDED_ZONES` (`engine.ts:2917`). |
| 400.3 | Object going to library, graveyard, or hand always goes to its owner's zone | implemented | `runtime/zones.ts:233-237`: `const effectiveReceiver = (dest === 'hand' || dest === 'graveyard' || dest === 'library' || dest === 'command') && owner ? owner : receiver;`. |
| 400.4, 400.4a | Instant or sorcery card can't enter the battlefield; remains in previous zone | implemented | `moveObjectInner` in `runtime/zones.ts:150-168`. |
| 400.4b | Conspiracy, phenomenon, plane, scheme, or vanguard can't leave command zone | N/A | Those nontraditional card types are not used in Commander. |
| 400.5 | Order of objects in library, graveyard, and stack cannot be changed except by rules/effects | implemented | Zone arrays are only mutated through `runtime/zones.ts` helpers (`moveObject`, `shuffleLibrary`, `rearrangeLibrary`, `setZoneOrder`) and `state.stack`. |
| 400.6 | Zone-change replacement effects applied before move; controller/owner chooses between contradictory effects | partial | Graveyard replacement (`checkGraveyardReplacementZone` in `runtime/zones.ts:222-224`), commander redirect (`zones.ts:225-231`), and ETB replacements (`applySelfEtbReplacements` in `engine.ts:4244`, `runtime/replace.ts`) are applied, but competing replacement effects are applied in fixed code order rather than prompting the controller/owner to choose. |
| 400.7 | Object moving zones becomes a new object with no memory of previous existence | implemented | `moveObjectInner` (`runtime/zones.ts:239-271`) resets battlefield state (`leaveBattlefieldReset`), increments `objectVersion` (`bumpVersion`), and allocates a new timestamp (`newTimestamp`); target validation checks `targetObjectVersions` (`engine.ts:8207-8246`). Note: as documented in `zones.ts:17-20`, callers must pass `bumpVersion: true` / `leaveBattlefieldReset: true` explicitly, and a few callers (e.g. `engine.ts:6387` cleanup discard) omit `bumpVersion: true`. |
| 400.7a–c | Spell-to-permanent exceptions (characteristic/control changes, static abilities, damage prevention on permanent spell) | missing | Resolving a permanent spell creates a fresh `CardInstance` from `item.card` (`engine.ts:4189-4204`) without carrying over any continuous/control/prevention effects applied to the `StackItem`. |
| 400.7d | Permanent ability can reference costs paid or mana spent to cast the spell that became it | partial | `perm.enteredWithX = item.xValue` (`engine.ts:4201`) preserves X from the stack spell; specific colors of mana spent or other additional costs paid are not tracked on `CardInstance`. |
| 400.7e | Zone-change triggers can find the new object in a public destination zone | implemented | `ZoneChange` events pass `object: obj` (`runtime/zones.ts:351`), and `triggeredStackItem` records `eventObjectId` and `eventObjectVersion` (`engine.ts:3403-3404`), allowing `eventObject` refs (`runtime/effects.ts:550,640`) to find the object in its new zone. |
| 400.7f | Triggers on enchanted permanent leaving battlefield can find Auras put into graveyard at same time or via SBA | missing | No LKI link from a leaving permanent to its formerly attached Auras in the graveyard is recorded in `LeftBattlefieldInfo` (`runtime/zones.ts:311-330`). |
| 400.7g–i | Cast/play permissions from effects continue to apply to the spell on the stack or land on the battlefield | implemented | `playableFromExileBy` (`types.ts:378`, `engine.ts:7860,7920`) permits casting/playing the card and is cleared after leaving the zone (`engine.ts:1540`). |
| 400.7j | Effect (or cost) moving an object to a public zone allows later steps of the same effect to find it | implemented | Effect steps bind moved objects via `this.bind(step, ...)` (`runtime/effects.ts:1410,1499,1529,1554`), which subsequent steps reference via `{ k: 'binding', name }`. |
| 400.7k, 400.7m | Madness discarded-card tracking (400.7k); Stickers retained between public zones (400.7m) | N/A | Madness (`compiler/adapter.ts:141`) is unimplemented; Stickers/Un-set mechanics are N/A. |
| 400.8 | Exiled object becoming exiled again becomes a new object | missing | `runtime/effects.ts:1530-1539` only exiles objects from `'battlefield'` or `'graveyard'`, ignoring objects already in `'exile'`. |
| 400.9 | Face-up object in command zone turned face down becomes a new object | N/A | Only applies to Planechase/Archenemy/Conspiracy cards in the command zone. |
| 400.10 | Object in command zone put into command zone becomes a new object | partial | `moveObject` supports `bumpVersion: true`, though nothing currently moves a command-zone object to the command zone. |
| 400.11, 400.11a–c | Outside the game is not a zone; sideboards/wishes | N/A | Commander does not use sideboards or wishboards, and no wish effects are implemented. |
| 400.12 | Effects acting on a zone ("Shuffle your hand into your library") act on all cards in that zone | implemented | Handled by iterating all cards in the zone (e.g. `exile` all from graveyard in `runtime/effects.ts:1516-1526`, `mulliganRedraw` in `runtime/zones.ts:461-481`). |

### 401 Library
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 401.1–401.3 | Deck becomes library at start of game; single face-down pile; any player may count cards | implemented | `createInitialGameState` (`engine.ts:326-360`) shuffles the deck into `player.library`; library count `player.library.length` is public while card faces are hidden. |
| 401.4 | Multiple cards put into a specific position in a library simultaneously are ordered by owner | partial | Scry and `rearrange_top` prompt the player with `orderObjects` (`engine.ts:4040-4070`, `runtime/choices.ts`), but other multi-card moves to a library do not prompt the owner to order them. |
| 401.5–401.6 | Playing with top card of library revealed / looking at top card; stops being revealed -> new object | missing | Static effects that reveal or allow playing the top card of the library (`Future Sight`, `Courser of Kruphix`) are not implemented in `compiler/statics.ts` or `engine.ts:7860,7920`. |
| 401.7 | Putting a card "Nth from the top" into a library with fewer than N cards puts it on the bottom | implemented | `Array.prototype.splice(at, 0, obj)` in `insertInto` (`runtime/zones.ts:126`) naturally appends at the end (bottom of library) when `at >= list.length`. |

### 402 Hand
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 402.1 | Hand holds drawn cards; starting hand size normally 7 | implemented | `createInitialGameState` (`engine.ts:352`) draws 7 cards into `player.hand`; `drawCards` (`engine.ts:902-936`). |
| 402.2 | Maximum hand size normally 7; discard excess during cleanup step | implemented | `runCleanupStep` (`engine.ts:6373-6418`) checks `state.rules.maxHandSize` (default 7) and `playerHasNoMaxHandSize` (Reliquary Tower, Thought Vessel, etc.), prompting humans (`discard_to_hand_size`) and auto-discarding for bots. |
| 402.3 | Player may look at/arrange own hand; other players see only hand count | implemented | `ArenaTable.svelte` and lobby state expose `hand.length` to opponents and full hand to owner. |

### 403 Battlefield
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 403.1 | Battlefield starts empty; permanents kept in front of controller | implemented | `player.battlefield` starts as `[]` (`engine.ts:331`). |
| 403.2 | Spell or ability affects and checks only the battlefield unless another zone is mentioned | implemented | `ObjectFilter.zone` defaults to `'battlefield'` across `runtime/objectFilter.ts`, `runtime/effects.ts:648`, and `engine.ts:3522`. |
| 403.3 | Permanents exist only on the battlefield; every object on the battlefield is a permanent | implemented | Enforced by `player.battlefield` and `moveObjectInner` (`runtime/zones.ts:150-168`). |
| 403.4–403.5 | Entering battlefield creates a new object (`objectVersion` / `enteredTimestamp`); "in play" errata | implemented | `runtime/zones.ts:270-271`, `engine.ts:4189-4195`; Oracle text uses "battlefield". |

### 404 Graveyard
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 404.1 | Graveyard is owner's discard pile; countered/discarded/destroyed/sacrificed/resolved objects go on top | implemented | `player.graveyard` starts empty; `insertInto` pushes to the end of `player.graveyard` (`runtime/zones.ts:48,124`: top of graveyard is the end of the array). |
| 404.2 | Graveyard is a single face-up pile; any player may examine; order preserved | implemented | Publicly visible in UI; `topmostOnly` in `runtime/effects.ts:1550-1553` and `engine.ts:4998` ("Corpse Dance ... CR 404.2") reads `graveyard[graveyard.length - 1]`. |
| 404.3 | Multiple cards put into the same graveyard simultaneously are ordered by owner | missing | Simultaneous SBA deaths (`engine.ts:6755-6816`), board wipes (`runtime/effects.ts:794-798`), and multi-card discards/mills (`runtime/effects.ts:1003-1017,1500-1503`) insert cards into the graveyard in iteration order without prompting the owner. |

### 405 Stack
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 405.1–405.2 | Spells, activated abilities, and triggered abilities go on top of the stack; LIFO order | implemented | `state.stack.push(...)` (`engine.ts:1562,1678,3636`) and `state.stack[state.stack.length - 1]` resolved first in `resolveTopOfStack` (`engine.ts:3786`). |
| 405.3 | Simultaneous stack objects placed in APNAP order; controller chooses relative order | implemented | `flushTriggers` (`runtime/triggers.ts:832-851`) iterates `apnap(state)` and calls `host.orderSimultaneous` (`askTriggerOrder` in `engine.ts:3680`), which prompts human players with an `orderObjects` choice when they control 2+ simultaneous triggers. |
| 405.4 | Spell has card characteristics; ability on stack has text and no card characteristics; controller rules | partial | `StackItem` (`types.ts:424-465`) tracks `controllerId` and `kind: 'spell' | 'activated' | 'triggered'`. However, `StackItem.card` holds the source `ScryfallCard` even for `'activated'` and `'triggered'` items (`engine.ts:3392`), so code that inspects `item.card` without checking `item.kind === 'spell'` sees the source card's characteristics. |
| 405.5 | When all players pass in succession, top stack object resolves; if empty, step/phase ends | implemented | `case 'pass_priority'` in `engine.ts:2100-2175`. |
| 405.6, 405.6a–h | Things that don't use the stack: resolving effects (405.6a), static abilities/CDAs (405.6b), mana abilities (405.6c), special actions (405.6d), turn-based actions (405.6e), SBAs (405.6f), conceding (405.6g), player leaving multiplayer game (405.6h) | implemented | Effects (`runtime/effects.ts`), statics (`runtime/layers.ts`), mana abilities (`engine.ts:1234,1605` resolve immediately without stack), land/suspend special actions (`engine.ts:1278,1337`), untap/draw/cleanup TBAs (`engine.ts:944,1059,6373`), SBAs (`engine.ts:6538`), concede/elimination cleanup (`engine.ts:1155,7035`). |

### 406 Exile
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 406.1–406.2 | Exile zone is a holding area; `exile` moves object from current zone to exile | implemented | `player.exile` (`types.ts:535`) and `moveObject(state, obj, 'exile', ...)` (`runtime/zones.ts:133`, `runtime/effects.ts:1506-1542`). |
| 406.3, 406.3a–b, 406.4 | Exiled cards face up by default; face-down exile rules, looking permissions, piles, and casting | missing | All exiled cards are kept face up in `player.exile`; `runtime/zones.ts:264` resets `obj.isFaceDown = false` on leaving the battlefield, and no face-down exile piles or per-player view permissions exist. |
| 406.5 | Exiled cards that may return or have abilities tracked appropriately | partial | `playableFromExileBy` (`types.ts:378`), `isSuspended` (`types.ts:373`), and `DelayedTrigger.targetInstanceId` (`types.ts:413`) track individual exiled cards with return/play permissions. |
| 406.6 | Linked abilities referring to "the exiled cards" / "cards exiled with [this object]" | missing | No `exiledByInstanceId` or linked-ability tracking exists on `CardInstance` (`types.ts:346-384`) or in `runtime/effects.ts`. |
| 406.7 | Object in exile becoming exiled again becomes a new object | missing | Same as CR 400.8 (`runtime/effects.ts:1530-1539` does not exile cards already in exile). |
| 406.8 | "Removed from the game" / "set aside" errata means exile | implemented | Scryfall Oracle text uses "exile". |

### 407 Ante
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 407.1–407.4 | Ante zone and ante cards | N/A | Ante is forbidden in Commander / constructed play. |

### 408 Command
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 408.1, 408.3 | Command zone reserved for specialized objects (Commanders); cannot be destroyed | implemented | `player.command` (`types.ts:536`), initialized with commanders in `createInitialGameState` (`engine.ts:370-395`), Eminence statics/triggers active in `command` (`runtime/costs.ts:197-205`, `runtime/triggers.ts`). |
| 408.2 | Emblems may be created in the command zone | missing | No emblem creation verb or representation exists in `ir.ts`, `types.ts`, or `runtime/effects.ts`. |

---

## Silently skipped / approximated behaviour

- **Legend Rule auto-keeps newest permanent (`engine.ts:6695-6702`)**: Under CR 205.4d / 704.5j, when a player controls two or more legendary permanents with the same name, that player chooses one to keep. The engine silently keeps `list[list.length - 1]` (the most recently added to `battlefield`) and puts all earlier copies into the graveyard without prompting.
- **Clone fallback auto-picks highest-MV creature (`engine.ts:4211-4223`)**: When a `cardEntersAsCopyOfAnyCreature` spell resolves without a chosen target, the engine silently sorts all creatures on the battlefield by `b.card.cmc - a.card.cmc` and copies `allCreatures[0]` instead of prompting the controller (and makes the copy mandatory even on "you may" clones).
- **Aura entering the battlefield without being cast (`runtime/effects.ts:1565-1571`, `engine.ts:5043-5048`)**: Instead of prompting the controller to choose a legal object/player to enchant (CR 303.4f) or leaving the Aura in its previous zone if none exists (CR 303.4g), the engine puts the Aura onto the battlefield with `attachedToId = null`, causing `checkStateBasedActions` (`engine.ts:6616-6617`) to immediately put it into the graveyard.
- **Simultaneous graveyard/library zone changes (`engine.ts:6755-6816`, `runtime/effects.ts:794-798,1500-1503`)**: Under CR 401.4 and CR 404.3, when multiple cards are put into a library or graveyard simultaneously, their owner chooses their relative order. The engine inserts them in battlefield/hand array order without prompting, even though graveyard order is mechanically used by `topmostOnly` (`runtime/effects.ts:1550-1553`) and `Corpse Dance` (`engine.ts:4998`).
- **Bot commander bounce/tuck redirect (`runtime/zones.ts:225-231`)**: When a commander would be put into its owner's hand or library and `opts.commanderRedirect` is set, bots automatically redirect to `'command'`, whereas humans are not prompted by `moveObject` unless the caller separately creates a prompt.
- **Runaway trigger safety caps (`engine.ts:3597-3620`)**: After `MAX_STACK_FOR_TRIGGERS` (300) items on the stack or `MAX_TRIGGERS_PER_TURN` (200) triggered abilities in a turn, further triggered abilities are dropped with a log message (`addLog(state, 'rule', ...)`).

---

## Legacy-only findings (verify after step F)

- **Extra land plays (`CR 305.2`, `oracle.ts:121-131`, `engine.ts:7890`)**: Additional land plays per turn ("You may play an additional land on each of your turns") are only detected by `getCardExtraLandPlays(card)` in `oracle.ts:121-131` via regex on `card.oracleText` and are not represented as a `StaticDef` in `ir.ts` or `compiler/statics.ts`.
- **Mana cost parsing (`CR 202.1a, 202.3e–g`, `oracle.ts:141-295`)**: `parseManaCost` and `resolveFlexibleManaRequirement` (which implement hybrid `{W/U}`, twobrid `{2/W}`, Phyrexian `{W/P}`, and `{X}` mana cost requirements) live in `oracle.ts` and are imported by `runtime/costs.ts:18`.
- **Aura target requirements on cast (`CR 303.4a`, `oracle.ts:1700-1735`, `engine.ts:8038-8050`)**: `checkSpellCastLegality` still calls `parseSpellOrAbilityEffects(inst.card)` from `oracle.ts` to determine whether an Aura spell has legal targets on the board.
- **Equip resolution fallback (`CR 301.5b`, `engine.ts:4564-4592`)**: `case 'equip_target'` in `executeParsedEffect` (`engine.ts:4564`) duplicates the IR interpreter's `case 'attach'` (`runtime/effects.ts:906-924`).
- **Corpse Dance top-of-graveyard reanimation (`CR 404.2`, `engine.ts:4987-5039`, `oracle.ts:1340-1370`)**: Hardcoded to the card name/pattern in `oracle.ts` and `executeParsedEffect` (`dynamicFormula === 'top_creature_of_graveyard'`).
- **Clone / enters-as-copy (`CR 200.3`, `engine.ts:4206-4239`, `oracle.ts`)**: `cardEntersAsCopyOfAnyCreature(item.card)` in `resolveTopOfStack` is a legacy `oracle.ts` helper rather than an IR replacement effect.
