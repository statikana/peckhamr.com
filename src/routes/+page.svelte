<script>
    import Terminal from "../Terminal.svelte";

    let activeTab = $state('experience');
    let showTerminal = $state(false);

    function goToTab(tab) {
        activeTab = tab;
        document.getElementById('work')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
</script>

<svelte:head>
    <script src="https://kit.fontawesome.com/e469a2ed37.js" crossorigin="anonymous"></script>
</svelte:head>

<nav id="site-nav">
    <div class="nav-inner">
        <a class="nav-brand" href="#top">Ryan Peckham</a>
        <div class="nav-links">
            <button type="button" class="nav-link-btn" onclick={() => goToTab('experience')}>Experience</button>
            <button type="button" class="nav-link-btn" onclick={() => goToTab('projects')}>Projects</button>
            <a href="#terminal">Terminal</a>
            <a class="nav-resume" href="/ryan_peckham_resume.pdf" target="_blank">
                <i class="fa-regular fa-file-pdf"></i> Résumé
            </a>
        </div>
    </div>
</nav>

<div id="main-personal">
    <div id="top"></div>
    <!-- personal -->
    <div id="me">
        <p id="name" class="glow">
            Ryan Peckham
        </p>
        <p id="tagline">
            Computer Engineering &amp; Applied Physics student at the University of Michigan
        </p>
        <div id="info">
            <p id="info-bits">
                <a class="link" href="emailto:peckhamr@umich.edu">peckhamr@umich.edu</a>
                •
                <span>Ann Arbor, MI</span>
            </p>
        </div>
        <p id="bio">
            I build software, work with hardware, and like figuring out how things work end to end.
            Currently leading software for a student-built autonomous drone team, with a background
            in robotics and machine learning.
        </p>
        <div id="cta-row">
            <a class="btn btn-primary" href="/ryan_peckham_resume.pdf" aria-label="resume" target="_blank">
                <i class="fa-regular fa-file-pdf"></i> View résumé
            </a>
            <button type="button" class="btn btn-secondary" onclick={() => goToTab('experience')}>
                <i class="fa-regular fa-id-badge"></i> Experience
            </button>
            <button type="button" class="btn btn-secondary" onclick={() => goToTab('projects')}>
                <i class="fa-regular fa-folder-open"></i> Projects
            </button>
        </div>
        <div id="links">
            <a class="social-link" href="https://github.com/statikana" aria-label="github" target="_blank">
                <i class="fa-brands fa-github"></i>
            </a>
            <a class="social-link" href="https://www.linkedin.com/in/peckhamr/" aria-label="linkedin" target="_blank">
                <i class="fa-brands fa-linkedin"></i>
            </a>
            <a class="social-link" href="https://www.instagram.com/that.ryguy/" aria-label="instagram" target="_blank">
                <i class="fa-brands fa-instagram"></i>
            </a>
        </div>
    </div>

    <!-- experience / projects tabs -->
    <section id="work" class="section">
        <div class="tab-switch">
            <button type="button" class:active={activeTab === 'experience'} onclick={() => activeTab = 'experience'}>
                <i class="fa-regular fa-id-badge"></i> Experience
            </button>
            <button type="button" class:active={activeTab === 'projects'} onclick={() => activeTab = 'projects'}>
                <i class="fa-regular fa-folder-open"></i> Projects
            </button>
        </div>

        <div class="tab-viewport">
            <div class="tab-track" class:show-projects={activeTab === 'projects'}>
            <div class="tab-panel">
        <h2 class="section-title glow">Experience</h2>
        <div class="experience-list">
            <div class="xp-item">
                <div class="xp-head">
                    <span class="xp-role">Chief Software Engineer <span class="xp-org">Michigan Autonomous Security Team, University of Michigan</span></span>
                    <span class="xp-date">Jan 2026 – Present</span>
                </div>
                <p class="xp-desc">
                    Leading a team of engineers building the software for a prototype autonomous drone,
                    including sensor integration (GPS, gyroscope, barometer), system architecture, and
                    code review.
                </p>
            </div>

            <div class="xp-item">
                <div class="xp-head">
                    <span class="xp-role">Machine Learning Team, Member <span class="xp-org">Michigan Hackers, University of Michigan</span></span>
                    <span class="xp-date">Nov 2025 – Present</span>
                </div>
                <p class="xp-desc">
                    Studying and applying core machine learning concepts with a group of peers through
                    regular lectures and hands-on practice.
                </p>
            </div>

            <div class="xp-item">
                <div class="xp-head">
                    <span class="xp-role">Engineering 100 Team Project <span class="xp-org">University of Michigan</span></span>
                    <span class="xp-date">Aug 2025 – Dec 2025</span>
                </div>
                <p class="xp-desc">
                    As part of a 5-person team, researched, designed, and built a sun-tracking solar panel
                    on a Raspberry Pi, then presented our process and results to engineering faculty.
                </p>
            </div>

            <div class="xp-item">
                <div class="xp-head">
                    <span class="xp-role">Programming Sub-team <span class="xp-org">FIRST Robotics Competition, Team 141 "WOBOT", West Ottawa High School</span></span>
                    <span class="xp-date">Aug 2023 – Oct 2024</span>
                </div>
                <p class="xp-desc">
                    Wrote control software for our competition robot. Our team won District Champions,
                    along with awards for Engineering Inspiration, Sustainability, and Entrepreneurship.
                </p>
            </div>

            <div class="xp-item">
                <div class="xp-head">
                    <span class="xp-role">Volunteer <span class="xp-org">Cultural, Technological, and Environmental Exchange Club, West Ottawa High School</span></span>
                    <span class="xp-date">Sep 2024 – Apr 2025</span>
                </div>
                <p class="xp-desc">
                    Repaired donated desktop computers each week and prepared them for shipment to
                    communities in need in Haiti.
                </p>
            </div>
        </div>

        <h3 class="subsection-title">Work Experience</h3>
        <div class="experience-list">
            <div class="xp-item">
                <div class="xp-head">
                    <span class="xp-role">Assembly and Repair Technician <span class="xp-org">Ace Hardware</span></span>
                    <span class="xp-date">May 2026 – Aug 2026</span>
                </div>
                <p class="xp-desc">
                    Completed complex equipment repairs and assemblies, diagnosing and resolving
                    technical issues independently. Built strong foundational knowledge of hardware
                    systems, tools, and specifications. Received consistently positive feedback from
                    customers and management for reliability, problem-solving, and quality of work.
                </p>
            </div>

            <div class="xp-item">
                <div class="xp-head">
                    <span class="xp-role">Crew Member <span class="xp-org">Chick-fil-A</span></span>
                    <span class="xp-date">Feb 2024 – Jan 2026</span>
                </div>
                <p class="xp-desc">
                    Nearly two years as a crew member at Michigan's highest-volume Chick-fil-A location,
                    managing guest service, desserts, and drive-thru operations with consistently
                    positive customer interactions and high work standards.
                </p>
            </div>

            <div class="xp-item">
                <div class="xp-head">
                    <span class="xp-role">Team Lead <span class="xp-org">Target</span></span>
                    <span class="xp-date">Nov 2020 – Aug 2022</span>
                </div>
                <p class="xp-desc">
                    Promoted from team member to team lead after demonstrating strong performance.
                    Trained and supervised team members on department operations and customer service
                    standards, managed inventory receiving and auditing, and took ownership of daily
                    department operations.
                </p>
            </div>
        </div>
            </div>

            <div class="tab-panel">
        <h2 class="section-title glow">Projects</h2>
        <div class="center" id="projects-list">
            <!-- this site -->
            <div class="project">
                <p>This Site [<a href="https://github.com/statikana/peckhamr.com">Source</a>]</p>
                <div class="project-desc">
                    I made this site using HTML, CSS, and JS. I also used <a href="https://svelte.dev/" target="_blank">Svelte</a> for routing and
                    dynamic rendering, and Git for version control.
                </div>
            </div>
            <hr class="line-break">

            <div class="project">
                <p>M-AST Flight Stack [<a href="https://github.com/Michigan-AST/Flight_Stack" target="_blank">Source</a>]</p>
                <div class="project-desc">
                    As Chief Software Engineer of the Michigan Autonomous Security Team, I've recently helped develop and improve sensor integration software for our team's
                    quadcopter drone. I have also advised my peers on routing software and operating system management, via a Raspberry Pi running Debian Linux.
                </div>
            </div>

            <hr class="line-break">

            <!-- DLM -->
            <div class="project">
                <p>Downloader [<a href="https://github.com/statikana/dlm" target="_blank">Source</a>]</p>
                <div class="project-desc">
                    Uses concurrent threads to read and write data from a website (e.g., a file server) faster than you are normally able to.
                    Each thread reads a different segment of the source file, and writes to the associated segment of the new file being created on your computer. Uses file locks to
                    prevent race conditions, and chunked writing to balance memory usage and performance. Shows substantial improvements in download times, depending on the file size and the number of concurrent threads used.
                </div>
            </div>

            <hr class="line-break">

            <!-- Koda -->
            <!-- <div class="project">
                <p>Koda [<a href="https://github.com/statikana/antlr-project" target="_blank">Source</a>]</p>
                <div class="project-desc">
                    A custom interpreted programming language written in C++, using the ANTLR4 parser generator for lexing and parsing.
                    Involved designing my own type system and building the AST generation and execution engine from scratch. One of my
                    favorite personal projects, and a deep dive into how programming languages actually work under the hood.
                </div>
            </div> -->

            <hr class="line-break">

            <!-- Cosmo -->
            <div class="project">
                <p>Cosmo [<a href="https://github.com/statikana/cosmo" target="_blank">Source</a>]</p>
                <div class="project-desc">
                    A small self-hosted file server: a single-page upload/download web app backed by a lightweight Python WSGI app
                    behind Apache. Handles concurrent uploads safely using thread locks, so simultaneous writes don't clobber each
                    other's data.
                </div>
            </div>

            <hr class="line-break">

            <!-- PyTenno -->
            <div class="project">
                <p>PyTenno [<a href="https://github.com/statikana/PyTenno" target="_blank">Source</a>]</p>
                <div class="project-desc">
                    An asynchronous API wrapper for <a href="https://warframe.market/" target="_blank">warframe.market</a>, a marketplace
                    for the video game <a href="https://www.warframe.com/game/about" target="_blank">Warframe</a>. Translates the site's
                    API endpoints into Python functions and data structures, and was my first package published on
                    <a href="https://pypi.org/project/pytenno/" target="_blank">PyPI</a>, with full documentation on
                    <a href="https://pytenno.readthedocs.io/en/latest/index.html" target="_blank">Read the Docs</a>.
                </div>
            </div>
        </div>
            </div>
            </div>
        </div>
    </section>

    <!-- terminal, de-emphasized for non-technical visitors -->
    <section id="terminal" class="section terminal-section">
        <h2 class="section-title glow">For the curious</h2>
        <p class="terminal-blurb">
            I also built a little interactive terminal into this site, just for fun; feel free to poke around.
        </p>
        <div class="terminal-actions">
            <a class="btn btn-secondary" href="/terminal">
                <i class="fa-solid fa-terminal"></i> Open the terminal
            </a>
            <button type="button" class="btn btn-secondary" onclick={() => showTerminal = !showTerminal}>
                <i class="fa-solid fa-chevron-down" class:flipped={showTerminal}></i>
                {showTerminal ? 'Hide it' : 'Show it here instead'}
            </button>
        </div>
        {#if showTerminal}
            <div id="terminal-container">
                <Terminal />
            </div>
        {/if}
    </section>

    <!-- a little spot to talk about the accent color -->
    <footer id="site-footer">
        <span class="accent-swatch" aria-label="accent color #9FFDD8"></span>
        <p class="accent-note">
            Accent color: Seafoam Nectar <code>#9FFDD8</code> is the loveliest color
        </p>
    </footer>
</div>

<style>
    :global(html) {
        scroll-behavior: smooth;
    }

    :global(body) {
        margin: 0;
    }

    /* nav */
    #site-nav {
        position: sticky;
        top: 0;
        z-index: 10;
        background-color: #242426ee;
        backdrop-filter: blur(6px);
        border-bottom: 1px solid #ffffff14;
        margin: 0 -5%;
        padding: 0 5%;
    }

    .nav-inner {
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
        padding: 0.9rem 0;
        max-width: 68rem;
        margin: 0 auto;
    }

    .nav-brand {
        color: #fff;
        font-family: var(--mono-font);
        font-weight: 600;
        font-size: 1.05rem;
        text-decoration: none;
    }

    .nav-links {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 1.75rem;
        font-family: var(--mono-font);
    }

    .nav-links > a {
        color: #ffffffcc;
        text-decoration: none;
        font-size: 0.9rem;
    }

    .nav-links > a:hover {
        color: #9FFDD8;
    }

    .nav-link-btn {
        color: #ffffffcc;
        background: none;
        border: none;
        padding: 0;
        font: inherit;
        font-size: 0.9rem;
        cursor: pointer;
    }

    .nav-link-btn:hover {
        color: #9FFDD8;
    }

    .nav-resume {
        display: inline-flex;
        align-items: center;
        gap: 0.4em;
        color: #0c0c0c !important;
        background-color: #9FFDD8;
        padding: 0.4em 0.9em;
        border-radius: 999px;
        font-weight: 600;
    }

    .nav-resume:hover {
        color: #0c0c0c !important;
    }

    /* main layout */
    #main-personal {
        display: flex;
        flex-direction: column;
        max-width: 68rem;
        margin: 0 auto;
    }

    .glow {
        color: #fff;
    }

    .section {
        margin-top: 2rem;
        padding-top: 1.5rem;
        border-top: 1px solid #ffffff14;
    }

    .section-title {
        margin-top: 0;
        margin-bottom: 1.25rem;
        font-size: 1.5rem;
    }

    /* personal */
    div#me {
        margin: 4rem 0 2.5rem 0;
        text-align: center;
        color: #fff;
    }

    div#me > p#name {
        padding-bottom: 0;
        margin: 0;
        font-size: 2.6rem;
        font-weight: 700;
    }

    #tagline {
        margin: 0.4rem 0 0 0;
        color: #ffffffcc;
        font-size: 1.1rem;
    }

    #info-bits {
        color: #fff5;
        padding: 0;
        margin: 0.75rem 0 0 0;
    }

    div#me > p#bio {
        margin: 1rem auto 0 auto;
        max-width: 38rem;
        line-height: 1.5;
        color: #ffffffcc;
    }

    #cta-row {
        display: flex;
        flex-direction: row;
        flex-wrap: wrap;
        justify-content: center;
        gap: 0.75rem;
        margin: 1.5rem 0 1.25rem 0;
    }

    .btn {
        display: inline-flex;
        align-items: center;
        gap: 0.5em;
        text-decoration: none;
        font-family: inherit;
        font-size: 0.95rem;
        font-weight: 600;
        padding: 0.55em 1.2em;
        border-radius: 999px;
        border: none;
        cursor: pointer;
        transition: box-shadow 0.25s ease, transform 0.25s ease;
    }

    .btn:hover {
        transform: translateY(-1px);
    }

    .btn-primary {
        color: #0c0c0c;
        background-color: #9FFDD8;
    }

    .btn-primary:hover {
        box-shadow: 0 0 12px 2px #9FFDD888;
    }

    .btn-secondary {
        color: #fff;
        background-color: #ffffff12;
        border: 1px solid #ffffff2a;
    }

    .btn-secondary:hover {
        background-color: #ffffff1e;
    }

    #links {
        font-size: 140%;
    }

    /* links */
    a.link,
    a.social-link {
        color: inherit;
        text-decoration: underline;
        text-decoration-color: #fff3;
    }

    /* work tabs */
    .tab-switch {
        display: flex;
        flex-direction: row;
        gap: 0.5rem;
        margin-bottom: 1.5rem;
    }

    .tab-switch > button {
        display: inline-flex;
        align-items: center;
        gap: 0.5em;
        font-family: var(--mono-font);
        font-size: 0.95rem;
        font-weight: 600;
        color: #ffffffa0;
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        padding: 0.4em 0.1em;
        cursor: pointer;
        transition: color 0.2s ease, border-color 0.2s ease;
    }

    .tab-switch > button:hover {
        color: #fff;
    }

    .tab-switch > button.active {
        color: #fff;
        border-bottom-color: #9FFDD8;
    }

    .tab-switch > button + button {
        margin-left: 1rem;
    }

    .tab-viewport {
        overflow: hidden;
        width: 100%;
    }

    .tab-track {
        display: flex;
        width: 200%;
        transform: translateX(0%);
        transition: transform 0.35s ease;
    }

    .tab-track.show-projects {
        transform: translateX(-50%);
    }

    .tab-panel {
        width: 50%;
        flex-shrink: 0;
        box-sizing: border-box;
        padding-right: 1.5rem;
    }

    /* experience */
    .subsection-title {
        color: #ffffffb0;
        font-size: 1rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin: 2.25rem 0 1.25rem 0;
    }

    .experience-list {
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
    }

    .xp-item {
        color: #fff;
    }

    .xp-head {
        display: flex;
        flex-direction: row;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 0.5rem 1rem;
    }

    .xp-role {
        font-weight: 600;
        font-size: 1.05rem;
    }

    .xp-date {
        color: #ffffffb0;
        font-family: var(--mono-font);
        font-size: 0.78rem;
        font-weight: 500;
        letter-spacing: 0.02em;
        background-color: #ffffff12;
        border-radius: 999px;
        padding: 0.2em 0.75em;
        white-space: nowrap;
        align-self: flex-start;
    }

    .xp-org {
        color: #9FFDD8;
        font-family: var(--mono-font);
        font-size: 0.85rem;
        font-weight: 500;
        background-color: #9FFDD818;
        border-radius: 0.4em;
        padding: 0.1em 0.5em;
        margin-left: 0.3em;
        display: inline-block;
    }

    .xp-desc {
        color: #ffffffcc;
        margin: 0.4rem 0 0 0;
        line-height: 1.5;
    }

    /* projects */
    div.center {
        color: #fff;
    }

    div.project > div.project-desc {
        margin-left: 2.5%;
        color: #fffa;
        font-size: 1em;
        line-height: 1.5;
    }

    /* terminal (de-emphasized) */
    .terminal-section {
        padding-bottom: 3rem;
    }

    .terminal-blurb {
        color: #ffffffb0;
        max-width: 38rem;
    }

    .terminal-actions {
        display: flex;
        flex-direction: row;
        flex-wrap: wrap;
        gap: 0.75rem;
        margin: 1rem 0 1.25rem 0;
    }

    .terminal-actions i.fa-chevron-down {
        transition: transform 0.2s ease;
    }

    .terminal-actions i.fa-chevron-down.flipped {
        transform: rotate(180deg);
    }

    #terminal-container {
        padding: 1.5rem;
        color: white;
        border: 1px solid #ffffff2a;
        border-radius: 15px;
        overflow-y: auto;
        overflow-x: hidden;
        max-height: 500px;
        margin-top: 1rem;
        scrollbar-color: #fff #0000;
        scrollbar-arrow-color: #0000;
    }

    /* footer / accent blurb */
    #site-footer {
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        gap: 0.6rem;
        margin: 1rem 0 3rem 0;
        padding-top: 1.5rem;
        border-top: 1px solid #ffffff14;
        text-align: center;
    }

    .accent-swatch {
        display: inline-block;
        width: 0.9rem;
        height: 0.9rem;
        border-radius: 999px;
        background-color: #9FFDD8;
        flex-shrink: 0;
    }

    .accent-note {
        margin: 0;
        color: #ffffff80;
        font-family: var(--mono-font);
        font-size: 0.82rem;
        max-width: 34rem;
    }

    .accent-note code {
        color: #9FFDD8;
        background-color: #9FFDD818;
        border-radius: 0.35ch;
        padding: 0 0.5ch;
    }

    @media (max-width: 768px) {
        .nav-links {
            gap: 1rem;
        }

        .nav-links > a:not(.nav-resume) {
            display: none;
        }
    }
</style>
