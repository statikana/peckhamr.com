<script>
    import Terminal from "../Terminal.svelte";
</script>

<svelte:head>
    <script src="https://kit.fontawesome.com/e469a2ed37.js" crossorigin="anonymous"></script>
</svelte:head>

<div id="main-personal">
    <div id="me">
        <p id="name">
            Ryan Peckham
        </p>
        <div id="info">
            <p id="info-bits">
                <a class=link href="emailto:peckhamr@umich.edu">peckhamr@umich.edu</a>
                •
                <span >Ann Arbor, MI</span>
            </p>
        </div>
        <p id="bio">
            Computer Engineering<br>
            University of Michigan
            <br>
            <span>class of 2029</span>
        </p>
        <div id="links">
            <a class="social-link" href="https://github.com/statikana" aria-label="github" target="_blank"><i class="fa-brands fa-github"></i></a>
            <a class="social-link" href="https://www.linkedin.com/in/ryan-peckham-9b4114399/" aria-label="linkedin" target="_blank"><i class="fa-brands fa-linkedin"></i></a>
            <a class="social-link" href="https://www.instagram.com/that.ryguy/" aria-label="instagram" target="_blank"><i class="fa-brands fa-instagram"></i></a>
        </div>  
    </div>

    <div id=terminal-container>
        <details id=terminal-details open>
            <summary>my super cool terminal <a href="/terminal"> [click for fullscreen]</a></summary>
            <Terminal />
        </details>
    </div>

    <div class="center" id="projects">
        <div class="project">
            <p>Project One</p>
            <div class="project-desc">
                I hope to someday put things here...
            </div>
        </div>
        <hr class="line-break">
        <div class="project">
            <p>Project Two</p>
            <div class="project-desc">
                It feels so empty in this website...
            </div>
        </div>
        <hr class="line-break">
        <div class="project">
            <p>Project Three</p>
            <div class="project-desc">
                I should start making stuff...
            </div>
        </div>
        <hr class="line-break">
        <div class="project">
            <p>Project Four</p>
            
            <div class="project-desc">
                Why are you still reading these?
            </div>
        </div>
    </div>
</div>

<style>
    :global(body) {
        margin: 0;
    }
    #terminal-container {
        padding: 2%;
        color: white;
        border: white;
        border-style: solid;
        border-width: 3px;
        border-radius: 15px;
        overflow-y: scroll;
        overflow-x: hidden;

        width: 90%;


        scrollbar-color: #fff #0000;
        scrollbar-arrow-color: #0000;
    }

    #terminal-container > details > summary:hover {
        cursor:pointer;
    }

    #main-personal {
        display: flex;
        flex-direction: column;
        align-items: center;
    }



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

    a.link, a.social-link {
        color: inherit;
        text-decoration: underline;
        text-decoration-color: #fff3;
    }


    #info-bits {
        color: #fff5;
        padding: 0;
        margin: 0;
    }

    #links {
        font-size: 200%;
    }

    div#me > p#bio {
        margin-top: 1%;
        padding: 1%;
    }

    div#me > p#bio > span {
        color: #fff5
    }


    div.center {
        margin-top: 2%;
        margin-bottom: 2%;

        color: #fff;
        padding: 1%;
        width: 90%;
    }

    hr.line-break {
        width: 90%
    }

    div.project > div.project-desc {
        margin-left: 5%;
    }
</style>