/**
 * Schema-validated pure-JSON IR override registry (ENGINE_ARCHITECTURE_PLAN.md section 2.23).
 *
 * Overrides live in `src/lib/magic/overrides/<oracleId>.json` and are imported statically so
 * Cloudflare Workers / edge isolates never touch `node:fs`. Each entry carries `expectedTextHash`
 * computed over `sourceText(card)` so any Scryfall oracle update or in-test card mutation
 * automatically falls back to standard `compileFaces(card)` compilation rather than serving stale IR.
 */
import type { AbilityDef, CardDefinition, FaceDefinition, Span } from '../ir.ts';
import { getKeywordSpec } from '../keywords.ts';
import { staticallyInterpretable, triggerTargetsSupported } from '../compiler/interpretable.ts';
import type { CardLayout } from '../types.ts';

import ov0636b6c3 from './0636b6c3-0662-420a-b30d-f0a14e7c512d.json' with { type: 'json' };
import ov08becc07 from './08becc07-28bc-4a2f-a6b0-28a2998d2f50.json' with { type: 'json' };
import ov1313da2f from './1313da2f-92bb-4862-9153-373972cc1520.json' with { type: 'json' };
import ov15d5b198 from './15d5b198-edbe-40f3-87e2-d72f7f0c58ab.json' with { type: 'json' };
import ov240e85d3 from './240e85d3-e495-4877-8609-4b4056c402f7.json' with { type: 'json' };
import ov2962fe4c from './2962fe4c-bf48-454b-8a6b-0f8253352ae8.json' with { type: 'json' };
import ov32fbb638 from './32fbb638-ab14-4e8b-a07a-d4c44e3496f2.json' with { type: 'json' };
import ov333745d9 from './333745d9-e930-439b-94d6-3aeea2877f69.json' with { type: 'json' };
import ov33e85a8a from './33e85a8a-86df-4cdc-a9cc-8cbabe92c3c0.json' with { type: 'json' };
import ov3d92e5ce from './3d92e5ce-9d30-4203-9f84-6c36117440cf.json' with { type: 'json' };
import ov48534bbf from './48534bbf-06b6-46a0-8a86-b14f38caee58.json' with { type: 'json' };
import ov49d4aef7 from './49d4aef7-d2d1-4f66-bc2a-79ec8cc96565.json' with { type: 'json' };
import ov4ff07b7c from './4ff07b7c-e97a-4b57-bcf1-2f22c37a8bd6.json' with { type: 'json' };
import ov5f15125e from './5f15125e-ae89-471e-b055-226a783bc7c1.json' with { type: 'json' };
import ov699b192c from './699b192c-f3f2-4ac5-9ca9-e35bcf08ad8a.json' with { type: 'json' };
import ov6f4ac4a4 from './6f4ac4a4-53ec-4bc9-8f5c-d4b801d867b2.json' with { type: 'json' };
import ov723a66c3 from './723a66c3-2c2c-411c-bba5-922e8601981b.json' with { type: 'json' };
import ov85ccae95 from './85ccae95-92c4-41ff-96fd-dcb515dc568e.json' with { type: 'json' };
import ov8f351961 from './8f351961-69e3-4637-b010-d13f19daca39.json' with { type: 'json' };
import ov9b9a10ff from './9b9a10ff-5a5d-4df8-88aa-18d84ff9117c.json' with { type: 'json' };
import ov9f6828e3 from './9f6828e3-39d9-45d9-9bf1-0e3737a0321e.json' with { type: 'json' };
import ovA54f0869 from './a54f0869-94c8-42af-9080-166efb9486a4.json' with { type: 'json' };
import ovAa959340 from './aa959340-c869-4caa-92c7-572bd8d23eef.json' with { type: 'json' };
import ovAb8d5f5c from './ab8d5f5c-1976-4f77-8ed2-8d28ee666741.json' with { type: 'json' };
import ovC0d8fef4 from './c0d8fef4-65f4-4769-982d-b397d2b7e977.json' with { type: 'json' };
import ovC12e2563 from './c12e2563-4ad4-4637-b9ae-72f23cca31d8.json' with { type: 'json' };
import ovC549b0fd from './c549b0fd-1e08-4873-952e-a14dc45a0fd2.json' with { type: 'json' };
import ovC823e687 from './c823e687-6311-4c99-974b-fd77d204141a.json' with { type: 'json' };
import ovCfca44cb from './cfca44cb-8ca5-4ebb-bd5c-b621eca41944.json' with { type: 'json' };
import ovE0cef79c from './e0cef79c-ad47-4cbc-9d73-a913e487ccb7.json' with { type: 'json' };
import ovE11966cd from './e11966cd-2ee3-4df4-b099-abf42dcdf0db.json' with { type: 'json' };
import ovE8863518 from './e8863518-0bfa-49c3-8c6e-6c9116a81051.json' with { type: 'json' };
import ovEe6099b0 from './ee6099b0-fb1f-42f1-b862-7708c6e36d05.json' with { type: 'json' };
import ovF36d1d8b from './f36d1d8b-8303-44a9-ab56-531931641ea2.json' with { type: 'json' };
import ovFb60739e from './fb60739e-1dc3-481d-a056-ad72e665c680.json' with { type: 'json' };
import ovFb773114 from './fb773114-6161-46a3-ab30-1853958fbcb0.json' with { type: 'json' };
import ovFb88fb3d from './fb88fb3d-6a85-4bb1-b316-7f759b45a0fa.json' with { type: 'json' };
import ovFd949f82 from './fd949f82-fc10-4e37-8aa9-6c7569fe3c55.json' with { type: 'json' };

export interface CardOverrideEntry {
	oracleId: string;
	expectedTextHash: string;
	layout?: CardLayout;
	faces: FaceDefinition[];
}

const VALID_LAYOUTS: ReadonlySet<string> = new Set<CardLayout>([
	'normal',
	'split',
	'flip',
	'transform',
	'modal_dfc',
	'adventure',
	'meld',
	'reversible_card',
	'prepare',
	'omen'
]);

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((item) => typeof item === 'string');
}

function isValidSpan(v: unknown): v is Span {
	if (!isRecord(v)) return false;
	return (
		typeof v.start === 'number' &&
		Number.isInteger(v.start) &&
		v.start >= 0 &&
		typeof v.end === 'number' &&
		Number.isInteger(v.end) &&
		v.end >= v.start
	);
}

function validateAbilityDef(ab: unknown, oracleId: string, faceIdx: number, abIdx: number): void {
	const loc = `override ${oracleId} face[${faceIdx}].abilities[${abIdx}]`;
	if (!isRecord(ab) || typeof ab.kind !== 'string') {
		throw new Error(`${loc}: ability must be an object with string kind`);
	}
	if (!isValidSpan(ab.span)) {
		throw new Error(`${loc}: invalid span`);
	}
	if (ab.kind === 'unsupported') {
		throw new Error(`${loc}: override must not contain unsupported abilities`);
	}

	const typed = ab as unknown as AbilityDef;
	switch (typed.kind) {
		case 'keyword': {
			const kwName = isRecord(typed.keyword) ? typed.keyword.name : undefined;
			if (typeof kwName !== 'string') {
				throw new Error(`${loc}: keyword ability missing keyword.name`);
			}
			const spec = getKeywordSpec(kwName);
			if (!spec || spec.status !== 'implemented') {
				throw new Error(`${loc}: keyword "${kwName}" is not implemented`);
			}
			return;
		}
		case 'spell': {
			if (!Array.isArray(typed.additionalCosts) || !Array.isArray(typed.targets) || !Array.isArray(typed.effect)) {
				throw new Error(`${loc}: spell ability missing additionalCosts/targets/effect arrays`);
			}
			if (
				!staticallyInterpretable({
					steps: typed.effect,
					targets: typed.targets,
					modal: typed.modal,
					unparsed: []
				})
			) {
				throw new Error(`${loc}: spell effect is not statically interpretable`);
			}
			return;
		}
		case 'activated': {
			if (typeof typed.id !== 'string' || typed.id.length === 0) {
				throw new Error(`${loc}: activated ability missing non-empty id`);
			}
			if (!Array.isArray(typed.cost) || !Array.isArray(typed.targets) || !Array.isArray(typed.effect)) {
				throw new Error(`${loc}: activated ability missing cost/targets/effect arrays`);
			}
			if (typed.timing !== 'instant' && typed.timing !== 'sorcery' && typed.timing !== 'mana') {
				throw new Error(`${loc}: invalid activated timing`);
			}
			if (typeof typed.isMana !== 'boolean') {
				throw new Error(`${loc}: activated ability missing boolean isMana`);
			}
			if (
				!staticallyInterpretable({
					steps: typed.effect,
					targets: typed.targets,
					modal: typed.modal,
					unparsed: []
				})
			) {
				throw new Error(`${loc}: activated effect is not statically interpretable`);
			}
			return;
		}
		case 'triggered': {
			if (!isRecord(typed.trigger) || typeof typed.trigger.event !== 'string') {
				throw new Error(`${loc}: triggered ability missing trigger.event`);
			}
			if (!Array.isArray(typed.targets) || !Array.isArray(typed.effect)) {
				throw new Error(`${loc}: triggered ability missing targets/effect arrays`);
			}
			if (!triggerTargetsSupported(typed.targets)) {
				throw new Error(`${loc}: triggered ability has unsupported target zone`);
			}
			if (
				!staticallyInterpretable({
					steps: typed.effect,
					targets: typed.targets,
					modal: typed.modal,
					unparsed: []
				})
			) {
				throw new Error(`${loc}: triggered effect is not statically interpretable`);
			}
			return;
		}
		case 'static': {
			if (!isRecord(typed.static) || typeof typed.static.k !== 'string' || typed.static.k.length === 0) {
				throw new Error(`${loc}: static ability missing static.k`);
			}
			return;
		}
		case 'replacement': {
			if (
				!isRecord(typed.replacement) ||
				!isRecord(typed.replacement.replaces) ||
				typeof typed.replacement.replaces.event !== 'string'
			) {
				throw new Error(`${loc}: replacement ability missing replacement.replaces.event`);
			}
			return;
		}
		default:
			throw new Error(`${loc}: unknown ability kind`);
	}
}

export function validateOverrideEntry(raw: unknown): CardOverrideEntry {
	if (!isRecord(raw)) {
		throw new Error('override entry must be an object');
	}
	const oracleId = raw.oracleId;
	if (typeof oracleId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(oracleId)) {
		throw new Error(`override entry has invalid oracleId: ${String(oracleId)}`);
	}
	const expectedTextHash = raw.expectedTextHash;
	if (typeof expectedTextHash !== 'string' || !/^[0-9a-f]{8}$/.test(expectedTextHash)) {
		throw new Error(`override ${oracleId}: expectedTextHash must be an 8-char lowercase hex string`);
	}
	if (raw.layout !== undefined && (typeof raw.layout !== 'string' || !VALID_LAYOUTS.has(raw.layout))) {
		throw new Error(`override ${oracleId}: invalid layout "${String(raw.layout)}"`);
	}
	if (!Array.isArray(raw.faces) || raw.faces.length === 0) {
		throw new Error(`override ${oracleId}: faces must be a non-empty array`);
	}
	for (let fi = 0; fi < raw.faces.length; fi++) {
		const face = raw.faces[fi];
		const faceName = isRecord(face) ? face.name : undefined;
		if (!isRecord(face) || typeof faceName !== 'string' || faceName.trim().length === 0) {
			throw new Error(`override ${oracleId} face[${fi}]: missing face name`);
		}
		const ch = face.characteristics;
		if (!isRecord(ch) || typeof ch.manaCost !== 'string') {
			throw new Error(`override ${oracleId} face[${fi}]: missing characteristics.manaCost`);
		}
		if (
			!isStringArray(ch.types) ||
			!isStringArray(ch.subtypes) ||
			!isStringArray(ch.supertypes) ||
			!isStringArray(ch.colors)
		) {
			throw new Error(`override ${oracleId} face[${fi}]: characteristics arrays invalid`);
		}
		if (!Array.isArray(face.abilities) || face.abilities.length === 0) {
			throw new Error(`override ${oracleId} face[${fi}]: abilities must be a non-empty array`);
		}
		for (let ai = 0; ai < face.abilities.length; ai++) {
			validateAbilityDef(face.abilities[ai], oracleId, fi, ai);
		}
	}
	return raw as unknown as CardOverrideEntry;
}

const RAW_ENTRIES: readonly unknown[] = [
	ov0636b6c3,
	ov08becc07,
	ov1313da2f,
	ov15d5b198,
	ov240e85d3,
	ov2962fe4c,
	ov32fbb638,
	ov333745d9,
	ov33e85a8a,
	ov3d92e5ce,
	ov48534bbf,
	ov49d4aef7,
	ov4ff07b7c,
	ov5f15125e,
	ov699b192c,
	ov6f4ac4a4,
	ov723a66c3,
	ov85ccae95,
	ov8f351961,
	ov9b9a10ff,
	ov9f6828e3,
	ovA54f0869,
	ovAa959340,
	ovAb8d5f5c,
	ovC0d8fef4,
	ovC12e2563,
	ovC549b0fd,
	ovC823e687,
	ovCfca44cb,
	ovE0cef79c,
	ovE11966cd,
	ovE8863518,
	ovEe6099b0,
	ovF36d1d8b,
	ovFb60739e,
	ovFb773114,
	ovFb88fb3d,
	ovFd949f82
];

function buildOverrideRegistry(entries: readonly unknown[]): ReadonlyMap<string, CardOverrideEntry> {
	const map = new Map<string, CardOverrideEntry>();
	for (const raw of entries) {
		const valid = validateOverrideEntry(raw);
		if (map.has(valid.oracleId)) {
			throw new Error(`duplicate override entry for oracleId ${valid.oracleId}`);
		}
		map.set(valid.oracleId, valid);
	}
	return map;
}

export const OVERRIDES_BY_ORACLE_ID: ReadonlyMap<string, CardOverrideEntry> =
	buildOverrideRegistry(RAW_ENTRIES);

/**
 * Looks up a validated JSON override by `(oracleId, textHash)`.
 * Returns `null` when unregistered or when `textHash !== entry.expectedTextHash`, allowing
 * `compileCardByText` to fall back cleanly to `compileFaces(card)`.
 */
export function resolveCardOverride(
	oracleId: string,
	textHash: string,
	cardName: string,
	compilerVersion: number
): CardDefinition | null {
	const entry = OVERRIDES_BY_ORACLE_ID.get(oracleId);
	if (!entry || entry.expectedTextHash !== textHash) return null;
	const faces: FaceDefinition[] = structuredClone(entry.faces);
	if (faces.length === 1) {
		faces[0].name = cardName;
	}
	return {
		oracleId,
		compilerVersion,
		textHash,
		name: cardName,
		...(entry.layout && entry.layout !== 'normal' ? { layout: entry.layout } : {}),
		faces,
		fullySupported: true
	};
}
