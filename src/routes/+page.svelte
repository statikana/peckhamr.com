<script>
    import Terminal from "../Terminal.svelte";
    
    function toggleTheme() {
        // TODO
    }
</script>

<svelte:head>
    <script src="https://kit.fontawesome.com/e469a2ed37.js" crossorigin="anonymous"></script>
</svelte:head>

<div id="theme-toggle-div">
    <!-- svelte-ignore a11y_consider_explicit_label -->
    <!-- <button id="theme-toggle-btn" onclick={toggleTheme}>
        <i class="fa-regular fa-sun"></i>
    </button> -->
</div>

<div id="main-personal">
    <!-- personal -->
    <div id="me">
        <p id="name" class="glow">
            Ryan Peckham
        </p>
        <div id="info">
            <p id="info-bits">
                <a class="link" href="emailto:peckhamr@umich.edu">peckhamr@umich.edu</a>
                •
                <span>Ann Arbor, MI</span>
            </p>
        </div>
        <p id="bio">
            Computer Engineering<br>
            University of Michigan<br>
            <span>Class of 2029</span>
        </p>
        <div id="links">
            <a class="social-link" href="https://github.com/statikana" aria-label="github" target="_blank">
                <i class="fa-brands fa-github"></i>
            </a>
            <a class="social-link" href="https://www.linkedin.com/in/ryan-peckham-9b4114399/" aria-label="linkedin" target="_blank">
                <i class="fa-brands fa-linkedin"></i>
            </a>
            <a class="social-link" href="https://www.instagram.com/that.ryguy/" aria-label="instagram" target="_blank">
                <i class="fa-brands fa-instagram"></i>
            </a>
            <a class="social-link" href="/Ryan_Peckham_Resume.pdf" aria-label="resume" target="_blank">
                <i class="fa-regular fa-file"></i>
            </a>
        </div>
    </div>

    <!-- inner stuff -->
    <div class="row-shell">
        <!-- terminal -->
        <div id="terminal-container">
            <details id="terminal-details" open>
                <summary>my super cool terminal <a href="/terminal">[click for fullscreen]</a></summary>
                <Terminal />
            </details>
        </div>

        <div class="spacer"></div>

        <!-- projects -->
        <div class="col-shell">
            <h2 class="titlebar glow">My Stuff</h2>
            <div class="center" id="projects">
                <!-- this site -->
                <div class="project">
                    <p>This Site</p>
                    <div class="project-desc">
                        Of course, I made this site using HTML, CSS, and JS. I also used <a href="https://svelte.dev/" target="_blank">Svelte</a> for routing and 
                        dynamic rendering. To protect my privacy, this site's code is not publicly linked to my github, but you are free to inspect the page source.
                    </div>
                </div>
                <hr class="line-break">

                <!-- pytenno -->
                <div class="project">
                    <p>PyTenno [<a href="https://github.com/statikana/PyTenno" target="_blank">Source</a>]</p>
                    <div class="project-desc">
                        A relatively simple asynchonous HTTPS wrapper for <a href="https://warframe.market/" target="_blank">warframe.market</a>, a website where users can
                        buy and sell items in the video game <a href="https://www.warframe.com/game/about" target="_blank">Warframe</a>. Written in Python, it translates API endpoints
                        and JSON structures into Python functions and data structures. It was my first package which I published on <a href="https://pypi.org/project/pytenno/" target="_blank">PyPI</a> (Python's Package Index). 
                        It includes comprehensive documentation on <a href="https://pytenno.readthedocs.io/en/latest/index.html" target="_blank">readthedocs.io</a>, though it isn't maintained any more.
                    </div>
                </div>
                <hr class="line-break">

                <!-- DLM -->
                <div class="project">
                    <p>Download Manager [<a href="https://github.com/statikana/dlm" target="_blank">Source</a>]</p>
                    <div class="project-desc">
                        Also made in Python, I used this to explore multithreading. It uses concurrent threads on your device to read and write data from a website (e.g., a file server) faster than you are normally able to.
                        Each thread reads a different segment of the source file, and writes to the associated segment of the new file being created on your computer. Uses file locks to
                        prevent race conditions. Shows substantial improvements in download times, depending on the file size and the number of concurrent threads used.
                    </div>
                </div>
                <hr class="line-break">

                <!-- Vanir -->
                <div class="project">
                    <p>Vanir [<a href="https://github.com/statikana/Vanir" target="_blank">Source</a>]</p>
                    <div class="project-desc">
                        One of my first substantial projects. Uses <a href="https://discord.com/" target="_blank">Discord</a>'s API to create an interactive bot-agent which users
                        can send commands to. Notable features include:
                        <ul>
                            <li>An SQL-based currency system with robust normalization</li>
                            <li>Safe, sandboxed arbitrary code execution for many languages via <a href="https://github.com/engineer-man/piston" target="_blank">Piston</a></li>
                        </ul> 
                    </div>
                </div>
            </div>
        </div>
    </div>
</div>

<style>
    :global(body) {
        margin: 0;
    }

    /* main layout */
    #main-personal {
        display: flex;
        flex-direction: column;
    }

    .row-shell {
        display: flex;
        flex-direction: row;
    }

    .col-shell {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
    }

    .spacer {
        flex: 0.05;
    }

    /* theme toggle */
    /* #theme-toggle-btn {
        justify-self: left;
        background-color: inherit;
        color: #fff;
        font-size: 125%;
        box-shadow: none;
        border: none;
        margin: 1%;
        padding: 0;
    }

    #theme-toggle-btn:hover {
        text-shadow: 0 0 10px #fff8;
    } */

    /* util */
    .glow {
        color: #fff;
    }

    .titlebar {
        margin-top: 3%;
        margin-bottom: 0;
    }

    /* personal */
    div#me {
        border-style: hidden;
        margin: 5%;
        text-align: center;
        color: #fff;
    }

    div#me > p#name {
        padding-bottom: 0;
        margin: 0;
        font-size: 300%;
    }

    #info-bits {
        color: #fff5;
        padding: 0;
        margin: 0;
    }

    div#me > p#bio {
        margin-top: 1%;
        padding: 1%;
    }

    div#me > p#bio > span {
        color: #fff5;
    }

    #links {
        font-size: 200%;
    }

    /* links */
    a.link,
    a.social-link {
        color: inherit;
        text-decoration: underline;
        text-decoration-color: #fff3;
    }

    /* terminal */
    #terminal-container {
        padding: 2%;
        color: white;
        border: white;
        border-style: solid;
        border-width: 3px;
        border-radius: 15px;
        overflow-y: scroll;
        overflow-x: hidden;
        flex: 0.9;
        margin-left: 2%;
        scrollbar-color: #fff #0000;
        scrollbar-arrow-color: #0000;
    }

    #terminal-container > details {
        max-height: 500px;
    }

    #terminal-container > details > summary:hover {
        cursor: pointer;
    }
    

    /* projs */
    div.center {
        margin-bottom: 2%;
        color: #fff;
        padding: 1%;
    }

    ul {
        margin-top: 0.5%;
    }

    div.project > div.project-desc {
        margin-left: 2.5%;
        color: #fffa;
        font-size: 1em;
    }

    /* change to vertical layout with mobile (>=768px width ig) */
    @media (max-width: 768px) {
        .row-shell {
            flex-direction: column;
        }
        
        #terminal-container {
            margin-left: 0;
            margin-bottom: 2%;
        }
        
        .spacer {
            display: none;
        }
    }
</style>