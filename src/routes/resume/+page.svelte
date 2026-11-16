<script lang="ts">
    import { onMount, onDestroy } from "svelte";
    import { page } from "$app/state";
    import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
    import { appUrl } from "../../lib/apps";

    const PDF_URL = "/ryan_peckham_resume.pdf";
    const MIN_ZOOM = 0.75;
    const MAX_ZOOM = 2.5;
    const ZOOM_STEP = 0.25;
    const MAX_DESKTOP_FIT_WIDTH = 860;
    const MAX_CANVAS_PIXELS = 12_000_000;

    let theme = $state<"light" | "dark">("light");
    let zoom = $state(1);
    let numPages = $state(0);
    let loading = $state(true);
    let errorMessage = $state<string | null>(null);

    let stageEl = $state<HTMLDivElement | null>(null);
    let pagesEl = $state<HTMLDivElement | null>(null);

    let pdfDoc: PDFDocumentProxy | null = null;
    let pdfjsLib: typeof import("pdfjs-dist") | null = null;
    let activeRenderTasks: RenderTask[] = [];
    let activeTextLayers: Array<{ cancel: () => void }> = [];
    let renderGeneration = 0;
    let lastMeasuredWidth = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    function applyTheme(nextTheme: "light" | "dark") {
        theme = nextTheme;
        if (typeof document !== "undefined") {
            document.documentElement.setAttribute("data-theme", theme);
        }
        try {
            localStorage.setItem("peckhamr-theme", theme);
        } catch {
            // Ignore storage errors in restricted browsing contexts.
        }
    }

    function toggleTheme() {
        applyTheme(theme === "light" ? "dark" : "light");
    }

    function createLinkService() {
        return {
            externalLinkEnabled: true,
            externalLinkTarget: 2, // LinkTarget.BLANK
            externalLinkRel: "noopener noreferrer",
            isInPresentationMode: false,
            eventBus: null,
            pagesCount: numPages,
            page: 1,
            rotation: 0,
            addLinkAttributes(link: HTMLAnchorElement, url: string, newWindow = false) {
                link.href = url;
                link.title = url;
                if (url.startsWith("http://") || url.startsWith("https://") || newWindow) {
                    link.target = "_blank";
                    link.rel = "noopener noreferrer";
                }
            },
            getDestinationHash() {
                return "#";
            },
            getAnchorUrl(hash: string) {
                return hash || "#";
            },
            async goToDestination() {},
            executeNamedAction() {},
            executeSetOCGState() {}
        };
    }

    function cancelActiveRendering() {
        for (const task of activeRenderTasks) {
            try {
                task.cancel();
            } catch {
                // Ignore already-completed tasks.
            }
        }
        activeRenderTasks = [];

        for (const textLayer of activeTextLayers) {
            try {
                textLayer.cancel();
            } catch {
                // Ignore already-completed text layers.
            }
        }
        activeTextLayers = [];
    }

    async function renderPage(
        pdfPage: PDFPageProxy,
        fitWidth: number,
        generation: number
    ): Promise<HTMLDivElement | null> {
        if (!pdfjsLib || generation !== renderGeneration) return null;

        const baseViewport = pdfPage.getViewport({ scale: 1 });
        const scale = (fitWidth / baseViewport.width) * zoom;
        const viewport = pdfPage.getViewport({ scale });

        const cssWidth = Math.max(1, Math.floor(viewport.width));
        const cssHeight = Math.max(1, Math.floor(viewport.height));

        // Clamp DPR-scaled canvas area so iOS Safari does not hit its canvas memory limit.
        const rawDpr = Math.min(window.devicePixelRatio || 1, 3);
        const maxSafeDpr = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, cssWidth * cssHeight));
        const outputScale = Math.max(1, Math.min(rawDpr, maxSafeDpr));

        const pageWrap = document.createElement("div");
        pageWrap.className = "pdf-page";
        pageWrap.style.width = `${cssWidth}px`;
        pageWrap.style.height = `${cssHeight}px`;
        pageWrap.style.setProperty("--scale-factor", `${scale}`);
        pageWrap.style.setProperty("--total-scale-factor", `${scale}`);
        pageWrap.style.setProperty("--scale-round-x", "1px");
        pageWrap.style.setProperty("--scale-round-y", "1px");

        const canvas = document.createElement("canvas");
        canvas.className = "pdf-canvas";
        canvas.width = Math.max(1, Math.floor(cssWidth * outputScale));
        canvas.height = Math.max(1, Math.floor(cssHeight * outputScale));
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;

        const textLayerDiv = document.createElement("div");
        textLayerDiv.className = "textLayer";

        const annotationLayerDiv = document.createElement("div");
        annotationLayerDiv.className = "annotationLayer";

        pageWrap.appendChild(canvas);
        pageWrap.appendChild(textLayerDiv);
        pageWrap.appendChild(annotationLayerDiv);

        const transform =
            outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;

        const renderTask = pdfPage.render({
            canvas,
            viewport,
            transform,
            background: "rgb(255, 255, 255)"
        });
        activeRenderTasks.push(renderTask);

        await renderTask.promise;
        if (generation !== renderGeneration) return null;

        const textContent = await pdfPage.getTextContent();
        if (generation !== renderGeneration) return null;

        const textLayer = new pdfjsLib.TextLayer({
            textContentSource: textContent,
            container: textLayerDiv,
            viewport
        });
        activeTextLayers.push(textLayer);
        await textLayer.render();
        if (generation !== renderGeneration) return null;

        const annotations = await pdfPage.getAnnotations();
        if (generation !== renderGeneration) return null;

        if (annotations.length > 0) {
            const linkService = createLinkService();
            const annotationLayer = new pdfjsLib.AnnotationLayer({
                div: annotationLayerDiv,
                accessibilityManager: undefined,
                annotationCanvasMap: undefined,
                annotationEditorUIManager: undefined,
                page: pdfPage,
                viewport: viewport.clone({ dontFlip: true }),
                structTreeLayer: undefined,
                commentManager: undefined,
                linkService: linkService as unknown as ConstructorParameters<
                    typeof pdfjsLib.AnnotationLayer
                >[0]["linkService"],
                annotationStorage: undefined
            });
            await annotationLayer.render({
                annotations,
                viewport: viewport.clone({ dontFlip: true }),
                div: annotationLayerDiv,
                page: pdfPage,
                linkService: linkService as unknown as Parameters<
                    typeof annotationLayer.render
                >[0]["linkService"],
                renderForms: false
            });
        }

        return pageWrap;
    }

    async function renderAllPages() {
        if (!pdfDoc || !stageEl || !pagesEl) return;

        const generation = ++renderGeneration;
        cancelActiveRendering();

        const containerWidth = stageEl.clientWidth;
        if (containerWidth <= 0) return;

        const fitWidth = Math.min(Math.max(1, containerWidth - 2), MAX_DESKTOP_FIT_WIDTH);
        const fragment = document.createDocumentFragment();

        try {
            for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
                const pdfPage = await pdfDoc.getPage(pageNum);
                if (generation !== renderGeneration) return;

                const pageEl = await renderPage(pdfPage, fitWidth, generation);
                if (!pageEl || generation !== renderGeneration) return;
                fragment.appendChild(pageEl);
            }

            if (generation !== renderGeneration || !pagesEl) return;
            pagesEl.replaceChildren(fragment);
            errorMessage = null;
        } catch (err) {
            const name = err instanceof Error ? err.name : "";
            if (name === "RenderingCancelledException" || name === "AbortException") {
                return;
            }
            console.error("Failed to render resume PDF:", err);
            errorMessage = "Unable to render the PDF preview in this browser.";
        }
    }

    function changeZoom(delta: number) {
        const next = Math.round((zoom + delta) * 100) / 100;
        const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
        if (clamped !== zoom) {
            zoom = clamped;
            void renderAllPages();
        }
    }

    function resetZoom() {
        if (zoom !== 1) {
            zoom = 1;
            void renderAllPages();
        }
    }

    onMount(() => {
        try {
            const saved = localStorage.getItem("peckhamr-theme");
            applyTheme(saved === "dark" ? "dark" : "light");
        } catch {
            applyTheme("light");
        }

        let disposed = false;
        let observer: ResizeObserver | null = null;

        (async () => {
            try {
                const [pdfjs, workerModule] = await Promise.all([
                    import("pdfjs-dist"),
                    import("pdfjs-dist/build/pdf.worker.min.mjs?url")
                ]);
                if (disposed) return;

                pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
                pdfjsLib = pdfjs;

                const loadingTask = pdfjs.getDocument({ url: PDF_URL });
                const loadedPdf = await loadingTask.promise;
                if (disposed) {
                    await loadingTask.destroy();
                    return;
                }

                pdfDoc = loadedPdf;
                numPages = loadedPdf.numPages;
                loading = false;

                if (stageEl) {
                    lastMeasuredWidth = stageEl.clientWidth;
                    observer = new ResizeObserver((entries) => {
                        const width = Math.round(entries[0]?.contentRect.width ?? 0);
                        // Ignore height-only resizes (e.g. mobile browser URL bar collapse on scroll).
                        if (width <= 0 || Math.abs(width - lastMeasuredWidth) < 2) {
                            return;
                        }
                        lastMeasuredWidth = width;
                        if (resizeTimer) clearTimeout(resizeTimer);
                        resizeTimer = setTimeout(() => {
                            void renderAllPages();
                        }, 120);
                    });
                    observer.observe(stageEl);
                }

                await renderAllPages();
            } catch (err) {
                if (disposed) return;
                console.error("Failed to load resume PDF:", err);
                loading = false;
                errorMessage = "Could not load the inline PDF viewer.";
            }
        })();

        return () => {
            disposed = true;
            if (observer) observer.disconnect();
            if (resizeTimer) clearTimeout(resizeTimer);
        };
    });

    onDestroy(() => {
        renderGeneration++;
        cancelActiveRendering();
        if (pdfDoc) {
            void pdfDoc.loadingTask.destroy();
            pdfDoc = null;
        }
    });
</script>

<svelte:head>
    <title>Ryan Peckham — Résumé</title>
    <meta name="description" content="Résumé PDF of Ryan Peckham, Computer Engineering student at the University of Michigan." />
</svelte:head>

<div class="resume-shell">
    <header class="resume-nav no-print">
        <div class="nav-left">
            <a href={appUrl("home", "/", page.url)} class="nav-back">
                <span aria-hidden="true">←</span>
                <span>peckhamr.com</span>
            </a>
            <span class="nav-divider">/</span>
            <span class="nav-crumb">resume</span>
        </div>

        <div class="nav-right">
            <div class="zoom-controls" role="group" aria-label="PDF zoom controls">
                <button
                    type="button"
                    class="zoom-btn"
                    onclick={() => changeZoom(-ZOOM_STEP)}
                    disabled={zoom <= MIN_ZOOM || loading || !!errorMessage}
                    aria-label="Zoom out"
                    title="Zoom out"
                >
                    −
                </button>
                <button
                    type="button"
                    class="zoom-btn zoom-reset"
                    onclick={resetZoom}
                    disabled={loading || !!errorMessage}
                    title="Reset zoom to fit width"
                >
                    {Math.round(zoom * 100)}%
                </button>
                <button
                    type="button"
                    class="zoom-btn"
                    onclick={() => changeZoom(ZOOM_STEP)}
                    disabled={zoom >= MAX_ZOOM || loading || !!errorMessage}
                    aria-label="Zoom in"
                    title="Zoom in"
                >
                    +
                </button>
            </div>

            <a
                class="action-btn download-btn"
                href={PDF_URL}
                download="ryan_peckham_resume.pdf"
                title="Download PDF to device"
            >
                <span aria-hidden="true">↓</span>
                <span>Download</span>
            </a>

            <a
                class="action-btn raw-btn"
                href={PDF_URL}
                target="_blank"
                rel="noopener noreferrer"
                title="Open raw PDF file"
            >
                <span>Open PDF</span>
                <span aria-hidden="true">↗</span>
            </a>

            <button
                type="button"
                class="action-btn theme-btn"
                onclick={toggleTheme}
                aria-label="Toggle Monokai Pro Light/Dark"
                title={theme === "light" ? "Switch to Monokai Pro Dark" : "Switch to Monokai Pro Light"}
            >
                <span aria-hidden="true">{theme === "light" ? "☾" : "☀"}</span>
                <span class="theme-label">{theme === "light" ? "Dark" : "Light"}</span>
            </button>
        </div>
    </header>

    <main class="resume-content">
        <div class="pdf-stage" bind:this={stageEl}>
            {#if loading}
                <div class="pdf-status no-print" role="status" aria-live="polite">
                    <span class="status-dot" aria-hidden="true"></span>
                    <span>Loading résumé PDF…</span>
                </div>
            {:else if errorMessage}
                <div class="pdf-fallback no-print">
                    <p class="fallback-title">{errorMessage}</p>
                    <p class="fallback-sub">
                        You can still open or download the PDF directly:
                    </p>
                    <div class="fallback-actions">
                        <a
                            class="action-btn download-btn"
                            href={PDF_URL}
                            download="ryan_peckham_resume.pdf"
                        >
                            ↓ Download PDF
                        </a>
                        <a
                            class="action-btn raw-btn"
                            href={PDF_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Open Raw PDF ↗
                        </a>
                    </div>
                </div>
            {/if}

            <div class="pdf-pages" bind:this={pagesEl} class:hidden={loading || !!errorMessage}></div>

            <noscript>
                <div class="pdf-fallback">
                    <p class="fallback-title">JavaScript is required for the inline viewer.</p>
                    <div class="fallback-actions">
                        <a class="action-btn download-btn" href={PDF_URL}>
                            Open / Download Résumé PDF ↗
                        </a>
                    </div>
                </div>
            </noscript>
        </div>
    </main>
</div>

<style>
    .resume-shell {
        min-height: 100vh;
        min-height: 100dvh;
        display: flex;
        flex-direction: column;
        background-color: var(--mp-bg);
        color: var(--mp-text);
    }

    .resume-nav {
        position: sticky;
        top: 0;
        z-index: 50;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 0.65rem 1rem;
        padding: 0.75rem 1.25rem;
        background-color: var(--mp-bg);
        border-bottom: 1px solid var(--mp-border);
        backdrop-filter: blur(8px);
    }

    .nav-left {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        font-family: var(--mono-font);
        font-size: 0.88rem;
    }

    .nav-back {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        color: var(--mp-cyan);
        font-weight: 600;
        text-decoration: none;
    }

    .nav-back:hover {
        color: var(--mp-red);
    }

    .nav-divider {
        color: var(--mp-border-strong);
    }

    .nav-crumb {
        color: var(--mp-text-muted);
    }

    .nav-right {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.5rem;
    }

    .zoom-controls {
        display: inline-flex;
        align-items: center;
        border: 1px solid var(--mp-border-strong);
        border-radius: 6px;
        overflow: hidden;
        background-color: var(--mp-bg-elevated);
    }

    .zoom-btn {
        background: transparent;
        border: none;
        color: var(--mp-text);
        font-family: var(--mono-font);
        font-size: 0.82rem;
        font-weight: 600;
        padding: 0.4rem 0.6rem;
        min-height: 34px;
        cursor: pointer;
        transition: background-color 0.15s ease, color 0.15s ease;
    }

    .zoom-btn:hover:not(:disabled) {
        background-color: var(--mp-bg-hover);
        color: var(--mp-cyan);
    }

    .zoom-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
    }

    .zoom-reset {
        border-left: 1px solid var(--mp-border);
        border-right: 1px solid var(--mp-border);
        min-width: 3.3rem;
        text-align: center;
    }

    .action-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.35rem;
        padding: 0.4rem 0.8rem;
        min-height: 34px;
        box-sizing: border-box;
        border-radius: 6px;
        font-family: inherit;
        font-size: 0.84rem;
        font-weight: 600;
        text-decoration: none;
        cursor: pointer;
        border: 1px solid var(--mp-border-strong);
        transition: all 0.15s ease;
    }

    .download-btn {
        background-color: var(--mp-btn-bg);
        color: var(--mp-btn-fg);
        border-color: var(--mp-btn-bg);
    }

    .download-btn:hover {
        background-color: var(--mp-btn-hover);
        color: var(--mp-btn-hover-fg);
        border-color: var(--mp-btn-hover);
    }

    .raw-btn {
        background-color: var(--mp-bg-elevated);
        color: var(--mp-text);
    }

    .raw-btn:hover {
        background-color: var(--mp-bg-hover);
        border-color: var(--mp-cyan);
        color: var(--mp-cyan);
    }

    .theme-btn {
        background-color: var(--mp-bg-elevated);
        color: var(--mp-text);
    }

    .theme-btn:hover {
        background-color: var(--mp-bg-hover);
        border-color: var(--mp-orange);
        color: var(--mp-orange);
    }

    .resume-content {
        flex: 1;
        display: flex;
        justify-content: center;
        padding: 1.5rem 1rem 3rem;
    }

    .pdf-stage {
        width: 100%;
        max-width: 960px;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
    }

    .pdf-pages {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1.25rem;
        width: fit-content;
        min-width: 100%;
        margin: 0 auto;
    }

    .pdf-pages.hidden {
        display: none;
    }

    .pdf-status,
    .pdf-fallback {
        margin: 2rem auto 0;
        padding: 1.5rem 1.75rem;
        border: 1px solid var(--mp-border);
        border-radius: 8px;
        background-color: var(--mp-bg-elevated);
        color: var(--mp-text);
        text-align: center;
        max-width: 440px;
        width: 100%;
        box-sizing: border-box;
    }

    .pdf-status {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.6rem;
        font-family: var(--mono-font);
        font-size: 0.9rem;
        color: var(--mp-text-muted);
    }

    .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background-color: var(--mp-cyan);
        animation: pulse 1.1s ease-in-out infinite;
    }

    @keyframes pulse {
        0%,
        100% {
            opacity: 0.35;
            transform: scale(0.85);
        }
        50% {
            opacity: 1;
            transform: scale(1.1);
        }
    }

    .fallback-title {
        margin: 0 0 0.45rem;
        font-weight: 600;
    }

    .fallback-sub {
        margin: 0 0 1rem;
        font-size: 0.9rem;
        color: var(--mp-text-muted);
    }

    .fallback-actions {
        display: flex;
        justify-content: center;
        flex-wrap: wrap;
        gap: 0.65rem;
    }

    /* Dynamically created PDF page, text layer, and link annotations */
    :global(.pdf-page) {
        position: relative;
        background-color: #ffffff;
        border: 1px solid var(--mp-border);
        border-radius: 4px;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.08);
        overflow: hidden;
        flex-shrink: 0;
    }

    :global(.pdf-canvas) {
        display: block;
    }

    :global(.pdf-page .textLayer) {
        color-scheme: only light;
        position: absolute;
        inset: 0;
        overflow: clip;
        opacity: 1;
        line-height: 1;
        letter-spacing: normal;
        word-spacing: normal;
        -webkit-text-size-adjust: none;
        -moz-text-size-adjust: none;
        text-size-adjust: none;
        transform-origin: 0 0;
        z-index: 1;
        --min-font-size: 1;
        --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
        --min-font-size-inv: calc(1 / var(--min-font-size));
    }

    :global(.pdf-page .textLayer :is(span, br)) {
        color: transparent;
        position: absolute;
        white-space: pre;
        cursor: text;
        transform-origin: 0% 0%;
        -webkit-user-select: text;
        -moz-user-select: text;
        user-select: text;
    }

    :global(.pdf-page .textLayer > :not(.markedContent)),
    :global(.pdf-page .textLayer .markedContent span:not(.markedContent)) {
        z-index: 1;
        --font-height: 0;
        font-size: calc(var(--text-scale-factor) * var(--font-height));
        --scale-x: 1;
        --rotate: 0deg;
        transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
    }

    :global(.pdf-page .textLayer .markedContent) {
        display: contents;
    }

    :global(.pdf-page .textLayer ::selection) {
        background: rgba(0, 102, 255, 0.25);
        color: transparent;
    }

    :global(.pdf-page .textLayer .endOfContent) {
        display: block;
        position: absolute;
        inset: 100% 0 0;
        z-index: 0;
        cursor: default;
        user-select: none;
    }

    :global(.pdf-page .annotationLayer) {
        position: absolute;
        inset: 0;
        pointer-events: none;
        transform-origin: 0 0;
        z-index: 2;
    }

    :global(.pdf-page .annotationLayer section) {
        position: absolute;
        text-align: initial;
        pointer-events: auto;
        box-sizing: border-box;
        transform-origin: 0 0;
        user-select: none;
    }

    :global(.pdf-page .annotationLayer .linkAnnotation > a) {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
    }

    :global(.pdf-page .annotationLayer .linkAnnotation > a:hover) {
        background-color: rgba(255, 255, 0, 0.2);
    }

    @media (max-width: 640px) {
        .resume-nav {
            padding: 0.6rem 0.75rem;
            gap: 0.5rem;
        }

        .nav-right {
            width: 100%;
            justify-content: space-between;
            gap: 0.35rem;
        }

        .zoom-btn {
            padding: 0.35rem 0.5rem;
            font-size: 0.78rem;
        }

        .zoom-reset {
            min-width: 2.75rem;
        }

        .action-btn {
            padding: 0.35rem 0.55rem;
            font-size: 0.78rem;
            gap: 0.25rem;
        }

        .theme-label {
            display: none;
        }

        .resume-content {
            padding: 0.75rem 0.5rem 2rem;
        }

        .pdf-pages {
            gap: 0.75rem;
        }
    }

    @media print {
        .no-print {
            display: none !important;
        }

        .resume-shell,
        .resume-content,
        .pdf-stage {
            background: white !important;
            padding: 0 !important;
            margin: 0 !important;
            overflow: visible !important;
            max-width: none !important;
        }

        :global(.pdf-page) {
            border: none !important;
            box-shadow: none !important;
            border-radius: 0 !important;
            break-after: page;
        }
    }
</style>
