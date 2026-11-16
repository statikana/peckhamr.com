<script lang="ts">
    import { onMount } from "svelte";
    import { page } from "$app/state";
    import { appUrl } from "../../lib/apps";

    let theme = $state<"light" | "dark">("light");
    let viewMode = $state<"web" | "pdf">("web");
    let isDesktop = $state(false);

    function applyTheme(nextTheme: "light" | "dark") {
        theme = nextTheme;
        if (typeof document !== "undefined") {
            document.documentElement.setAttribute("data-theme", theme);
        }
        try {
            localStorage.setItem("peckhamr-theme", theme);
        } catch (e) {}
    }

    function toggleTheme() {
        applyTheme(theme === "light" ? "dark" : "light");
    }

    onMount(() => {
        try {
            const saved = localStorage.getItem("peckhamr-theme");
            applyTheme(saved === "dark" ? "dark" : "light");
        } catch (e) {
            applyTheme("light");
        }

        const updateMedia = () => {
            isDesktop = window.innerWidth >= 960;
        };
        updateMedia();
        window.addEventListener("resize", updateMedia);
        return () => window.removeEventListener("resize", updateMedia);
    });
</script>

<svelte:head>
    <title>Ryan Peckham — Résumé</title>
    <meta name="description" content="Résumé of Ryan Peckham, Computer Engineering student at the University of Michigan." />
</svelte:head>

<div class="resume-shell">
    <header class="resume-nav no-print">
        <div class="nav-left">
            <a href={appUrl("home", "/", page.url)} class="nav-back">
                <span class="back-arrow" aria-hidden="true">←</span>
                <span>peckhamr.com</span>
            </a>
            <span class="nav-divider">/</span>
            <span class="nav-crumb">resume</span>
        </div>

        <div class="nav-right">
            {#if isDesktop}
                <div class="mode-toggles" role="group" aria-label="Resume display mode">
                    <button
                        type="button"
                        class="mode-btn"
                        class:active={viewMode === "web"}
                        onclick={() => (viewMode = "web")}
                    >
                        Web View
                    </button>
                    <button
                        type="button"
                        class="mode-btn"
                        class:active={viewMode === "pdf"}
                        onclick={() => (viewMode = "pdf")}
                    >
                        Embedded PDF
                    </button>
                </div>
            {/if}

            <a
                class="action-btn download-btn"
                href="/ryan_peckham_resume.pdf"
                download="ryan_peckham_resume.pdf"
                title="Download PDF to device"
            >
                <span class="btn-icon" aria-hidden="true">↓</span>
                <span>Download PDF</span>
            </a>

            <a
                class="action-btn raw-btn"
                href="/ryan_peckham_resume.pdf"
                target="_blank"
                rel="noopener noreferrer"
                title="Open PDF directly"
            >
                <span>Raw PDF</span>
                <span class="btn-icon" aria-hidden="true">↗</span>
            </a>

            <button
                type="button"
                class="action-btn theme-btn"
                onclick={toggleTheme}
                aria-label="Toggle Monokai Pro Light/Dark"
                title={theme === "light" ? "Switch to Monokai Pro Dark" : "Switch to Monokai Pro Light"}
            >
                <span class="theme-icon" aria-hidden="true">{theme === "light" ? "☾" : "☀"}</span>
                <span>{theme === "light" ? "Dark" : "Light"}</span>
            </button>
        </div>
    </header>

    <main class="resume-content">
        {#if viewMode === "pdf" && isDesktop}
            <div class="pdf-container no-print">
                <iframe
                    src="/ryan_peckham_resume.pdf"
                    title="Ryan Peckham Résumé PDF"
                    class="pdf-frame"
                ></iframe>
            </div>
        {:else}
            <!-- Responsive Web Résumé (Works reliably on mobile & desktop, prints cleanly) -->
            <article class="resume-paper">
                <header class="resume-header">
                    <h1 class="candidate-name">Ryan Peckham</h1>
                    <div class="contact-line">
                        <a href="mailto:peckhamr@umich.edu">peckhamr@umich.edu</a>
                        <span class="bullet">·</span>
                        <a href="https://peckhamr.com">peckhamr.com</a>
                        <span class="bullet">·</span>
                        <a href="https://github.com/statikana" target="_blank" rel="noopener noreferrer">github.com/statikana</a>
                        <span class="bullet">·</span>
                        <span class="contact-item">(616) 834-2160</span>
                        <span class="bullet">·</span>
                        <span class="contact-item">Ann Arbor, MI</span>
                    </div>
                </header>

                <!-- 01 EDUCATION -->
                <section class="section">
                    <h2 class="section-title">Education</h2>
                    <div class="entry">
                        <div class="entry-head">
                            <span class="entry-title bold">University of Michigan</span>
                            <span class="entry-right">Ann Arbor, MI</span>
                        </div>
                        <div class="entry-sub">
                            <span class="entry-role">B.S. in Computer Engineering (GPA: 3.35/4.0)</span>
                            <span class="entry-date">Expected May 2029</span>
                        </div>
                        <p class="entry-note">
                            <strong>Relevant Coursework:</strong> Programming &amp; Data Structures, Discrete Mathematics, Multivariable &amp; Vector Calculus, Probability &amp; Statistics, Electricity &amp; Magnetism
                        </p>
                    </div>
                </section>

                <!-- 02 TECHNICAL SKILLS -->
                <section class="section">
                    <h2 class="section-title">Technical Skills</h2>
                    <dl class="skills-list">
                        <div class="skill-row">
                            <dt class="skill-label">Languages</dt>
                            <dd class="skill-desc">C/C++, Python, Rust, Java, C#, SQL, JavaScript, MATLAB</dd>
                        </div>
                        <div class="skill-row">
                            <dt class="skill-label">Robotics &amp; Autonomy</dt>
                            <dd class="skill-desc">ROS 2, OpenCV, SITL/HITL Simulation, PID Control, Sensor Interfacing (IMU, GPS)</dd>
                        </div>
                        <div class="skill-row">
                            <dt class="skill-label">Systems &amp; Tools</dt>
                            <dd class="skill-desc">Linux (Ubuntu, Debian, NixOS), Docker, Git/GitHub, Multithreading, PostgreSQL</dd>
                        </div>
                        <div class="skill-row">
                            <dt class="skill-label">Hardware Prototyping</dt>
                            <dd class="skill-desc">Raspberry Pi, Circuit Prototyping, Soldering, Machining (CNC, Lathe, Mill)</dd>
                        </div>
                    </dl>
                </section>

                <!-- 03 ENGINEERING EXPERIENCE -->
                <section class="section">
                    <h2 class="section-title">Engineering Experience</h2>

                    <div class="entry">
                        <div class="entry-head">
                            <span class="entry-title bold">Michigan Autonomous Security Team (M-AST)</span>
                            <span class="entry-right">Jan. 2026 – Present</span>
                        </div>
                        <div class="entry-sub">
                            <span class="entry-role italic">Chief Software Engineer · University of Michigan</span>
                        </div>
                        <ul class="bullets">
                            <li>
                                Lead a team of engineers developing onboard firmware and sensor drivers for an autonomous quadcopter, integrating and calibrating IMU (gyroscope/accelerometer), magnetometer, barometer, and GPS modules.
                            </li>
                            <li>
                                Co-architected modular flight software architecture and inter-subsystem data pipelines, containerizing services with Docker to enable Software-in-the-Loop (SITL) and Hardware-in-the-Loop (HITL) flight simulation.
                            </li>
                            <li>
                                Integrated ROS 2 nodes, OpenCV vision pipelines, autonomous waypoint navigation, and real-time telemetry into a unified flight software stack.
                            </li>
                            <li>
                                Direct repository architecture across submodules, enforcing peer code reviews, CI workflows, and quality standards.
                            </li>
                        </ul>
                    </div>

                    <div class="entry">
                        <div class="entry-head">
                            <span class="entry-title bold">FIRST Robotics Competition (FRC), Team 141 "WOBOT"</span>
                            <span class="entry-right">Aug. 2023 – Oct. 2024</span>
                        </div>
                        <div class="entry-sub">
                            <span class="entry-role italic">Programming Team Lead · West Ottawa High School</span>
                        </div>
                        <ul class="bullets">
                            <li>
                                Programmed robot drivetrain kinematics and mechanism control in Java, tuning closed-loop PIDF feedback controllers to achieve precision autonomous trajectory tracking and responsive teleoperation.
                            </li>
                            <li>
                                Troubleshot real-time software exceptions and electrical faults under tight match turnarounds, collaborating with drive and pit teams to win the District Championship and Engineering Inspiration award.
                            </li>
                        </ul>
                    </div>

                    <div class="entry">
                        <div class="entry-head">
                            <span class="entry-title bold">Cultural, Technological, and Environmental Exchange (CTEE) Club</span>
                            <span class="entry-right">Sep. 2024 – Apr. 2025</span>
                        </div>
                        <div class="entry-sub">
                            <span class="entry-role italic">Hardware Technician · West Ottawa High School</span>
                        </div>
                        <ul class="bullets">
                            <li>
                                Diagnosed and refurbished desktop workstations, troubleshooting hardware-level faults across motherboards, power supplies, RAM, and storage drives.
                            </li>
                            <li>
                                Configured operating systems, drivers, and network configurations to provision ready-to-deploy machines for humanitarian delivery to schools in Cambodia and Haiti.
                            </li>
                        </ul>
                    </div>
                </section>

                <!-- 04 TECHNICAL PROJECTS -->
                <section class="section">
                    <h2 class="section-title">Technical Projects</h2>
                    <ul class="bullets projects-list">
                        <li>
                            <strong>QRust (Custom Compiler)</strong> — Statically typed language in Rust targeting multiple ISAs via Cranelift; implemented lexical analysis, AST parsing, type checking, native SIMD vector primitives, and stack-allocated pointer semantics.
                        </li>
                        <li>
                            <strong>Autonomous Solar Tracker</strong> — Engineered a dual-axis solar tracking system on a Raspberry Pi using C++; designed closed-loop feedback algorithms processing photoresistor arrays to control precision stepper motor orientation.
                        </li>
                        <li>
                            <strong>Multi-Threaded File Downloader</strong> — Built a concurrent CLI file downloader in Python; segmented large payloads via HTTP Range headers to stream chunks across worker threads with thread-safe file reassembly.
                        </li>
                        <li>
                            <strong>Algorithmic Sudoku Solver</strong> — Implemented a high-performance solver modeling grid states with bitmasks and NumPy; developed constraint propagation techniques and human strategies (hidden singles/pairs, X-Wing, Swordfish).
                        </li>
                        <li>
                            <strong>FlyMast.com &amp; peckhamr.com</strong> — Designed and deployed production web applications using Svelte, JavaScript, and Cloudflare Workers, incorporating responsive modular components for team updates and sponsor engagement.
                        </li>
                    </ul>
                </section>

                <!-- 05 WORK EXPERIENCE -->
                <section class="section">
                    <h2 class="section-title">Work Experience</h2>
                    <div class="work-history-table">
                        <div class="work-history-row">
                            <span class="work-history-name">Ace Hardware, Delivery and Assembly Technician</span>
                            <span class="work-history-date">May 2026 – Aug. 2026</span>
                        </div>
                        <div class="work-history-row">
                            <span class="work-history-name">Chick-fil-A, Crew Member</span>
                            <span class="work-history-date">June 2025 – Jan. 2026</span>
                        </div>
                        <div class="work-history-row">
                            <span class="work-history-name">Target, Electronics Consultant &amp; Team Leader</span>
                            <span class="work-history-date">Nov. 2022 – Aug. 2024</span>
                        </div>
                    </div>
                </section>
            </article>
        {/if}
    </main>
</div>

<style>
    .resume-shell {
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        background-color: var(--mp-bg);
        color: var(--mp-text);
    }

    /* Top Sticky Navigation Bar */
    .resume-nav {
        position: sticky;
        top: 0;
        z-index: 50;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 0.75rem 1rem;
        padding: 0.85rem 1.5rem;
        background-color: var(--mp-bg);
        border-bottom: 1px solid var(--mp-border);
        backdrop-filter: blur(8px);
    }

    .nav-left {
        display: flex;
        align-items: center;
        gap: 0.5rem;
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
        gap: 0.6rem;
    }

    .mode-toggles {
        display: inline-flex;
        border: 1px solid var(--mp-border);
        border-radius: 6px;
        overflow: hidden;
        background-color: var(--mp-bg-subtle);
    }

    .mode-btn {
        background: transparent;
        border: none;
        padding: 0.35rem 0.75rem;
        font-family: inherit;
        font-size: 0.8rem;
        font-weight: 600;
        color: var(--mp-text-muted);
        cursor: pointer;
        transition: background-color 0.15s ease, color 0.15s ease;
    }

    .mode-btn.active {
        background-color: var(--mp-bg-elevated);
        color: var(--mp-text);
    }

    .action-btn {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.4rem 0.85rem;
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

    /* Main Content Area */
    .resume-content {
        flex: 1;
        display: flex;
        justify-content: center;
        padding: 2rem 1.25rem 4rem 1.25rem;
    }

    .pdf-container {
        width: 100%;
        max-width: 900px;
        height: 85vh;
        border: 1px solid var(--mp-border);
        border-radius: 8px;
        overflow: hidden;
        background-color: var(--mp-bg-elevated);
    }

    .pdf-frame {
        width: 100%;
        height: 100%;
        border: none;
    }

    /* Paper-style Web Résumé */
    .resume-paper {
        width: 100%;
        max-width: 820px;
        background-color: var(--mp-bg-elevated);
        border: 1px solid var(--mp-border);
        border-radius: 8px;
        padding: 2.75rem 3rem;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
        line-height: 1.45;
        font-size: 0.95rem;
        color: var(--mp-text-body);
    }

    .resume-header {
        text-align: center;
        margin-bottom: 1.5rem;
        padding-bottom: 0.75rem;
    }

    .candidate-name {
        margin: 0 0 0.35rem 0;
        font-size: 2.1rem;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: var(--mp-text);
    }

    .contact-line {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        align-items: center;
        gap: 0.35rem 0.55rem;
        font-size: 0.85rem;
        color: var(--mp-text-muted);
    }

    .contact-line a {
        color: var(--mp-cyan);
        text-decoration: none;
    }

    .contact-line a:hover {
        color: var(--mp-red);
        text-decoration: underline;
    }

    .bullet {
        color: var(--mp-border-strong);
    }

    /* Sections */
    .section {
        margin-top: 1.35rem;
    }

    .section-title {
        margin: 0 0 0.65rem 0;
        font-size: 1.12rem;
        font-weight: 700;
        letter-spacing: 0.03em;
        text-transform: uppercase;
        color: var(--mp-text);
        border-bottom: 1.5px solid var(--mp-border-strong);
        padding-bottom: 0.25rem;
    }

    .entry {
        margin-bottom: 1rem;
    }

    .entry-head,
    .entry-sub {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 0.5rem;
    }

    .entry-head {
        font-size: 0.98rem;
    }

    .entry-title {
        color: var(--mp-text);
    }

    .entry-right,
    .entry-date {
        font-family: var(--mono-font);
        font-size: 0.84rem;
        color: var(--mp-orange);
        white-space: nowrap;
        text-align: right;
    }

    .entry-sub {
        margin-top: 0.1rem;
        margin-bottom: 0.35rem;
    }

    .entry-role {
        font-size: 0.92rem;
        color: var(--mp-purple);
        font-weight: 500;
    }

    .entry-note {
        margin: 0.3rem 0 0 0;
        font-size: 0.9rem;
        line-height: 1.45;
        color: var(--mp-text-body);
    }

    .bold {
        font-weight: 700;
    }

    .italic {
        font-style: italic;
    }

    .bullets {
        margin: 0.3rem 0 0 0;
        padding-left: 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
        font-size: 0.91rem;
        line-height: 1.5;
        color: var(--mp-text-body);
    }

    .bullets li::marker {
        color: var(--mp-text-muted);
    }

    /* Skills definition list */
    .skills-list {
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        font-size: 0.91rem;
    }

    .skill-row {
        display: grid;
        grid-template-columns: 190px 1fr;
        gap: 0.75rem;
        align-items: baseline;
    }

    .skill-label {
        font-weight: 700;
        color: var(--mp-text);
    }

    .skill-desc {
        margin: 0;
        color: var(--mp-text-body);
        line-height: 1.45;
    }

    /* Work History Table */
    .work-history-table {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
        margin-top: 0.35rem;
    }

    .work-history-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 0.75rem;
        font-size: 0.9rem;
    }

    .work-history-name {
        color: var(--mp-text);
        font-weight: 500;
    }

    .work-history-date {
        font-family: var(--mono-font);
        font-size: 0.82rem;
        color: var(--mp-orange);
        white-space: nowrap;
    }

    /* Responsive adjustments */
    @media (max-width: 768px) {
        .resume-paper {
            padding: 1.75rem 1.25rem;
            border-radius: 6px;
        }

        .candidate-name {
            font-size: 1.7rem;
        }

        .skill-row {
            grid-template-columns: 1fr;
            gap: 0.15rem;
        }

        .entry-head,
        .entry-sub,
        .work-history-row {
            flex-direction: column;
            align-items: flex-start;
            gap: 0.1rem;
        }

        .entry-right,
        .entry-date,
        .work-history-date {
            text-align: left;
        }

        .resume-nav {
            padding: 0.75rem 1rem;
        }
    }

    /* Print styling */
    @media print {
        .no-print {
            display: none !important;
        }

        .resume-shell {
            background: white !important;
            color: black !important;
        }

        .resume-content {
            padding: 0 !important;
        }

        .resume-paper {
            border: none !important;
            box-shadow: none !important;
            padding: 0 !important;
            max-width: 100% !important;
            background: white !important;
            color: black !important;
            font-size: 10.5pt !important;
            line-height: 1.35 !important;
        }

        .candidate-name,
        .section-title,
        .entry-title,
        .skill-label {
            color: black !important;
        }

        .entry-right,
        .entry-date,
        .work-history-date,
        .entry-role {
            color: #333 !important;
        }

        .contact-line a {
            color: black !important;
            text-decoration: none !important;
        }
    }
</style>
