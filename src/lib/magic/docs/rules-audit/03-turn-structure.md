# Rules audit: 5. Turn Structure, CR 500–514 (rules.txt lines 2114–2455)
Audited at engine-rewrite 917180b on 2026-11-09.

## Summary
- Counts: implemented 32 (42 subrules), partial 36 (43 subrules), missing 22 (48 subrules), N/A 6 (6 subrules).
- Top gaps (most player-visible first):
  1. **CR 510.2** — Combat damage (`engine.ts:6007-6356`) bypasses `dealDamageToPermanent` / `dealDamageToPlayer` (`runtime/effects.ts:1121-1220`), ignoring Protection (CR 702.16e), shield counters (CR 122.1c), damage prevention shields, Wither, counter multipliers/`CounterPlaced` events on Infect `-1/-1` counters, and static `lifeTotalCantChange` rule modifiers — **M**.
  2. **CR 506.4c / 510.1b** — If a planeswalker being attacked leaves the battlefield or phases out before combat damage, an unblocked or trampling attacker falls through `if (defWalker)` (`engine.ts:6105-6178, 6231-6293`) and deals its combat damage to the defending player instead of assigning 0 combat damage — **S**.
  3. **CR 506.4** — `moveObject` (`runtime/zones.ts:187-309`) and `movePermanentToZone` (`engine.ts:7142-7159`) never remove a permanent leaving the battlefield from `state.combat.attackers` or `blockerInstanceIds` (and continuous type loss is never checked), so flickered/reanimated permanents or non-creatures remain in combat — **S**.
  4. **CR 500.2 / 513.1** — The `end_turn` action (`engine.ts:2152-2184`) lets the active player jump directly from any phase (even `upkeep` before drawing, or mid-combat) to `end_step` and immediately into `cleanup`, skipping all intermediate steps/triggers and denying non-active players priority in every skipped step and in `end_step` — **M**.
  5. **CR 508.1 / 509.1** — Entering `declare_attackers` (`engine.ts:5906-5909`) and `declare_blockers` (`engine.ts:5913-5920`) grants priority before the turn-based action of declaring attackers/blockers has been performed, allowing spells and abilities to be cast/activated inside those steps before declarations — **M**.
  6. **CR 510.1 / 510.1c** — When an attacker is blocked by two or more creatures, `executeCombatDamageStep` (`engine.ts:6190-6227`) auto-assigns lethal damage in blocker-array order instead of letting the attacking player divide combat damage among the blockers — **M**.
  7. **CR 500.7** — When an extra turn is popped from `extraTurnQueue` (`engine.ts:6440-6457`), `state.activePlayerIndex` is overwritten with `extraIdx` without recording whose normal turn just ended; if a player takes an extra turn out of turn order, intermediate players' normal turns are permanently skipped — **S**.
  8. **CR 505.4** — Sagas never receive a lore counter as a turn-based action at the beginning of the precombat main phase (`engine.ts:3248-3278`) and chapter triggers are unimplemented — **M**.
  9. **CR 508.1d / 509.1c** — Mandatory attack checks (`engine.ts:1797-1810`) force `attacksEachCombat`/Goaded creatures to attack into Propaganda/Ghostly Prison taxes (violating CR 508.1d), and mandatory block checks (`engine.ts:2021`) unconditionally exempt `blocksEachCombat` creatures from blocking Menace attackers even when a second blocker is available (violating CR 509.1c) — **S**.
  10. **CR 500.5a / 500.8–500.10 / 511.2** — No support for `'endOfCombat'` effect durations (`ir.ts:332`) or additional combat/main phases and additional upkeep steps (`engine.ts:5882-5976`) — **M**.
  11. **CR 506.1 / 508.8** — When no attackers are declared (`engine.ts:5922-5930`), the engine skips `end_combat` directly to `main2`, whereas CR 506.1 and 508.8 only skip `declare_blockers` and `combat_damage` — **S**.
  12. **CR 508.3 / 509.3** — Missing common combat trigger variants in `compiler/triggers.ts` and `runtime/triggers.ts`: "attacks and isn't blocked" (508.3f / 509.3g), "Whenever [player/planeswalker] is attacked" (508.3b), "attacks [a player]" (508.3a/e), and "blocks/becomes blocked by a creature" per-blocker triggers (509.3b/d) — **M**.

---

## Rule-by-rule

### 500. General
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 500.1 | Five phases in order (beginning, precombat main, combat, postcombat main, ending) and their steps | implemented | `types.ts:14-43` (`GamePhase`, `PHASE_ORDER`), `engine.ts:1084-1110` (`runBeginningOfTurn`), `engine.ts:5876-5981` (`advancePhaseOrStep`). |
| 500.2 | Phase/step with priority ends only when stack is empty and all players pass in succession | partial | `engine.ts:2127-2142` (`pass_priority` checks `allPassed` with `state.stack.length === 0`). Violated in four places: (1) `end_turn` (`engine.ts:2152-2184`) skips all remaining steps/phases and `end_step` priority without opponent passes; (2) `checkIfAllKeptMulligan` (`engine.ts:471-476`) auto-advances past Turn 1 `upkeep` and `draw` without any player passing; (3) `declare_blockers` entry (`engine.ts:5913-5920`) gives priority to the defending player first; (4) `ai.ts:191-206` auto-passes off-turn empty-stack priority for humans even when holding legal instants and ignores `stopPhases`. |
| 500.3 | Steps without priority (untap and normal cleanup) end when turn-based actions complete | implemented | `engine.ts:1095-1102` runs `untap` and transitions directly to `upkeep`; `engine.ts:6373-6473` (`runCleanupStep` / `completeTurnCleanupAndPassTurn`) completes cleanup without priority unless 514.3a applies. |
| 500.4 | As a step or phase begins, effects lasting until that step or phase expire | partial | `engine.ts:1089-1092` clears "until your next turn" player flags at the start of the player's turn; general step/phase-start durations do not exist in `ir.ts:332` (`Duration`). |
| 500.5 | As a step or phase ends, "until end of [step/phase]" effects expire; unspent mana empties | partial | Mana pools empty at `engine.ts:1097, 5417, 5878, 6374` (`emptyAllPlayersManaPools`); step/phase-scoped continuous effect expiration is not implemented. |
| 500.5a | "Until end of combat" effects expire at the end of the combat phase | missing | `ir.ts:332` (`Duration = 'endOfTurn' \| 'permanent' \| 'untilYourNextTurn'`) has no `'endOfCombat'` duration, and `engine.ts:5954-5963` expires no continuous effects when `end_combat` ends. |
| 500.5b | "Until end of turn" effects expire in cleanup (see 514.2) | implemented | `engine.ts:6358-6371, 6426` (`clearEndOfTurnAndDamage`). |
| 500.6 | "At the beginning of [phase/step]" abilities trigger when phase/step begins, queued until priority | partial | `engine.ts:3248-3278` (`beginPhase`) emits `PhaseBegin` after turn-based actions and flushes via `runtime/triggers.ts:725-741, 823-856`. However, `compiler/triggers.ts:54-62, 367-375` (`STEPS`, `RUNTIME_PHASES`) only supports `upkeep`, `draw`, `main1`, `begin_combat`, `end_combat`, `main2`, and `end_step` (no `declare_attackers`, `declare_blockers`, `combat_damage`, or `cleanup`). |
| 500.7 | Extra turns added directly after specified turn in LIFO / APNAP order | partial | `types.ts:818` (`extraTurnQueue`), `runtime/effects.ts:941-948`, `engine.ts:4328-4342, 6440-6457`. Uses LIFO `.push()` / `.pop()`, but `engine.ts:6445, 6460-6470` overwrites `state.activePlayerIndex = extraIdx` without saving whose normal turn was interrupted; an extra turn taken by a non-active player permanently shifts normal turn order and skips intermediate players. |
| 500.8 | Extra phases added directly after specified phase in LIFO order | missing | `engine.ts:5882-5976` uses a static `switch (state.phase)`; no extra-phase queue or IR verb exists for additional combat/main phases. |
| 500.9 | Extra steps added to a phase in LIFO order | missing | No extra-step queue or IR verb exists. |
| 500.10, 500.10a | Adding a step after a phase creates that phase with other steps skipped; "you get" on another player's turn adds nothing | missing | No extra-step/phase support. |
| 500.11 | Skipping a step, phase, or turn proceeds past it as though it didn't exist | partial | Built-in skips exist for Turn 1 1v1 draw (`engine.ts:1060-1081`), 0-attacker combat steps (`engine.ts:5922-5930`), and `endTheTurnImmediately` (`engine.ts:5388-5408`), but card-driven step/phase/turn-skipping effects (e.g. Stasis, Stonehorn Dignitary) are not implemented. |
| 500.12 | No game events can occur between steps, phases, or turns | implemented | Definitional; `engine.ts:5876-5981` transitions `state.phase` synchronously. |

### 501. Beginning Phase
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 501.1 | Beginning phase consists of untap, upkeep, and draw steps in order | implemented | `types.ts:29-33`, `engine.ts:1095-1100, 5883-5892`. |

### 502. Untap Step
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 502.1 | First, phased-in permanents with phasing phase out and phased-out permanents phase in simultaneously | implemented | `engine.ts:948-1042` (`executeUntapTurnBasedActions`) collects direct and indirect phasing in/out sets before mutating `phasedOut` simultaneously. |
| 502.2 | Second, day/night check based on previous turn's active player's spell count | missing | `activePlayer.spellsCastThisTurn` is tracked (`engine.ts:1093`), but day/night state (`CR 732`) does not exist in `types.ts` or `executeUntapTurnBasedActions` (`engine.ts:944-1057`). |
| 502.2a | Shared team turns day/night check | N/A | Shared team turns variant is not used in free-for-all Commander. |
| 502.3 | Third, active player determines which permanents untap and untaps them simultaneously | partial | `engine.ts:1044-1056` untaps non-phased-out permanents unless `hasRestriction(state, perm, 'doesntUntap')` (`runtime/replace.ts:531`) and applies stun counter replacement (`CR 122.1d`). Missing optional untap ("you may choose not to untap ~") and quantity-capped untap restrictions ("choose N permanents to untap"). |
| 502.4 | No player receives priority during untap step; triggers held until upkeep | implemented | `engine.ts:1095-1109` (`runBeginningOfTurn`) runs `beginPhase(state, 'untap')` and immediately transitions to `beginPhase(state, 'upkeep')` before giving priority. |

### 503. Upkeep Step
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 503.1 | Upkeep step has no turn-based actions; active player gets priority | partial | `engine.ts:1100-1109, 5883-5885`. Partial because `checkIfAllKeptMulligan` (`engine.ts:471-473`) immediately advances past Turn 1 `upkeep` without priority if the stack is empty. |
| 503.1a | Triggers from untap step and beginning of upkeep go on stack before active player gets priority | implemented | `engine.ts:1096-1100, 3248-3277, 3325-3326` runs suspend upkeep and flushes `PhaseBegin('upkeep')` triggers in APNAP order before priority. |
| 503.2 | Spells stating they may be cast only "after [a player's] upkeep step" | missing | Not parsed or enforced in `compiler/`, `oracle.ts`, or `engine.ts:7901-8053`. |

### 504. Draw Step
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 504.1 | First, active player draws a card as a turn-based action | implemented | `engine.ts:1059-1082, 3257-3258` (`executeDrawTurnBasedAction`) runs inside `withTriggersDeferred` before `PhaseBegin('draw')` triggers. |
| 504.2 | Second, active player gets priority | partial | `engine.ts:5886-5892, 5978-5980`. Partial because `checkIfAllKeptMulligan` (`engine.ts:474-476`) immediately advances past Turn 1 `draw` step without priority if the stack is empty. |

### 505. Main Phase
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 505.1, 505.1a, 505.1b | Two main phases (`main1` precombat, `main2` postcombat) separated by combat | implemented | `types.ts:18, 25`, `engine.ts:5893-5904, 5928, 5961`, `compiler/triggers.ts:58-61`. |
| 505.2 | Main phase has no steps; ends when all players pass with empty stack | implemented | `engine.ts:2131-2142, 5901-5904, 5965-5967`. |
| 505.3 | Archenemy scheme turn-based action in precombat main phase | N/A | Archenemy variant (CR 904). |
| 505.4 | Active player puts a lore counter on each Saga they control at start of precombat main phase | missing | `'lore'` counter exists in `types.ts:195` and `'Saga'` in `runtime/objectFilter.ts:54`, but `beginPhase(state, 'main1')` (`engine.ts:3248-3278`) performs no Saga lore-counter turn-based action and chapter triggers are not implemented. |
| 505.5 | Roll to visit Attractions in precombat main phase | N/A | Un-set / Attractions casual mechanic. |
| 505.6, 505.6a | Active player gets priority; artifact, creature, enchantment, planeswalker, and sorcery spells normally cast only in main phase | implemented | `engine.ts:5978, 7951-7974` (`checkSpellCastLegality`). |
| 505.6b | Active player may play one land per turn in main phase with priority and empty stack; doesn't use stack | partial | `engine.ts:1278-1335, 7844-7899` (`checkLandPlayLegality`). Partial because additional-land static abilities ("play an additional land") are only parsed by legacy `getCardExtraLandPlays` (`oracle.ts:121-139`, `engine.ts:7890`) rather than `compiler/statics.ts`, and bots (`ai.ts:279`) check `bot.maxLandsPerTurn` (always 1) instead of `effectiveMaxLands`. |

### 506. Combat Phase
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 506.1 | Five combat steps in order; skip blockers & damage if no attackers; two damage steps for first/double strike | partial | `types.ts:19-24`, `engine.ts:5906-5963`. When 0 attackers are declared (`engine.ts:5922-5930`), the engine skips `declare_blockers`, `combat_damage`, AND `end_combat` directly to `main2`; per CR 506.1 and 508.8 only `declare_blockers` and `combat_damage` are skipped (`end_combat` still occurs). |
| 506.2 | Active player is attacking player; opponents, their planeswalkers, and protected battles may be attacked | partial | `engine.ts:1700-1702, 1745-1763` supports attacking opposing players and planeswalkers they control; battles are not implemented. |
| 506.2a | Multiplayer defending players (Attack Multiple Players option in Commander) | implemented | `engine.ts:1745-1750` allows attacking any non-eliminated opponent or their planeswalkers simultaneously. |
| 506.2b | Shared team turns attacking/defending teams | N/A | Shared team turns variant. |
| 506.3 | Only a creature can attack or block; only a player, planeswalker, or battle can be attacked | partial | `engine.ts:1726, 1745-1763, 1912` enforces `evaluatePermanent(state, ...).isCreature` for attackers/blockers and player/planeswalker for attack targets; battles not implemented. |
| 506.3a–g | Putting permanents onto the battlefield attacking or blocking; battles cannot attack or block | missing | No effect in `compiler/`, `ir.ts`, or `runtime/effects.ts` puts permanents onto the battlefield attacking or blocking. |
| 506.4 | Permanent is removed from combat when it leaves battlefield, changes controller, phases out, regenerates, stops being a creature/planeswalker/battle, or by effect | partial | Control change (`runtime/zones.ts:429-436`) and direct phase-out (`engine.ts:5373-5378`) remove attackers/blockers. Missing: (1) `moveObject` (`runtime/zones.ts:187-309`) and `movePermanentToZone` (`engine.ts:7142-7159`) do not remove permanents leaving the battlefield from `state.combat.attackers` or `blockerInstanceIds`, so flickered/reanimated creatures remain in combat; (2) permanents that stop being creatures/planeswalkers are never removed from combat; (3) `defenderPlaneswalkerId` is not cleared on control change or phase-out. |
| 506.4a | Spells/abilities that would have kept an already-declared creature from attacking/blocking don't remove it from combat | implemented | Restrictions are checked only at declaration time in `engine.ts:1726-1743, 1912-1988`. |
| 506.4b | Tapping or untapping a declared attacker or blocker doesn't remove it from combat or prevent its combat damage | implemented | `engine.ts:6049-6350` deals combat damage regardless of `tapped` status. |
| 506.4c | Removing an attacked planeswalker/battle from combat leaves the attacker in combat attacking nothing; if unblocked it deals no combat damage | missing | Bug in `engine.ts:6098-6150, 6230-6293`: when `atkEntry.defenderPlaneswalkerId` is set and the planeswalker leaves the battlefield or phases out, `defWalker` is `undefined`, so `if (defWalker)` is false and execution falls into `else`, dealing unblocked or trample combat damage to `defPlayer` instead of dealing 0 damage. |
| 506.4d, 506.4e | Permanent that is both a blocking creature and attacked planeswalker (or planeswalker and battle) losing one type | missing | Type-loss removal from combat is not implemented. |
| 506.5, 506.6 | "Attacks alone", "attacking alone", "blocks alone", "blocking alone", "attacks a player alone" | missing | Not parsed or tracked in `compiler/`, `ir.ts`, or `runtime/`. |
| 506.7 | Checking whether a creature "had to attack" | missing | Not tracked on `CombatAttacker` or in `runtime/`. |
| 506.8, 506.8a, 506.8c | Spells restricted to "only during combat" or "only before attackers are declared" | partial | Legacy-only in `oracle.ts:629-631` and `engine.ts:7984-8008` (`onlyDuringCombat`, `onlyBeforeAttackersDeclared`). Not in IR. |
| 506.8b, 506.8d–g | Spells/abilities restricted to before/after blockers declared, after attackers declared, skipped-step fallbacks, and activated ability combat-point restrictions | missing | Not parsed or enforced in `oracle.ts`, `compiler/`, or `engine.ts`. |

### 507. Beginning of Combat Step
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 507.1 | Choosing single defending player in variants without Attack Multiple Players | N/A | Commander uses Attack Multiple Players option (CR 802). |
| 507.2 | Active player gets priority in beginning of combat step | implemented | `engine.ts:5901-5904, 5978`. |

### 508. Declare Attackers Step
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 508.1 | First, active player declares attackers as a turn-based action; illegal declaration rewinds | partial | `engine.ts:1699-1880` validates all assignments before mutating state. However, `engine.ts:5906-5909, 5978` enters `declare_attackers` and grants priority to the active player BEFORE attackers are declared, allowing spells/abilities to be cast in `declare_attackers` prior to declaration. |
| 508.1a | Chosen attackers must be controlled by active player, untapped, creatures, not battles, and have haste or no summoning sickness | partial | `engine.ts:1723-1737` checks active-player control, not phased out, `isCreature`, `!creature.tapped`, and `!creature.summoningSick \|\| hasKeyword(creature, 'Haste', state)`; `runtime/zones.ts:426` sets `summoningSick = true` on control change. Battle check is missing. |
| 508.1b | Announce which player, planeswalker, or battle each creature is attacking | partial | `engine.ts:1745-1763` validates `defenderPlayerId` and `defenderPlaneswalkerId`; battles are not implemented. |
| 508.1c | Check attacking restrictions (`cantAttack`, `Defender`, conditional restrictions) | partial | `engine.ts:1738-1743` checks `Defender` and `hasRestriction(state, creature, 'cantAttack')`. Conditional restrictions ("can't attack alone", "can't attack unless...") are not implemented. |
| 508.1d | Check attacking requirements; maximize requirements obeyed without violating restrictions; never required to pay an attack cost to obey a requirement | partial | `engine.ts:1765-1784, 1792-1811` enforces Goad (`CR 701.15b`) and `attacksEachCombat`. Bug: `engine.ts:1797-1810` requires a `mustAttack` creature to attack even when all opponents have a Propaganda/Ghostly Prison `attackTax`, forcing the player to pay the tax or fail declaration in violation of CR 508.1d. |
| 508.1e | Banding announcement | missing | Banding (CR 702.22) is not implemented. |
| 508.1f | Tap chosen attackers unless they have vigilance; tapping is not a cost | implemented | `engine.ts:1831-1833`. |
| 508.1g | Choose whether to pay optional attack costs | missing | Optional attack costs are not implemented. |
| 508.1h–j | Determine total cost to attack, mana ability window, and pay all attack costs | partial | `engine.ts:1786-1789, 1813-1822` sums generic `attackTax` via `getAttackTaxGeneric` (`runtime/replace.ts:300`) when attacking a player (not a planeswalker) and auto-pays via `payManaWithAutoTap`. Non-mana attack costs and manual mana-ability windows during attack declaration are not supported. |
| 508.1k | Chosen creatures become attacking creatures until removed from combat or combat ends | implemented | `engine.ts:1834-1845`. |
| 508.1m, 508.2, 508.2a, 508.2b | Attack triggers fire on declaration using characteristics at that moment, put on stack in APNAP order before active player gets priority | implemented | `engine.ts:1865-1878` emits `AttackDeclared` and calls `flushTriggers(state)`, matching characteristics synchronously (`runtime/triggers.ts:600-652`) and stacking in APNAP order (`runtime/triggers.ts:823-856`) before priority. |
| 508.3, 508.3a, 508.3d | Trigger conditions: "Whenever [creature] attacks" and "Whenever [player] attacks" | partial | `compiler/triggers.ts:161-163, 210, 441` and `runtime/triggers.ts:600-652` implement "Whenever [creature] attacks", "Whenever one or more [creatures] attack", and "Whenever you attack". Missing "Whenever [creature] attacks [a player/planeswalker/battle]" and "Whenever [an opponent/a player] attacks". |
| 508.3b, 508.3c, 508.3e, 508.3f | Trigger conditions: "Whenever [player/planeswalker] is attacked", "attacks with [creature]", "attacks [another player]", "attacks and isn't blocked" | missing | Not supported in `compiler/triggers.ts` or `runtime/triggers.ts`. |
| 508.4, 508.4a–e | Creatures put onto the battlefield attacking or stated to be attacking | missing | Not implemented in compiler or runtime. |
| 508.5, 508.5a | "Defending player" reference in abilities and spells | missing | `PlayerRef` (`ir.ts:247-254`) has no `'defendingPlayer'` variant. |
| 508.6 | "Attacking [a player]" and "attacked [a player]" definitions | partial | `state.combat.attackers` tracks `defenderPlayerId` during combat, but historical "attacked [a player] this turn" is not recorded after combat ends. |
| 508.7, 508.7a–e | Reselecting which player, planeswalker, or battle a creature is attacking | missing | Not implemented. |
| 508.8 | If no creatures are declared as attackers or put onto the battlefield attacking, skip declare blockers and combat damage steps | partial | `engine.ts:5912, 5922-5930` skips `declare_blockers` and `combat_damage` when 0 attackers are declared, but also skips `end_combat` directly to `main2`. |

### 509. Declare Blockers Step
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 509.1 | First, defending player(s) declare blockers as a turn-based action; illegal declaration rewinds | partial | `engine.ts:1882-2091` validates blocks atomically and steps through attacked defenders in turn order (`getAttackedDefenderIdsInTurnOrder`, `engine.ts:3083-3094`). However, `engine.ts:5913-5920` grants priority to the defending player upon entering `declare_blockers`, allowing defenders to cast instants/activate abilities before declaring blockers. |
| 509.1a | Chosen blockers must be controlled by defending player, untapped, creatures, not battles; each blocks one creature attacking that defender/planeswalker | partial | `engine.ts:1900-1934` validates control, not phased out, `isCreature`, untapped, single attacker per blocker, and `atkEntry.defenderPlayerId === actorId`. Missing effects that let a creature block multiple attackers, and battle check. |
| 509.1b | Check blocking restrictions and cumulative evasion abilities; gaining/losing evasion after block declared doesn't affect block | partial | `engine.ts:1918-1988` enforces `cantBlock`, `cantBeBlocked`, printed unblockable, `Flying`/`Reach`, `Protection`, and `Menace`. Missing other evasion keywords (`Fear`, `Intimidate`, `Shadow`, `Horsemanship`, `Skulk`, landwalk), conditional block restrictions, and one-shot "can't block this turn" effects. |
| 509.1c | Check blocking requirements; maximize requirements obeyed without violating restrictions; not required to pay block costs | partial | `engine.ts:1990-2030` checks `blocksEachCombat`. Bug: `engine.ts:2021` (`return !hasKeyword(atk, 'Menace', state)`) exempts a `blocksEachCombat` creature from blocking a Menace attacker even when a second potential blocker is available, failing the official CR 509.1c Example. Attacker "must be blocked if able" (Lure) requirements are also missing. |
| 509.1d–f | Determine total cost to block, mana ability window, and pay block costs | missing | No block cost/tax mechanics are implemented. |
| 509.1g | Chosen creatures become blocking creatures until removed from combat or combat ends | implemented | `engine.ts:2032-2041`. |
| 509.1h | Attacker with >=1 blocker becomes blocked; with 0 becomes unblocked; remains blocked even if all blockers are removed from combat | implemented | `engine.ts:2037-2039` sets `atkEntry.wasBlocked = true`; `engine.ts:6179-6187` checks `atkEntry.wasBlocked && blockers.length === 0` so a blocked attacker whose blockers left combat deals 0 damage without Trample. |
| 509.1i, 509.2, 509.2a | Block triggers fire on declaration, put on stack in APNAP order before active player gets priority | partial | `engine.ts:2062-2070, 2086` emits `BlockersDeclared`, flushes triggers, and gives priority to the active player after all defenders declare. In multiplayer with 2+ attacked defenders, `flushTriggers` at `engine.ts:2070` fires after each defender instead of waiting until all defenders have declared blockers. |
| 509.3, 509.3a, 509.3c, 509.3f | "Whenever [creature] blocks" (once per combat) and "Whenever [creature] becomes blocked" (once per combat), checked at declaration time | implemented | `compiler/triggers.ts:164-168, 395-396` and `runtime/triggers.ts:654-677` deduplicate `blocks` and `becomesBlocked` subjects and check characteristics synchronously. |
| 509.3b, 509.3d, 509.3e, 509.3g | "Whenever [creature] blocks a creature", "becomes blocked by a creature", N-blocker triggers, and "attacks and isn't blocked" | missing | Not supported in `compiler/triggers.ts` or `runtime/triggers.ts` (note also `BlockersDeclared` is not emitted when 0 blockers are declared at `engine.ts:2050-2073, 2099-2125`). |
| 509.4, 509.4a, 509.4b | Creatures put onto the battlefield blocking | missing | Not implemented. |

### 510. Combat Damage Step
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 510.1 | First, active player announces attacker combat damage assignment, then defending player announces blocker combat damage assignment | partial | `engine.ts:6007-6356` (`executeCombatDamageStep`) runs as a turn-based action at the start of the step (`engine.ts:3259-3263`), but never prompts players to choose how damage is divided among multiple blockers. |
| 510.1a | Each attacker and blocker assigns combat damage equal to its power; <= 0 power assigns no combat damage | implemented | `engine.ts:6095, 6320` checks `atkPower > 0` and `bPower > 0`. |
| 510.1b | Unblocked creature assigns damage to the player, planeswalker, or battle it's attacking; assigns 0 if what it was attacking left the battlefield | partial | `engine.ts:6104-6178`. Bug: if `atkEntry.defenderPlaneswalkerId` is non-null and `defWalker` left the battlefield or phased out, `if (defWalker)` is false and the code falls into `else`, dealing unblocked combat damage to `defPlayer` instead of assigning 0 combat damage. |
| 510.1c | Blocked creature assigns damage to its blockers (0 if all blockers left and no trample; divided as controller chooses among 2+ blockers) | partial | `engine.ts:6179-6227` handles 0 remaining blockers (`wasBlocked && blockers.length === 0 && !atkTrample` deals 0) and 1 blocker. For 2+ blockers, `engine.ts:6190-6227` auto-assigns lethal damage in `blockerInstanceIds` order without giving the controller a choice of division. |
| 510.1d | Blocking creature assigns damage to the creature(s) it's blocking (0 if attacker left combat) | implemented | `engine.ts:6071, 6308-6348` skips blockers whose attacker left the battlefield and assigns full power to the single blocked attacker. |
| 510.1e | Illegal combat damage assignment rewinds | N/A | Players are never prompted to submit manual combat damage assignments. |
| 510.2 | Second, all assigned combat damage is dealt simultaneously as a turn-based action | partial | `engine.ts:6012-6061` snapshots power, toughness, and keywords before dealing damage so simultaneous combat damage is not reduced by Infect `-1/-1` counters. However, `engine.ts:6095-6350` mutates life/damage/counters directly instead of calling `dealDamageToPermanent` / `dealDamageToPlayer` (`runtime/effects.ts:1121-1220`), bypassing Protection (`CR 702.16e`), shield counters (`CR 122.1c`), `damagePreventionShield`, Wither (`CR 702.80`), counter multipliers/`CounterPlaced` events on Infect `-1/-1` counters, and static `lifeTotalCantChange` rule modifiers. |
| 510.3, 510.3a | Third, active player gets priority after SBAs and combat-damage/SBA triggers are placed on the stack in APNAP order | implemented | `engine.ts:3259-3277, 5978` executes combat damage and `checkStateBasedActions` inside `withTriggersDeferred`, then flushes all triggers in APNAP order and gives priority to the active player. |
| 510.4 | First strike / double strike creates two combat damage steps; second step includes remaining creatures that didn't deal first-strike damage or currently have double strike | implemented | `engine.ts:5934-5947, 5983-6005, 6029-6034, 6075-6079, 6312-6316` tracks `dealtFirstStrikeDamageIds` and computes `dealsNow = isFirstStrikeStep ? hasFS \|\| hasDS : hasDS \|\| !alreadyDealtFS`. |

### 511. End of Combat Step
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 511.1 | End of combat step has no turn-based actions; active player gets priority | implemented | `engine.ts:5948-5952, 5978`. |
| 511.2 | "At end of combat" abilities trigger as step begins; "until end of combat" effects expire at end of combat phase | partial | `compiler/triggers.ts:257-259, 372` and `engine.ts:3271-3277` fire `phaseBegin('end_combat')` at the start of `end_combat`; "until end of combat" duration/expiry is missing (`ir.ts:332`). |
| 511.3 | As soon as end of combat step ends, all permanents are removed from combat and postcombat main phase begins | implemented | `engine.ts:5954-5963`. |

### 512. Ending Phase
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 512.1 | Ending phase consists of end step and cleanup step | implemented | `types.ts:26-27, 41-42`, `engine.ts:5965-5975`. |

### 513. End Step
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 513.1, 513.1a | End step has no turn-based actions; active player gets priority; "at the beginning of the end step" triggers | partial | `engine.ts:5416-5425, 3327-3330` enters `end_step`, flushes permanent triggers, and runs delayed end-step triggers. Partial because: (1) `end_turn` (`engine.ts:2172-2176`) immediately calls `runCleanupStep(state)` if the stack is empty after `enterEndStep`, denying all players priority in `end_step`; (2) `runDelayedEndStepTriggers` (`engine.ts:3189-3241, 3328-3329`) pushes delayed triggers after `flushTriggers` in array order rather than ordering them with permanent triggers in APNAP order. |
| 513.2 | End-step triggers on permanents entering during end step, or delayed end-step triggers created during end step, wait until next turn's end step | implemented | `PhaseBegin('end_step')` is emitted only once when entering `end_step` (`engine.ts:3271, 5421`), so permanents entering or delayed triggers created later in `end_step` do not trigger until the next `end_step`. |

### 514. Cleanup Step
| CR | Rule (short) | Status | Evidence / notes |
|---|---|---|---|
| 514.1 | First, active player discards down to maximum hand size as a turn-based action | implemented | `engine.ts:6377-6418, 2497-2526` checks `maxHandSize` and `noMaxHandSize` (`runtime/replace.ts:264`), prompting human players via `discard_to_hand_size` or discarding excess for bots via `moveObject`. |
| 514.2 | Second, simultaneously remove all damage marked on permanents (including phased-out) and end all "until end of turn" / "this turn" effects | partial | `engine.ts:6358-6371, 6426` (`clearEndOfTurnAndDamage`) clears `damageMarked`, `deathtouchDamageMarked`, `tempPowerMod`, `tempToughnessMod`, `grantedKeywords`, and `switchedPTCount` across all permanents (including phased-out). However, when a human player must discard to hand size (`engine.ts:6395`), `beginPhase(state, 'cleanup')` (`engine.ts:3263-3265`) runs `clearEndOfTurnAndDamage` BEFORE the player answers the `discard_to_hand_size` prompt (reversing 514.1 and 514.2). |
| 514.3, 514.3a | No priority in cleanup unless SBAs or triggers wait after 514.1/514.2; if so, perform SBAs, stack triggers, grant priority, and repeat cleanup when stack empties and all pass | implemented | `engine.ts:6428-6437` checks SBAs and flushes triggers; if `state.stack.length > 0 \|\| state.pendingPrompts.length > 0`, it stays in `cleanup` with active-player priority, and when all players pass on an empty stack (`engine.ts:5973-5975`), `advancePhaseOrStep` calls `runCleanupStep(state)` for another cleanup step. |

---

## Silently skipped / approximated behaviour
- **Multi-blocker combat damage division auto-assigned without player choice** (`engine.ts:6190-6227`): When an attacking creature is blocked by two or more creatures, the engine never prompts the attacking player to divide combat damage (CR 510.1c); it silently assigns lethal damage in `blockerInstanceIds` array order.
- **Unblocked/trample attacker whose planeswalker left combat damages the defending player instead of dealing 0** (`engine.ts:6098-6150, 6230-6293`): If a creature is declared attacking a planeswalker (`defenderPlaneswalkerId !== null`) and that planeswalker is destroyed, exiled, or phased out before combat damage, `defWalker` resolves to `undefined` and the code silently falls into the `else` branch, dealing the combat damage to the defending player in violation of CR 506.4c and CR 510.1b.
- **`end_turn` action skips intermediate steps/phases and end-step priority** (`engine.ts:2152-2184`): When the active player dispatches `end_turn`, the engine clears combat, jumps straight from the current phase (even `upkeep` before drawing a card, or mid-combat) to `enterEndStep`, and if no end-step triggers or prompts are pending (`engine.ts:2173-2176`), immediately runs `runCleanupStep`, never giving opponents priority in any intermediate step or in `end_step` (CR 500.2).
- **Turn 1 `upkeep` and `draw` priority silently skipped after mulligans** (`engine.ts:470-476`): `checkIfAllKeptMulligan` calls `runBeginningOfTurn(state)` and then immediately calls `advancePhaseOrStep(state)` twice if the stack is empty, skipping Turn 1 `upkeep` and `draw` priority without any player passing.
- **Off-turn human priority auto-passed on empty stack regardless of instants or `stopPhases`** (`ai.ts:191-206`, `engine.ts:1176-1180`): Unless `fullControl` is enabled, `runAutomatedPriorityAndBots` auto-passes priority for a human player on an opponent's turn whenever `state.stack.length === 0`, even if the human holds castable instants/flash spells or activatable abilities, and `priorityPlayer.stopPhases` is never read anywhere in `engine.ts` or `ai.ts`.
- **Attack taxes (`Propaganda` / `Ghostly Prison`) auto-paid via auto-tap without optional choice** (`engine.ts:1786-1789, 1813-1822`): Declaring attackers against a player with an `attackTax` automatically taps lands/mana sources via `payManaWithAutoTap`, and mandatory attackers (`Goad` / `attacksEachCombat`, `engine.ts:1797-1810`) are forced to attack into taxes even though CR 508.1d makes attack-cost payment optional for requirements.
- **Obeka "the player whose turn it is may end the turn" auto-accepted for controller** (`engine.ts:5102-5107`): `activePlayerMayEndTurn` immediately ends the turn without a `yesNo` prompt whenever `activePlayer.playerId === controller.playerId`.

---

## Legacy-only findings (verify after step F)
- **Additional land plays per turn (CR 505.6b)**: `checkLandPlayLegality` (`engine.ts:7887-7891`) computes `effectiveMaxLands` by calling `getCardExtraLandPlays` in `oracle.ts:121-139`. There is no IR static or `RuleModKind` in `compiler/statics.ts` / `ir.ts` for "You may play an additional land on each of your turns".
- **Per-spell combat/turn casting restrictions (CR 506.8, 506.8a, 506.8c)**: "Cast this spell only during combat", "Cast this spell only before attackers are declared", and "Cast this spell only during your turn" are parsed only by `parseAdditionalCostsAndRestrictions` in `oracle.ts:588-641` and checked in `engine.ts:7977-8008` (also referenced in `compiler/adapter.ts:696, 742-744`).
- **Printed unblockable check (CR 509.1b)**: `engine.ts:1954, 2007` still falls back to `cardHasPrintedUnblockable` (`oracle.ts:1990`) alongside `hasRestriction(state, atkCard, 'cantBeBlocked')`.
- **Legacy delayed end-step triggers (CR 513.1)**: `engine.ts:4092-4116` (`parseDelayedTriggersFromSpell` from `oracle.ts:1434`) and `engine.ts:5017-5033` (Corpse Dance in `executeParsedEffect`) still register delayed end-step triggers alongside the IR `delayedTrigger` interpreter (`runtime/effects.ts:1579-1621`).
