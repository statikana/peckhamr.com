# Rules audit: 8. Multiplayer Rules (800–811) and 9. Casual Variants (900–905) (rules.txt lines 6456–7151)
Audited at engine-rewrite 917180b on 2026-11-09.

## Summary
- Counts: implemented 25, partial 17, missing 9, N/A 194 (total 245 numbered rules/subrules across CR 800–905).
- Top gaps (most player-visible first):
  1. **CR 903.9b** — Human players are never prompted to send a commander to the command zone when it would be put into their hand or library (`runtime/zones.ts:224-231` only redirects for `owner?.isBot`), and non-battlefield moves to hand/library (from stack, graveyard, exile, or hand) omit `commanderRedirect: true` entirely — **M**.
  2. **CR 903.3d / 903.3e** — The IR `ObjectFilter`, `Amount`, `Condition`, and compiler grammars (`ir.ts`, `runtime/objectFilter.ts`, `compiler/statics.ts`, `compiler/triggers.ts`, `compiler/effects.ts`, `compiler/costs.ts`) have no support for `isCommander` or "your commander" across zones, breaking Background enchantments ("Commander creatures you own have..."), free commander spells (*Fierce Guardianship*, *Deflecting Swat*), *Jeska's Will*, and cast-commander triggers — **M**.
  3. **CR 903.4f** — When a player has a colorless commander (`commanderColorIdentity = []`) or no commander, `manaChoiceColors` (`runtime/effects.ts:1772-1775`) and legacy mana parsers (`oracle.ts:343, 524`) fall back to `['W', 'U', 'B', 'R', 'G']` instead of producing no mana — **S**.
  4. **CR 800.4j** — When the active player leaves the game during their turn, `cleanupEliminatedPlayer` (`engine.ts:7110-7111`) immediately aborts the turn via `completeTurnCleanupAndPassTurn(state)` instead of letting the turn continue to completion without an active player (wiping out pending combat/stack resolution and end-step triggers) — **M**.
  5. **CR 800.4a / 800.4c** — When a player leaves the game, `cleanupEliminatedPlayer` (`engine.ts:7062-7070`) unconditionally transfers all foreign-owned permanents on their battlefield back to `owner` (even permanents put onto the battlefield under the eliminated player's default control via *Bribery*/*Reanimate*, which CR 800.4a requires to be exiled), and `engine.ts:7042` drops foreign-owned spells controlled by the eliminated player from `state.stack` without exiling the cards or removing stack spells owned by the eliminated player but controlled by another player — **M**.
  6. **CR 800.4g** — If a resolving spell or ability pauses for an opponent's choice (`effectResume` in `runtime/effects.ts:398`) and that player concedes or loses, `cleanupEliminatedPlayer` (`engine.ts:7039`) deletes their prompt without reassigning the choice to another opponent or resuming the stack item, stalling the stack — **M**.
  7. **CR 800.4m** — Continuous effects with durations lasting "until [a player's] next turn" (`protectionFromEverythingThisTurn`, `lifeTotalCannotChangeThisTurn`, `cannotLoseGameThisTurn` in `engine.ts:1089-1092`, and `goadedByPlayerIds` in `engine.ts:1766`) never expire when that player has left the game because `completeTurnCleanupAndPassTurn` (`engine.ts:6463`) skips lost players' turns (`goadedByPlayerIds` is never cleared on turn start even for alive players) — **S**.
  8. **CR 800.4d** — Delayed triggered abilities (`state.delayedTriggers` in `engine.ts:3190-3240`) do not check whether their controller has left the game and are not cleaned up in `cleanupEliminatedPlayer` (`engine.ts:7035`) — **S**.
  9. **CR 802.4 / 802.5** — Multiplayer blocker declaration (`engine.ts:2075-2125`) conflates the turn-based action of declaring blockers with holding priority (passing priority in `declare_blockers` silently declares 0 blockers), and combat damage (`engine.ts:5977-6370`) is auto-assigned in attacker array order rather than APNAP choice order — **M**.
  10. **CR 806.3** — Seating order and starting player in Free-for-All multiplayer games (`createInitialGameState` in `engine.ts:305, 381`) are fixed to lobby seat index `0..N-1` with seat `0` always going first rather than randomized — **S**.
  11. **CR 903.3 / 903.3b / 903.3c** — Commander eligibility in `scryfall.ts:165, 179-185` checks combined `raw.type_line` across both faces of DFCs (allowing non-creature front faces with creature back faces) and does not require a P/T box on Spacecraft; `precons.ts:31` omits Vehicles and Spacecraft; meld (`903.3b`) and merged/mutated (`903.3c`) commanders are unimplemented — **S**.
  12. **CR 800.6 / 800.7** — Default lobby rules (`db.ts:448, 451`, `types.ts:160, 164`) enable `london_1free` and `firstTurnDraw: true` even when `players.length === 2` (2-player Commander should not get a free mulligan under CR 800.6 and should skip the starting player's Turn 1 draw under CR 800.7/103.8), and bots (`engine.ts:414-429`) can only mulligan at most once — **S**.

---

## Rule-by-rule

### 800. General (Multiplayer)

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 800.1 | Multiplayer game begins with >2 players | implemented | Definitional; `types.ts:148` (`maxPlayers: 2 \| 3 \| 4`) and `engine.ts:294-356` initialize 2–4 player games. |
| 800.2 | Multiplayer options and variants overview | N/A | Definitional overview; engine supports Free-for-All Commander only (`types.ts:138-154`). |
| 800.3 | Multiplayer tournament rules reference | N/A | Casual online engine; MTR tournament rules do not apply. |
| 800.4 | Multiplayer game continues after players leave | implemented | `engine.ts:7004-7032, 7106-7115` keeps `state.status = 'active'` while 2+ players have `!p.lost`. |
| 800.4a | Player leaves game: owned objects leave, control effects end, non-card stack items cease, remaining controlled objects exiled immediately, priority passes | partial | `cleanupEliminatedPlayer` (`engine.ts:7035-7116`) runs immediately in `loseTheGame` (`engine.ts:897`), `concede` (`engine.ts:1165`), and SBA loss (`engine.ts:6990`), removing owned objects via `removeFromGame` (`runtime/zones.ts:440-450`) and advancing priority (`engine.ts:7112-7114`). **Gaps:** (1) `engine.ts:7042` filters `state.stack` only by `item.controllerId !== elimId`, failing to remove stack spells *owned* by `elimId` but controlled by another player, and deleting foreign-owned spells controlled by `elimId` instead of exiling their cards; (2) `engine.ts:7062-7070` returns all foreign-owned permanents on `eliminated.battlefield` to `owner` (and clears `attachedToId`) instead of ending control-changing effects and exiling permanents where `elimId` is the default controller (e.g. *Bribery* / *Reanimate*); (3) `engine.ts:7076` skips clearing `graveyard` and `command` in 2-player `'GOLDEN'` lobbies. |
| 800.4b | No control change, token creation, or zone move to battlefield/stack under a left player's control | partial | `runtime/triggers.ts:310, 805` skips `p.lost` when collecting and flushing triggers. However, `moveObject` (`runtime/zones.ts:210-238`), `transferBattlefieldControl` (`runtime/zones.ts:418`), and token creation in `runtime/effects.ts` do not guard against `receiver.lost`. |
| 800.4c | Control-changing effect ends and default controller has left the game → exile object immediately | missing | No tracking of default controller vs continuous control-changing effects; `engine.ts:7062-7070` mutates `perm.controllerId = owner.playerId` directly. |
| 800.4d | Objects owned by left player aren't created; triggered abilities controlled by left player aren't put on stack | partial | Regular triggers controlled by lost players are skipped in `runtime/triggers.ts:310, 805`. However, `state.delayedTriggers` (`engine.ts:3190-3240`) and `cleanupEliminatedPlayer` (`engine.ts:7035`) never filter out delayed triggers controlled by an eliminated player. |
| 800.4e | Combat damage isn't assigned to a player who has left the game | partial | `cleanupEliminatedPlayer` (`engine.ts:7046-7048`) removes attackers with `defenderPlayerId === elimId`, preventing combat damage to `elimId`, though this also prematurely removes those creatures from combat entirely (see `802.2a`). |
| 800.4f | Left player required to pay a cost or choose whether to pay → cost is not paid | partial | `engine.ts:7039` removes `pendingPrompts` for `elimId`; cost prompts before casting/activating haven't put items on the stack yet. |
| 800.4g | Object requires left player to make a non-cost choice → controller chooses another player/opponent | missing | If a resolving stack item pauses via `effectResume` (`runtime/effects.ts:398`, `engine.ts:2848-2860`) waiting for an opponent's choice and that opponent leaves the game, `engine.ts:7039` deletes their prompt without reassigning the choice or resuming resolution. |
| 800.4h | Rule requires left player to make a choice → next player in turn order makes that choice | missing | Not implemented; no rule-choice handoff to the next player in turn order exists in `engine.ts`. |
| 800.4i | Effects needing info about a left player use LKI; "last turn" actions visible until next turn would have begun | partial | `PlayerGameState` remains in `state.players` with `lost: true` (`engine.ts:6984`), preserving last known life, poison, commander damage, and `spellsCastThisTurn`. The "last turn" cutoff when their next turn would have begun is not tracked. |
| 800.4j | If active player leaves during their turn, turn continues to completion without an active player | missing | `cleanupEliminatedPlayer` (`engine.ts:7110-7111`) checks `if (activePlayer?.playerId === elimId)` and immediately calls `completeTurnCleanupAndPassTurn(state)`, aborting the current step/phase and skipping the rest of the turn. |
| 800.4k | A player who has left the game doesn't begin a turn | implemented | `completeTurnCleanupAndPassTurn` (`engine.ts:6443, 6463`) skips `p.lost` in both `extraTurnQueue` and normal turn rotation; `runBeginningOfTurn` (`engine.ts:1086`) returns early if `activePlayer.lost`. |
| 800.4m | Continuous effects lasting until a left player's next turn expire when that turn would have begun | missing | Turn-start flags (`protectionFromEverythingThisTurn`, `lifeTotalCannotChangeThisTurn`, `cannotLoseGameThisTurn` at `engine.ts:1089-1092`) only clear inside `runBeginningOfTurn`, which is skipped when `p.lost` is true (`engine.ts:6463`), and `goadedByPlayerIds` (`engine.ts:1766`) is never cleared on turn start at all. |
| 800.4n | Ante zone exception when leaving the game | N/A | Ante zone is not supported. |
| 800.4p | Planechase planar controller handoff when leaving the game | N/A | Planechase variant is not supported. |
| 800.5 | Seating order determined by mutually agreeable method | implemented | Seats follow lobby seating order in `engine.ts:305`. |
| 800.6 | Multiplayer first mulligan is free | partial | `engine.ts:407-428, 2222-2228` grants 1 free mulligan under `london_1free`. However, `london_1free` is applied by default even in 2-player games (`db.ts:448`, `types.ts:160`), and bots (`engine.ts:414-429`) only check/mulligan once at game init. |
| 800.7 | In multiplayer (other than 2HG), starting player doesn't skip Turn 1 draw step | partial | `executeDrawTurnBasedAction` (`engine.ts:1060-1064`) draws on Turn 1 when `state.players.length > 2`, but because `state.rules.firstTurnDraw` defaults to `true` (`db.ts:451`, `types.ts:164`), 2-player games also draw on Turn 1 unless reconfigured. |

### 801. Limited Range of Influence Option

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 801.1, 801.2, 801.2a–d, 801.3, 801.4, 801.5, 801.5a–c, 801.6, 801.7, 801.7a, 801.8, 801.9, 801.10, 801.11, 801.12, 801.13, 801.13a–b, 801.14, 801.15, 801.16, 801.17, 801.18 | Limited range of influence option (28 rules/subrules) | N/A | Optional multiplayer rule not used in Free-for-All Commander (CR 806.2a, 903.2). |

### 802. Attack Multiple Players Option

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 802.1 | Active player may attack multiple players or only one player | implemented | `engine.ts:1717-1842` accepts per-attacker `defenderPlayerId` assignments across any subset of opponents. |
| 802.2 | All opponents are defending players during combat phase | implemented | `engine.ts:1745-1750` allows any non-lost opponent to be attacked. |
| 802.2a | "Defending player" refers to the specific player/planeswalker controller/battle protector attacked (or LKI if removed from combat) | partial | `AttackerEntry` (`engine.ts:1834-1841`) records `defenderPlayerId` and `defenderPlaneswalkerId` per attacker. However, when a defending player leaves the game, `cleanupEliminatedPlayer` (`engine.ts:7046-7048`) removes the `AttackerEntry` completely (losing attacking status and LKI), and battles are not supported. |
| 802.3 | Declare defending player, planeswalker, or battle for each attacker | partial | `engine.ts:1745-1763` supports attacking players and planeswalkers (`defenderPlaneswalkerId`); attacking battles is missing. |
| 802.3a | Per-player vs global attack restrictions and requirements | partial | `engine.ts:1765-1811` checks Goad (`701.15b`), Propaganda/Ghostly Prison (`getAttackTaxGeneric` per defender at `engine.ts:1787-1789`), and `attacksEachCombat`. Missing a general multi-player requirement-maximization solver (CR 508.1d) and per-player "can't attack [player]" static filter. |
| 802.3b | Creatures in a band can't attack different players | N/A | Banding is not implemented (covered in section 702). |
| 802.4 | Defending players declare blockers in APNAP order | partial | `getAttackedDefenderIdsInTurnOrder` (`engine.ts:3083-3094`) orders attacked defenders in APNAP turn order and `engine.ts:2075-2087, 5921-5926` steps through them. However, the engine uses `priorityPlayerIndex` for blocker declaration, and `pass_priority` (`engine.ts:2099-2125`) silently treats passing priority as declaring 0 blockers. |
| 802.4a | Defending player blocks only with own creatures and only creatures attacking them or their planeswalkers/battles | implemented | `engine.ts:1909-1933` enforces `blocker` is on `actor.battlefield` and `atkEntry.defenderPlayerId === actorId`. |
| 802.4b | Legality of blocks ignores creatures attacking other players and other players' blockers | implemented | `engine.ts:1898-2030` checks Menace and `blocksEachCombat` strictly per defending player (`attackersAgainstActor`). |
| 802.5 | Combat damage assigned in APNAP order | partial | `executeCombatDamageStep` (`engine.ts:5977-6370`) auto-assigns damage in `state.combat.attackers` array order without player damage-assignment order prompts. |

### 803. Attack Left and Attack Right Options

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 803.1, 803.1a, 803.1b | Attack left and attack right options (3 rules/subrules) | N/A | Optional multiplayer rules not used in Free-for-All Commander (CR 903.2). |

### 804. Deploy Creatures Option

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 804.1, 804.2 | Deploy creatures option for team variants (2 rules) | N/A | Team option not used in Free-for-All Commander (CR 806.2c, 903.2). |

### 805. Shared Team Turns Option

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 805.1, 805.2, 805.3, 805.3a–b, 805.4, 805.4a–d, 805.5, 805.5a–b, 805.6, 805.6a, 805.7, 805.8, 805.9, 805.10, 805.10a–f | Shared team turns option (24 rules/subrules) | N/A | Team option used only in Two-Headed Giant and Archenemy. |

### 806. Free-for-All Variant

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 806.1 | Players compete as individuals against each other | implemented | `engine.ts:294-356, 7004-7032` models individual players and last-player-standing victory. |
| 806.2, 806.2a, 806.2b, 806.2c | Free-for-All default options (no range of influence, attack multiple players, no deploy creatures) | implemented | `engine.ts:1717-1842` uses attack multiple players with unlimited range of influence and no deploy creatures. |
| 806.3 | Players are randomly seated around the table | missing | `createInitialGameState` (`engine.ts:305, 381`) preserves lobby seat array order and hardcodes `activePlayerIndex: 0` without randomizing seats or starting player. |

### 807–811. Other Multiplayer Variants (Grand Melee, Team vs. Team, Emperor, Two-Headed Giant, Alternating Teams)

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 807.1, 807.2, 807.2a–c, 807.3, 807.4, 807.4a–j, 807.5, 807.5a–b | Grand Melee variant (21 rules/subrules) | N/A | 10+ player variant not supported. |
| 808.1, 808.2, 808.3, 808.3a–b, 808.4, 808.5 | Team vs. Team variant (7 rules/subrules) | N/A | Team variant not supported. |
| 809.1, 809.2, 809.3, 809.3a–c, 809.4, 809.5, 809.5a–c, 809.6, 809.6a, 809.7 | Emperor variant (14 rules/subrules) | N/A | Team variant not supported. |
| 810.1, 810.2, 810.3, 810.4, 810.5, 810.6, 810.7, 810.8, 810.8a–d, 810.9, 810.9a–h, 810.10, 810.10a–d, 810.11 | Two-Headed Giant variant (27 rules/subrules) | N/A | Team variant not supported. |
| 811.1, 811.2, 811.2a–c, 811.3, 811.4, 811.5 | Alternating Teams variant (8 rules/subrules) | N/A | Team variant not supported. |

### 900–902. Casual Variants: General, Planechase, Vanguard

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 900.1, 900.2 | Casual variants general overview (2 rules) | N/A | Definitional overview. |
| 901.1, 901.2, 901.3, 901.3a, 901.4, 901.5, 901.6, 901.7, 901.7a, 901.8, 901.9, 901.9a–d, 901.10, 901.10a–b, 901.11, 901.11a–c, 901.12, 901.12a–d, 901.13, 901.14, 901.14a–b, 901.15, 901.15a–c | Planechase variant (35 rules/subrules) | N/A | Planechase casual variant not supported. |
| 902.1, 902.2, 902.3, 902.4, 902.5, 902.5a–b, 902.6, 902.7 | Vanguard variant (9 rules/subrules) | N/A | Vanguard casual variant not supported. |

### 903. Commander

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 903.1 | Commander variant overview | implemented | Definitional; primary game mode of the engine. |
| 903.2 | Two-player or multiplayer Free-for-All with attack multiple players and no limited range of influence | implemented | `types.ts:138-169`, `engine.ts:294-356, 1717-1842`. |
| 903.3 | Legendary commander designation (creature, Vehicle, or Spacecraft with P/T box); retained across zones | partial | `CardInstance.isCommander` (`types.ts:362`, `engine.ts:250, 310`) is an immutable card-instance attribute preserved across all zone changes (`runtime/zones.ts:239-269`). `scryfall.ts:179-186` checks `isLegendary && (Creature \| Vehicle \| Spacecraft)`. **Gaps:** (1) `scryfall.ts:183` does not verify that a Spacecraft has a power/toughness box; (2) `scryfall.ts:165` uses combined `raw.type_line` across both faces of a DFC instead of the front face (`front.type_line`), allowing a non-creature front face with a creature back face; (3) `precons.ts:31` only checks `Legendary` + `Creature` (omits Vehicle and Spacecraft). |
| 903.3a | "Can be your commander" static ability modifies deck construction before game begins | partial | `scryfall.ts:186` and `precons.ts:32` check `oracleText.toLowerCase().includes('can be your commander')`. Does not handle off-battlefield type-granting CDAs like *Grist, the Hunger Tide* unless `Creature` is already in `typeLine`. |
| 903.3b | Melded permanent containing a commander is that player's commander | missing | Meld is not implemented; no logic propagates `isCommander` to a melded permanent. |
| 903.3c | Merged permanent containing a commander is that player's commander | missing | Mutate/merged permanents are not implemented; no logic propagates `isCommander` to a merged permanent. |
| 903.3d | Effects referring to controlling/casting a commander or a commander in a specific zone | partial | Legacy target filter `matchesPermanentTypeFilter` (`engine.ts:7187`) checks `perm.isCommander` when `typeFilter` contains `'commander'`. However, the IR `ObjectFilter` (`ir.ts`, `runtime/objectFilter.ts`) and compiler (`compiler/statics.ts`, `compiler/triggers.ts`, `compiler/effects.ts`, `compiler/costs.ts`) have no `isCommander` support at all (breaking Background enchantments, free commander spells like *Fierce Guardianship*, and commander-cast triggers), and `spellCannotBeCountered` (`runtime/replace.ts:625`) hardcodes `isCommander: false` on stack spells. |
| 903.3e | Effects referring to a characteristic of "your commander" see it in all zones | missing | Neither `runtime/objectFilter.ts` (`evaluateAmount`) nor `runtime/effects.ts` can query a player's commander across all zones to read its power, toughness, mana value, colors, or creature types (e.g. *Jeska's Will*, *Path of Ancestry* scry trigger). |
| 903.4 | Color identity defined by mana symbols in mana cost/rules text, CDAs, and color indicator | implemented | `scryfall.ts:172` uses Scryfall's `raw.color_identity` (and `precons.ts` provides curated `colorIdentity`). |
| 903.4a | Color identity is established before the game begins | implemented | `engine.ts:312-314` computes `commanderColorIdentity` before play begins; `card.colorIdentity` is never mutated by in-game continuous effects. |
| 903.4b | Commander static ability choosing a color before the game begins affects color identity | missing | No deckbuilder or pre-game choice exists for commanders with "Choose a color before the game begins" (e.g. *The Prismatic Piper*, *Faceless One*, *Clara Oswald*). |
| 903.4c | Reminder text is ignored when determining color identity | implemented | Handled via Scryfall's `color_identity` in `scryfall.ts:172`. |
| 903.4d | Back face of a DFC is included in color identity | implemented | Handled via Scryfall's `color_identity` in `scryfall.ts:172`. |
| 903.4e | Alternative characteristics (e.g. Adventurer) included in color identity | implemented | Handled via Scryfall's `color_identity` in `scryfall.ts:172`. |
| 903.4f | If a player has no commander (or colorless identity), commander color identity is undefined/empty; abilities referring to it do nothing | missing | Both IR `manaChoiceColors` (`runtime/effects.ts:1772-1775`: `return cols.length > 0 ? cols : [...FIVE_COLORS]`) and legacy mana parsers (`oracle.ts:343, 524`, `ruleTree.ts:232, 985`) fall back to all five colors `['W', 'U', 'B', 'R', 'G']` when `commanderColors(controller)` is empty! A colorless commander deck or a player without a commander can tap *Command Tower* or *Arcane Signet* for any color of mana. |
| 903.5 | Commander deck construction rules | implemented | `validateCommanderDeck` in `scryfall.ts:491-586`. |
| 903.5a | Deck must contain_exactly 100 cards including commander(s) | implemented | `scryfall.ts:575-578` checks `totalCards = commanders.length + mainCount !== 100`. |
| 903.5b | Singleton rule except basic lands; interchangeable English names | partial | `scryfall.ts:532-559` enforces singleton except `BASIC_LAND_NAMES` / `Basic Land`, `MULTI_COPY_CARDS` / `"a deck can have any number of cards named"`, and `CAPPED_COPY_CARDS` (*Seven Dwarves*, *Nazgûl*). Does not deduplicate cards with interchangeable names (`oracle_id` / Universes Beyond equivalents, CR 201.3). |
| 903.5c | Card color identity must be subset of commander's color identity | implemented | `scryfall.ts:518-526, 561-568`. |
| 903.5d | Basic land types restricted by commander's color identity | implemented | Covered by `scryfall.ts:561-568` via Scryfall's `color_identity`. |
| 903.5e | Commander abilities that modify deck construction | partial | `areValidCommanderPartners` (`scryfall.ts:452-489`) implements Partner, Partner with [Name], Friends forever, Choose a Background, and Doctor's companion (CR 702.124). Other deck-construction modifiers (e.g. Companion, CR 702.139) are not supported. |
| 903.5f | Commander games do not use sideboards | implemented | `scryfall.ts:43-144` and `types.ts:104-116` have no sideboard structure. |
| 903.6 | At start of game, put commander face up into command zone and shuffle remaining deck as library | implemented | `createInitialGameState` in `engine.ts:309-323`. |
| 903.7 | Starting life total is 40 and opening hand is 7 cards | implemented | `db.ts:444`, `types.ts:157`, `engine.ts:324, 332`. |
| 903.8 | Cast commander from command zone; costs additional {2} per previous cast from command zone | implemented | Casting from `actor.command` in `engine.ts:1433-1437`, tax increment on cast in `engine.ts:1516-1520`, and tax cost addition (`castCount * state.rules.commanderTaxIncrement`) in `runtime/costs.ts:210-216` and `ruleTree.ts:897-911`. |
| 903.9 | Commander may return to command zone | partial | See `903.9a`–`903.9c`. |
| 903.9a | Commander in graveyard or exile since last SBA check may be put into command zone as SBA | partial | `checkStateBasedActions` (`engine.ts:6859-6920`) and choice handler (`engine.ts:2451-2495`) implement the SBA with `commanderSbaDeclinedVersion` tracking (`engine.ts:2485, 6867-6870`). **Gaps:** (1) For human players, `engine.ts:6903` queues an async prompt and finishes the SBA loop / flushes triggers before the player answers; (2) `engine.ts:6860-6863` scans `p.graveyard` and `p.exile` and prompts `p.playerId` rather than `cmd.ownerId` (if a commander is placed in an opponent's exile zone, since `runtime/zones.ts:235` does not force `exile` to `owner`, the opponent gets the prompt). |
| 903.9b | If commander would be put into owner's hand or library from anywhere, owner may put it into command zone instead (replacement effect) | partial | **Gaps:** (1) `runtime/zones.ts:224-231` only redirects when `owner?.isBot` is true — human players are never prompted and their commander goes straight into their hand or library; (2) bots unconditionally redirect to the command zone without option to keep in hand; (3) `commanderRedirect: true` is only passed when moving from the battlefield (`engine.ts:7151`, `runtime/costs.ts:691, 706`), so a commander moving to hand or library from the stack (e.g. *Remand* / *Memory Lapse*), graveyard, exile, or hand never triggers CR 903.9b even for bots. |
| 903.9c | Melded or merged commander replacement effect splits non-commander components to destination and commander to command zone | missing | Meld and Mutate/merged permanents are not implemented. |
| 903.10, 903.10a | Player dealt 21+ combat damage by the same commander over the game loses the game (SBA) | implemented | Tracked per commander `instanceId` in `defPlayer.commanderDamageTaken[attacker.instanceId]` for unblocked (`engine.ts:6161-6168`) and trample (`engine.ts:6266-6269`) combat damage; checked in `checkStateBasedActions` (`engine.ts:6966-6978`). |
| 903.11, 903.11a | Cards from outside the game cannot be brought into a Commander game except via specific rules/effects | implemented | Engine does not allow bringing cards from outside the game. |
| 903.12, 903.12a–h | Brawl option (9 rules/subrules) | N/A | Brawl variant is not supported (engine is 100-card Commander only). |
| 903.13, 903.13a–g | Commander Draft option (8 rules/subrules) | N/A | Commander Draft limited variant is not supported. |

### 904–905. Casual Variants: Archenemy, Conspiracy Draft

| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 904.1, 904.2, 904.2a–b, 904.3, 904.4, 904.5, 904.6, 904.7, 904.8, 904.9, 904.10, 904.11, 904.12, 904.12a–c, 904.13, 904.13a–d | Archenemy variant (21 rules/subrules) | N/A | Archenemy casual variant is not supported. |
| 905.1, 905.1a–d, 905.2, 905.2a–c, 905.3, 905.4, 905.4a, 905.5, 905.6 | Conspiracy Draft variant (14 rules/subrules) | N/A | Conspiracy Draft casual variant is not supported. |

---

## Silently skipped / approximated behaviour

- **CR 903.9b (Commander to hand or library replacement effect):** `moveObjectInner` in `runtime/zones.ts:224-231` checks `opts.commanderRedirect && obj.isCommander && (to === 'hand' || to === 'library') && owner?.isBot`. For human players, the replacement choice is silently skipped and the commander is put directly into their hand or library. For bots, it is unconditionally redirected to the command zone. Furthermore, moves to `hand` or `library` from any zone other than the battlefield never set `commanderRedirect: true` (`engine.ts:7151`, `runtime/costs.ts:691, 706`).
- **CR 903.4f (Empty/colorless commander color identity fallback to WUBRG):** In `runtime/effects.ts:1772-1775` (`manaChoiceColors`) and `oracle.ts:343, 524`, if `commanderColors(controller)` returns an empty array (e.g. a colorless commander or no commander), the engine silently falls back to all five colors `['W', 'U', 'B', 'R', 'G']` instead of producing no mana.
- **CR 800.4a / 800.4c (Eliminated player's foreign-owned permanents and stack items):** `cleanupEliminatedPlayer` in `engine.ts:7062-7070` unconditionally transfers all foreign-owned permanents on the eliminated player's battlefield back to their owners (even if the eliminated player put them onto the battlefield under their default control via *Reanimate*/*Bribery* and CR 800.4a requires them to be exiled), and `engine.ts:7042` drops foreign-owned spells controlled by the eliminated player from `state.stack` without putting those cards into their owners' exile zones.
- **CR 800.4j (Active player leaves the game during their turn):** `cleanupEliminatedPlayer` in `engine.ts:7110-7111` immediately calls `completeTurnCleanupAndPassTurn(state)` when the active player leaves the game, silently aborting the rest of the current turn (including combat or stack items) rather than continuing the turn without an active player.
- **CR 800.4g (Opponent leaves the game while an effect choice is pending):** `cleanupEliminatedPlayer` in `engine.ts:7039` deletes `pendingPrompts` belonging to the eliminated player without asking the effect's controller to choose another opponent or advancing a paused `effectResume` on the stack (`engine.ts:2848-2860`).
- **CR 802.4 (Passing priority in `declare_blockers` auto-declares 0 blockers):** In `engine.ts:2099-2125`, if an attacked defending player sends `pass_priority` during `declare_blockers` before declaring blockers, the engine silently records 0 blockers for that player and jumps `priorityPlayerIndex` to the next undecided defender.
- **CR 802.5 (Combat damage assignment order):** `executeCombatDamageStep` in `engine.ts:5977-6370` automatically assigns combat damage to blockers in array order without prompting attacking/defending players in APNAP order.
- **CR 806.3 (Random seating and starting player):** `createInitialGameState` in `engine.ts:305, 381` seats players in deterministic lobby seat order and always gives seat 0 the first turn.
- **CR 800.6 (Bot mulligan limit):** In `createInitialGameState` (`engine.ts:414-429`), bots evaluate their opening hand at most once and auto-keep whatever hand they draw on their first mulligan.

---

## Legacy-only findings (verify after step F)

- **CR 903.3d (`'commander'` type-word filter):** The only place in the codebase that filters permanents by `perm.isCommander` is `matchesPermanentTypeFilter` in `engine.ts:7187` (used by legacy target validation). The IR `ObjectFilter` (`ir.ts`, `runtime/objectFilter.ts`) has no `isCommander` property at all.
- **CR 903.4f (Legacy mana parser WUBRG fallback):** `oracle.ts:343, 524` and `ruleTree.ts:232, 985` default `commanderIdentity` to `['W', 'U', 'B', 'R', 'G']` when empty (duplicated in the new IR runtime at `runtime/effects.ts:1774`).
- **CR 903.8 (Legacy ruleTree commander tax hook):** `ruleTree.ts:897-911` computes Commander Tax separately from `runtime/costs.ts:210-216`.
