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

import ov15d5b198 from './15d5b198-edbe-40f3-87e2-d72f7f0c58ab.json' with { type: 'json' };
import ov3d92e5ce from './3d92e5ce-9d30-4203-9f84-6c36117440cf.json' with { type: 'json' };
import ov49d4aef7 from './49d4aef7-d2d1-4f66-bc2a-79ec8cc96565.json' with { type: 'json' };
import ov699b192c from './699b192c-f3f2-4ac5-9ca9-e35bcf08ad8a.json' with { type: 'json' };
import ovC0d8fef4 from './c0d8fef4-65f4-4769-982d-b397d2b7e977.json' with { type: 'json' };
import ovC823e687 from './c823e687-6311-4c99-974b-fd77d204141a.json' with { type: 'json' };
import ovCfca44cb from './cfca44cb-8ca5-4ebb-bd5c-b621eca41944.json' with { type: 'json' };
import ovEe6099b0 from './ee6099b0-fb1f-42f1-b862-7708c6e36d05.json' with { type: 'json' };

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
			if (!isRecord(typed.replacement) || typeof typed.replacement.event !== 'string') {
				throw new Error(`${loc}: replacement ability missing replacement.event`);
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
	ov15d5b198,
	ov3d92e5ce,
	ov49d4aef7,
	ov699b192c,
	ovC0d8fef4,
	ovC823e687,
	ovCfca44cb,
	ovEe6099b0
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
