<script lang="ts">
	import type {
		CombatAttackerForecast,
		CombatBlockerForecast,
		PlaneswalkerIncomingForecast
	} from '../engine.ts';
	import ManaSymbol from '../ManaSymbol.svelte';
	import type { CardInstance, ScryfallCard, TargetRef } from '../types.ts';
	import type { CounterBadgeEntry, PermanentView } from './boardViewModel.ts';

	interface Props {
		view: PermanentView;
		variant?: 'opponent' | 'front' | 'back';
		actable?: boolean;
		selectedTarget?: boolean;
		isAutoTapPreviewed?: boolean;
		draftAttacking?: boolean;
		draftBlocking?: boolean;
		attachmentLinked?: boolean;
		stackOffsetIndex?: number;
		attackerForecast?: CombatAttackerForecast;
		blockerForecast?: CombatBlockerForecast;
		planeswalkerForecast?: PlaneswalkerIncomingForecast;
		canAcceptDrop?: boolean;
		onHover?: (card: ScryfallCard, inst: CardInstance) => void;
		onLeave?: (card: ScryfallCard, inst: CardInstance) => void;
		onClick?: (perm: CardInstance) => void;
		onDropTarget?: (e: DragEvent, target: TargetRef) => void;
	}

	let {
		view,
		variant = 'front',
		actable,
		selectedTarget = false,
		isAutoTapPreviewed = false,
		draftAttacking = false,
		draftBlocking = false,
		attachmentLinked = false,
		stackOffsetIndex,
		attackerForecast,
		blockerForecast,
		planeswalkerForecast,
		canAcceptDrop = false,
		onHover,
		onLeave,
		onClick,
		onDropTarget
	}: Props = $props();

	const perm = $derived(view.perm);
	const disp = $derived(view.displayCard);
	const isMini = $derived(variant === 'opponent');
	const isCompact = $derived(variant === 'back');
	const effectiveActable = $derived(actable ?? view.actableSummary.isActable);

	const effectiveStackDepth = $derived(
		stackOffsetIndex ??
			Math.min(3, view.attachments.length + Math.max(0, view.mergedComponentNames.length - 1))
	);
	const compactChosenLabel = $derived(
		view.chosenDescriptor
			? view.chosenDescriptor.length > 12
				? `${view.chosenDescriptor.slice(0, 11)}…`
				: view.chosenDescriptor
			: null
	);

	function counterToneClass(entry: CounterBadgeEntry): string {
		switch (entry.badgeKind) {
			case 'plus':
				return 'green';
			case 'minus':
				return 'red';
			case 'keyword':
				return 'keyword';
			case 'loyalty':
				return 'purple';
			case 'defense':
				return 'gold';
			case 'lore':
				return 'gold';
			case 'charge':
				return 'cyan';
			case 'shield':
				return 'cyan';
			case 'stun':
				return 'amber';
			case 'time':
			case 'age':
				return 'purple';
			default:
				return 'neutral';
		}
	}

	const frozenTooltip = $derived(
		view.frozenBySourceNames.length > 0
			? `Doesn't untap while locked by ${view.frozenBySourceNames.join(', ')}`
			: "Doesn't untap during controller's next untap step"
	);

	const cantBlockAttackersTooltip = $derived(
		view.cantBlockAttackerNames.length > 0
			? `Can't block this turn: ${view.cantBlockAttackerNames.join(', ')}`
			: `Can't block ${view.cantBlockAttackerCount} creature(s) this turn`
	);

	const linkedExileTooltip = $derived(
		view.linkedExileCount > 0
			? `Linked exile (${view.linkedExileCount} — CR 607.2a): ${view.linkedExileLabels.join(', ')}`
			: ''
	);
</script>

<button
	type="button"
	class={isMini ? 'mini-card' : 'board-card'}
	class:compact={isCompact}
	class:tapped={perm.tapped}
	class:phased-out={perm.phasedOut}
	class:playable={!isMini && effectiveActable}
	class:unactable={!effectiveActable}
	class:selected-target={selectedTarget}
	class:auto-tap-preview={isAutoTapPreviewed}
	class:sick={view.isSummoningSickVisual}
	class:is-goaded={view.isGoaded}
	class:is-suspected={view.isSuspected}
	class:is-flipped={view.isFlipped}
	class:is-melded={view.meldedComponentNames.length > 0}
	class:is-merged={view.mergedComponentNames.length > 1}
	class:is-paired={view.pairedPartnerName !== null}
	class:is-mounted={view.isSaddled}
	class:is-ring-bearer={view.isRingBearer}
	class:is-prototyped={view.isPrototyped}
	class:is-stolen={view.isStolen}
	class:is-frozen={view.isFrozen}
	class:is-battle={view.isBattle}
	class:has-stack={effectiveStackDepth > 0}
	class:attacking={Boolean(attackerForecast)}
	class:blocking={Boolean(blockerForecast)}
	class:draft-atk={draftAttacking}
	class:draft-blk={draftBlocking}
	class:attachment-linked={attachmentLinked}
	style="--attach-depth: {effectiveStackDepth};"
	data-game-id={perm.instanceId}
	onmouseenter={() => onHover?.(disp.card, perm)}
	onmouseleave={() => onLeave?.(disp.card, perm)}
	onclick={() => onClick?.(perm)}
	ondragover={(e) => {
		if (canAcceptDrop) e.preventDefault();
	}}
	ondrop={(e) =>
		onDropTarget?.(e, {
			kind: 'permanent',
			id: perm.instanceId,
			label: disp.name
		})}
>
	<img src={disp.artCropUrl} alt={disp.name} loading="lazy" />

	{#if isAutoTapPreviewed}
		<span class="autotap-pill" title="Will be tapped automatically for mana">⚡ TAP</span>
	{/if}

	{#if isMini}
		{#if attackerForecast}
			<span class="combat-mini-banner atk" class:blocked={attackerForecast.isBlocked}>
				⚔️ ATK{#if attackerForecast.isBlocked} (BLK){/if}{#if attackerForecast.attackerDies} 💀{/if}
			</span>
		{:else if blockerForecast}
			<span class="combat-mini-banner blk">
				🛡️ BLK{#if blockerForecast.blockerDies} 💀{/if}
			</span>
		{/if}
		{#if planeswalkerForecast}
			<span class="pw-dmg-layover" class:lethal={planeswalkerForecast.willDie}>
				⚔️ -{planeswalkerForecast.loyaltyLoss} (L:{planeswalkerForecast.projectedLoyalty}){#if planeswalkerForecast.willDie} 💀{/if}
			</span>
		{/if}
		{#if view.host}
			<span class="attach-mini-tag" title="Attached to {view.host.card.name}">
				🔗→{view.host.card.name.split(',')[0]}
			</span>
		{:else if view.attachments.length > 0}
			<span
				class="attach-mini-tag host"
				title="Attached: {view.attachments.map((a) => a.card.name).join(', ')}"
			>
				🗡️×{view.attachments.length}
			</span>
		{/if}

		<div class="mini-badges-strip">
			{#if perm.phasedOut}
				<span class="badge purple">PH</span>
			{/if}
			{#if view.isRingBearer}
				<span
					class="badge gold ring-bearer"
					data-testid="ring-bearer-badge"
					title="Ring-bearer (CR 701.54)"
				>
					💍 RING
				</span>
			{/if}
			{#if view.isBattle && view.protectorName}
				<span
					class="badge amber"
					data-testid="battle-protector-badge"
					title="Battle Protector: {view.protectorName} (CR 310)"
				>
					🛡️ {view.protectorName}
				</span>
			{/if}
			{#if view.roomDoors.length >= 2}
				<span
					class="badge cyan"
					data-testid="room-doors-badge"
					title={view.roomDoors
						.map((d) => `${d.name} (${d.manaCost}): ${d.unlocked ? 'Unlocked' : 'Locked'}`)
						.join(' | ')}
				>
					🚪{view.roomDoors.map((d) => (d.unlocked ? '🔓' : '🔒')).join('')}
				</span>
			{/if}
			{#if view.isPrepared}
				<span
					class="badge cyan"
					data-testid="prepared-badge"
					title="Prepared (CR 723)"
				>
					📖 PREP
				</span>
			{/if}
			{#if view.classLevel !== null}
				<span
					class="badge gold"
					data-testid="class-level-badge"
					title="Class Level {view.classLevel} (CR 717)"
				>
					Lv.{view.classLevel}
				</span>
			{/if}
			{#if view.caseSolved !== null}
				<span
					class="badge {view.caseSolved ? 'green' : 'neutral'}"
					data-testid="case-status-badge"
					title="Case {view.caseSolved ? 'Solved' : 'Unsolved'} (CR 720)"
				>
					{view.caseSolved ? '✓ SOLVED' : 'UNSOLVED'}
				</span>
			{/if}
			{#if view.mergedComponentNames.length > 1}
				<span
					class="badge purple"
					data-testid="merged-stack-badge"
					title="Merged Stack (×{view.mergedComponentNames.length}, mutated {view.mutateCount}× — CR 731): {view.mergedComponentNames.join(' → ')}"
				>
					🧬×{view.mergedComponentNames.length}
				</span>
			{/if}
			{#if view.meldedComponentNames.length > 0}
				<span
					class="badge purple"
					data-testid="melded-badge"
					title="Melded Permanent (CR 713): {view.meldedComponentNames.join(' + ')}"
				>
					MELDED
				</span>
			{/if}
			{#if view.isFlipped}
				<span
					class="badge cyan"
					data-testid="flipped-badge"
					title="Flipped Permanent (CR 710)"
				>
					↻ FLIPPED
				</span>
			{/if}
			{#if view.pairedPartnerName !== null}
				<span
					class="badge cyan"
					data-testid="paired-badge"
					title="Paired with {view.pairedPartnerName} (CR 702.95)"
				>
					🔗 PAIRED
				</span>
			{/if}
			{#if view.hauntedByNames.length > 0}
				<span
					class="badge purple"
					data-testid="haunted-badge"
					title="Haunted by {view.hauntedByNames.join(', ')} (CR 702.55)"
				>
					👻 HAUNTED
				</span>
			{/if}
			{#if view.isSuspected}
				<span
					class="badge red"
					data-testid="suspected-badge"
					title="Suspected: has menace and can't block (CR 701.60)"
				>
					SUSPECTED
				</span>
			{/if}
			{#if view.isGoaded}
				<span
					class="badge red"
					data-testid="goaded-badge"
					title={view.goadedByNames.length > 0
						? `Goaded by ${view.goadedByNames.join(', ')} (CR 701.15)`
						: 'Goaded (CR 701.15)'}
				>
					GOADED
				</span>
			{/if}
			{#if view.isHarnessed}
				<span
					class="badge amber"
					data-testid="harnessed-badge"
					title="Harnessed: ∞ abilities active (CR 701.64)"
				>
					∞ HARNESSED
				</span>
			{/if}
			{#if view.isRenowned}
				<span
					class="badge gold"
					data-testid="renowned-badge"
					title="Renowned (CR 702.112)"
				>
					★ RENOWNED
				</span>
			{/if}
			{#if view.isPrototyped}
				<span
					class="badge cyan"
					data-testid="prototype-badge"
					title="Prototyped permanent (CR 719)"
				>
					⚙ PROTO
				</span>
			{/if}
			{#if view.regenerationShields > 0}
				<span
					class="badge green"
					data-testid="regen-shield-badge"
					title="Regeneration shields active: {view.regenerationShields} (CR 701.19)"
				>
					🛡 ×{view.regenerationShields}
				</span>
			{/if}
			{#if view.isFlagbearer}
				<span
					class="badge gold"
					data-testid="flagbearer-badge"
					title="Opponents must choose at least one Flagbearer target if able (CR 115.1)"
				>
					🚩 FLAG
				</span>
			{/if}
			{#if view.chosenDescriptor !== null && compactChosenLabel}
				<span
					class="badge purple"
					data-testid="chosen-descriptor-badge"
					title="Chosen value: {view.chosenDescriptor}"
				>
					🎯 {compactChosenLabel}
				</span>
			{/if}
			{#if view.isStolen}
				<span
					class="badge amber"
					data-testid="stolen-badge"
					title={view.ownerName
						? `Controlled by another player (Owner: ${view.ownerName})`
						: 'Controlled by another player'}
				>
					⇄
				</span>
			{/if}
			{#if view.isFrozen}
				<span
					class="badge cyan"
					data-testid="frozen-badge"
					title={frozenTooltip}
				>
					❄
				</span>
			{/if}
			{#if view.assimilatedBySourceName !== null}
				<span
					class="badge purple"
					data-testid="assimilated-badge"
					title="Assimilated by {view.assimilatedBySourceName} (CR 607.2)"
				>
					🧬
				</span>
			{/if}
			{#if view.mustAttackThisTurn}
				<span
					class="badge red"
					data-testid="must-attack-badge"
					title="Must attack this turn if able (CR 508.1d)"
				>
					⚔!
				</span>
			{/if}
			{#if view.mustBlockThisTurn}
				<span
					class="badge amber"
					data-testid="must-block-badge"
					title="Must block this turn if able (CR 509.1c)"
				>
					🛡!
				</span>
			{/if}
			{#if view.mustBeBlockedThisTurn}
				<span
					class="badge gold"
					data-testid="must-be-blocked-badge"
					title="Must be blocked this turn if able (CR 509.1c)"
				>
					🎯!
				</span>
			{/if}
			{#if view.assignsNoCombatDamageThisTurn}
				<span
					class="badge neutral"
					data-testid="no-combat-dmg-badge"
					title="Assigns no combat damage this turn (CR 510.1)"
				>
					0⚔
				</span>
			{/if}
			{#if view.cantBlockAttackerCount > 0}
				<span
					class="badge red"
					data-testid="cant-block-attacker-badge"
					title={cantBlockAttackersTooltip}
				>
					🚫🛡
				</span>
			{/if}
			{#if view.isMonstrous}
				<span
					class="badge green"
					data-testid="monstrous-badge"
					title="Monstrous permanent (CR 701.37)"
				>
					🦖 MONST
				</span>
			{/if}
			{#if view.linkedExileCount > 0}
				<span
					class="badge purple"
					data-testid="linked-exile-badge"
					title={linkedExileTooltip}
				>
					⛓️ {view.linkedExileCount}
				</span>
			{/if}
			{#if view.isSaddled}
				<span class="badge amber" title="Active mount bonus this turn">🐎</span>
			{/if}
			{#each view.countersList as ctr (ctr.type)}
				<span class="badge {counterToneClass(ctr)}" data-testid="counter-badge" title={ctr.description}>
					{ctr.shortLabel}
				</span>
			{/each}
		</div>

		<span class="mc-name">{disp.name}</span>

		{#if view.isCreature}
			<span class="pt-badge" class:damaged={perm.damageMarked > 0}>
				{view.power}/{view.displayToughness}
			</span>
		{/if}
	{:else}
		{#if attackerForecast}
			<div class="combat-card-banner atk-banner" class:blocked={attackerForecast.isBlocked}>
				<span>
					⚔️ ATK → {(attackerForecast.defenderPlaneswalkerName || attackerForecast.defenderName).split(',')[0]}
				</span>
				<span class="combat-sub">
					{#if attackerForecast.isBlocked}
						🛡️ Blocked ({attackerForecast.blockerIds.length}){#if attackerForecast.damageToDefender > 0} · 💥{attackerForecast.damageToDefender}{/if}
					{:else}
						🔥 {attackerForecast.damageToDefender || attackerForecast.poisonToDefender} Unblocked
					{/if}
					{#if attackerForecast.attackerDies} · 💀 DIES{/if}
				</span>
			</div>
		{:else if blockerForecast}
			<div class="combat-card-banner blk-banner">
				<span>🛡️ BLK → {blockerForecast.blockingAttackerName.split(',')[0]}</span>
				{#if blockerForecast.blockerDies}
					<span class="combat-sub">💀 DIES IN COMBAT</span>
				{/if}
			</div>
		{/if}

		{#if planeswalkerForecast}
			<div class="pw-dmg-layover" class:lethal={planeswalkerForecast.willDie}>
				⚔️ -{planeswalkerForecast.loyaltyLoss} LOYALTY (L:{planeswalkerForecast.currentLoyalty}→{planeswalkerForecast.projectedLoyalty})
				{#if planeswalkerForecast.willDie} 💀{/if}
			</div>
		{/if}

		{#if view.host}
			<div class="attached-items-strip on-attachment" title="Attached to {view.host.card.name}">
				<span class="attached-pill host-ref">
					🔗 → {view.host.card.name.split(',')[0]}
				</span>
			</div>
		{:else if view.attachments.length > 0}
			<div
				class="attached-items-strip"
				title="Attached: {view.attachments.map((a) => a.card.name).join(', ')}"
			>
				{#each view.attachments as att (att.instanceId)}
					<span class="attached-pill">
						{att.card.typeLine.includes('Equipment') ? '🗡️' : '✨'} {att.card.name.split(',')[0]}
					</span>
				{/each}
			</div>
		{/if}

		<div class="bc-overlay">
			<span class="bc-name">{disp.name}</span>
			<div class="bc-badges">
				{#if perm.phasedOut}<span class="badge purple">PHASED</span>{/if}
				{#if perm.isCommander}<span class="badge gold">CMD</span>{/if}
				{#if view.isRingBearer}
					<span
						class="badge gold ring-bearer"
						data-testid="ring-bearer-badge"
						title="Your Ring-bearer (CR 701.54)"
					>
						💍 RING
					</span>
				{/if}
				{#if view.isBattle && view.protectorName}
					<span
						class="badge amber"
						data-testid="battle-protector-badge"
						title="Protector: {view.protectorName} (CR 310.8b)"
					>
						🛡️ Prot: {view.protectorName}
					</span>
				{/if}
				{#if view.roomDoors.length >= 2}
					<span
						class="badge cyan"
						data-testid="room-doors-badge"
						title={view.roomDoors
							.map((d) => `${d.name} (${d.manaCost}): ${d.unlocked ? 'Unlocked' : 'Locked'}`)
							.join(' | ')}
					>
						🚪 {view.roomDoors.map((d) => (d.unlocked ? '🔓' : '🔒')).join('/')}
					</span>
				{/if}
				{#if view.isPrepared}
					<span
						class="badge cyan"
						data-testid="prepared-badge"
						title="Prepared (CR 723: may cast a copy of its preparation spell)"
					>
						📖 PREPARED
					</span>
				{/if}
				{#if view.classLevel !== null}
					<span
						class="badge gold"
						data-testid="class-level-badge"
						title="Class Level {view.classLevel} (CR 717)"
					>
						Lv. {view.classLevel}
					</span>
				{/if}
				{#if view.caseSolved !== null}
					<span
						class="badge {view.caseSolved ? 'green' : 'neutral'}"
						data-testid="case-status-badge"
						title="Case {view.caseSolved ? 'Solved' : 'Unsolved'} (CR 720)"
					>
						{view.caseSolved ? 'Solved' : 'Unsolved'}
					</span>
				{/if}
				{#if view.mergedComponentNames.length > 1}
					<span
						class="badge purple"
						data-testid="merged-stack-badge"
						title="Merged Stack (×{view.mergedComponentNames.length}, mutated {view.mutateCount}× — CR 731): {view.mergedComponentNames.join(' → ')}"
					>
						×{view.mergedComponentNames.length}
					</span>
				{/if}
				{#if view.meldedComponentNames.length > 0}
					<span
						class="badge purple"
						data-testid="melded-badge"
						title="Melded Permanent (CR 713): {view.meldedComponentNames.join(' + ')}"
					>
						Melded
					</span>
				{/if}
				{#if view.isFlipped}
					<span
						class="badge cyan"
						data-testid="flipped-badge"
						title="Flipped Permanent (CR 710)"
					>
						↻ Flipped
					</span>
				{/if}
				{#if view.pairedPartnerName !== null}
					<span
						class="badge cyan"
						data-testid="paired-badge"
						title="Paired with {view.pairedPartnerName} (CR 702.95)"
					>
						🔗 Paired
					</span>
				{/if}
				{#if view.hauntedByNames.length > 0}
					<span
						class="badge purple"
						data-testid="haunted-badge"
						title="Haunted by {view.hauntedByNames.join(', ')} (CR 702.55)"
					>
						👻 Haunted{view.hauntedByNames.length > 1 ? ` ×${view.hauntedByNames.length}` : ''}
					</span>
				{/if}
				{#if perm.isToken}<span class="badge cyan">TOK</span>{/if}
				{#if view.isSuspected}
					<span
						class="badge red"
						data-testid="suspected-badge"
						title="Suspected: has menace and can't block (CR 701.60)"
					>
						{isCompact ? 'SUSP' : 'Suspected'}
					</span>
				{/if}
				{#if view.isGoaded}
					<span
						class="badge red"
						data-testid="goaded-badge"
						title={view.goadedByNames.length > 0
							? `Goaded by ${view.goadedByNames.join(', ')} (CR 701.15)`
							: 'Goaded (CR 701.15)'}
					>
						Goaded
					</span>
				{/if}
				{#if view.isHarnessed}
					<span
						class="badge amber"
						data-testid="harnessed-badge"
						title="Harnessed: ∞ abilities active (CR 701.64)"
					>
						∞ {isCompact ? 'HARN' : 'Harnessed'}
					</span>
				{/if}
				{#if view.isRenowned}
					<span
						class="badge gold"
						data-testid="renowned-badge"
						title="Renowned (CR 702.112)"
					>
						★ {isCompact ? 'REN' : 'Renowned'}
					</span>
				{/if}
				{#if view.isPrototyped}
					<span
						class="badge cyan"
						data-testid="prototype-badge"
						title="Prototyped permanent (CR 719)"
					>
						{#if isCompact}⚙ PROTO{:else}⚙ Prototype{/if}
					</span>
				{/if}
				{#if view.regenerationShields > 0}
					<span
						class="badge green"
						data-testid="regen-shield-badge"
						title="Regeneration shields active: {view.regenerationShields} (CR 701.19)"
					>
						🛡 Regen ×{view.regenerationShields}
					</span>
				{/if}
				{#if view.isFlagbearer}
					<span
						class="badge gold"
						data-testid="flagbearer-badge"
						title="Opponents must choose at least one Flagbearer target if able (CR 115.1)"
					>
						{#if isCompact}🚩 FLAG{:else}🚩 Flagbearer{/if}
					</span>
				{/if}
				{#if view.chosenDescriptor !== null && compactChosenLabel}
					<span
						class="badge purple"
						data-testid="chosen-descriptor-badge"
						title="Chosen value: {view.chosenDescriptor}"
					>
						🎯 {compactChosenLabel}
					</span>
				{/if}
				{#if view.isStolen}
					<span
						class="badge amber"
						data-testid="stolen-badge"
						title={view.ownerName
							? `Controlled by another player (Owner: ${view.ownerName})`
							: 'Controlled by another player'}
					>
						⇄ {isCompact ? 'STL' : 'Stolen'}
					</span>
				{/if}
				{#if view.isFrozen}
					<span
						class="badge cyan"
						data-testid="frozen-badge"
						title={frozenTooltip}
					>
						❄ {isCompact ? 'FRZ' : 'Frozen'}
					</span>
				{/if}
				{#if view.assimilatedBySourceName !== null}
					<span
						class="badge purple"
						data-testid="assimilated-badge"
						title="Assimilated by {view.assimilatedBySourceName} (CR 607.2)"
					>
						🧬 {isCompact ? 'ASSIM' : 'Assimilated'}
					</span>
				{/if}
				{#if view.mustAttackThisTurn}
					<span
						class="badge red"
						data-testid="must-attack-badge"
						title="Must attack this turn if able (CR 508.1d)"
					>
						⚔ {isCompact ? 'ATK!' : 'Must Atk'}
					</span>
				{/if}
				{#if view.mustBlockThisTurn}
					<span
						class="badge amber"
						data-testid="must-block-badge"
						title="Must block this turn if able (CR 509.1c)"
					>
						🛡 {isCompact ? 'BLK!' : 'Must Blk'}
					</span>
				{/if}
				{#if view.mustBeBlockedThisTurn}
					<span
						class="badge gold"
						data-testid="must-be-blocked-badge"
						title="Must be blocked this turn if able (CR 509.1c)"
					>
						🎯 {isCompact ? 'LURE' : 'Must Block'}
					</span>
				{/if}
				{#if view.assignsNoCombatDamageThisTurn}
					<span
						class="badge neutral"
						data-testid="no-combat-dmg-badge"
						title="Assigns no combat damage this turn (CR 510.1)"
					>
						0⚔ {isCompact ? '0DMG' : 'No Dmg'}
					</span>
				{/if}
				{#if view.cantBlockAttackerCount > 0}
					<span
						class="badge red"
						data-testid="cant-block-attacker-badge"
						title={cantBlockAttackersTooltip}
					>
						🚫 {isCompact ? 'BLK' : `No Blk ×${view.cantBlockAttackerCount}`}
					</span>
				{/if}
				{#if view.isMonstrous}
					<span
						class="badge green"
						data-testid="monstrous-badge"
						title="Monstrous permanent (CR 701.37)"
					>
						🦖 {isCompact ? 'MONST' : 'Monstrous'}
					</span>
				{/if}
				{#if view.linkedExileCount > 0}
					<span
						class="badge purple"
						data-testid="linked-exile-badge"
						title={linkedExileTooltip}
					>
						⛓️ {view.linkedExileCount}
					</span>
				{/if}
				{#if view.isSaddled}
					<span class="badge amber" title="Active mount bonus this turn">🐎 MOUNTED</span>
				{/if}
				{#if view.isSummoningSickVisual}
					<span class="badge neutral" title="Summoning sickness">💤</span>
				{/if}
				{#if perm.tapped}
					<span class="tapped-icon"><ManaSymbol symbol="T" size={isCompact ? 14 : 15} /></span>
				{/if}
				{#each view.countersList as ctr (ctr.type)}
					<span class="badge {counterToneClass(ctr)}" data-testid="counter-badge" title={ctr.description}>
						{isCompact ? ctr.shortLabel : ctr.label}
					</span>
				{/each}
			</div>
			{#if view.isCreature}
				<span class="bc-pt" class:damaged={perm.damageMarked > 0}>
					{view.power}/{view.displayToughness}
				</span>
			{/if}
		</div>
	{/if}
</button>

<style>
	.board-card {
		position: relative;
		width: 104px;
		height: 78px;
		border-radius: 6px;
		border: 1.5px solid var(--mp-border-strong);
		background: var(--mp-bg);
		padding: 0;
		overflow: hidden;
		cursor: pointer;
		transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
	}
	.board-card.compact {
		width: 84px;
		height: 64px;
	}
	.board-card.has-stack {
		margin-top: calc(var(--attach-depth, 0) * 3px);
		margin-left: calc(var(--attach-depth, 0) * 2px);
		box-shadow:
			-3px -3px 0 -1px rgba(171, 157, 242, 0.55),
			-5px -5px 0 -2px rgba(25, 22, 34, 0.85);
	}
	.board-card:hover {
		transform: translateY(-3px) scale(1.03);
		border-color: var(--mp-cyan);
		z-index: 10;
	}
	.board-card.tapped {
		transform: rotate(14deg) scale(0.94);
		opacity: 0.8;
	}
	.board-card.playable {
		border-color: var(--mp-cyan);
		box-shadow: 0 0 10px rgba(120, 220, 232, 0.45);
	}
	.board-card.sick {
		border-style: dashed;
	}
	.board-card.draft-atk {
		border-color: var(--mp-red);
		box-shadow: 0 0 12px var(--mp-red);
	}
	.board-card.draft-blk {
		border-color: var(--mp-cyan);
		box-shadow: 0 0 12px var(--mp-cyan);
	}
	.board-card img,
	.mini-card img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.mini-card {
		position: relative;
		width: 66px;
		height: 50px;
		border-radius: 5px;
		border: 1px solid var(--mp-border-strong);
		background: var(--mp-bg);
		padding: 0;
		overflow: hidden;
		cursor: pointer;
		transition: transform 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
	}
	.mini-card.has-stack {
		margin-top: calc(var(--attach-depth, 0) * 2px);
		box-shadow: -2px -2px 0 rgba(171, 157, 242, 0.55);
	}
	.mini-card.tapped {
		transform: rotate(14deg);
		opacity: 0.78;
	}

	/* Auto-tap hover preview amber pulse outline */
	.board-card.auto-tap-preview,
	.mini-card.auto-tap-preview {
		border-color: #f59e0b !important;
		outline: 2px solid #ffd866;
		outline-offset: 1px;
		animation: autotap-amber-pulse 1.05s ease-in-out infinite;
		z-index: 9;
	}
	@keyframes autotap-amber-pulse {
		0%,
		100% {
			box-shadow: 0 0 8px rgba(245, 158, 11, 0.65), inset 0 0 8px rgba(255, 216, 102, 0.3);
		}
		50% {
			box-shadow: 0 0 18px rgba(255, 216, 102, 0.95), inset 0 0 14px rgba(245, 158, 11, 0.52);
		}
	}
	.autotap-pill {
		position: absolute;
		top: 2px;
		right: 2px;
		z-index: 8;
		background: #f59e0b;
		color: #19181a;
		border: 1px solid #ffd866;
		border-radius: 3px;
		padding: 0 4px;
		font-size: 0.52rem;
		font-weight: 800;
		letter-spacing: 0.03em;
		pointer-events: none;
	}

	.board-card.unactable::after,
	.mini-card.unactable::after {
		content: '';
		position: absolute;
		inset: 0;
		background: linear-gradient(180deg, rgba(6, 5, 10, 0.52) 0%, rgba(8, 7, 14, 0.58) 100%);
		box-shadow: inset 0 0 12px rgba(0, 0, 0, 0.55);
		border-radius: inherit;
		pointer-events: none;
		z-index: 4;
		transition: opacity 0.14s ease;
	}
	.board-card.auto-tap-preview.unactable::after,
	.mini-card.auto-tap-preview.unactable::after {
		opacity: 0.15;
	}
	.board-card.unactable:hover::after,
	.mini-card.unactable:hover::after {
		opacity: 0.2;
	}

	.board-card.phased-out,
	.mini-card.phased-out {
		opacity: 0.42;
		filter: saturate(0.25) contrast(0.9);
		border-style: dashed;
	}
	.board-card.selected-target,
	.mini-card.selected-target {
		border-color: #ffd866;
		box-shadow: 0 0 12px rgba(255, 216, 102, 0.55);
	}
	.board-card.attachment-linked,
	.mini-card.attachment-linked {
		border-color: var(--mp-purple) !important;
		box-shadow: 0 0 14px rgba(171, 157, 242, 0.85) !important;
	}
	.board-card.attacking,
	.mini-card.attacking {
		border-color: var(--mp-red) !important;
		box-shadow: 0 0 14px rgba(255, 97, 136, 0.82);
	}
	.board-card.blocking,
	.mini-card.blocking {
		border-color: var(--mp-cyan) !important;
		box-shadow: 0 0 12px rgba(120, 220, 232, 0.78);
	}

	.bc-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		padding: 3px 4px;
		background: linear-gradient(
			180deg,
			rgba(0, 0, 0, 0.6) 0%,
			transparent 45%,
			rgba(0, 0, 0, 0.82) 100%
		);
	}
	.bc-name {
		font-size: 0.62rem;
		font-weight: 600;
		color: #fcfcfa;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.tapped-icon {
		display: inline-flex;
		align-items: center;
	}
	.bc-badges {
		display: flex;
		align-items: center;
		gap: 2px;
		flex-wrap: wrap;
	}
	.mini-badges-strip {
		position: absolute;
		top: 2px;
		left: 2px;
		z-index: 5;
		display: flex;
		flex-wrap: wrap;
		gap: 1px;
		max-width: calc(100% - 26px);
		pointer-events: none;
	}
	.badge {
		font-size: 0.52rem;
		font-weight: 700;
		padding: 1px 3px;
		border-radius: 3px;
		line-height: 1.15;
	}
	.badge.gold {
		background: #ffd866;
		color: #19181a;
	}
	.badge.amber {
		background: #f59e0b;
		color: #19181a;
	}
	.badge.cyan {
		background: #78dce8;
		color: #19181a;
	}
	.badge.keyword {
		background: #38bdf8;
		color: #0f172a;
	}
	.badge.green {
		background: #a9dc76;
		color: #19181a;
	}
	.badge.purple {
		background: #ab9df2;
		color: #19181a;
	}
	.badge.red {
		background: #ff6188;
		color: #19181a;
	}
	.badge.neutral {
		background: rgba(25, 24, 26, 0.9);
		color: #fcfcfa;
		border: 1px solid rgba(252, 252, 250, 0.35);
	}

	.bc-pt {
		align-self: flex-end;
		background: #141218;
		border: 1px solid #ffd866;
		color: #fcfcfa;
		font-size: 0.66rem;
		font-weight: 700;
		padding: 0 4px;
		border-radius: 3px;
	}
	.bc-pt.damaged,
	.pt-badge.damaged {
		border-color: #ff6188;
		color: #ff6188;
	}

	.mc-name {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		background: rgba(15, 13, 18, 0.85);
		color: #fcfcfa;
		font-size: 0.54rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		padding: 1px 3px;
	}
	.pt-badge {
		position: absolute;
		top: 2px;
		right: 2px;
		z-index: 5;
		background: #19181a;
		border: 1px solid #78dce8;
		color: #fcfcfa;
		font-size: 0.58rem;
		font-weight: 700;
		padding: 0 3px;
		border-radius: 3px;
	}

	.attached-items-strip {
		position: absolute;
		top: 2px;
		left: 2px;
		right: 2px;
		z-index: 5;
		display: flex;
		flex-direction: column;
		gap: 1px;
		pointer-events: none;
	}
	.attached-pill {
		display: inline-block;
		max-width: 100%;
		background: rgba(25, 22, 34, 0.92);
		color: #ab9df2;
		border: 1px solid rgba(171, 157, 242, 0.75);
		border-radius: 3px;
		padding: 1px 4px;
		font-size: 0.54rem;
		font-weight: 700;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-align: left;
	}
	.attached-pill.host-ref {
		color: #78dce8;
		border-color: rgba(120, 220, 232, 0.8);
	}
	.attach-mini-tag {
		position: absolute;
		bottom: 13px;
		left: 2px;
		right: 2px;
		z-index: 5;
		background: rgba(25, 22, 34, 0.92);
		color: #78dce8;
		border: 1px solid rgba(120, 220, 232, 0.75);
		border-radius: 3px;
		padding: 0 3px;
		font-size: 0.48rem;
		font-weight: 700;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.attach-mini-tag.host {
		color: #ab9df2;
		border-color: rgba(171, 157, 242, 0.75);
		right: auto;
	}

	.combat-card-banner {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		z-index: 6;
		display: flex;
		flex-direction: column;
		padding: 2px 4px;
		font-size: 0.55rem;
		font-weight: 800;
		line-height: 1.15;
		text-align: left;
		pointer-events: none;
	}
	.combat-card-banner.atk-banner {
		background: linear-gradient(90deg, rgba(255, 97, 136, 0.94), rgba(190, 45, 82, 0.92));
		color: #fff;
		border-bottom: 1px solid #ffd866;
	}
	.combat-card-banner.atk-banner.blocked {
		background: linear-gradient(90deg, rgba(252, 152, 103, 0.94), rgba(185, 92, 48, 0.92));
	}
	.combat-card-banner.blk-banner {
		background: linear-gradient(90deg, rgba(120, 220, 232, 0.94), rgba(45, 138, 156, 0.92));
		color: #19181a;
		border-bottom: 1px solid #fff;
	}
	.combat-sub {
		font-size: 0.5rem;
		font-weight: 700;
		opacity: 0.95;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.combat-mini-banner {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		z-index: 6;
		font-size: 0.5rem;
		font-weight: 800;
		padding: 1px 3px;
		text-align: center;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		pointer-events: none;
	}
	.combat-mini-banner.atk {
		background: rgba(255, 97, 136, 0.94);
		color: #fff;
	}
	.combat-mini-banner.atk.blocked {
		background: rgba(252, 152, 103, 0.94);
		color: #19181a;
	}
	.combat-mini-banner.blk {
		background: rgba(120, 220, 232, 0.94);
		color: #19181a;
	}
	.board-card.is-ring-bearer,
	.mini-card.is-ring-bearer {
		border-color: #ffd866;
		box-shadow: 0 0 8px rgba(255, 216, 102, 0.55);
	}
	.board-card.is-flipped,
	.mini-card.is-flipped {
		border-color: #78dce8;
		box-shadow: inset 0 -2px 0 #78dce8;
	}
	.board-card.is-melded,
	.mini-card.is-melded {
		border-color: #ab9df2;
		box-shadow: 0 0 8px rgba(171, 157, 242, 0.45);
	}
	.board-card.is-paired,
	.mini-card.is-paired {
		border-color: rgba(120, 220, 232, 0.85);
	}
	.board-card.is-suspected,
	.mini-card.is-suspected {
		border-color: rgba(255, 97, 136, 0.78);
	}
	.board-card.is-prototyped,
	.mini-card.is-prototyped {
		border-color: rgba(120, 220, 232, 0.85);
		box-shadow: inset 0 0 6px rgba(120, 220, 232, 0.35);
	}
	.board-card.is-stolen,
	.mini-card.is-stolen {
		border-color: rgba(245, 158, 11, 0.82);
	}
	.board-card.is-frozen,
	.mini-card.is-frozen {
		border-color: rgba(120, 220, 232, 0.68);
	}
	.badge.ring-bearer {
		box-shadow: 0 0 6px rgba(255, 216, 102, 0.7);
	}
	.pw-dmg-layover {
		position: absolute;
		top: 2px;
		left: 2px;
		right: 2px;
		z-index: 7;
		background: rgba(255, 97, 136, 0.92);
		color: #fff;
		border: 1px solid #ffd866;
		border-radius: 3px;
		padding: 1px 4px;
		font-size: 0.54rem;
		font-weight: 800;
		text-align: center;
		pointer-events: none;
	}
	.pw-dmg-layover.lethal {
		background: #ff2e63;
		box-shadow: 0 0 8px #ff2e63;
	}
</style>
