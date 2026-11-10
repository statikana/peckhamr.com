<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { appUrl } from '$lib/apps';

	interface NoteSummary {
		path: string;
		course: string;
		title: string;
		sha256: string;
		size_bytes: number;
		updated_at: number;
	}

	interface NoteFull extends NoteSummary {
		content: string;
	}

	interface SearchHit {
		path: string;
		course: string;
		course_code?: string;
		title: string;
		section_title?: string;
		wikilink?: string;
		excerpts?: string[];
		formulas?: string[];
		score?: number;
		snippet: string;
		updated_at: number;
	}

	interface RoutedTopic {
		course: string;
		course_code: string;
		slug: string;
		path: string;
		wikilink: string;
		summary: string;
		core_equations: string[];
	}

	interface HeadingItem {
		id: string;
		text: string;
		level: number;
	}

	let notesList = $state<NoteSummary[]>([]);
	let loadingTree = $state(true);
	let loadingNote = $state(false);
	let selectedPath = $state('');
	let currentNote = $state<NoteFull | null>(null);
	let showRaw = $state(false);
	let showAutoSuiteHub = $state(false);
	let activeHubCategory = $state('All');
	let hubAiQuery = $state('Explain the Hong-Ou-Mandel coincidence dip on a 50:50 beam splitter');
	let hubAiCourse = $state('all');
	let hubAiAnswerMarkdown = $state('');
	let hubAiRoutedTopics = $state<RoutedTopic[]>([]);
	let hubAiResults = $state<SearchHit[]>([]);
	let hubAiLoading = $state(false);
	let hubAiShowRaw = $state(false);
	let hubAiCopyStatus = $state('');
	let searchQuery = $state('');
	let searchHits = $state<SearchHit[]>([]);
	let searching = $state(false);
	let collapsedCourses = $state<Record<string, boolean>>({});
	let mobileSidebarOpen = $state(false);
	let copyStatus = $state('');
	let katexReady = $state(false);
	let theme = $state<'light' | 'dark'>('light');

	function applyTheme(next: 'light' | 'dark') {
		theme = next === 'dark' ? 'dark' : 'light';
		if (typeof document !== 'undefined') {
			document.documentElement.setAttribute('data-theme', theme);
		}
		try {
			localStorage.setItem('peckhamr-theme', theme);
		} catch {}
	}

	function toggleTheme() {
		applyTheme(theme === 'light' ? 'dark' : 'light');
	}

	const AUTO_SUITE_TOOLS = [
		{
			num: 1,
			id: 'todo_sync',
			title: 'Todoist & UMich Canvas Sync',
			category: 'Productivity & Sync',
			gpu: false,
			desc: 'Bidirectional Todoist <-> Obsidian TaskNotes sync and UMich Canvas .ics / cookie assignment import.',
			toolNote: 'Auto Suite/Tools/01 - Todoist & Canvas Sync.md',
			outputNote: 'Home.md'
		},
		{
			num: 2,
			id: 'note_router',
			title: 'Cosmo Note Router',
			category: 'GPU & Vision',
			gpu: true,
			desc: 'Classifies & transcribes handwritten notes from peckhamr.com/cosmo or iCloud into Obsidian LaTeX notes.',
			toolNote: 'Auto Suite/Tools/02 - iCloud & Handwritten Note Router.md',
			outputNote: 'quantum/notes/lecture_2026_11_04.md'
		},
		{
			num: 3,
			id: 'lecture_notes',
			title: 'Offline Lecture Video -> LaTeX Notes (GPU)',
			category: 'GPU & Vision',
			gpu: true,
			desc: 'Extracts slide keyframes via ffmpeg, transcribes audio offline with faster-whisper, and annotates slide math with Qwen2.5-VL-3B.',
			toolNote: 'Auto Suite/Tools/03 - Lecture Video to LaTeX Notes.md',
			outputNote: 'quantum/notes/lecture_2026_11_02.md'
		},
		{
			num: 4,
			id: 'tex_studio',
			title: 'Heavy LaTeX Live Studio & Resume Publisher',
			category: 'Career & LaTeX',
			gpu: false,
			desc: 'Compiles .tex documents in 0.04s, verifies 1-page overflow metrics, and publishes resume.pdf to peckhamr.com.',
			toolNote: 'Auto Suite/Tools/04 - Heavy LaTeX Live Studio & Publisher.md',
			outputNote: 'career/Portfolio.md'
		},
		{
			num: 5,
			id: 'career_tailor',
			title: 'Tailored Resume & Cover Letter Generator',
			category: 'Career & LaTeX',
			gpu: false,
			desc: 'Scores & reorders resume.tex experience bullets for target engineering tracks and writes tailored Obsidian cover letters.',
			toolNote: 'Auto Suite/Tools/05 - Career Resume & Cover Letter Tailor.md',
			outputNote: 'career/cover letters/Relativity Space.md'
		},
		{
			num: 6,
			id: 'pset_checker',
			title: 'Homework Step-by-Step SymPy Sanity Checker',
			category: 'Study & Math',
			gpu: false,
			desc: 'Verifies step-by-step symbolic equivalence across multi-line LaTeX derivations using SymPy and checks coverage against problem PDFs.',
			toolNote: 'Auto Suite/Tools/06 - Homework SymPy Sanity Checker.md',
			outputNote: 'Auto Suite/Reports/Homework 8 SymPy Report.md'
		},
		{
			num: 7,
			id: 'crib_gen',
			title: 'Exam Crib-Sheet / Formula Compiler',
			category: 'Study & Math',
			gpu: false,
			desc: 'Extracts all display & inline LaTeX equations and definitions from a UMich class folder into an Obsidian Crib Sheet.',
			toolNote: 'Auto Suite/Tools/07 - Exam Crib Sheet Compiler.md',
			outputNote: 'physics/Electricity & Magnetism Formula & Concept Crib Sheet.md'
		},
		{
			num: 8,
			id: 'lab_helper',
			title: 'Physics / CE Lab Curve Fitter & Error Propagator',
			category: 'Study & Math',
			gpu: false,
			desc: 'Computes exact symbolic partial-derivative error propagation in SymPy and weighted SciPy curve fits with ready-to-paste LaTeX.',
			toolNote: 'Auto Suite/Tools/08 - Lab Curve Fitter & Error Propagator.md',
			outputNote: 'Auto Suite/Reports/Lab Error Propagation.md'
		},
		{
			num: 9,
			id: 'guitar2tab',
			title: 'Local Guitar-to-Tab Transcriber',
			category: 'Creative & Audio',
			gpu: false,
			desc: 'Live microphone capture or audio file -> HPSS harmonic isolation, polyphonic pitch tracker, and Viterbi fretboard solver -> ASCII Tab.',
			toolNote: 'Auto Suite/Tools/09 - Local Guitar-to-Tab Transcriber.md',
			outputNote: 'Auto Suite/Guitar Tabs/Knockin on Heavens Door Tab.md'
		},
		{
			num: 10,
			id: 'backpack_planner',
			title: 'UMich CE + Physics Course & Prerequisite Planner',
			category: 'Study & Math',
			gpu: false,
			desc: 'Parses UMich CE & Physics Mermaid prerequisite flowcharts + completed credits to compute unlocked courses and graduation schedule.',
			toolNote: 'Auto Suite/Tools/10 - UMich CE & Physics Course Planner.md',
			outputNote: 'backpack/Graduation Plan.md'
		},
		{
			num: 11,
			id: 'note_refiner',
			title: 'Pass-2 Note Polisher & Verifier (GPU)',
			category: 'GPU & Vision',
			gpu: true,
			desc: 'Runs a 100% local second-pass verification over lecture or handwritten notes using canonical course references.',
			toolNote: 'Auto Suite/Tools/11 - Pass-2 Note Polisher & Verifier.md',
			outputNote: 'quantum/notes/lecture_2026_11_04.md'
		},
		{
			num: 12,
			id: 'local_ai',
			title: 'Local Vault AI Assistant (Multi-Model GPU + 1-Hop Graph + SymPy)',
			category: 'Study & Math',
			gpu: true,
			desc: '100% local AI study assistant with 3 local GPU models (Qwen2.5-VL-3B, Qwen2.5-Math-1.5B, DeepSeek-R1-1.5B), 4 generation profiles, 1-hop Topic Hub routing, Hybrid RAG, and SymPy math.',
			toolNote: 'Auto Suite/Tools/12 - Local Vault AI Assistant.md',
			outputNote: 'Auto Suite/Reports/Local GPU AI Model & Context Benchmark Report.md'
		},
		{
			num: 13,
			id: 'exam_simulator',
			title: 'Interactive Practice Exam & Quiz Simulator',
			category: 'Study & Math',
			gpu: false,
			desc: 'Generates SymPy & SciPy verified practice exams and quizzes across EECS 498, PHYSICS 240, STATS 412, GERMAN 375, and EECS 280 with collapsible hints and worked solutions.',
			toolNote: 'Auto Suite/Tools/13 - Practice Exam & Quiz Simulator.md',
			outputNote: 'Auto Suite/Reports/Practice Exam & Quiz Bank.md'
		}
	];

	const HUB_CATEGORIES = [
		'All',
		'Productivity & Sync',
		'GPU & Vision',
		'Career & LaTeX',
		'Study & Math',
		'Creative & Audio'
	];

	const filteredHubTools = $derived(
		activeHubCategory === 'All'
			? AUTO_SUITE_TOOLS
			: AUTO_SUITE_TOOLS.filter((t) => t.category === activeHubCategory)
	);

	async function runHubAiSearch(presetQuery?: string) {
		if (presetQuery) hubAiQuery = presetQuery;
		const q = hubAiQuery.trim();
		if (!q) return;
		hubAiLoading = true;
		try {
			const res = await fetch(
				appUrl(
					'notes',
					`/api?action=ask_ai&q=${encodeURIComponent(q)}&course=${encodeURIComponent(hubAiCourse)}`
				)
			);
			const data = await res.json();
			if (data.ok) {
				hubAiAnswerMarkdown = data.answer_markdown || '';
				hubAiRoutedTopics = data.routed_topics || [];
				hubAiResults = data.hits || [];
			}
		} catch {
			hubAiAnswerMarkdown = '';
			hubAiRoutedTopics = [];
			hubAiResults = [];
		} finally {
			hubAiLoading = false;
		}
	}

	// Group notes by course folder
	const groupedByCourse = $derived.by(() => {
		const groups: Record<string, NoteSummary[]> = {};
		for (const n of notesList) {
			const c = n.course || 'general';
			if (!groups[c]) groups[c] = [];
			groups[c].push(n);
		}
		// Sort notes within each course: index note (e.g. Quantum.md) first, then newest lectures first
		for (const c of Object.keys(groups)) {
			groups[c].sort((a, b) => {
				const aDepth = a.path.split('/').length;
				const bDepth = b.path.split('/').length;
				if (aDepth !== bDepth) return aDepth - bDepth;
				return b.path.localeCompare(a.path);
			});
		}
		return groups;
	});

	const courseNames = $derived(Object.keys(groupedByCourse).sort());

	function slugifyHeading(raw: string): string {
		return raw
			.toLowerCase()
			.replace(/[`*_~]/g, '')
			.replace(/[^\w\s-]/g, '')
			.trim()
			.replace(/\s+/g, '-');
	}

	function escapeHtml(str: string): string {
		return str
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function resolveRelativePath(notePath: string, relTarget: string): string {
		const cleanTarget = relTarget.trim().replace(/^\/+/, '');
		if (cleanTarget.startsWith('classes/')) {
			return cleanTarget.slice('classes/'.length);
		}
		const parts = notePath.split('/');
		parts.pop(); // directory of current note
		for (const seg of cleanTarget.split('/')) {
			if (!seg || seg === '.') continue;
			if (seg === '..') {
				if (parts.length > 0) parts.pop();
			} else {
				parts.push(seg);
			}
		}
		return parts.join('/');
	}

	function renderLatexString(tex: string, displayMode: boolean): string {
		const w = typeof window !== 'undefined' ? (window as any) : null;
		if (w && w.katex && katexReady) {
			try {
				return w.katex.renderToString(tex.trim(), {
					displayMode,
					throwOnError: false,
					strict: false,
					trust: true
				});
			} catch {
				// fallback below
			}
		}
		return displayMode
			? `<pre class="math-fallback-block">$$${escapeHtml(tex)}$$</pre>`
			: `<code class="math-fallback-inline">$${escapeHtml(tex)}$</code>`;
	}

	// Parse frontmatter + markdown + Obsidian callouts + wikilinks + KaTeX
	function renderMarkdownToHtml(rawContent: string, basePath = 'Home.md'): {
		frontmatter: Record<string, string>;
		html: string;
		headings: HeadingItem[];
	} {
		if (!rawContent) {
			return { frontmatter: {}, html: '', headings: [] };
		}

		let raw = rawContent.replace(/\r\n/g, '\n');
		const fm: Record<string, string> = {};

		if (raw.startsWith('---\n')) {
			const endFm = raw.indexOf('\n---\n', 4);
			if (endFm !== -1) {
				const fmBlock = raw.slice(4, endFm);
				raw = raw.slice(endFm + 5);
				for (const line of fmBlock.split('\n')) {
					const m = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
					if (m) {
						fm[m[1]] = m[2].replace(/^["']|["']$/g, '');
					}
				}
			}
		}

		// Step 1: Extract fenced code blocks & math blocks into placeholders so markdown rules don't mangle them
		const placeholders: string[] = [];
		const putPlaceholder = (renderedHtml: string): string => {
			const id = `\u0000PH_${placeholders.length}_\u0000`;
			placeholders.push(renderedHtml);
			return id;
		};

		// Fenced code blocks ```lang ... ```
		raw = raw.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
			if ((lang || '').trim().toLowerCase() === 'guitar-tab-player') {
				return putPlaceholder('');
			}
			return putPlaceholder(
				`<pre class="code-block"><code class="lang-${escapeHtml(lang || 'text')}">${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`
			);
		});

		// Display math $$ ... $$
		raw = raw.replace(/\$\$([\s\S]*?)\$\$/g, (_m, tex) => {
			return putPlaceholder(`<div class="math-display">${renderLatexString(tex, true)}</div>`);
		});

		// Inline code `...`
		raw = raw.replace(/`([^`\n]+)`/g, (_m, code) => {
			return putPlaceholder(`<code class="inline-code">${escapeHtml(code)}</code>`);
		});

		// Inline math $...$ (avoid matching currency like $50)
		raw = raw.replace(/(?<!\\)\$([^\$\n]+?)(?<!\\)\$/g, (m, tex) => {
			if (/^\s*\d+(\.\d+)?\s*$/.test(tex)) return m;
			return putPlaceholder(`<span class="math-inline">${renderLatexString(tex, false)}</span>`);
		});

		// Step 2: Process line-by-line structures (headings, callouts, lists, paragraphs, images)
		const lines = raw.split('\n');
		const outHtml: string[] = [];
		const headings: HeadingItem[] = [];

		function formatInline(text: string): string {
			let s = escapeHtml(text);

			// Obsidian embedded image ![[assets/foo.jpg|650]]
			s = s.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, widthSpec) => {
				if (target.endsWith('.base') || target.includes('.base#')) {
					return `<span class="obsidian-embed-pill">Obsidian View: ${target}</span>`;
				}
				const resolved = resolveRelativePath(basePath, target);
				const srcUrl = appUrl('notes', `/api?action=asset&path=${encodeURIComponent(resolved)}`, page.url);
				const maxW = widthSpec && /^\d+$/.test(widthSpec.trim()) ? `style="max-width:${widthSpec.trim()}px"` : '';
				return `<figure class="note-figure"><img src="${srcUrl}" alt="${target}" loading="lazy" ${maxW} /></figure>`;
			});

			// Standard Markdown image ![alt](url)
			s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
				const resolved = url.startsWith('http')
					? url
					: appUrl(
							'notes',
							`/api?action=asset&path=${encodeURIComponent(resolveRelativePath(basePath, url))}`,
							page.url
						);
				return `<figure class="note-figure"><img src="${resolved}" alt="${alt}" loading="lazy" /></figure>`;
			});

			// Obsidian internal heading link [[#Heading|Label]] or [[#Heading]]
			s = s.replace(/\[\[#([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, targetHeading, label) => {
				const cleanTargetH = String(targetHeading).replace(/\u0000PH_\d+_\u0000/g, '');
				const slug = slugifyHeading(cleanTargetH);
				return `<a href="#${slug}" class="wikilink">${label || cleanTargetH}</a>`;
			});

			// Obsidian cross-note wikilink [[note_name#Section|Label]]
			s = s.replace(/\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g, (_m, noteTarget, sectionTarget, label) => {
				const cleanTarget = String(noteTarget).replace(/\u0000PH_\d+_\u0000/g, '').trim();
				const cleanSection = sectionTarget
					? slugifyHeading(String(sectionTarget).replace(/\u0000PH_\d+_\u0000/g, ''))
					: '';
				const display = label || cleanTarget;
				const secAttr = cleanSection ? ` data-section="${cleanSection}"` : '';
				return `<a href="?note=${encodeURIComponent(cleanTarget)}" data-wikilink="${cleanTarget}"${secAttr} class="wikilink">${display}</a>`;
			});

			// Standard markdown links [text](url)
			s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
				const ext = url.startsWith('http') ? ' target="_blank" rel="noopener noreferrer"' : '';
				return `<a href="${url}" class="md-link"${ext}>${label}</a>`;
			});

			// Bold **text**
			s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
			// Italic *text*
			s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

			// Restore placeholders
			s = s.replace(/\u0000PH_(\d+)_\u0000/g, (_m, idx) => placeholders[Number(idx)] || '');
			return s;
		}

		let i = 0;
		while (i < lines.length) {
			const line = lines[i];
			const trimmed = line.trim();

			if (!trimmed) {
				i++;
				continue;
			}

			// Standalone placeholder line (e.g. display math or fenced code block)
			if (/^\u0000PH_\d+_\u0000$/.test(trimmed)) {
				outHtml.push(formatInline(trimmed));
				i++;
				continue;
			}

			// Horizontal rule
			if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
				outHtml.push('<hr class="note-hr" />');
				i++;
				continue;
			}

			// Headings # .. ####
			const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
			if (hMatch) {
				const level = hMatch[1].length;
				const rawTitle = hMatch[2].trim();
				const plainTitle = rawTitle.replace(/\u0000PH_\d+_\u0000/g, '').trim();
				const slug = slugifyHeading(plainTitle || `section-${i}`);
				if (level === 2 || level === 3) {
					headings.push({ id: slug, text: plainTitle, level });
				}
				outHtml.push(`<h${level} id="${slug}" class="note-h${level}">${formatInline(rawTitle)}</h${level}>`);
				i++;
				continue;
			}

			// Obsidian Callout or Blockquote `> ...`
			if (trimmed.startsWith('>')) {
				const quoteLines: string[] = [];
				while (i < lines.length && lines[i].trim().startsWith('>')) {
					quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
					i++;
				}
				const firstLine = quoteLines[0] || '';
				const calloutMatch = firstLine.match(/^\[!([a-zA-Z0-9_-]+)\]([+-])?\s*(.*)$/);
				if (calloutMatch) {
					const calloutType = calloutMatch[1].toLowerCase();
					const foldFlag = calloutMatch[2] || '';
					const calloutTitle = calloutMatch[3] || calloutType.toUpperCase();
					const bodyHtml = quoteLines
						.slice(1)
						.filter((ql) => ql.trim().length > 0)
						.map((ql) => `<p>${formatInline(ql.replace(/^[-*]\s+/, '• '))}</p>`)
						.join('');
					const isAutoCollapsedTitle =
						/navigation|metadata|table of contents|source photo|connected knowledge graph|quick access|purpose & 1-hop/i.test(
							calloutTitle
						);
					const openAttr =
						foldFlag === '-' || (foldFlag !== '+' && isAutoCollapsedTitle) ? '' : 'open';
					outHtml.push(
						`<details class="callout callout-${calloutType}" ${openAttr}><summary class="callout-title">${formatInline(calloutTitle)}</summary><div class="callout-body">${bodyHtml}</div></details>`
					);
				} else {
					const bodyHtml = quoteLines.map((ql) => `<p>${formatInline(ql)}</p>`).join('');
					outHtml.push(`<blockquote class="note-quote">${bodyHtml}</blockquote>`);
				}
				continue;
			}

			// Unordered list `- ` or `* `
			if (/^[-*]\s+/.test(trimmed)) {
				const items: string[] = [];
				while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
					items.push(`<li>${formatInline(lines[i].trim().replace(/^[-*]\s+/, ''))}</li>`);
					i++;
				}
				outHtml.push(`<ul class="note-ul">${items.join('')}</ul>`);
				continue;
			}

			// Ordered list `1. `
			if (/^\d+\.\s+/.test(trimmed)) {
				const items: string[] = [];
				while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
					items.push(`<li>${formatInline(lines[i].trim().replace(/^\d+\.\s+/, ''))}</li>`);
					i++;
				}
				outHtml.push(`<ol class="note-ol">${items.join('')}</ol>`);
				continue;
			}

			// Markdown table `| ... |`
			if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
				const tableLines: string[] = [];
				while (i < lines.length && lines[i].trim().startsWith('|')) {
					tableLines.push(lines[i].trim());
					i++;
				}
				if (tableLines.length >= 2) {
					const parseCells = (row: string) =>
						row
							.slice(1, -1)
							.split('|')
							.map((c) => formatInline(c.trim()));
					const headerCells = parseCells(tableLines[0]);
					const bodyStart = /^[\s|:-]+$/.test(tableLines[1]) ? 2 : 1;
					const rowsHtml = tableLines
						.slice(bodyStart)
						.map((r) => `<tr>${parseCells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`)
						.join('');
					outHtml.push(
						`<div class="table-wrap"><table class="note-table"><thead><tr>${headerCells.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`
					);
					continue;
				}
			}

			// Standard paragraph
			outHtml.push(`<p class="note-p">${formatInline(trimmed)}</p>`);
			i++;
		}

		return {
			frontmatter: fm,
			html: outHtml.join('\n'),
			headings
		};
	}

	const parsedView = $derived.by(() => {
		const _k = katexReady;
		if (!currentNote || !currentNote.content) {
			return { frontmatter: {} as Record<string, string>, html: '', headings: [] as HeadingItem[] };
		}
		return renderMarkdownToHtml(currentNote.content, currentNote.path);
	});

	const hubAiRenderedHtml = $derived.by(() => {
		const _k = katexReady;
		if (!hubAiAnswerMarkdown) return '';
		return renderMarkdownToHtml(hubAiAnswerMarkdown, 'Home.md').html;
	});

	// --- Built-In Guitar Tab MIDI Player, 25-Tuning Re-Voicer & Live Mic Tuner ---
	interface GuitarVoicingNote {
		string: number;
		fret: number;
		midi: number;
		note: string;
		technique?: string;
		target_fret?: number;
		target_midi?: number;
	}

	interface GuitarTabEvent {
		onset_sec: number;
		duration_sec: number;
		chord?: string | null;
		voicing: GuitarVoicingNote[];
	}

	interface GuitarTuningCandidate {
		tuning: string;
		notes_label?: string;
		avg_biomech_cost?: number;
		open_string_pct?: number;
		confidence?: number;
	}

	interface GuitarTabPayload {
		title: string;
		bpm: number;
		tuning_name: string;
		open_tuning: number[];
		capo: number;
		detected_tuning?: string;
		detected_confidence?: number;
		cents_offset?: number;
		a4_hz?: number;
		tuning_candidates?: GuitarTuningCandidate[];
		events: GuitarTabEvent[];
	}

	const GUITAR_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

	function midiToNoteLabel(midi: number, withOctave = true): string {
		const m = Math.round(Number(midi) || 60);
		const name = GUITAR_NOTE_NAMES[((m % 12) + 12) % 12];
		if (!withOctave) return name;
		const oct = Math.floor(m / 12) - 1;
		return `${name}${oct}`;
	}

	function midiToFreqHz(midi: number, a4 = 440.0): number {
		return Number(a4 || 440.0) * Math.pow(2, (Number(midi) - 69.0) / 12.0);
	}

	const GUITAR_TUNING_PRESETS: Record<string, { notes: number[]; label: string }> = {
		standard: { notes: [40, 45, 50, 55, 59, 64], label: 'Standard (E2 A2 D3 G3 B3 E4)' },
		'drop-d': { notes: [38, 45, 50, 55, 59, 64], label: 'Drop D (D2 A2 D3 G3 B3 E4)' },
		'double-drop-d': { notes: [38, 45, 50, 55, 59, 62], label: 'Double Drop D (D2 A2 D3 G3 B3 D4)' },
		dadgad: { notes: [38, 45, 50, 55, 57, 62], label: 'DADGAD Celtic/Folk (D2 A2 D3 G3 A3 D4)' },
		'half-step-down': { notes: [39, 44, 49, 54, 58, 63], label: 'Half-Step Down / Eb (D#2 G#2 C#3 F#3 A#3 D#4)' },
		'full-step-down': { notes: [38, 43, 48, 53, 57, 62], label: 'Full-Step Down / D Std (D2 G2 C3 F3 A3 D4)' },
		'drop-cs': { notes: [37, 44, 49, 54, 58, 63], label: 'Drop C# / Db (C#2 G#2 C#3 F#3 A#3 D#4)' },
		'drop-c': { notes: [36, 43, 48, 53, 57, 62], label: 'Drop C (C2 G2 C3 F3 A3 D4)' },
		'drop-b': { notes: [35, 42, 47, 52, 56, 61], label: 'Drop B (B1 F#2 B2 E3 G#3 C#4)' },
		'drop-a': { notes: [33, 40, 45, 50, 54, 59], label: 'Drop A (A1 E2 A2 D3 F#3 B3)' },
		'cs-standard': { notes: [37, 42, 47, 52, 56, 61], label: 'C# Standard (C#2 F#2 B2 E3 G#3 C#4)' },
		'c-standard': { notes: [36, 41, 46, 51, 55, 60], label: 'C Standard (C2 F2 A#2 D#3 G3 C4)' },
		'baritone-b': { notes: [35, 40, 45, 50, 54, 59], label: 'Baritone B Standard (B1 E2 A2 D3 F#3 B3)' },
		'open-d': { notes: [38, 45, 50, 54, 57, 62], label: 'Open D Major (D2 A2 D3 F#3 A3 D4)' },
		'open-dm': { notes: [38, 45, 50, 53, 57, 62], label: 'Open D Minor (D2 A2 D3 F3 A3 D4)' },
		'open-g': { notes: [38, 43, 50, 55, 59, 62], label: 'Open G Major (D2 G2 D3 G3 B3 D4)' },
		'open-gm': { notes: [38, 43, 50, 55, 58, 62], label: 'Open G Minor (D2 G2 D3 G3 A#3 D4)' },
		'open-e': { notes: [40, 47, 52, 56, 59, 64], label: 'Open E Major (E2 B2 E3 G#3 B3 E4)' },
		'open-a': { notes: [40, 45, 52, 57, 61, 64], label: 'Open A Major (E2 A2 E3 A3 C#4 E4)' },
		'open-c': { notes: [36, 43, 48, 55, 60, 64], label: 'Open C Major (C2 G2 C3 G3 C4 E4)' },
		facgce: { notes: [41, 45, 48, 55, 60, 64], label: 'FACGCE Midwest Emo (F2 A2 C3 G3 C4 E4)' },
		daeacse: { notes: [38, 45, 52, 57, 61, 64], label: 'DAEAC#E Midwest Emo (D2 A2 E3 A3 C#4 E4)' },
		'nick-drake': { notes: [36, 43, 48, 53, 60, 64], label: 'Nick Drake CGCFCE (C2 G2 C3 F3 C4 E4)' },
		'all-fourths': { notes: [40, 45, 50, 55, 60, 65], label: 'All Fourths Jazz/Fusion (E2 A2 D3 G3 C4 F4)' },
		'new-standard': { notes: [36, 43, 50, 57, 64, 67], label: 'New Standard / Fripp NST (C2 G2 D3 A3 E4 G4)' }
	};

	const DEFAULT_GUITAR_PAYLOAD: GuitarTabPayload = {
		title: "Knockin' on Heaven's Door (G - D - Am7 - C)",
		bpm: 120.0,
		tuning_name: 'standard',
		open_tuning: [40, 45, 50, 55, 59, 64],
		capo: 0,
		detected_tuning: 'standard',
		detected_confidence: 0.5,
		cents_offset: 0.0,
		a4_hz: 440.0,
		tuning_candidates: [
			{ tuning: 'standard', notes_label: 'E2 A2 D3 G3 B3 E4', avg_biomech_cost: 0.49, open_string_pct: 42.3, confidence: 0.5 },
			{ tuning: 'drop-d', notes_label: 'D2 A2 D3 G3 B3 E4', avg_biomech_cost: 0.68, open_string_pct: 42.3, confidence: 0.25 },
			{ tuning: 'facgce', notes_label: 'F2 A2 C3 G3 C4 E4', avg_biomech_cost: 1.17, open_string_pct: 34.6, confidence: 0.14 }
		],
		events: [
			{ onset_sec: 0.0, duration_sec: 1.0, chord: 'G', voicing: [{ string: 6, fret: 3, midi: 43, note: 'G2' }, { string: 5, fret: 2, midi: 47, note: 'B2' }, { string: 4, fret: 0, midi: 50, note: 'D3' }, { string: 3, fret: 0, midi: 55, note: 'G3' }, { string: 2, fret: 0, midi: 59, note: 'B3' }, { string: 1, fret: 3, midi: 67, note: 'G4' }] },
			{ onset_sec: 1.0, duration_sec: 1.0, chord: null, voicing: [{ string: 2, fret: 0, midi: 59, note: 'B3' }] },
			{ onset_sec: 2.0, duration_sec: 1.0, chord: 'D', voicing: [{ string: 4, fret: 0, midi: 50, note: 'D3' }, { string: 3, fret: 2, midi: 57, note: 'A3' }, { string: 2, fret: 3, midi: 62, note: 'D4' }, { string: 1, fret: 2, midi: 66, note: 'F#4' }] },
			{ onset_sec: 3.0, duration_sec: 1.0, chord: null, voicing: [{ string: 2, fret: 3, midi: 62, note: 'D4', technique: '/', target_fret: 5, target_midi: 64 }] },
			{ onset_sec: 4.0, duration_sec: 1.0, chord: 'Am7', voicing: [{ string: 5, fret: 0, midi: 45, note: 'A2' }, { string: 4, fret: 2, midi: 52, note: 'E3' }, { string: 3, fret: 0, midi: 55, note: 'G3' }, { string: 2, fret: 1, midi: 60, note: 'C4' }, { string: 1, fret: 0, midi: 64, note: 'E4' }] },
			{ onset_sec: 5.0, duration_sec: 1.0, chord: null, voicing: [{ string: 2, fret: 1, midi: 60, note: 'C4' }] },
			{ onset_sec: 6.0, duration_sec: 1.0, chord: 'C', voicing: [{ string: 5, fret: 3, midi: 48, note: 'C3' }, { string: 4, fret: 2, midi: 52, note: 'E3' }, { string: 3, fret: 0, midi: 55, note: 'G3' }, { string: 2, fret: 1, midi: 60, note: 'C4' }, { string: 1, fret: 0, midi: 64, note: 'E4' }] },
			{ onset_sec: 7.0, duration_sec: 1.0, chord: null, voicing: [{ string: 1, fret: 3, midi: 67, note: 'G4', technique: 'b', target_fret: 5, target_midi: 69 }] }
		]
	};

	let gSelectedTuning = $state('standard');
	let gSelectedCapo = $state(0);
	let gSpeedMult = $state(1.0);
	let gLoopEnabled = $state(true);
	let gIsPlaying = $state(false);
	let gActiveStepIdx = $state(0);
	let gPlayTimer: number | null = null;
	let gAudioCtx: AudioContext | null = null;

	// Live Mic Tuner state
	let gMicActive = $state(false);
	let gMicNoteText = $state('--');
	let gMicFreqText = $state('Pluck any guitar string near your microphone...');
	let gMicCents = $state(0);
	let gMicDetectedSummary = $state('Pluck strings 6 -> 1 to auto-identify your guitar tuning.');
	let gMicStream: MediaStream | null = null;
	let gMicAnimFrame: number | null = null;
	const gPluckedMicStrings = new Map<number, number>();

	// Context-Aware Note Question Box state
	let noteTutorQuery = $state('');
	let noteTutorLoading = $state(false);
	let noteTutorAnswerMd = $state('');
	let noteTutorOpen = $state(false);

	const noteTutorRenderedHtml = $derived.by(() => {
		const _k = katexReady;
		if (!noteTutorAnswerMd) return '';
		return renderMarkdownToHtml(noteTutorAnswerMd, currentNote?.path || 'Home.md').html;
	});

	async function askNoteContextAi() {
		const q = noteTutorQuery.trim();
		if (!q || !currentNote) return;
		noteTutorLoading = true;
		noteTutorOpen = true;
		try {
			const c = ['quantum', 'physics', 'stats', 'german', 'eecs280'].includes(currentNote.course)
				? currentNote.course
				: 'all';
			const res = await fetch(
				appUrl(
					'notes',
					`/api?action=ask_ai&q=${encodeURIComponent(q)}&course=${encodeURIComponent(c)}&context_path=${encodeURIComponent(currentNote.path)}`
				)
			);
			const data = await res.json();
			if (data.ok && data.answer_markdown) {
				noteTutorAnswerMd = data.answer_markdown;
			} else {
				noteTutorAnswerMd = 'No matching synthesis found.';
			}
		} catch (e) {
			noteTutorAnswerMd = `Error: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			noteTutorLoading = false;
		}
	}

	const activeGuitarTabPayload = $derived.by((): GuitarTabPayload | null => {
		if (!currentNote || !currentNote.content) return null;
		const m = currentNote.content.match(/```guitar-tab-player\s*\r?\n([\s\S]+?)\r?\n```/);
		if (m && m[1]) {
			try {
				const parsed = JSON.parse(m[1]);
				return { ...DEFAULT_GUITAR_PAYLOAD, ...parsed };
			} catch {
				return DEFAULT_GUITAR_PAYLOAD;
			}
		}
		if (
			currentNote.path.includes('Guitar Tabs/') ||
			currentNote.path.includes('09 - Local Guitar-to-Tab Transcriber')
		) {
			return DEFAULT_GUITAR_PAYLOAD;
		}
		return null;
	});

	$effect(() => {
		const p = activeGuitarTabPayload;
		if (p) {
			stopGuitarPlayback();
			gSelectedTuning = p.tuning_name && GUITAR_TUNING_PRESETS[p.tuning_name] ? p.tuning_name : 'standard';
			gSelectedCapo = Number(p.capo) || 0;
			gActiveStepIdx = 0;
		}
	});

	const gActiveOpenTuning = $derived(
		GUITAR_TUNING_PRESETS[gSelectedTuning]?.notes || [40, 45, 50, 55, 59, 64]
	);

	const gRevoicedEvents = $derived.by((): GuitarTabEvent[] => {
		const p = activeGuitarTabPayload;
		if (!p || !Array.isArray(p.events)) return [];
		const effectiveOpen = gActiveOpenTuning.map((n) => n + (Number(gSelectedCapo) || 0));
		return p.events.map((ev) => {
			const usedStrings = new Set<number>();
			const sortedNotes = [...(ev.voicing || [])].sort((a, b) => a.midi - b.midi);
			const newVoicing: GuitarVoicingNote[] = [];
			for (const v of sortedNotes) {
				let bestStr: number | null = null;
				let bestFret = 0;
				let bestCost = 1e9;
				for (let idx = 0; idx < 6; idx++) {
					const strNum = 6 - idx;
					if (usedStrings.has(strNum)) continue;
					const fret = v.midi - effectiveOpen[idx];
					if (fret < 0 || fret > 22) continue;
					let cost = fret === 0 ? 0.05 : fret * 0.24;
					if (strNum === v.string) cost -= 0.15;
					if (cost < bestCost) {
						bestCost = cost;
						bestStr = strNum;
						bestFret = fret;
					}
				}
				if (bestStr !== null) {
					usedStrings.add(bestStr);
					const delta = v.target_midi ? v.target_midi - v.midi : 0;
					newVoicing.push({
						string: bestStr,
						fret: bestFret,
						midi: v.midi,
						note: midiToNoteLabel(v.midi, true),
						technique: v.technique || '',
						target_fret: delta ? Math.max(0, bestFret + delta) : bestFret,
						target_midi: v.target_midi || v.midi
					});
				}
			}
			newVoicing.sort((a, b) => b.string - a.string);
			return { ...ev, voicing: newVoicing };
		});
	});

	const gLiveAsciiTab = $derived.by((): string => {
		const events = gRevoicedEvents;
		if (!events.length) return '';
		const strLabels: string[] = [];
		for (let s = 1; s <= 6; s++) {
			const pitch = gActiveOpenTuning[6 - s] + (Number(gSelectedCapo) || 0);
			let lbl = midiToNoteLabel(pitch, false);
			if (s === 1) lbl = lbl.toLowerCase();
			strLabels.push((lbl + ' ').slice(0, 2));
		}
		const lines = ['', '', '', '', '', ''];
		let chordRow = '   ';
		events.forEach((ev, idx) => {
			const tokens = ['-', '-', '-', '-', '-', '-'];
			let width = 3;
			for (const v of ev.voicing || []) {
				const r = v.string - 1;
				if (r >= 0 && r < 6) {
					let tok = String(v.fret);
					if (v.technique && v.target_fret && v.target_fret !== v.fret) {
						tok = `${v.fret}${v.technique}${v.target_fret}`;
					}
					tokens[r] = tok;
					if (tok.length + 2 > width) width = tok.length + 2;
				}
			}
			const colW = Math.max(width, 6);
			const ch = ev.chord ? String(ev.chord) : '';
			chordRow += ch.padEnd(colW, ' ');
			for (let r = 0; r < 6; r++) {
				lines[r] += tokens[r].padEnd(colW, '-');
			}
			if ((idx + 1) % 4 === 0 && idx < events.length - 1) {
				chordRow += ' ';
				for (let r = 0; r < 6; r++) lines[r] += '|';
			}
		});
		const out = [chordRow.trimEnd()];
		for (let r = 0; r < 6; r++) {
			out.push(`${strLabels[r]}|-${lines[r]}|`);
		}
		return out.join('\n');
	});

	function ensureGuitarAudioCtx(): AudioContext | null {
		if (typeof window === 'undefined') return null;
		if (!gAudioCtx) {
			const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
			if (Ctx) gAudioCtx = new Ctx();
		}
		if (gAudioCtx && gAudioCtx.state === 'suspended') {
			gAudioCtx.resume();
		}
		return gAudioCtx;
	}

	function pluckGuitarNote(midi: number, durationSec = 0.9, delaySec = 0.0, targetMidi?: number) {
		const ctx = ensureGuitarAudioCtx();
		if (!ctx) return;
		const a4 = Number(activeGuitarTabPayload?.a4_hz) || 440.0;
		const now = ctx.currentTime + Math.max(0, delaySec);
		const freq = midiToFreqHz(midi, a4);
		const dur = Math.max(0.25, Math.min(2.8, durationSec));

		const osc1 = ctx.createOscillator();
		const osc2 = ctx.createOscillator();
		const subOsc = ctx.createOscillator();
		const filter = ctx.createBiquadFilter();
		const gain = ctx.createGain();

		osc1.type = 'triangle';
		osc2.type = 'sawtooth';
		subOsc.type = 'sine';

		osc1.frequency.setValueAtTime(freq, now);
		osc2.frequency.setValueAtTime(freq, now);
		subOsc.frequency.setValueAtTime(freq * 2.0, now);
		osc2.detune.setValueAtTime(3.5, now);

		if (targetMidi && targetMidi !== midi) {
			const targetFreq = midiToFreqHz(targetMidi, a4);
			const bendStart = now + Math.min(0.16, dur * 0.28);
			const bendEnd = now + Math.min(0.42, dur * 0.68);
			osc1.frequency.setValueAtTime(freq, bendStart);
			osc2.frequency.setValueAtTime(freq, bendStart);
			subOsc.frequency.setValueAtTime(freq * 2.0, bendStart);
			osc1.frequency.linearRampToValueAtTime(targetFreq, bendEnd);
			osc2.frequency.linearRampToValueAtTime(targetFreq, bendEnd);
			subOsc.frequency.linearRampToValueAtTime(targetFreq * 2.0, bendEnd);
		}

		filter.type = 'lowpass';
		filter.frequency.setValueAtTime(Math.min(4800, freq * 7.5), now);
		filter.frequency.exponentialRampToValueAtTime(Math.max(380, freq * 1.9), now + dur * 0.85);
		filter.Q.setValueAtTime(1.6, now);

		gain.gain.setValueAtTime(0.0001, now);
		gain.gain.linearRampToValueAtTime(0.20, now + 0.012);
		gain.gain.exponentialRampToValueAtTime(0.065, now + 0.14);
		gain.gain.exponentialRampToValueAtTime(0.0008, now + dur);

		const g1 = ctx.createGain();
		const g2 = ctx.createGain();
		const g3 = ctx.createGain();
		g1.gain.value = 0.62;
		g2.gain.value = 0.26;
		g3.gain.value = 0.12;

		osc1.connect(g1);
		osc2.connect(g2);
		subOsc.connect(g3);
		g1.connect(filter);
		g2.connect(filter);
		g3.connect(filter);
		filter.connect(gain);
		gain.connect(ctx.destination);

		osc1.start(now);
		osc2.start(now);
		subOsc.start(now);
		osc1.stop(now + dur + 0.04);
		osc2.stop(now + dur + 0.04);
		subOsc.stop(now + dur + 0.04);
	}

	function playGuitarEventVoicing(ev: GuitarTabEvent | undefined) {
		if (!ev || !ev.voicing) return;
		const sorted = [...ev.voicing].sort((a, b) => b.string - a.string);
		const dur = Math.max(0.45, (Number(ev.duration_sec) || 0.8) / gSpeedMult);
		sorted.forEach((v, idx) => {
			pluckGuitarNote(v.midi, dur * 1.15, idx * 0.018, v.target_midi);
		});
	}

	function strumOpenTuningWeb() {
		gActiveOpenTuning.forEach((p, idx) => {
			pluckGuitarNote(p + (Number(gSelectedCapo) || 0), 1.35, idx * 0.065);
		});
	}

	function stopGuitarPlayback() {
		gIsPlaying = false;
		if (gPlayTimer !== null && typeof window !== 'undefined') {
			window.clearTimeout(gPlayTimer);
			gPlayTimer = null;
		}
	}

	function scheduleNextGuitarStep() {
		const events = gRevoicedEvents;
		if (!gIsPlaying || events.length === 0) return;
		if (gActiveStepIdx >= events.length) {
			if (gLoopEnabled) {
				gActiveStepIdx = 0;
			} else {
				stopGuitarPlayback();
				return;
			}
		}
		const ev = events[gActiveStepIdx];
		playGuitarEventVoicing(ev);
		const nextEv = events[gActiveStepIdx + 1];
		let waitSec = Number(ev.duration_sec) || 0.75;
		if (nextEv && Number(nextEv.onset_sec) > Number(ev.onset_sec)) {
			waitSec = Number(nextEv.onset_sec) - Number(ev.onset_sec);
		}
		const waitMs = Math.max(140, (waitSec * 1000) / gSpeedMult);
		gActiveStepIdx = gActiveStepIdx + 1;
		gPlayTimer = window.setTimeout(scheduleNextGuitarStep, waitMs);
	}

	function toggleGuitarPlayback() {
		if (gIsPlaying) {
			stopGuitarPlayback();
		} else {
			gIsPlaying = true;
			if (gActiveStepIdx >= gRevoicedEvents.length) gActiveStepIdx = 0;
			scheduleNextGuitarStep();
		}
	}

	function detectPitchAutocorrelationWeb(buf: Float32Array, sampleRate: number): number {
		let size = buf.length;
		let rms = 0;
		for (let i = 0; i < size; i++) rms += buf[i] * buf[i];
		rms = Math.sqrt(rms / size);
		if (rms < 0.012) return -1;
		let r1 = 0;
		let r2 = size - 1;
		const thres = 0.2;
		for (let i = 0; i < size / 2; i++) {
			if (Math.abs(buf[i]) < thres) {
				r1 = i;
				break;
			}
		}
		for (let i = 1; i < size / 2; i++) {
			if (Math.abs(buf[size - i]) < thres) {
				r2 = size - i;
				break;
			}
		}
		const sliced = buf.slice(r1, r2);
		size = sliced.length;
		if (size < 64) return -1;
		const c = new Float32Array(size);
		for (let i = 0; i < size; i++) {
			let sum = 0;
			for (let j = 0; j < size - i; j++) sum += sliced[j] * sliced[j + i];
			c[i] = sum;
		}
		let d = 0;
		while (d < size - 1 && c[d] > c[d + 1]) d++;
		let maxval = -1;
		let maxpos = -1;
		for (let i = d; i < size; i++) {
			if (c[i] > maxval) {
				maxval = c[i];
				maxpos = i;
			}
		}
		if (maxpos <= 0) return -1;
		let T0 = maxpos;
		if (T0 > 0 && T0 < size - 1) {
			const x1 = c[T0 - 1];
			const x2 = c[T0];
			const x3 = c[T0 + 1];
			const a = (x1 + x3 - 2 * x2) / 2;
			const b = (x3 - x1) / 2;
			if (a) T0 = T0 - b / (2 * a);
		}
		const freq = sampleRate / T0;
		if (freq < 55 || freq > 1100) return -1;
		return freq;
	}

	function stopGuitarMicTuner() {
		if (gMicAnimFrame !== null && typeof window !== 'undefined') {
			window.cancelAnimationFrame(gMicAnimFrame);
			gMicAnimFrame = null;
		}
		if (gMicStream) {
			gMicStream.getTracks().forEach((t) => t.stop());
			gMicStream = null;
		}
		gMicActive = false;
	}

	async function toggleGuitarMicTuner() {
		if (gMicActive) {
			stopGuitarMicTuner();
			return;
		}
		gMicActive = true;
		if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
			gMicFreqText = 'Microphone access unavailable in this browser.';
			return;
		}
		try {
			gMicStream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false }
			});
			const ctx = ensureGuitarAudioCtx();
			if (!ctx) return;
			const source = ctx.createMediaStreamSource(gMicStream);
			const analyser = ctx.createAnalyser();
			analyser.fftSize = 2048;
			source.connect(analyser);
			const buf = new Float32Array(analyser.fftSize);
			const a4 = Number(activeGuitarTabPayload?.a4_hz) || 440.0;

			const loop = () => {
				if (!gMicStream) return;
				analyser.getFloatTimeDomainData(buf);
				const freq = detectPitchAutocorrelationWeb(buf, ctx.sampleRate);
				if (freq > 0) {
					const midiFloat = 69 + 12 * Math.log2(freq / a4);
					const nearestMidi = Math.round(midiFloat);
					const cents = Math.round((midiFloat - nearestMidi) * 100);
					gMicCents = cents;
					const noteName = midiToNoteLabel(nearestMidi, true);

					let bestStr = 6;
					let minDiff = 999;
					gActiveOpenTuning.forEach((openP, idx) => {
						const d = Math.abs(nearestMidi - (openP + gSelectedCapo));
						if (d < minDiff) {
							minDiff = d;
							bestStr = 6 - idx;
						}
					});
					if (minDiff <= 4) {
						gPluckedMicStrings.set(bestStr, nearestMidi - gSelectedCapo);
					}
					gMicNoteText = `${noteName} (${cents >= 0 ? '+' : ''}${cents}c)`;
					gMicFreqText = `${freq.toFixed(1)} Hz | Closest String #${bestStr} (${midiToNoteLabel(gActiveOpenTuning[6 - bestStr] + gSelectedCapo, true)})`;

					if (gPluckedMicStrings.size >= 2) {
						let bestPreset = 'standard';
						let bestMatches = -1;
						for (const [k, info] of Object.entries(GUITAR_TUNING_PRESETS)) {
							let matches = 0;
							for (const [sNum, detMidi] of gPluckedMicStrings.entries()) {
								if (info.notes[6 - sNum] === detMidi) matches++;
							}
							if (matches > bestMatches) {
								bestMatches = matches;
								bestPreset = k;
							}
						}
						const summary = Array.from(gPluckedMicStrings.entries())
							.sort((a, b) => b[0] - a[0])
							.map(([s, m]) => `S${s}:${midiToNoteLabel(m, true)}`)
							.join(' ');
						gMicDetectedSummary = `Plucked [${summary}] -> Best Detected Tuning: ${GUITAR_TUNING_PRESETS[bestPreset].label} (${bestMatches}/${gPluckedMicStrings.size} match)`;
					}
				}
				gMicAnimFrame = window.requestAnimationFrame(loop);
			};
			loop();
		} catch (e) {
			gMicFreqText = `Mic error: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	async function fetchTree() {
		loadingTree = true;
		try {
			const res = await fetch(appUrl('notes', '/api?action=tree'));
			const data = await res.json();
			if (data.ok && Array.isArray(data.notes)) {
				notesList = data.notes;
				if (!selectedPath && notesList.length > 0) {
					const urlNote = new URLSearchParams(window.location.search).get('note');
					const initial =
						(urlNote && notesList.find((n) => n.path === urlNote || n.path.endsWith(`/${urlNote}.md`) || n.path.endsWith(urlNote))?.path) ||
						notesList.find((n) => n.path.includes('quantum/notes/lecture_'))?.path ||
						notesList[0].path;
					if (initial) {
						await selectNote(initial, false);
					}
				}
			}
		} catch (e) {
			console.error('Failed to load notes tree:', e);
		} finally {
			loadingTree = false;
		}
	}

	async function selectNote(path: string, pushUrl = true) {
		selectedPath = path;
		mobileSidebarOpen = false;
		loadingNote = true;
		try {
			const res = await fetch(appUrl('notes', `/api?action=note&path=${encodeURIComponent(path)}`));
			const data = await res.json();
			if (data.ok && data.note) {
				currentNote = data.note;
				if (pushUrl && typeof window !== 'undefined') {
					const url = new URL(window.location.href);
					url.searchParams.set('note', path);
					window.history.replaceState({}, '', url.toString());
				}
			}
		} catch (e) {
			console.error('Failed to load note:', e);
		} finally {
			loadingNote = false;
		}
	}

	let searchTimer: ReturnType<typeof setTimeout> | null = null;
	function onSearchInput() {
		if (searchTimer) clearTimeout(searchTimer);
		const q = searchQuery.trim();
		if (!q) {
			searchHits = [];
			searching = false;
			return;
		}
		searching = true;
		searchTimer = setTimeout(async () => {
			try {
				const res = await fetch(appUrl('notes', `/api?action=search&q=${encodeURIComponent(q)}`));
				const data = await res.json();
				if (data.ok) {
					searchHits = data.hits || [];
				}
			} catch {
				searchHits = [];
			} finally {
				searching = false;
			}
		}, 180);
	}

	function handleArticleClick(e: MouseEvent) {
		const target = (e.target as HTMLElement)?.closest('a[data-wikilink]') as HTMLAnchorElement | null;
		if (!target) return;
		const linkName = target.getAttribute('data-wikilink');
		const sectionSlug = target.getAttribute('data-section');
		if (!linkName) return;
		e.preventDefault();
		const cleanLink = linkName.replace(/^classes\//, '').replace(/\.md$/i, '');
		const match = notesList.find(
			(n) =>
				n.path === cleanLink ||
				n.path === `${cleanLink}.md` ||
				n.path.endsWith(`/${cleanLink}.md`) ||
				n.path.toLowerCase().endsWith(`${cleanLink.toLowerCase()}.md`)
		);
		if (match) {
			showAutoSuiteHub = false;
			selectNote(match.path).then(() => {
				if (sectionSlug && typeof document !== 'undefined') {
					setTimeout(() => {
						const secEl = document.getElementById(sectionSlug);
						if (secEl) secEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
					}, 80);
				}
			});
		}
	}

	function copyShareLink() {
		if (!selectedPath) return;
		const url = new URL(
			appUrl('notes', `/?note=${encodeURIComponent(selectedPath)}`),
			window.location.origin
		).toString();
		navigator.clipboard.writeText(url);
		copyStatus = 'copied url';
		setTimeout(() => (copyStatus = ''), 2000);
	}

	function formatBytes(b: number): string {
		if (b < 1024) return `${b} B`;
		return `${(b / 1024).toFixed(1)} KB`;
	}

	onMount(() => {
		try {
			const saved = localStorage.getItem('peckhamr-theme');
			applyTheme(saved === 'dark' ? 'dark' : 'light');
		} catch {
			applyTheme('light');
		}
		fetchTree();
		if (typeof window !== 'undefined') {
			if ((window as any).katex) {
				katexReady = true;
			}
			const params = new URLSearchParams(window.location.search);
			if (params.get('hub') === '1' || params.get('note') === 'Auto Suite/Auto Hub.md') {
				showAutoSuiteHub = true;
				runHubAiSearch();
			}
		}
	});
</script>

<svelte:head>
	<title>{currentNote ? `${currentNote.title} — notes` : 'notes — peckhamr.com'}</title>
	<link
		rel="stylesheet"
		href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css"
		crossorigin="anonymous"
	/>
	<script
		defer
		src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"
		crossorigin="anonymous"
		onload={() => {
			katexReady = true;
		}}
	></script>
</svelte:head>

<div class="notes-shell">
	<!-- Top Bar -->
	<header class="topbar">
		<div class="topbar-left">
			<button
				class="mobile-menu-btn"
				onclick={() => (mobileSidebarOpen = !mobileSidebarOpen)}
				aria-label="Toggle class tree"
			>
				☰
			</button>
			<a href={appUrl('home', '/', page.url)} class="brand-link">peckhamr.com</a>
			<span class="sep">/</span>
			<span class="route-name">notes</span>
		</div>

		<div class="topbar-search">
			<input
				type="search"
				placeholder="Search classes/, equations, topics..."
				bind:value={searchQuery}
				oninput={onSearchInput}
				class="search-input"
			/>
			{#if searchQuery.trim()}
				<div class="search-dropdown">
					{#if searching}
						<div class="search-empty">Searching...</div>
					{:else if searchHits.length === 0}
						<div class="search-empty">No matches for "{searchQuery}"</div>
					{:else}
						{#each searchHits as hit}
							<button
								class="search-hit"
								onclick={() => {
									searchQuery = '';
									searchHits = [];
									selectNote(hit.path);
								}}
							>
								<div class="hit-top">
									<span class="hit-course">{hit.course}</span>
									<span class="hit-title">{hit.title}</span>
								</div>
								<div class="hit-snippet">{hit.snippet}</div>
							</button>
						{/each}
					{/if}
				</div>
			{/if}
		</div>

		<div class="topbar-right">
			<button
				class="tool-btn"
				onclick={toggleTheme}
				title={theme === 'light' ? 'Switch to Monokai Pro Dark' : 'Switch to Monokai Pro Light'}
			>
				{theme === 'light' ? '☾ dark' : '☀ light'}
			</button>
			<button
				class="tool-btn"
				class:active={showAutoSuiteHub}
				onclick={() => {
					showAutoSuiteHub = !showAutoSuiteHub;
					if (showAutoSuiteHub && hubAiResults.length === 0) {
						runHubAiSearch();
					}
				}}
			>
				auto suite hub
			</button>
			{#if currentNote && !showAutoSuiteHub}
				<button class="tool-btn" onclick={copyShareLink}>
					{copyStatus || 'share link'}
				</button>
				<button
					class="tool-btn"
					class:active={showRaw}
					onclick={() => (showRaw = !showRaw)}
				>
					{showRaw ? 'rendered' : 'raw .md'}
				</button>
			{/if}
		</div>
	</header>

	<div class="workspace">
		<!-- Left Sidebar: classes/ directory tree -->
		<aside class="sidebar-left" class:open={mobileSidebarOpen}>
			<div class="sidebar-header">
				<span>vault: classes/</span>
				<span class="count-pill">{notesList.length}</span>
			</div>

			{#if loadingTree}
				<div class="sidebar-empty">Loading classes/...</div>
			{:else if courseNames.length === 0}
				<div class="sidebar-empty">No published notes yet.</div>
			{:else}
				<nav class="tree-nav">
					{#each courseNames as course}
						<div class="course-group">
							<button
								class="course-header"
								onclick={() => (collapsedCourses[course] = !collapsedCourses[course])}
							>
								<span class="caret">{collapsedCourses[course] ? '▸' : '▾'}</span>
								<span class="course-name">{course}/</span>
								<span class="course-count">{groupedByCourse[course].length}</span>
							</button>

							{#if !collapsedCourses[course]}
								<div class="course-items">
									{#each groupedByCourse[course] as item}
										{@const shortRel = item.path.replace(new RegExp(`^${course}/`), '')}
										<button
											class="note-item"
											class:selected={selectedPath === item.path}
											onclick={() => selectNote(item.path)}
											title={item.path}
										>
											<span class="note-item-title">{item.title}</span>
											<span class="note-item-sub">{shortRel}</span>
										</button>
									{/each}
								</div>
							{/if}
						</div>
					{/each}
				</nav>
			{/if}
		</aside>

		<!-- Main Note Reader -->
		<main class="reader-pane">
			{#if showAutoSuiteHub || (currentNote && currentNote.path === 'Auto Suite/Auto Hub.md' && !showRaw)}
				<div class="hub-container">
					<div class="hub-header">
						<div>
							<h1 class="hub-title">Vault Tools &amp; Search</h1>
							<p class="hub-sub">
								Course notes search and study utilities
							</p>
						</div>
						<div class="hub-pills">
							<button class="tool-btn" onclick={() => { showAutoSuiteHub = false; selectNote('Home.md'); }}>Home</button>
							<button class="tool-btn" onclick={() => { showAutoSuiteHub = false; selectNote('INDEX.md'); }}>Classes Index</button>
						</div>
					</div>

					<!-- Local Vault AI & Search Box -->
					<div class="hub-search-box">
						<div class="hub-search-row">
							<input
								type="text"
								class="search-input"
								placeholder="Search or ask a question across notes..."
								bind:value={hubAiQuery}
								onkeydown={(e) => e.key === 'Enter' && runHubAiSearch()}
							/>
							<select class="hub-select" bind:value={hubAiCourse} onchange={() => runHubAiSearch()}>
								<option value="all">All Courses</option>
								<option value="quantum">EECS 498</option>
								<option value="physics">PHYSICS 240</option>
								<option value="stats">STATS 412</option>
								<option value="german">GERMAN 375</option>
							</select>
							<button class="hub-primary-btn" onclick={() => runHubAiSearch()}>
								{hubAiLoading ? 'Searching...' : 'Search'}
							</button>
						</div>
						<div class="hub-presets">
							{#each [
								'Hong-Ou-Mandel coincidence dip',
								'Gauss law coaxial cable',
								'95% confidence interval chi-square',
								'Kennedy receiver vs Helstrom bound',
								'RC circuit time constant',
								'Maximum Likelihood Estimation'
							] as preset}
								<button class="hub-chip" onclick={() => runHubAiSearch(preset)}>{preset}</button>
							{/each}
						</div>

						{#if hubAiAnswerMarkdown}
							<div class="hub-ai-synthesis-card">
								<div class="hub-ai-synthesis-header">
									<span class="hit-course">Summary</span>
									<div class="hub-rag-actions">
										{#each hubAiRoutedTopics.slice(0, 2) as tm}
											<button
												class="tool-btn"
												onclick={() => {
													showAutoSuiteHub = false;
													selectNote(tm.path);
												}}
											>
												{tm.slug}
											</button>
										{/each}
										<button
											class="tool-btn"
											onclick={() => {
												navigator.clipboard.writeText(hubAiAnswerMarkdown);
												hubAiCopyStatus = 'Copied';
												setTimeout(() => (hubAiCopyStatus = ''), 1800);
											}}
										>
											{hubAiCopyStatus || 'Copy .md'}
										</button>
										<button class="tool-btn" onclick={() => (hubAiShowRaw = !hubAiShowRaw)}>
											{hubAiShowRaw ? 'Rendered' : 'Raw .md'}
										</button>
									</div>
								</div>

								{#if hubAiShowRaw}
									<pre class="raw-markdown-view hub-ai-raw">{hubAiAnswerMarkdown}</pre>
								{:else}
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
									<article class="markdown-body hub-ai-synthesis" onclick={handleArticleClick}>
										{@html hubAiRenderedHtml}
									</article>
								{/if}
							</div>
						{/if}

						{#if hubAiResults.length > 0}
							<div class="hub-ai-results">
								{#each hubAiResults.slice(0, 5) as item, idx}
									<div class="hub-rag-card">
										<div class="hub-rag-top">
											<span class="hit-course">{item.course_code || item.course}</span>
											<strong class="hub-rag-title">#{idx + 1} {item.title}</strong>
											{#if item.score !== undefined}
												<span class="note-item-sub">score {item.score.toFixed(3)}</span>
											{/if}
										</div>
										<!-- svelte-ignore a11y_click_events_have_key_events -->
										<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
										<div class="markdown-body hub-rag-snippet-md" onclick={handleArticleClick}>
											{@html renderMarkdownToHtml(
												[
													item.snippet,
													item.formulas && item.formulas.length > 0
														? `$$\n${item.formulas[0]}\n$$`
														: ''
												]
													.filter(Boolean)
													.join('\n\n'),
												item.path
											).html}
										</div>
										<div class="hub-rag-actions">
											<button
												class="hub-primary-btn"
												onclick={() => {
													showAutoSuiteHub = false;
													selectNote(item.path);
												}}
											>
												Open Note ({item.path.split('/').pop()})
											</button>
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</div>

					<!-- Category Filter Tabs -->
					<div class="hub-filter-tabs">
						{#each HUB_CATEGORIES as cat}
							<button
								class="hub-chip"
								class:active={activeHubCategory === cat}
								onclick={() => (activeHubCategory = cat)}
							>
								{cat === 'All' ? `All Tools (${AUTO_SUITE_TOOLS.length})` : cat}
							</button>
						{/each}
					</div>

					<!-- Tool Cards Grid -->
					<div class="hub-grid">
						{#each filteredHubTools as tool}
							<div class="hub-card">
								<div class="hub-card-top">
									<h3 class="hub-card-title">{tool.num}. {tool.title}</h3>
									<span class="hit-course">{tool.category}</span>
								</div>
								<p class="hub-card-desc">{tool.desc}</p>
								<div class="hub-card-actions">
									<button
										class="hub-primary-btn"
										onclick={() => {
											showAutoSuiteHub = false;
											selectNote(tool.outputNote);
										}}
									>
										Open ({tool.outputNote.split('/').pop()})
									</button>
									<button
										class="tool-btn"
										onclick={() => {
											showAutoSuiteHub = false;
											selectNote(tool.toolNote);
										}}
									>
										Docs
									</button>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{:else if loadingNote}
				<div class="reader-empty">Loading note...</div>
			{:else if !currentNote}
				<div class="reader-empty">Select a note from <code>classes/</code> in the sidebar.</div>
			{:else}
				<div class="note-meta-bar">
					<div class="meta-path">
						<span class="meta-course">{currentNote.course}</span>
						<span class="sep">/</span>
						<code>classes/{currentNote.path}</code>
					</div>
					<div class="meta-stats">
						{#if parsedView.frontmatter.date}
							<span>{parsedView.frontmatter.date}</span>
							<span class="sep">·</span>
						{/if}
						<span>{formatBytes(currentNote.size_bytes)}</span>
					</div>
				</div>

				<!-- Context-Aware Class Material Question Box -->
				<div class="web-note-tutor-bar">
					<div class="web-note-tutor-row">
						<input
							type="text"
							class="search-input web-note-tutor-input"
							placeholder="Ask a question about {currentNote.path.split('/').pop()}..."
							bind:value={noteTutorQuery}
							onkeydown={(e) => {
								if (e.key === 'Enter') askNoteContextAi();
							}}
						/>
						<button
							class="hub-primary-btn"
							disabled={noteTutorLoading}
							onclick={askNoteContextAi}
						>
							{noteTutorLoading ? 'Thinking...' : 'Ask'}
						</button>
						{#if noteTutorOpen}
							<button class="tool-btn" onclick={() => (noteTutorOpen = false)}>
								Hide
							</button>
						{/if}
					</div>

					{#if noteTutorOpen && noteTutorAnswerMd}
						<div class="web-note-tutor-drawer">
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
							<div class="markdown-body hub-ai-rendered" onclick={handleArticleClick}>
								{@html noteTutorRenderedHtml}
							</div>
						</div>
					{/if}
				</div>

				{#if showRaw}
					<pre class="raw-markdown-view">{currentNote.content}</pre>
				{:else}
					{#if activeGuitarTabPayload}
						<section class="web-guitar-player-box">
							<div class="web-gp-header">
								<div>
									<h3 class="web-gp-title">{activeGuitarTabPayload.title}</h3>
								</div>
								<div class="web-gp-badges">
									<span class="hit-course">{Math.round(Number(activeGuitarTabPayload.bpm) || 120)} BPM</span>
									<span class="hit-course">
										{activeGuitarTabPayload.detected_tuning || activeGuitarTabPayload.tuning_name}
									</span>
								</div>
							</div>

							<div class="web-gp-controls">
								<button class="hub-primary-btn" onclick={toggleGuitarPlayback}>
									{gIsPlaying ? 'Pause MIDI' : 'Play Tab MIDI'}
								</button>
								<button
									class="tool-btn"
									onclick={() => {
										stopGuitarPlayback();
										gActiveStepIdx = 0;
									}}
								>
									Stop
								</button>
								<button
									class="tool-btn"
									class:active={gLoopEnabled}
									onclick={() => (gLoopEnabled = !gLoopEnabled)}
								>
									{gLoopEnabled ? 'Loop: ON' : 'Loop: OFF'}
								</button>
								<button class="tool-btn" onclick={strumOpenTuningWeb}>
									Strum Open Strings
								</button>

								<select class="hub-select web-gp-compact-select" bind:value={gSpeedMult}>
									<option value={0.5}>0.5x Speed</option>
									<option value={0.75}>0.75x Speed</option>
									<option value={1}>1.0x Speed</option>
									<option value={1.25}>1.25x Speed</option>
									<option value={1.5}>1.5x Speed</option>
								</select>

								<select class="hub-select web-gp-tuning-select" bind:value={gSelectedTuning}>
									{#each Object.entries(GUITAR_TUNING_PRESETS) as [key, info]}
										<option value={key}>Tuning: {info.label}</option>
									{/each}
								</select>

								<select class="hub-select web-gp-compact-select" bind:value={gSelectedCapo}>
									{#each [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as c}
										<option value={c}>{c === 0 ? 'Capo: 0 (Open)' : `Capo: Fret ${c}`}</option>
									{/each}
								</select>
							</div>

							<div class="web-gp-tuner-bar">
								<div class="web-gp-ref-strings">
									<span class="web-gp-sublabel">Reference Strings (tap to pluck):</span>
									{#each [0, 1, 2, 3, 4, 5] as idx}
										{@const strNum = 6 - idx}
										{@const pitch = gActiveOpenTuning[idx] + gSelectedCapo}
										<button
											class="web-gp-ref-btn"
											onclick={() => pluckGuitarNote(pitch, 1.4, 0)}
										>
											{strNum}: {midiToNoteLabel(pitch, true)} ({midiToFreqHz(pitch, Number(activeGuitarTabPayload.a4_hz) || 440).toFixed(1)}Hz)
										</button>
									{/each}
								</div>
								<button class="hub-primary-btn" onclick={toggleGuitarMicTuner}>
									{gMicActive ? 'Stop Mic Tuner' : 'Live Mic Tuner & Tuning Detector'}
								</button>
							</div>

							{#if gMicActive}
								<div class="web-gp-mic-panel">
									<div class="web-gp-mic-row">
										<span class="web-gp-mic-note">{gMicNoteText}</span>
										<span class="web-gp-mic-freq">{gMicFreqText}</span>
									</div>
									<div class="web-gp-cents-track">
										<div
											class="web-gp-cents-fill"
											style="width: {Math.max(0, Math.min(100, 50 + gMicCents))}%; background: {Math.abs(gMicCents) <= 6 ? '#a6e3a1' : '#f9e2af'};"
										></div>
									</div>
									<div class="web-gp-mic-detected">{gMicDetectedSummary}</div>
								</div>
							{/if}

							{#if activeGuitarTabPayload.tuning_candidates && activeGuitarTabPayload.tuning_candidates.length > 0}
								<div class="web-gp-candidates">
									<span class="web-gp-sublabel">Audio Tuning Detector Top Matches:</span>
									{#each activeGuitarTabPayload.tuning_candidates.slice(0, 4) as cand}
										<button
											class="web-gp-cand-chip"
											class:active={cand.tuning === gSelectedTuning}
											onclick={() => {
												if (GUITAR_TUNING_PRESETS[cand.tuning]) {
													gSelectedTuning = cand.tuning;
												}
											}}
										>
											{cand.tuning} ({cand.notes_label || ''}) · open {cand.open_string_pct}%
										</button>
									{/each}
								</div>
							{/if}

							<div class="web-gp-timeline">
								{#each gRevoicedEvents as ev, idx}
									<button
										class="web-gp-step-pill"
										class:active={idx === gActiveStepIdx}
										onclick={() => {
											gActiveStepIdx = idx;
											playGuitarEventVoicing(ev);
										}}
									>
										{idx + 1}. {ev.chord ? `${ev.chord} ` : ''}[{(ev.voicing || []).map((v) => `${v.string}:${v.fret}`).join(' ')}]
									</button>
								{/each}
							</div>

							<div class="web-gp-fretboard-wrap">
								<div class="web-gp-fretboard">
									<div class="web-gp-fb-row header">
										<div class="web-gp-fb-str">Str</div>
										{#each [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as f}
											<div class="web-gp-fb-cell header">
												{[3, 5, 7, 9, 12, 15].includes(f) ? `${f}*` : f}
											</div>
										{/each}
									</div>
									{#each [1, 2, 3, 4, 5, 6] as s}
										{@const openPitch = gActiveOpenTuning[6 - s] + gSelectedCapo}
										{@const activeVoicing = gRevoicedEvents[gActiveStepIdx]?.voicing || []}
										{@const vHit = activeVoicing.find((v) => v.string === s)}
										<div class="web-gp-fb-row">
											<div class="web-gp-fb-str">{s} ({midiToNoteLabel(openPitch, true)})</div>
											{#each [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as f}
												{@const cellPitch = openPitch + f}
												{@const isHit = vHit && vHit.fret === f}
												{@const isTarget = vHit && vHit.target_fret && vHit.target_fret !== vHit.fret && vHit.target_fret === f}
												<!-- svelte-ignore a11y_click_events_have_key_events -->
												<!-- svelte-ignore a11y_no_static_element_interactions -->
												<div
													class="web-gp-fb-cell"
													class:nut={f === 0}
													class:active={isHit}
													class:target={isTarget}
													title="String {s}, Fret {f}: {midiToNoteLabel(cellPitch, true)} — tap to pluck"
													onclick={() => pluckGuitarNote(cellPitch, 1.0, 0)}
												>
													{#if isHit}
														{f}{vHit?.technique || ''} ({midiToNoteLabel(cellPitch, false)})
													{:else if isTarget}
														-&gt;{f}
													{/if}
												</div>
											{/each}
										</div>
									{/each}
								</div>
							</div>

							<pre class="web-gp-live-tab">{gLiveAsciiTab}</pre>
						</section>
					{/if}

					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<article class="markdown-body" onclick={handleArticleClick}>
						{@html parsedView.html}
					</article>
				{/if}
			{/if}
		</main>

		<!-- Right Outline Sidebar: On This Page -->
		{#if currentNote && !showRaw && parsedView.headings.length > 0}
			<aside class="sidebar-right">
				<div class="sidebar-header">On This Page</div>
				<nav class="toc-nav">
					{#each parsedView.headings as h}
						<a
							href="#{h.id}"
							class="toc-link"
							class:toc-h3={h.level === 3}
						>
							{h.text}
						</a>
					{/each}
				</nav>
			</aside>
		{/if}
	</div>
</div>

<style>
	.notes-shell {
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
		background: var(--mp-bg);
		color: var(--mp-text);
	}

	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		height: 46px;
		padding: 0 1rem;
		background: var(--mp-bg-elevated);
		border-bottom: 1px solid var(--mp-border);
		flex-shrink: 0;
		font-family: var(--mono-font, ui-monospace, monospace);
		font-size: 0.82rem;
	}

	.topbar-left {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.mobile-menu-btn {
		display: none;
		background: transparent;
		border: 1px solid var(--mp-border);
		color: var(--mp-text);
		border-radius: 4px;
		padding: 0.2rem 0.5rem;
		cursor: pointer;
	}

	.brand-link {
		color: var(--mp-text-muted);
		text-decoration: none;
	}
	.brand-link:hover {
		color: var(--mp-red);
	}

	.sep {
		color: var(--mp-text-faint);
	}

	.route-name {
		color: var(--mp-text);
		font-weight: 600;
	}

	.topbar-search {
		position: relative;
		flex: 1;
		max-width: 440px;
	}

	.search-input {
		width: 100%;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		padding: 0.35rem 0.65rem;
		color: var(--mp-text);
		font-family: inherit;
		font-size: 0.82rem;
		outline: none;
	}
	.search-input:focus {
		border-color: var(--mp-accent);
	}

	.search-dropdown {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		max-height: 360px;
		overflow-y: auto;
		z-index: 50;
		box-shadow: 0 8px 20px rgba(0, 0, 0, 0.25);
	}

	.search-empty {
		padding: 0.75rem;
		color: var(--mp-text-muted);
		font-size: 0.78rem;
	}

	.search-hit {
		display: block;
		width: 100%;
		text-align: left;
		padding: 0.6rem 0.75rem;
		background: transparent;
		border: none;
		border-bottom: 1px solid var(--mp-border);
		color: var(--mp-text);
		font-family: inherit;
		cursor: pointer;
	}
	.search-hit:hover {
		background: var(--mp-bg-subtle);
	}

	.hit-top {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin-bottom: 0.2rem;
	}

	.hit-course {
		font-size: 0.7rem;
		font-family: var(--mono-font, ui-monospace, monospace);
		color: var(--mp-purple);
		background: var(--mp-bg-subtle);
		padding: 0.05rem 0.4rem;
		border-radius: 3px;
		font-weight: 600;
	}

	.hit-title {
		font-weight: 600;
		font-size: 0.82rem;
	}

	.hit-snippet {
		font-size: 0.75rem;
		color: var(--mp-text-muted);
		line-height: 1.35;
	}

	.topbar-right {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.tool-btn {
		background: var(--mp-bg);
		border: 1px solid var(--mp-border-strong);
		color: var(--mp-text-body);
		padding: 0.28rem 0.6rem;
		border-radius: 4px;
		font-family: var(--mono-font, ui-monospace, monospace);
		font-size: 0.75rem;
		cursor: pointer;
	}
	.tool-btn:hover,
	.tool-btn.active {
		border-color: var(--mp-red);
		color: var(--mp-red);
	}

	.workspace {
		display: flex;
		flex: 1;
		overflow: hidden;
		position: relative;
	}

	.sidebar-left {
		width: 270px;
		background: var(--mp-bg-elevated);
		border-right: 1px solid var(--mp-border);
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
		overflow-y: auto;
	}

	.sidebar-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.65rem 0.85rem;
		font-family: var(--mono-font, ui-monospace, monospace);
		font-size: 0.72rem;
		color: var(--mp-text-muted);
		border-bottom: 1px solid var(--mp-border);
	}

	.count-pill {
		color: var(--mp-text-muted);
		font-size: 0.7rem;
	}

	.sidebar-empty {
		padding: 1rem;
		color: var(--mp-text-muted);
		font-size: 0.8rem;
	}

	.tree-nav {
		padding: 0.4rem 0;
	}

	.course-group {
		margin-bottom: 0.25rem;
	}

	.course-header {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: 100%;
		padding: 0.4rem 0.75rem;
		background: transparent;
		border: none;
		color: var(--mp-text);
		font-family: var(--mono-font, ui-monospace, monospace);
		font-size: 0.78rem;
		font-weight: 600;
		cursor: pointer;
		text-align: left;
	}
	.course-header:hover {
		background: var(--mp-bg-subtle);
	}

	.caret {
		color: var(--mp-text-faint);
		width: 12px;
	}

	.course-name {
		color: var(--mp-text);
		flex: 1;
	}

	.course-count {
		color: var(--mp-text-faint);
		font-size: 0.7rem;
	}

	.course-items {
		display: flex;
		flex-direction: column;
		padding-left: 0.65rem;
	}

	.note-item {
		display: flex;
		flex-direction: column;
		gap: 0.12rem;
		width: 100%;
		text-align: left;
		padding: 0.4rem 0.75rem;
		background: transparent;
		border: none;
		border-left: 2px solid transparent;
		color: var(--mp-text-muted);
		font-family: inherit;
		cursor: pointer;
	}
	.note-item:hover {
		background: var(--mp-bg-subtle);
		color: var(--mp-text);
	}
	.note-item.selected {
		background: var(--mp-bg-subtle);
		border-left-color: var(--mp-red);
		color: var(--mp-text);
		font-weight: 600;
	}

	.note-item-title {
		font-size: 0.82rem;
		font-weight: 500;
		line-height: 1.25;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.note-item-sub {
		font-family: var(--mono-font, ui-monospace, monospace);
		font-size: 0.68rem;
		color: var(--mp-text-faint);
	}

	.reader-pane {
		flex: 1;
		overflow-y: auto;
		padding: 1.5rem 2.25rem 4rem;
		max-width: 900px;
		margin: 0 auto;
	}

	.reader-empty {
		padding: 3rem 1rem;
		color: var(--mp-text-muted);
		font-size: 0.85rem;
	}

	.note-meta-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding-bottom: 0.75rem;
		margin-bottom: 1.15rem;
		border-bottom: 1px solid var(--mp-border);
		font-family: var(--mono-font, ui-monospace, monospace);
		font-size: 0.75rem;
		color: var(--mp-text-muted);
	}

	.meta-path {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.meta-course {
		color: var(--mp-red);
		font-weight: 600;
	}

	.raw-markdown-view {
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border);
		border-radius: 4px;
		padding: 1rem;
		font-family: var(--mono-font, ui-monospace, monospace);
		font-size: 0.8rem;
		line-height: 1.55;
		color: var(--mp-text-body);
		white-space: pre-wrap;
		word-break: break-word;
	}

	/* Right TOC sidebar */
	.sidebar-right {
		width: 230px;
		background: var(--mp-bg-elevated);
		border-left: 1px solid var(--mp-border);
		overflow-y: auto;
		flex-shrink: 0;
	}

	.toc-nav {
		display: flex;
		flex-direction: column;
		padding: 0.5rem 0.75rem 2rem;
		gap: 0.25rem;
	}

	.toc-link {
		color: var(--mp-text-muted);
		text-decoration: none;
		font-size: 0.76rem;
		line-height: 1.35;
		padding: 0.2rem 0.35rem;
		border-radius: 3px;
	}
	.toc-link:hover {
		color: var(--mp-text);
		background: var(--mp-bg-subtle);
	}
	.toc-link.toc-h3 {
		padding-left: 1rem;
		font-size: 0.72rem;
		color: var(--mp-text-faint);
	}

	/* Rendered Markdown Content */
	.markdown-body :global(.note-h1) {
		font-size: 1.55rem;
		font-weight: 700;
		color: var(--mp-text);
		margin: 0.5rem 0 1rem;
		line-height: 1.3;
	}

	.markdown-body :global(.note-h2) {
		font-size: 1.2rem;
		font-weight: 600;
		color: var(--mp-text);
		margin: 1.85rem 0 0.75rem;
		padding-bottom: 0.35rem;
		border-bottom: 1px solid var(--mp-border);
	}

	.markdown-body :global(.note-h3) {
		font-size: 1.02rem;
		font-weight: 600;
		color: var(--mp-text);
		margin: 1.25rem 0 0.5rem;
	}

	.markdown-body :global(.note-h4) {
		font-size: 0.94rem;
		font-weight: 600;
		color: var(--mp-text-body);
		margin: 1rem 0 0.4rem;
	}

	.markdown-body :global(.note-p) {
		line-height: 1.65;
		margin: 0.65rem 0;
		color: var(--mp-text-body);
		font-size: 0.95rem;
	}

	.markdown-body :global(.note-ul),
	.markdown-body :global(.note-ol) {
		margin: 0.6rem 0;
		padding-left: 1.4rem;
		line-height: 1.65;
		color: var(--mp-text-body);
		font-size: 0.94rem;
	}

	.markdown-body :global(li) {
		margin: 0.3rem 0;
	}

	.markdown-body :global(.note-hr) {
		border: none;
		border-top: 1px solid var(--mp-border);
		margin: 1.75rem 0;
	}

	.markdown-body :global(.note-figure) {
		margin: 1rem 0;
	}

	.markdown-body :global(.note-figure img) {
		max-width: 100%;
		height: auto;
		border-radius: 4px;
		border: 1px solid var(--mp-border);
		background: var(--mp-bg-elevated);
		display: block;
	}

	.markdown-body :global(.math-display) {
		margin: 1rem 0;
		padding: 0.65rem 0.9rem;
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border);
		border-radius: 4px;
		overflow-x: auto;
	}

	.markdown-body :global(.inline-code) {
		font-family: var(--mono-font, ui-monospace, monospace);
		font-size: 0.85em;
		background: var(--mp-bg-subtle);
		border: 1px solid var(--mp-border);
		padding: 0.1rem 0.35rem;
		border-radius: 3px;
		color: var(--mp-red);
	}

	.markdown-body :global(.code-block) {
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border);
		border-radius: 4px;
		padding: 0.85rem 1rem;
		overflow-x: auto;
		font-family: var(--mono-font, ui-monospace, monospace);
		font-size: 0.82rem;
		line-height: 1.5;
	}

	.markdown-body :global(.wikilink),
	.markdown-body :global(.md-link) {
		color: var(--mp-cyan);
		text-decoration: underline;
		text-decoration-color: var(--mp-border-strong);
	}
	.markdown-body :global(.wikilink:hover),
	.markdown-body :global(.md-link:hover) {
		color: var(--mp-red);
	}

	.markdown-body :global(.callout) {
		margin: 1rem 0;
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border);
		border-left: 3px solid var(--mp-purple);
		border-radius: 4px;
		overflow: hidden;
	}

	.markdown-body :global(.callout-title) {
		padding: 0.5rem 0.85rem;
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--mp-text);
		cursor: pointer;
		user-select: none;
	}

	.markdown-body :global(.callout-body) {
		padding: 0.25rem 0.85rem 0.75rem;
		font-size: 0.88rem;
		color: var(--mp-text-body);
		border-top: 1px solid var(--mp-border);
	}

	.markdown-body :global(.note-quote) {
		margin: 0.85rem 0;
		padding: 0.4rem 0.9rem;
		border-left: 3px solid var(--mp-orange);
		color: var(--mp-text-muted);
	}

	.markdown-body :global(.table-wrap) {
		overflow-x: auto;
		margin: 1rem 0;
	}

	.markdown-body :global(.note-table) {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}

	.markdown-body :global(.note-table th),
	.markdown-body :global(.note-table td) {
		border: 1px solid var(--mp-border);
		padding: 0.45rem 0.65rem;
		text-align: left;
	}

	.markdown-body :global(.note-table th) {
		background: var(--mp-bg-elevated);
		color: var(--mp-text);
		font-size: 0.8rem;
	}

	/* Tools & Search View */
	.hub-container {
		display: flex;
		flex-direction: column;
		gap: 1.15rem;
	}
	.hub-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.75rem;
		padding-bottom: 0.85rem;
		border-bottom: 1px solid var(--mp-border);
	}
	.hub-title {
		margin: 0;
		font-size: 1.25rem;
		color: var(--mp-text);
	}
	.hub-sub {
		margin: 0.25rem 0 0;
		font-size: 0.85rem;
		color: var(--mp-text-muted);
	}
	.hub-pills {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.hub-search-box {
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border);
		border-radius: 4px;
		padding: 0.85rem;
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
	}
	.hub-search-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.hub-search-row .search-input {
		flex: 1;
		min-width: 180px;
	}
	.hub-select {
		background: var(--mp-bg);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		color: var(--mp-text);
		font-family: inherit;
		font-size: 0.78rem;
		padding: 0.35rem 0.55rem;
	}
	.hub-primary-btn {
		background: var(--mp-btn-bg);
		border: 1px solid transparent;
		color: var(--mp-btn-fg);
		border-radius: 4px;
		padding: 0.38rem 0.75rem;
		font-family: inherit;
		font-size: 0.78rem;
		font-weight: 600;
		cursor: pointer;
	}
	.hub-primary-btn:hover {
		background: var(--mp-btn-hover);
		color: var(--mp-btn-hover-fg);
	}
	.hub-presets,
	.hub-filter-tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.hub-chip {
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
		color: var(--mp-text-muted);
		border-radius: 4px;
		padding: 0.22rem 0.6rem;
		font-family: inherit;
		font-size: 0.75rem;
		cursor: pointer;
	}
	.hub-chip:hover,
	.hub-chip.active {
		border-color: var(--mp-red);
		color: var(--mp-red);
		background: var(--mp-bg-subtle);
	}
	.hub-ai-synthesis-card {
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
		border-radius: 4px;
		padding: 0.85rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
		margin-top: 0.35rem;
	}
	.hub-ai-synthesis-header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding-bottom: 0.45rem;
		border-bottom: 1px solid var(--mp-border);
	}
	.hub-ai-synthesis {
		font-size: 0.88rem;
		line-height: 1.6;
		max-height: 480px;
		overflow-y: auto;
	}
	.hub-ai-raw {
		max-height: 380px;
		overflow-y: auto;
		margin: 0;
	}
	.hub-rag-snippet-md {
		font-size: 0.82rem;
		line-height: 1.5;
		color: var(--mp-text-muted);
	}
	.hub-ai-results {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}
	.hub-rag-card {
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
		border-radius: 4px;
		padding: 0.65rem 0.8rem;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.hub-rag-top {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.hub-rag-title {
		font-size: 0.85rem;
		color: var(--mp-text);
	}
	.hub-rag-actions {
		display: flex;
		gap: 0.4rem;
		margin-top: 0.2rem;
	}
	.hub-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 0.85rem;
	}
	.hub-card {
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border);
		border-radius: 4px;
		padding: 0.85rem;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}
	.hub-card-top {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.hub-card-title {
		margin: 0;
		font-size: 0.92rem;
		color: var(--mp-text);
		line-height: 1.3;
	}
	.hub-card-desc {
		margin: 0;
		font-size: 0.82rem;
		color: var(--mp-text-muted);
		line-height: 1.45;
		flex: 1;
	}
	.hub-card-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
		margin-top: 0.35rem;
	}

	/* Guitar Tab Player */
	.web-guitar-player-box {
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border);
		border-radius: 4px;
		padding: 0.85rem 1rem;
		margin: 0 auto 1.25rem auto;
		max-width: 900px;
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
	}
	.web-gp-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.5rem;
		border-bottom: 1px solid var(--mp-border);
		padding-bottom: 0.5rem;
	}
	.web-gp-title {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--mp-text);
	}
	.web-gp-badges {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.web-gp-controls {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.45rem;
	}
	.web-gp-compact-select {
		width: auto;
		min-width: 115px;
	}
	.web-gp-tuning-select {
		flex: 1;
		min-width: 230px;
	}
	.web-gp-tuner-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.5rem;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
		border-radius: 4px;
		padding: 0.45rem 0.65rem;
	}
	.web-gp-ref-strings {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.35rem;
	}
	.web-gp-sublabel {
		font-size: 0.75rem;
		color: var(--mp-text-muted);
	}
	.web-gp-ref-btn {
		background: var(--mp-bg-subtle);
		border: 1px solid var(--mp-border);
		color: var(--mp-text-body);
		border-radius: 3px;
		padding: 0.2rem 0.45rem;
		font-size: 0.72rem;
		font-family: var(--mono-font, ui-monospace, monospace);
		cursor: pointer;
	}
	.web-gp-ref-btn:hover {
		border-color: var(--mp-red);
		background: var(--mp-bg-hover);
	}
	.web-gp-mic-panel {
		background: var(--mp-bg);
		border: 1px solid var(--mp-border-strong);
		border-radius: 4px;
		padding: 0.55rem 0.75rem;
	}
	.web-gp-mic-row {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
	.web-gp-mic-note {
		font-size: 1.05rem;
		font-weight: 700;
		color: var(--mp-green);
	}
	.web-gp-mic-freq {
		font-size: 0.75rem;
		color: var(--mp-text-muted);
	}
	.web-gp-cents-track {
		height: 6px;
		background: var(--mp-bg-subtle);
		border-radius: 3px;
		overflow: hidden;
		margin: 0.4rem 0;
	}
	.web-gp-cents-fill {
		height: 100%;
		transition: width 0.08s ease;
	}
	.web-gp-mic-detected {
		font-size: 0.75rem;
		color: var(--mp-text-body);
	}
	.web-gp-candidates {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.web-gp-cand-chip {
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
		color: var(--mp-text-muted);
		border-radius: 3px;
		padding: 0.18rem 0.5rem;
		font-size: 0.72rem;
		font-family: var(--mono-font, ui-monospace, monospace);
		cursor: pointer;
	}
	.web-gp-cand-chip.active,
	.web-gp-cand-chip:hover {
		border-color: var(--mp-red);
		color: var(--mp-red);
		background: var(--mp-bg-subtle);
	}
	.web-gp-timeline {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}
	.web-gp-step-pill {
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
		color: var(--mp-text-body);
		border-radius: 3px;
		padding: 0.2rem 0.5rem;
		font-size: 0.72rem;
		font-family: var(--mono-font, ui-monospace, monospace);
		cursor: pointer;
	}
	.web-gp-step-pill.active {
		background: var(--mp-bg-subtle);
		border-color: var(--mp-red);
		color: var(--mp-red);
		font-weight: 600;
	}
	.web-gp-fretboard-wrap {
		overflow-x: auto;
		border: 1px solid var(--mp-border);
		border-radius: 4px;
		background: var(--mp-bg);
	}
	.web-gp-fretboard {
		display: flex;
		flex-direction: column;
		min-width: 680px;
		font-family: var(--mono-font, ui-monospace, monospace);
	}
	.web-gp-fb-row {
		display: grid;
		grid-template-columns: 74px repeat(16, minmax(36px, 1fr));
		border-bottom: 1px solid var(--mp-border-subtle);
	}
	.web-gp-fb-row.header {
		background: var(--mp-bg-elevated);
		color: var(--mp-text-muted);
		font-weight: 600;
	}
	.web-gp-fb-str {
		padding: 0.25rem 0.4rem;
		font-size: 0.68rem;
		font-weight: 600;
		color: var(--mp-text-body);
		border-right: 2px solid var(--mp-border-strong);
	}
	.web-gp-fb-cell {
		padding: 0.25rem 0.15rem;
		font-size: 0.65rem;
		text-align: center;
		border-right: 1px solid var(--mp-border-subtle);
		cursor: pointer;
		color: var(--mp-text-faint);
		user-select: none;
	}
	.web-gp-fb-cell.nut {
		border-right: 2px solid var(--mp-border-strong);
		background: var(--mp-bg-elevated);
	}
	.web-gp-fb-cell:hover {
		background: var(--mp-bg-subtle);
		color: var(--mp-text);
	}
	.web-gp-fb-cell.active {
		background: var(--mp-red);
		color: #fff;
		font-weight: 700;
	}
	.web-gp-fb-cell.target {
		background: var(--mp-bg-subtle);
		color: var(--mp-orange);
		font-weight: 600;
	}
	.web-gp-live-tab {
		margin: 0;
		padding: 0.55rem 0.7rem;
		background: var(--mp-bg);
		border: 1px solid var(--mp-border);
		border-radius: 4px;
		font-family: var(--mono-font, ui-monospace, monospace);
		font-size: 0.74rem;
		line-height: 1.38;
		color: var(--mp-text-body);
		overflow-x: auto;
	}

	/* Note Question Bar */
	.web-note-tutor-bar {
		max-width: 900px;
		margin: 0 auto 1rem auto;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.web-note-tutor-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.45rem;
	}
	.web-note-tutor-input {
		flex: 1 1 220px;
		min-width: 180px;
	}
	.web-note-tutor-drawer {
		background: var(--mp-bg-elevated);
		border: 1px solid var(--mp-border);
		border-radius: 4px;
		padding: 0.65rem 0.85rem;
		max-height: 360px;
		overflow-y: auto;
	}

	@media (max-width: 1024px) {
		.sidebar-right {
			display: none;
		}
	}

	@media (max-width: 768px) {
		.mobile-menu-btn {
			display: inline-block;
		}
		.sidebar-left {
			position: absolute;
			top: 0;
			bottom: 0;
			left: 0;
			z-index: 40;
			transform: translateX(-100%);
			transition: transform 0.2s ease;
		}
		.sidebar-left.open {
			transform: translateX(0);
		}
		.reader-pane {
			padding: 1rem;
		}
	}
</style>
