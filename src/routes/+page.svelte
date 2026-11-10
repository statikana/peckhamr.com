<script>
    import { onMount } from "svelte";
    import { page } from "$app/state";
    import { appUrl } from "../lib/apps";
    import Terminal from "../Terminal.svelte";

    let activeSection = $state("experience");
    let terminalOpen = $state(false);
    let theme = $state("light");

    const sections = [
        { id: "experience", num: "01", label: "Experience" },
        { id: "projects", num: "02", label: "Projects" },
        { id: "work", num: "03", label: "Work History" },
        { id: "terminal", num: "04", label: "Terminal" }
    ];

    function applyTheme(nextTheme) {
        theme = nextTheme === "dark" ? "dark" : "light";
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

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        activeSection = entry.target.id;
                    }
                }
            },
            { rootMargin: "-15% 0px -65% 0px", threshold: 0 }
        );

        for (const s of sections) {
            const el = document.getElementById(s.id);
            if (el) observer.observe(el);
        }

        return () => observer.disconnect();
    });
</script>

<div class="page-grid">
    <!-- Left Sticky Rail: Identity, Theme Switcher, Quick Actions, Section Index, Contact -->
    <aside class="rail">
        <div class="rail-inner">
            <header class="identity">
                <div class="identity-top">
                    <h1 class="name">Ryan Peckham</h1>
                    <button
                        type="button"
                        class="theme-toggle"
                        onclick={toggleTheme}
                        aria-label="Switch between Monokai Pro Light and Dark mode"
                        title={theme === "light" ? "Switch to Monokai Pro Dark" : "Switch to Monokai Pro Light"}
                    >
                        <span class="theme-icon" aria-hidden="true">{theme === "light" ? "☾" : "☀"}</span>
                        <span class="theme-label">{theme === "light" ? "Dark" : "Light"}</span>
                    </button>
                </div>
                <p class="degree">Computer Engineering Student</p>
                <p class="school">University of Michigan · Ann Arbor, MI</p>
            </header>

            <p class="bio">
                I build software, work with hardware, and like figuring out how things work end to end.
                Currently leading software for a student-built autonomous drone team, with a background
                in robotics and machine learning.
            </p>

            <!-- Clear, approachable primary actions for any visitor -->
            <div class="primary-actions">
                <a class="action-primary" href="/ryan_peckham_resume.pdf" target="_blank">
                    View Résumé (PDF) <span aria-hidden="true">↗</span>
                </a>
                <a class="action-secondary" href="mailto:peckhamr@umich.edu">
                    Email Me
                </a>
            </div>

            <nav class="index-nav" aria-label="Page sections">
                <div class="rail-heading">ON THIS PAGE</div>
                {#each sections as s}
                    <a
                        href="#{s.id}"
                        class="index-link"
                        class:active={activeSection === s.id}
                        onclick={() => (activeSection = s.id)}
                    >
                        <span class="index-num">{s.num}</span>
                        <span class="index-label">{s.label}</span>
                        <span class="index-arrow" aria-hidden="true">→</span>
                    </a>
                {/each}
            </nav>

            <div class="directory">
                <div class="rail-heading">CONTACT &amp; LINKS</div>
                <dl class="meta-table">
                    <div class="meta-row">
                        <dt>Email</dt>
                        <dd><a href="mailto:peckhamr@umich.edu">peckhamr@umich.edu</a></dd>
                    </div>
                    <div class="meta-row">
                        <dt>LinkedIn</dt>
                        <dd><a href="https://www.linkedin.com/in/peckhamr/" target="_blank">linkedin.com/in/peckhamr ↗</a></dd>
                    </div>
                    <div class="meta-row">
                        <dt>GitHub</dt>
                        <dd><a href="https://github.com/statikana" target="_blank">github.com/statikana ↗</a></dd>
                    </div>
                    <div class="meta-row">
                        <dt>Instagram</dt>
                        <dd><a href="https://www.instagram.com/that.ryguy/" target="_blank">@that.ryguy ↗</a></dd>
                    </div>
                </dl>
            </div>
        </div>
    </aside>

    <!-- Right Main Column: Structured Ledger -->
    <main class="ledger">
        <!-- 01 / EXPERIENCE -->
        <section id="experience" class="ledger-section">
            <div class="section-bar">
                <span class="section-index">01</span>
                <h2 class="section-title">Experience</h2>
                <span class="section-rule"></span>
                <span class="section-caption">ENGINEERING &amp; LEADERSHIP</span>
            </div>

            <div class="timeline">
                <article class="timeline-row">
                    <div class="timeline-meta">
                        <span class="timeline-date">Jan 2026 — Present</span>
                        <span class="timeline-tag">Autonomous Drone Team</span>
                    </div>
                    <div class="timeline-body">
                        <div class="timeline-header">
                            <h3 class="role">Chief Software Engineer</h3>
                            <span class="org">Michigan Autonomous Security Team, University of Michigan</span>
                        </div>
                        <p class="desc">
                            Leading a team of engineers building the software for a prototype autonomous drone,
                            including sensor integration (GPS, gyroscope, barometer), system architecture, and
                            code review.
                        </p>
                    </div>
                </article>

                <article class="timeline-row">
                    <div class="timeline-meta">
                        <span class="timeline-date">Nov 2025 — Present</span>
                        <span class="timeline-tag">Student Organization</span>
                    </div>
                    <div class="timeline-body">
                        <div class="timeline-header">
                            <h3 class="role">Machine Learning Team Member</h3>
                            <span class="org">Michigan Hackers, University of Michigan</span>
                        </div>
                        <p class="desc">
                            Studying and applying core machine learning concepts with a group of peers through
                            regular lectures and hands-on practice.
                        </p>
                    </div>
                </article>

                <article class="timeline-row">
                    <div class="timeline-meta">
                        <span class="timeline-date">Aug — Dec 2025</span>
                        <span class="timeline-tag">Engineering Project</span>
                    </div>
                    <div class="timeline-body">
                        <div class="timeline-header">
                            <h3 class="role">Engineering 100 Team Project</h3>
                            <span class="org">University of Michigan</span>
                        </div>
                        <p class="desc">
                            As part of a 5-person team, researched, designed, and built a sun-tracking solar panel
                            powered by a Raspberry Pi, then presented our process and results to engineering faculty.
                        </p>
                    </div>
                </article>

                <article class="timeline-row">
                    <div class="timeline-meta">
                        <span class="timeline-date">Sep 2024 — Apr 2025</span>
                        <span class="timeline-tag">Community Volunteering</span>
                    </div>
                    <div class="timeline-body">
                        <div class="timeline-header">
                            <h3 class="role">Volunteer Computer Technician</h3>
                            <span class="org">Cultural, Technological, and Environmental Exchange Club</span>
                        </div>
                        <p class="desc">
                            Repaired donated desktop computers each week and prepared them for shipment to
                            communities in need in Haiti.
                        </p>
                    </div>
                </article>

                <article class="timeline-row">
                    <div class="timeline-meta">
                        <span class="timeline-date">Aug 2023 — Oct 2024</span>
                        <span class="timeline-tag">Robotics Competition</span>
                    </div>
                    <div class="timeline-body">
                        <div class="timeline-header">
                            <h3 class="role">Programming Sub-team</h3>
                            <span class="org">FIRST Robotics Team 141 "WOBOT", West Ottawa High School</span>
                        </div>
                        <p class="desc">
                            Wrote control software for our competition robot. Our team won District Champions,
                            along with awards for Engineering Inspiration, Sustainability, and Entrepreneurship.
                        </p>
                    </div>
                </article>
            </div>
        </section>

        <!-- 02 / PROJECTS -->
        <section id="projects" class="ledger-section">
            <div class="section-bar">
                <span class="section-index">02</span>
                <h2 class="section-title">Projects</h2>
                <span class="section-rule"></span>
                <span class="section-caption">THINGS I'VE BUILT</span>
            </div>

            <div class="project-table">
                <article class="project-row">
                    <div class="project-num">01</div>
                    <div class="project-main">
                        <div class="project-top">
                            <h3 class="project-name">M-AST Drone Flight Stack</h3>
                            <span class="project-stack">Python · Linux · Raspberry Pi</span>
                        </div>
                        <p class="desc">
                            Onboard flight and sensor software for our student team's autonomous quadcopter drone.
                            Reads real-time data from the GPS, gyroscope, and barometer, and manages networking and
                            operating system tasks on an onboard Raspberry Pi computer.
                        </p>
                    </div>
                    <div class="project-links">
                        <a href="https://github.com/Michigan-AST/Flight_Stack" target="_blank">View Code ↗</a>
                    </div>
                </article>

                <article class="project-row">
                    <div class="project-num">02</div>
                    <div class="project-main">
                        <div class="project-top">
                            <h3 class="project-name">flymast.com (Team Website)</h3>
                            <span class="project-stack">Web Design · Modular Components</span>
                        </div>
                        <p class="desc">
                            The public website for the Michigan Autonomous Security Team. Built around reusable
                            components so team members can easily post announcements, photos, and roster updates
                            without having to rewrite the site's core code.
                        </p>
                    </div>
                    <div class="project-links">
                        <a href="https://flymast.com" target="_blank">Visit Site ↗</a>
                        <a href="https://github.com/Michigan-AST/flymast.com" target="_blank">View Code ↗</a>
                    </div>
                </article>

                <article class="project-row">
                    <div class="project-num">03</div>
                    <div class="project-main">
                        <div class="project-top">
                            <h3 class="project-name">Multi-Threaded File Downloader</h3>
                            <span class="project-stack">Parallel Programming · Systems</span>
                        </div>
                        <p class="desc">
                            A tool that downloads large files significantly faster than a standard browser download
                            by splitting the file into pieces, downloading multiple pieces at the same time in parallel,
                            and safely stitching them together on disk.
                        </p>
                    </div>
                    <div class="project-links">
                        <a href="https://github.com/statikana/dlm" target="_blank">View Code ↗</a>
                    </div>
                </article>

                <article class="project-row">
                    <div class="project-num">04</div>
                    <div class="project-main">
                        <div class="project-top">
                            <h3 class="project-name">Cosmo (Personal Cloud Server)</h3>
                            <span class="project-stack">Python · Web Server · Self-Hosted</span>
                        </div>
                        <p class="desc">
                            A lightweight, self-hosted file server and web app for uploading and sharing files across
                            devices, built to safely handle multiple uploads happening at the same time.
                        </p>
                    </div>
                    <div class="project-links">
                        <a href="https://github.com/statikana/cosmo" target="_blank">View Code ↗</a>
                    </div>
                </article>

                <article class="project-row">
                    <div class="project-num">05</div>
                    <div class="project-main">
                        <div class="project-top">
                            <h3 class="project-name">PyTenno (Published Python Library)</h3>
                            <span class="project-stack">Python · Open-Source Package</span>
                        </div>
                        <p class="desc">
                            An open-source software library that lets Python developers easily fetch live marketplace
                            data for the video game <a href="https://www.warframe.com/game/about" target="_blank">Warframe</a>.
                            My first package published on the official <a href="https://pypi.org/project/pytenno/" target="_blank">Python Package Index (PyPI)</a>,
                            complete with user documentation.
                        </p>
                    </div>
                    <div class="project-links">
                        <a href="https://pytenno.readthedocs.io/en/latest/index.html" target="_blank">Documentation ↗</a>
                        <a href="https://github.com/statikana/PyTenno" target="_blank">View Code ↗</a>
                    </div>
                </article>

                <article class="project-row">
                    <div class="project-num">06</div>
                    <div class="project-main">
                        <div class="project-top">
                            <h3 class="project-name">This Website (peckhamr.com)</h3>
                            <span class="project-stack">Svelte · HTML/CSS · JavaScript</span>
                        </div>
                        <p class="desc">
                            Designed and built from scratch using HTML, CSS, JavaScript, and
                            <a href="https://svelte.dev/" target="_blank">Svelte</a>.
                        </p>
                    </div>
                    <div class="project-links">
                        <a href="https://github.com/statikana/peckhamr.com" target="_blank">View Code ↗</a>
                    </div>
                </article>

                <article class="project-row">
                    <div class="project-num">07</div>
                    <div class="project-main">
                        <div class="project-top">
                            <h3 class="project-name">MTG Commander Arena (/magic)</h3>
                            <span class="project-stack">Svelte 5 · Cloudflare D1 · Rules Engine</span>
                        </div>
                        <p class="desc">
                            A live, strictly rules-enforced Magic: The Gathering Commander service with OAuth accounts,
                            Scryfall deck importing, private invite-code lobbies, configurable host rules, VFX, and live chat.
                        </p>
                    </div>
                    <div class="project-links">
                        <a href={appUrl("magic", "/", page.url)}>Launch Arena ↗</a>
                    </div>
                </article>
            </div>
        </section>

        <!-- 03 / WORK HISTORY -->
        <section id="work" class="ledger-section">
            <div class="section-bar">
                <span class="section-index">03</span>
                <h2 class="section-title">Work History</h2>
                <span class="section-rule"></span>
                <span class="section-caption">JOBS &amp; CUSTOMER SERVICE</span>
            </div>

            <div class="work-grid">
                <article class="work-cell">
                    <div class="work-date">May 2026 — Aug 2026</div>
                    <h3 class="work-role">Assembly &amp; Repair Technician</h3>
                    <div class="work-company">Ace Hardware</div>
                    <p class="work-desc">
                        Completed equipment repairs and assemblies, diagnosing and resolving technical hardware
                        issues independently. Received consistently positive feedback from customers and management
                        for reliability and quality of work.
                    </p>
                </article>

                <article class="work-cell">
                    <div class="work-date">Jun 2025 — Jan 2026</div>
                    <h3 class="work-role">Crew Member</h3>
                    <div class="work-company">Chick-fil-A</div>
                    <p class="work-desc">
                        Crew member at Michigan's highest-volume Chick-fil-A location, managing guest service,
                        desserts, and drive-thru operations with fast, friendly customer interactions.
                    </p>
                </article>

                <article class="work-cell">
                    <div class="work-date">Nov 2022 — Aug 2024</div>
                    <h3 class="work-role">Team Lead</h3>
                    <div class="work-company">Target</div>
                    <p class="work-desc">
                        Promoted from team member to team lead. Trained and supervised team members on customer
                        service and operations, managed inventory auditing, and ran daily department operations.
                    </p>
                </article>
            </div>
        </section>

        <!-- 04 / TERMINAL -->
        <section id="terminal" class="ledger-section terminal-section">
            <div class="section-bar">
                <span class="section-index">04</span>
                <h2 class="section-title">Interactive Terminal</h2>
                <span class="section-rule"></span>
                <span class="section-caption">JUST FOR FUN</span>
            </div>

            <p class="terminal-intro">
                I also built a small interactive command-line version of this site. Feel free to open it up and
                type <code>help</code> or <code>whois</code> to explore.
            </p>

            <div class="console-frame">
                <div class="console-bar">
                    <span class="console-prompt">guest@peckhamr.com:~</span>
                    <div class="console-actions">
                        <button type="button" class="console-toggle-btn" onclick={() => (terminalOpen = !terminalOpen)}>
                            {terminalOpen ? "Hide terminal" : "Open terminal here"}
                        </button>
                        <a href={appUrl("terminal", "/", page.url)} class="console-link">Full screen ↗</a>
                    </div>
                </div>
                {#if terminalOpen}
                    <div id="terminal-container">
                        <Terminal />
                    </div>
                {/if}
            </div>
        </section>
    </main>
</div>

<style>
    /* Master Asymmetric Two-Column Layout */
    .page-grid {
        display: grid;
        grid-template-columns: 335px minmax(0, 1fr);
        gap: 3.75rem;
        max-width: 76rem;
        margin: 0 auto;
        padding: 3.5rem 1.5rem 5rem 1.5rem;
        align-items: start;
    }

    /* Left Sticky Rail */
    .rail {
        position: sticky;
        top: 2.75rem;
    }

    .rail-inner {
        display: flex;
        flex-direction: column;
        gap: 1.75rem;
        border-right: 1px solid var(--mp-border);
        padding-right: 2.15rem;
    }

    .identity-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding-bottom: 0.15rem;
    }

    .identity .name {
        margin: 0;
        padding-right: 0.25rem;
        font-size: 1.8rem;
        font-weight: 700;
        letter-spacing: -0.02em;
        color: var(--mp-text);
        line-height: 1.15;
        white-space: nowrap;
    }

    .theme-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.35rem;
        min-width: 4.85rem;
        padding: 0.32rem 0.65rem;
        font-family: var(--mono-font);
        font-size: 0.75rem;
        font-weight: 600;
        white-space: nowrap;
        color: var(--mp-text);
        background-color: var(--mp-bg-elevated);
        border: 1px solid var(--mp-border-strong);
        border-radius: 4px;
        cursor: pointer;
        flex-shrink: 0;
        transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }

    .theme-toggle:hover {
        background-color: var(--mp-bg-subtle);
        border-color: var(--mp-accent);
        color: var(--mp-accent);
    }

    .theme-icon {
        font-size: 0.85rem;
        line-height: 1;
        color: var(--mp-orange);
    }

    .identity .degree {
        margin: 0.45rem 0 0 0;
        font-size: 0.95rem;
        font-weight: 600;
        color: var(--mp-red);
    }

    .identity .school {
        margin: 0.2rem 0 0 0;
        font-size: 0.85rem;
        color: var(--mp-text-muted);
    }

    .bio {
        margin: 0;
        font-size: 0.94rem;
        line-height: 1.6;
        color: var(--mp-text-body);
    }

    /* Clear, tactile primary actions for non-technical & technical visitors alike */
    .primary-actions {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 0.5rem;
    }

    .action-primary,
    .action-secondary {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.35rem;
        padding: 0.5rem 0.72rem;
        font-size: 0.82rem;
        font-weight: 600;
         line-height: 1.2;
        white-space: nowrap;
        text-decoration: none;
        border-radius: 4px;
        transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }

    .action-primary {
        background-color: var(--mp-btn-bg);
        color: var(--mp-btn-fg);
        border: 1px solid transparent;
        flex: 1;
    }

    .action-primary:hover {
        background-color: var(--mp-btn-hover);
        color: var(--mp-btn-hover-fg);
    }

    .action-secondary {
        background-color: var(--mp-bg-elevated);
        border: 1px solid var(--mp-border-strong);
        color: var(--mp-text);
    }

    .action-secondary:hover {
        background-color: var(--mp-bg-subtle);
        border-color: var(--mp-cyan);
        color: var(--mp-cyan);
    }

    .rail-heading {
        font-family: var(--mono-font);
        font-size: 0.7rem;
        font-weight: 600;
        letter-spacing: 0.1em;
        color: var(--mp-text-muted);
        margin-bottom: 0.55rem;
    }

    /* Section Index Navigation */
    .index-nav {
        display: flex;
        flex-direction: column;
    }

    .index-link {
        display: grid;
        grid-template-columns: 2rem 1fr auto;
        align-items: center;
        padding: 0.45rem 0;
        border-top: 1px solid var(--mp-border-subtle);
        color: var(--mp-text-muted);
        text-decoration: none;
        font-size: 0.92rem;
        transition: color 0.15s ease;
    }

    .index-link:last-child {
        border-bottom: 1px solid var(--mp-border-subtle);
    }

    .index-num {
        font-family: var(--mono-font);
        font-size: 0.75rem;
        color: var(--mp-text-faint);
    }

    .index-arrow {
        font-family: var(--mono-font);
        font-size: 0.8rem;
        opacity: 0;
        transform: translateX(-4px);
        transition: opacity 0.15s ease, transform 0.15s ease;
    }

    .index-link:hover,
    .index-link.active {
        color: var(--mp-text);
        font-weight: 600;
    }

    .index-link.active .index-num {
        color: var(--mp-red);
    }

    .index-link:hover .index-arrow,
    .index-link.active .index-arrow {
        opacity: 1;
        transform: translateX(0);
        color: var(--mp-red);
    }

    /* Key-Value Contact Table */
    .meta-table {
        margin: 0;
        display: flex;
        flex-direction: column;
    }

    .meta-row {
        display: grid;
        grid-template-columns: 76px 1fr;
        align-items: baseline;
        padding: 0.4rem 0;
        border-top: 1px solid var(--mp-border-subtle);
        font-size: 0.84rem;
    }

    .meta-row:last-child {
        border-bottom: 1px solid var(--mp-border-subtle);
    }

    .meta-row dt {
        color: var(--mp-text-muted);
        font-size: 0.8rem;
    }

    .meta-row dd {
        margin: 0;
        color: var(--mp-text-body);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .meta-row a {
        color: var(--mp-text-body);
        text-decoration: none;
        border-bottom: 1px solid var(--mp-border-strong);
    }

    .meta-row a:hover {
        color: var(--mp-cyan);
        border-bottom-color: var(--mp-cyan);
    }

    /* Right Column: Ledger Sections */
    .ledger {
        display: flex;
        flex-direction: column;
        gap: 4rem;
        min-width: 0;
    }

    .ledger-section {
        scroll-margin-top: 2.5rem;
    }

    .section-bar {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin-bottom: 1.5rem;
    }

    .section-index {
        font-family: var(--mono-font);
        font-size: 0.82rem;
        font-weight: 600;
        color: var(--mp-red);
    }

    .section-title {
        margin: 0;
        font-size: 1.3rem;
        font-weight: 600;
        color: var(--mp-text);
        letter-spacing: -0.01em;
    }

    .section-rule {
        flex: 1;
        height: 1px;
        background-color: var(--mp-border);
    }

    .section-caption {
        font-family: var(--mono-font);
        font-size: 0.7rem;
        letter-spacing: 0.08em;
        color: var(--mp-text-muted);
    }

    /* 01 / Experience Timeline */
    .timeline {
        display: flex;
        flex-direction: column;
    }

    .timeline-row {
        display: grid;
        grid-template-columns: 165px 1fr;
        gap: 1.5rem;
        padding: 1.35rem 0;
        border-top: 1px solid var(--mp-border-subtle);
    }

    .timeline-row:first-child {
        padding-top: 0.25rem;
        border-top: none;
    }

    .timeline-meta {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        padding-top: 0.15rem;
    }

    .timeline-date {
        font-family: var(--mono-font);
        font-size: 0.8rem;
        color: var(--mp-orange);
        font-weight: 500;
    }

    .timeline-tag {
        font-size: 0.78rem;
        color: var(--mp-text-muted);
    }

    .timeline-header {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        margin-bottom: 0.45rem;
    }

    .role {
        margin: 0;
        font-size: 1.05rem;
        font-weight: 600;
        color: var(--mp-text);
    }

    .org {
        font-size: 0.9rem;
        color: var(--mp-purple);
        font-weight: 500;
    }

    .desc {
        margin: 0;
        font-size: 0.95rem;
        line-height: 1.6;
        color: var(--mp-text-body);
    }

    .desc a {
        color: var(--mp-cyan);
        border-bottom: 1px solid var(--mp-border-strong);
    }

    .desc a:hover {
        color: var(--mp-red);
        border-bottom-color: var(--mp-red);
    }

    /* 02 / Projects Specification Table */
    .project-table {
        display: flex;
        flex-direction: column;
        border-top: 1px solid var(--mp-border);
    }

    .project-row {
        display: grid;
        grid-template-columns: 2.25rem 1fr auto;
        gap: 1.25rem;
        padding: 1.35rem 0.5rem;
        border-bottom: 1px solid var(--mp-border);
        align-items: start;
        transition: background-color 0.15s ease;
    }

    .project-row:hover {
        background-color: var(--mp-bg-hover);
    }

    .project-num {
        font-family: var(--mono-font);
        font-size: 0.8rem;
        color: var(--mp-text-faint);
        padding-top: 0.2rem;
    }

    .project-top {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 0.35rem 0.85rem;
        margin-bottom: 0.4rem;
    }

    .project-name {
        margin: 0;
        font-size: 1.05rem;
        font-weight: 600;
        color: var(--mp-text);
    }

    .project-stack {
        font-family: var(--mono-font);
        font-size: 0.75rem;
        color: var(--mp-green);
        font-weight: 500;
    }

    .project-links {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 0.4rem;
        font-size: 0.84rem;
        font-weight: 600;
        white-space: nowrap;
        padding-top: 0.1rem;
    }

    .project-links a {
        color: var(--mp-cyan);
        text-decoration: none;
        border-bottom: 1px solid var(--mp-border-strong);
        padding-bottom: 1px;
    }

    .project-links a:hover {
        color: var(--mp-red);
        border-bottom-color: var(--mp-red);
    }

    /* 03 / Work History 3-Column Strip */
    .work-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        border-top: 1px solid var(--mp-border);
        border-bottom: 1px solid var(--mp-border);
    }

    .work-cell {
        padding: 1.35rem 1.25rem 1.35rem 0;
    }

    .work-cell + .work-cell {
        border-left: 1px solid var(--mp-border);
        padding-left: 1.25rem;
    }

    .work-date {
        font-family: var(--mono-font);
        font-size: 0.75rem;
        color: var(--mp-orange);
        font-weight: 500;
        margin-bottom: 0.4rem;
    }

    .work-role {
        margin: 0;
        font-size: 0.98rem;
        font-weight: 600;
        color: var(--mp-text);
    }

    .work-company {
        font-size: 0.86rem;
        color: var(--mp-purple);
        font-weight: 500;
        margin-top: 0.15rem;
        margin-bottom: 0.55rem;
    }

    .work-desc {
        margin: 0;
        font-size: 0.88rem;
        line-height: 1.55;
        color: var(--mp-text-body);
    }

    /* 04 / Terminal Console Frame */
    .terminal-intro {
        margin: 0 0 1rem 0;
        font-size: 0.94rem;
        line-height: 1.55;
        color: var(--mp-text-body);
    }

    .terminal-intro code {
        font-family: var(--mono-font);
        font-size: 0.85em;
        color: var(--mp-red);
        background-color: var(--mp-bg-subtle);
        padding: 0.1rem 0.35rem;
        border-radius: 3px;
    }

    .console-frame {
        border: 1px solid var(--mp-border-strong);
        border-radius: 6px;
        background-color: var(--mp-bg-elevated);
        overflow: hidden;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.04);
        transition: background-color 0.18s ease, border-color 0.18s ease;
    }

    .console-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 0.75rem;
        padding: 0.75rem 1.35rem;
        background-color: var(--mp-bg-subtle);
        border-bottom: 1px solid var(--mp-border);
        font-size: 0.84rem;
        color: var(--mp-text-muted);
        transition: background-color 0.18s ease, border-color 0.18s ease, color 0.18s ease;
    }

    .console-prompt {
        font-family: var(--mono-font);
        font-size: 0.78rem;
        color: var(--mp-green);
        font-weight: 600;
    }

    .console-actions {
        display: flex;
        align-items: center;
        gap: 0.85rem;
    }

    .console-toggle-btn {
        background-color: var(--mp-bg);
        border: 1px solid var(--mp-border-strong);
        border-radius: 4px;
        padding: 0.3rem 0.7rem;
        font-family: inherit;
        font-size: 0.82rem;
        font-weight: 600;
        color: var(--mp-text);
        cursor: pointer;
    }

    .console-toggle-btn:hover {
        background-color: var(--mp-bg-hover);
        border-color: var(--mp-red);
        color: var(--mp-red);
    }

    .console-link {
        font-size: 0.82rem;
        color: var(--mp-cyan);
        text-decoration: none;
        border-bottom: 1px solid var(--mp-border-strong);
    }

    .console-link:hover {
        color: var(--mp-red);
        border-bottom-color: var(--mp-red);
    }

    #terminal-container {
        padding: 1.5rem 1.75rem;
        background-color: var(--mp-bg-elevated);
        color: var(--mp-text);
        overflow-y: auto;
        overflow-x: hidden;
        min-height: 320px;
        max-height: 520px;
        scrollbar-width: thin;
        scrollbar-color: var(--mp-border-strong) transparent;
        transition: background-color 0.18s ease, color 0.18s ease;
    }

    /* Responsive Breakpoints */
    @media (max-width: 960px) {
        .page-grid {
            grid-template-columns: 1fr;
            gap: 2.75rem;
            padding-top: 2.25rem;
        }

        .rail {
            position: static;
        }

        .rail-inner {
            border-right: none;
            border-bottom: 1px solid var(--mp-border);
            padding-right: 0;
            padding-bottom: 2rem;
        }

        .index-nav {
            display: none;
        }
    }

    @media (max-width: 720px) {
        .timeline-row {
            grid-template-columns: 1fr;
            gap: 0.35rem;
        }

        .timeline-meta {
            flex-direction: row;
            justify-content: space-between;
        }

        .project-row {
            grid-template-columns: 1.75rem 1fr;
        }

        .project-links {
            grid-column: 2;
            flex-direction: row;
            justify-content: flex-start;
            gap: 1rem;
            margin-top: 0.25rem;
        }

        .work-grid {
            grid-template-columns: 1fr;
        }

        .work-cell {
            padding: 1rem 0;
        }

        .work-cell + .work-cell {
            border-left: none;
            border-top: 1px solid var(--mp-border);
            padding-left: 0;
        }
    }
</style>
