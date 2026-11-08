## 1. Layers and continuous effects

These are among the hardest rules to implement correctly because the order in which effects are applied can change the final game state.

1\. Layer system (CR 613) – Continuous effects are applied in a specific sequence of layers and sublayers, rather than simply in timestamp order.

- Example: One effect makes a creature lose all abilities, while another grants it flying. The result depends on which layer each effect operates in.
- Challenge: The engine needs a dependency-aware effect evaluation system, not just a list of modifiers.

2\. Dependency between continuous effects – One continuous effect can change how another effect applies.

- Challenge: The engine must detect dependencies and potentially reevaluate effects in a different order.

3\. Humility interactions – Humility makes creatures lose all abilities and become 1/1s, creating notoriously complicated interactions with other cards.

- Challenge: Type-changing, ability-removing, and power/toughness-setting effects must be evaluated in the correct layers.

4\. Power/toughness switching – Effects like Inside Out switch a creature's power and toughness.

- Challenge: Switching is applied in a later sublayer than setting power and toughness, and can interact unexpectedly with counters and other modifications.

## 2. State-based actions and timing

5\. State-based actions are checked repeatedly – They are not simply checked once at the end of a turn or after a spell resolves.

- Example: A creature with lethal damage dies; its controller may then lose the game for having zero life; the game checks again as necessary.
- Challenge: The engine needs an iterative state-based-action loop.

6\. Legend rule – If a player controls multiple legendary permanents with the same name, they choose one and put the others into their owners' graveyards.

- Challenge: This isn't destruction or sacrifice, and replacement effects can interact with the zone change.

7\. Zero-toughness creatures – A creature with toughness 0 or less is put into its owner's graveyard as a state-based action, rather than being destroyed.

- Challenge: Indestructible does not save it.

8\. Damage and toughness changes – Damage marked on a creature can become lethal when its toughness is reduced.

- Challenge: An engine must distinguish damage from toughness reduction and reevaluate state-based actions after either changes.

9\. Simultaneous state-based actions – Multiple state-based actions can happen at the same time.

- Challenge: The engine must determine the full set of applicable actions before applying them, rather than processing them as unrelated sequential events.

## 3. Replacement and prevention effects

10\. Replacement effect ordering – If multiple replacement effects attempt to modify the same event, the affected player or object's controller chooses the order in which applicable effects are applied.

- Example: A creature would enter the battlefield with counters, but another effect modifies how many counters it receives.
- Challenge: The engine cannot simply apply replacement effects in a fixed global order.

11\. Replacement effects replacing themselves – A replacement effect can modify an event in a way that causes another replacement effect to become applicable.

\- Challenge: The engine must repeatedly evaluate applicable replacement effects without accidentally applying the same effect twice.

12\. "Instead" versus triggered abilities – Replacement effects modify an event before it happens, while triggered abilities react after an event occurs.

- Example: "If a creature would die, exile it instead" versus "Whenever a creature dies, draw a card."
- Challenge: The engine must distinguish events that actually happen from events that were replaced.

13\. Multiple damage prevention effects – Several effects can prevent or redirect damage, potentially interacting with one another.

\- Challenge: Damage isn't necessarily a single atomic operation. It can be divided, prevented, redirected, and modified.

14\. Entering the battlefield replacement effects – Some permanents enter with counters, tapped, transformed, or under different conditions depending on replacement effects.

\- Challenge: The engine must process these modifications before the permanent actually enters the battlefield, while also handling enter-the-battlefield triggers correctly.

## 4. Copying and object identity

15\. Copying copies – A copy of a copy generally copies the copiable values of the original object, not necessarily every modification currently affecting it.

\- Challenge: The engine must distinguish copiable values from counters, modifications, and other effects.

16\. Copying a transformed permanent – Copy effects generally copy the copiable characteristics of the face that's currently up, with exceptions for certain characteristics.

\- Challenge: The engine must understand double-faced cards and distinguish their front-face and back-face characteristics.

17\. Copying spells on the stack – A copy of a spell copies its modes, targets, choices, and other relevant characteristics, but certain choices can be changed.

\- Challenge: A spell cannot be represented merely as a reference to its original card. It needs a complete representation of its stack characteristics.

18\. Copiable values versus noncopiable values – Counters, damage, tapped status, and most continuous effects aren't copied.

\- Challenge: The engine needs a separate representation of an object's base characteristics and its current evaluated characteristics.

19\. Token copies – If a token copies a permanent, it copies its copiable values, but it remains a token.

\- Challenge: The engine must distinguish the characteristics of an object from its underlying object type and origin.

20\. Copying a permanent that is copying something else – Layer interactions can cause the final characteristics of a copy to differ substantially from what the copied object currently looks like.

\- Challenge: Copy effects must be evaluated in the appropriate layer, not by taking a snapshot of the displayed characteristics.

## 5. Triggered abilities and the stack

21\. APNAP ordering – When multiple players have triggered abilities waiting to go on the stack, the active player puts theirs on first, followed by each nonactive player in turn order.

\- Challenge: The stack ordering depends on turn order, not simply the order in which triggers were detected.

22\. Triggers triggering other triggers – A single event can cause many abilities to trigger, and resolving one ability can cause additional triggers.

\- Challenge: The engine must correctly collect, order, and place triggers on the stack at the appropriate times.

23\. Intervening-if clauses – An ability with an intervening-if condition checks that condition both when it would trigger and when it resolves.

\- Challenge: The engine cannot simply check the condition once.

24\. Triggered abilities that trigger on casting – A spell can trigger an ability when cast, even if the spell is subsequently countered.

\- Challenge: Casting and resolving are separate events.

25\. Delayed triggered abilities – Some effects create triggers that happen at a future point, potentially long after the original spell or ability resolves.

\- Challenge: The engine needs persistent, event-driven triggers that survive the resolution of their originating effects.

26\. Missed triggers – In tournament play, players can fail to acknowledge triggered abilities. The rules for handling missed triggers are not equivalent to automatically executing every trigger.

\- Challenge: A tournament engine needs a concept of player acknowledgment and policy enforcement, not just rules execution.

## 6. Combat rules

27\. Damage assignment order – When a creature blocks multiple creatures, or is blocked by multiple creatures, damage assignment must follow the established damage assignment order.

\- Challenge: Damage cannot always be distributed arbitrarily.

28\. First strike and double strike – Combat damage can occur in two separate damage steps.

\- Challenge: The engine must reevaluate the battlefield between the two steps, including checking state-based actions and triggers.

29\. Creatures leaving combat – A creature removed from combat may no longer assign or receive combat damage, depending on when and how it leaves.

\- Challenge: Combat participants and damage assignment must be tracked independently of battlefield presence.

30\. Trample and deathtouch – A creature with trample and deathtouch generally only needs to assign 1 damage to each creature blocking it to assign the remainder to the defending player or planeswalker.

\- Challenge: The engine must account for lethal damage calculations that depend on abilities, rather than simply comparing power and toughness.

31\. Attack requirements and restrictions – Some effects require creatures to attack, while others prohibit certain creatures from attacking.

\- Challenge: The engine must determine whether an attack declaration is legal across the entire set of attacking creatures, rather than checking each creature independently.

32\. Attacking multiple opponents – In multiplayer games, attacking creatures can have different defending players or planeswalkers.

\- Challenge: Combat isn't necessarily a single attacker-versus-defender relationship.

## 7. Weird zone and turn mechanics

33\. Phasing – A permanent that phases out doesn't leave the battlefield. It effectively becomes treated as though it doesn't exist for most game purposes, while retaining its identity and attachments.

\- Challenge: Phasing is not a zone change, so ordinary leave-the-battlefield and enter-the-battlefield logic must not execute.

34\. Face-down permanents – Face-down creatures generally have characteristics that are independent of their actual card identity.

\- Challenge: The engine must maintain hidden underlying card data while exposing only the permitted characteristics to opponents.

35\. Morph and manifest – These mechanics allow cards to be cast or turned face up under specific conditions, sometimes without paying their mana costs.

\- Challenge: The engine must handle face-down status, alternative costs, and face-up transition triggers.

36\. Adventure cards – An Adventure spell can be cast as an instant or sorcery, then exile itself and potentially be cast later as a creature.

\- Challenge: One physical card can represent multiple spell characteristics and change how it can be cast depending on its zone.

37\. Split cards – Split cards have different characteristics in different zones and when cast, depending on the applicable rules.

\- Challenge: The engine must understand that the same card can have different mana values and characteristics in different contexts.

38\. Commander replacement effects – A commander that would go to certain zones, such as a graveyard or exile, can instead be moved to the command zone.

\- Challenge: This is a replacement effect, not a triggered ability, and the player makes the choice as the event occurs.

39\. Extra turns and skipped turns – Effects can grant additional turns, skip phases, or cause players to take turns in unusual orders.

\- Challenge: The engine needs a flexible turn scheduler rather than a fixed sequence of turns.

40\. Taking control of another player's turn – Some cards allow one player to make decisions for another player during their turn.

\- Challenge: The engine must distinguish the player who owns an object, controls it, and is currently making decisions.

## 8. Rules that modify the rules

These are particularly interesting for an engine because they effectively modify the game's own execution model.

41\. "You may play cards as though they had flash" – An effect changes when a player is allowed to play a card.

\- Challenge: Timing legality must be dynamically evaluated rather than hardcoded into card types.

42\. "Players can't cast spells" – Effects can prohibit actions that would otherwise be legal.

\- Challenge: The engine needs a centralized legality-checking system for actions.

43\. "You can't lose the game" – An effect can prevent a player from losing, even when a normal loss condition occurs.

\- Challenge: The engine must distinguish between a loss condition being satisfied and the game actually ending.

44\. "You win the game" – Some cards create alternative win conditions that can happen independently of reducing an opponent to zero life.

\- Challenge: Win conditions must be extensible and evaluated alongside ordinary loss conditions.

45\. Effects that change the starting life total – Some cards modify players' starting life totals or starting conditions.

\- Challenge: Game initialization itself must be configurable.

46\. Extra copies of the legend rule or other rule-modifying effects – Effects can change how normally universal rules operate.

\- Challenge: The engine must avoid embedding fundamental game rules as immutable assumptions.

47\. Ante and subgames – Certain cards can create subgames or involve cards being set aside as ante.

\- Challenge: These mechanics require nested game states and potentially unusual card ownership and zone handling.

## 9. Particularly good stress tests for an MTG engine

If you're developing an engine and want to test its architecture, I'd prioritize these interactions:

| Test                                  | What it tests                                |
| ------------------------------------- | -------------------------------------------- |
| Humility + Opalescence                | Layer dependencies and type-changing effects |
| Humility + Elesh Norn                 | Layer ordering and ability removal           |
| Blood Moon + Urborg                   | Dependency between continuous effects        |
| Clone + counters + anthem             | Copiable versus modified characteristics     |
| First strike + deathtouch + trample   | Combat damage assignment                     |
| Multiple simultaneous death triggers  | APNAP ordering and trigger collection        |
| Rest in Peace + replacement effects   | Zone changes and replacement ordering        |
| Phasing + attached Equipment          | Object identity and attachment handling      |
| Split cards + alternate casting costs | Context-dependent characteristics            |
| Commander + graveyard replacement     | Zone-change replacement effects              |

## 10. Architectural recommendations

If the goal is to build an engine that can handle the full ruleset, I'd avoid implementing cards as simple collections of callbacks.

Instead, I'd build around these abstractions:

1. Game objects: Cards, tokens, copies, spells, abilities, and their identities.
2. Zones: Battlefield, stack, hand, library, graveyard, exile, command zone, etc.
3. Events: Casting, resolving, entering, leaving, attacking, dealing damage, and so on.
4. Replacement effects: Intercept and modify events before they occur.
5. Triggered abilities: Listen for events and create stack objects.
6. Continuous effects: Dynamically evaluate characteristics through the layer system.
7. State-based actions: Repeatedly check and apply automatic game-state corrections.
8. Action legality: Centralize checks for whether an action is permitted.
9. Priority and turn structure: Model priority passes, phases, steps, and stack resolution explicitly.

The most important architectural decision is to separate an object's underlying characteristics from its currently evaluated characteristics. That distinction is essential for layers, copy effects, face-down cards, and almost every complicated interaction in Magic.