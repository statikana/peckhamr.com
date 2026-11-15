import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';
import { createGunzip } from 'node:zlib';

import { COMPILER_VERSION, compileCard } from '../compiler/index.ts';
import { definitionSupportReport } from '../compiler/support.ts';
import { normalizeScryfallCard } from '../scryfall.ts';
import {
	OVERRIDES_BY_ORACLE_ID,
	resolveCardOverride,
	validateOverrideEntry
} from './index.ts';

const OVERRIDES_DIR = new URL('.', import.meta.url).pathname;
const SCRYFALL_PATH = '/home/ryan/data/scryfall/oracle-cards.jsonl.gz';

describe('Wave 7/8 JSON Card Overrides Registry', () => {
	it('registers every JSON file in src/lib/magic/overrides/ with unique oracleIds', () => {
		const jsonFiles = readdirSync(OVERRIDES_DIR)
			.filter((name) => name.endsWith('.json'))
			.sort();
		assert.ok(jsonFiles.length >= 8, `Expected at least 8 override files, found ${jsonFiles.length}`);
		assert.equal(
			OVERRIDES_BY_ORACLE_ID.size,
			jsonFiles.length,
			'Every override JSON file must be registered in OVERRIDES_BY_ORACLE_ID'
		);

		for (const fileName of jsonFiles) {
			const oracleId = fileName.replace(/\.json$/, '');
			assert.ok(
				OVERRIDES_BY_ORACLE_ID.has(oracleId),
				`Override file ${fileName} is not registered in OVERRIDES_BY_ORACLE_ID`
			);
			const parsed = JSON.parse(readFileSync(join(OVERRIDES_DIR, fileName), 'utf8'));
			const validated = validateOverrideEntry(parsed);
			assert.equal(validated.oracleId, oracleId);
		}
	});

	it('resolves every registered override cleanly with zero unsupported abilities', () => {
		for (const [oracleId, entry] of OVERRIDES_BY_ORACLE_ID) {
			const resolved = resolveCardOverride(
				oracleId,
				entry.expectedTextHash,
				entry.faces[0].name,
				COMPILER_VERSION
			);
			assert.ok(resolved, `resolveCardOverride returned null for ${oracleId}`);
			assert.equal(resolved.fullySupported, true);
			const report = definitionSupportReport(resolved);
			assert.equal(
				report.fullySupported,
				true,
				`Override ${oracleId} failed definitionSupportReport: ${JSON.stringify(report.unsupported)}`
			);
			assert.equal(report.unsupported.length, 0);

			// JSON round-trip sanity check (Worker-safe pure IR, no functions/RegExps)
			const cloned = JSON.parse(JSON.stringify(resolved));
			assert.deepEqual(cloned.faces, resolved.faces);

			// Hash-mismatch safety: mutated/errata'd text hash must NOT serve stale override
			const stale = resolveCardOverride(
				oracleId,
				'00000000' === entry.expectedTextHash ? 'ffffffff' : '00000000',
				entry.faces[0].name,
				COMPILER_VERSION
			);
			assert.equal(stale, null);
		}
	});

	it('rejects malformed or unsupported override definitions in validateOverrideEntry', () => {
		assert.throws(() => validateOverrideEntry(null), /must be an object/);
		assert.throws(
			() => validateOverrideEntry({ oracleId: 'not-a-uuid', expectedTextHash: '12345678', faces: [] }),
			/invalid oracleId/
		);
		assert.throws(
			() =>
				validateOverrideEntry({
					oracleId: '11111111-1111-1111-1111-111111111111',
					expectedTextHash: 'bad',
					faces: []
				}),
			/expectedTextHash/
		);
		assert.throws(
			() =>
				validateOverrideEntry({
					oracleId: '11111111-1111-1111-1111-111111111111',
					expectedTextHash: 'abcdef01',
					faces: [
						{
							name: 'Test',
							characteristics: { manaCost: '{1}', types: ['Artifact'], subtypes: [], supertypes: [], colors: [] },
							abilities: [
								{
									kind: 'unsupported',
									reason: 'spell_not_compiled',
									text: 'Do impossible thing.',
									unparsed: [],
									span: { start: 0, end: 20 }
								}
							]
						}
					]
				}),
			/must not contain unsupported/
		);
	});

	it('matches live Scryfall oracleId and textHash for every registered override', async () => {
		if (!existsSync(SCRYFALL_PATH)) return;

		const remaining = new Set(OVERRIDES_BY_ORACLE_ID.keys());
		const rl = readline.createInterface({
			input: createReadStream(SCRYFALL_PATH).pipe(createGunzip()),
			crlfDelay: Infinity
		});

		for await (const line of rl) {
			if (!line) continue;
			const raw = JSON.parse(line);
			const oid = raw.oracle_id;
			if (typeof oid !== 'string' || !remaining.has(oid)) continue;
			remaining.delete(oid);
			const card = normalizeScryfallCard(raw);
			const def = compileCard(card);
			const entry = OVERRIDES_BY_ORACLE_ID.get(oid)!;
			assert.equal(
				def.textHash,
				entry.expectedTextHash,
				`Override textHash mismatch for ${card.name} (${oid}): expected ${entry.expectedTextHash}, got ${def.textHash}`
			);
			assert.equal(def.fullySupported, true, `${card.name} (${oid}) should be fullySupported`);
			assert.equal(definitionSupportReport(def).fullySupported, true);
			if (remaining.size === 0) {
				rl.close();
				break;
			}
		}

		assert.equal(
			remaining.size,
			0,
			`Overrides not found in Scryfall dump: ${[...remaining].join(', ')}`
		);
	});
});
