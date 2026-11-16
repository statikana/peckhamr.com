# 04 — Impact of Active Concurrent Keyword Fixes & Test Suites on Documentation

**Audited:** 2026-11-12 against the active uncommitted working tree on `engine-rewrite` (`HEAD = ecd4a3e`)

> [!IMPORTANT]
> Another agent is actively writing keyword tests and fixing keyword rules in the working tree (`compiler/{card,effects,normalize,support}.ts`, `ruleTree.ts`, `runtime/{costs,effects,layers,objectFilter,triggers,zones}.ts`, `engine.ts`, `ai.ts`, `ArenaTable.svelte`, `scryfall.ts`, and four `runtime/keywords-*.test.ts` suites). This report documents **how those in-flight changes affect `src/lib/magic/docs/`** and flags **5 remaining keyword truthfulness / consistency issues** observed in the code so docs and tests stay aligned.

---

## 1. New Keyword Test Suites Being Added

| Test File | Status | Keywords Covered |
| :--- | :--- | :--- |
| `src/lib/magic/runtime/keywords-casting.test.ts` | Untracked (new) | Overload, Flash, Suspend, Prowess, Changeling, Partner |
| `src/lib/magic/runtime/keywords-evasion.test.ts` | Untracked (new) | Flying, Reach, Fear, Intimidate, Horsemanship, Shadow, Menace, Defender, Haste, Vigilance |
| `src/lib/magic/runtime/keywords-combat-damage.test.ts` | Untracked (new) | Combat-damage & keyword interaction suite |
| `src/lib/magic/runtime/keywords-protection-attachments.test.ts` | Untracked (new) | Protection, Hexproof, Shroud, Ward, Enchant, Equip |
| `src/lib/magic/runtime/keywords-damage.test.ts` | Tracked (`fea46d5`) | Deathtouch, First Strike, Double Strike, Lifelink, Trample, Indestructible, Hexproof, Shroud, Protection, Ward, Infect, Wither |

*(Note: `FULL_COVERAGE_STRUCTURE.md:35` cites `995 tests, all passing, about 37 s`; that count and runtime will increase substantially once these 4 new suites commit.)*

---

## 2. Docs Impact of the 7 Active Working-Tree Fix Groups

| Fix Group in Working Tree | Affected Docs & Lines | Required Doc Updates Once Committed |
| :--- | :--- | :--- |
| **1. Overload UI modal, explicit `castMode`, `{X}` in overload cost, & removal of `xValue >= 1` sentinel** (`ArenaTable.svelte`, `ai.ts`, `engine.ts`, `runtime/costs.ts`) | • `07-keyword-abilities-2.md:89, 621`<br>• `FULL_COVERAGE_STRUCTURE.md:39–47, 59–65, 151–152` | • Update `07:89` (`702.96a`): remove gaps `(2)` (`xValue >= 1` fallback), `(3)` (deleted legacy `bounce_target`), and `(4)` (uncommitted UI fix warning); keep `partial` only for player-targeted Overload (`Mind Rake`) in `runtime/effects.ts`.<br>• Remove `07:621` (`xValue >= 1` Overload silent-skip bullet).<br>• Update `FULL_COVERAGE_STRUCTURE.md:39–47, 151–152` from *"fix in progress in the working tree, uncommitted"* to past tense (*"fixed after `ecd4a3e` by adding an Overload modal, motivating §1.1"*). |
| **2. Suspend global cast-restriction check & control-change haste expiry** (`engine.ts`, `runtime/zones.ts`) | • `06-keyword-abilities-1.md:12, 412, 414, 542–545` | • Upgrade **`702.62c` (`06:414`) from `missing` → `implemented`** (`checkSuspendLegality` now enforces `globalCheck.ok`).<br>• Remove gap `(3)` (`castViaSuspend` cleared in `transferBattlefieldControl`) from `702.62a` (`06:412`) and remove `06:545`. |
| **3. Ward on triggered-ability targeting & Layer 6 ability-removal / multi-instance grants** (`engine.ts`, `runtime/triggers.ts`, `runtime/layers.ts`) | • `06-keyword-abilities-1.md:11, 192–193` | • Upgrade **`702.21b` (`06:193`) from `missing` → `implemented`** (multiple distinct Ward instances trigger separately).<br>• Update `702.21a` (`06:192`): triggered abilities now emit `BecameTarget`, and Layer 6 ability removal / granted Ward are respected (`702.21a` stays `partial` only because non-mana/non-life Ward costs intentionally fall back to unsupported/manual resolution). |
| **4. Protection & Hexproof from [quality] Layer 4/5/6 evaluation + Equipment creature SBA (`CR 704.5p`)** (`engine.ts`, `runtime/effects.ts`, `runtime/layers.ts`) | • `06-keyword-abilities-1.md:111–113, 146, 150, 152`<br>• `08-tba-sba-copy.md:73` | • Update `702.11d–f` and `702.16a,e,g` in `06`: `hasProtectionFrom` and `hasHexproofFromQuality` now use `evalTarget.activeKeywords` and `sourcePerm`'s evaluated Layer 4/5 types/colors (including `lands` and face-down colorless status), and `permanentProtectedFromSource` splits `"protection from A and from B"` (`CR 702.16g`).<br>• Upgrade **`704.5p` (`08:73`)** note: `checkStateBasedActions` unattaches Equipment that becomes a creature or becomes attached to itself (`Battle` attachment half remains N/A/missing until Battles exist). |
| **5. Changeling Layer 4 CDA persistence & `Kindred`/`Tribal` subtype matching** (`runtime/layers.ts`, `runtime/objectFilter.ts`, `runtime/effects.ts`) | • `06-keyword-abilities-1.md:470`<br>• `ENGINE_INVARIANTS.md:45` | • Update `702.73a` (`06:470`): `hasAllCreatureTypes` now persists across Layer 6 ability loss (`CR 613.1d, 613.5`), clears when overwritten by a later Layer 4 `setTypes` effect (*Darksteel Mutation*), and applies to `Kindred`/`Tribal` objects. *(Off-battlefield `matchesLibrarySearchSpec`, graveyard Layer 7 counts, and `printedSubject` trigger filters remain open—see `01-top-level-docs-audit.md` §3.2.)* |
| **6. Partner deck validation (`CR 702.124f,h,m`, `CR 903.5b`)** (`scryfall.ts`, `compiler/card.ts`) | • `07-keyword-abilities-2.md:11, 238, 240, 242, 244, 617–618`<br>• `10-multiplayer-commander.md:136` | • Update `702.124f,h,m` (`07`) and `903.5b` (`10:136`): `isTimeLordDoctor` excludes Changeling (`CR 702.124m`), `hasGenericPartner` checks compiled IR rather than `/\bpartner\b/i`, and `validateCommanderDeck` rejects duplicate Partner commanders (`CR 903.5b`). **However, see §3.1 below on `CR 702.124j` `"Partner with [Name]"`!** |
| **7. Expanded `GRANTABLE_KEYWORDS` + parameterized keyword grants + `printedText` (`CR 201.5`)** (`compiler/effects.ts`, `compiler/normalize.ts`, `compiler/support.ts`, `ruleTree.ts`) | • `COVERAGE.md`<br>• `02-card-parts-types-zones.md:44` (`CR 201.5`) | • `compiler/effects.ts` now compiles spell/ability grants of `fear`, `flash`, `horsemanship`, `infect`, `intimidate`, `prowess`, `shadow`, `changeling`, `protection from ...`, `hexproof from ...`, and `ward {...}`, increasing Scryfall coverage further beyond `7,393` (`21.1%`) once `COVERAGE.md` is regenerated (and requiring a `COMPILER_VERSION` bump `7 → 8` per `compiler/index.ts`). |

---

## 3. Five Remaining Keyword Truthfulness & Consistency Issues Found During Audit

These discrepancies directly affect [`ENGINE_INVARIANTS.md`](../ENGINE_INVARIANTS.md) §1.5 (*"Honest Support Surface"*), [`06-keyword-abilities-1.md`](../rules-audit/06-keyword-abilities-1.md), and [`07-keyword-abilities-2.md`](../rules-audit/07-keyword-abilities-2.md):

1. **`"Partner with [Name]"` (`CR 702.124j`) & `"Partner—[text]"` (`CR 702.124h`) Compile as `fullySupported: true` Despite Missing Runtime Trigger (`compiler/card.ts:212, 221, 232`):**
   - In the working tree, `compiler/card.ts:221` added `partner with` to the non-comma-split regex so `"Partner with Pir, Imaginative Rascal"` stays one keyword token.
   - However, `parseKeyword` (`L212`) returns `{ name: 'partner', param: 'with Pir, Imaginative Rascal' }`, and `keywordLine` (`L232`) sets `implemented = IMPLEMENTED_KEYWORDS.has('partner')` (`true`) without rejecting `Boolean(keyword.param)`.
   - Result: **Every `"Partner with [Name]"` card now compiles with `fullySupported: true`**, even though `CR 702.124j`'s ETB target-player library-search trigger is completely unimplemented at runtime! (Either `keyword.name === 'partner' && keyword.param` should mark the ability unsupported, or the ETB trigger must be synthesized.)
2. **`'wither'` (`CR 702.80a`) Is Implemented in `statics.ts`, `layers.ts` & `effects.ts`, But Missing from `IMPLEMENTED_KEYWORDS` (`compiler/card.ts:56–86, 111`):**
   - Granted Wither compiles as `fullySupported: true` (`compiler/statics.ts:118`) and deals `-1/-1` counters in both combat and noncombat damage (`runtime/effects.ts:372`), yet `'wither'` is only in `KNOWN_KEYWORDS` (`compiler/card.ts:111`), so printed Wither cards compile as `keyword_not_implemented`!
3. **`'phasing'` (`CR 702.26a`) Is Implemented in Untap TBA, But Missing from `IMPLEMENTED_KEYWORDS`, `statics.ts` & `layers.ts` (`compiler/card.ts:104`):**
   - `executeUntapTurnBasedAction` (`engine.ts`) enforces phasing, yet `'phasing'` is only in `KNOWN_KEYWORDS`.
4. **Unimplemented `'evolve'` and `'cascade'` Remain in `runtime/layers.ts:225–226` (`KEYWORD_LABELS`):**
   - If granted via continuous effects, they render UI keyword badges while having zero runtime implementation.
5. **[DISPUTED 2026-11-12: the code is correct; don't change it.]** Damage from an infect or wither source is still damage dealt; it's only *marked* as counters (CR 702.90b, 702.80a). CR 702.2b and 704.5h destroy a creature that was "dealt damage by a source with deathtouch", so setting `deathtouchDamageMarked` there is right. ~~**Infect / Wither + Deathtouch Interaction Bug (`CR 702.90c`, `704.5h` — `runtime/effects.ts:377–379`):**
   - When a source with Deathtouch + Infect/Wither deals damage to a creature as `-1/-1` counters (`damageMarked` stays `0`), `runtime/effects.ts:377–379` still sets `target.deathtouchDamageMarked = true`, causing `checkStateBasedActions` (`CR 704.5h`) to destroy the creature even if it survived the `-1/-1` counters!~~
   - *(Minor typo also still present at `compiler/card.ts:111`: `'plainswalker'` instead of `'plainswalk'`, plus 6 duplicate strings in `KNOWN_KEYWORDS` already spread from `IMPLEMENTED_KEYWORDS`.)*
