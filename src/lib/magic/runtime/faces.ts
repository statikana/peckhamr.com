/**
 * Zone-aware object and face resolution (ENGINE_ARCHITECTURE_PLAN.md §2.14, CR 707–712, 708, 716).
 *
 * Resolves which face(s) and copiable characteristics apply for an object given its layout, zone,
 * active face index, unlocked designations, copy state (Layer 1a), and face-down status (Layer 1b).
 */
import { compileCard } from '../compiler/index.ts';
import { getKeywordSpec } from '../keywords.ts';
import type { AbilityDef, Characteristics, FaceDefinition } from '../ir.ts';
import { parseManaCost } from '../oracle.ts';
import { activeFaceIndexForObject, getCardFaces } from '../scryfall.ts';
import type {
	CardInstance,
	CardLayout,
	CopiableState,
	FaceDownSpec,
	ManaColor,
	ScryfallCard,
	ScryfallCardFace,
	StackItem,
	ZoneType
} from '../types.ts';

const SUPERTYPES = new Set(['Basic', 'Legendary', 'Snow', 'World', 'Ongoing', 'Elite', 'Host']);

export interface ResolveObjectFacesOptions {
	zone?: ZoneType;
	faceIndex?: number;
	fused?: boolean;
	unlockedFaces?: number[];
	isFaceDown?: boolean;
	faceDownSpec?: FaceDownSpec;
	faceDownLabel?: string;
	isSingleFaceCopy?: boolean;
	copiableState?: CopiableState;
}

export interface ResolvedObjectView {
	layout: CardLayout;
	isFaceDown: boolean;
	faceDownSpec?: FaceDownSpec;
	wardCost?: string;
	activeFaceIndices: number[];
	faces: ScryfallCardFace[];
	name: string;
	names: string[];
	manaCost: string;
	manaValue: number;
	typeLine: string;
	supertypes: string[];
	types: string[];
	subtypes: string[];
	colors: ManaColor[];
	colorIndicator?: ManaColor[];
	keywords: string[];
	power?: number;
	toughness?: number;
	loyalty?: number;
	defense?: string;
	ptDefinedByAbility?: boolean;
	imageUrl: string;
	artCropUrl?: string;
}

function parseStat(v: string | undefined): number | undefined {
	return v !== undefined && /^-?\d+$/.test(v) ? parseInt(v, 10) : undefined;
}

function parseTypeLineParts(typeLine: string): {
	supertypes: string[];
	types: string[];
	subtypes: string[];
} {
	const [left, right = ''] = typeLine.split(/\s+—\s+/);
	const words = left.split(/\s+/).filter(Boolean);
	return {
		supertypes: words.filter((w) => SUPERTYPES.has(w)),
		types: words.filter((w) => !SUPERTYPES.has(w)),
		subtypes: right.split(/\s+/).filter(Boolean)
	};
}

function formatTypeLine(supertypes: string[], types: string[], subtypes: string[]): string {
	const left = [...supertypes, ...types].join(' ');
	return subtypes.length > 0 ? `${left} — ${subtypes.join(' ')}` : left;
}

function dedupe<T>(items: readonly T[]): T[] {
	const out: T[] = [];
	for (const item of items) {
		if (!out.includes(item)) out.push(item);
	}
	return out;
}

function faceManaValue(card: ScryfallCard, face: ScryfallCardFace, idx: number, layout: CardLayout): number {
	if (face.cmc !== undefined) return face.cmc;
	if (face.manaCost) return parseManaCost(face.manaCost).totalCmc;
	if (idx === 0 && layout === 'normal') return card.cmc ?? 0;
	return 0;
}

function faceColors(face: ScryfallCardFace): ManaColor[] {
	if (face.colors.length > 0) return [...face.colors];
	if (face.colorIndicator && face.colorIndicator.length > 0) return [...face.colorIndicator];
	return [];
}

function resolveLayout(card: ScryfallCard, allFaces: ScryfallCardFace[]): CardLayout {
	if (card.layout) return card.layout;
	if (allFaces.length > 1 && card.backFace) return 'transform';
	return 'normal';
}

function viewFromSingleFace(
	layout: CardLayout,
	face: ScryfallCardFace,
	idx: number,
	manaValue: number,
	manaFace?: ScryfallCardFace
): ResolvedObjectView {
	const { supertypes, types, subtypes } = parseTypeLineParts(face.typeLine);
	const power = parseStat(face.power);
	const toughness = parseStat(face.toughness);
	const loyalty = parseStat(face.loyalty);
	const ptDefinedByAbility =
		(face.power !== undefined && power === undefined) ||
		(face.toughness !== undefined && toughness === undefined);
	const colorSrc = manaFace ?? face;
	const colors = faceColors(colorSrc);
	const colorIndicator = colorSrc.colorIndicator ? [...colorSrc.colorIndicator] : undefined;
	return {
		layout,
		isFaceDown: false,
		activeFaceIndices: [idx],
		faces: [face],
		name: face.name,
		names: [face.name],
		manaCost: colorSrc.manaCost,
		manaValue,
		typeLine: face.typeLine,
		supertypes,
		types,
		subtypes,
		colors,
		...(colorIndicator ? { colorIndicator } : {}),
		keywords: face.keywords ? [...face.keywords] : [],
		...(power !== undefined ? { power } : {}),
		...(toughness !== undefined ? { toughness } : {}),
		...(loyalty !== undefined ? { loyalty } : {}),
		...(face.defense !== undefined ? { defense: face.defense } : {}),
		...(ptDefinedByAbility ? { ptDefinedByAbility: true } : {}),
		imageUrl: face.imageUrl,
		...(face.artCropUrl ? { artCropUrl: face.artCropUrl } : {})
	};
}

function applyCopyExceptions(
	view: ResolvedObjectView,
	except: NonNullable<CopiableState['except']>
): ResolvedObjectView {
	let names = view.names;
	let name = view.name;
	if (except.names) {
		names = [...except.names];
		name = names.join(' // ');
	}
	let supertypes = except.supertypes ? [...except.supertypes] : [...view.supertypes];
	if (except.removeSupertypes && except.removeSupertypes.length > 0) {
		const rm = new Set(except.removeSupertypes.map((s) => s.toLowerCase()));
		supertypes = supertypes.filter((s) => !rm.has(s.toLowerCase()));
	}
	const types = except.types ? [...except.types] : [...view.types];
	const subtypes = except.subtypes ? [...except.subtypes] : [...view.subtypes];
	const colors = except.colors ? [...except.colors] : [...view.colors];
	const power = except.power !== undefined ? except.power : view.power;
	const toughness = except.toughness !== undefined ? except.toughness : view.toughness;
	const typeLine = formatTypeLine(supertypes, types, subtypes);
	return {
		...view,
		name,
		names,
		supertypes,
		types,
		subtypes,
		typeLine,
		colors,
		...(power !== undefined ? { power } : {}),
		...(toughness !== undefined ? { toughness } : {})
	};
}

/**
 * Resolves the active faces and copiable characteristics for a card/object in a given zone.
 * Implements Layer 1a copy state/exceptions (CR 613.2a) followed by Layer 1b face-down
 * characteristics (CR 613.2b, 708.2) on the stack and battlefield.
 */
export function resolveObjectFaces(
	card: ScryfallCard,
	opts?: ResolveObjectFacesOptions
): ResolvedObjectView {
	const zone = opts?.zone;
	const baseCard = opts?.copiableState?.card ?? card;
	const allFaces = getCardFaces(baseCard);
	const layout = resolveLayout(baseCard, allFaces);

	// Layer 1b (CR 613.2b, 708.2a, 708.4, 406.3): face-down objects on stack/battlefield have
	// spec characteristics (default 2/2 Creature); face-down exiled/other cards have no characteristics.
	if (opts?.isFaceDown) {
		const visibleChars = zone === 'battlefield' || zone === 'stack';
		const spec = opts.faceDownSpec;
		const supertypes = visibleChars && spec?.supertypes ? [...spec.supertypes] : [];
		const types = visibleChars
			? spec?.types && spec.types.length > 0
				? [...spec.types]
				: ['Creature']
			: [];
		const subtypes = visibleChars && spec?.subtypes ? [...spec.subtypes] : [];
		const colors = visibleChars && spec?.colors ? [...spec.colors] : [];
		const isCreature = types.includes('Creature');
		const power =
			visibleChars && (spec?.power !== undefined || isCreature) ? (spec?.power ?? 2) : undefined;
		const toughness =
			visibleChars && (spec?.toughness !== undefined || isCreature)
				? (spec?.toughness ?? 2)
				: undefined;
		const wardCost = visibleChars ? spec?.wardCost : undefined;
		const keywords = wardCost ? [`Ward ${wardCost}`] : [];
		const name =
			opts.faceDownLabel ??
			(zone === 'stack'
				? 'Face-Down Spell'
				: zone === 'battlefield'
					? 'Face-Down Creature'
					: 'Face-Down Card');
		return {
			layout,
			isFaceDown: true,
			...(visibleChars && spec ? { faceDownSpec: spec } : {}),
			...(wardCost ? { wardCost } : {}),
			activeFaceIndices: [],
			faces: [],
			name,
			names: [],
			manaCost: '',
			manaValue: 0,
			typeLine: formatTypeLine(supertypes, types, subtypes),
			supertypes,
			types,
			subtypes,
			colors,
			keywords,
			...(power !== undefined ? { power } : {}),
			...(toughness !== undefined ? { toughness } : {}),
			imageUrl: ''
		};
	}

	const requestedIdx = opts?.faceIndex ?? opts?.copiableState?.faceIndex ?? 0;
	const clampIdx = (i: number) => (i >= 0 && i < allFaces.length ? i : 0);
	const fused = opts?.fused ?? opts?.copiableState?.fused ?? false;
	const isSingleFaceCopy =
		opts?.isSingleFaceCopy ?? opts?.copiableState?.isSingleFaceCopy ?? false;

	let view: ResolvedObjectView;

	switch (layout) {
		case 'transform': {
			const idx = zone === 'battlefield' || zone === 'stack' ? clampIdx(requestedIdx) : 0;
			const face = allFaces[idx];
			// CR 712.6b, 712.6d: back face uses front face's MV unless it is a single-face copy.
			const mv =
				idx === 1 && !isSingleFaceCopy
					? allFaces[0].cmc !== undefined
						? allFaces[0].cmc
						: allFaces[0].manaCost
							? parseManaCost(allFaces[0].manaCost).totalCmc
							: (baseCard.cmc ?? 0)
					: faceManaValue(baseCard, face, idx, layout);
			view = viewFromSingleFace(layout, face, idx, mv);
			break;
		}
		case 'modal_dfc': {
			const idx = zone === 'battlefield' || zone === 'stack' ? clampIdx(requestedIdx) : 0;
			const face = allFaces[idx];
			// CR 712.6e: modal DFC uses the up face's own mana value.
			const mv = faceManaValue(baseCard, face, idx, layout);
			view = viewFromSingleFace(layout, face, idx, mv);
			break;
		}
		case 'split': {
			if (zone === 'stack' && !fused) {
				const idx = clampIdx(requestedIdx);
				const face = allFaces[idx];
				view = viewFromSingleFace(layout, face, idx, faceManaValue(baseCard, face, idx, layout));
			} else if (zone === 'battlefield') {
				// CR 709.5: Rooms share their type line; only unlocked halves contribute name/MC/abilities.
				const parsedFaces = allFaces.map((f) => parseTypeLineParts(f.typeLine));
				let supertypes = dedupe(parsedFaces.flatMap((p) => p.supertypes));
				let types = dedupe(parsedFaces.flatMap((p) => p.types));
				let subtypes = dedupe(parsedFaces.flatMap((p) => p.subtypes));
				if (types.length === 0 && baseCard.typeLine) {
					const top = parseTypeLineParts(baseCard.typeLine);
					supertypes = top.supertypes;
					types = top.types;
					subtypes = top.subtypes;
				}
				const unlocked = dedupe(
					(opts?.unlockedFaces ?? []).filter((i) => i >= 0 && i < allFaces.length)
				);
				const unlockedFaceObjs = unlocked.map((i) => allFaces[i]);
				const names = unlockedFaceObjs.map((f) => f.name);
				const colors = dedupe(unlockedFaceObjs.flatMap(faceColors));
				const keywords = dedupe(unlockedFaceObjs.flatMap((f) => f.keywords ?? []));
				const manaCost = unlockedFaceObjs
					.map((f) => f.manaCost)
					.filter(Boolean)
					.join('');
				const manaValue = unlocked.reduce(
					(sum, idx) => sum + faceManaValue(baseCard, allFaces[idx], idx, layout),
					0
				);
				const firstFace = unlockedFaceObjs[0] ?? allFaces[0];
				view = {
					layout,
					isFaceDown: false,
					activeFaceIndices: unlocked,
					faces: unlockedFaceObjs,
					name: names.join(' // '),
					names,
					manaCost,
					manaValue,
					typeLine: formatTypeLine(supertypes, types, subtypes),
					supertypes,
					types,
					subtypes,
					colors,
					keywords,
					imageUrl: firstFace.imageUrl,
					...(firstFace.artCropUrl ? { artCropUrl: firstFace.artCropUrl } : {})
				};
			} else {
				// CR 709.4 / 709.4d: outside the stack, or fused on the stack -> union of all halves.
				const parsedFaces = allFaces.map((f) => parseTypeLineParts(f.typeLine));
				const supertypes = dedupe(parsedFaces.flatMap((p) => p.supertypes));
				const types = dedupe(parsedFaces.flatMap((p) => p.types));
				const subtypes = dedupe(parsedFaces.flatMap((p) => p.subtypes));
				const names = allFaces.map((f) => f.name);
				const colors = dedupe(allFaces.flatMap(faceColors));
				const keywords = dedupe(allFaces.flatMap((f) => f.keywords ?? []));
				const manaCost = allFaces
					.map((f) => f.manaCost)
					.filter(Boolean)
					.join('');
				const anyManaInfo = allFaces.some((f) => Boolean(f.manaCost) || f.cmc !== undefined);
				const manaValue = anyManaInfo
					? allFaces.reduce((sum, f, i) => sum + faceManaValue(baseCard, f, i, layout), 0)
					: (baseCard.cmc ?? 0);
				view = {
					layout,
					isFaceDown: false,
					activeFaceIndices: allFaces.map((_, i) => i),
					faces: [...allFaces],
					name: names.join(' // '),
					names,
					manaCost,
					manaValue,
					typeLine: formatTypeLine(supertypes, types, subtypes),
					supertypes,
					types,
					subtypes,
					colors,
					keywords,
					imageUrl: allFaces[0].imageUrl,
					...(allFaces[0].artCropUrl ? { artCropUrl: allFaces[0].artCropUrl } : {})
				};
			}
			break;
		}
		case 'adventure': {
			// CR 716.4: Adventure characteristics exist only while on the stack as an Adventure.
			const idx = zone === 'stack' ? clampIdx(requestedIdx) : 0;
			const face = allFaces[idx];
			view = viewFromSingleFace(layout, face, idx, faceManaValue(baseCard, face, idx, layout));
			break;
		}
		case 'flip': {
			// CR 710.2–3, 710.1c: flipped characteristics apply on battlefield; color & mana cost stay front.
			const idx = zone === 'battlefield' ? clampIdx(requestedIdx) : 0;
			const face = allFaces[idx];
			const front = allFaces[0];
			const mv = faceManaValue(baseCard, front, 0, layout);
			view = viewFromSingleFace(layout, face, idx, mv, idx === 1 ? front : face);
			break;
		}
		case 'normal':
		case 'meld':
		case 'reversible_card':
		default: {
			const idx =
				layout === 'reversible_card' && (zone === 'battlefield' || zone === 'stack')
					? clampIdx(requestedIdx)
					: 0;
			const face = allFaces[idx];
			view = viewFromSingleFace(layout, face, idx, faceManaValue(baseCard, face, idx, layout));
			break;
		}
	}

	if (!opts?.isFaceDown) {
		const cdaColors = resolveLayer5CdaColors(baseCard, view.activeFaceIndices);
		if (cdaColors !== null) {
			view = { ...view, colors: cdaColors };
		}
	}

	if (opts?.copiableState?.except) {
		view = applyCopyExceptions(view, opts.copiableState.except);
	}
	return view;
}

function resolveLayer5CdaColors(
	card: ScryfallCard,
	activeFaceIndices: readonly number[]
): ManaColor[] | null {
	const compiled = compileCard(card);
	let result: ManaColor[] | null = null;
	for (const idx of activeFaceIndices) {
		const face = compiled.faces[idx];
		if (!face) continue;
		for (const ab of face.abilities) {
			if (ab.kind !== 'keyword') continue;
			const spec = getKeywordSpec(ab.keyword.name);
			if (spec?.status !== 'implemented' || spec.implementation?.kind !== 'static') continue;
			for (const st of spec.implementation.buildStatics(ab.keyword)) {
				if (st.k === 'continuous' && st.layer === '5' && st.affected === 'self' && st.mod.k === 'setColors') {
					result = [...st.mod.colors];
				}
			}
		}
	}
	return result;
}

/**
 * Matches an object's effective colors against an ObjectFilter's `colors` array,
 * treating `'C'` (colorless) as `colors.length === 0`.
 */
export function matchesColorFilter(
	objectColors: readonly string[],
	filterColors: readonly string[]
): boolean {
	return filterColors.some((c) => (c === 'C' ? objectColors.length === 0 : objectColors.includes(c)));
}

export function instanceFaceOptions(
	inst: CardInstance,
	zoneOverride?: ZoneType
): ResolveObjectFacesOptions {
	return {
		zone: zoneOverride ?? inst.zone,
		faceIndex: activeFaceIndexForObject(inst),
		unlockedFaces: inst.unlockedFaces,
		isFaceDown: inst.isFaceDown,
		faceDownSpec: inst.faceDownSpec,
		faceDownLabel: inst.faceDownLabel,
		copiableState: inst.copiableState,
		isSingleFaceCopy: inst.copiableState?.isSingleFaceCopy
	};
}

export function stackItemFaceOptions(item: StackItem): ResolveObjectFacesOptions {
	return {
		zone: 'stack',
		faceIndex: item.faceIndex ?? 0,
		fused: item.fused,
		isFaceDown: item.isFaceDown,
		faceDownSpec: item.faceDownSpec,
		faceDownLabel: item.faceDownLabel
	};
}

/**
 * Returns the compiled `FaceDefinition`s corresponding to the active face(s) of `card`.
 */
export function activeFaceDefs(
	card: ScryfallCard,
	opts?: ResolveObjectFacesOptions
): FaceDefinition[] {
	const view = resolveObjectFaces(card, opts);
	if (view.isFaceDown) return [];
	const def = compileCard(opts?.copiableState?.card ?? card);
	return view.activeFaceIndices
		.map((idx) => def.faces[idx])
		.filter((f): f is FaceDefinition => Boolean(f));
}

/**
 * Returns the compiled `AbilityDef`s active for `card` under the given zone/face options.
 */
export function activeAbilityDefs(
	card: ScryfallCard,
	opts?: ResolveObjectFacesOptions
): AbilityDef[] {
	return activeFaceDefs(card, opts).flatMap((f) => f.abilities);
}

/**
 * Returns the resolved `Characteristics` for `card` under the given zone/face options.
 */
export function activeCharacteristics(
	card: ScryfallCard,
	opts?: ResolveObjectFacesOptions
): Characteristics {
	const view = resolveObjectFaces(card, opts);
	return {
		manaCost: view.manaCost,
		types: view.types,
		subtypes: view.subtypes,
		supertypes: view.supertypes,
		colors: view.colors,
		...(view.colorIndicator ? { colorIndicator: view.colorIndicator } : {}),
		...(view.power !== undefined ? { power: view.power } : {}),
		...(view.toughness !== undefined ? { toughness: view.toughness } : {}),
		...(view.loyalty !== undefined ? { loyalty: view.loyalty } : {}),
		...(view.ptDefinedByAbility ? { ptDefinedByAbility: true } : {})
	};
}

/**
 * Returns the effective mana value of `card` under the given zone/face options (CR 202.3, 708.2a,
 * 709.4b, 712.6d–e).
 */
export function effectiveManaValue(
	card: ScryfallCard,
	opts?: ResolveObjectFacesOptions
): number {
	return resolveObjectFaces(card, opts).manaValue;
}
