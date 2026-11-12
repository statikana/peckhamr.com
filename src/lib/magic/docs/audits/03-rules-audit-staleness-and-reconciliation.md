# 03 — Post-`917180b` Staleness, Deleted Legacy References & Step F Reconciliation (`rules-audit/00`–`10`)

**Audited:** 2026-11-12 against `engine-rewrite` (`HEAD = ecd4a3e`)  
**Baseline of `rules-audit/01`–`10`:** Commit `917180b` (written 2026-11-09, committed in `bddf961` with **zero subsequent git commits** to `01`–`10`)

---

## 1. Root Cause of `rules-audit/` Drift

Between `917180b` (2026-11-09) and `ecd4a3e` (2026-11-12), **~136 commits** landed on `engine-rewrite`—including **Step F (`9ac8423`)**, **Phase 6d (`d7afed1`)**, **Tier 1a & 1b (`168eb3a`, `09a60a2`)**, **Review Phases 1–5 (`de50a56`, `8a1682e`, `b644c6c`)**, **Tier 2a & 2b (`c9cd8ce`, `c33b460`)**, **Tier 3a & 3b (`215d889`, `35adc9c`)**, **Review 2 (`1955ea9`)**, **Review 3 (`6aa533c`)**, **Toxic Deluge X-cost (`9473dad`)**, and **Turn Controls (`ecd4a3e`)**.

While `00-SUMMARY-AND-PRIORITIZED-GAPS.md` §2–§3 had `[FIXED]` / `✅ Fixed` notes appended for Tiers 1–3:
1. **`00-SUMMARY` §1's count table (`585 / 432 / 1,082 / 466`) was never updated.**
2. **None of `01`–`10` had their Top Gaps, CR status rows, line-number citations, or `"Silently skipped"` sections updated** (apart from 1 uncommitted line in `07-keyword-abilities-2.md:89`).
3. **Several post-Tier-3 waves (Review Phases 1–5, Review 2, Review 3, `9473dad`, `ecd4a3e`) were never recorded even in `00-SUMMARY`.**

---

## 2. Staleness & Omissions Inside `00-SUMMARY-AND-PRIORITIZED-GAPS.md`

1. **Tier 4 #1 (`L129`, Modal Spells `CR 700.2`) & §3 Step F (`L144–149`):**
   - `L129` still reads in future tense: `*(Step F is adding modal support for precon spells like Casualties of War and Farewell)*`. Step F (`301a183` / `9ac8423`) already shipped modal spell compilation and cast/resolution mode handling (`parseModal` in `compiler/effects.ts`, `cast_spell` in `engine.ts`, `compileSpellEffects` in `compiler/index.ts`). Remaining gaps are modal *activated/triggered abilities*, `"choose the same mode more than once"` (`CR 700.2d`), and untargeted resolution-time mode prompts.
   - `L144–149` omits Step F (`301a183`) IR additions for single-color `devotion` (`CR 700.5`), non-legendary token copies (`notLegendary`, `CR 707.9b`), `topmostOnly` graveyard moves (`CR 404.2`), and `DelayedTriggerEffect` replacing `ParsedEffect[]`.
2. **Tier 2 #1 (`L78–79`, Ability-Word Stripping):**
   - States `compiler/normalize.ts` is restricted *"to the canonical 66 ability words enumerated in `CR 207.2c`"*. Superseded by Review 2 (`1c5395c`), which replaced that check with `isAbilityOrFlavorWord` (`compiler/normalize.ts:463–477`) stripping both `CR 207.2c` ability words and `CR 207.2d` flavor words while blocking `CR 701/702` rules terms (`RULES_TERM_BLOCKLIST`, `RULES_PARAM_PREFIXES`).
3. **Tier 2 #5e (`L95`, Trample Damage Assignment):**
   - States human attackers are prompted when blocked by *multiple* blockers; Review 3 (`623071a`) extended the prompt to **single-blocker** Trample combat whenever attacker power exceeds lethal damage (`CR 510.1c, 702.19b`).
4. **Post-`917180b` Rules Fixes Completely Unrecorded in `00-SUMMARY`:**
   - **Review Phase 1 (`eab468d`):** Viewer secret/choice redaction (`CR 101.4a, 400.2`) — strips `rngState`/`nextUid`/`idSalt`, strips `effectResume` from `stack` and `pendingResolution`, and redacts opponent prompts.
   - **Review Phase 3 (`0b05112`, `10a6f62`, `5df0704`, `018fc84`):** Per-`TargetSpec` uniqueness (`CR 115.3, 601.2c`); preserved `TargetSpec` order and `targetObjectVersions` on triggered abilities (`CR 608.2b`); monotonic `turnSerial` for per-turn trigger caps; human Phyrexian mana payment prompts before auto-tap + `CR 119.8` life lock (`CR 107.4f, 118.13a, 119.8`).
   - **Review Phase 4 (`1b18f91`, `778a8d0`):** `CR 104.4b / 733.4` mandatory trigger loop detection (`computeLoopBoardFingerprints` including player state, ending zero-net-progress mandatory loops in a draw, with `MAX_TRIGGERS_PER_TURN = 2000` backstop).
   - **Review 2 (`0523789`, `6a6ef91`, `5eb3a09`, `1eb73e0`, `821808a`):** `pendingZoneMoves` deferred zone changes during `chooseReplacement` (`CR 603.10a, 616.1e–f, 903.9b`), pausing SBAs while `chooseReplacement` is pending (`CR 704.3`), scoping off-battlefield replacement/counter triggers (`CR 113.6`), and routing spell resolution + cleanup discard through `moveObject(..., { graveyardReplacement: true })` (`CR 400.7, 514.1, 608.2m`).
   - **Review 3 (`9dc6092`, `7d158af`, `d72e1c5`, `f59fac1`, `36109a0`, `67526ed`, `c80f6a3`):** Last-defender pass priority reset (`CR 509.2, 117.3a`), mandatory attacker/blocker bot compliance & lone `blocksEachCombat` vs. Menace deadlock fix (`CR 508.1d, 509.1c`), separate triggers per granted `Prowess` instance (`CR 702.108b`), exact stack `{X}` symbol count in `objectManaValue` (`CR 202.3e`), and face-down/hidden-zone redaction in `pendingZoneMoves` (`CR 400.2, 708.5`).
   - **Recent Commits (`28274c7`, `9473dad`, `ecd4a3e`):** Per-game starting card timestamps; `{X}` prompt when X appears only in an additional cost (*Toxic Deluge*, `CR 107.3a, 601.2b`); read-only `checkEndTurnLegality` / `checkMandatoryAttackersSatisfied` + UI turn controls.

---

## 3. Section-by-Section Stale Items (`01` through `10`)

*(Note: Almost all line-number citations to `engine.ts`, `compiler/*.ts`, and `runtime/*.ts` across `01`–`10` have also shifted since `917180b`.)*

### `01-game-concepts.md`
- **Top Gaps (`L12–16`):** **All 5 are stale** — `#1` `GainLife` (`c7d6b79`), `#2` `CardDrawn` & `playersDrawnThisTurn` reset (`c7d6b79`; `121.6` draw replacement still missing), `#3` unified combat damage (`d12a5b4`), `#4` auto-tap `TappedForMana` (`3da2cf1`), `#5` permanent spell copy tokens (`1cab195`).
- **Status Upgrades (`partial`/`missing` → `implemented`):**
  - `104.2, 104.2a` (`L79`, `2e674c2`), `106.5` (`L109`, `2f93b65`), `106.12, 106.12a` (`L113`, `3da2cf1`), `111.13` (`L190`, `1cab195`), `115.3` (`L230`, `0b05112`), `118.13, 118.13a` (`L274`, `326c5d9` + `018fc84`), `119.7, 119.8` (`L287`, `d12a5b4` + `018fc84`), `119.9, 119.10` (`L288`, `c7d6b79`), `120.3a, 120.3d, 120.3f` (`L296–297`, `d12a5b4`), plus `104.4, 104.4a, 104.4b` (`L88`, `missing` → `partial`/`implemented` via `1b18f91` + `778a8d0`).
- **Substantially Updated `partial` Rows:** `101.2` (`L36`, `232fc4a`), `101.4a` (`L41`, `eab468d`), `105.4` (`L100`, `326c5d9`), `107.3a` (`L124`, `9473dad`), `107.4e–f` (`L129`, `326c5d9` + `018fc84`), `109.4` (`L158`, `5eb3a09` + `1eb73e0`), `111.11` (`L189`, `301a183`), `113.6b/j/m` (`L211`, `301a183` + `5e4b339`), `115.7` (`L234`, `6d4b1f1` `copySpell`), `117.3–117.5` (`L251–253`, `50e9d61` + `ffe25b6` + `9dc6092`), `120.4` (`L299`, `d12a5b4`), `122.6` (`L325`, `d12a5b4` + `c7d6b79`).
- **Known Approximations (`L335–353`):** **14 of 18 bullets (`L337–338, 340–344, 347–353`) are resolved or false.**

### `02-card-parts-types-zones.md`
- **Top Gaps (`L7–19`):** **7 of 13 resolved** — `#2` Enchant player/multi-Enchant (`1dfa990`), `#3` non-cast Auras (`c3c3e79`), `#4` Legend Rule prompt (`eea6386`), `#6` Layer 4 supertypes & non-land types (`af8c944`), `#7` stack X & face-down mana value (`c0b068d` + `67526ed`), `#8` Equipment creature/self-attach SBA (`9ac8423`), `#10` off-battlefield `*/*` CDAs (`c0b068d`).
- **Status Upgrades (`partial` → `implemented`):**
  - `202.3a` (`L54`), `202.3e` (`L58`), `205.1a–b` (`L77–78`), `205.4b` (`L88`), `205.4d` (`L90`), `208.2, 208.2a` (`L113`), `303.4, 303.4a–e` (`L173–175`), `303.4f–g` (`L177`), `305.7` (`L200`).
- **Updated Notes:** `207.2c–d` (`L106`, `1c5395c`), `301.5c–e` (`L152–155`, `9ac8423`), `305.2` (`L196`, IR `extraLandPlays` in `9ac8423`), `400.6` (`L262`, `8978023` + `0523789`), `400.7` (`L263`, `821808a`), `404.2` (`L305`, `301a183`), `405.2` (`L317`, `c0b068d`), `405.5` (`L319`, `3da2cf1`), `408.1–408.3` (`L334`, `5e4b339` + `8978023`).
- **Silently Skipped (`L341–346`):** **5 of 6 bullets resolved** (`L341–343, 345–346`).

### `03-turn-structure.md`
- **Top Gaps (`L7–18`):** **8 of 12 resolved** (`#1–#7`, `#9`: `d12a5b4`, `2876b24`, `8f70d72`, `50e9d61`, `ffe25b6`, `4e55737` + `623071a`, `f152e58`, `d72e1c5` + `7d158af` + `f59fac1`).
- **Status Upgrades (`partial`/`missing` → `implemented`):**
  - `500.7` (`L33`), `505.6b` (`L78`), `506.4c` (`L92`), `506.8, 506.8a, 506.8c` (`L96`), `508.1` (`L111`), `508.1k` (`L120`), `508.2, 508.2a–b` (`L121`), `509.1` (`L130`), `509.1b` (`L132`), `509.1h–i` (`L137`), `509.2, 509.2a` (`L138`), `510.1a–e` (`L145–150`), `510.2` (`L151`), `513.1, 513.1a` (`L169`).
- **Updated `partial`/`implemented` Rows:** `500.2–500.3` (`L28–29`), `502.3` (`L43`, `08776ad`), `506.4` (`L90`, `8f70d72`), `507.2` (`L105`), `508.1d` (`L116`), `509.1c` (`L133`), `514.1` (`L176`, `821808a`).
- **Silently Skipped (`L183–189`):** **4 of 7 bullets resolved** (`L183–185, 187`).

### `04-spells-abilities-effects.md`
- **Top Gaps (`L7–18`):** **6 of 12 resolved/substantially fixed** (`#1` modal spells `301a183`, `#2` auto-tap `3da2cf1`, `#3` activation/cast restrictions `39d3686` + `232fc4a`, `#5` replacement ordering `63da2ac`, `#8` permanent spell copy `1cab195`, `#10` `becomesTapped`/`gainLife`/`drawCard` `c7d6b79`).
- **Status Upgrades (`partial`/`missing` → `implemented` or `missing` → `partial`):**
  - `602.5b–c` (`L65` → `implemented`), `603.2d` (`L76` → `implemented`), `603.2e` (`L77` → `partial`), `604.6` (`L115` → `partial`), `605.4a` (`L129` → `implemented`), `608.3a–b` (`L177` → `implemented`), `608.3f` (`L180` → `implemented`), `613.4a` (`L234` → `implemented`), `616.1, 616.1a` (`L292` → `implemented`), `616.1b–d` (`L293` → `partial`), `616.1e–f` (`L294` → `implemented`).
- **Updated `partial` Rows:** `601.1a` (`L28`), `601.2b–c` (`L32–33`), `601.3–601.3a` (`L40–41`), `602.1–602.2b` (`L57–60`), `603.2` (`L73`), `603.7` (`L90`), `603.10a` (`L96`), `604.3` (`L112`), `605.3a` (`L125`), `608.1–608.2m` (`L158–172`), `613.1d/f` (`L224, 226`), `614.1–614.12` (`L257–270`), `615.1/6` (`L282, 286`).
- **Silently Skipped (`L301–312`):** **9 of 12 bullets resolved** (`L301, 304–307, 309–312`).

### `05-general-and-keyword-actions.md`
- **Top Gaps (`L7–18`):** **4 resolved + 1 behavior change** (`#1` modal spells `301a183`, `#2` `fight`/`tap`/`untap` grammar `6d4b1f1`, `#3` Proliferate prompt `50a89cd`, `#6` `"can't be regenerated"` no longer silently stripped after Step F `9ac8423`, `#7` single-color `devotion` compiled/interpreted in `301a183`).
- **Status Upgrades:** `700.2a–c` (`L33`, `missing` → `partial` for spells), `701.14, 701.14a–c` (`L147`, `partial` → `implemented`), `701.26, 701.26a–b` (`L207`, `partial` → `implemented`), `701.34, 701.34a` (`L223`, `partial` → `implemented`).
- **Silently Skipped (`L271–274`):** **3 of 4 bullets resolved** (`L271, 272, 274`).

### `06-keyword-abilities-1.md`
*(Additional active working-tree keyword changes are covered in [`04-in-flight-keyword-and-test-impact.md`](./04-in-flight-keyword-and-test-impact.md).)*
- **Top Gaps (`L7–18`):** **9 of 12 resolved or partially fixed** (`#1` Protection combat damage `d12a5b4`, `#2` Wither combat damage `d12a5b4` [still missing from `IMPLEMENTED_KEYWORDS`], `#3` Fear/Intimidate/Shadow/Horsemanship `5dae1a1`, `#5` Ward prompt & unsupported costs `2402b09`, `#7` Hexproof from [quality] `5dae1a1`, `#8` Trample prompt & planeswalker-left-combat `2876b24` + `4e55737`, `#9` Enchant player/non-cast Auras `1dfa990` + `c3c3e79`, `#10` Equip IR migration `301a183`, `#12` Lifelink `GainLife` event `c7d6b79`).
- **Status Upgrades (`partial`/`missing` → `implemented` at `ecd4a3e`):**
  - `702.5c` (`L64`), `702.5d` (`L65`), `702.11d` (`L111`), `702.11e` (`L112`), `702.13a–c` Intimidate (`L126`), `702.15b` (`L137`), `702.15e` (`L140`), `702.19f` (`L180`), `702.28a–c` Shadow (`L240`), `702.31a–c` Horsemanship (`L256`), `702.36a–c` Fear (`L282`) — **+19 implemented subrules**.
- **Silently Skipped (`L535–546`):** **8 of 9 groups resolved** (`#1–#2, #4–#9`, plus `#3` Wither combat half).

### `07-keyword-abilities-2.md`
- **Top Gaps (`L8–19`):** `#1` Boast/Solved/Exhaust/Max speed/Power-up false-positive stripping fixed (`5a4b8f2`, `1c5395c`), `#2` Prowess implemented (`5dae1a1`, `40c6f4c`, `36109a0`), `#3` unsupported spell keywords no longer silently skipped (`583db73`), `#4c` Background commander grants & cast counts implemented (`5e4b339`), `#11` Infect combat damage routed through `addCounters` (`d12a5b4`; note `deathtouchDamageMarked` bug remains at `runtime/effects.ts:377–379`), `#12` Menace bot blocker assignment improved (`7d158af`; human multi-`blocksEachCombat` edge case remains).
- **Status Upgrades:** `702.108a–b` Prowess (`L151`, `missing` → `implemented`), `702.124e` (`L237`, `missing` → `partial`/`implemented`), `702.124k` (`L243`, `partial` → `implemented`), plus 15 spell-keyword rows (`L28–607`) whose silent-skip notes are now obsolete.

### `08-tba-sba-copy.md`
- **Top Gaps (`L7–16`):** **7 of 10 resolved** (`#1` Legend Rule prompt `eea6386`, `#2` `copySpell` & permanent spell copy tokens `1cab195` + `6d4b1f1`, `#3` Clone ETB prompt `4605975`, `#5` unified combat damage `d12a5b4` [with erroneous `704.5g/h` shield-counter claim], `#6` combat step-start TBAs `ffe25b6` + `50e9d61`, `#7` combat damage assignment prompt `4e55737`, `#10` Aura SBA legality `1dfa990`).
- **Status Upgrades:** `704.5j` (`L69`, `partial` → `implemented`), `707.5` (`L126`, `partial` → `implemented`), `707.9` (`L130`, `missing` → `partial`), `707.10` (`L131`, `missing` → `partial`), `707.10f` (`L137`, `missing` → `implemented`); major updates to `703.3`, `703.4i–m`, `704.5m`.

### `09-additional-rules-708-plus.md`
- **Updates:** `708.2a` (`L32`, `objectManaValue` returns `0` for face-down in `c0b068d` + `pendingZoneMoves` redaction in `c80f6a3`; Clone/token copy face-down leak remains open), `720.3c` (`L269`, `Solved —` no longer stripped in `5a4b8f2`), `733.4` (`L464`, `partial` → `implemented` via `CR 104.4b` mandatory loop draw in `1b18f91` + `778a8d0`).

### `10-multiplayer-commander.md`
- **Top Gaps (`L7–15`):** **6 resolved** (`#1` `903.9b` commander bounce/tuck prompt `8978023`, `#2` `903.3d` commander IR predicates `5e4b339`, `#3` `903.4f` colorless commander identity mana `2f93b65`, `#4` `800.4a/c` leaving-game stolen permanents & stack cleanup `b2c3995`, `#5` `800.4j` mid-turn active-player elimination `b2c3995`, `#9` `802.4/802.5` blocker TBA & damage prompt `ffe25b6` + `4e55737`).
- **Status Upgrades:** `800.4c` (`L34`, `missing` → `implemented`), `800.4j` (`L41`, `missing` → `implemented`), `903.4f` (`L133`, `missing` → `implemented`), `903.9b` (`L146`, `partial` → `implemented`); `800.4a` (`L32`) and `903.3d` (`L125`) substantially upgraded.

---

## 4. Deleted File Citations & `## Legacy-only findings (verify after step F)` Audit

### 4.1 Deleted Files & Symbols Still Cited as Active in `01`–`10`
1. **`compiler/adapter.ts` (`adaptCard`, `adaptKeywordLine`) — DELETED in Step F (`e19ac12`):**
   - Still cited on **283 lines** across `02` (`24` lines), `03` (`2` lines), `04` (`1` line), `05` (`5` lines), `06` (`90` lines), `07` (`111` lines), `08` (`4` lines), and `09` (`46` lines). All keyword/card compilation now lives in `compiler/card.ts` and `compiler/index.ts`.
2. **Deleted Legacy Functions & Action Cases (`executeParsedEffect`, `parseSpellOrAbilityEffects`, `parseActivatedAbilities`, `parseStructuredTriggeredAbilities`, `getCardExtraLandPlays`, `cardEntersAsCopyOfAnyCreature`, `spellExilesSelfOnResolution`, `cardHasPrintedUnblockable`, `evaluateActionNode`, `collectActiveBoardHooks`, `parseSuspendClause`, `detectTargetRequirement`):**
   - Cited across dozens of rows in `01`–`10`, including line numbers `> 600` in `oracle.ts` (now 595 lines) and `ruleTree.ts` (now 597 lines).

### 4.2 Disposition of All 39 `## Legacy-only findings (verify after step F)` Bullets (`01`–`10`)

Every single `## Legacy-only findings (verify after step F)` section at the bottom of `01` through `10` (**39 bullets total**: 4 in `01`, 6 in `02`, 4 in `03`, 7 in `04`, 3 in `05`, 4 in `06`, 3 in `07`, 2 in `08`, 3 in `09`, 3 in `10`) was audited against post-Step-F code:

- **36 of 39 bullets are 100% retired/migrated to IR** and can be deleted outright once their parent CR table rows cite the current IR compiler/runtime modules.
- **Only 3 bullets contain non-legacy details worth preserving in main table notes before deleting the sections:**
  1. **`01:357` (`CR 119.7–119.8`):** Note that turn-duration `PlayerGameState.lifeTotalCannotChangeThisTurn` (*Teferi's Protection*) and static `activeRuleModifiers(state, 'lifeTotalCantChange')` (*Platinum Emperion*) both remain in use and are checked consistently across damage, life changes, and Phyrexian mana payment.
  2. **`02:353` (`CR 202.1a, 202.3e–g`):** `parseManaCost` and `resolveFlexibleManaRequirement` in `oracle.ts` are intentionally retained shared mana utilities, not legacy parser debt.
  3. **`09:514` (`CR 714`):** While `oracle.ts:1723` was deleted, `compiler/objectFilter.ts` still does not recognize `'saga'` as an enchantment subtype (retain under `714.1` in `09`).
