<script lang="ts">
	import { compileCard } from '../compiler/index.ts';
	import { cardAbilityDisplayText } from '../compiler/support.ts';
	import {
		checkAbilityActivationLegality,
		checkHandSpecialActionLegality,
		checkSpellCastLegality,
		checkUnlockRoomDoorLegality,
		getCastOptions,
		getEffectiveActivatedAbilities,
		getHandSpecialActions,
		getPlayerCommanderIdentity,
		getTurnFaceUpDisplay
	} from '../engine.ts';
	import ManaText from '../ManaText.svelte';
	import { instanceFaceOptions, resolveObjectFaces } from '../runtime/faces.ts';
	import { effectiveCardForObject } from '../scryfall.ts';
	import type {
		CardInstance,
		CastOption,
		EffectiveActivatedAbility,
		GameActionPayload,
		GameState,
		HandSpecialActionOption,
		PlayerGameState
	} from '../types.ts';

	interface UnlockableRoomDoor {
		faceIndex: number;
		name: string;
		manaCost: string;
		check: { ok: boolean; error?: string };
	}

	let {
		gameState,
		actor,
		inst,
		abilities: abilitiesProp,
		handSpecialActions: handSpecialActionsProp,
		onActivateAbility,
		onTurnFaceUp,
		onUnlockRoomDoor,
		onCastPreparationCopy,
		onHandSpecialAction,
		onGameAction,
		onHoverAbility,
		onClose
	}: {
		gameState: GameState;
		actor: PlayerGameState;
		inst: CardInstance;
		abilities?: EffectiveActivatedAbility[];
		handSpecialActions?: HandSpecialActionOption[];
		onActivateAbility: (
			inst: CardInstance,
			ability: EffectiveActivatedAbility
		) => void | Promise<void>;
		onTurnFaceUp?: (inst: CardInstance, choosesX: boolean) => void | Promise<void>;
		onUnlockRoomDoor?: (inst: CardInstance, faceIndex: number) => void | Promise<void>;
		onCastPreparationCopy?: (inst: CardInstance, option: CastOption) => void | Promise<void>;
		onHandSpecialAction?: (
			inst: CardInstance,
			action: HandSpecialActionOption
		) => void | Promise<void>;
		onGameAction?: (payload: GameActionPayload) => void | Promise<void>;
		onHoverAbility?: (ability: EffectiveActivatedAbility | null) => void;
		onClose: () => void;
	} = $props();

	let lastInstId = '';
	let minimized = $state(false);

	$effect.pre(() => {
		if (inst.instanceId !== lastInstId) {
			lastInstId = inst.instanceId;
			minimized = false;
		}
	});

	const effCard = $derived(effectiveCardForObject(inst));
	const view = $derived(resolveObjectFaces(effCard, instanceFaceOptions(inst, inst.zone)));
	const canInspectFaceDown = $derived(
		inst.controllerId === actor.playerId ||
			inst.ownerId === actor.playerId ||
			Boolean(inst.faceDownSpec?.knownToPlayerIds?.includes(actor.playerId))
	);
	const displayTitle = $derived(
		inst.isFaceDown ? inst.faceDownLabel || view.name || effCard.name : view.name || effCard.name
	);
	const rulesDisplayText = $derived(
		!inst.isFaceDown || canInspectFaceDown ? cardAbilityDisplayText(effCard) : ''
	);

	const turnUp = $derived(
		inst.zone === 'battlefield' ? getTurnFaceUpDisplay(gameState, actor.playerId, inst) : null
	);

	const unlockableDoors = $derived.by<UnlockableRoomDoor[]>(() => {
		if (inst.zone !== 'battlefield' || inst.isFaceDown) return [];
		const compiled = compileCard(effCard);
		if (compiled.faces.length < 2) return [];
		const out: UnlockableRoomDoor[] = [];
		for (let fi = 0; fi < compiled.faces.length; fi++) {
			const f = compiled.faces[fi];
			const isLockedRoom =
				f.characteristics.subtypes.includes('Room') && !(inst.unlockedFaces ?? []).includes(fi);
			if (!isLockedRoom) continue;
			out.push({
				faceIndex: fi,
				name: f.name,
				manaCost: f.characteristics.manaCost || '',
				check: checkUnlockRoomDoorLegality(gameState, actor.playerId, inst, fi)
			});
		}
		return out;
	});

	const preparationCopy = $derived.by<{
		faceName: string;
		manaCost: string;
		option: CastOption | null;
		check: { ok: boolean; error?: string };
	} | null>(() => {
		if (inst.zone !== 'battlefield' || inst.isFaceDown || !inst.isPrepared) return null;
		const baseCard = inst.copiableCard ?? inst.card;
		if ((baseCard.layout ?? 'normal') !== 'prepare') return null;
		const prepFace = compileCard(baseCard).faces[1];
		if (!prepFace) return null;
		const legalOption =
			getCastOptions(gameState, actor.playerId, inst, 'battlefield').find(
				(o) => o.permission === 'preparation_copy' || o.id === 'battlefield:prepare_copy'
			) ?? null;
		const check = legalOption
			? { ok: true }
			: checkSpellCastLegality(
					gameState,
					actor.playerId,
					inst,
					'battlefield',
					0,
					'battlefield:prepare_copy',
					undefined,
					1
				);
		return {
			faceName: prepFace.name,
			manaCost: prepFace.characteristics.manaCost || '{0}',
			option: legalOption,
			check
		};
	});

	const specialActions = $derived<HandSpecialActionOption[]>(
		handSpecialActionsProp ??
			(inst.zone === 'hand' ? getHandSpecialActions(gameState, actor.playerId, inst) : [])
	);

	const abilities = $derived.by<EffectiveActivatedAbility[]>(() => {
		if (abilitiesProp) return abilitiesProp;
		const cmdIdentity = getPlayerCommanderIdentity(actor);
		const all = getEffectiveActivatedAbilities(gameState, actor, inst, cmdIdentity);
		if (inst.zone === 'battlefield') return all;
		return all.filter((ab) => !ab.isManaAbility && Boolean(ab.activationZones?.includes(inst.zone)));
	});

	function clearHover() {
		onHoverAbility?.(null);
	}

	function handleClose() {
		clearHover();
		onClose();
	}
</script>

{#if minimized}
	<div class="modal-peek-bar" data-testid="ability-menu-peek-bar" role="region" aria-label="Minimized Ability Menu">
		<span class="peek-title">
			<strong>{displayTitle}</strong> — Actions
		</span>
		<div class="peek-actions">
			<button
				type="button"
				class="hud-btn active-ctrl"
				data-testid="restore-modal-btn"
				onclick={() => (minimized = false)}
			>
				👁 Return to Actions
			</button>
			<button type="button" class="hud-btn danger" onclick={handleClose}>
				Close
			</button>
		</div>
	</div>
{:else}
	<div class="modal-backdrop">
		<div class="arena-modal" role="dialog" aria-modal="true" aria-label="{displayTitle} Actions">
			<div class="modal-head-row">
				<h3>{displayTitle} — Actions</h3>
				<button
					type="button"
					class="hud-btn peek-btn"
					data-testid="peek-battlefield-btn"
					onclick={() => {
						clearHover();
						minimized = true;
					}}
				>
					👁 Peek Battlefield
				</button>
			</div>

			{#if rulesDisplayText}
				<div class="modal-desc">
					<ManaText text={rulesDisplayText} size={15} />
				</div>
			{/if}

			<div class="ability-list">
				{#if turnUp}
					<button
						type="button"
						class="ability-choice-btn"
						data-testid="turn-face-up-btn"
						disabled={!turnUp.legal}
						title={turnUp.error || `Turn ${canInspectFaceDown ? effCard.name : displayTitle} face up`}
						onclick={async () => {
							clearHover();
							const choosesX = Boolean(turnUp.choosesX);
							if (onTurnFaceUp) {
								await onTurnFaceUp(inst, choosesX);
								return;
							}
							if (!choosesX && onGameAction) {
								await onGameAction({
									type: 'turn_face_up',
									instanceId: inst.instanceId
								});
							}
						}}
					>
						Turn Face Up (<ManaText text={turnUp.costDisplay} size={14} />)
					</button>
				{/if}

				{#each unlockableDoors as door (door.faceIndex)}
					<button
						type="button"
						class="ability-choice-btn"
						data-testid="unlock-room-door-btn-{door.faceIndex}"
						disabled={!door.check.ok}
						title={door.check.error || `Unlock ${door.name}`}
						onclick={async () => {
							clearHover();
							if (onUnlockRoomDoor) {
								await onUnlockRoomDoor(inst, door.faceIndex);
								return;
							}
							if (onGameAction) {
								await onGameAction({
									type: 'unlock_room_door',
									instanceId: inst.instanceId,
									faceIndex: door.faceIndex
								});
							}
						}}
					>
						🚪 Unlock {door.name}
						{#if door.manaCost}
							(<ManaText text={door.manaCost} size={14} />)
						{/if}
					</button>
				{/each}

				{#if preparationCopy}
					<button
						type="button"
						class="ability-choice-btn"
						data-testid="cast-preparation-copy-btn"
						disabled={!preparationCopy.check.ok}
						title={preparationCopy.check.error || `Cast Preparation Copy (${preparationCopy.faceName})`}
						onclick={async () => {
							clearHover();
							if (preparationCopy.option && onCastPreparationCopy) {
								await onCastPreparationCopy(inst, preparationCopy.option);
								return;
							}
							if (onGameAction) {
								await onGameAction({
									type: 'cast_preparation_copy',
									instanceId: inst.instanceId
								});
							}
						}}
					>
						📖 Cast Preparation Copy ({preparationCopy.faceName}) (<ManaText
							text={preparationCopy.manaCost}
							size={14}
						/>)
					</button>
				{/if}

				{#each specialActions as sa (sa.id)}
					{@const saCheck = checkHandSpecialActionLegality(gameState, actor.playerId, inst, sa.id)}
					<button
						type="button"
						class="ability-choice-btn"
						data-testid="hand-special-action-btn-{sa.id}"
						disabled={!saCheck.ok}
						title={saCheck.error || sa.label}
						onclick={async () => {
							clearHover();
							if (onHandSpecialAction) {
								await onHandSpecialAction(inst, sa);
								return;
							}
							if (onGameAction) {
								await onGameAction({
									type: 'hand_special_action',
									instanceId: inst.instanceId,
									actionId: sa.id
								});
							}
						}}
					>
						✨ <ManaText text={sa.label} size={15} />
					</button>
				{/each}

				{#each abilities as ab (ab.id)}
					{@const abCheck = checkAbilityActivationLegality(
						gameState,
						actor.playerId,
						inst,
						ab
					)}
					<button
						type="button"
						class="ability-choice-btn"
						data-testid="ability-choice-btn-{ab.id}"
						disabled={!abCheck.ok}
						title={abCheck.error || ab.label}
						onmouseenter={() => onHoverAbility?.(ab)}
						onmouseleave={clearHover}
						onclick={async () => {
							clearHover();
							await onActivateAbility(inst, ab);
						}}
					>
						<ManaText text={ab.label} size={15} />
					</button>
				{/each}
			</div>

			<div class="modal-actions">
				<button type="button" class="hud-btn" onclick={handleClose}>
					Close
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(10, 8, 14, 0.78);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 200;
		padding: 1rem;
	}
	.arena-modal {
		background: var(--mp-bg-elevated);
		border: 1.5px solid var(--mp-accent);
		border-radius: 10px;
		padding: 1.15rem;
		max-width: 520px;
		width: 100%;
		max-height: 86vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.65);
	}
	.modal-head-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.65rem;
		flex-wrap: wrap;
	}
	.arena-modal h3 {
		margin: 0;
		color: var(--mp-accent);
	}
	.modal-desc {
		margin: 0;
		font-size: 0.8rem;
		color: var(--mp-text-body);
		white-space: pre-line;
	}
	.ability-list {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.ability-choice-btn {
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 6px;
		padding: 0.55rem 0.75rem;
		font-family: inherit;
		font-size: 0.78rem;
		text-align: left;
		cursor: pointer;
	}
	.ability-choice-btn:hover:not(:disabled) {
		border-color: var(--mp-accent);
	}
	.ability-choice-btn:disabled {
		opacity: 0.42;
		cursor: not-allowed;
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.modal-peek-bar {
		position: fixed;
		top: 0.65rem;
		left: 50%;
		transform: translateX(-50%);
		z-index: 205;
		display: flex;
		align-items: center;
		gap: 0.85rem;
		padding: 0.45rem 0.9rem;
		background: var(--mp-bg-elevated);
		border: 1.5px solid var(--mp-accent);
		border-radius: 999px;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
		font-size: 0.8rem;
		color: var(--mp-text);
	}
	.peek-title strong {
		color: var(--mp-accent);
	}
	.peek-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
	}
	.hud-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		background: var(--mp-bg);
		color: var(--mp-text);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		padding: 0.3rem 0.6rem;
		font-size: 0.76rem;
		font-family: inherit;
		cursor: pointer;
	}
	.hud-btn:hover:not(:disabled) {
		border-color: var(--mp-accent);
		color: var(--mp-accent);
	}
	.hud-btn.active-ctrl {
		border-color: var(--mp-accent);
		color: var(--mp-accent);
		font-weight: 700;
	}
	.hud-btn.danger:hover:not(:disabled) {
		border-color: var(--mp-red);
		color: var(--mp-red);
	}
	.hud-btn:disabled {
		opacity: 0.42;
		cursor: not-allowed;
	}
</style>
