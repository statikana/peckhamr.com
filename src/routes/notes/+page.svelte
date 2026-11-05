<script lang="ts">
	import { onMount } from 'svelte';

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
		title: string;
		snippet: string;
		updated_at: number;
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
	let searchQuery = $state('');
	let searchHits = $state<SearchHit[]>([]);
	let searching = $state(false);
	let collapsedCourses = $state<Record<string, boolean>>({});
	let mobileSidebarOpen = $state(false);
	let copyStatus = $state('');
	let katexReady = $state(false);

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
	const parsedView = $derived.by(() => {
		// touch katexReady so Svelte re-evaluates once KaTeX script loads
		const _k = katexReady;
		if (!currentNote || !currentNote.content) {
			return { frontmatter: {} as Record<string, string>, html: '', headings: [] as HeadingItem[] };
		}

		let raw = currentNote.content.replace(/\r\n/g, '\n');
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
				const resolved = resolveRelativePath(currentNote!.path, target);
				const srcUrl = `/notes/api?action=asset&path=${encodeURIComponent(resolved)}`;
				const maxW = widthSpec && /^\d+$/.test(widthSpec.trim()) ? `style="max-width:${widthSpec.trim()}px"` : '';
				return `<figure class="note-figure"><img src="${srcUrl}" alt="${target}" loading="lazy" ${maxW} /></figure>`;
			});

			// Standard Markdown image ![alt](url)
			s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
				const resolved = url.startsWith('http')
					? url
					: `/notes/api?action=asset&path=${encodeURIComponent(resolveRelativePath(currentNote!.path, url))}`;
				return `<figure class="note-figure"><img src="${resolved}" alt="${alt}" loading="lazy" /></figure>`;
			});

			// Obsidian internal heading link [[#Heading|Label]] or [[#Heading]]
			s = s.replace(/\[\[#([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, targetHeading, label) => {
				const slug = slugifyHeading(targetHeading);
				return `<a href="#${slug}" class="wikilink">${label || targetHeading}</a>`;
			});

			// Obsidian cross-note wikilink [[note_name|Label]]
			s = s.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_m, noteTarget, label) => {
				const display = label || noteTarget;
				return `<a href="?note=${encodeURIComponent(noteTarget)}" data-wikilink="${noteTarget}" class="wikilink">${display}</a>`;
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
						.map((ql) => `<p>${formatInline(ql)}</p>`)
						.join('');
					const openAttr = foldFlag === '-' ? '' : 'open';
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
	});

	async function fetchTree() {
		loadingTree = true;
		try {
			const res = await fetch('/notes/api?action=tree');
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
			const res = await fetch(`/notes/api?action=note&path=${encodeURIComponent(path)}`);
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
				const res = await fetch(`/notes/api?action=search&q=${encodeURIComponent(q)}`);
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
		if (!linkName) return;
		e.preventDefault();
		const match = notesList.find(
			(n) =>
				n.path === linkName ||
				n.path.endsWith(`/${linkName}.md`) ||
				n.path.toLowerCase().endsWith(`${linkName.toLowerCase()}.md`)
		);
		if (match) {
			selectNote(match.path);
		}
	}

	function copyShareLink() {
		if (!selectedPath) return;
		const url = `${window.location.origin}/notes/?note=${encodeURIComponent(selectedPath)}`;
		navigator.clipboard.writeText(url);
		copyStatus = 'copied url';
		setTimeout(() => (copyStatus = ''), 2000);
	}

	function formatBytes(b: number): string {
		if (b < 1024) return `${b} B`;
		return `${(b / 1024).toFixed(1)} KB`;
	}

	onMount(() => {
		fetchTree();
		if (typeof window !== 'undefined' && (window as any).katex) {
			katexReady = true;
		}
	});
</script>

<svelte:head>
	<title>{currentNote ? `${currentNote.title} — classes/` : 'classes/ — Lecture Notes'}</title>
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
			<a href="/" class="brand-link">peckhamr.com</a>
			<span class="sep">/</span>
			<span class="route-name">notes</span>
			<span class="role-badge" title="Served from Cloudflare D1 via a read-only GET role">
				read-only
			</span>
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
			{#if currentNote}
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
			{#if loadingNote}
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

				{#if showRaw}
					<pre class="raw-markdown-view">{currentNote.content}</pre>
				{:else}
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
	:global(body) {
		margin: 0;
		background: #121214;
		color: #e4e4e7;
		font-family:
			'Inter',
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			Roboto,
			sans-serif;
	}

	.notes-shell {
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
		background: #121214;
	}

	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		height: 48px;
		padding: 0 1rem;
		background: #18181b;
		border-bottom: 1px solid #27272a;
		flex-shrink: 0;
		font-family: 'JetBrains Mono', monospace;
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
		border: 1px solid #27272a;
		color: #e4e4e7;
		border-radius: 4px;
		padding: 0.2rem 0.5rem;
		cursor: pointer;
	}

	.brand-link {
		color: #a1a1aa;
		text-decoration: none;
	}
	.brand-link:hover {
		color: #9ffdd8;
	}

	.sep {
		color: #52525b;
	}

	.route-name {
		color: #f4f4f5;
		font-weight: 600;
	}

	.role-badge {
		font-size: 0.7rem;
		padding: 0.1rem 0.45rem;
		border-radius: 3px;
		background: rgba(159, 253, 216, 0.08);
		color: #9ffdd8;
		border: 1px solid rgba(159, 253, 216, 0.25);
	}

	.topbar-search {
		position: relative;
		flex: 1;
		max-width: 440px;
	}

	.search-input {
		width: 100%;
		background: #121214;
		border: 1px solid #27272a;
		border-radius: 4px;
		padding: 0.35rem 0.65rem;
		color: #e4e4e7;
		font-family: 'JetBrains Mono', monospace;
		font-size: 0.78rem;
		outline: none;
	}
	.search-input:focus {
		border-color: #9ffdd8;
	}

	.search-dropdown {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		background: #18181b;
		border: 1px solid #3f3f46;
		border-radius: 6px;
		max-height: 360px;
		overflow-y: auto;
		z-index: 50;
		box-shadow: 0 12px 28px rgba(0, 0, 0, 0.6);
	}

	.search-empty {
		padding: 0.75rem;
		color: #71717a;
		font-size: 0.78rem;
	}

	.search-hit {
		display: block;
		width: 100%;
		text-align: left;
		padding: 0.6rem 0.75rem;
		background: transparent;
		border: none;
		border-bottom: 1px solid #27272a;
		color: #e4e4e7;
		cursor: pointer;
	}
	.search-hit:hover {
		background: #27272a;
	}

	.hit-top {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin-bottom: 0.2rem;
	}

	.hit-course {
		font-size: 0.68rem;
		color: #9ffdd8;
		background: rgba(159, 253, 216, 0.1);
		padding: 0.05rem 0.35rem;
		border-radius: 3px;
	}

	.hit-title {
		font-weight: 600;
		font-size: 0.8rem;
	}

	.hit-snippet {
		font-size: 0.73rem;
		color: #a1a1aa;
		line-height: 1.35;
	}

	.topbar-right {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.tool-btn {
		background: #121214;
		border: 1px solid #27272a;
		color: #a1a1aa;
		padding: 0.28rem 0.6rem;
		border-radius: 4px;
		font-family: 'JetBrains Mono', monospace;
		font-size: 0.74rem;
		cursor: pointer;
	}
	.tool-btn:hover,
	.tool-btn.active {
		border-color: #9ffdd8;
		color: #9ffdd8;
	}

	.workspace {
		display: flex;
		flex: 1;
		overflow: hidden;
		position: relative;
	}

	.sidebar-left {
		width: 280px;
		background: #161618;
		border-right: 1px solid #27272a;
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
		font-family: 'JetBrains Mono', monospace;
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #71717a;
		border-bottom: 1px solid #27272a;
	}

	.count-pill {
		background: #27272a;
		color: #a1a1aa;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		font-size: 0.68rem;
	}

	.sidebar-empty {
		padding: 1rem;
		color: #71717a;
		font-size: 0.8rem;
		font-family: 'JetBrains Mono', monospace;
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
		color: #d4d4d8;
		font-family: 'JetBrains Mono', monospace;
		font-size: 0.78rem;
		font-weight: 600;
		cursor: pointer;
		text-align: left;
	}
	.course-header:hover {
		background: rgba(255, 255, 255, 0.03);
	}

	.caret {
		color: #71717a;
		width: 12px;
	}

	.course-name {
		color: #9ffdd8;
		flex: 1;
	}

	.course-count {
		color: #52525b;
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
		padding: 0.42rem 0.75rem;
		background: transparent;
		border: none;
		border-left: 2px solid transparent;
		color: #a1a1aa;
		cursor: pointer;
	}
	.note-item:hover {
		background: rgba(255, 255, 255, 0.03);
		color: #f4f4f5;
	}
	.note-item.selected {
		background: rgba(159, 253, 216, 0.06);
		border-left-color: #9ffdd8;
		color: #f4f4f5;
	}

	.note-item-title {
		font-size: 0.8rem;
		font-weight: 500;
		line-height: 1.25;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.note-item-sub {
		font-family: 'JetBrains Mono', monospace;
		font-size: 0.68rem;
		color: #52525b;
	}

	.reader-pane {
		flex: 1;
		overflow-y: auto;
		padding: 1.5rem 2.25rem 4rem;
		max-width: 920px;
		margin: 0 auto;
	}

	.reader-empty {
		padding: 3rem 1rem;
		color: #71717a;
		font-family: 'JetBrains Mono', monospace;
		font-size: 0.85rem;
	}

	.note-meta-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding-bottom: 0.75rem;
		margin-bottom: 1.25rem;
		border-bottom: 1px solid #27272a;
		font-family: 'JetBrains Mono', monospace;
		font-size: 0.75rem;
		color: #71717a;
	}

	.meta-path {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.meta-course {
		color: #9ffdd8;
		font-weight: 600;
		text-transform: uppercase;
	}

	.raw-markdown-view {
		background: #18181b;
		border: 1px solid #27272a;
		border-radius: 6px;
		padding: 1rem;
		font-family: 'JetBrains Mono', monospace;
		font-size: 0.8rem;
		line-height: 1.55;
		color: #d4d4d8;
		white-space: pre-wrap;
		word-break: break-word;
	}

	/* Right TOC sidebar */
	.sidebar-right {
		width: 240px;
		background: #161618;
		border-left: 1px solid #27272a;
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
		color: #a1a1aa;
		text-decoration: none;
		font-size: 0.75rem;
		line-height: 1.35;
		padding: 0.2rem 0.35rem;
		border-radius: 3px;
	}
	.toc-link:hover {
		color: #9ffdd8;
		background: rgba(159, 253, 216, 0.05);
	}
	.toc-link.toc-h3 {
		padding-left: 1rem;
		font-size: 0.71rem;
		color: #71717a;
	}

	/* Rendered Markdown Content */
	.markdown-body :global(.note-h1) {
		font-size: 1.55rem;
		font-weight: 700;
		color: #fafafa;
		margin: 0.5rem 0 1rem;
		line-height: 1.3;
	}

	.markdown-body :global(.note-h2) {
		font-size: 1.2rem;
		font-weight: 600;
		color: #9ffdd8;
		margin: 2rem 0 0.75rem;
		padding-bottom: 0.35rem;
		border-bottom: 1px solid #27272a;
	}

	.markdown-body :global(.note-h3) {
		font-size: 1rem;
		font-weight: 600;
		color: #e4e4e7;
		margin: 1.25rem 0 0.5rem;
	}

	.markdown-body :global(.note-h4) {
		font-size: 0.92rem;
		font-weight: 600;
		color: #d4d4d8;
		margin: 1rem 0 0.4rem;
	}

	.markdown-body :global(.note-p) {
		line-height: 1.68;
		margin: 0.65rem 0;
		color: #d4d4d8;
		font-size: 0.95rem;
	}

	.markdown-body :global(.note-ul),
	.markdown-body :global(.note-ol) {
		margin: 0.6rem 0;
		padding-left: 1.4rem;
		line-height: 1.65;
		color: #d4d4d8;
		font-size: 0.94rem;
	}

	.markdown-body :global(li) {
		margin: 0.3rem 0;
	}

	.markdown-body :global(.note-hr) {
		border: none;
		border-top: 1px solid #27272a;
		margin: 1.75rem 0;
	}

	.markdown-body :global(.note-figure) {
		margin: 1rem 0;
	}

	.markdown-body :global(.note-figure img) {
		max-width: 100%;
		height: auto;
		border-radius: 6px;
		border: 1px solid #27272a;
		background: #18181b;
		display: block;
	}

	.markdown-body :global(.math-display) {
		margin: 1rem 0;
		padding: 0.65rem 0.9rem;
		background: #18181b;
		border: 1px solid #27272a;
		border-radius: 6px;
		overflow-x: auto;
	}

	.markdown-body :global(.inline-code) {
		font-family: 'JetBrains Mono', monospace;
		font-size: 0.83em;
		background: #18181b;
		border: 1px solid #27272a;
		padding: 0.1rem 0.35rem;
		border-radius: 4px;
		color: #9ffdd8;
	}

	.markdown-body :global(.code-block) {
		background: #18181b;
		border: 1px solid #27272a;
		border-radius: 6px;
		padding: 0.85rem 1rem;
		overflow-x: auto;
		font-family: 'JetBrains Mono', monospace;
		font-size: 0.82rem;
		line-height: 1.5;
	}

	.markdown-body :global(.wikilink),
	.markdown-body :global(.md-link) {
		color: #9ffdd8;
		text-decoration: none;
		border-bottom: 1px dashed rgba(159, 253, 216, 0.4);
	}
	.markdown-body :global(.wikilink:hover),
	.markdown-body :global(.md-link:hover) {
		border-bottom-style: solid;
	}

	.markdown-body :global(.callout) {
		margin: 1rem 0;
		background: #18181b;
		border: 1px solid #27272a;
		border-left: 3px solid #9ffdd8;
		border-radius: 6px;
		overflow: hidden;
	}

	.markdown-body :global(.callout-title) {
		padding: 0.55rem 0.85rem;
		font-family: 'JetBrains Mono', monospace;
		font-size: 0.78rem;
		font-weight: 600;
		color: #9ffdd8;
		cursor: pointer;
		user-select: none;
	}

	.markdown-body :global(.callout-body) {
		padding: 0.25rem 0.85rem 0.75rem;
		font-size: 0.86rem;
		color: #a1a1aa;
		border-top: 1px solid #27272a;
	}

	.markdown-body :global(.note-quote) {
		margin: 0.85rem 0;
		padding: 0.4rem 0.9rem;
		border-left: 3px solid #52525b;
		color: #a1a1aa;
		background: rgba(255, 255, 255, 0.02);
	}

	.markdown-body :global(.table-wrap) {
		overflow-x: auto;
		margin: 1rem 0;
	}

	.markdown-body :global(.note-table) {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.86rem;
	}

	.markdown-body :global(.note-table th),
	.markdown-body :global(.note-table td) {
		border: 1px solid #27272a;
		padding: 0.45rem 0.65rem;
		text-align: left;
	}

	.markdown-body :global(.note-table th) {
		background: #18181b;
		color: #9ffdd8;
		font-family: 'JetBrains Mono', monospace;
		font-size: 0.78rem;
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
