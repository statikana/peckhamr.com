<script lang="ts">
//@ts-nocheck

import DOMPurify from "dompurify";
import { onMount } from 'svelte';

export const data = $state({
    terminal_text: "",
    history: []
});

let terminal_text = $state(data.terminal_text);
let history = $state(data.history);
let current_history_index = 0;

let current_autofill_recs = $state([]);
let autofill_selected_index = null;
let ignore_next_history = false;

var cursor_x = -1;
var cursor_y = -1;

/* cats */

const cats = [
    `\
         _
       \\\`*-.
        )  _\`-.
       .  : \`. .
       : _   '  \\
       ; *\` _.   \`*-._
       \`-.-'          \`-.
         ;       \`       \`.
         :.       .        \\
         . \\  .   :   .-'   .
         '  \`+.;  ;  '      :
         :  '  |    ;       ;-.
         ; '   : :\`-:     _.\`* ;
[bug] .*' /  .*' ; .*\`- +'  \`*'
      \`*-*   \`*-*  \`*-*'`,
    `\
   |\\---/|
   | ,_, |
    \\_\`_/-..----.
 ___/ \`   ' ,""+ \\  sk
(__...'   __\\    |\`.___.';
  (_,...'(_,.\`__)/'.....+`,
];

/* command defs */

class Command {
    constructor(name, short, usage, func, help_func = null, rec_pool = () => {return [];}) {
        this.name = name;
        this.short = short;
        this.usage = usage;
        this.func = func;
        this.help_func = help_func;
        this.rec_pool = rec_pool;
    }
}

let commands = {
    help: new Command(
        "help",
        "See what commands you can use",
        "help [Command Name]",
        commandHelp,
        null,
        () => {return ["terminal"].concat(Object.keys(commands))}
    ),
    echo: new Command(
        "echo",
        "Repeats back anything you give you it",
        "echo [Any Text]*",
        commandEcho,
    ),
    whois: new Command(
        "whois",
        "Who is Ryan?",
        "whois",
        commandWhoIs
    ),
    linkedin: new Command(
        "linkedin",
        "Get Ryan's linkedin",
        "linkedin",
        (args) => makeLink("https://www.linkedin.com/in/ryan-peckham-9b4114399/")
    ),
    instagram: new Command(
        "instagram",
        "Get Ryan's instagram",
        "instagram",
        (args) => makeLink("https://www.instagram.com/that.ryguy/")
    ),
    github: new Command(
        "github",
        "Get Ryan's GitHub",
        "github",
        (args) => makeLink("https://github.com/statikana"),
    ),
    resume: new Command(
        "resume",
        "Get Ryan's resume",
        "resume",
        (args) => window.location.href = "/ryan_peckham_resume.pdf"
    ),
    helloworld: new Command(
        "helloworld",
        "Hello World!!",
        "helloworld",
        (args) => "Hello World!"
    ),
    clear: new Command(
        "clear",
        "Clear's the terminal's history",
        "clear [Limit]",
        commandClear,
        null,
    ),
    feline: new Command(
        "feline",
        "Get a new random cat in the intro text (there's " + cats.length + " cats)",
        "feline",
        commandCat
    ),
    home: new Command(
        "home",
        "If you're in the full-screened terminal, takes you back to the embedded page",
        "home",
        (args) => {
            let url = URL.parse(window.location.href);
            if (url?.pathname === "/terminal") {
                window.location.href = "/";
                return "Bye!";
            } else {
                return "You're not full-screened right now (try " + makeLink("/terminal") + "?)";
            }
        }
    ),
    fullscreen: new Command(
        "fullscreen",
        "If you're in the embedded terminal page, takes you to the dedicated terminal page",
        "fullscreen",
        (args) => {
            let url = URL.parse(window.location.href);
            if (url?.pathname === "/") {
                window.location.href = "/terminal";
                return "Bye!";
            } else {
                return "You're already full-screened right now (try " + makeLink("/", "back to root") + "?)";
            }
        }
    )
};

/* command funcs */

function commandHelp(args) {
    if (args.length === 0) {
        return "Hello! Here are the available commands:\n" +
            _getHelpSignatures(Object.values(commands)) +
            "\n\nUse " + makeCode(commands["help"].usage) +" for more details\nUse " + makeCode("help terminal") + " for terminal controls.\n\n"
    } else if (args.length === 1) {
        let arg = args[0];
        if (arg === "terminal") {
            return "Terminal Controls:\n" +
            "- Use " + makeCode("Tab") + " or " + makeCode("Enter") + " to choose the autofill\n" +
            "- Use " + makeCode("ArrowUp") + " and " + makeCode("ArrowDown") + " to change selection";
        }
        if (Object.keys(commands).includes(arg)) {
            let cmd = commands[args[0]];
            if (cmd.help_func === null) {
                return "Command: " +
                    makeCode(cmd.name) +
                    "\n——— Purpose: " + cmd.short +
                    "\n——— Usage  : " + makeCode(cmd.usage);
            } else {
                return cmd.help_func(args);
            }
        }
    }
}

function commandWhoIs(args) {
    // Pulled from my AboutMe section on my linkedin profile. Would be neat to have it automatically pull from linkedin.com but there's an authwall and
    // its not really worth devising a solution for that
    return `I'm a Computer Engineering student at the University of Michigan building practical solutions that combine hardware and software. I work as Vice President of Software at Michigan Autonomous Security Team, where I'm leading sensor integration and software architecture for a prototype drone. I've also worked on machine learning fundamentals and built my personal website from scratch.

My technical foundation includes Python, C, C++, C#, and Java, with experience in full-stack development, database design, and embedded systems. I've learned as much from personal projects as I have from coursework. I'm comfortable with both the software side (Git, Docker, PostgreSQL) and the hands-on hardware work (soldering, CNC machines, welding). I am also highly interested in exploring the applications of Computer Engineering in the field of quantum physics and mechanics.

Before university, I was part of my high school's FIRST Robotics team where we won District Champions and multiple awards. I've also done customer-facing work at Target and local businesses, which taught me the importance of clear communication and attention to detail.

I'm always looking to deepen my engineering skills and work on projects that challenge me and have a real impact.`
    // return "He's just a silly little guy ngl";
}

function commandEcho(args) {
    return sanitize(args.join(" "));
}

function commandClear(args) {
    if (args.length === 0) {
        history = [];
        ignore_next_history = true;
        return "";
    } else if (args.length === 1) {
        let limit = args[0];
        let as_float = parseFloat(limit);
        if (isNaN(as_float) || !Number.isInteger(as_float) || as_float < 0) {
            return makeCode("clear") + " only takes positive, integer inputs (1, 2, 3, ...)"
        } else {
            history.splice(history.length - as_float);
            ignore_next_history = true;
            return "";
        }
    } else {
        return makeCode("clear") + " only takes one argument"
    }
}

function commandCat(args) {
    let introText = getIntroText();
    writeIntroText(introText, true);
    ignore_next_history = true;
    return "";
}

function _getHelpSignatures(cmds) {
    let max_diff = Math.max(...map((cmd) => cmd.name.length, cmds));

    let sigs = [];
    cmds.forEach(cmd => {
        sigs.push(
            makeCode(cmd.name) + " " + "—".repeat(max_diff - cmd.name.length + 1) + " " + cmd.short
        );
    });
    return sigs.join("\n");
}

/* terminal stuff */

function submitCommand() {
    let responseArr = getResponse();

    if (!ignore_next_history) {
        history.push([terminal_text, responseArr, current_history_index]);
        current_history_index += 1;
    } else {
        ignore_next_history = false;
    }
    terminal_text = "";
}

function getResponse() {
    let args = terminal_text.trim().split(" ");
    let command = args[0].toLowerCase();

    let response = commands[command];

    if (response === undefined) {
        if (terminal_text.trim() === "") {
            return "";
        }
        return "Unknown command " +
            makeCode(command) +
            " Try " +
            makeCode("help");
    } else {
        return response.func(args.splice(1)).trim();
    }
}

/* keyboard handlers */

function updateKeyDown(e) {
    const ignoredChars = ["Alt", "Meta", "Shift"];
    
    if (e.key === "Enter" && (autofill_selected_index === null)) {
        e.preventDefault();
        submitCommand();
    } else {
        let input = document.getElementById("terminal-input");
        // @ts-ignore
        let size = input.value.length;

        if (["ArrowRight", "Escape"].includes(e.key)) {
            // remove selected autofill
            e.preventDefault();
            autofill_selected_index = null;
            Array.prototype.forEach.call(document.getElementsByClassName("autofill-text-rec-highlight"), function(rec_highlight) {
                rec_highlight.style.visibility = "hidden";
            });
        } else if (e.key === "Tab" || e.key === "Enter") {
            // pressing Enter without a autofill selection is handled above
            if (autofill_selected_index === null) {
                autofill_selected_index = 0;
            }
            if (current_autofill_recs.length !== 0) {
                e.preventDefault();
            } else {
                return;
            }
            let args = terminal_text.split(" ")
            terminal_text = (args.slice(0, args.length-1).join(" ") + " " + current_autofill_recs[autofill_selected_index]).trim();

            document.getElementById("autofill").style.visibility = "hidden";
            Array.prototype.forEach.call(document.getElementsByClassName("autofill-text-rec-highlight"), function(rec_highlight) {
                rec_highlight.style.visibility = "hidden";
            })
            autofill_selected_index = null;

        } else if (["ArrowDown", "ArrowUp"].includes(e.key) && current_autofill_recs.length !== 0) {
            e.preventDefault();

            let min_index = 0;
            let max_index = current_autofill_recs.length - 1;

            if (e.key === "ArrowDown") {
                if (autofill_selected_index === null || autofill_selected_index === max_index) {
                    autofill_selected_index = min_index;
                } else {
                    autofill_selected_index += 1;
                }
            } else {
                if (autofill_selected_index === null || autofill_selected_index === min_index) {
                    autofill_selected_index = max_index;
                } else {
                    autofill_selected_index -= 1;
                }
            }

            let index = 0;

            /* iterate through highlight elements to update visibility based on selected index */
            Array.prototype.forEach.call(document.getElementsByClassName("autofill-text-rec-highlight"), function(rec_highlight) {
                if (index === autofill_selected_index) {
                    rec_highlight.style.visibility = "visible";
                } else {
                    rec_highlight.style.visibility = "hidden";
                }
                index += 1;
            });

        } else if (e.key === "Backspace") {
            document.getElementById("autofill").style.visibility = "visible";
            size -= 1;
        } else if (e.key === "Escape" || e.key === "ArrowRight" || e.key === "ArrowLeft") {
            autofill_selected_index = null;
            e.preventDefault();
        } else if (!ignoredChars.includes(e.key)) {
            document.getElementById("autofill").style.visibility = "visible";
            autofill_selected_index = null;
            size += 1;
        } else {
            e.preventDefault();
        }

        input.style.width = size + "ch";
    }
    updateAutofill();
}

function updateKeyUp(e) {
    let input = document.getElementById("terminal-input");
    input.style.width = input.value.length + "ch";
    updateAutofill();
}

/* autofill */

function updateAutofill() {
    if (!terminal_text || terminal_text.length === 0) {
        current_autofill_recs = [];
    } else {
        let args = terminal_text.split(" ");
        if (args.length === 1) {
            /* just general commands */
            current_autofill_recs = filterAutofillStrings(Object.keys(commands), terminal_text);
        } else {
            if (Object.keys(commands).includes(args[0])) {
                current_autofill_recs = filterAutofillStrings(commands[args[0]].rec_pool(), args[1]);
            }
        }
    }
}

function filterAutofillStrings(pool, test) {
    return pool.filter((str) => str.split(" ")[0].startsWith(test.toLowerCase()) && str !== test);
}

/* terminal */

function focusTerminal() {
    document.getElementById("terminal-input").focus();
}

function enableInput() {
    document.getElementById("cursor").style.visibility = "visible";
    document.getElementById("autofill").style.visibility = "visible";
    document.getElementById("default-text").innerHTML = "";
}

function disableInput() {
    let autofillRect = document.getElementById("autofill")?.getBoundingClientRect();
    let isAutofillClick = (
        cursor_x >= autofillRect.left &&
        cursor_x <= (autofillRect.left + autofillRect.width)
    ) && (
        cursor_y >= autofillRect.top &&
        cursor_y <= (autofillRect.top + autofillRect.height)
    )

    if (isAutofillClick) {
        return;
    }
    document.getElementById("cursor").style.visibility = "hidden";
    document.getElementById("autofill").style.visibility = "hidden";
    autofill_selected_index = null;
    document.getElementById("default-text").innerHTML = (history.length !== 0 || terminal_text !== "") ? "" : "try typing here...";
}

/* utils for other stuff */

function typewrite(text, element, delay = 10, reset = false, on_finish = () => {}, on_finish_delay = 0) {
    /* text is an array? NO MORE */
    if (reset) {
        element.innerHTML = "";
    }
    let index = 0;
    let interval = setInterval(() => {
        let ele = text[index];
        element.innerHTML += ele;
        index += 1;
        if (index >= text.length) {
            clearInterval(interval);
            setTimeout(on_finish, on_finish_delay);
        }
    }, delay);
}

function makeCode(text) {
    return "<span class=fmt-code>" + sanitize(text) + "</span>"
}

function makeLink(url, text="") {
    return "<a class=fmt-link href=" + sanitize(url) + " target=_blank>" + sanitize(text? text : url) + "</a>"
}

function map(func, iter) {
    let post = [];
    iter.forEach(e => post.push(func(e)));
    return post;
}

function sanitize(html) {
    return DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ["span", "b", "i", "u", "pre", "br"],
        ALLOWED_ATTR: ["class"]
    });
}

function getCat() {
    return cats[Math.floor(Math.random() * cats.length)];
}

function getIntroText() {
    let t = (getCat() + "\n\nhi, im ryan. i like making stuff. try the ").split("").concat(makeCode("help")).concat(" command.\nuse arrow keys + [TAB] to use autocomplete".split(""));
    let url = URL.parse(window.location.href);
    if (url?.pathname === "/terminal") {
        t = t.concat("\nyou can also use the ".split("")).concat(makeCode("home")).concat(" command to go back to my main site".split(""))
    }
    return t;
}

function writeIntroText(introText: string[], reset = false) {
    typewrite(
        introText,
        document.getElementById("animation"),
        0,
        reset,
        () => {
            document.getElementById("terminal-input")?.focus();
            //@ts-ignore
            document.getElementById("input-container").style.visibility = "visible";
            enableInput();
            focusTerminal();
        },
        350
    )
}

onMount(() => {
    let introText = getIntroText();
    writeIntroText(introText);

    document.onmousemove = (event) => {
        cursor_x = event.pageX;
        cursor_y = event.pageY;
    }
});

</script>

<!-- snippets -->

{#snippet prefix(is_main)}
    <span class="prefix">
        <pre class="inline" id={is_main? "current-prefix" : ""}>guest@peckhamr.com> </pre>
    </span>
{/snippet}

{#snippet autofillRec(rec)}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <li class="autofill-text-rec inline autofill-component" 
        onclick={ () => { 
            focusTerminal(); 
            let args = terminal_text.split(" ");
            args[args.length-1] = rec;
            terminal_text = args.join(" "); 
            let input = document.getElementById("terminal-input");

            //@ts-ignore
            input.style.width = terminal_text.length + "ch";
            updateAutofill();
        } }
    >
        <div class="autofill-text-rec-highlight" style="visibility: hidden;"></div>
        <span style="color:white">{
            rec.slice(0, terminal_text.split(" ")[terminal_text.split(" ").length - 1].length)
        }
        </span>
        <span>
            {rec.slice(terminal_text.split(" ")[terminal_text.split(" ").length - 1].length)}
        </span>
    </li>
{/snippet}

<!-- template -->

<div id=main-terminal>
    <!-- animation/intro Text -->
    <pre id=animation></pre>

    <!-- command history -->
    {#each history as h}
        <div class="input-row">
            {@render prefix(false)}
            <div class="line history-input">{h[0]}</div>
        </div>
        <pre class="history-text inline" data-history-index={h[2]}>{@html h[1]}</pre>
        <br />
    {/each}

    <!-- current input -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div id="input-container">
        <div class="input-row current-input-row" onclick={focusTerminal}>
            {@render prefix(true)}
            <span id="default-text"></span>
            
            <div id="secondary-input">
                <div id=entry>
                    <input 
                        class="line inline" id="terminal-input" autocomplete="off" autocapitalize="off"
                        onkeydown={updateKeyDown} onkeyup={updateKeyUp} 
                        onfocusout={disableInput} onfocusin={enableInput}
                        bind:value={terminal_text}
                    />
                    <span id="cursor"></span>
                </div>
                
                <!-- autofill suggestions -->
                <ul id=autofill class="inline autofill-component">
                    {#each current_autofill_recs as rec}
                        {@render autofillRec(rec)}
                    {/each}
                </ul>
            </div>
        </div>
    </div>

    <div id=screen-spacer></div>
</div>

<style>

/* page layout */

#main-terminal {
    padding: 1%;
    margin: 0;
    display: flex;
    flex-direction: column;
    background-color: #242426;
    font-family: monospace !important;
    font-size: 14px !important;
}

#screen-spacer {
    min-height: 5vh;
    width: 90vw;
}

/* layout */

.input-row {
    display: flex;
    flex-direction: row;
    border: none;
    outline: none;
    color: #efa368;
}

#secondary-input {
    display: flex;
    flex-direction: column;
}

#entry {
    display: flex;
    flex-direction: row;
    align-items: top;
}

#input-container {
    visibility: hidden;
}

/* prefix */

.prefix {
    flex-shrink: 0;
    color: rgb(155, 232, 177);
    user-select: none;
    display: flex;
}

/* text display */
.history-text {
    overflow-wrap: break-word;
    white-space: pre-wrap;
}
.history-text,
#animation {
    color: white;
}

.history-input {
    flex: 1;
}

#default-text {
    color: #ffffff80;
    user-select: none;
}

/* input */

.line {
    width: 0ch;
    border: none;
    outline: none;
    color: inherit;
    background-color: inherit;
}

.inline {
    margin: 0;
    padding: 0;
}

#terminal-input {
    caret-color: transparent;
    font-family: monospace !important;
    top: -1px;
    position: relative;
}

/* cusrsor */

#cursor {
    width: 1ch;
    height: 18px;
    display: inline-block;
    background-color: white;
    animation-name: cursorBlink;
    animation-duration: 1s;
    animation-iteration-count: infinite;
}

@keyframes cursorBlink {
    from { background-color: white; }
    to { background-color: #ffffff00; }
}

/* autofill */

#autofill {
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    position: relative;
    list-style-type: none;
    visibility: "hidden";
    color: #ffffff80;
    margin-top: .1ch;
    left: -5px; /* adjust for highlight's width */
}

.autofill-text-rec {
    display: flex;
    flex-direction: row;
}

.autofill-text-rec-highlight {
    flex: 0;
    min-width: 5px;
    min-height: 100%;
    background-color: #efa368;
}


:global(.fmt-code) {
    background-color: #ffffff1a;
    padding-left: .5ch;
    padding-right: .5ch;
    border-radius: .35ch;
}

:global(.fmt-link) {
    color: #de81c7;
}

::selection {
    color: #2c2c2c;
    background-color: #ffffff;
}
</style>