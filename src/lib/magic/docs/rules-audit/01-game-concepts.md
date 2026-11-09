# Rules audit: 1. Game Concepts (rules.txt lines 183–1278)

Audited at engine-rewrite 917180b on 2026-11-09.

## Summary
- Total numbered subrules in range: 503
- Implemented: 210
- Partial: 79
- Missing: 124
- N/A: 90
- Top gaps:
  1. **Life-gain events and replacement effects never fire (`CR 119.9`, `CR 119.10`)**: `ir.ts:429` and `compiler/triggers.ts` compile `event: 'gainLife'`, but `runtime/events.ts` has no `GainLife` event and neither `runtime/effects.ts:751, 1233` nor `engine.ts:4602, 6297, 6338` emits one or applies `lifeGain` replacement effects.
  2. **Card-draw events and replacement effects are largely absent (`CR 121.2`, `CR 121.6`)**: `runtime/events.ts` has no `CardDrawn` event (`ir.ts` has no `'draw'` trigger event), `playersDrawnThisTurn` is never reset at turn boundaries, and draw replacement effects (Abundance, Dredge, Notion Thief) are not implemented.
  3. **Combat damage bypasses Wither, protection, prevention shields, shield counters, and counter multipliers (`CR 120.3d`, `CR 120.4`, `CR 122.1c`, `CR 122.6`)**: `executeCombatDamageStep` (`engine.ts:6007-6356`) omits `Wither`, `hasProtectionFrom`, `damagePreventionShield`, `shield` counters, `activeRuleModifiers(state, 'lifeTotalCantChange')`, and directly mutates `counters['-1/-1']` for Infect instead of calling `addCountersToPermanent`.
  4. **Auto-tap for mana silently skips `TappedForMana` events and triggered mana abilities (`CR 106.12`, `CR 106.12a`)**: `simulateOrExecuteAutoTap` (`engine.ts:820-832`) taps lands and adds mana directly without emitting `TappedForMana`, unlike manual `tap_mana` (`engine.ts:1265`).
  5. **Predefined tokens beyond Treasure, permanent spell copies, and non-battlefield activated abilities are unimplemented (`CR 111.10b–x`, `CR 111.13`, `CR 113.6b/j/m`)**: `compiler/effects.ts:454-475` and `oracle.ts:70-98` only define predefined rules for Treasure tokens; `resolveStackItemNow` (`engine.ts:4171`) skips battlefield entry when `item.isCopy` is true; and `activate_ability` (`engine.ts:1591`) only searches `actor.battlefield`.

## Rule-by-rule

### 100 General

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 100.1, 100.1a, 100.1b | implemented | `types.ts:148`, `engine.ts:294-305` | Supports 2-player and multiplayer (up to 4-player Commander pod) games. |
| 100.2, 100.2c, 100.5 | implemented | `scryfall.ts:491-588`, `types.ts:144` | `validateCommanderDeck` enforces exact 100-card Commander decks, singleton rule (except basic lands), and color identity (unless `deckValidation === 'rule0_relaxed'`). |
| 100.2a | partial | `scryfall.ts:491-588` | Only 100-card singleton Commander deck construction is validated; 60-card 4-of Constructed deck validation is not implemented. |
| 100.2b, 100.2d | N/A | — | Limited format deck minimums and supplementary decks (Planar, Scheme, Attraction, Contraption) are outside the Commander engine scope. |
| 100.3 | partial | `runtime/random.ts`, `types.ts:820` | Deterministic seeded RNG (`GameState.rngState`) is used for shuffles and random choices, but coin-flip and die-roll (`d6`/`d20`/planar die) effects are not implemented in `ir.ts`. |
| 100.4, 100.4a, 100.4b, 100.4c, 100.4d | N/A | — | Sideboards, best-of-three match sideboarding, and "outside the game" Wish effects are not applicable to single-game Commander pods. |
| 100.6, 100.6a, 100.6b, 100.7 | N/A | — | Tournament Rules, Wizards Event Reporter / Store & Event Locator references, and Un-set / acorn cards. |

### 101 The Magic Golden Rules

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 101.1 | implemented | `runtime/replace.ts`, `engine.ts:1161-1168` | Card rules text (`RuleModKind`, `ReplacementDef`, `RestrictionKind`) overrides base rules; `concede` action is always processed immediately (`CR 104.3a`). |
| 101.2 | implemented | `runtime/replace.ts:244-278, 375, 531`, `engine.ts:855, 884`, `runtime/effects.ts:749` | "Can't" effects override "can" effects across cast permissions/restrictions, win/lose conditions, combat restrictions, and life total changes. |
| 101.2a | implemented | `runtime/layers.ts:1277-1741`, `ir.ts:500-503` | Adding and removing abilities are resolved in Layer 6 by timestamp and `cantHaveOrGain` rules (`CR 113.10–113.11`), not as rule-modifying "can't" effects. |
| 101.3 | implemented | `runtime/effects.ts:776, 1005, 1378, 1467` | Impossible instructions are ignored while performing as much as possible (e.g., sacrificing/discarding with 0 candidates, milling more cards than in library, destroying indestructible permanents). |
| 101.4, 101.4b | partial | `runtime/effects.ts:580-591, 1371-1416, 1460-1504`, `runtime/triggers.ts:800`, `engine.ts:435-444` | `apnapPlayers()` orders resolving sacrifice/discard choices and trigger placement in APNAP turn order, pausing sequentially per human player; however, opening-hand mulligan prompts are queued in parallel for all human players (`engine.ts:435-444`). |
| 101.4a | partial | `runtime/effects.ts:1460-1504`, `engine.ts:8364-8400` | Multi-player discard choices from hidden hand zones are collected in `item.effectResume.answers` before moving cards simultaneously, but `effectResume.answers` is not redacted in `sanitizeGameStateForViewer`. |
| 101.4c, 101.4d | missing | `runtime/effects.ts` | Effects specifying a custom player choice order (`101.4c`) and restarting APNAP choice order when a nonactive player's choice causes an earlier player to make another choice (`101.4d`) are not implemented. |
| 101.4e | partial | `engine.ts:381` | Seat 0 (`activePlayerIndex = 0`) is designated as the starting active player at game creation, though pregame mulligan choices are not strictly sequential. |

### 102 Players

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 102.1, 102.2 | implemented | `types.ts:798-803`, `runtime/objectFilter.ts:214`, `runtime/effects.ts:610` | Active player is `state.players[state.activePlayerIndex]`; in free-for-all multiplayer, every other player (`p.playerId !== controllerId`) is an opponent. |
| 102.3, 102.4 | N/A | — | Multiplayer team variants (Two-Headed Giant, Emperor) are not supported; all games are free-for-all where a player's "team" is just that player. |

### 103 Starting the Game

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 103.1 | partial | `engine.ts:381, 6460-6470` | Turn order proceeds in seat order (`0..N-1`), but the starting player is hardcoded to seat index `0` (`activePlayerIndex: 0`) rather than randomly chosen with a play/draw decision. |
| 103.1a, 103.1b, 103.1c | N/A | — | Shared team turns, Archenemy, and Conspiracy Power Play are not applicable. |
| 103.2, 103.2c | implemented | `engine.ts:309-311` | Each player's commander(s) are placed face up into their `command` zone at the start of the game before shuffling libraries. |
| 103.2a, 103.2d, 103.2e | N/A | — | Sideboards/substitute cards, Unfinity sticker sheets, and Conspiracy Draft start-of-game actions. |
| 103.2b | missing | `engine.ts:294-404` | Revealing a companion from outside the game at game start is not implemented. |
| 103.3 | implemented | `engine.ts:323` | Each player's remaining deck is shuffled via seeded `shuffleWithState` to become their library. |
| 103.3a | N/A | — | Supplementary decks (Planar, Scheme, Attraction, Contraption). |
| 103.4, 103.4c | implemented | `types.ts:139, 157`, `engine.ts:332` | Starting life total defaults to 40 for Commander (`DEFAULT_LOBBY_RULES.startingLife = 40`) and is configurable via lobby rules. |
| 103.4a, 103.4b, 103.4d, 103.4e | N/A | — | Two-Headed Giant, Vanguard, Brawl, and Archenemy starting life rules. |
| 103.5, 103.5c | partial | `engine.ts:406-445, 2191-2310`, `runtime/zones.ts:461-481`, `types.ts:143, 161` | London mulligan with free first mulligan (`london_1free`) is implemented. Gaps: human mulligan prompts are created simultaneously rather than in APNAP turn order (`engine.ts:435`); bots mulligan at most once (`engine.ts:416`); `london_bottom` places cards in `instanceIds` array order (`engine.ts:2270-2285`); and `mulliganCount >= 7` does not auto-keep a 0-card hand. |
| 103.5a, 103.5d | N/A | — | Vanguard hand size modifiers and shared team turn mulligans. |
| 103.5b | missing | `engine.ts:2191-2310` | Cards with abilities that can be used "any time you could mulligan" (e.g., Serum Powder) are not supported. |
| 103.6, 103.6a, 103.6b | missing | `engine.ts:464-477`, `precons.ts:1533` | Opening-hand pregame actions ("If this card is in your opening hand, you may begin the game with it on the battlefield", e.g., `Leyline of Anticipation` in `precons.ts:1533`, and Chancellor reveal triggers) are not implemented; `checkIfAllKeptMulligan` goes directly to Turn 1. |
| 103.6c, 103.7 | N/A | — | Shared team turns and Planechase starting plane. |
| 103.8, 103.8a | partial | `engine.ts:1059-1082`, `types.ts:164` | `executeDrawTurnBasedAction` skips Turn 1 draw only if `!state.rules.firstTurnDraw`. Because `DEFAULT_LOBBY_RULES.firstTurnDraw` defaults to `true`, a 2-player game (`state.players.length === 2`) does not automatically skip the starting player's Turn 1 draw unless toggled in lobby rules. |
| 103.8b | N/A | — | Two-Headed Giant first-turn draw rule. |
| 103.8c | implemented | `engine.ts:1066`, `types.ts:164` | In multiplayer games (3–4 players), no player skips their first-turn draw step (`firstTurnDraw: true`). |

### 104 Ending the Game

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 104.1 | implemented | `engine.ts:865, 7006, 7017` | A game ends immediately (`state.status = 'finished'`) when a player wins or the game is a draw. |
| 104.2, 104.2a | partial | `engine.ts:7014-7032` | When all other players have lost (`remaining.length === 1`), that player wins. **Bug (`CR 104.2a`)**: `engine.ts:7016` checks `if (winner && !playerCannotWinGame(state, winner).blocked)`, violating CR 104.2a ("This happens immediately and overrides all effects that would preclude that player from winning the game"). |
| 104.2b | implemented | `engine.ts:853-880`, `runtime/effects.ts:958-965` | `winTheGame` and `EffectStep` verb `'win'` end the game in that player's favor unless blocked by `playerCannotWinGame`. |
| 104.2c, 104.2d | N/A | — | Multiplayer team and Emperor win conditions. |
| 104.3, 104.3a | implemented | `engine.ts:1161-1168` | A player can `concede` at any time (`applyGameActionInner`); they immediately leave the game, lose, and trigger `cleanupEliminatedPlayer` + SBAs. |
| 104.3b, 104.3c, 104.3d, 104.3j | implemented | `engine.ts:923, 6933-6998` | Checked simultaneously in `checkStateBasedActions`: `p.life <= 0` (`104.3b`), `p.attemptedEmptyLibraryDraw` set by `drawCards` (`104.3c`), `p.poison >= state.rules.poisonLethal` (`104.3d`), and `commanderDamageTaken[cmdId] >= state.rules.commanderDamageLethal` (`104.3j`), respecting `playerCannotLoseGame`. |
| 104.3e | implemented | `engine.ts:882-900`, `runtime/effects.ts:958-965` | `loseTheGame` and `EffectStep` verb `'lose'` cause a player to lose unless prevented by `playerCannotLoseGame`. |
| 104.3f | missing | `engine.ts:853-900, 6933-7032` | Simultaneous win and lose ("If a player would both win and lose the game simultaneously, that player loses the game") is not tracked as a simultaneous event; `winTheGame` and `loseTheGame` execute sequentially. |
| 104.3g, 104.3h, 104.3i, 104.3k | N/A | — | Multiplayer teams, Limited Range of Influence, Emperor, and tournament judge penalties. |
| 104.4, 104.4a | implemented | `engine.ts:7005-7013` | If all remaining players lose simultaneously in an SBA pass (`remaining.length === 0`), `state.status = 'finished'` with `winnerPlayerId = null` (a draw). |
| 104.4b | partial | `engine.ts:3597-3620, 6541` | Instead of ending the game in a draw when mandatory actions/triggers repeat in an unbreakable loop, `putTriggerOnStack` caps at `MAX_STACK_FOR_TRIGGERS = 300` and `MAX_TRIGGERS_PER_TURN = 200` and silently drops further triggers while continuing the game, and `checkStateBasedActions` caps at 25 iterations. |
| 104.4c | missing | `ir.ts`, `runtime/effects.ts` | No effect verb exists for card effects that explicitly state the game is a draw (e.g., Divine Intervention). |
| 104.4d, 104.4e, 104.4f, 104.4g, 104.4h, 104.4i | N/A | — | Multiplayer teams, Limited Range of Influence, Emperor, and tournament intentional draws. |
| 104.5 | implemented | `engine.ts:7035-7116` | `cleanupEliminatedPlayer` removes an eliminated player's objects, stack items, and combat assignments and advances priority/turn if needed in multiplayer. |
| 104.6 | missing | `ir.ts`, `engine.ts` | Effects that restart the game (e.g., Karn Liberated) are not implemented. |

### 105 Colors

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 105.1, 105.2, 105.2a, 105.2b, 105.2c | implemented | `types.ts:1, 69`, `runtime/layers.ts:977, 1801`, `runtime/objectFilter.ts:221-224`, `engine.ts:7226-7234` | Five colors (`W`, `U`, `B`, `R`, `G`); monocolored, multicolored, and colorless (`colors.length === 0`, including face-down permanents) are evaluated in filters and protection checks. |
| 105.3 | implemented | `ir.ts:498-499`, `runtime/layers.ts:1143-1148, 1247-1275` | Layer 5 `setColors` overwrites previous colors (`[]` makes an object colorless) and `addColors` ("in addition to its other colors") adds colors without removing existing ones. |
| 105.4 | partial | `runtime/effects.ts:897-902, 1674, 1771` | `FIVE_COLORS` excludes colorless (`'C'`), but human players are never prompted with a `chooseColor` prompt—mana color choices default automatically to `preferredColor` or `allowed[0]`. |
| 105.5 | missing | `compiler/`, `runtime/` | Color pairs (10 two-color combinations) are not represented in the compiler or runtime. |

### 106 Mana

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 106.1, 106.1a, 106.1b, 106.2 | implemented | `types.ts:1-3` | `ManaColor` represents the five colors (`W`, `U`, `B`, `R`, `G`) and colorless (`C`). |
| 106.3, 106.4, 106.4a, 106.4b | implemented | `engine.ts:938-942, 1263, 2171-2178`, `runtime/effects.ts:887-905`, `types.ts:759` | Mana is produced by mana abilities and resolving effects into `player.manaPool` (publicly visible in `PlayerGameState`) and empties at the end of each step and phase. |
| 106.5 | partial | `runtime/effects.ts:897, 1772-1775` | `addMana` produces no mana if `manaChoiceColors` returns `[]` (e.g., `opponentLandColors` with no colored-mana lands). **Bug**: `manaChoiceColors` for `commanderIdentity` (`runtime/effects.ts:1774`) falls back to `FIVE_COLORS` when `cols.length === 0`, so Command Tower with a colorless commander produces any color instead of no mana (`CR 106.5` / `CR 903.9`). |
| 106.6, 106.6a | missing | `types.ts:3`, `runtime/costs.ts` | `ManaPool` is a flat `Record<ManaColor, number>`; mana spending restrictions (e.g., Powerstone, Cavern of Souls) and rider benefits/triggers on mana spent are not tracked. |
| 106.7 | partial | `runtime/effects.ts:1704-1763` | Implemented for `opponentLandColors` (Exotic Orchard, Fellwar Stone), checking basic land subtypes, Layer 6 mana abilities, and mutual Exotic Orchards, but not generalized to arbitrary permanents (Reflecting Pool) or mana-production replacement effects. |
| 106.8, 106.9, 106.10, 106.11 | missing | `compiler/effects.ts`, `runtime/effects.ts:887-905` | Effects that add hybrid (`106.8`), Phyrexian (`106.9`), generic (`106.10`), or snow (`106.11`) mana symbols to a mana pool are not supported. |
| 106.12, 106.12a | partial | `engine.ts:820-832, 1265`, `runtime/events.ts:147-152`, `runtime/triggers.ts` | Explicit `tap_mana` emits `TappedForMana` and resolves triggered mana abilities inline. **Bug**: `simulateOrExecuteAutoTap` (`engine.ts:820-832`) taps lands and adds mana during spell/ability payment without emitting `TappedForMana`, silently skipping "Whenever you tap a land for mana" triggers. |
| 106.12b, 106.13 | missing | `runtime/replace.ts`, `runtime/effects.ts` | Replacement effects on tapping a permanent for mana (`106.12b`, e.g., Nyxbloom Ancient) and effects forcing a player to activate mana abilities (`106.13`) are not implemented. |

### 107 Numbers and Symbols

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 107.1, 107.1a | partial | `ir.ts:256-268`, `runtime/objectFilter.ts:261-291` | Game values use integer arithmetic, but fractional division with "rounded up" / "rounded down" is not represented in `Amount`. |
| 107.1b | implemented | `runtime/objectFilter.ts:80-148`, `runtime/layers.ts:1763`, `runtime/effects.ts:741, 829, 888, 1241, 1318`, `runtime/costs.ts:337` | Creature power and toughness calculations preserve negative values (`effectivePower` is unclamped; `unclampedToughness` is preserved for SBAs), while life/damage/mana/counter/token amounts clamp negative values to 0. |
| 107.1c | implemented | `compiler/effects.ts:315-322`, `runtime/effects.ts:1607` | "Up to" target and search counts set `min: 0`, allowing a choice of 0. |
| 107.2 | implemented | `runtime/objectFilter.ts:261-291`, `runtime/effects.ts:452-489` | Unresolved or indeterminable `Amount` expressions evaluate to `0`. |
| 107.3, 107.3a | partial | `engine.ts:1458, 1641, 1670`, `oracle.ts:157-160, 195`, `runtime/effects.ts:458` | `action.xValue` is chosen when casting an `{X}` spell and stored on `StackItem.xValue`; however, `activate_ability` hardcodes `xValue: 0` (`engine.ts:1641, 1670`), so `{X}` or `[-X]` in activated ability costs cannot be chosen. |
| 107.3b | partial | `runtime/costs.ts:123`, `engine.ts:3179` | `effectiveSpellManaCost` forces `effectiveX = 0` for Overload and Suspend free-casts set `xValue: 0`, though general "without paying its mana cost" effects are not generalized. |
| 107.3c, 107.3g, 107.3m | implemented | `compiler/effects.ts:436-449`, `oracle.ts:143`, `engine.ts:4201, 4245-4263` | `"where X is ..."` compiles into `Amount` (`107.3c`); `{X}` in a mana cost is 0 off the stack (`107.3g`); `perm.enteredWithX = item.xValue` feeds ETB replacement/triggered abilities (`107.3m`). |
| 107.3d, 107.3e, 107.3f, 107.3h, 107.3i, 107.3j, 107.3k, 107.3n, 107.3p | missing | `compiler/`, `runtime/` | Special-action `{X}`, cross-object X references, text-only X choices without `{X}` in cost, separate ability X values, delayed-trigger X inheritance, and `Y` variables are not implemented. |
| 107.4, 107.4a, 107.4b, 107.4c, 107.4d | implemented | `oracle.ts:141-244`, `compiler/costs.ts:80-115` | Colored (`{W}`, `{U}`, `{B}`, `{R}`, `{G}`), numerical/variable generic (`{0}`–`{N}`, `{X}`), colorless (`{C}`), and rules-text mana symbols are parsed and enforced. |
| 107.4e, 107.4f | partial | `oracle.ts:171-190, 209-244`, `engine.ts:780-807` | Two-color hybrid (`{W/U}`), monocolored hybrid (`{2/W}`), and single-color Phyrexian (`{W/P}`) mana symbols are supported; however, hybrid Phyrexian (`{W/U/P}`) ignores the Phyrexian `P` branch (`oracle.ts:176-186`) and colorless hybrid (`{C/W}`) is not parsed. |
| 107.4g, 107.4h | missing | `oracle.ts:190` | `{H}` rules-text symbol and snow mana `{S}` (tracking snow sources) are not implemented; `parseManaCost` treats `{S}` as 1 generic mana (`oracle.ts:190`). |
| 107.5, 107.6 | implemented | `compiler/costs.ts:224-225`, `runtime/costs.ts:386-397` | Tap (`{T}`) and untap (`{Q}`) cost symbols enforce tapped/untapped state and summoning sickness (`CR 302.6`) when the permanent is a creature without haste. |
| 107.7 | partial | `runtime/costs.ts:61, 407-409, 752-755`, `engine.ts:8130-8147` | Loyalty symbols (`+N`, `-N`, `0`) are parsed and enforced as loyalty costs; variable `[-X]` loyalty costs are not supported. |
| 107.8, 107.8a, 107.8b | missing | `compiler/` | Leveler card symbols (`{LEVEL N1-N2}`) are not implemented. |
| 107.9, 107.10, 107.11, 107.12 | N/A | — | Visual-only Odyssey tombstone / Future Sight type icons, and Planechase `{PW}` / `{CHAOS}` symbols. |
| 107.13 | implemented | `scryfall.ts`, `types.ts:69` | Color indicators are reflected in `ScryfallCard.colors`. |
| 107.14 | partial | `types.ts:758`, `engine.ts:5825, 5851`, `compiler/costs.ts:226` | `PlayerGameState.energyCounters` is tracked and proliferated, but `{E}` energy symbols in costs and effects are rejected by the compiler (`compiler/costs.ts:226`). |
| 107.15, 107.15a, 107.15b | partial | `types.ts:195`, `compiler/triggers.ts` | `'lore'` counter type exists on permanents, but Saga chapter symbols (`{rN}`) and chapter abilities are not compiled. |
| 107.16, 107.16a | missing | `compiler/` | Class level bars are not implemented. |
| 107.17, 107.17a | N/A | — | Unfinity ticket symbol `{TK}`. |
| 107.18 | missing | `compiler/costs.ts:226` | Pawprint modal symbol `{P}` (Bloomburrow Season cycle) is rejected by the compiler. |

### 108 Cards

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 108.1 | implemented | `types.ts:68`, `scryfall.ts` | Card compilation and evaluation use Scryfall Oracle text (`ScryfallCard.oracleText`). |
| 108.2, 108.2b | implemented | `types.ts:361`, `runtime/objectFilter.ts:219`, `runtime/zones.ts:291` | Tokens have `isToken: true`, are excluded when matching "card" filters in non-battlefield zones, and cease to exist outside the battlefield. |
| 108.2a, 108.3a, 108.3b, 108.5, 108.6 | N/A | — | Nontraditional Magic cards (planar, scheme, vanguard, phenomenon, conspiracy), outside-the-game Wish ownership, and deck-sharing definitions. |
| 108.3 | implemented | `types.ts:349`, `engine.ts:310, 319` | `CardInstance.ownerId` records the player in whose deck or command zone the card started the game. |
| 108.4, 108.4a | implemented | `runtime/objectFilter.ts:212`, `runtime/effects.ts:677` | Only objects on the battlefield or stack have a controller; in other zones, `controllerId` checks fall back to `obj.ownerId`. |

### 109 Objects

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 109.1 | partial | `types.ts:346, 407` | Cards, tokens, copies, spells, permanents, and abilities on the stack are represented (`CardInstance`, `StackItem`), but emblems are missing (`CR 114`). |
| 109.2, 109.2a, 109.2b | implemented | `compiler/effects.ts:264-290`, `runtime/objectFilter.ts:247` | Type/subtype references without "card" or "spell" default to `zone: 'battlefield'` (permanents); `"card"` references match the specified zone; `"spell"` references match `zone: 'stack'`. |
| 109.2c | partial | `engine.ts:7195`, `runtime/effects.ts:1042-1119` | Protection checks evaluate source characteristics (`sourceCard`), but effects instructing a player to "choose a source" in any zone are not implemented. |
| 109.2d | N/A | — | Archenemy scheme references. |
| 109.3 | partial | `ir.ts:36-48`, `types.ts:346-384` | Characteristics (`name`, `manaCost`, `colors`, `types`, `subtypes`, `supertypes`, `rulesText`, `abilities`, `power`, `toughness`, `loyalty`) are separated from status/control; `defense`, `hand modifier`, and `life modifier` are not represented. |
| 109.4, 109.4a, 109.4b | implemented | `types.ts:350, 412`, `runtime/triggers.ts` | Permanents, spells, and abilities on the stack have controllers (`controllerId`). |
| 109.4c | missing | — | Emblem controller rules (`CR 114` not implemented). |
| 109.4d, 109.4e, 109.4f, 109.4g | N/A | — | Planar, vanguard, scheme, and conspiracy controllers. |
| 109.5 | implemented | `runtime/objectFilter.ts:18`, `runtime/effects.ts:115` | `"you"` and `"your"` resolve to the object's current controller, would-be controller, or owner (when in a non-battlefield, non-stack zone). |

### 110 Permanents

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 110.1, 110.2, 110.2a | implemented | `types.ts:771`, `runtime/zones.ts:269`, `runtime/effects.ts:1562-1571`, `engine.ts:4189-4240` | Permanents exist only in `player.battlefield` under the control of the player who put them there (`controllerId`). |
| 110.2b | missing | `engine.ts:4189-4240` | Gaining control of a permanent spell on the stack (e.g., Commandeer, Aethersnatch) is not implemented. |
| 110.3 | implemented | `runtime/layers.ts:962-1825` | A permanent's characteristics are determined from its printed/copiable values and active continuous effects across Layers 1–7. |
| 110.4, 110.4a, 110.4b, 110.4c | implemented | `runtime/zones.ts:150-168`, `engine.ts:4173-4178, 7452-7459`, `compiler/costs.ts:37-46` | Recognizes all six permanent types (`Artifact`, `Battle`, `Creature`, `Enchantment`, `Land`, `Planeswalker`); prevents Instant/Sorcery cards from entering the battlefield (`110.4a`); and keeps permanents that lose all types on the battlefield (`110.4c`). |
| 110.5, 110.5b | partial | `types.ts:352, 371, 376` | Tracks `tapped/untapped`, `face up/face down` (`isFaceDown`), and `phased in/phased out` (`phasedOut`) status separately from characteristics; `flipped/unflipped` status (Kamigawa flip cards) is not tracked. |
| 110.5a, 110.5c, 110.5d | implemented | `engine.ts:221-260`, `runtime/zones.ts:247-268` | Status is initialized to untapped, face up, and phased in by default, persists only on the battlefield, and is reset by `leaveBattlefieldReset` when leaving the battlefield. |

### 111 Tokens

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 111.1, 111.2, 111.3, 111.6 | implemented | `engine.ts:5767-5792`, `oracle.ts:70-98`, `runtime/effects.ts:828-835` | `createTokenOnBoard` creates a `CardInstance` with `isToken: true` on `controller.battlefield`, sets `ownerId = controller.playerId` (`111.2`), and assigns characteristics defined by the effect (`111.3`). |
| 111.4 | partial | `oracle.ts:70-98`, `compiler/effects.ts:459` | Generated creature tokens name themselves `"<Subtypes> Token"`, but `compiler/effects.ts:459` names Treasure tokens `'Treasure'` instead of `'Treasure Token'`. |
| 111.5 | partial | `runtime/zones.ts:150-168`, `engine.ts:5710-5765` | Instant/sorcery cards cannot become tokens on the battlefield, though static effects forbidding a token with specific characteristics from entering the battlefield are not checked in `createTokenOnBoard`. |
| 111.7, 111.8 | implemented | `runtime/zones.ts:290-307`, `engine.ts:6841-6857` | Tokens that leave the battlefield emit `ZoneChange` with `ceasedToExist: true` (`ceaseToExist: 'tokens'`) so dies/LTB triggers fire, are never added to the destination zone array, and cannot change zones again (`111.8`). |
| 111.9 | missing | `compiler/effects.ts:454-475` | Named token creation phrases ("create [Name], a legendary ... token") are not parsed by `tokenPhrase`. |
| 111.10, 111.10a | implemented | `compiler/effects.ts:456-460`, `oracle.ts:74-88` | Predefined Treasure tokens (`111.10a`: colorless Treasure artifact token with `"{T}, Sacrifice this token: Add one mana of any color"`) are compiled and created. |
| 111.10b, 111.10c, 111.10d, 111.10e, 111.10f, 111.10g, 111.10h, 111.10i, 111.10j, 111.10k, 111.10m, 111.10n, 111.10p, 111.10q, 111.10r, 111.10s, 111.10t, 111.10u, 111.10v, 111.10w, 111.10x | missing | `compiler/effects.ts:454-475`, `oracle.ts:70-98` | Predefined Food, Gold, Walker, Shard, Clue, Blood, Powerstone, Incubator, Role (Monster, Cursed, Royal, Sorcerer, Virtuous, Wicked, Young Hero), Map, Junk, Lander, Mutagen, Vibranium, and Heartwood tokens are not defined in `tokenPhrase` or `buildTokenScryfallCard`. |
| 111.11 | missing | `compiler/effects.ts`, `runtime/effects.ts` | Creating a token by card name (e.g., Disa the Restless creating a Tarmogoyf token) is not implemented. |
| 111.12 | implemented | `runtime/effects.ts:836-841` | `copyPermanent` filters `this.objects(step.subject).filter((o) => o.zone === 'battlefield')`; if the source permanent left the battlefield before resolution, no token is created. |
| 111.13 | missing | `engine.ts:4171` | In `resolveStackItemNow`, permanent spell resolution checks `if (item.kind === 'spell' && !item.isCopy)`—a copy of a permanent spell on the stack is discarded on resolution instead of entering the battlefield as a token! |

### 112 Spells

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 112.1, 112.1a, 112.2 | implemented | `engine.ts:1505-1548`, `types.ts:407-429` | Casting a card moves it to `'stack'` and creates a `StackItem` (`kind: 'spell'`, `ownerId`, `controllerId`, `isCopy`); it remains a spell until it resolves, is countered, or leaves the stack. |
| 112.1b, 112.2a | missing | `runtime/effects.ts` | Effects that copy a card in another zone and cast the copy (e.g., Isochron Scepter, Mizzix's Mastery) are not implemented. |
| 112.3 | partial | `types.ts:409`, `runtime/costs.ts:114-220` | A spell's characteristics are read from `item.card` and cost modifiers apply on the stack, but continuous effects changing a spell's color/types on the stack (e.g., Painter's Servant) are not evaluated. |
| 112.4 | missing | `engine.ts:4189` | Resolving a permanent spell calls `createCardInstance(item.card, ...)`, so any characteristic modifications made to the spell on the stack do not carry over to the permanent. |

### 113 Abilities

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 113.1, 113.1a, 113.1b, 113.1c, 113.2, 113.2a, 113.2b, 113.2d | implemented | `ir.ts:56-63, 521-536`, `runtime/effects.ts:843-886`, `types.ts:407` | Supports object abilities (rules text, keywords, continuous/temporary grants), player-granted rule modifiers (`grantPlayer`), and activated/triggered abilities on the stack (`StackItem`). |
| 113.2c | missing | — | Emblem abilities (`CR 114` not implemented). |
| 113.3, 113.3a, 113.3b, 113.3c, 113.3d | implemented | `ir.ts:56-63` | Distinguishes `spell`, `activated`, `triggered`, and `static` (plus `replacement` and `keyword`) abilities in compiled IR. |
| 113.4 | implemented | `engine.ts:1240-1276, 1601-1608, 3488-3499`, `runtime/triggers.ts` | Activated mana abilities (`ab.isManaAbility`) and triggered mana abilities (`executeInline`) resolve immediately without using the stack. |
| 113.5 | implemented | `engine.ts:8130-8147`, `runtime/costs.ts:752-755` | Loyalty abilities can only be activated during a main phase by the active player when the stack is empty and only once per permanent per turn (`loyaltyActivatedThisTurn`). |
| 113.6, 113.6a | partial | `runtime/objectFilter.ts:100-115, 190-206`, `runtime/layers.ts:1326-1342` | Layer 7a `*/*` P/T CDAs and Changeling (`702.73a`) are evaluated in all zones, but color/type CDAs outside the battlefield (other than Changeling) are not. |
| 113.6b, 113.6j, 113.6m | partial | `compiler/costs.ts:455`, `compiler/triggers.ts`, `compiler/statics.ts`, `ir.ts:464`, `engine.ts:1591` | Static and triggered abilities with explicit `activeZones` (Eminence in `command`) or `fromZone: 'graveyard'` work; however, `activate_ability` (`engine.ts:1591`) only searches `actor.battlefield`, so activated abilities on cards in hand, graveyard, or command zone (except Suspend special action and legacy `return_self_from_graveyard`) cannot be activated. |
| 113.6c, 113.6i, 113.6n, 113.6p | missing | `compiler/`, `runtime/` | Abilities stating they don't function in a zone (`113.6c`), "can't have counters put on it" while entering (`113.6i`), deck-construction abilities like Relentless Rats (`113.6n`), and emblem abilities (`113.6p`) are not implemented. |
| 113.6d, 113.6e, 113.6f, 113.6g, 113.6h, 113.6k | implemented | `runtime/costs.ts:168-179`, `engine.ts:4244, 7919-7928, 7976-8009`, `runtime/replace.ts:606, 759-825`, `runtime/triggers.ts` | Self cost reductions, cast timing/permissions/restrictions, `"can't be countered"`, self ETB replacements (`applySelfEtbReplacements`), and graveyard/LTB triggers function in their respective zones. |
| 113.7, 113.7a, 113.8 | implemented | `types.ts:407-446`, `engine.ts:1645-1664, 3378-3413`, `runtime/effects.ts:512-538` | Activated and triggered abilities on the stack exist independently of their source, retain their controller, and use captured LKI (`sourceLkiPower`, `sourceLkiToughness`, `eventLki`) if the source leaves the battlefield before resolution. |
| 113.9 | implemented | `engine.ts:7323-7328` | `validateTargetLegality` distinguishes spells from activated/triggered abilities on the stack (`Target on the Stack is an ability, not a spell`). |
| 113.10, 113.10a, 113.10b, 113.10c, 113.11, 113.12 | implemented | `ir.ts:484-485, 500-503, 538-546`, `runtime/layers.ts:554-617, 1277-1741` | Layer 6 evaluates `addKeywords`, `grantAbility`, `removeAllAbilities`, and `removeKeywords` in timestamp order (`113.10c`), supports `cantHaveOrGain` (`113.11`), and models qualities like `"can't be blocked"` as `RestrictionKind` rather than granted abilities (`113.12`). |

### 114 Emblems

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 114.1, 114.2, 114.3, 114.4, 114.5 | missing | `types.ts`, `ir.ts`, `compiler/`, `runtime/` | Emblems are not implemented anywhere in the IR, compiler, or runtime. |

### 115 Targets

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 115.1, 115.1a, 115.1b, 115.1c, 115.1d, 115.1e | implemented | `engine.ts:1466-1480, 1619-1633, 3624-3672`, `compiler/effects.ts:292-360` | Targets are chosen and validated when casting spells (including Aura `"Enchant"` targets), activating abilities (including `"Equip"`), and putting triggered abilities on the stack. |
| 115.2 | implemented | `compiler/effects.ts:264`, `engine.ts:7288` | Targets default to permanents on the `'battlefield'` unless another zone, player, or spell is specified. |
| 115.3 | partial | `engine.ts:7662-7668`, `runtime/effects.ts:251-252` | Duplicate target IDs are rejected within a single target list (`validateChosenTargets`), and `fight` uses two separate `target` specs; however, `validateChosenTargets` rejects choosing the same object across separate target clauses even when CR 115.3 would allow separate `"target"` words to target the same object. |
| 115.4 | partial | `compiler/effects.ts:305-312`, `engine.ts:7490-7609` | In the IR compiler (`compiler/effects.ts:305-312`), `"any target"` restricts permanent targets to `['Creature', 'Planeswalker', 'Battle']`. **Bug in legacy validation**: `validateTargetLegality` for `targetKind === 'any'` (`engine.ts:7527`) checks `findPermanentOnBoard` without verifying that the permanent is a Creature, Planeswalker, or Battle, allowing noncreature Artifacts/Enchantments/Lands to be targeted when validated by `validateChosenTargets`. |
| 115.5 | implemented | `engine.ts:7330-7337` | `validateTargetLegality` explicitly rejects a spell targeting itself on the stack. |
| 115.6 | implemented | `compiler/effects.ts:315-322`, `oracle.ts:660` | `"up to N target ..."` compiles with `min: 0, max: N`. |
| 115.7, 115.7a, 115.7b, 115.7c, 115.7d, 115.7e, 115.7f, 115.8 | missing | `ir.ts`, `runtime/effects.ts` | Changing targets or choosing new targets for a spell/ability on the stack (e.g., Deflecting Swat, Redirect) is not implemented. |
| 115.9, 115.9b | partial | `runtime/events.ts:115-124`, `engine.ts:1570-1582, 1681-1693` | `BecameTarget` events fire when a spell or ability is put on the stack with targets (triggering Ward and `becomesTarget` abilities). |
| 115.9a, 115.9c | missing | `compiler/`, `runtime/` | Effects that count a spell/ability's number of targets (`115.9a`) or check whether a spell/ability `"targets only [something]"` (`115.9c`, e.g., Zada, Hedron Grinder) are not implemented. |
| 115.10, 115.10a, 115.10b | implemented | `compiler/effects.ts`, `runtime/effects.ts` | Spells and abilities that do not use the word `"target"` (or `"Enchant"`/`"Equip"`) resolve via `Subject` (`all`, `you`, `eachOpponent`, `chosen`) without target legality or hexproof/shroud/protection targeting checks. |

### 116 Special Actions

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 116.1, 116.3 | implemented | `engine.ts:1278-1381` | Special actions (`play_land`, `suspend_card`) require priority, do not use the stack, reset `passedPriorityPlayerIds = []`, and return priority to the acting player. |
| 116.2, 116.2a | implemented | `engine.ts:1278-1335, 7844-7899` | Playing a land requires priority, active player, main phase, empty stack, and `landsPlayedThisTurn < effectiveMaxLands` (accounting for extra-land-play static effects). |
| 116.2b, 116.2c, 116.2d, 116.2e, 116.2g, 116.2h, 116.2k, 116.2m | missing | `engine.ts`, `types.ts` | Special actions to turn a face-down creature face up (`116.2b`), end a continuous effect / stop a delayed trigger (`116.2c`), ignore a static ability (`116.2d`), Circling Vultures (`116.2e`), pay `{3}` for Companion (`116.2g`), Foretell (`116.2h`), Plot (`116.2k`), and unlock a Room door (`116.2m`) are not implemented. |
| 116.2f | implemented | `engine.ts:1337-1381` | `suspend_card` exiles a card with Suspend from hand with time counters when the player has priority and could begin to cast it. |
| 116.2i, 116.2j | N/A | — | Planechase planar die roll and Conspiracy Draft Hidden Agenda / Double Agenda. |

### 117 Timing and Priority

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 117.1, 117.1a, 117.1b, 117.1c, 117.1d | implemented | `engine.ts:623-624, 1240-1276, 7873-7886, 7933-7974, 8097-8105` | Priority is required to cast spells, activate abilities, or take special actions; mana abilities can also be activated during spell/ability cost payment. |
| 117.2, 117.2a, 117.2b, 117.2c, 117.2d, 117.2e | implemented | `runtime/triggers.ts`, `runtime/layers.ts`, `engine.ts:3248-3278, 3828, 6538` | Triggered abilities wait for `flushTriggers`; static abilities apply continuously; turn-based actions run at step start and mana pools empty at step/phase ends; SBAs run before priority; no player has priority while a spell/ability is resolving. |
| 117.3, 117.3a, 117.3b, 117.3c, 117.3d, 117.4, 117.7 | implemented | `engine.ts:1322, 1365, 1549, 1679, 2127-2149, 3870, 3894, 4291` | Active player receives priority at step/phase start (except untap and normally cleanup) and after stack resolution; a player retains priority after acting (`passedPriorityPlayerIds = []`); passing priority advances in turn order and resolves top of stack or ends step/phase when all alive players pass in succession. |
| 117.5 | partial | `engine.ts:2144, 6544-7001` | `checkStateBasedActions` runs a fixpoint loop until no SBAs occur and then calls `flushTriggers(state)`; however, if flushing triggers (e.g., declining a required target) creates a new SBA condition, it does not loop back around `checkStateBasedActions`, and `pass_priority` calls `checkStateBasedActions` when passing to the next player (`engine.ts:2144`). |
| 117.6 | N/A | — | Shared team turns. |

### 118 Costs

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 118.1, 118.2, 118.3, 118.3a, 118.3b, 118.3c | implemented | `runtime/costs.ts:365-808`, `engine.ts:689-845` | Two-phase `planCosts` + `payPlannedCosts` verifies that every cost component can be paid in full before mutating mana pools, life totals, permanents, or zones. |
| 118.4, 118.5, 118.5a | implemented | `oracle.ts:157`, `compiler/costs.ts:88`, `runtime/costs.ts:62, 218` | Supports `{X}` in costs and treats `{0}` / `"0"` as an explicit zero cost requiring player acknowledgment to cast/activate. |
| 118.6, 118.6a | implemented | `engine.ts:3179, 7920, 8011-8016` | Unpayable mana costs (`manaCost === ''`, e.g., Ancestral Vision, Living End) cannot be cast normally from hand (`engine.ts:8011-8016`), but can be cast via an alternative permission such as Suspend (`castViaSuspend`). |
| 118.7, 118.7a | implemented | `runtime/costs.ts:114-220`, `oracle.ts:196` | Generic cost reductions reduce only the generic mana component (`Math.max(0, generic - genericReduction)`), leaving `{0}` if reduced to nothing. |
| 118.7b, 118.7c, 118.7d, 118.7e, 118.7f, 118.7g | missing | `ir.ts:505-513`, `runtime/costs.ts:114-220` | `CostDelta` only models generic mana (`generic: number`) or `setZero`; reductions to colored, colorless, hybrid, Phyrexian, or snow mana symbols are not implemented. |
| 118.8, 118.8a, 118.8b, 118.8d | implemented | `compiler/costs.ts:390-404`, `runtime/costs.ts:70-78, 530-610` | Mandatory, choice, and optional (`{ k: 'optional' }` / Kicker-style) additional costs are added to total cost without changing `card.manaCost` (`cmc`). |
| 118.8c | missing | `engine.ts` | "Cast if able" effects interacting with hidden-zone additional costs are not implemented. |
| 118.9, 118.9a, 118.9b, 118.9c, 118.9d | partial | `runtime/costs.ts:89-93, 114-220`, `engine.ts:3179` | Overload (`ALTERNATIVE_COST_KEYWORDS.overload`), Suspend free-cast, and `setZero` static cost modifiers replace the mana cost while still applying commander tax and cost increases/reductions (`118.9d`) and preserving `card.manaCost` (`118.9c`); general card-specific alternative costs ("rather than pay this spell's mana cost") are not compiled. |
| 118.10 | implemented | `runtime/costs.ts:530, 591, 602-610` | Each cost payment tracks `used = new Set<string>()` and `canPayManaAfterTaps` so the same permanent/card cannot pay two separate cost steps or be tapped for both `{T}` and mana. |
| 118.11 | partial | `runtime/costs.ts:690, 716` | Replacement effects modifying graveyard destination (e.g., Rest in Peace) apply during sacrifice/discard cost payment while still counting the cost as paid; draw-as-cost is not in `CostDef`. |
| 118.12, 118.12a, 118.12b | partial | `runtime/effects.ts:267-280`, `engine.ts:4040-4165` | Ward (`"counter unless that player pays [cost]"`) and triggered abilities with a leading `"you may [do X]"` (`optionalPrefix`) are supported, but general resolving reflexive costs (`"[Do X]. If you do, [Y]"`) and non-Ward `"unless [player] pays"` effects are not compiled in `compiler/effects.ts`. |
| 118.13, 118.13a, 118.13b, 118.13c | partial | `oracle.ts:209-244`, `engine.ts:780-807` | Hybrid and Phyrexian mana payments are resolved automatically (`resolveFlexibleManaRequirement` and `simulateOrExecuteAutoTap` spend matching mana first and only pay 2 life for Phyrexian mana when mana is unavailable) rather than prompting the player how to pay (`118.13a`). |
| 118.14 | implemented | `ir.ts:533`, `types.ts:265`, `engine.ts:551-568` | `spendManaAsAnyColor` converts colored mana requirements into generic cost requirements so mana of any type/color can pay them. |

### 119 Life

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 119.1, 119.1c | implemented | `types.ts:139, 157`, `engine.ts:332` | Each player starts at `state.rules.startingLife` (40 in Commander). |
| 119.1a, 119.1b, 119.1d, 119.1e, 119.4a | N/A | — | Two-Headed Giant, Vanguard, Brawl, and Archenemy life rules. |
| 119.2, 119.3 | implemented | `runtime/effects.ts:739-765, 1213`, `engine.ts:6139, 6263` | Damage dealt to a player by a source without infect causes that much life loss; `gainLife` and `loseLife` adjust `player.life`. |
| 119.4, 119.4b | implemented | `runtime/costs.ts:398-406, 747` | Paying 0 life is always legal (`if (amount === 0) return null; // CR 119.4b`), and paying `> 0` life requires `player.life >= amount` and subtracts from `player.life` (causing life loss). |
| 119.5 | missing | `ir.ts`, `runtime/effects.ts` | Setting a player's life total to a specific number (and gaining/losing the difference) is not implemented. |
| 119.6 | implemented | `engine.ts:6948-6953` | A player with `life <= 0` loses the game as a state-based action (unless prevented by `playerCannotLoseGame`). |
| 119.7, 119.8 | partial | `runtime/effects.ts:748-751, 1210-1213, 1230-1233`, `runtime/costs.ts:402`, `engine.ts:6138, 6262, 6296, 6337` | `lifeTotalCantChange` prevents life gain, life loss, and paying `> 0` life in `runtime/effects.ts` and `runtime/costs.ts`. **Gaps**: (1) `executeCombatDamageStep` (`engine.ts:6138, 6262, 6296, 6337`) only checks the legacy flag `lifeTotalCannotChangeThisTurn` and ignores IR `activeRuleModifiers(state, 'lifeTotalCantChange')`; (2) separate `"can't gain life"` (e.g., Sulfuric Vortex) vs `"can't lose life"` modifiers and life-total exchange effects are not implemented. |
| 119.9, 119.10 | missing | `ir.ts:429`, `runtime/events.ts`, `runtime/effects.ts:751, 1233`, `engine.ts:4602, 6297, 6338` | **Bug**: `ir.ts:429` and `compiler/triggers.ts` define `event: 'gainLife'`, but `runtime/events.ts` has no `GainLife` event and no code path emits one or applies `lifeGain` replacement effects (`CR 119.9–119.10`). |

### 120 Damage

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 120.1, 120.1a, 120.2, 120.2a, 120.2b | implemented | `engine.ts:6007-6356`, `runtime/effects.ts:1121-1337` | Combat damage is dealt by attacking/blocking creatures (`executeCombatDamageStep`); noncombat damage is dealt by resolving spells/abilities (`damage`, `fight`) specifying a source. |
| 120.3, 120.3b, 120.3c, 120.3e | implemented | `runtime/effects.ts:1157-1170, 1206-1208`, `engine.ts:6106-6110, 6136-6137, 6207, 6232-6235, 6260-6261, 6324` | Damage to a player by an Infect source adds poison counters (`120.3b`); damage to a planeswalker removes loyalty counters (`120.3c`); damage to a creature without Wither/Infect marks `damageMarked` and `deathtouchDamageMarked` (`120.3e`). |
| 120.3a, 120.3f | partial | `runtime/effects.ts:1210-1213, 1228-1234`, `engine.ts:6138-6140, 6262-6264, 6296-6304, 6337-6339` | Damage to a player without Infect causes life loss (`120.3a`) and Lifelink causes the source's controller to gain life (`120.3f`), but `executeCombatDamageStep` ignores IR `activeRuleModifiers(state, 'lifeTotalCantChange')` and Lifelink never emits a `GainLife` event. |
| 120.3d | partial | `runtime/effects.ts:1162-1165`, `engine.ts:6044, 6204-6205, 6321-6322` | Spell/ability damage in `runtime/effects.ts:1162-1165` checks both `Infect` and `Wither` and places `-1/-1` counters via `this.addCounters`. **Bug in combat damage**: `executeCombatDamageStep` (`engine.ts:6044, 6204, 6321`) only checks `Infect` (ignoring `Wither` completely!) and directly mutates `counters['-1/-1']` instead of calling `addCountersToPermanent` (bypassing counter multipliers and `CounterPlaced` events). |
| 120.3g, 120.3h | missing | `engine.ts:6007-6356`, `runtime/effects.ts:1157-1172`, `types.ts:188-196` | Toxic (`120.3g`) is not implemented, and Battles / `'defense'` counters (`120.3h`) are not implemented (`dealDamageToPermanent` marks `damageMarked` on Battles instead of removing defense counters). |
| 120.4, 120.4b, 120.4c, 120.4d | partial | `runtime/effects.ts:1121-1234`, `engine.ts:6092-6348` | Noncombat damage (`runtime/effects.ts:1121-1234`) applies protection, `damagePreventionShield`, and `shield` counters before applying damage results and emitting `DamageDealt`. **Bug in combat damage**: `executeCombatDamageStep` (`engine.ts:6092-6348`) only checks `preventAllCombatDamageThisTurn` and `protectionFromEverythingThisTurn`—it skips `hasProtectionFrom` on creatures, `damagePreventionShield` on players/permanents, and `shield` counters (`CR 122.1c`). General damage-increasing/redirection replacement effects (e.g., Torbran) are also not implemented. |
| 120.4a | missing | `compiler/effects.ts`, `runtime/effects.ts` | Noncombat "excess damage" calculation and redirection (e.g., Flame Spill) is not implemented. |
| 120.5, 120.6, 120.7 | implemented | `engine.ts:6363-6364, 6657-6681`, `runtime/effects.ts:1166-1170` | Damage is marked on `perm.damageMarked` without reducing toughness (`120.5`); `checkStateBasedActions` destroys creatures with `damageMarked >= tough` or `deathtouchDamageMarked` (`120.6`), and `clearEndOfTurnAndDamage` clears marked damage in cleanup (`120.7`). |
| 120.8 | partial | `engine.ts:6095, 6320`, `runtime/effects.ts:1124, 1237, 1317` | Creatures with power `<= 0` deal no combat damage (`atkPower > 0`, `bPower > 0`) and `dealDamageToPermanent`/`dealDamageToPlayer` return `0` when `amount <= 0`; however, `fight` (`runtime/effects.ts:1322, 1326`) calls `dealDamageToPermanent` unconditionally and only gates on `amount <= 0` inside `dealDamageToPermanent`. |
| 120.9, 120.10 | missing | `runtime/events.ts`, `runtime/triggers.ts` | Batching single-source simultaneous damage to multiple permanents (`120.9`, `"deals damage to one or more..."`) and multi-source simultaneous damage (`120.10`) are not supported; `DamageDealt` is emitted once per target. |

### 121 Drawing a Card

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 121.1, 121.2, 121.2a, 121.4 | implemented | `engine.ts:914-936`, `runtime/effects.ts:989-997` | `drawCards` moves cards one at a time (`for (let i = 0; i < count; i++)`) from the top of `player.library` (`library[0]`) to `player.hand`, sets `attemptedEmptyLibraryDraw = true` if the library is empty (`121.4`), and skips `count <= 0`. |
| 121.2b | partial | `engine.ts:915-935`, `types.ts:814` | `state.playersDrawnThisTurn` records players who have drawn a card, **Bug**: `playersDrawnThisTurn` is never cleared at turn transitions (`runBeginningOfTurn` / `completeTurnCleanupAndPassTurn`), and `runtime/events.ts` has no `CardDrawn` event (`ir.ts` has no `'draw'` trigger event), so `"Whenever you draw a card"` / `"draw your second card each turn"` triggers do not exist. |
| 121.2c, 121.2d, 121.3, 121.5, 121.6, 121.6a, 121.6b, 121.6c, 121.7, 121.8 | missing | `engine.ts:914-936`, `runtime/replace.ts` | Multiple-draw action tracking (`121.2c`), revealing the first card drawn each turn (`121.2d`, Miracle), looking at top card while drawing (`121.3`), `"put into hand"` vs `"draw"` replacement distinction (`121.5`), draw replacement/prevention effects (`121.6–121.6c`), and reveal-as-you-draw effects (`121.7–121.8`) are not implemented. |

### 122 Counters

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 122.1, 122.1a, 122.1d, 122.2 | implemented | `types.ts:188-196, 353, 757-758`, `runtime/layers.ts:1640-1659`, `runtime/zones.ts:248` | Counters on permanents (`perm.counters`) and players (`poison`, `energyCounters`, `experienceCounters`) are tracked, `+1/+1` and `-1/-1` counters modify P/T in Layer 7c (`122.1a`), loyalty counters track planeswalker loyalty (`122.1d`), and `leaveBattlefieldReset` clears counters on zone change (`122.2`). |
| 122.1b | partial | `types.ts:188-196`, `runtime/layers.ts` | `CounterType` (`types.ts:188-196`) only includes `'+1/+1'`, `'-1/-1'`, `'loyalty'`, `'charge'`, `'shield'`, `'stun'`, `'time'`, and `'lore'`; keyword counters (flying, hexproof, deathtouch, lifelink, trample, indestructible, etc.) are not in `CounterType` and are not granted in Layer 6 by `runtime/layers.ts`. |
| 122.1c | implemented | `runtime/replace.ts:624-662`, `runtime/effects.ts:773, 1136-1143`, `engine.ts:6668` | Shield counters prevent destruction (`tryConsumeDestructionShield` in `runtime/replace.ts:624-662`, used by `destroy` and lethal-damage SBA) and prevent noncombat damage (`runtime/effects.ts:1136-1143`). (Note: skipped in `executeCombatDamageStep`, see `CR 120.4`). |
| 122.1e | partial | `types.ts:195`, `compiler/triggers.ts` | `'lore'` counter type exists on `CounterType`, but Saga chapter triggers and final-chapter sacrifice SBA are not implemented. |
| 122.1f, 122.1g, 122.1h, 122.1i | missing | `types.ts:188-196`, `engine.ts` | Finality counters (`122.1f`), defense counters on Battles (`122.1g`), rad counters on players (`122.1h`), and blessing counters (`122.1i`) are not implemented. |
| 122.3, 122.3a | implemented | `engine.ts:6699-6714` | `checkStateBasedActions` Step 3 removes `Math.min(plusOnes, minusOnes)` of both `+1/+1` and `-1/+1` (`-1/-1`) counters simultaneously as a state-based action. |
| 122.4 | implemented | `engine.ts:1032-1043` | In `executeUntapTurnBasedAction`, if a permanent that would untap has one or more `'stun'` counters, a stun counter is removed instead of untapping it. |
| 122.5 | partial | `runtime/costs.ts:410-416, 756-761`, `runtime/effects.ts:816-827` | `removeCounter` in `runtime/costs.ts` checks `(perm.counters[cost.counter] || 0) >= cost.count`, and `removeCounters` in `runtime/effects.ts` removes up to `n` counters; however, `"remove a counter"` (any counter type) is not supported. |
| 122.6, 122.6a | partial | `runtime/events.ts:98-104`, `engine.ts:4245-4263, 4632-4666, 6205, 6322`, `runtime/effects.ts:806-815` | `addCountersToPermanent` and `EffectEnv.addCounters` apply `counterMultiplier` (Doubling Season) and emit `CounterPlaced`. **Gaps**: (1) ETB counters (`engine.ts:4245-4263`) set `perm.counters[cType]` directly without emitting `CounterPlaced`, so `"Whenever one or more counters are put on a permanent"` triggers (`122.6a`) miss ETB counters; (2) combat Infect (`engine.ts:6205, 6322`) mutates `counters['-1/-1']` directly, bypassing both `counterMultiplier` and `CounterPlaced`. |
| 122.6b, 122.8 | missing | `runtime/events.ts`, `runtime/effects.ts` | There is no `CounterRemoved` event for `"Whenever a counter is removed from..."` triggers (`122.6b`), and `"can't have counters put on it"` effects (`122.8`, e.g., Solemnity) are not implemented. |
| 122.7 | partial | `engine.ts:5805-5865`, `runtime/effects.ts:966-968` | `proliferateAll` adds one counter of each existing counter type on permanents and players (`poison`, `energyCounters`, `experienceCounters`), **Bug**: `proliferateAll` automatically proliferates only `"beneficial"` permanents (own permanents with positive counters, opponent permanents with `-1/-1`/`stun` counters) and opponent poison without prompting the player to choose which permanents/players to proliferate! |

### 123 Stickers

| Rule | Status | Engine location | Notes |
|---|---|---|---|
| 123.1, 123.2, 123.2a, 123.2b, 123.2c, 123.3, 123.3a, 123.3b, 123.3c, 123.3d, 123.4, 123.4a, 123.5, 123.5a, 123.5b, 123.6, 123.6a, 123.6b, 123.7, 123.7a, 123.7b, 123.8, 123.8a, 123.8b, 123.9 | N/A | — | Unfinity stickers and sticker sheets are not supported in this Commander engine. |

## Silently skipped / approximated behaviour
- **Parallel human mulligan prompts (`CR 101.4`, `CR 103.5`)**: `engine.ts:435-444` queues opening-hand `mulligan` prompts for all human players simultaneously instead of in APNAP turn order, and bots only ever mulligan at most once (`engine.ts:416-429`) and bottom the last drawn card (`engine.ts:2235`).
- **Hidden-zone choice leakage (`CR 101.4a`)**: `sanitizeGameStateForViewer` (`engine.ts:8364-8400`) does not strip `stack[i].effectResume.answers`, exposing earlier players' pending hidden-zone discard choices before simultaneous execution (`runtime/effects.ts:1480`).
- **Starting player and 2-player first-turn draw (`CR 103.1`, `CR 103.8a`)**: `activePlayerIndex` is hardcoded to `0` at game start (`engine.ts:381`), and `DEFAULT_LOBBY_RULES.firstTurnDraw` is `true` (`types.ts:164`), so 2-player games do not skip Turn 1 draw unless manually configured (`engine.ts:1066`).
- **Opening-hand Leylines silently do nothing (`CR 103.6a`)**: `Leyline of Anticipation` is included in `precons.ts:1533`, but `checkIfAllKeptMulligan` (`engine.ts:464-477`) has no pregame opening-hand action step, so its opening-hand ability is silently ignored.
- **Last-player-standing win blocked by `playerCannotWinGame` (`CR 104.2a`)**: `checkStateBasedActions` (`engine.ts:7016`) checks `if (winner && !playerCannotWinGame(state, winner).blocked)` when only one player remains, directly contradicting CR 104.2a.
- **Mandatory infinite trigger loops silently truncated instead of drawing the game (`CR 104.4b`)**: `putTriggerOnStack` (`engine.ts:3597-3620`) caps triggers at `MAX_STACK_FOR_TRIGGERS = 300` and `MAX_TRIGGERS_PER_TURN = 200` and silently drops further triggers while continuing the game.
- **Mana color choice never prompts human players (`CR 105.4`)**: `runtime/effects.ts:897-902` auto-picks `preferredColor` or `allowed[0]` instead of presenting a `chooseColor` prompt.
- **Command Tower with a colorless commander produces all five colors (`CR 106.5`, `CR 903.9`)**: `manaChoiceColors` (`runtime/effects.ts:1772-1775`) falls back to `[...FIVE_COLORS]` when `commanderIdentity` is empty (`cols.length === 0`), instead of producing no mana.
- **Auto-tap for mana silently skips `TappedForMana` triggers (`CR 106.12`, `CR 106.12a`)**: `simulateOrExecuteAutoTap` (`engine.ts:820-832`) sets `perm.tapped = true` and adds mana without emitting `TappedForMana`.
- **Activated ability `{X}` hardcoded to 0 (`CR 107.3a`)**: `activate_ability` (`engine.ts:1641, 1670`) hardcodes `xValue: 0` instead of accepting `action.xValue`.
- **Snow mana `{S}` and hybrid Phyrexian `{W/U/P}` approximated (`CR 107.4f`, `CR 107.4h`)**: `parseManaCost` treats `{S}` as 1 generic mana (`oracle.ts:190`) and ignores `P` in two-color hybrid Phyrexian symbols (`oracle.ts:176-186`).
- **Permanent spell copies on the stack vanish on resolution (`CR 111.13`)**: `resolveStackItemNow` (`engine.ts:4171`) checks `if (item.kind === 'spell' && !item.isCopy)`, so copied permanent spells never enter the battlefield as tokens.
- **Hybrid and Phyrexian mana payments are auto-decided (`CR 118.13a`)**: `resolveFlexibleManaRequirement` (`oracle.ts:209-244`) and `simulateOrExecuteAutoTap` (`engine.ts:780-807`) automatically spend mana before paying 2 life for Phyrexian mana without prompting the player.
- **`GainLife` events are never emitted (`CR 119.9`, `CR 119.10`)**: `ir.ts:429` defines `event: 'gainLife'`, but `runtime/events.ts` has no `GainLife` event and neither `runtime/effects.ts:751, 1233` nor `engine.ts:4602, 6297, 6338` emits one.
- **Combat damage skips Wither, protection, prevention shields, shield counters, and counter multipliers (`CR 120.3d`, `CR 120.4`, `CR 122.1c`, `CR 122.6`)**: `executeCombatDamageStep` (`engine.ts:6007-6356`) omits `Wither`, creature protection, `damagePreventionShield`, `shield` counters, and `activeRuleModifiers(state, 'lifeTotalCantChange')`, and directly increments `counters['-1/-1']` for Infect without calling `addCountersToPermanent`.
- **`playersDrawnThisTurn` is never reset (`CR 121.2b`)**: `drawCards` (`engine.ts:918`) pushes to `state.playersDrawnThisTurn`, which is never cleared at turn transitions.
- **ETB counters do not emit `CounterPlaced` (`CR 122.6a`)**: `engine.ts:4245-4263` writes `perm.counters[cType]` directly on battlefield entry without emitting `CounterPlaced`.
- **Proliferate auto-selects targets (`CR 122.7`)**: `proliferateAll` (`engine.ts:5805-5865`) heuristically proliferates beneficial own counters and detrimental opponent counters without prompting the player.

## Legacy-only findings (verify after step F)
- **Legacy `validateTargetLegality` for `targetKind === 'any'` allows targeting any permanent (`CR 115.4`)**: In `engine.ts:7527`, the legacy `targetKind === 'any'` validator checks `findPermanentOnBoard(state, targetId)` without checking that the permanent is a Creature, Planeswalker, or Battle (whereas the IR compiler in `compiler/effects.ts:305-312` properly sets `types: ['Creature', 'Planeswalker', 'Battle']`).
- **Legacy `lifeTotalCannotChangeThisTurn` boolean vs IR `lifeTotalCantChange` rule modifier (`CR 119.7`)**: `executeCombatDamageStep` (`engine.ts:6138, 6262, 6296, 6337`) only checks `player.lifeTotalCannotChangeThisTurn` and does not query `activeRuleModifiers(state, 'lifeTotalCantChange', player.playerId)`.
- **Legacy `proliferateAll` helper (`CR 122.7`)**: `runtime/effects.ts:967` delegates `proliferate` to `this.env.proliferateAll()`, which lives in `engine.ts:5805-5865` and uses hardcoded beneficial/detrimental heuristics instead of `EffectStep` prompts.
- **Legacy `return_self_from_graveyard` activated ability exception (`CR 113.6b`, `CR 113.6m`)**: Non-battlefield activated abilities are only supported via legacy `return_self_from_graveyard` handling, while the IR `activate_ability` path (`engine.ts:1591`) only searches `actor.battlefield`.
