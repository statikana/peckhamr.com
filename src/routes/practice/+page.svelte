<script lang="ts">
// @ts-nocheck
// 
import { onMount } from "svelte";

// --- types ---
interface Word {
    chinese: string;
    pinyin: string; 
    type: string;
    english: string;
    source: string;
}

type Side = "chinese" | "english" | "pinyin";

// --- props ---

let filePaths = import.meta.glob("/static/vocab/*.csv");
let serverFiles = $state([]);

// --- state ---
let loadedFiles = $state<{ name: string; words: Word[]; fromServer: boolean }[]>([]); 
let activeFileNames = $state<Set<string>>(new Set());
let loadingServerFile = $state<string | null>(null); 

let cardIndex = $state(0);
let flipped = $state(false);
let shuffled = $state(false);
let dragOver = $state(false); 
let shuffleOrder = $state<number[]>([]);
let knownSet = $state<Set<number>>(new Set());
let showKnownOnly = $state(false);

// UPDATED: Individual side selection state 
let frontSide = $state<Side>("chinese");
let backSide = $state<Side>("english");

// UPDATED: Side-specific Pinyin toggles
let showPinyin = $state({
    front: true,
    back: false
});

const sides: Side[] = ["chinese", "english", "pinyin"]; 

let localFiles = $derived(loadedFiles.filter(f => !f.fromServer));

// UPDATED: Logic to use individual side state 
let face = $derived(flipped ? backSide : frontSide);
let currentPinyinVisible = $derived(flipped ? showPinyin.back : showPinyin.front);

// --- derived ---
let allWords = $derived( 
    loadedFiles
        .filter((f) => activeFileNames.has(f.name))
        .flatMap((f) => f.words)
);

let displayWords = $derived((() => { 
    let base = allWords
        .map((w, i) => ({ w, originalIndex: i }))
        .filter(({ originalIndex }) => !showKnownOnly || !knownSet.has(originalIndex));
    if (!shuffled) return base;
    if (shuffleOrder.length !== base.length) return base;
    return shuffleOrder.map((i) => base[i]).filter(Boolean);
})());

let currentEntry = $derived(displayWords[cardIndex] ?? null); 
let current = $derived(currentEntry?.w ?? null);

let progress = $derived(displayWords.length > 0 ? cardIndex + 1 : 0); 
let knownCount = $derived(knownSet.size);

// --- csv parsing ---
function parseCSV(text: string, filename: string): Word[] { 
    console.log("parse csv", filename);
    const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
    const words: Word[] = []; 
    const isHeader = (line: string) =>
        /chinese|pinyin|english|word|type|definition/i.test(line.split(",")[0]);
    const start = isHeader(lines[0]) ? 1 : 0; 
    for (let i = start; i < lines.length; i++) {
        const parts = splitCSVLine(lines[i]);
        if (parts.length < 2) continue; 
        words.push({
            chinese: parts[0]?.trim() ?? "",
            pinyin:  parts[1]?.trim() ?? "",
            type:    parts[2]?.trim() ?? "",
            english: parts[3]?.trim() ?? parts[2]?.trim() ?? "",
            source:  filename,
        });
    } 
    return words;
}

function splitCSVLine(line: string): string[] {
    const result: string[] = [];
    let cur = ""; 
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { inQuotes = !inQuotes; continue; } 
        if (c === "," && !inQuotes) { result.push(cur); cur = ""; continue; }
        cur += c;
    }
    result.push(cur);
    return result;
}

async function loadLocalFiles(files: FileList | File[]) {
    const arr = Array.from(files);
    for (const file of arr) {
        if (!file.name.endsWith(".csv")) continue;
        if (loadedFiles.some((f) => f.name === file.name)) continue;
        const text = await file.text(); 
        const words = parseCSV(text, file.name);
        if (words.length === 0) continue;
        loadedFiles = [...loadedFiles, { name: file.name, words, fromServer: false }];
        activeFileNames = new Set([...activeFileNames, file.name]);
    }
    resetCard();
}

async function toggleServerFile(filename: string) {
    const already = loadedFiles.find((f) => f.name === filename);
    if (already) {
        toggleFile(filename); 
        return;
    }
    loadingServerFile = filename;
    try { 
        const fileRes = await fetch(`/vocab/${encodeURIComponent(filename)}`);
        const text = await fileRes.text();
        const words = parseCSV(text, filename); 
        if (words.length > 0) {
            loadedFiles = [...loadedFiles, { name: filename, words, fromServer: true }];
            activeFileNames = new Set([...activeFileNames, filename]); 
            resetCard();
        }
    } catch (e) {
        console.error("Failed to load server file:", filename, e);
    } finally { 
        loadingServerFile = null;
    } 
}

async function toggleAllServerFiles() {
    const allActive = serverFiles.every(sf => activeFileNames.has(sf));
    if (allActive) { 
        for (const sf of serverFiles) activeFileNames.delete(sf);
        activeFileNames = new Set(activeFileNames);
    } else { 
        for (const sf of serverFiles) {
            if (!activeFileNames.has(sf)) await toggleServerFile(sf);
        } 
    }
    resetCard();
}

function removeFile(name: string) {
    loadedFiles = loadedFiles.filter((f) => f.name !== name);
    activeFileNames.delete(name); 
    activeFileNames = new Set(activeFileNames);
    resetCard();
}

function toggleFile(name: string) {
    if (activeFileNames.has(name)) { activeFileNames.delete(name); 
    } 
    else { activeFileNames.add(name); }
    activeFileNames = new Set(activeFileNames);
    resetCard();
} 

function resetCard() {
    cardIndex = 0;
    flipped = false;
    knownSet = new Set();
    rebuildShuffle();
} 

function rebuildShuffle() {
    const len = displayWords.length;
    const arr = Array.from({ length: len }, (_, i) => i); 
    for (let i = arr.length - 1; i > 0; i--) { 
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]]; 
    }
    shuffleOrder = arr;
} 

function next() { if (cardIndex < displayWords.length - 1) { cardIndex++; flipped = false; } } 
function prev() { if (cardIndex > 0) { cardIndex--; flipped = false; } }
function flip() { flipped = !flipped; } 

function markKnown() {
    if (!currentEntry) return;
    knownSet = new Set([...knownSet, currentEntry.originalIndex]);
    if (cardIndex >= displayWords.length - 1) { 
        cardIndex = Math.max(0, displayWords.length - 2);
    } 
    flipped = false;
}

function toggleShuffle() {
    shuffled = !shuffled;
    if (shuffled) rebuildShuffle();
    cardIndex = 0; 
    flipped = false;
}

onMount(() => {
    const handler = (e: KeyboardEvent) => {
        if (e.target instanceof HTMLInputElement) return;
        if (e.key === "ArrowRight" || e.key === "l") next();
        else if (e.key === "ArrowLeft" || e.key === "h") prev();
        else if (e.key === " " || e.key === "f") { e.preventDefault(); flip(); }
        else if (e.key === "k") markKnown();
    }; 
    window.addEventListener("keydown", handler);

    console.log(filePaths);
    for (const path in filePaths) {
        // console.log("PATH", path);
        let filename = path.substring(path.lastIndexOf('/') + 1);
        serverFiles.push(filename);
        // const data_p = fetch(path)
        //     .then(data => data.text())
        //     .then(text => parseCSV(text, filename))
        //     .then(result => serverFiles.push(result));

    }
    console.log(serverFiles);
    return () => window.removeEventListener("keydown", handler);
});
</script>

<div id="page">
    <header>
        <a href="/" class="back">guest@peckhamr.com&gt;</a>
        <span class="title">/practice</span>
    </header>

    <section class="panel">
        <div class="panel-label">files</div>
        {#if serverFiles.length > 0}
            <div class="sub-header-row">
                <div class="sub-label">from server</div>
                <button class="text-link-btn" onclick={toggleAllServerFiles}> 
                    {serverFiles.every(sf => activeFileNames.has(sf)) ? "deselect all" : "select all"} 
                </button>
            </div>
            <div class="file-chips">
                {#each serverFiles as sf}
                    {@const isLoaded = loadedFiles.some(f => f.name === sf)}
                    {@const isActive = activeFileNames.has(sf)} 
                    {@const isLoading = loadingServerFile === sf}
                    <div class="chip chip-server" class:chip-inactive={isLoaded && !isActive} onclick={() => toggleServerFile(sf)}>
                        <span class="server-dot" class:dot-on={isActive}></span>
                        <span class="chip-name">{isLoading ? "loading..." : sf}</span>
                    </div>
                {/each}
            </div>
            <div class="divider"></div>
        {/if}

        <div class="sub-label">upload local</div>
        
        <div class="drop-zone" class:drag-active={dragOver}
            ondrop={(e) => { e.preventDefault(); dragOver = false; if (e.dataTransfer?.files) loadLocalFiles(e.dataTransfer.files); }}
            ondragover={(e) => { e.preventDefault(); dragOver = true; }} 
            ondragleave={() => dragOver = false}
            onclick={() => document.getElementById("file-input").click()}
        >
            <span class="drop-hint">{dragOver ? "drop to load" : "drag csv files here / click to browse"}</span> 
            <input id="file-input" type="file" accept=".csv" multiple style="display:none" onchange={(e) => loadLocalFiles(e.target.files)} />
        </div>

        {#if localFiles.length > 0}
            <div class="file-chips" style="margin-top: 0.6rem;">
                {#each localFiles as file}
                    <div class="chip" class:chip-inactive={!activeFileNames.has(file.name)}> 
                        <span class="chip-name" onclick={() => toggleFile(file.name)}>
                            {file.name}<span class="chip-count"> ({file.words.length})</span>
                        </span>
                        <span class="chip-remove" onclick={() => removeFile(file.name)}>✕</span> 
                    </div>
                {/each}
            </div>
        {/if}
    </section>

    {#if allWords.length > 0}
    <section class="panel controls-panel">
        <div class="panel-label">options</div>
        <div class="controls-row"> 

            <div class="control-group">
                <span class="ctrl-label">front</span>
                <div class="btn-group">
                    {#each sides as s}
                        <button class="ctrl-btn" class:active={frontSide === s} onclick={() => {frontSide = s; flipped = false}}>{s}</button>
                    {/each}
                </div>
            </div>

            <div class="control-group">
                <span class="ctrl-label">back</span>
                <div class="btn-group">
                    {#each sides as s} 
                        <button class="ctrl-btn" class:active={backSide === s} onclick={() => {backSide = s; flipped = false}}>{s}</button> 
                    {/each}
                </div>
            </div>

            <div class="control-group">
                <span class="ctrl-label">pinyin on</span>
                <div class="btn-group">
                    <button class="ctrl-btn" class:active={showPinyin.front} onclick={() => showPinyin.front = !showPinyin.front}>front</button> 
                    <button class="ctrl-btn" class:active={showPinyin.back} onclick={() => showPinyin.back = !showPinyin.back}>back</button>
                </div>
            </div>

            <div class="control-group">
                <button class="ctrl-btn" class:active={shuffled} onclick={toggleShuffle}>shuffle {shuffled ? "on" : "off"}</button>
                <button class="ctrl-btn" class:active={showKnownOnly} onclick={() => { showKnownOnly = !showKnownOnly; cardIndex = 0; flipped = false; }}> 
                    {showKnownOnly ? "show all" : "hide known"} 
                </button>
                <button class="ctrl-btn" onclick={resetCard}>reset</button>
            </div>
        </div>
    </section>

    {#if displayWords.length > 0 && current}
        <section class="card-section">
            <div class="progress-line">
                <span class="prog-num">{progress} / {displayWords.length}</span> 
                <div class="prog-bar-bg"><div class="prog-bar-fill" style="width: {(progress / displayWords.length) * 100}%"></div></div>
                <span class="prog-src">{current.source}</span>
            </div>

            <div class="card-wrap" onclick={flip}>
                <div class="card" class:is-flipped={flipped}>
                    <div class="card-face"> 
                        {#if face === "chinese"}
                            <span class="face-label">chinese</span>
                            <span class="face-main face-zh">{current.chinese}</span> 
                            {#if currentPinyinVisible}<span class="face-sub">{current.pinyin}</span>{/if}
                            {#if current.type}<span class="pos-tag">{current.type}</span>{/if}
                        {:else if face === "english"}
                            <span class="face-label">english</span> 
                            <span class="face-main">{current.english}</span>
                            {#if currentPinyinVisible && current.pinyin}<span class="face-sub">{current.pinyin}</span>{/if}
                            {#if flipped && current.type}<span class="pos-tag">{current.type}</span>{/if} 
                        {:else}
                            <span class="face-label">pinyin</span>
                            <span class="face-main">{current.pinyin}</span>
                            {#if current.type}<span class="pos-tag">{current.type}</span>{/if} 
                        {/if}
                        {#if !flipped}<span class="tap-hint">click to reveal</span>{/if}
                    </div>
                </div> 
            </div>

            <div class="nav-row">
                <button class="nav-btn" onclick={prev} disabled={cardIndex === 0}>← prev</button>
                <button class="nav-btn known-btn" onclick={markKnown}>mark known</button>
                <button class="nav-btn" onclick={next} disabled={cardIndex >= displayWords.length - 1}>next →</button> 
            </div>
        </section>
    {:else}
        <div class="empty-state">no cards to show — all marked known?</div>
    {/if}
    {/if}
</div>

<style>
/* ... include all styles from previous response ... */
#page {
    min-height: 100vh;
    background-color: #242426; 
    font-family: monospace;
    font-size: 14px;
    color: #ffffffcc;
    padding: 2rem 1.5rem;
    box-sizing: border-box;
    max-width: 720px;
    margin: 0 auto;
} 

header { display: flex; align-items: baseline; margin-bottom: 2rem; font-size: 14px; }
.back { color: rgb(155, 232, 177); text-decoration: none; } 
.back:hover { text-decoration: underline; }
.title { color: #efa368; }

.panel {
    border: 1px solid #ffffff18;
    border-radius: 4px;
    padding: 1rem 1.25rem; 
    margin-bottom: 1.25rem;
    position: relative;
}
.panel-label {
    position: absolute;
    top: -0.6em;
    left: 1rem;
    background: #242426;
    padding: 0 0.4rem; 
    font-size: 11px;
    color: #efa368;
    letter-spacing: 0.12em;
    text-transform: uppercase;
}

.sub-header-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline; 
    margin-bottom: 0.5rem;
}

.sub-label {
    font-size: 11px;
    color: #ffffff28;
    text-transform: uppercase;
    letter-spacing: 0.1em;
} 

.text-link-btn {
    background: none;
    border: none;
    color: #efa368;
    font-family: monospace;
    font-size: 11px;
    text-transform: uppercase;
    cursor: pointer;
    padding: 0; 
    opacity: 0.6;
}
.text-link-btn:hover { opacity: 1; text-decoration: underline; }

.divider { border-top: 1px solid #ffffff10; margin: 0.85rem 0; } 

.drop-zone {
    border: 1px dashed #ffffff22;
    border-radius: 3px;
    padding: 1rem;
    text-align: center;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s; 
}
.drop-zone:hover, .drag-active { border-color: #efa368; background: #efa36810; }
.drop-hint { color: #ffffff38; font-size: 13px; } 
.drag-active .drop-hint { color: #efa368; }

.file-chips { display: flex; flex-wrap: wrap; gap: 6px; }

.chip {
    display: flex;
    align-items: center; 
    gap: 6px;
    border: 1px solid #efa36855;
    border-radius: 3px;
    padding: 2px 8px;
    font-size: 12px;
    color: #efa368;
    transition: opacity 0.15s;
} 
.chip-inactive { opacity: 0.35; border-color: #ffffff22; color: #ffffff50; }

.chip-server {
    border-color: #ffffff20;
    color: #ffffff55;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s; 
}
.chip-server:hover { border-color: #efa36860; color: #efa368; }

.server-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%; 
    background: #ffffff20;
    flex-shrink: 0;
    transition: background 0.15s;
}
.dot-on { background: rgb(155, 232, 177); }

.chip-name { cursor: pointer; } 
.chip-count { color: #ffffff45; }
.chip-remove { cursor: pointer; color: #ffffff28; font-size: 10px; }
.chip-remove:hover { color: #de81c7; }

.file-meta { margin-top: 0.6rem;
    font-size: 12px; color: #ffffff30; } 

.controls-panel { padding-bottom: 0.75rem; }
.controls-row { display: flex; flex-wrap: wrap; gap: 0.75rem 1.25rem; align-items: center; } 
.control-group { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

.ctrl-label {
    font-size: 11px;
    color: #ffffff30;
    text-transform: uppercase; 
    letter-spacing: 0.1em;
}

.btn-group { display: flex; }
.btn-group .ctrl-btn { border-radius: 0; } 
.btn-group .ctrl-btn:first-child { border-radius: 3px 0 0 3px; }
.btn-group .ctrl-btn:last-child { border-radius: 0 3px 3px 0; border-right-width: 1px; } 
.btn-group .ctrl-btn:not(:last-child) { border-right-width: 0; }

.ctrl-btn {
    background: transparent;
    border: 1px solid #ffffff1e;
    border-radius: 3px;
    color: #ffffff50;
    font-family: monospace; 
    font-size: 12px;
    padding: 3px 10px;
    cursor: pointer;
    transition: all 0.12s;
}
.ctrl-btn:hover { border-color: #efa36870; color: #efa368; } 
.ctrl-btn.active { background: #efa36818; border-color: #efa368; color: #efa368; }

/* .hint-row { display: flex; gap: 1.5rem; margin-top: 0.75rem; }
.hint { font-size: 11px;
    color: #ffffff20; }  */

.card-section { display: flex; flex-direction: column; gap: 1rem; }

.progress-line { display: flex; align-items: center; gap: 0.75rem; font-size: 12px; } 
.prog-num { color: #efa368; min-width: 5ch; }
.prog-bar-bg { flex: 1; height: 2px; background: #ffffff10; border-radius: 1px; overflow: hidden; } 
.prog-bar-fill { height: 100%; background: #efa368; border-radius: 1px; transition: width 0.25s; }
.prog-src { color: #ffffff1e; font-size: 11px; text-align: right;
    max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } 

.card-wrap { cursor: pointer; user-select: none; } 

.card {
    border: 1px solid #ffffff18;
    border-radius: 4px;
    min-height: 220px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: border-color 0.15s, background 0.15s; 
    background: #1e1e20;
}
.card:hover { border-color: #ffffff2a; }
.card.is-flipped { border-color: #efa36840; background: #efa3680a; } 

.card-face {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2rem;
    width: 100%;
    text-align: center; 
    position: relative;
}

.face-label { font-size: 11px; color: #ffffff25; text-transform: uppercase; letter-spacing: 0.12em; }
.face-main { font-size: 1.6rem; color: #ffffff;
    line-height: 1.25; font-weight: normal; } 
.face-zh { font-size: 2.8rem; color: #efa368; }
.face-sub { font-size: 1rem; color: rgb(155, 232, 177); } 
.pos-tag {
    font-size: 11px;
    border: 1px solid #ffffff12;
    border-radius: 2px;
    padding: 1px 6px;
    color: #ffffff28;
    margin-top: 0.25rem;
} 
.tap-hint { position: absolute; bottom: 1rem; font-size: 11px; color: #ffffff14; }

.nav-row { display: flex; gap: 8px; }
.nav-btn {
    flex: 1;
    background: transparent;
    border: 1px solid #ffffff18;
    border-radius: 3px;
    color: #ffffff42;
    font-family: monospace;
    font-size: 13px; 
    padding: 8px 0;
    cursor: pointer;
    transition: all 0.12s;
}
.nav-btn:hover:not(:disabled) { border-color: #efa36870; color: #efa368; }
.nav-btn:disabled { opacity: 0.16;
    cursor: default; } 

.known-btn { border-color: #de81c725; color: #de81c750; }
.known-btn:hover:not(:disabled) { border-color: #de81c7; color: #de81c7; background: #de81c710; }

.empty-state { text-align: center;
    color: #ffffff25; padding: 3rem 0; font-size: 13px; } 
</style>