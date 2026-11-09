# Rules audit: 702.85–702.196 Keyword Abilities (Cascade onward) (rules.txt lines 4655–5487)
Audited at engine-rewrite 917180b on 2026-11-09.

## Summary
- Counts (302 subrules across 112 keywords, CR 702.85–702.196): **implemented 12, partial 11, missing 261, N/A 18**.
  - By keyword (112 total): **implemented 0** (all 4 supported keywords in this range have partial subrules), **partial 4** (`702.90 Infect`, `702.96 Overload`, `702.111 Menace`, `702.124 Partner`), **missing 104**, **N/A 4** (`702.106 Hidden Agenda`, `702.158 Space Sculptor`, `702.159 Visit`, `702.186 ∞ (Infinity)`).
- Top gaps (most player-visible first):
  1. **CR 702.169b–d / 702.178a / 702.142a / 702.177a / 702.193a (Solved, Max Speed, Boast, Exhaust, Power-up)** — `normalizeFace` (`compiler/normalize.ts:39,108-120`) strips any `^[A-Z][A-Za-z' -]*? — (?=[A-Z•])` prefix as a meaningless CR 207.2c ability word, causing `Solved — [Ability]` on Case cards and `Max speed — [Ability]` on Aetherdrift cards (plus `Boast —`, `Exhaust —`, and `Power-up —` abilities whose cost starts with a word) to compile with `fullySupported: true` and apply/trigger **unconditionally** without the Case being solved, without having Max Speed 4, or without once-per-turn/once-per-game/attacked-this-turn restrictions — **S**.
  2. **CR 702.108a–b (Prowess)** — `'prowess'` is included in `compiler/statics.ts:118` (`KEYWORDS`) and `runtime/layers.ts:185` (`KEYWORD_LABELS`), so cards granting Prowess (e.g. `"Creatures you control have prowess"`) compile as `fullySupported: true` and display a `"Prowess"` badge on creatures, while printed `Prowess` also displays a `"Prowess"` badge via `runtime/layers.ts:326-328`, yet no runtime spell-cast trigger exists to grant `+1/+1 until end of turn` — **S**.
  3. **CR 702.85a / 702.88a / 702.99a / 702.113a / 702.131a / 702.144a / 702.153a / 702.174a (Instant/sorcery keywords: Cascade, Rebound, Cipher, Awaken, Ascend, Demonstrate, Casualty, Gift, etc.)** — `parseSpellText` (`compiler/effects.ts:1187-1191,1218`) skips all non-period keyword lines on instants/sorceries, and `noteUnautomatedOnEnter` (`engine.ts:3299,3308-3320`) only logs unsupported keywords when a permanent enters the battlefield; casting an instant/sorcery with an unimplemented keyword resolves only its non-keyword text automatically with **zero log notice** and no manual-resolution prompt — **S**.
  4. **CR 702.124f, 702.124h, 702.124i, 702.124j, 702.124k (Partner variants & Backgrounds)** — (a) `hasGenericPartner` (`scryfall.ts:431-437`) uses `/\bpartner\b/i.test(card.oracleText)`, conflating `Partner—Survivors`, `Partner—Character select`, and `Partner—Father & son` (and any legendary creature whose rules text contains the word `"partner"`) with generic `Partner`; (b) `"Partner with [name]"` when `[name]` has no comma (e.g. *Blaring Recruiter*) compiles in `compiler/adapter.ts:198-244` as `fullySupported: true` while silently dropping the CR 702.124j ETB library-search trigger; (c) `"Commander creatures you own have ..."` on all Background enchantments is uncompiled (`static_not_compiled`) — **M**.
  5. **CR 702.122a–e / 702.161a / 702.171a–c / 702.184a–c (Crew, Living Metal, Saddle, Station)** — `Vehicle` is recognized as a card subtype (`scryfall.ts:182`, `runtime/layers.ts:142`), allowing Legendary Vehicles/Spacecraft as commanders, but `Crew N`, `Living metal`, `Saddle N`, and `Station` are completely unimplemented, leaving Vehicles unable to animate into creatures — **M**.
  6. **CR 702.85a–c (Cascade)** — Commander staple keyword (`Cascade`) is unimplemented (`keyword_not_implemented`), yet `runtime/layers.ts:179,326-328` still renders `"Cascade"` as an active keyword badge on permanents (`KEYWORD_LABELS`) and `noteUnautomatedOnEnter` only logs after the spell resolves onto the battlefield rather than when cast — **M**.
  7. **CR 702.93a / 702.135a / 702.136a / 702.147a / 702.181a (Undying, Afterlife, Riot, Decayed, Mobilize)** — Extremely common Commander creature keywords with straightforward triggered/replacement semantics are all `keyword_not_implemented` — **M**.
  8. **CR 702.116a–b / 702.141a / 702.157a–b / 702.175a–b (Myriad, Encore, Squad, Offspring)** — Token-copy multiplayer/Commander mechanics are unimplemented — **M**.
  9. **CR 702.125a–c / 702.126a–c / 702.119a–c / 702.138a–d / 702.143a–f (Undaunted, Improvise, Emerge, Escape, Foretell)** — Common Commander cost-reduction and alternative-cost/graveyard/exile-cast keywords are unimplemented (`ALTERNATIVE_COST_KEYWORDS` in `runtime/costs.ts:91-95` only contains `overload`) — **L**.
  10. **CR 702.164a–c (Toxic)** — Poison counters and SBAs are implemented for `Infect` (`engine.ts:6136,6954`), but `Toxic N` (combat damage to a player gives N poison counters in addition to life loss) is unimplemented (`keyword_not_implemented`) — **S**.
  11. **CR 702.90c–d (Infect edge cases)** — Combat damage from a creature with Infect mutates `counters['-1/-1']` directly (`engine.ts:6204-6205,6321-6322`) instead of calling `addCounters`, bypassing counter-doubling replacement effects (`runtime/replace.ts:828`) and counter triggers; noncombat damage from a source with both Infect and Deathtouch skips setting `deathtouchDamageMarked` (`runtime/effects.ts:1160-1167`); noncombat LKI (`runtime/effects.ts:1049-1081`) falls back to printed keywords rather than battlefield LKI if the source left the battlefield — **S**.
  12. **CR 702.111b (Menace + "must block if able")** — `engine.ts:2021` unconditionally ignores Menace attackers when checking `"blocks each combat if able"` (`CR 509.1c`), even when a second legal blocker is available or already assigned to block the Menace creature; bots (`ai.ts:243`) never block Menace creatures — **S**.

---

## Rule-by-rule

### 702.85 Cascade
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.85a–c | Cascade cast trigger, "as you cascade" actions, multiple instances trigger separately | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:132`) → compiles to `unsupported('keyword_not_implemented')`. No cast trigger or exile-until-lesser-MV loop exists in `runtime/` or `engine.ts`. Paradoxically, `'cascade'` is in `KEYWORD_LABELS` (`runtime/layers.ts:179`), so `evaluatePermanent` (`runtime/layers.ts:326-328`) attaches `'cascade'` to `activeKeywords` on permanents; on instants/sorceries `parseSpellText` (`compiler/effects.ts:1188,1218`) silently skips the `Cascade` line with no log notice. |

### 702.86 Annihilator
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.86a–b | Annihilator N attack trigger (defending player sacrifices N permanents); multiple instances trigger separately | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:130`) → `keyword_not_implemented`. Static grants like `"Creatures you control have annihilator 1"` also fail `parseKeywordList` (`compiler/statics.ts:101-125`) → `static_not_compiled`. |

### 702.87 Level Up
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.87a–c | Level up `[cost]` sorcery-speed activated ability; leveler card layout (CR 711); Class levels don't interact with level counters | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:141`) → `keyword_not_implemented`. No level counter ability or leveler tier static evaluation in `runtime/layers.ts`. |

### 702.88 Rebound
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.88a–c | Rebound replacement on resolution if cast from hand + next-upkeep free cast trigger; alternative cost rules; multiple instances redundant | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:145`) → `keyword_not_implemented`. On instants/sorceries, `parseSpellText` (`compiler/effects.ts:1188,1218`) skips the `Rebound` line and resolves the spell into the graveyard with no log notice. |

### 702.89 Umbra Armor
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.89a | Umbra armor destruction replacement effect on Auras | missing | Both `'umbra armor'` and `'totem armor'` are in `KNOWN_KEYWORDS` (`compiler/adapter.ts:148,150`) → `keyword_not_implemented`. `runtime/replace.ts` has no Aura destruction-replacement handler. |
| 702.89b | Older cards printed with "totem armor" received Oracle errata to "umbra armor" | N/A | Oracle errata history note; both strings are in `KNOWN_KEYWORDS` (`compiler/adapter.ts:148,150`). |

### 702.90 Infect
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.90a | Infect is a static ability | implemented | Recognised in `IMPLEMENTED_KEYWORDS` (`compiler/adapter.ts:113`), static keyword grants (`compiler/statics.ts:114`), and layer evaluation (`runtime/layers.ts:170,314`). |
| 702.90b | Damage dealt to a player by a source with infect gives poison counters instead of life loss | implemented | Combat damage in `engine.ts:6136-6137,6260-6261` and noncombat damage in `runtime/effects.ts:1203-1205` add to `player.poison` and bypass life loss (and bypass `lifeTotalCannotChangeThisTurn`). Poison SBA is enforced in `engine.ts:6954-6959`. |
| 702.90c | Damage dealt to a creature by a source with infect puts `-1/-1` counters on it instead of marking damage | partial | Combat (`engine.ts:6204-6205,6321-6322`) and noncombat (`runtime/effects.ts:1160-1167`) place `-1/-1` counters instead of `damageMarked`. Two bugs: (1) combat infect mutates `b.counters['-1/-1']` directly instead of calling `addCounters`, bypassing counter multipliers like Doubling Season / Corpsejack Menace (`runtime/replace.ts:828`) and counter triggers; (2) noncombat damage (`runtime/effects.ts:1161-1167`) puts `if (srcInfo.hasDeathtouch) target.deathtouchDamageMarked = true` inside the `else` branch, so noncombat damage from a source with both Infect and Deathtouch fails to mark deathtouch damage (CR 702.2b/c). |
| 702.90d | Last known information (LKI) used if source is no longer in expected zone when damage is dealt | partial | Combat snapshots `hasInfect` for all combatants prior to damage (`engine.ts:6013-6045`). However, for noncombat damage (`runtime/effects.ts:1049-1081`), if `sourcePerm` is no longer in `zone === 'battlefield'` when the damage step resolves, `sourceDamageInfo` falls back to `compileCard(sourceCard).faces[0]` printed abilities rather than battlefield LKI, losing temporary/granted Infect. |
| 702.90e | Infect rules function no matter what zone an object with infect deals damage from | implemented | `sourceDamageInfo` (`runtime/effects.ts:1064-1081`) reads `sourceCard.keywords` and compiled face keyword abilities when the source is not on the battlefield. |
| 702.90f | Multiple instances of infect on the same object are redundant | implemented | Evaluated as a boolean (`hasKeyword(perm, 'Infect', state)` in `engine.ts:6044`; `kws.includes('infect')` in `runtime/effects.ts:1058,1076`). |

### 702.91 Battle Cry
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.91a–b | Battle cry attack trigger (`+1/+0` to each other attacking creature); multiple instances trigger separately | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:131`) → `keyword_not_implemented`. |

### 702.92 Living Weapon
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.92a | Living weapon ETB trigger (create 0/0 black Phyrexian Germ token and attach) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:141`) → `keyword_not_implemented`. |

### 702.93 Undying
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.93a | Undying dies trigger (if no `+1/+1` counters, return to battlefield under owner's control with a `+1/+1` counter) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:149`) → `keyword_not_implemented`. |

### 702.94 Miracle
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.94a–b | Miracle static reveal on first draw of turn + linked triggered ability to cast for miracle cost; keep revealed while on stack | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:142`) → `keyword_not_implemented`. Draw logic does not pause or prompt for Miracle reveals. |

### 702.95 Soulbond
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.95a–e | Soulbond pairing triggers, "paired"/"unpaired" designation, resolution legality check, max one pair, unpairing conditions | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:146`) → `keyword_not_implemented`. No `pairedWith` state exists on `CardInstance` (`types.ts`). |

### 702.96 Overload
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.96a | Overload `[cost]` alternative cost + replace all instances of `'target'` with `'each'` | partial | Recognised in `IMPLEMENTED_KEYWORDS` (`compiler/adapter.ts:116`) and `ALTERNATIVE_COST_KEYWORDS` (`runtime/costs.ts:80-95,115-120`); `castMode: 'overload'` is supported in `engine.ts:530-585,1523-1540` and `runtime/effects.ts:302-313,622-641,1246-1256`. Three gaps: (1) `interpretableNow` (`runtime/effects.ts:302-313`) rejects Overload whenever a target spec has `spec.kind === 'player'`, so player-targeted Overload spells cannot auto-resolve; (2) `isOverloadCastMode` (`engine.ts:530-542`) falls back to `xValue >= 1 && !/\{X\}/i.test(card.manaCost)` when `castMode` is omitted; (3) legacy `bounce_target` (`engine.ts:4827-4845`) hardcodes bouncing opponents' nonland permanents (*Cyclonic Rift*). |
| 702.96b | Overloaded spell requires no targets and may affect objects that couldn't be chosen as legal targets | implemented | `engine.ts:7620-7624,7759-7768` and `ruleTree.ts:291-318` set `requiresTarget: false` / `minTargets: 0, maxTargets: 0`, and `runtime/effects.ts:622-641` iterates `allPermanents` via `matchesFilter` without target legality/hexproof/shroud checks. |
| 702.96c | Overload's second ability creates a text-changing effect (CR 612) | partial | Approximated via an `overload: boolean` execution flag in `runtime/effects.ts:622-641,1246-1256` rather than a CR 612 text-changing effect. |

### 702.97 Scavenge
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.97a | Scavenge `[cost]` sorcery-speed graveyard activated ability (`+1/+1` counters equal to exiled card's power) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:146`) → `keyword_not_implemented`. |

### 702.98 Unleash
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.98a | Unleash optional ETB `+1/+1` counter replacement + can't block while it has a `+1/+1` counter | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:149`) → `keyword_not_implemented`. |

### 702.99 Cipher
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.99a–c | Cipher spell ability to exile encoded on a creature + granted combat-damage free-copy trigger; encoded designation tracking | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:132`) → `keyword_not_implemented`. Silently skipped on instants/sorceries by `parseSpellText` (`compiler/effects.ts:1188,1218`). |

### 702.100 Evolve
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.100a–d | Evolve creature-ETB trigger (greater P or T puts a `+1/+1` counter), "evolves" event, noncreature P/T rule, multiple instances | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:136`) → `keyword_not_implemented`. However, `'evolve'` is in `KEYWORD_LABELS` (`runtime/layers.ts:178`), so `evaluatePermanent` (`runtime/layers.ts:326-328`) still shows `'Evolve'` in `activeKeywords` on permanents despite no trigger existing. |

### 702.101 Extort
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.101a–b | Extort spell-cast trigger (may pay `{W/B}` to drain each opponent for 1); multiple instances trigger separately | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:137`) → `keyword_not_implemented`. |

### 702.102 Fuse
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.102a–d | Fuse static ability on split cards (cast both halves from hand, combined characteristics/cost, left-then-right resolution) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:138`), and split cards (`card.oracleText.includes('\n//\n')`) are rejected early as `unsupported('multiface')` in `compiler/adapter.ts:99-109`. |

### 702.103 Bestow
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.103a–g | Bestow `[cost]` alternative cost to cast as an Aura enchantment with enchant creature; fallback to creature on illegal target or unattachment | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:131`) → `keyword_not_implemented`. |

### 702.104 Tribute
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.104a–b | Tribute N opponent choice on ETB for N `+1/+1` counters; linked "if tribute wasn't paid" condition | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:148`) → `keyword_not_implemented`. |

### 702.105 Dethrone
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.105a–b | Dethrone attack trigger when attacking player with most/tied-for-most life; multiple instances trigger separately | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:134`) → `keyword_not_implemented`. |

### 702.106 Hidden Agenda
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.106a–f | Hidden agenda / Double agenda on Conspiracy cards in the command zone | N/A | Conspiracy card mechanic for Conspiracy draft formats; Conspiracy cards are not legal in Commander (`702.106b` is also physical paper note-taking). |

### 702.107 Outlast
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.107a | Outlast `[cost]` (`[Cost], {T}: Put a +1/+1 counter on this creature. Activate only as a sorcery.`) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:143`) → `keyword_not_implemented`. |

### 702.108 Prowess
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.108a–b | Prowess noncreature-spell cast trigger (`+1/+1` until end of turn); multiple instances trigger separately | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:144`) → `keyword_not_implemented` on printed keyword lines, **but** `'prowess'` is included in `KEYWORDS` (`compiler/statics.ts:118`) and `KEYWORD_LABELS` (`runtime/layers.ts:185`). As a result, static grants (`"Creatures you control have prowess"`) compile with `fullySupported: true` (`addKeywords: ['prowess']`) and both printed and granted Prowess appear in `activeKeywords` (`runtime/layers.ts:326-328`) while silently doing nothing when noncreature spells are cast. |

### 702.109 Dash
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.109a | Dash `[cost]` alternative cost + haste + end-step return-to-hand delayed trigger | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:134`) → `keyword_not_implemented`. |

### 702.110 Exploit
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.110a–b | Exploit ETB optional creature-sacrifice trigger; "exploits a creature" event | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:137`) → `keyword_not_implemented`. |

### 702.111 Menace
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.111a | Menace is an evasion ability | implemented | Recognised in `IMPLEMENTED_KEYWORDS` (`compiler/adapter.ts:115`), static keyword grants (`compiler/statics.ts:117`), token parser (`oracle.ts:1507`), and layer evaluation (`runtime/layers.ts:172,314`). |
| 702.111b | A creature with menace can't be blocked except by two or more creatures | partial | `engine.ts:1975-1988` rejects declare-blockers submissions where a Menace attacker is assigned exactly 1 blocker (`bIds.length === 1`). However: (1) `engine.ts:2021` (`return !hasKeyword(atk, 'Menace', state)`) unconditionally excludes Menace attackers when enforcing `"blocks each combat if able"` (`CR 509.1c`), even when the defending player has 2+ legal blockers (or has already assigned a second blocker to that Menace attacker); (2) `ai.ts:243` skips Menace attackers entirely rather than double-blocking when profitable. |
| 702.111c | Multiple instances of menace on the same creature are redundant | implemented | `hasKeyword(atkCard, 'Menace', state)` (`engine.ts:1981`) is a boolean check. |

### 702.112 Renown
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.112a–c | Renown N combat-damage-to-player trigger, "renowned" designation, multiple instances | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:145`) → `keyword_not_implemented`. |

### 702.113 Awaken
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.113a–b | Awaken N—`[cost]` alternative cost + animate target land with N `+1/+1` counters; target chosen only if awaken cost paid | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:131`) → `keyword_not_implemented`. Silently skipped on instants/sorceries by `parseSpellText` (`compiler/effects.ts:1188,1218`). |

### 702.114 Devoid
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.114a | Devoid characteristic-defining ability (object is colorless in all zones) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:134`) → `keyword_not_implemented`. (Scryfall already sets `colors: []` on printed Devoid cards, but effects that grant/remove abilities or inspect Devoid as a CDA do not evaluate it in `runtime/layers.ts`.) |

### 702.115 Ingest
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.115a–b | Ingest combat-damage-to-player trigger (damaged player exiles top card of library); multiple instances | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:140`) → `keyword_not_implemented`. |

### 702.116 Myriad
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.116a–b | Myriad attack trigger (token copies attacking each other opponent, exiled at end of combat); multiple instances | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:142`) → `keyword_not_implemented`. |

### 702.117 Surge
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.117a | Surge `[cost]` alternative cost if you or a teammate cast another spell this turn | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:148`) → `keyword_not_implemented`. |

### 702.118 Skulk
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.118a–c | Skulk evasion ability (can't be blocked by creatures with greater power); multiple instances redundant | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:146`) → `keyword_not_implemented`. Not checked in `declare_blockers` (`engine.ts:1900-1990`). |

### 702.119 Emerge
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.119a–c | Emerge `[cost]` and Emerge from `[quality]` `[cost]` alternative cost with sacrifice + MV cost reduction | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:135`) → `keyword_not_implemented`. |

### 702.120 Escalate
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.120a | Escalate `[cost]` additional cost per mode beyond the first | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:136`) → `keyword_not_implemented`. |

### 702.121 Melee
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.121a–b | Melee attack trigger (`+1/+1` per opponent you attacked this combat); multiple instances trigger separately | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:141`) → `keyword_not_implemented`. |

### 702.122 Crew
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.122a–e | Crew N activated ability on Vehicles, "crews a Vehicle" / "crewed by" designations, "can't crew", "becomes crewed" triggers | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:133`) → `keyword_not_implemented`. Although `Vehicle` is recognised as a subtype (`runtime/layers.ts:142`, `runtime/objectFilter.ts:52`, `scryfall.ts:182`), Vehicles cannot be crewed. |

### 702.123 Fabricate
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.123a–b | Fabricate N ETB trigger (choose N `+1/+1` counters or N 1/1 Servo tokens); multiple instances trigger separately | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:137`) → `keyword_not_implemented`. |

### 702.124 Partner
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.124a | Partner abilities modify Commander deck construction and allow two commanders | partial | `validateCommanderDeck` and `areValidCommanderPartners` (`scryfall.ts:452-518`) validate two-commander decks for Partner, Partner with, Friends forever, Choose a Background, and Doctor's companion, but miss non-Friends-forever `Partner—[text]` variants as distinct groups. |
| 702.124b | 100-card deck including two commanders; both begin in the command zone | implemented | `validateCommanderDeck` (`scryfall.ts:413-425,560-566`) includes all commanders in the 100-card count; `createInitialGameState` (`engine.ts:310-370`) places both commanders in `player.command`. |
| 702.124c | Combined color identity of two commanders | implemented | `validateCommanderDeck` (`scryfall.ts:400-411`), `getPlayerCommanderIdentity` (`engine.ts:514-528`), and `commanderColors` (`runtime/effects.ts:1683-1703`) union the color identities of both commanders. |
| 702.124d | Commanders function independently for commander tax and 21 combat damage | implemented | `commanderCastCounts[inst.instanceId]` (`engine.ts:363,1516-1520`, `runtime/costs.ts:211-214`) and `commanderDamageTaken[attacker.instanceId]` (`engine.ts:368,6161-6168,6266-6269,6967`) are keyed by each commander's `instanceId` independently. |
| 702.124e | Effects referring to "your commander" refer to either one (or player chooses if action affects one) | missing | No general `"your commander"` or `"commander creatures you own"` selector exists in `compiler/statics.ts`, `compiler/effects.ts`, or `runtime/objectFilter.ts` (only legacy multi-word type filter in `engine.ts:7187` checks `perm.isCommander`). |
| 702.124f | Different partner abilities are distinct and cannot be combined | partial | `areValidCommanderPartners` (`scryfall.ts:452-489`) checks each pairing family separately, **except** `hasGenericPartner` (`scryfall.ts:431-437`) only excludes `partnerWithTarget`, `hasFriendsForever`, and `hasDoctorsCompanion`, so `Partner—Survivors`, `Partner—Character select`, and `Partner—Father & son` match `/\bpartner\b/i` and can illegally pair with generic `Partner` or with each other. |
| 702.124g | A card with multiple partner abilities can only use one; max two commanders | implemented | `validateCommanderDeck` (`scryfall.ts:504-505,513-517`) enforces `commanders.length <= 2` and requires `areValidCommanderPartners(c1, c2)`. |
| 702.124h | "Partner" allows two legendary cards that both have generic partner | partial | `scryfall.ts:431-437,454-456` enforces generic Partner pairing, but `/\bpartner\b/i.test(card.oracleText)` in `hasGenericPartner` false-positives on any legendary creature whose oracle text contains the English word `"partner"` or a `Partner—[text]` variant. |
| 702.124i | "Partner—[text]" requires both commanders to have the exact same `Partner—[text]` ability | partial | `"Friends forever"` is checked in `scryfall.ts:409-414,470-473`, but `"Partner—Character select"`, `"Partner—Father & son"`, and `"Partner—Survivors"` are not parsed as distinct `[text]` groups and fall into `hasGenericPartner`. |
| 702.124j | "Partner with [name]" allows pairing the two named cards AND gives an ETB library-search triggered ability | partial | Deck pairing is validated in `scryfall.ts:404-407,457-469` (though `partnerWithTarget`'s regex `/\bPartner with ([^\n(.]+)/i` can truncate names containing a period such as initials). The in-game ETB search trigger is completely missing. Moreover, when `[name]` has no comma (e.g. *Blaring Recruiter*'s `"Partner with Blaring Captain"`), `compiler/adapter.ts:198-244` parses it as `{ name: 'partner', param: 'with Blaring Captain' }` and marks it `fullySupported: true` (`IMPLEMENTED_KEYWORDS.has('partner')`), suppressing any unsupported-ability warning. |
| 702.124k | "Choose a Background" pairs with a legendary Background enchantment; Background can't be a solo commander | partial | Deck validation (`scryfall.ts:440-450,474-480,508-512`) enforces `hasChooseABackground` + `isLegendaryBackground` and rejects a single Background commander (`canBeCommander` is `false` for Enchantments at `scryfall.ts:185-187`). However, in-game, every Background's `"Commander creatures you own have ..."` static ability fails to compile (`static_not_compiled` in `compiler/statics.ts`). |
| 702.124m | "Doctor's companion" pairs with a legendary Time Lord Doctor creature with no other creature types | implemented | `scryfall.ts:416-429,481-487` validates `hasDoctorsCompanion` + `isTimeLordDoctor`, using `splitSubtypes` (`runtime/layers.ts:83-89`) to preserve `'Time Lord'` as a single subtype and verify `subs.length === 2`. |
| 702.124n | Effects referring to a partner ability by name or to "partner" generally | missing | No runtime filter or effect queries partner abilities on cards/permanents. |

### 702.125 Undaunted
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.125a–c | Undaunted spell cost reduction (`{1}` less per opponent still in the game); multiple instances cumulative | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:149`) → `keyword_not_implemented`. |

### 702.126 Improvise
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.126a–c | Improvise (tap untapped artifacts you control to pay `{1}` each after total cost is determined); redundant multiples | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:140`) → `keyword_not_implemented`. |

### 702.127 Aftermath
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.127a | Aftermath on split cards (cast right half only from graveyard, exile when leaving stack) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:130`), and split cards compile to `unsupported('multiface')` (`compiler/adapter.ts:99-109`). |

### 702.128 Embalm
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.128a–b | Embalm `[cost]` graveyard activated ability (exile to create white Zombie token copy with no mana cost); "embalmed" designation | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:135`) → `keyword_not_implemented`. |

### 702.129 Eternalize
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.129a | Eternalize `[cost]` graveyard activated ability (exile to create 4/4 black Zombie token copy with no mana cost) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:136`) → `keyword_not_implemented`. |

### 702.130 Afflict
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.130a–b | Afflict N becomes-blocked trigger (defending player loses N life); multiple instances trigger separately | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:130`) → `keyword_not_implemented`. |

### 702.131 Ascend
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.131a–d | Ascend spell ability / permanent static ability (10+ permanents grants "the city's blessing" for rest of game; reapply continuous effects before trigger checks) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:130`) → `keyword_not_implemented`. No `citysBlessing` state on `PlayerGameState` (`types.ts`). On instants/sorceries, `parseSpellText` (`compiler/effects.ts:1188,1218`) silently skips the `Ascend` line. |

### 702.132 Assist
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.132a | Assist (chosen player may pay any amount of generic mana in spell's total cost) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:130`) → `keyword_not_implemented`. |

### 702.133 Jump-Start
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.133a | Jump-start graveyard cast permission with discard additional cost + exile when leaving stack | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:140`) → `keyword_not_implemented`. |

### 702.134 Mentor
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.134a–c | Mentor attack trigger (`+1/+1` counter on target attacking creature with lesser power), multiple instances, "mentors" event | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:141`) → `keyword_not_implemented`. |

### 702.135 Afterlife
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.135a–b | Afterlife N dies trigger (create N 1/1 white and black Spirit tokens with flying); multiple instances trigger separately | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:130`) → `keyword_not_implemented`. |

### 702.136 Riot
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.136a–b | Riot ETB choice (`+1/+1` counter or haste); multiple instances work separately | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:146`) → `keyword_not_implemented`. |

### 702.137 Spectacle
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.137a | Spectacle `[cost]` alternative cost if an opponent lost life this turn | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:147`) → `keyword_not_implemented`. |

### 702.138 Escape
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.138a–d | Escape `[cost]` alternative cost from graveyard, "escaped" designation, "escapes with [counters/ability]" | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:136`), though because Oracle writes `"Escape—{cost}, Exile N other cards from your graveyard."` with a trailing period, `adaptKeywordLine` (`compiler/adapter.ts:220`) returns `null` and it compiles to `static_not_compiled` / `unparsed`. |

### 702.139 Companion
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.139a–d | Companion deck-construction condition, pre-game reveal, `{3}` sorcery-speed special action to put into hand, Commander legality | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:133`), though `"Companion — [Condition]."` has a trailing period and `ABILITY_WORD` prefix (`compiler/normalize.ts:39`), compiling to `static_not_compiled`. Neither `scryfall.ts` nor `engine.ts` supports a companion slot or the `{3}` special action. |

### 702.140 Mutate
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.140a–f | Mutate `[cost]` alternative cost targeting non-Human creature with same owner, fallback on illegal target, merging permanents (CR 731), "mutates" trigger, merged characteristics | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:142`) → `keyword_not_implemented`. No merged-permanent stack exists on `CardInstance`. |

### 702.141 Encore
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.141a | Encore `[cost]` sorcery-speed graveyard activated ability (exile to create haste token copies attacking each opponent, sacrificed at next end step) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:136`) → `keyword_not_implemented` (and ignored by legacy `oracle.ts:1062`). |

### 702.142 Boast
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.142a–b | Boast — `[Cost]: [Effect]` (activate only if this creature attacked this turn and only once each turn); "boasting" reference | missing | Not enforced. Worse, if `[Cost]` starts with an uppercase word (e.g. `"Boast — Sacrifice a creature: ..."`), `ABILITY_WORD` (`compiler/normalize.ts:39`) strips `"Boast — "` as an ability word and compiles the ability with `fullySupported: true` and **no** attack or once-per-turn restriction; for mana costs (`"Boast — {1}{R}: ..."`), legacy `oracle.ts:479` also strips `"Boast — "` and offers the unrestricted activated ability. |

### 702.143 Foretell
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.143a–d, 702.143f | Foretell `{2}` special action to exile face down from hand, cast on later turn for foretell cost, "foretold" designation, reveal on leaving game / game end | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:138`) → `keyword_not_implemented`. No special action or foretold state exists in `engine.ts` / `types.ts`. |
| 702.143e | Physical differentiation of multiple face-down foretold cards in exile | N/A | Physical-card handling rule; digital engine tracks distinct `CardInstance` objects in `exile` by `instanceId`. |

### 702.144 Demonstrate
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.144a | Demonstrate cast trigger (may copy spell; if you do, chosen opponent also copies it) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:134`) → `keyword_not_implemented`. Silently skipped on instants/sorceries by `parseSpellText` (`compiler/effects.ts:1188,1218`). |

### 702.145 Daybound and Nightbound
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.145a–g | Daybound and Nightbound on DFCs, entering transformed at night, immediate transform on day/night mismatch, initializing day/night | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:134,143`), and DFCs (`card.backFace`) compile to `unsupported('multiface')` (`compiler/adapter.ts:99-109`). `GameState` (`types.ts`) has no day/night designation. |

### 702.146 Disturb
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.146a–b | Disturb `[cost]` alternative cost to cast DFC transformed from graveyard; enters back face up | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:135`), and DFCs compile to `unsupported('multiface')` (`compiler/adapter.ts:99-109`). |

### 702.147 Decayed
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.147a | Decayed static ability (can't block) + attack trigger (sacrifice at end of combat) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:134`) → `keyword_not_implemented`. |

### 702.148 Cleave
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.148a–b | Cleave `[cost]` alternative cost + text-changing effect removing bracketed text | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:132`) → `keyword_not_implemented`. Silently skipped on instants/sorceries by `parseSpellText` (`compiler/effects.ts:1188,1218`), and square brackets are not stripped or handled in `compiler/normalize.ts`. |

### 702.149 Training
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.149a–c | Training attack trigger (attacking with a higher-power creature puts a `+1/+1` counter), multiple instances, "when this creature trains" trigger | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:148`) → `keyword_not_implemented`. |

### 702.150 Compleated
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.150a | Compleated planeswalker replacement effect (2 fewer loyalty counters per Phyrexian mana symbol paid with life) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:133`) → `keyword_not_implemented`. |

### 702.151 Reconfigure
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.151a–b | Reconfigure `[cost]` sorcery-speed attach and unattach activated abilities; stops being a creature while attached | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:145`) → `keyword_not_implemented`. |

### 702.152 Blitz
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.152a–b | Blitz `[cost]` alternative cost (haste, dies-draw trigger, sacrifice at next end step); multiple instances | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:131`) → `keyword_not_implemented`. |

### 702.153 Casualty
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.153a–b | Casualty N optional additional sacrifice cost (power >= N) + linked cast trigger to copy spell; multiple instances | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:132`) → `keyword_not_implemented`. Silently skipped on instants/sorceries by `parseSpellText` (`compiler/effects.ts:1188,1218`). |

### 702.154 Enlist
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.154a–d | Enlist optional attack cost (tap non-attacking non-summoning-sick creature) + linked `+X/+0` trigger; "enlists" event; multiple instances | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:136`) → `keyword_not_implemented`. |

### 702.155 Read Ahead
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.155a–c | Read ahead on Sagas (choose starting lore counter count 1..N; chapter abilities only trigger on entry turn for exact chosen chapter) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:145`) → `keyword_not_implemented`, and Saga chapter lines compile to `unsupported('unparsed')` (`compiler/adapter.ts:125-128`). |

### 702.156 Ravenous
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.156a | Ravenous replacement effect (enters with X `+1/+1` counters) + ETB trigger (if X >= 5, draw a card) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:144`) → `keyword_not_implemented`. |

### 702.157 Squad
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.157a–b | Squad `[cost]` repeatable additional cost + linked ETB trigger to create token copies; multiple instances | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:147`) → `keyword_not_implemented`. |

### 702.158 Space Sculptor
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.158a–e | Space sculptor sector designations (alpha, beta, gamma) | N/A | Acorn / Un-set mechanic exclusive to *Space Beleren* (*Unfinity*), not legal in Commander (though `'space sculptor'` is in `KNOWN_KEYWORDS` at `compiler/adapter.ts:147`). |

### 702.159 Visit
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.159a–b | Visit — `[Effect]` and Prize abilities on Attraction cards | N/A | Attraction card mechanic (*Unfinity*); Attractions are banned in Commander. |

### 702.160 Prototype
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.160a | Prototype alternative power, toughness, and mana cost characteristics | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:144`) → `keyword_not_implemented`. |

### 702.161 Living Metal
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.161a | Living metal on Vehicles ("During your turn, this permanent is an artifact creature in addition to its other types.") | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:141`) → `keyword_not_implemented`. |

### 702.162 More Than Meets the Eye
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.162a | More Than Meets the Eye `[cost]` alternative cost to cast converted | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:142`), and DFCs compile to `unsupported('multiface')` (`compiler/adapter.ts:99-109`). |

### 702.163 For Mirrodin!
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.163a | For Mirrodin! Equipment ETB trigger (create 2/2 red Rebel token and attach) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:138`) via `'for mirrodin!'`, **but** `adaptKeywordLine` (`compiler/adapter.ts:220`) only rejects lines ending in `.`, while `isNonEffectLine` (`compiler/effects.ts:1189`) treats `!` like `.` — on an Equipment, `'For Mirrodin!'` compiles to `keyword_not_implemented`. |

### 702.164 Toxic
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.164a–c | Toxic N static ability, total toxic value sum, combat damage to a player gives N poison counters in addition to damage's other results | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:151`) → `keyword_not_implemented`. Only `Infect` is checked during combat damage (`engine.ts:6044,6136`). |

### 702.165 Backup
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.165a–d | Backup N ETB trigger (N `+1/+1` counters on target creature; if another creature, grants printed abilities below backup until EOT) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:131`) → `keyword_not_implemented`. |

### 702.166 Bargain
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.166a–d | Bargain optional additional cost (sacrifice artifact, enchantment, or token), "bargained" designation, linked abilities and conditional targets | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:131`) → `keyword_not_implemented`. Silently skipped on instants/sorceries by `parseSpellText` (`compiler/effects.ts:1188,1218`). |

### 702.167 Craft
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.167a–c | Craft with `[materials]` `[cost]` sorcery-speed activated ability to exile self + materials from battlefield/graveyard and return transformed; exiled materials reference | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:133`), and DFCs compile to `unsupported('multiface')` (`compiler/adapter.ts:99-109`). |

### 702.168 Disguise
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.168a–f | Disguise `[cost]` (cast face down for `{3}` as 2/2 with ward `{2}`; special action to turn face up by paying disguise cost) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:135`) → `keyword_not_implemented`. Although `CardInstance.isFaceDown` exists (`types.ts:288`), there is no face-down casting or turn-face-up special action in `engine.ts`. |

### 702.169 Solved
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.169a–d | Solved — `[Ability text]` on Case cards (static, triggered, or activated ability active/usable only if this Case is solved) | missing | Not in `KNOWN_KEYWORDS`, and Case solving (CR 720) is unimplemented. Worse, `ABILITY_WORD` (`compiler/normalize.ts:39,108-120`) strips `"Solved — "` as if it were an ability word, causing `Solved — [Ability]` static, triggered, and word-cost activated abilities to compile with `fullySupported: true` and apply **unconditionally** even though the Case is unsolved! |

### 702.170 Plot
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.170a–f | Plot `[cost]` sorcery-speed special action to exile from hand as a plotted card; free sorcery-speed cast on a later turn | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:144`) → `keyword_not_implemented`. |

### 702.171 Saddle
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.171a–c | Saddle N sorcery-speed activated ability on Mounts (tap other creatures with total power >= N to become "saddled" until EOT); "saddles" event | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:146`) → `keyword_not_implemented`. |

### 702.172 Spree
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.172a | Spree on modal spells (choose one or more modes and pay the additional cost associated with each chosen mode) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:147`) → `keyword_not_implemented`, and `+ [Cost] — [Effect]` mode lines are not recognised as modal bullets by `groupLines` (`compiler/adapter.ts:175-185`) or `parseSpellText` (`compiler/effects.ts:1207-1216`, which only checks `•`). |
| 702.172b | Visual `+` sign icon in upper right corner and `+` bullet points have no additional rules meaning | N/A | Visual card-frame reminder rule. |

### 702.173 Freerunning
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.173a | Freerunning `[cost]` alternative cost if a player was dealt combat damage this turn by an Assassin or commander you controlled | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:138`, wait: actually `'freerunning'` is not in `KNOWN_KEYWORDS` in `compiler/adapter.ts:128-153`, so it falls through to `unparsed` / `static_not_compiled`, or is skipped by `isNonEffectLine` on instants/sorceries). |

### 702.174 Gift
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.174a–k, 702.174m | Gift a `[something]` optional additional cost (choose an opponent) + permanent ETB trigger or spell pre-effect (Food, card, tapped Fish, extra turn, Treasure, Octopus); "gives a gift" trigger; "gift was promised" conditional targets | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:139`) → `keyword_not_implemented`. On instants/sorceries, `parseSpellText` (`compiler/effects.ts:1188,1218`) skips the `Gift a ...` line. (Note: CR skips 702.174l.) |

### 702.175 Offspring
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.175a–b | Offspring `[cost]` optional additional cost + linked ETB trigger to create a 1/1 token copy; multiple instances | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:143`) → `keyword_not_implemented`. |

### 702.176 Impending
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.176a | Impending N—`[cost]` alternative cost (enters with N time counters, not a creature while it has time counters, end-step counter removal trigger) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:140`) → `keyword_not_implemented`. |

### 702.177 Exhaust
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.177a–b | Exhaust — `[Cost]: [Effect]` (activate only once per game); "haven't activated an exhaust ability this turn" check | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:151`), but `"Exhaust — [Cost]: [Effect]"` ends with a period so `adaptKeywordLine` (`compiler/adapter.ts:220`) skips it. When `[Cost]` starts with a word (`"Exhaust — Sacrifice a creature: ..."`), `ABILITY_WORD` (`compiler/normalize.ts:39`) strips `"Exhaust — "` and compiles it as an unrestricted repeatable activated ability (`fullySupported: true`); for mana costs (`"Exhaust — {2}{G}: ..."`), legacy `oracle.ts:479` also strips `"Exhaust — "` and offers repeatable activation. |

### 702.178 Max Speed
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.178a–b | Max speed — `[Ability]` ("As long as your speed is 4, this object has '[Ability]'"); zone inheritance | missing | Not in `KNOWN_KEYWORDS`, and player speed is not tracked. Worse, `ABILITY_WORD` (`compiler/normalize.ts:39,108-120`) strips `"Max speed — "` as an ability word, causing `Max speed — [Ability]` static, triggered, and word-cost activated abilities to compile with `fullySupported: true` and apply **unconditionally** at speed 0! |

### 702.179 Start Your Engines!
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.179a–f | Start your engines! SBA (sets speed to 1), player speed 0..4 tracking, inherent once-per-turn speed-increase trigger on opponent life loss | missing | Not in `KNOWN_KEYWORDS` (`compiler/adapter.ts:128-153`); because `"Start your engines!"` ends with `!`, `adaptKeywordLine` (`compiler/adapter.ts:220`) would parse it if added, but currently it falls through to `static_not_compiled`. No `speed` field exists on `PlayerGameState` (`types.ts`). |

### 702.180 Harmonize
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.180a–b | Harmonize `[cost]` alternative cost from graveyard with optional creature tap for power-based generic mana reduction + exile on leaving stack | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:151`) → `keyword_not_implemented`. |

### 702.181 Mobilize
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.181a | Mobilize N attack trigger (create N tapped and attacking 1/1 red Warrior tokens, sacrificed at next end step) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:152`) → `keyword_not_implemented`. |

### 702.182 Job Select
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.182a | Job select Equipment ETB trigger (create 1/1 colorless Hero token and attach) | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:152`) → `keyword_not_implemented`. |

### 702.183 Tiered
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.183a | Tiered modal spell static ability (choose one mode and pay the cost associated with that mode) | missing | Not in `KNOWN_KEYWORDS` (`compiler/adapter.ts:128-153`); compiles to `unparsed` / skipped on instants and sorceries (`compiler/effects.ts:1188,1218`). |

### 702.184 Station
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.184a–c | Station sorcery-speed activated ability (tap another untapped creature to put charge counters equal to its power), station cards (CR 722), stationing with toughness modifiers | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:151`) → `keyword_not_implemented`. (`Spacecraft` is recognised for `canBeCommander` in `scryfall.ts:183`, but Station abilities are not implemented.) |

### 702.185 Warp
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.185a–c | Warp `[cost]` alternative cost from hand + exile permanent at next end step with permission to cast on a later turn; "warped" designations | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:152`) → `keyword_not_implemented`. |

### 702.186 ∞ (Infinity)
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.186a–b | ∞ — `[Ability]` ("As long as this permanent is harnessed, it has [ability]") on Infinity cards | N/A | Playtest / *Mystery Booster 2* Infinity mechanic, not legal in Commander. |

### 702.187 Mayhem
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.187a–c | Mayhem `[cost]` (cast from graveyard for `[cost]` if discarded this turn) and costless Mayhem (play from graveyard if discarded this turn) | missing | Not in `KNOWN_KEYWORDS` (`compiler/adapter.ts:128-153`) → compiles to `static_not_compiled` / skipped by `isNonEffectLine`. |

### 702.188 Web-slinging
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.188a | Web-slinging `[cost]` alternative cost by paying `[cost]` and returning a tapped creature you control to hand | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:152`) → `keyword_not_implemented`. |

### 702.189 Firebending
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.189a–b | Firebending N attack trigger (add N `{R}` that isn't lost as steps/phases end until end of combat); "whenever a player firebends" trigger | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:152`) → `keyword_not_implemented`. |

### 702.190 Sneak
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.190a–b | Sneak `[cost]` alternative cost during declare blockers step by returning an unblocked attacker to hand; enters tapped and attacking same defender | missing | Listed in `KNOWN_KEYWORDS` (`compiler/adapter.ts:152`) → `keyword_not_implemented`. |

### 702.191 Increment
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.191a–b | Increment spell-cast trigger (if mana spent > this creature's power or toughness, put a `+1/+1` counter on it); multiple instances | missing | Not in `KNOWN_KEYWORDS` (`compiler/adapter.ts:128-153`) → compiles to `static_not_compiled`. |

### 702.192 Paradigm
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.192a | Paradigm spell abilities (first resolution creates a rest-of-game precombat-main-phase free copy trigger; exile this spell) | missing | Not in `KNOWN_KEYWORDS` (`compiler/adapter.ts:128-153`); silently skipped on instants/sorceries by `parseSpellText` (`compiler/effects.ts:1188,1218`). |

### 702.193 Power-up
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.193a–b | Power-up — `[Cost]: [Effect]` (if entered this turn, cost reduced by permanent's mana cost; activate only once); colored/generic reduction rules | missing | Not in `KNOWN_KEYWORDS` (`compiler/adapter.ts:128-153`). Like `Boast` and `Exhaust`, when `[Cost]` starts with an uppercase word, `ABILITY_WORD` (`compiler/normalize.ts:39`) strips `"Power-up — "` and compiles the ability as a repeatable activated ability with `fullySupported: true`; for mana costs, legacy `oracle.ts:479` also strips `"Power-up — "`. |

### 702.194 Teamwork
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.194a–c | Teamwork N optional additional cost (tap creatures you control with total power >= N), "using teamwork" reference, conditional targets | missing | Not in `KNOWN_KEYWORDS` (`compiler/adapter.ts:128-153`) → compiles to `static_not_compiled` / skipped on instants and sorceries (`compiler/effects.ts:1188,1218`). |

### 702.195 Storied
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.195a–c | Storied static ability (controlling 3+ artifacts, Sagas, and/or legendary permanents grants "enduring story" for rest of game) | missing | Not in `KNOWN_KEYWORDS` (`compiler/adapter.ts:128-153`) → compiles to `static_not_compiled`. |

### 702.196 Beam me up
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 702.196a–b | Beam me up `[cost]` alternative cost from graveyard for instants/sorceries by returning a creature you control to hand + exile on leaving stack; "can't be beamed up" restriction | missing | Not in `KNOWN_KEYWORDS` (`compiler/adapter.ts:128-153`); silently skipped on instants/sorceries by `parseSpellText` (`compiler/effects.ts:1188,1218`). |

---

## Silently skipped / approximated behaviour
- **`Solved —`, `Max speed —`, `Boast —`, `Exhaust —`, and `Power-up —` stripped as ability words and executed unconditionally** (`compiler/normalize.ts:39,108-120`, `oracle.ts:479`): `ABILITY_WORD` (`/^([A-Z][A-Za-z' -]*?) — (?=[A-Z•])/`) matches any capitalized prefix before an em-dash and strips it before static, trigger, and activated-ability compilation. Consequently:
  - Case cards with `Solved — [Ability]` (`CR 702.169b–d`) and Aetherdrift cards with `Max speed — [Ability]` (`CR 702.178a`) compile with `fullySupported: true` (no deck-builder warning, no on-enter notice) and have their Solved / Max Speed static, triggered, or activated abilities active **from turn 1** without solving the Case or reaching speed 4.
  - `Boast — [Cost]: [Effect]` (`CR 702.142a`), `Exhaust — [Cost]: [Effect]` (`CR 702.177a`), and `Power-up — [Cost]: [Effect]` (`CR 702.193a`) whose cost starts with an uppercase word (e.g. `Sacrifice`, `Tap`, `Pay`, `Discard`, `Exile`) compile with `fullySupported: true` as unrestricted, infinitely repeatable activated abilities. Even when `[Cost]` starts with `{`, `oracle.ts:479` (`rawLine.replace(/^[A-Za-z' -]+\s+—\s+/, '')`) strips the keyword header and exposes the legacy activated ability without the attacked-this-turn or once-per-turn/once-per-game restriction.
- **Prowess grants compile as `fullySupported: true` and display UI badges, but never trigger** (`compiler/statics.ts:118`, `runtime/layers.ts:178-185,326-328`): `'prowess'` is included in `KEYWORDS` in `compiler/statics.ts:118`, so cards like `"Creatures you control have prowess"` compile cleanly (`fullySupported: true`, zero warnings in deck builder or on battlefield entry). In addition, `runtime/layers.ts:178-185,326-328` includes `'prowess'`, `'evolve'`, and `'cascade'` in `KEYWORD_LABELS` and adds them to `activeKeywords` / `attributedKeywords` even when they come from `unsupported('keyword_not_implemented')` abilities, showing active keyword badges on permanents for abilities the runtime completely ignores.
- **Unsupported keywords on instants and sorceries are silently ignored with no log message or manual-resolution prompt** (`compiler/effects.ts:1187-1191,1218`, `engine.ts:3299,3308-3320,3930-4015`): `parseSpellText` skips every line that does not end with `.` or `!` (`isNonEffectLine`). When an instant or sorcery has an unsupported keyword line (`Cascade`, `Rebound`, `Cipher`, `Awaken`, `Undaunted`, `Improvise`, `Ascend`, `Assist`, `Jump-start`, `Spectacle`, `Demonstrate`, `Cleave`, `Casualty`, `Bargain`, `Freerunning`, `Gift`, `Harmonize`, `Web-slinging`, `Paradigm`, `Teamwork`, `Beam me up`) alongside parseable effect sentences, `compiledStackItemEffects` returns `unparsed: []`, `resolveTopOfStack` auto-resolves only the non-keyword effect steps, and `noteUnautomatedOnEnter` never runs because the spell never enters the battlefield.
- **`"Partner with [name]"` without a comma compiles as `fullySupported: true` and silently drops the ETB tutor trigger** (`compiler/adapter.ts:117,198-244`): Because `'partner'` is in `IMPLEMENTED_KEYWORDS` (`compiler/adapter.ts:117`) and `parseKeyword` accepts any non-period argument after `'partner'`, `"Partner with Blaring Captain"` (no comma in the partner's name) compiles to `{ kind: 'keyword', keyword: { name: 'partner', param: 'with Blaring Captain' } }` (`fullySupported: true`), silently ignoring the CR 702.124j ETB library-search trigger with no on-enter notice.
- **`hasGenericPartner` conflates `Partner—[text]` variants and any oracle text containing the word `"partner"` with generic Partner** (`scryfall.ts:431-437`): `hasGenericPartner` returns `true` whenever `/\bpartner\b/i.test(card.oracleText)` matches and the card isn't `Partner with`, `Friends forever`, or `Doctor's companion`. This allows pairing `Partner—Survivors`, `Partner—Character select`, and `Partner—Father & son` with generic `Partner` commanders or with each other (`CR 702.124f, 702.124i`), as well as any legendary creature whose rules text mentions the word `"partner"`.
- **Menace attackers are unconditionally ignored by `"blocks each combat if able"` (`CR 509.1c`) and by bot blockers** (`engine.ts:2021`, `ai.ts:243`): `engine.ts:2021` returns `false` (`!hasKeyword(atk, 'Menace', state)`) when checking whether a creature with `blocksEachCombat` can block an attacker, even when the defending player controls a second available blocker or has already assigned another creature to block that Menace attacker. Bots (`ai.ts:243`) also skip blocking Menace creatures altogether.
- **Infect combat damage bypasses counter replacement/multiplier effects, and noncombat Infect+Deathtouch skips `deathtouchDamageMarked`** (`engine.ts:6204-6205,6321-6322`, `runtime/effects.ts:1049-1081,1160-1167`): Combat Infect directly increments `counters['-1/-1']` instead of calling `addCounters` (`CR 702.90c`), skipping Doubling Season / Corpsejack Menace multipliers (`runtime/replace.ts:828`). Noncombat Infect damage (`runtime/effects.ts:1161-1167`) skips setting `target.deathtouchDamageMarked = true` when the source also has Deathtouch, and `sourceDamageInfo` (`runtime/effects.ts:1049-1081`) loses granted Infect if the source left the battlefield before damage resolves (`CR 702.90d`).
- **Overload approximations** (`engine.ts:530-542,4827-4845`, `runtime/effects.ts:302-313`): `isOverloadCastMode` (`engine.ts:541`) treats `xValue >= 1` on a non-`{X}` spell with Overload as overloaded when `castMode` is omitted; `interpretableNow` (`runtime/effects.ts:302-313`) bails out on player-targeted Overload spells; and legacy `bounce_target` (`engine.ts:4827-4845`) hardcodes *Cyclonic Rift*'s opponent-nonland filter.

---

## Legacy-only findings (verify after step F)
- **Overload cast node in `ruleTree.ts` and legacy `bounce_target` handler in `engine.ts`** (`ruleTree.ts:38,83,290-318,877,899,913`, `engine.ts:4827-4845`): `ruleTree.ts` builds a `cast.overload` action node by regex-matching `/overload\s+((?:\{[^}]+\})+)/i`, and `engine.ts:4827-4845` has a hardcoded *Cyclonic Rift* Overload branch inside `executeParsedEffect`'s `case 'bounce_target':`. The new compiler/runtime already handles Overload via `compiler/adapter.ts:116`, `runtime/costs.ts:80-95`, and `runtime/effects.ts:302-313,622-641,1246-1256`.
- **Legacy activated-ability parser strips `Boast —`, `Exhaust —`, and `Power-up —` before mana costs** (`oracle.ts:479`): `parseActivatedAbilities` runs `rawLine.replace(/^[A-Za-z' -]+\s+—\s+/, '')`, which strips `Boast —`, `Exhaust —`, and `Power-up —` even when the cost starts with `{` (where `compiler/normalize.ts:39`'s `ABILITY_WORD` regex does not match `{`). Once `oracle.ts` is removed in step F, mana-cost `Boast`/`Exhaust`/`Power-up` lines will no longer be claimed by `oracle.ts`, though word-cost lines (`"Exhaust — Sacrifice ...: ..."`) will still be stripped by `compiler/normalize.ts:39` unless `ABILITY_WORD` excludes keyword prefixes with rules meaning.
- **Legacy `oracle.ts` keyword skip list and token Menace parser** (`oracle.ts:1062,1507,1987`): `oracle.ts:1062` filters out lines starting with `encore` when parsing cast effects, and `oracle.ts:1507` parses `'Menace'` on token creation strings. Both are superseded by `compiler/adapter.ts` and `compiler/effects.ts`.
