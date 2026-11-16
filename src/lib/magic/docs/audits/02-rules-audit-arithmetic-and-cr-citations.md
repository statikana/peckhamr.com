# 02 — Audit of `rules-audit/` Arithmetic, Table Integrity & CR Citations

**Audited:** 2026-11-12 against [`src/lib/rules.txt`](../../../rules.txt) (effective 2026-11-06) and [`rules-audit/00`–`10`](../rules-audit/00-SUMMARY-AND-PRIORITIZED-GAPS.md)

---

## 1. Summary Table Arithmetic & Unit Mismatches (`00-SUMMARY` §1 vs. `01`–`10` vs. `src/lib/rules.txt`)

### 1.1 Master Reconciliation Table (Pre-Fix Statuses as Written in `01`–`10`)

[`00-SUMMARY-AND-PRIORITIZED-GAPS.md`](../rules-audit/00-SUMMARY-AND-PRIORITIZED-GAPS.md) §1 (`L9–21`, also copied into [`README.md:13`](../README.md#L13) and [`FULL_COVERAGE_STRUCTURE.md:31`](../FULL_COVERAGE_STRUCTURE.md#L31)) claims **`585 implemented / 432 partial / 1,082 missing / 466 N/A = 2,565 subrules`**. Auditing every row of `01`–`10` against `src/lib/rules.txt` (`L183–7145`, which actually contains **3,182 numbered rules/subrules**) exposes two systemic defects:

1. **Incommensurable units summed in one column:** Sections `01`, `03`, `04`, `06`, `07`, `08`, `09`, `10` attempted to report **expanded CR subrule counts**, whereas `02` (`263`) and `05` (`104`) reported **markdown table row/group counts** (`02` covers 362 rules; `05` covers 341 subrules). Summing them produces a hybrid `2,565` figure that represents neither rows (`1,560` actual rows) nor CR rules (`2,988` actual numbered rules/subrules in `src/lib/rules.txt:183–7145`).
2. **Severe counting/addition errors inside 5 of the 10 files (`01`, `02`, `03`, `06`, `10`):**

| Sec | File | Claimed in File Header & `00-SUMMARY` (`Impl / Part / Miss / N/A = Total`) | Actual Markdown Table Rows (`Impl / Part / Miss / N/A = Rows`) | Actual Expanded CR Rules in Table (`Impl / Part / Miss / N/A = Rules`) | Real Rules in `rules.txt` | Arithmetic Verdict |
| :--- | :--- | :--- | :--- | :--- | ---: | :--- |
| **01** | `01-game-concepts.md` | `210 / 79 / 124 / 90 = 503` | `83 / 49 / 40 / 23 = 195` | `209 / 79 / 123 / 87 = 498` valid *(+5 non-existent CRs = 503 tokens)* | **506** (`L183–1278`) | **Mismatch:** 5 hallucinated CRs counted; 8 real CRs omitted (`498 + 8 = 506`). |
| **02** | `02-card-parts-types-zones.md` | `92 / 42 / 64 / 65 = 263` rows *(362 rules)* | **`94 / 31 / 31 / 20 = 176`** | `163 / 41 / 85 / 77 = 366` entries across `359` unique rules | **362** (`L1279–2113`) | **MAJOR ERROR:** Off by **87 rows** (`42/64/65` match neither rows nor rules); 7 rules duplicated across rows, 3 omitted. |
| **03** | `03-turn-structure.md` | `42 / 43 / 48 / 6 = 139` *(header also says 96 rows)* | `32 / 36 / 22 / 6 = 96` | **`43 / 45 / 56 / 6 = 150`** | **150** (`L2114–2455`) | **Mismatch:** Row count (`96`) exact, but expanded subrules undercounted by **11**. |
| **04** | `04-spells-abilities-effects.md` | `91 / 113 / 100 / 15 = 319` | `67 / 60 / 56 / 10 = 193` | `91 / 113 / 100 / 15 = 319` | **319** (`L2456–3203`) | **Exact** on expanded subrules. |
| **05** | `05-general-and-keyword-actions.md` | `17 / 12 / 67 / 8 = 104` *(row groups)* | `17 / 12 / 67 / 8 = 104` | `40 / 33 / 246 / 22 = 341` | **341** (`L3204–3911`) | **Exact** on row groups *(reports 104 groups instead of 341 subrules)*. |
| **06** | `06-keyword-abilities-1.md` | `56 / 42 / 153 / 11 = 262` | `64 / 27 / 75 / 5 = 171` | **`65 / 29 / 178 / 5 = 277`** | **277** (`L3912–4654`) | **MAJOR ERROR:** Wrong in all 5 columns (`+9 / -13 / +25 / -6 = +15` subrules; states 56 `implemented` despite 64 single-rule `implemented` rows). |
| **07** | `07-keyword-abilities-2.md` | `12 / 11 / 261 / 18 = 302` | `12 / 11 / 106 / 7 = 136` | `12 / 11 / 261 / 18 = 302` | **302** (`L4655–5487`) | **Exact** on expanded subrules. |
| **08** | `08-tba-sba-copy.md` | `21 / 28 / 52 / 13 = 114` | `21 / 28 / 36 / 9 = 94` | `21 / 28 / 52 / 13 = 114` | **114** (`L5488–5751`) | **Exact** on expanded subrules. |
| **09** | `09-additional-rules-708-plus.md` | `19 / 45 / 204 / 46 = 314` | `19 / 45 / 204 / 46 = 314` | `19 / 45 / 204 / 46 = 314` | **314** (`L5752–6455`) | **Exact** on both rows and subrules (1:1). |
| **10** | `10-multiplayer-commander.md` | `25 / 17 / 9 / 194 = 245` | `27 / 21 / 12 / 21 = 81` | **`32 / 21 / 12 / 238 = 303`** | **303** (`L6456–7145`) | **MAJOR ERROR:** Wrong in all 5 columns (`+7 / +4 / +3 / +44 = +58` subrules; N/A subrules alone sum to `238`, nearly exceeding stated `245` total). |
| **Sum** | **`CR 100–905`** | **`585 / 432 / 1,082 / 466 = 2,565`** | **`436 / 320 / 649 / 155 = 1,560`** | **`695 / 445 / 1,317 / 527 = 2,984`** *(with `02` duplicates)* | **2,988** | **Summary table mixes units and mis-adds 5 sections.** |

*(Note on `rules.txt:183–7145` total: `src/lib/rules.txt` has `3,183` `NNN.N*` lines; excluding the `195` `702.2–702.196` keyword title headers that `06` and `07` use as `###` headings yields exactly `2,988` substantive rules/subrules.)*

### 1.2 Structural & Coverage Defects in `01` and `02`

1. **`01-game-concepts.md` — 5 Non-Existent CR Subrules & 8 Omitted Real CR Subrules:**
   - **Fabricated / Non-Existent CR Numbers:**
     - `122.3a` (`01:322`, marked `implemented`) — `CR 122.3` (`rules.txt:1205`) has no lettered subrules.
     - `122.6b` (`01:326`, marked `missing`) — `CR 122.6` (`rules.txt:1211–1213`) only has `122.6a`.
     - `123.4a`, `123.7b`, `123.8b` (`01:333`, marked `N/A`) — none of these subrules exist (`rules.txt:1244, 1271, 1275`).
   - **Omitted Real CR Numbers:**
     - `121.3a` (`rules.txt:1159`), `121.9` (`1177`), `122.1j` (`1201`, hone counter), `122.9` (`1219`), `123.5c` (`1251`), `123.6c` (`1260`), `123.6d` (`1265`), `123.6e` (`1267`).
2. **`02-card-parts-types-zones.md` — Contradictory Overlapping Rows, Non-Standard Status Strings & Omitted Parent Rules:**
   - **Non-standard status strings** break simple counting: `'implemented (definitional)'` (`L28`), `'implemented (N/A)'` (`L212`), `'N/A (definition)'` (`L66, 99, 136`).
   - **Overlapping rules with contradictory statuses:**
     - `201.1–201.2` (`L34`, `implemented`) overlaps `201.2a` (`L35`, `partial`) and `201.2b–201.2c` (`L36`, `missing`).
     - `207.1–207.2, 207.2a–b` (`L105`, `implemented`) overlaps `207.2c–d` (`L106`, `implemented`) if `207.2` denotes the whole rule.
     - `300.1–300.2` (`L143`, `implemented`) overlaps `300.2a` (`L144`, `partial`) and `300.2b` (`L145`, `implemented`).
   - **Omitted parent rules:** `205.2` (`rules.txt:1402`), `205.3` (`1410`), and `205.4` (`1471`) are omitted (only their lettered subrules appear).

### 1.3 `rules.txt` Line-Range Citation Error (`00-SUMMARY` & `10-multiplayer-commander.md`)
- `00-SUMMARY:3, 20` and `10-multiplayer-commander.md:1` cite `lines 183–7151` / `lines 6456–7151`.
- In `src/lib/rules.txt`, `CR 905.6` (the final numbered rule) ends at **line `7145`** (`7146` is blank; `7147` is the `Glossary` header; `7149–7151` is the glossary definition of `Abandon`). All other section line boundaries (`01` through `09`) are exact.

---

## 2. Wrong & Scrambled Comprehensive Rules Citations

### 2.1 Seven Wrong CR Citations in `ENGINE_INVARIANTS.md`

| Location | Citation in `ENGINE_INVARIANTS.md` | What That Rule Actually Is in `src/lib/rules.txt` | Correct CR Citation |
| :--- | :--- | :--- | :--- |
| `L19` | `"Partner with [Name]" (CR 702.124f)` | `702.124f` (`L4949`) states different partner abilities cannot be combined | **`CR 702.124j`** (`L4957`) |
| `L58` | `Exception (CR 400.7b): A permanent spell resolving from stack to battlefield retains choices made on cast (enteredWithX, castViaSuspend)` | `400.7b` (`L1961`) covers continuous effects from static abilities applying to a permanent spell | **`CR 400.7d`** (`L1965`) + **`CR 107.3m`** (`L489` for `{X}`) |
| `L76` *(also `L70`)* | `Self-replacement effects apply first (CR 614.16)` | `614.16` (`L3132`) covers token/counter multipliers (*Doubling Season*) | **`CR 614.15`** (`L3130`, definition) & **`CR 616.1a`** (`L3183`, ordering) |
| `L99, 102` | `mana pool empties at the end of every step and phase (CR 106.4 / 500.4)` | `500.4` (`L2124`) covers effects expiring at the *beginning* of a phase/step | **`CR 106.4 / 500.5`** (`L2126`) |
| `L115` | `sacrifice CR 701.19` | `701.19` (`L3438`) is **Regenerate** | **`CR 701.21`** (`L3459`, Sacrifice) |
| `L115` | `non-random discard CR 701.8` | `701.8` (`L3329`) is **Destroy** | **`CR 701.9`** (`L3337`, Discard) |
| `L115` | `proliferate CR 701.31` | `701.31` (`L3592`) is **Planeswalk** | **`CR 701.34`** (`L3616`, Proliferate) |

*(Related code comment miscitations spotted during verification: `src/lib/magic/runtime/wave4-cr-completion.test.ts:325–326` also cites `CR 701.31a` for Proliferate, and `src/lib/magic/oracle.ts:404` cites `CR 701.19b` instead of `CR 701.23b` for library search fail-to-find.)*

### 2.2 Scrambled CR Citations in `01-game-concepts.md` (Especially `### 122 Counters`)

In `01-game-concepts.md`, almost every subrule of **`CR 122` (`L317–327, 353, 358`)** plus several entries in `113`, `120`, and `121` are mapped to the **wrong CR rule text** (causing implemented rules to be marked `missing` and unimplemented rules to be marked `implemented`):

| `01-game-concepts.md` Line & Rule | What `01-game-concepts.md` Claims the Rule Is | Actual Rule in `src/lib/rules.txt` & True Engine Status |
| :--- | :--- | :--- |
| `L109, 343` (`106.5` note) | Cites `CR 903.9` for Command Tower with colorless commander | `903.9` (`L7021`) is commander zone return; colorless commander identity mana is **`CR 903.4f`** (`L6998`). |
| `L122` (`107.1c`) | `"Up to" target and search counts` | `107.1c` (`L458`) is `"any number"` allowing `0`; `"up to"` targets are `CR 115.6`. |
| `L206` (`113.2c`, marked `missing`) | `Emblem abilities (CR 114 not implemented)` | `113.2c` (`L756`) is **paragraph breaks separating abilities on a card** (**`implemented`** in `compiler/normalize.ts`!); emblem abilities are `CR 113.6p` / `114.2`. |
| `L301` (`120.6, 120.7`) | Claims `120.6` is lethal/deathtouch SBA and `120.7` is cleanup damage removal | `120.6` (`L1133`) is damage remaining marked until cleanup; **`120.7`** (`L1135`) is **choosing/determining the source of damage** (`partial`/`missing`). |
| `L303` (`120.10`) | `multi-source simultaneous damage` | **`120.10`** (`L1141`) is **triggered abilities checking excess damage dealt to a permanent** (`missing`). |
| `L310, 351` (`121.2b`, marked `partial`) | `"Whenever you draw a card"` / `"second card"` triggers | **`121.2b`** (`L1151`) is **`"can't draw more than one card each turn"` restrictions** (*Narset*), which are **`missing`**! |
| `L311` (`121.2c, 121.2d`) | Claims `121.2d` is `"revealing the first card drawn each turn (Miracle)"` | **`121.2c`** (`L1153`) is APNAP draw order for multiple players; **`121.2d`** (`L1155`) is **Shared Team Turns (`N/A`)** (revealing first card drawn is `121.7` / `702.94`). |
| `L317` (`122.1d`) | `loyalty counters track planeswalker loyalty (122.1d)` | **`122.1d`** (`L1189`) is **stun counters**; loyalty counters are **`122.1e`** (`L1191`). |
| `L320` (`122.1e`, marked `partial`) | `'lore' counter type ... Saga chapter triggers` | **`122.1e`** (`L1191`) is **planeswalker loyalty counters** (**`implemented`**; Saga lore counters are `CR 714`). |
| `L321` (`122.1f–i`, marked `missing`) | `Finality (122.1f), defense (122.1g), rad (122.1h), blessing (122.1i)` | **`122.1f`** (`L1193`) is **10+ poison counters SBA** (**`implemented`**!); `122.1g` = defense, `122.1h` = finality, `122.1i` = rad, `122.1j` = hone (omitted), and `"blessing counters"` is not in `122.1`. |
| `L323` (`122.4`, marked `implemented`) | Stun counter untap replacement | **`122.4`** (`L1207`) is **`"can't have more than N [kind] counters"` (`CR 704.5r`)**, which is **`missing`**! |
| `L324` (`122.5`, marked `partial`) | `removeCounter` cost/effect | **`122.5`** (`L1209`) is **`"move a counter"` from one object to another**, which is **`missing`**! |
| `L326` (`122.6b, 122.8`) | Claims `122.8` is `"can't have counters put on it"` (*Solemnity*) | `122.6b` does not exist; **`122.8`** (`L1217`) is **LTB triggers putting an object's counters onto another object** (*The Ozolith* / Modular; *Solemnity* is `122.6`). |
| `L327, 353, 358` (`122.7`, marked `partial`) | Claims `122.7` is **Proliferate** | **`122.7`** (`L1215`) is **`"When/Whenever the Nth [kind] counter"` triggers** (`missing`); Proliferate is **`CR 701.34`**. |

### 2.3 Minor Citation & Rule Interpretation Defects in `00-SUMMARY` and `08`
1. **`00-SUMMARY:36`:** Cites `CR 119.7` for `lifeTotalCantChange` preventing life loss on combat damage. `119.7` (`rules.txt:1080`) is `"can't gain life"`; `"can't lose life"` is **`CR 119.8`** (`rules.txt:1082`) — cite `CR 119.7–119.8`.
2. **`08-tba-sba-copy.md:11, 66, 67` & `01-game-concepts.md:319` (`CR 122.1c` Shield Counters vs. `704.5g/h` SBAs):**
   - `08` claims `checkStateBasedActions` (`704.5g` lethal damage, `704.5h` deathtouch) violates `CR 122.1c` by not removing a shield counter instead of destroying the creature, while `01:319` claims `engine.ts` SBA lethal damage *does* check shield counters.
   - **Both are wrong:** `engine.ts:8108–8126` checks only `indestructible` (not `counters.shield`), **which is CR-correct** because `CR 122.1c` (`rules.txt:1187`) replaces `"would be destroyed as the result of an effect"` (not SBA destruction under `CR 704.5g/h`), as `00-SUMMARY:37` already notes. Only `regenerationShields` (`CR 701.19`) is a valid remaining gap on `704.5g/h`.
3. **`01-game-concepts.md:59, 338` & `03-turn-structure.md:51, 71` (`CR 103.8a/c` Turn-1 Draw Claim):**
   - Both claim `checkIfAllKeptMulligan` sets `phase = 'main1'` directly and skips Turn 1 draw even in 3+ player Commander.
   - **Factually false even at `917180b`** (verified by `engine.ts:476–482`, `shouldSkipFirstDraw` at `engine.ts:1388–1392`, and `runtime/wave4-cr-completion.test.ts:106–140`): `checkIfAllKeptMulligan` runs `runBeginningOfTurn` and advances `upkeep -> draw -> main1`, drawing for turn in 3+ player games and skipping Turn 1 draw in 2-player games (contradicting `03:186`, which described it accurately in the very same file).
