# Rules audit: 702.1–702.84 Keyword Abilities, Part 1 (rules.txt lines 3912–4654)
Audited at engine-rewrite 917180b on 2026-11-09.

## Summary
- Counts: implemented 56, partial 42, missing 153, N/A 11 (262 subrules total across 702.1–702.84).
- Top gaps (most player-visible first):
  1. **CR 702.16e — Protection does not prevent combat damage** (`engine.ts:6007-6356`): `executeCombatDamageStep` never checks `hasProtectionFrom` or `permanentProtectedFromSource`, so creatures and planeswalkers with Protection take full combat damage from sources of the protected quality — **S**.
  2. **CR 702.80a — Wither is not applied during combat damage and is rejected on keyword lines** (`engine.ts:6014-6348`, `compiler/adapter.ts:100-153`): `executeCombatDamageStep` only checks `hasInfect`, not `hasWither` (unlike non-combat damage in `runtime/effects.ts:1163`), and `'wither'` is omitted from `IMPLEMENTED_KEYWORDS` even though `compiler/statics.ts:110` and `runtime/layers.ts:186` grant it — **S**.
  3. **CR 702.13, 702.28, 702.31, 702.36 — Intimidate, Shadow, Horsemanship, and Fear compile as supported in static grants but are never enforced in combat** (`compiler/statics.ts:93-107`, `runtime/layers.ts:184-188`, `engine.ts:1939-1968`): Static abilities like `"Creatures you control have fear/intimidate/shadow/horsemanship"` compile as fully supported, but `declare_blockers` in `engine.ts` never checks any of those four evasion keywords — **S**.
  4. **CR 702.14, 702.29, 702.33, 702.34, 702.40, 702.41, 702.49, 702.51, 702.66, 702.74, 702.79, 702.83, 702.84 — Major Commander staples (Landwalk, Cycling, Kicker, Flashback, Storm, Affinity, Ninjutsu, Convoke, Delve, Evoke, Persist, Exalted, Unearth) are unimplemented** (`compiler/adapter.ts:128-153`): Recognised in `KNOWN_KEYWORDS` and flagged `keyword_not_implemented`, with no runtime rules enforcement — **L**.
  5. **CR 702.21a–b — Ward auto-pays without prompting the opponent, ignores non-mana/non-life costs, never triggers on triggered abilities, and ignores dynamically granted Ward** (`engine.ts:4613-4670`, `engine.ts:3636-3747`, `runtime/triggers.ts:326-358`, `compiler/triggers.ts:516-533`): Resolving `ward_trigger` auto-taps mana or deducts life without prompting; non-mana/non-life Ward costs parse as `{0}` via `parseManaCost` and succeed for free; `putTriggerOnStack` never emits `BecameTarget`; `triggersOf(card)` ignores Layer 6 granted Ward — **M**.
  6. **CR 702.62a,c — Suspend skips stack triggers, auto-casts and auto-resolves without player choice or priority, and ignores cast-prohibition effects when suspending from hand** (`engine.ts:3166-3182`, `engine.ts:5432-5579`): Upkeep counter removal and the final-counter cast bypass the stack; `executeSuspendFreeCastFromExile` forces the "may play" choice, auto-picks targets, and immediately calls `resolveTopOfStack(state)`; `checkSuspendLegality` ignores `globalCheck.ok` — **M**.
  7. **CR 702.11d–g — "Hexproof from [quality]" is parsed in static grants and layer labels but never enforced by targeting checks** (`compiler/statics.ts:132-135`, `runtime/layers.ts:210-212`, `engine.ts:502-512`, `engine.ts:7538`): `hasKeyword(inst, 'Hexproof', state)` checks exact canonical key `'hexproof'` and ignores `'hexproof from ...'` — **S**.
  8. **CR 702.19b–c — Trample combat damage assignment is hardcoded to minimum lethal in blocker array order with no controller choice, and "trample over planeswalkers" is unimplemented** (`engine.ts:6190-6294`): The attacking player cannot choose blocker damage assignment order or assign more than lethal damage to a blocker before trampling over — **M**.
  9. **CR 702.5c–d — "Enchant player" Auras never attach on resolution and immediately die to SBAs; multi-Enchant and subtype/type Enchant targeting on cast are incomplete** (`engine.ts:4241-4243`, `engine.ts:6615-6635`, `oracle.ts:972-990`, `engine.ts:6486-6498`) — **M**.
  10. **CR 702.6a,c,e — Equip is legacy-only (`oracle.ts`/`ruleTree.ts`), only parses mana-symbol costs, enforces creature-only targets regardless of `[quality]` on activation, and unattaches `Equip planeswalker` during SBAs** (`oracle.ts:409-439`, `compiler/adapter.ts:568`, `engine.ts:6636-6646`) — **M**.
  11. **CR 702.26a — Phasing keyword is enforced in the untap step but missing from `IMPLEMENTED_KEYWORDS` and `compiler/statics.ts`** (`engine.ts:983`, `compiler/adapter.ts:100-153`): Cards with printed `Phasing` are flagged `keyword_not_implemented` even though `executeUntapTurnBasedActions` implements the Phasing turn-based action — **S**.
  12. **CR 702.15b,e — Lifelink mutates `player.life` directly without emitting life-gain events (`LifeGained` does not exist in `runtime/events.ts`), and non-combat LKI (`702.2e`, `702.15c`, `702.80b`) falls back to printed card text instead of battlefield LKI** (`engine.ts:6296-6304`, `engine.ts:6337-6339`, `runtime/effects.ts:1053-1080`, `runtime/effects.ts:1228-1234`) — **M**.

---

## Rule-by-rule

### 702.1 Keyword Abilities (General)
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.1 | Keyword ability definition | implemented (definitional) | `compiler/adapter.ts:100-153`, `compiler/adapter.ts:318-365`, `runtime/layers.ts:289-395` |
| 702.1a | "[keyword] cost" refers to variable cost of keyword | partial | `compiler/statics.ts:436-439` and `ruleTree.ts:673-705` handle `equip` cost modifiers; general `[keyword] cost` references (e.g. scavenge/cycling/flashback cost equal to mana cost) are not implemented. |
| 702.1b | Variable in granted keyword ability is constantly reevaluated | missing | No mechanism in `compiler/statics.ts` or `runtime/layers.ts` for dynamically reevaluated variables inside granted keyword abilities (e.g. `echo {X}` or `flashback` equal to mana cost). |
| 702.1c | "The same is true for [list of keywords]" grants each variant/variable | missing | Not parsed in `compiler/effects.ts`, `compiler/triggers.ts`, or `compiler/statics.ts`. |
| 702.1d | Object "with [keyword]" / "that has [keyword]" filter | missing | `ObjectFilter` in `ir.ts:192-214` and `matchesObjectFilter` in `runtime/objectFilter.ts:175-255` have no `keywords` field; effects/statics referring to "creatures with flying" fail to parse. |

### 702.2 Deathtouch
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.2a | Deathtouch is a static ability | implemented | `compiler/adapter.ts:102`, `compiler/statics.ts:91`, `runtime/layers.ts:168` |
| 702.2b | Creature with toughness > 0 dealt damage by deathtouch source since last SBA check is destroyed | implemented | `engine.ts:6209`, `engine.ts:6326-6328`, `runtime/effects.ts:1167-1169`, `engine.ts:6666-6672` (also clears `deathtouchDamageMarked` if creature survives SBA check via Indestructible, tested in `runtime/sba.test.ts:313`). |
| 702.2c | Any nonzero combat damage assigned by deathtouch source is lethal damage | implemented | `engine.ts:6195` (`const lethalNeeded = atkDeathtouch ? 1 : remTough`), `engine.ts:8676` (AI combat evaluator). |
| 702.2d | Functions no matter what zone source deals damage from | implemented | `runtime/effects.ts:1068-1075` checks compiled face/card keywords when source is not on the battlefield. |
| 702.2e | Last known information used if source is no longer in expected zone | partial | `runtime/effects.ts:1053-1080` (`sourceDamageInfo`) only evaluates Layer 6 `activeKeywords` if `sourcePerm.zone === 'battlefield'`; if the source permanent left the battlefield before its damage effect resolves, it falls back to printed card keywords (`compileCard(sourceCard)`) and loses temporary/granted Deathtouch. |
| 702.2f | Multiple instances of deathtouch are redundant | implemented | `engine.ts:502-512` (`hasKeyword` returns boolean), `runtime/layers.ts:282-286` deduplicates by `canonicalKey`. |

### 702.3 Defender
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.3a | Defender is a static ability | implemented | `compiler/adapter.ts:103`, `compiler/statics.ts:92`, `runtime/layers.ts:169` |
| 702.3b | Creature with defender can't attack | partial | Enforced in `engine.ts:1738-1740` and `engine.ts:1802`; however, "can attack as though it didn't have defender" (e.g. Arcades, the Strategist) is not modelled in `RestrictionKind` or `declare_attackers`. |
| 702.3c | Multiple instances of defender are redundant | implemented | `engine.ts:502-512`, `runtime/layers.ts:282-286` |

### 702.4 Double Strike
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.4a | Double strike is a static ability modifying combat damage step | implemented | `compiler/adapter.ts:104`, `compiler/statics.ts:93`, `runtime/layers.ts:167` |
| 702.4b | First & second combat damage step rules for double strike / first strike | implemented | `engine.ts:5935-5959`, `engine.ts:5983-6005`, `engine.ts:6029-6034`, `engine.ts:6075-6079`, `engine.ts:6312-6316` |
| 702.4c | Removing double strike during first step stops second-step damage | implemented | `engine.ts:6034` (`dealsNow` in normal combat damage step is `hasDS || !alreadyDealtFS`; since `alreadyDealtFS` is true and `hasDS` is now false, `dealsNow` is false). |
| 702.4d | Giving double strike to creature with first strike after first step allows second-step damage | implemented | `engine.ts:6034` (`hasDS || !alreadyDealtFS` evaluates to `true` when `hasDS` is true in the second step). |
| 702.4e | Multiple instances of double strike are redundant | implemented | `engine.ts:502-512`, `runtime/layers.ts:282-286` |

### 702.5 Enchant
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.5a | Enchant restricts what an Aura spell can target and what an Aura can enchant | partial | SBA attachment check in `engine.ts:6475-6532` (`isAuraAttachmentLegal`) checks controller, `nonland`, card types, and subtypes; however, cast-time target detection in `oracle.ts:972-990` only distinguishes `creature you control`, `permanent`, `creature`, `artifact`, and `player`, falling back to `target permanent` for all other Enchant clauses (e.g. `Enchant land`, `Enchant enchantment`, `Enchant planeswalker`, `Enchant creature an opponent controls`). |
| 702.5b | Cross-reference to rule 303 (Enchantments) | N/A (definition) | Cross-reference only. |
| 702.5c | Multiple instances of enchant: all apply | missing | `isAuraAttachmentLegal` (`engine.ts:6486-6498`) uses `.find(...)` / `break` and only checks the first `Enchant` ability on the Aura. |
| 702.5d | Auras that enchant a player can target and be attached to players | partial | `oracle.ts:986-988` allows targeting a player when casting an `Enchant player` Aura, but on resolution `engine.ts:4241-4243` only sets `perm.attachedToId` when `item.targets[0]?.kind === 'permanent'`, and `checkStateBasedActions` (`engine.ts:6615-6635`) requires `findPermanentOnBoard(state, perm.attachedToId)` to succeed — so any `Enchant player` Aura enters unattached and is immediately put into the graveyard as an SBA. |

### 702.6 Equip
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.6a | Equip [cost]: Attach to target creature you control; activate only as a sorcery | partial | Recognised in `compiler/adapter.ts:106,326,568`, but compiled only as a `keyword` IR node (not an IR `activated` ability). Runtime activation relies on legacy `oracle.ts:409-439` and `ruleTree.ts:326-341` and `engine.ts:4564-4590`. `oracle.ts:410` only matches mana-symbol costs (`{...}`), so non-mana Equip costs (e.g. `Equip—Pay 2 life`, `Equip—Sacrifice a creature`) are not parsed as activated abilities. |
| 702.6b | Cross-reference to rule 301 (Artifacts) | N/A (definition) | Cross-reference only. |
| 702.6c | "Equip [quality]" restricts legal target on activation, not what Equipment can stay attached to | partial | `oracle.ts:413-438` captures `equipQualityRaw` in the label/effectText, but hardcodes `targetKind: 'controlled_creature'` without enforcing the `[quality]` subtype/legendary filter during `validateChosenTargets` (`engine.ts:7568-7577`). |
| 702.6d | Multiple equip abilities: any may be activated | implemented | `oracle.ts:409-439` emits a separate `equip_${idx}` ability per line. |
| 702.6e | "Equip planeswalker [cost]" variant | missing | `oracle.ts:415-419` turns `Equip planeswalker` into `"planeswalker creature"` with `targetKind: 'controlled_creature'`, and `checkStateBasedActions` (`engine.ts:6639-6642`) unattaches any Equipment attached to a permanent whose typeLine does not include `'Creature'`. |

### 702.7 First Strike
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.7a | First strike is a static ability modifying combat damage step | implemented | `compiler/adapter.ts:107`, `compiler/statics.ts:95`, `runtime/layers.ts:166` |
| 702.7b | First and second combat damage step rules | implemented | `engine.ts:5935-5959`, `engine.ts:5983-6005`, `engine.ts:6029-6035` |
| 702.7c | Giving first strike after first step doesn't stop second-step damage; removing it after dealing first-step damage doesn't allow second-step damage | implemented | `engine.ts:6031-6034` tracks `state.combat.dealtFirstStrikeDamageIds` and evaluates `dealsNow = isFirstStrikeStep ? hasFS || hasDS : hasDS || !alreadyDealtFS`. |
| 702.7d | Multiple instances of first strike are redundant | implemented | `engine.ts:502-512`, `runtime/layers.ts:282-286` |

### 702.8 Flash
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.8a | Flash functions in any zone from which you could play the card; play any time you could cast an instant | implemented | `compiler/adapter.ts:108`, `compiler/statics.ts:96`, `engine.ts:7953-7954`, `engine.ts:5557-5558`, `runtime/replace.ts:348-436` |
| 702.8b | Multiple instances of flash are redundant | implemented | `engine.ts:502-512`, `runtime/layers.ts:282-286` |

### 702.9 Flying
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.9a | Flying is an evasion ability | implemented | `compiler/adapter.ts:109`, `compiler/statics.ts:97`, `runtime/layers.ts:165` |
| 702.9b | Can't be blocked except by creatures with flying and/or reach; can block with or without flying | implemented | `engine.ts:1940-1950`, `engine.ts:2014-2020`, `ai.ts:276,341` |
| 702.9c | Multiple instances of flying are redundant | implemented | `engine.ts:502-512`, `runtime/layers.ts:282-286` |

### 702.10 Haste
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.10a | Haste is a static ability | implemented | `compiler/adapter.ts:110`, `compiler/statics.ts:98`, `runtime/layers.ts:171` |
| 702.10b | Creature with haste can attack despite summoning sickness | implemented | `engine.ts:1732`, `engine.ts:1801` |
| 702.10c | Creature with haste can activate `{T}` or `{Q}` abilities despite summoning sickness | implemented | `runtime/costs.ts:348-350`, `runtime/costs.ts:391-395` (checks both `tapSelf` `{T}` and `untapSelf` `{Q}`), `engine.ts:727` |
| 702.10d | Multiple instances of haste are redundant | implemented | `engine.ts:502-512`, `runtime/layers.ts:282-286` |

### 702.11 Hexproof
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.11a | Hexproof is a static ability | implemented | `compiler/adapter.ts:111`, `compiler/statics.ts:99`, `runtime/layers.ts:172` |
| 702.11b | Hexproof on a permanent prevents targeting by spells/abilities opponents control | implemented | `engine.ts:3548`, `engine.ts:7538-7542`, `engine.ts:8248` |
| 702.11c | Hexproof on a player prevents targeting by spells/abilities opponents control | implemented | `compiler/statics.ts:365-366`, `runtime/replace.ts:284-290` (`playerHasHexproofFrom`), `engine.ts:3562`, `engine.ts:7517-7522`, `engine.ts:8212` |
| 702.11d | "Hexproof from [quality]" variant | partial | `compiler/adapter.ts:356-357` marks printed `hexproof from [quality]` as `keyword_not_implemented`, while `compiler/statics.ts:132-135` and `runtime/layers.ts:210-212` accept granted `hexproof from [quality]`, but targeting checks in `engine.ts:3548,7538,8248` only call `hasKeyword(inst, 'Hexproof', state)` and never enforce `hexproof from [quality]`. |
| 702.11e | Losing hexproof loses all "hexproof from [quality]"; glare/detection effects apply to variants | missing | Layer 6 ability-removal in `runtime/layers.ts` and targeting checks in `engine.ts` do not link `hexproof` to `hexproof from [quality]`, and "as though it didn't have hexproof" effects are not implemented. |
| 702.11f–g | "Hexproof from [A] and from [B]" and "Hexproof from each [characteristic]" shorthand | missing | Not parsed or enforced. |
| 702.11h | Multiple instances of the same hexproof ability are redundant | implemented | `engine.ts:502-512`, `runtime/replace.ts:284-290` |

### 702.12 Indestructible
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.12a | Indestructible is a static ability | implemented | `compiler/adapter.ts:112`, `compiler/statics.ts:101`, `runtime/layers.ts:173` |
| 702.12b | Can't be destroyed by destroy effects or lethal-damage / deathtouch SBAs | implemented | `engine.ts:6667` (SBA lethal/deathtouch check), `runtime/effects.ts:776-779` (IR `destroy` verb), `engine.ts:4794,5194` (legacy destroy helpers). |
| 702.12c | Multiple instances of indestructible are redundant | implemented | `engine.ts:502-512`, `runtime/layers.ts:282-286` |

### 702.13 Intimidate
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.13a–c | Intimidate evasion ability (can't be blocked except by artifact creatures and/or creatures sharing a color) | missing | Listed as unsupported on keyword lines (`compiler/adapter.ts:140`), yet accepted as supported in static keyword grants (`compiler/statics.ts:102`, `runtime/layers.ts:185`). `declare_blockers` in `engine.ts:1939-1968` never checks Intimidate. |

### 702.14 Landwalk
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.14a–e | Landwalk (`[type]walk`) evasion ability | missing | Recognised in `KNOWN_KEYWORDS` (`compiler/adapter.ts:140,150`: `landwalk`, `plainswalker` [typo for `plainswalk`], `islandwalk`, `swampwalk`, `mountainwalk`, `forestwalk`) as `keyword_not_implemented`; not enforced in `engine.ts`. |

### 702.15 Lifelink
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.15a | Lifelink is a static ability | implemented | `compiler/adapter.ts:114`, `compiler/statics.ts:103`, `runtime/layers.ts:175` |
| 702.15b | Damage dealt by source with lifelink causes controller (or owner) to gain that much life | partial | Combat damage (`engine.ts:6296-6304`, `6337-6339`) and non-combat/fight damage (`runtime/effects.ts:1228-1234`, `1267,1274,1281,1328,1335-1336`) add to `controller.life`. However, no `LifeGained` event exists in `runtime/events.ts`, so lifelink never triggers `"Whenever you gain life"` abilities. |
| 702.15c | Last known information used if source left expected zone | partial | `runtime/effects.ts:1053-1080` (`sourceDamageInfo`) falls back to printed card keywords rather than battlefield LKI if the source permanent left the battlefield before dealing damage. |
| 702.15d | Functions no matter what zone source deals damage from | implemented | `runtime/effects.ts:1068-1075`, `runtime/effects.ts:1244-1248` |
| 702.15e | Multiple sources with lifelink dealing combat damage simultaneously cause separate life gain events | missing | `runtime/events.ts` does not emit life-gain events at all; life is mutated directly per attacker/blocker in `engine.ts:6297,6338`. |
| 702.15f | Multiple instances of lifelink are redundant | implemented | `engine.ts:502-512`, `runtime/layers.ts:282-286` |

### 702.16 Protection
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.16a | Protection is a static ability written "Protection from [quality]" | partial | `compiler/adapter.ts:118,330,342`, `compiler/statics.ts:122-145`, `runtime/layers.ts:207-209,311-315`. Quality matching in `hasProtectionFrom` (`engine.ts:7195-7252`) and `permanentProtectedFromSource` (`runtime/effects.ts:1083-1119`) covers colors, `all colors`, `multicolored`, `monocolored`, `colorless`, `everything`, and major card types (`creatures`, `artifacts`, `enchantments`, `lands`, `planeswalkers`, `instants`, `sorceries`), but not arbitrary subtypes, supertypes, mana values, or card names. Also `hasProtectionFrom` checks `sourceCard.colors` / `sourceCard.typeLine` rather than evaluated Layer 4/5 characteristics of the source permanent. |
| 702.16b | Can't be targeted by spells or abilities from sources with the stated quality | partial | Enforced for permanents (`engine.ts:3549`, `engine.ts:7544-7549`, `engine.ts:8253-8255`). For players, only `protectionFromEverythingThisTurn` is checked (`engine.ts:7260,7265`), not quality-specific protection on a player. |
| 702.16c | Can't be enchanted by Auras with the stated quality; illegal Auras go to graveyard as SBA | implemented | `engine.ts:6484` (`isAuraAttachmentLegal` calls `hasProtectionFrom`), `engine.ts:6622-6634` (SBA puts illegal Aura into graveyard). |
| 702.16d | Can't be equipped by Equipment (or fortified) with stated quality; unattaches as SBA | implemented | `engine.ts:6641-6645` unattaches Equipment when `hasProtectionFrom` holds. |
| 702.16e | Damage from sources with the stated quality is prevented | partial | Enforced for non-combat/fight damage to permanents in `runtime/effects.ts:1133` (`permanentProtectedFromSource`, which only checks colors, `all colors`, `everything`, and 5 permanent types—missing `multicolored`, `monocolored`, `colorless`, `instants`, `sorceries`). **Completely missing for combat damage**: `executeCombatDamageStep` (`engine.ts:6007-6356`) never checks `hasProtectionFrom` on blockers, attackers, or planeswalkers! |
| 702.16f | Attacking creatures with protection can't be blocked by creatures with the stated quality | implemented | `engine.ts:1961-1967`, `engine.ts:2011-2013` |
| 702.16g | "Protection from [A] and from [B]" shorthand | implemented | `compiler/statics.ts:122-145`, `engine.ts:7222-7251` (regex checks each quality against combined text). |
| 702.16h–i | "Protection from each [characteristic / set]" shorthand | partial | `"protection from all colors"` is handled (`engine.ts:7226`, `runtime/effects.ts:1112`); other `"protection from each ..."` forms are not parsed. |
| 702.16j | "Protection from everything" variant | partial | Handled in `engine.ts:7225`, `runtime/effects.ts:1111`, and for players via `protectionFromEverythingThisTurn` (`engine.ts:6135,6259,7260,7265`, `runtime/effects.ts:1197`), except combat damage to a permanent with protection from everything is still not prevented in `engine.ts:6203-6209,6320-6328`. |
| 702.16k | "Protection from [a player]" variant (e.g. True-Name Nemesis) | missing | Not implemented in `hasProtectionFrom` (`engine.ts:7195-7252`) or `permanentProtectedFromSource` (`runtime/effects.ts:1083-1119`). |
| 702.16m | Multiple instances of protection from same quality are redundant | implemented | Boolean checks in `hasProtectionFrom` and `permanentProtectedFromSource`. |
| 702.16n, 702.16p | Auras granting protection that say "this effect doesn't remove [Aura / already attached]" | missing | `hasProtectionFrom` (`engine.ts:7213-7220`) includes the text of all attached Auras/Equipment without excluding Auras that state `"this effect doesn't remove..."`, so such an Aura grants protection from its own color and immediately causes itself to fall off in SBAs (`engine.ts:6484,6622`). |

### 702.17 Reach
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.17a | Reach is a static ability | implemented | `compiler/adapter.ts:119`, `compiler/statics.ts:106`, `runtime/layers.ts:177` |
| 702.17b | Creature with reach can block creatures with flying | implemented | `engine.ts:1941-1950`, `engine.ts:2014-2020`, `ai.ts:276,341` |
| 702.17c | Multiple instances of reach are redundant | implemented | `engine.ts:502-512`, `runtime/layers.ts:282-286` |

### 702.18 Shroud
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.18a | Shroud on a permanent or player prevents targeting by any spell or ability | implemented | `compiler/adapter.ts:120`, `compiler/statics.ts:108,367`, `runtime/replace.ts:294-296`, `engine.ts:3547,3562,7511-7515,7532-7536,8211,8247` |
| 702.18b | Multiple instances of shroud are redundant | implemented | `engine.ts:502-512`, `runtime/replace.ts:294-296` |

### 702.19 Trample
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.19a | Trample modifies attacking creature's combat damage assignment; no effect when blocking or noncombat | implemented | `compiler/adapter.ts:122`, `compiler/statics.ts:109`, `engine.ts:6043,6198-6294` |
| 702.19b | Assign lethal damage to all blockers (accounting for existing damage), then divide excess among blockers and defending player/planeswalker | partial | `engine.ts:6190-6294` accounts for `b.damageMarked` and Deathtouch (`lethalNeeded = atkDeathtouch ? 1 : remTough`), including damage from earlier attackers in the same step. However, damage assignment is completely automatic: the controller cannot choose blocker damage assignment order or choose to assign more than lethal damage to a blocker instead of trampling over. Also, `remTough = Math.max(1, bTough - b.damageMarked)` (`engine.ts:6194`) forces assigning at least 1 damage to a blocker that already has lethal damage marked on it from another attacker! |
| 702.19c | Trample over planeswalkers | missing | Not recognised in `compiler/adapter.ts` or `engine.ts:6231-6258`. |
| 702.19d | Blocked creature with trample whose blockers all left combat assigns damage to defending player/planeswalker | implemented | `engine.ts:6179,6189-6294` (when `atkEntry.wasBlocked && blockers.length === 0 && atkTrample`, the blocker loop runs 0 times and full `remainingDamage` tramples over to `defWalker` or `defPlayer`). |
| 702.19e | Trample over planeswalkers when planeswalker is removed from combat | missing | Trample over planeswalkers is not implemented. |
| 702.19f | Creature without trample over planeswalkers attacking a planeswalker that left combat assigns no damage to defending player | partial | Wait: in `engine.ts:6098-6178` and `6231-6292`, if `atkEntry.defenderPlaneswalkerId` was set, `defWalker` is looked up on `defPlayer.battlefield` (`engine.ts:6098-6102`). If that planeswalker was destroyed/removed from combat before the combat damage step, `defWalker` is `undefined`, and `engine.ts:6133` / `engine.ts:6258` falls into `else` and **deals the combat damage to `defPlayer` instead**! That directly violates CR 702.19f and CR 506.4c. |
| 702.19g | Multiple instances of trample are redundant | implemented | `engine.ts:502-512`, `runtime/layers.ts:282-286` |

### 702.20 Vigilance
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.20a–b | Attacking doesn't cause creatures with vigilance to tap | implemented | `compiler/adapter.ts:123`, `compiler/statics.ts:110`, `engine.ts:1831-1833` |
| 702.20c | Multiple instances of vigilance are redundant | implemented | `engine.ts:502-512`, `runtime/layers.ts:282-286` |

### 702.21 Ward
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.21a | Ward [cost]: triggered ability when permanent becomes target of spell/ability an opponent controls; counter unless opponent pays [cost] | partial | Parsed in `compiler/adapter.ts:124,318-335` and `compiler/triggers.ts:516-533`; matched in `runtime/triggers.ts:754-775`; resolved in `engine.ts:4613-4670`. Four major gaps: (1) Resolution does not prompt the opponent—it auto-pays mana/life unless `targetItem.declineWard` was pre-set (`engine.ts:4619-4648`); (2) Only mana costs and `Pay N life` are supported—any other Ward cost (e.g. `Discard a card`, `Sacrifice a permanent`) is passed to `parseManaCost(wardCost)` (`engine.ts:4634`), which parses `{0}` and succeeds for free; (3) `BecameTarget` is only emitted on `cast_spell` (`engine.ts:1574`) and `activate_ability` (`engine.ts:1685`), never when a triggered ability chooses targets (`engine.ts:3639-3673,3731-3748`), and `engine.ts:4660-4669` calls `moveStackSpellToZone` assuming a spell; (4) `triggersOf(card)` (`runtime/triggers.ts:326-358`) only checks printed card abilities, so Ward granted in Layer 6 never triggers. |
| 702.21b | Ward {X} cost determined on resolution | missing | `engine.ts:4634` calls `parseManaCost(wardCost)` without evaluating X, so `{X}` evaluates to 0. |

### 702.22 Banding
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.22a–m | Banding and "bands with other" | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:131`) as `keyword_not_implemented`; no runtime support. |

### 702.23 Rampage
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.23a–c | Rampage N triggered ability | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:144`) as `keyword_not_implemented`; no runtime support. |

### 702.24 Cumulative Upkeep
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.24a–b | Cumulative upkeep [cost] and age counters | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:133`) as `keyword_not_implemented`; `age` is not even a `CounterType` in `ir.ts`. |

### 702.25 Flanking
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.25a–b | Flanking triggered ability | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:137`) as `keyword_not_implemented`; no runtime support. |

### 702.26 Phasing
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.26a | Phasing keyword: during untap step before untapping, phased-in permanents with phasing phase out and phased-out permanents phase in simultaneously | partial | The turn-based action in `executeUntapTurnBasedActions` (`engine.ts:948-1042`) checks `hasKeyword(perm, 'Phasing', state)` and phases permanents in and out simultaneously! However, `'phasing'` is missing from `IMPLEMENTED_KEYWORDS` (`compiler/adapter.ts:100-125`) and `KEYWORDS` in `compiler/statics.ts:88-112`, so cards with printed `Phasing` compile as `keyword_not_implemented`. |
| 702.26b | Phased-out permanent is treated as though it does not exist and is removed from combat | implemented | `phaseOutPermanent` (`engine.ts:5360-5379`) sets `perm.phasedOut = true` and removes from `state.combat.attackers` and `blockerInstanceIds`; board scans across `engine.ts`, `runtime/layers.ts`, `runtime/triggers.ts`, `runtime/effects.ts`, and `runtime/objectFilter.ts` filter out `perm.phasedOut`. |
| 702.26c | Phased-in permanent is treated as existing again | implemented | `engine.ts:1012-1015` clears `perm.phasedOut = false` and `perm.phasedOutIndirectly = false`. |
| 702.26d | Phasing doesn't change zones; no ETB/LTB triggers; tokens, counters, and history remain | implemented | `engine.ts:948-1042` and `engine.ts:5360-5379` keep phased-out permanents in `player.battlefield` with their counters, token status, and `instanceId` intact without emitting `ZoneChange`. |
| 702.26e | Continuous effects from resolving spells/abilities ignore phased-out permanents | implemented | `runtime/effects.ts` and `engine.ts` skip `perm.phasedOut` when resolving effects. |
| 702.26f | Continuous effects may expire while phased out; "for as long as" tracking ends | partial | End-of-turn / until-next-turn effects expire normally while phased out (`engine.ts:1098-1102,6362-6369`), though `clearEndOfTurnAndDamage` clears `damageMarked` on phased-out permanents too (which matches cleanup rules); general `"for as long as"` tracking durations are not implemented. |
| 702.26g | Attached Auras/Equipment/Fortifications phase out indirectly and phase in with host | implemented | `engine.ts:951-975`, `engine.ts:987-1025`, and `engine.ts:5363-5371` track `phasedOutIndirectly` and phase attachments out/in with their host. |
| 702.26h | Simultaneously phasing out directly and indirectly phases out indirectly | partial | In `engine.ts:980-1025`, `phasingOutDirectIds` is populated before `phasingOutIndirectIds`, and line 997 skips permanents already in `phasingOutDirectIds`, so an attachment with Phasing attached to a permanent with Phasing gets `phasedOutIndirectly = false` (direct) instead of `true` (indirect). |
| 702.26i | Directly phased-out attachment phases in attached if host still in zone, else unattached (and SBA applies) | implemented | `perm.attachedToId` is preserved while phased out; when it phases in, `checkStateBasedActions` (`engine.ts:6607-6655`) unattaches or puts it into the graveyard if `findPermanentOnBoard(state, perm.attachedToId)` is missing. |
| 702.26j | Attach/unattach triggers don't trigger on phasing in or out | implemented | `engine.ts:948-1042` and `5360-5379` do not emit `Attached` events. |
| 702.26k, 702.26n | Multiplayer: phased-out permanents when a player leaves the game | partial | Players who lose have `p.lost = true` and their battlefield is skipped; control-change cleanup of phased-out permanents controlled by an eliminated player is not specially handled. |
| 702.26m | Skipping untap step skips phasing | partial | No effect currently skips the untap step, though phasing is inside `executeUntapTurnBasedActions` (`engine.ts:944`). |
| 702.26p | Multiple instances of phasing are redundant | implemented | `hasKeyword(perm, 'Phasing', state)` in `engine.ts:983` is boolean. |

### 702.27 Buyback
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.27a | Buyback [cost]: optional additional cost; if paid, put spell into owner's hand instead of graveyard as it resolves | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:132`) as `keyword_not_implemented`; no runtime support. |

### 702.28 Shadow
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.28a–c | Shadow evasion/blocking restriction | missing | Listed as unsupported on keyword lines (`compiler/adapter.ts:146`), yet accepted in static keyword grants (`compiler/statics.ts:107`, `runtime/layers.ts:188`). Never enforced in `declare_blockers` (`engine.ts:1939-1968`). |

### 702.29 Cycling
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.29a–f | Cycling and Typecycling (`[Cost], Discard this card: Draw a card` / search for `[type]`) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:134,151`) as `keyword_not_implemented` and stripped in `oracle.ts:1062`; no hand-activated ability support in `engine.ts`. |

### 702.30 Echo
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.30a | Echo [cost] upkeep triggered ability | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:135`) as `keyword_not_implemented`; no runtime support. |
| 702.30b | Urza block Oracle errata note | N/A (Oracle errata note) | Scryfall Oracle text already includes the errata cost. |

### 702.31 Horsemanship
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.31a–c | Horsemanship evasion ability | missing | Listed as unsupported on keyword lines (`compiler/adapter.ts:139`), yet accepted in static keyword grants (`compiler/statics.ts:99`, `runtime/layers.ts:187`). Never enforced in `declare_blockers` (`engine.ts:1939-1968`). |

### 702.32 Fading
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.32a | Fading N (fade counters + upkeep remove/sacrifice trigger) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:137`) as `keyword_not_implemented`; no runtime support. |

### 702.33 Kicker
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.33a–g | Kicker and Multikicker optional additional costs and "if it was kicked" linked abilities | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:140,142`) as `keyword_not_implemented`; `StackItem` and `cast_spell` have no `kicked` / `kickerCount` support. |
| 702.33h | Sticker kicker | N/A (Un-set / stickers) | Sticker mechanic is outside standard Commander scope. |

### 702.34 Flashback
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.34a | Flashback [cost]: cast instant/sorcery from graveyard for [cost], exile when leaving stack | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:137`) as `keyword_not_implemented`; `cast_spell` (`engine.ts:1423-1456`) only searches `hand`, `command`, and `playableFromExileBy`, never `graveyard`. |

### 702.35 Madness
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.35a–c | Madness [cost]: discard replacement to exile + triggered cast permission | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:141`) as `keyword_not_implemented`; no runtime support. |

### 702.36 Fear
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.36a–c | Fear evasion ability (can't be blocked except by artifact creatures and/or black creatures) | missing | Listed as unsupported on keyword lines (`compiler/adapter.ts:137`), yet accepted in static keyword grants (`compiler/statics.ts:93`, `runtime/layers.ts:184`). Never enforced in `declare_blockers` (`engine.ts:1939-1968`). |

### 702.37 Morph
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.37a–g | Morph and Megamorph: cast face-down for `{3}`, turn face up special action | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:141,142`) as `keyword_not_implemented`. Although `CardInstance.isFaceDown` is respected by layers/filters/SBAs (`runtime/layers.ts:865`, `engine.ts:6683`), there is no action to cast a card face-down with Morph or turn it face up. |

### 702.38 Amplify
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.38a–b | Amplify N ETB reveal replacement | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:130`) as `keyword_not_implemented`. |

### 702.39 Provoke
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.39a–b | Provoke attack trigger | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:144`) as `keyword_not_implemented`. |

### 702.40 Storm
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.40a–b | Storm cast trigger (copy spell for each spell cast before it this turn) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:147`) as `keyword_not_implemented`. (`player.spellsCastThisTurn` is tracked in `engine.ts:1521`, but Storm itself is not compiled or executed.) |

### 702.41 Affinity
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.41a–b | Affinity for [text] cost reduction | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:130`) as `keyword_not_implemented`. |

### 702.42 Entwine
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.42a–b | Entwine [cost] modal spell additional cost | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:136`) as `keyword_not_implemented`. |

### 702.43 Modular
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.43a–b | Modular N ETB +1/+1 counters and dies trigger | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:142`) as `keyword_not_implemented`. |

### 702.44 Sunburst
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.44a–d | Sunburst ETB counters based on colors of mana spent | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:148`) as `keyword_not_implemented`; mana colors spent to cast a spell are not tracked on `StackItem`. |

### 702.45 Bushido
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.45a–b | Bushido N combat trigger | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:132`) as `keyword_not_implemented`. |

### 702.46 Soulshift
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.46a–b | Soulshift N dies trigger | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:147`) as `keyword_not_implemented`. |

### 702.47 Splice
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.47a–e | Splice onto [quality] [cost] | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:147`) as `keyword_not_implemented`. |

### 702.48 Offering
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.48a–c | [Quality] offering flash + sacrifice cost reduction | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:143`) as `keyword_not_implemented`. |

### 702.49 Ninjutsu
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.49a–d | Ninjutsu and Commander ninjutsu | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:143`) as `keyword_not_implemented` and stripped in `oracle.ts:1062`; `commander ninjutsu` is not in `KNOWN_KEYWORDS`. |

### 702.50 Epic
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.50a–b | Epic spell ability (can't cast spells for rest of game; copy at each upkeep) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:136`) as `keyword_not_implemented`. |

### 702.51 Convoke
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.51a–d | Convoke (tap creatures to pay colored/generic mana in spell's total cost) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:133`) as `keyword_not_implemented`. |

### 702.52 Dredge
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.52a–b | Dredge N draw replacement from graveyard | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:135`) as `keyword_not_implemented`. |

### 702.53 Transmute
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.53a–b | Transmute [cost] hand-activated tutor ability | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:148`) as `keyword_not_implemented` and stripped in `oracle.ts:1062`. |

### 702.54 Bloodthirst
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.54a–c | Bloodthirst N / Bloodthirst X ETB counters if opponent dealt damage this turn | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:131`) as `keyword_not_implemented`. |

### 702.55 Haunt
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.55a–c | Haunt triggered ability and exile link | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:139`) as `keyword_not_implemented`. |

### 702.56 Replicate
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.56a–b | Replicate [cost] additional cost and copy trigger | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:145`) as `keyword_not_implemented`. |

### 702.57 Forecast
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.57a–b | Forecast upkeep hand-activated ability | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:138`) as `keyword_not_implemented` and stripped in `oracle.ts:1062`. |

### 702.58 Graft
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.58a–b | Graft N ETB counters and counter-moving trigger | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:139`) as `keyword_not_implemented`. |

### 702.59 Recover
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.59a | Recover [cost] graveyard triggered ability | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:145`) as `keyword_not_implemented`. |

### 702.60 Ripple
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.60a–b | Ripple N cast trigger | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:146`) as `keyword_not_implemented`. |

### 702.61 Split Second
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.61a–c | Split second (while on stack, players can't cast spells or activate non-mana abilities) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:147`) as `keyword_not_implemented`; `checkSpellCastLegality` and `checkAbilityActivationLegality` in `engine.ts` never check for Split Second on the stack. |

### 702.62 Suspend
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.62a | Suspend N—[cost]: special action to exile from hand with N time counters; upkeep trigger removes a time counter; last-counter trigger lets owner play without paying mana cost and grants haste to creatures until control is lost | partial | Recognised in `compiler/adapter.ts:121,328-329`; hand special action in `engine.ts:1337-1381`, upkeep in `engine.ts:3166-3182`, free cast in `engine.ts:5432-5530`, haste in `runtime/layers.ts:1636-1639`. Major deviations: (1) Upkeep counter removal and last-counter free cast are executed inline during `PhaseBegin` (`engine.ts:3166-3182,3325`) instead of using the stack as triggered abilities; (2) `executeSuspendFreeCastFromExile` (`engine.ts:5459-5529`) does not offer the `"you may play it"` choice (since March of the Machine CR update, casting a suspended card is optional), auto-picks targets without prompting (`engine.ts:5459-5483`), and immediately calls `resolveTopOfStack(state)` (`engine.ts:5522`) so players cannot respond; (3) `castViaSuspend` (`engine.ts:5526`, `runtime/layers.ts:1637`) is never cleared if another player gains control of the creature; (4) `parseSuspendClause` (`oracle.ts`) is legacy. |
| 702.62b | Card is "suspended" if in exile, has suspend, and has a time counter | implemented | `engine.ts:1356,3167-3169` checks `c.isSuspended && (c.counters.time || 0) > 0` in `exile`. |
| 702.62c | Consider effects that prohibit casting when determining if you could begin to cast a card with suspend | missing | `checkSuspendLegality` (`engine.ts:5554-5570`) calls `const globalCheck = checkGlobalCastPermissionsAndRestrictions(state, actorId, inst, 'hand')`, reads `globalCheck.grantsFlash`, and **never checks `if (!globalCheck.ok)`**—allowing players to suspend cards even when an effect (e.g. Teferi, Time Raveler / Rule of Law / Silence) prohibits casting them! |
| 702.62d | Casting via suspend follows alternative cost rules | partial | Casts without paying mana cost (`engine.ts:5491-5514`), but bypasses `cast_spell` additional costs, target prompts, and cost modifiers. |

### 702.63 Vanishing
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.63a–c | Vanishing N (time counters, upkeep remove trigger, last-counter sacrifice trigger) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:149`) as `keyword_not_implemented`. |

### 702.64 Absorb
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.64a–c | Absorb N damage prevention | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:130`) as `keyword_not_implemented`. |

### 702.65 Aura Swap
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.65a–b | Aura swap [cost] activated ability | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:130`) as `keyword_not_implemented`. |

### 702.66 Delve
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.66a–c | Delve (exile cards from graveyard to pay generic mana) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:134`) as `keyword_not_implemented`. |

### 702.67 Fortify
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.67a–c | Fortify [cost] activated ability of Fortification cards | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:138`) as `keyword_not_implemented`. |

### 702.68 Frenzy
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.68a–b | Frenzy N attack-and-unblocked trigger | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:138`) as `keyword_not_implemented`. |

### 702.69 Gravestorm
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.69a–b | Gravestorm cast trigger | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:139`) as `keyword_not_implemented`. |

### 702.70 Poisonous
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.70a–b | Poisonous N combat damage trigger | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:144`) as `keyword_not_implemented`. |

### 702.71 Transfigure
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.71a | Transfigure [cost] activated ability | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:148`) as `keyword_not_implemented`. |

### 702.72 Champion
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.72a–c | Champion an [object] linked ETB/LTB triggers | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:132`) as `keyword_not_implemented`. |

### 702.73 Changeling
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.73a | Changeling CDA: object is every creature type in all zones | implemented | `compiler/adapter.ts:101`, `compiler/statics.ts:90`, `runtime/layers.ts:181,1085,1572`, `runtime/objectFilter.ts:195-210` (checks off-battlefield objects for `changeling` keyword or `allCreatureTypes` static), `runtime/triggers.ts:255`. |

### 702.74 Evoke
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.74a | Evoke [cost] alternative cost + ETB sacrifice trigger | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:136`) as `keyword_not_implemented`. |

### 702.75 Hideaway
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.75a | Hideaway N ETB triggered ability | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:139`) as `keyword_not_implemented`. |
| 702.75b | Hideaway errata history note | N/A (Oracle errata note) | Scryfall Oracle text already reflects `Hideaway 4` + enters tapped. |

### 702.76 Prowl
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.76a | Prowl [cost] alternative cost | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:144`) as `keyword_not_implemented`. |

### 702.77 Reinforce
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.77a–b | Reinforce N—[cost] hand-activated ability | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:145`) as `keyword_not_implemented` and stripped in `oracle.ts:1062`. |

### 702.78 Conspire
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.78a–b | Conspire additional cost + copy trigger | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:133`) as `keyword_not_implemented`. |

### 702.79 Persist
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.79a | Persist dies trigger (return with a -1/-1 counter if it had no -1/-1 counters) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:143`) as `keyword_not_implemented`. |

### 702.80 Wither
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.80a | Wither static ability: damage to a creature is dealt as -1/-1 counters | partial | Implemented for non-combat and fight damage in `runtime/effects.ts:1049,1060,1077,1162-1165` (`if (srcInfo.hasInfect || srcInfo.hasWither) p.addCounters(s, target, '-1/-1', dmg)`), and recognised in `compiler/statics.ts:111` and `runtime/layers.ts:186`. However, **missing from `IMPLEMENTED_KEYWORDS`** (`compiler/adapter.ts:100-150`, so printed `Wither` compiles as `keyword_not_implemented`) and **missing from combat damage** (`executeCombatDamageStep` in `engine.ts:6014-6348` only checks `hasInfect`, never `hasWither`!). |
| 702.80b | Last known information used if source left expected zone | partial | `runtime/effects.ts:1053-1080` (`sourceDamageInfo`) falls back to printed card keywords rather than battlefield LKI when the source permanent is no longer on the battlefield. |
| 702.80c | Functions no matter what zone source deals damage from | implemented | `runtime/effects.ts:1068-1077` |
| 702.80d | Multiple instances of wither are redundant | implemented | Boolean `hasWither` in `runtime/effects.ts:1060,1077`, deduplicated in `runtime/layers.ts:282-286`. |

### 702.81 Retrace
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.81a | Retrace (cast from graveyard by discarding a land card as additional cost) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:146`) as `keyword_not_implemented`. |

### 702.82 Devour
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.82a–c | Devour N / Devour [quality] N ETB sacrifice replacement | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:135`) as `keyword_not_implemented`. |

### 702.83 Exalted
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.83a–b | Exalted ("Whenever a creature you control attacks alone, that creature gets +1/+1 until end of turn") | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:137`) as `keyword_not_implemented`. |

### 702.84 Unearth
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.84a | Unearth [cost] graveyard activated ability | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:149`) as `keyword_not_implemented` and stripped in `oracle.ts:1062`. |

---

## Silently skipped / approximated behaviour

1. **Static grants of `Fear`, `Intimidate`, `Shadow`, and `Horsemanship` compile as fully supported (`fullySupported: true`) but do nothing in combat** (`compiler/statics.ts:93,99,102,107`, `runtime/layers.ts:184-188`, `engine.ts:1939-1968`): When a card grants one of these keywords via a continuous effect (e.g. `"Creatures you control have fear"` or `"Equipped creature has shadow"`), the compiler does not report an unsupported ability, the layer inspector displays the keyword badge on the creature, and `declare_blockers` silently allows any creature to block it.
2. **Static grants of `Hexproof from [quality]` compile as supported but targeting ignores them** (`compiler/statics.ts:132-135`, `runtime/layers.ts:210-212`, `engine.ts:502-512,7538`): A permanent granted `Hexproof from black` displays the badge in the UI, but `hasKeyword(inst, 'Hexproof', state)` returns `false`, so opponents can target it with black spells/abilities without restriction.
3. **Static grants of `Wither` compile as supported (`compiler/statics.ts:111`) and work for non-combat damage, but silently deal normal marked damage in combat** (`engine.ts:6014-6348`).
4. **Protection silently fails to prevent combat damage** (`engine.ts:6007-6356`): `executeCombatDamageStep` deals full combat damage from sources of a protected quality to blockers, attackers (when blocked by a creature with protection), and planeswalkers.
5. **Trample and multi-blocker combat damage assignment is auto-decided with no player prompt** (`engine.ts:6190-6294`): The engine assigns minimum lethal damage in `blockerInstanceIds` array order and automatically tramples all remaining damage to the defending player/planeswalker, without letting the attacking player order blockers or over-assign damage to a blocker. Furthermore, `remTough = Math.max(1, bTough - b.damageMarked)` (`engine.ts:6194`) forces a second attacker to waste at least 1 damage on a blocker that already has lethal damage marked on it.
6. **Attackers attacking a planeswalker that leaves combat before combat damage silently deal their damage to the defending player instead** (`engine.ts:6098-6178`, `engine.ts:6231-6292`): If `defWalker` is no longer on the battlefield when `executeCombatDamageStep` runs, `if (defWalker)` is false and the `else` branch deals the attacker's unblocked or trample damage directly to `defPlayer`, violating CR 702.19f and CR 506.4c.
7. **Ward auto-pays mana or life for the opponent without prompting, and treats non-mana/non-life Ward costs as `{0}`** (`engine.ts:4613-4670`): Unless `targetItem.declineWard` was set when the spell/ability was put on the stack, resolving `ward_trigger` automatically taps the opponent's lands/mana or deducts life (`engine.ts:4622-4646`). If the Ward cost is anything other than mana symbols or `Pay N life` (such as `Ward—Discard a card` or `Ward—Sacrifice a permanent`), `parseManaCost(wardCost)` (`engine.ts:4634`) returns a 0-mana requirement and logs that the opponent "paid" the cost without doing anything.
8. **Suspend upkeep and final-counter cast bypass the stack, force the optional cast, auto-pick targets, immediately resolve the spell, and ignore cast prohibitions when suspending** (`engine.ts:3166-3182`, `engine.ts:5432-5579`):
   - `runSuspendUpkeep` removes time counters and casts the card inline during `PhaseBegin` before priority.
   - `executeSuspendFreeCastFromExile` never asks the owner whether they want to play the card (`"you may play it"` in CR 702.62a), auto-selects the first opponent/target (`engine.ts:5459-5483`), and immediately calls `resolveTopOfStack(state)` (`engine.ts:5522`).
   - `checkSuspendLegality` (`engine.ts:5554-5570`) calls `checkGlobalCastPermissionsAndRestrictions` but never checks `globalCheck.ok`, allowing players to suspend cards through casting locks (CR 702.62c).
9. **`Enchant player` Auras silently fail to attach on resolution and immediately go to the graveyard as an SBA** (`engine.ts:4241-4243`, `engine.ts:6615-6635`).

---

## Legacy-only findings (verify after step F)

1. **Equip activated ability parsing, cost modification, and resolution (`CR 702.6`)**:
   - `compiler/adapter.ts:568` explicitly skips `equip_` nodes when building IR activated abilities (`if (node.id.startsWith('equip_')) return null;`), emitting only `{ kind: 'keyword', keyword: { name: 'equip', cost } }`.
   - The actual activatable `equip_${idx}` ability comes exclusively from `oracle.ts:409-439` and `ruleTree.ts:326-341`, cost reductions for equip come from `ruleTree.ts:673-705` (alongside `compiler/statics.ts:436-439`), and resolution uses `case 'equip_target'` in `engine.ts:4564-4590` (`executeParsedEffect`). Once `oracle.ts` / `ruleTree.ts` / `executeParsedEffect` are removed in step F, Equipment will have no activated Equip ability unless the compiler expands `keyword: 'equip'` into an IR `activated` ability with an `attach` step (`runtime/effects.ts:905-924`).
2. **Ward trigger resolution (`CR 702.21`)**:
   - `compiler/triggers.ts:516-533` compiles `ward` with `effectSupported: false` and `legacy: { effects: [{ kind: 'ward_trigger', amount: 1, wardCost }], ... }`, and `engine.ts:3766` special-cases `ward_trigger` out of `isUnautomatedStackItem` so it resolves via `case 'ward_trigger'` in `engine.ts:4613-4670` (`executeParsedEffect`) using `withLegacyEventTarget(item)` (`engine.ts:4030`). Deleting `executeParsedEffect` in step F will break Ward resolution unless Ward is migrated to the IR effect interpreter.
3. **Suspend parsing and free-cast target/effect resolution (`CR 702.62`)**:
   - `checkSuspendLegality` (`engine.ts:5544`) and `suspend_card` (`engine.ts:1347`) rely on `parseSuspendClause` from `oracle.ts:1839`.
   - `executeSuspendFreeCastFromExile` (`engine.ts:5459,5502`) relies on `parseSpellOrAbilityEffects` from `oracle.ts` for target discovery and `parsedEffects`.
4. **Aura cast-time target restriction detection (`CR 702.5a`)**:
   - Cast-time target validation for Auras (`engine.ts:1465-1476`) relies on `detectTargetRequirement` in `oracle.ts:972-990` rather than compiling the `enchant` keyword's `param` into an IR `TargetSpec`.
