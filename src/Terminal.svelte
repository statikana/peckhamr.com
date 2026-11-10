<script lang="ts">
//@ts-nocheck

import DOMPurify from "dompurify";
import { onMount, tick } from "svelte";
import { appUrl, getAppFromHost } from "$lib/apps";

function isFullscreenTerminal(url) {
    if (!url) return false;
    return (
        getAppFromHost(url.host) === "terminal" ||
        url.pathname === "/terminal" ||
        url.pathname === "/terminal/"
    );
}

export const data = $state({
    terminal_text: "",
    history: []
});

let terminal_text = $state(data.terminal_text);
let history = $state(data.history);
let current_history_index = 0;

let current_autofill_recs = $state([]);
let autofill_selected_index = $state(0);
let user_navigated_autofill = $state(false);
let show_autofill = $state(false);
let is_focused = $state(false);
let cmd_history_cursor = $state(null);
let ignore_next_history = false;

/* cats */

let last_cat_index = -1;

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
      .*' /  .*' ; .*\`- +'  \`*'
      \`*-*   \`*-*  \`*-*'`,
    `\
   |\\---/|
   | ,_, |
    \\_\`_/-..----.
 ___/ \`   ' ,""+ \\    
(__...'   __\\    |\`.___.';
  (_,...'(_,.\`__)/'.....+`,
    `\
      |\\      _,,,---,,_
ZZZzz /, \`.-'\`'    -.  ;-;;,_
     |,4-  ) )-,_. ,\\ (  \`'-'
    '---''(_/--'  \`-'\\_)`,
    `\
  /\\_/\\  (
 ( ^.^ ) _)
   \\"/  (
 ( | | )
(__d b__)`,
    `\
    /\\_____/\\
   /  o   o  \\
  ( ==  ^  == )
   )         (
  (           )
 ( (  )   (  ) )
(__(__)___(__)__)`,
    `\
      /\\_/\\
 /\\  / o o \\
//\\\\ \\~(*)~/
\`  \\/   ^ /
   | \\|| ||
   \\ '|| ||
    \\)()-())`,
    `\
   |\\__/,|   (\`\\
 _.|o o  |_   ) )
-(((---(((--------`,
    `\
       _     _
      |\\\\_,-~/
      / _  _ |    ,--.
     (  @  @ )   / ,-'
      \\  _T_/-._( (
      /         \`. \\
     |         _  \\ |
      \\ \\ ,  /      |
       || |-_\\__   /
      ((_/\`(____,-'`,
    `\
   /\\_/\\
  ( -.- )___
   |      _ \\
   |  |  | \\ \\
   (__|__)  \\_\\`,
    `\
    |\\__/,|   (\`\\
  _.| ^ ^ |_   ) )
 -(((---(((--------
  |  [  box  ]  |
  '-------------'`,
];

/* command defs */

class Command {
    constructor(name, short, usage, func, help_func = null, rec_pool = () => { return []; }) {
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
        () => { return ["terminal"].concat(Object.keys(commands)); }
    ),
    echo: new Command(
        "echo",
        "Repeats back anything you give it",
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
        "Get Ryan's LinkedIn",
        "linkedin",
        (args) => makeLink("https://www.linkedin.com/in/peckhamr/")
    ),
    instagram: new Command(
        "instagram",
        "Get Ryan's Instagram",
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
        (args) => window.location.href = appUrl("home", "/ryan_peckham_resume.pdf")
    ),
    helloworld: new Command(
        "helloworld",
        "Hello World!!",
        "helloworld",
        (args) => "Hello World!"
    ),
    clear: new Command(
        "clear",
        "Clears the terminal's history",
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
            if (isFullscreenTerminal(url)) {
                window.location.href = appUrl("home", "/");
                return "Bye!";
            } else {
                return "You're not full-screened right now (try " + makeLink(appUrl("terminal", "/")) + "?)";
            }
        }
    ),
    fullscreen: new Command(
        "fullscreen",
        "If you're in the embedded terminal page, takes you to the dedicated terminal page",
        "fullscreen",
        (args) => {
            let url = URL.parse(window.location.href);
            if (!isFullscreenTerminal(url)) {
                window.location.href = appUrl("terminal", "/");
                return "Bye!";
            } else {
                return "You're already full-screened right now (try " + makeLink(appUrl("home", "/"), "back to root") + "?)";
            }
        }
    )
};

/* command funcs */

function commandHelp(args) {
    if (args.length === 0) {
        return "Hello! Here are the available commands:\n" +
            _getHelpSignatures(Object.values(commands)) +
            "\n\nUse " + makeCode(commands["help"].usage) + " for more details\nUse " + makeCode("help terminal") + " for terminal controls.";
    } else if (args.length === 1) {
        let arg = args[0].toLowerCase();
        if (arg === "terminal") {
            return "Terminal Controls:\n" +
                "- Use " + makeCode("Tab") + " or " + makeCode("ArrowRight") + " to accept the active suggestion\n" +
                "- Use " + makeCode("ArrowUp") + " and " + makeCode("ArrowDown") + " to navigate suggestions or command history\n" +
                "- Press " + makeCode("Tab") + " on an empty line to browse all commands";
        }
        if (Object.keys(commands).includes(arg)) {
            let cmd = commands[arg];
            if (cmd.help_func === null) {
                return "Command: " +
                    makeCode(cmd.name) +
                    "\n——— Purpose: " + cmd.short +
                    "\n——— Usage  : " + makeCode(cmd.usage);
            } else {
                return cmd.help_func(args);
            }
        }
        return "Unknown topic " + makeCode(arg) + ". Try " + makeCode("help");
    }
    return "Usage: " + makeCode(commands["help"].usage);
}

function commandWhoIs(args) {
    return `I'm a Computer Engineering student at the University of Michigan building practical solutions that combine hardware and software. I work as Vice President of Software at Michigan Autonomous Security Team, where I'm leading sensor integration and software architecture for a prototype drone. I've also worked on machine learning fundamentals and built my personal website from scratch.

My technical foundation includes Python, C, C++, C#, and Java, with experience in full-stack development, database design, and embedded systems. I've learned as much from personal projects as I have from coursework. I'm comfortable with both the software side (Git, Docker, PostgreSQL) and the hands-on hardware work (soldering, CNC machines, welding). I am also highly interested in exploring the applications of Computer Engineering in the field of quantum physics and mechanics.

Before university, I was part of my high school's FIRST Robotics team where we won District Champions and multiple awards. I've also done customer-facing work at Target and local businesses, which taught me the importance of clear communication and attention to detail.

I'm always looking to deepen my engineering skills and work on projects that challenge me and have a real impact.`;
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
            return makeCode("clear") + " only takes positive, integer inputs (1, 2, 3, ...)";
        } else {
            history.splice(history.length - as_float);
            ignore_next_history = true;
            return "";
        }
    } else {
        return makeCode("clear") + " only takes one argument";
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

/* terminal execution */

async function submitCommand() {
    let rawCmd = terminal_text;
    let responseArr = getResponse();

    if (!ignore_next_history) {
        history.push([rawCmd, responseArr, current_history_index]);
        current_history_index += 1;
    } else {
        ignore_next_history = false;
    }
    terminal_text = "";
    cmd_history_cursor = null;
    current_autofill_recs = [];
    show_autofill = false;
    user_navigated_autofill = false;

    await tick();
    scrollTerminalToBottom();
}

function scrollTerminalToBottom() {
    const container = document.getElementById("terminal-container");
    if (container) {
        container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    } else {
        window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    }
}

function getResponse() {
    let trimmed = terminal_text.trim();
    if (trimmed === "") {
        return "";
    }
    let args = trimmed.split(/\s+/);
    let command = args[0].toLowerCase();

    let response = commands[command];

    if (response === undefined) {
        return "Unknown command " +
            makeCode(command) +
            ". Try " +
            makeCode("help");
    } else {
        return (response.func(args.slice(1)) || "").trim();
    }
}

/* autocomplete & keyboard handlers */

function applyAutofillSelection(index = autofill_selected_index ?? 0) {
    if (current_autofill_recs.length === 0) return false;
    const target = current_autofill_recs[index] || current_autofill_recs[0];
    if (!target) return false;

    const hasLeadingCmd = terminal_text.includes(" ");
    if (!hasLeadingCmd) {
        // Completing primary command
        const cmdObj = commands[target.value];
        const hasArgs = cmdObj && cmdObj.rec_pool().length > 0;
        terminal_text = target.value + (hasArgs ? " " : "");
    } else {
        // Completing subcommand/argument
        const parts = terminal_text.split(" ");
        parts[parts.length - 1] = target.value;
        terminal_text = parts.join(" ");
    }

    user_navigated_autofill = false;
    updateAutofill(false);
    focusTerminal();
    return true;
}

function updateKeyDown(e) {
    if (e.key === "Enter") {
        e.preventDefault();
        if (show_autofill && user_navigated_autofill && current_autofill_recs.length > 0) {
            applyAutofillSelection(autofill_selected_index ?? 0);
        } else {
            submitCommand();
        }
        return;
    }

    if (e.key === "Tab") {
        e.preventDefault();
        if (terminal_text.trim() === "" && (!show_autofill || current_autofill_recs.length === 0)) {
            // Show all commands when pressing Tab on an empty input
            updateAutofill(true);
            user_navigated_autofill = true;
            tick().then(scrollTerminalToBottom);
            return;
        }
        if (show_autofill && current_autofill_recs.length > 0) {
            applyAutofillSelection(autofill_selected_index ?? 0);
        } else {
            updateAutofill(false);
        }
        return;
    }

    if (e.key === "ArrowRight") {
        const input = document.getElementById("terminal-input");
        const atEnd = !input || input.selectionStart === terminal_text.length;
        if (atEnd && show_autofill && current_autofill_recs.length > 0 && terminal_text.length > 0) {
            e.preventDefault();
            applyAutofillSelection(autofill_selected_index ?? 0);
            return;
        }
    }

    if (e.key === "Escape") {
        if (show_autofill) {
            e.preventDefault();
            show_autofill = false;
            user_navigated_autofill = false;
        }
        return;
    }

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (show_autofill && current_autofill_recs.length > 0) {
            e.preventDefault();
            const len = current_autofill_recs.length;
            if (e.key === "ArrowDown") {
                if (!user_navigated_autofill) {
                    user_navigated_autofill = true;
                    autofill_selected_index = len > 1 ? 1 : 0;
                } else {
                    autofill_selected_index = (autofill_selected_index + 1) % len;
                }
            } else {
                user_navigated_autofill = true;
                autofill_selected_index = (autofill_selected_index - 1 + len) % len;
            }
            return;
        }

        // Command history recall when autocomplete is closed
        const cmdHistory = history.map((h) => h[0]).filter((c) => c && c.trim() !== "");
        if (cmdHistory.length > 0) {
            e.preventDefault();
            if (e.key === "ArrowUp") {
                if (cmd_history_cursor === null) {
                    cmd_history_cursor = cmdHistory.length - 1;
                } else if (cmd_history_cursor > 0) {
                    cmd_history_cursor -= 1;
                }
                terminal_text = cmdHistory[cmd_history_cursor];
            } else {
                if (cmd_history_cursor !== null) {
                    if (cmd_history_cursor < cmdHistory.length - 1) {
                        cmd_history_cursor += 1;
                        terminal_text = cmdHistory[cmd_history_cursor];
                    } else {
                        cmd_history_cursor = null;
                        terminal_text = "";
                    }
                }
            }
        }
        return;
    }
}

function handleInput() {
    cmd_history_cursor = null;
    user_navigated_autofill = false;
    updateAutofill(false);
}

/* autofill builder */

function getRecDescription(cmdContext, value) {
    if (!cmdContext) {
        return commands[value]?.short || "";
    }
    if (cmdContext === "help") {
        if (value === "terminal") return "Keyboard shortcuts & autocomplete controls";
        return commands[value]?.short || "";
    }
    return "";
}

function buildRecItems(pool, query, cmdContext = null) {
    const q = (query || "").toLowerCase();
    const prefixMatches = [];
    const substringMatches = [];

    for (const item of pool) {
        const token = item.split(" ")[0];
        const lower = token.toLowerCase();
        if (lower === q && cmdContext !== "help") continue;
        if (q === "" || lower.startsWith(q)) {
            prefixMatches.push({
                value: token,
                matchPrefix: token.slice(0, q.length),
                rest: token.slice(q.length),
                isPrefix: true,
                desc: getRecDescription(cmdContext, token)
            });
        } else if (lower.includes(q)) {
            substringMatches.push({
                value: token,
                matchPrefix: "",
                rest: token,
                isPrefix: false,
                desc: getRecDescription(cmdContext, token)
            });
        }
    }

    return prefixMatches.concat(substringMatches);
}

function updateAutofill(forceShowAll = false) {
    if (forceShowAll) {
        current_autofill_recs = buildRecItems(Object.keys(commands), "", null);
        autofill_selected_index = 0;
        show_autofill = current_autofill_recs.length > 0;
        return;
    }

    if (!terminal_text || terminal_text.length === 0) {
        current_autofill_recs = [];
        show_autofill = false;
        autofill_selected_index = 0;
        return;
    }

    const args = terminal_text.split(" ");
    if (args.length === 1) {
        current_autofill_recs = buildRecItems(Object.keys(commands), args[0], null);
    } else if (args.length === 2) {
        const cmdName = args[0].toLowerCase();
        if (Object.keys(commands).includes(cmdName)) {
            const pool = commands[cmdName].rec_pool();
            if (pool.length > 0 && args[1].toLowerCase() !== pool.find((p) => p.toLowerCase() === args[1].toLowerCase())) {
                current_autofill_recs = buildRecItems(pool, args[1], cmdName);
            } else {
                current_autofill_recs = [];
            }
        } else {
            current_autofill_recs = [];
        }
    } else {
        current_autofill_recs = [];
    }

    autofill_selected_index = 0;
    show_autofill = current_autofill_recs.length > 0;
}

let ghostSuffix = $derived.by(() => {
    if (!is_focused || !show_autofill || current_autofill_recs.length === 0 || !terminal_text) {
        return "";
    }
    const active = current_autofill_recs[autofill_selected_index ?? 0];
    if (!active || !active.isPrefix) return "";
    return active.rest;
});

/* terminal focus */

function focusTerminal() {
    document.getElementById("terminal-input")?.focus();
}

function enableInput() {
    is_focused = true;
    if (current_autofill_recs.length > 0) {
        show_autofill = true;
    }
}

function disableInput() {
    is_focused = false;
    show_autofill = false;
    user_navigated_autofill = false;
}

/* utils */

function typewrite(text, element, delay = 10, reset = false, on_finish = () => {}, on_finish_delay = 0) {
    if (!element) return;
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
    return "<span class=fmt-code>" + sanitize(text) + "</span>";
}

function makeLink(url, text = "") {
    return "<a class=fmt-link href=" + sanitize(url) + " target=_blank>" + sanitize(text ? text : url) + "</a>";
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
    if (cats.length <= 1) return cats[0];
    let idx = Math.floor(Math.random() * cats.length);
    while (idx === last_cat_index) {
        idx = Math.floor(Math.random() * cats.length);
    }
    last_cat_index = idx;
    return cats[idx];
}

function getIntroText() {
    let t = (getCat() + "\n\nhi, im ryan. i like making stuff. try the ").split("").concat(makeCode("help")).concat(" command, or ".split("")).concat(makeCode("whois")).concat(" to learn more about me.\npress ".split("")).concat(makeCode("Tab")).concat(" to autocomplete commands (or ".split("")).concat(makeCode("↑")).concat(" / ".split("")).concat(makeCode("↓")).concat(" to navigate).".split(""));
    let url = URL.parse(window.location.href);
    if (isFullscreenTerminal(url)) {
        t = t.concat("\nyou can also use the ".split("")).concat(makeCode("home")).concat(" command to go back to my main site.".split(""));
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
            const inputContainer = document.getElementById("input-container");
            if (inputContainer) {
                inputContainer.style.visibility = "visible";
            }
            enableInput();
            focusTerminal();
        },
        200
    );
}

onMount(() => {
    let introText = getIntroText();
    writeIntroText(introText);
});
</script>

<!-- snippets -->

{#snippet prefix(is_main)}
    <span class="prefix" id={is_main ? "current-prefix" : ""}>guest@peckhamr.com&gt;</span>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div id="main-terminal" onclick={() => {
    if (!window.getSelection()?.toString()) {
        focusTerminal();
    }
}}>
    <!-- animation/intro Text -->
    <pre id="animation"></pre>

    <!-- command history -->
    {#if history.length > 0}
        <div class="history-list">
            {#each history as h (h[2])}
                <div class="history-entry">
                    <div class="input-row history-cmd-row">
                        {@render prefix(false)}
                        <div class="history-input">{h[0]}</div>
                    </div>
                    {#if h[1]}
                        <pre class="history-text" data-history-index={h[2]}>{@html h[1]}</pre>
                    {/if}
                </div>
            {/each}
        </div>
    {/if}

    <!-- current input -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div id="input-container">
        <div class="input-row current-input-row" onclick={focusTerminal}>
            {@render prefix(true)}

            <div id="secondary-input">
                <div id="entry">
                    {#if !is_focused && history.length === 0 && terminal_text === ""}
                        <span id="default-text">try typing 'help' or press Tab...</span>
                    {/if}
                    <input
                        class="line inline"
                        id="terminal-input"
                        autocomplete="off"
                        autocapitalize="off"
                        spellcheck="false"
                        style:width="{terminal_text.length}ch"
                        onkeydown={updateKeyDown}
                        oninput={handleInput}
                        onfocusout={disableInput}
                        onfocusin={enableInput}
                        bind:value={terminal_text}
                    />
                    <span id="cursor" class:cursor-visible={is_focused}></span>
                    {#if ghostSuffix}
                        <span class="ghost-completion">{ghostSuffix}<span class="ghost-tab-badge">Tab</span></span>
                    {/if}
                </div>

                <!-- autofill suggestions -->
                {#if show_autofill && current_autofill_recs.length > 0}
                    <div class="autofill-popover">
                        <div class="autofill-header">
                            <span>Suggestions</span>
                            <span class="autofill-hint"><kbd>Tab</kbd> complete · <kbd>↑↓</kbd> select</span>
                        </div>
                        <ul id="autofill" class="inline autofill-component">
                            {#each current_autofill_recs as rec, idx}
                                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                                <li
                                    class="autofill-text-rec"
                                    class:selected={idx === autofill_selected_index}
                                    onmouseenter={() => {
                                        autofill_selected_index = idx;
                                    }}
                                    onmousedown={(e) => {
                                        e.preventDefault();
                                        applyAutofillSelection(idx);
                                    }}
                                >
                                    <span class="autofill-cmd-name">
                                        <span class="autofill-match">{rec.matchPrefix}</span><span>{rec.rest}</span>
                                    </span>
                                    {#if rec.desc}
                                        <span class="autofill-desc">{rec.desc}</span>
                                    {/if}
                                </li>
                            {/each}
                        </ul>
                    </div>
                {/if}
            </div>
        </div>
    </div>

    <div id="screen-spacer"></div>
</div>

<style>
#main-terminal {
    padding: 0;
    margin: 0;
    width: 100%;
    min-height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    background-color: transparent;
    color: var(--mp-text, #2d2a2e);
    font-family: var(--mono-font, monospace) !important;
    font-size: 14px !important;
    line-height: 1.6;
    transition: background-color 0.18s ease, color 0.18s ease;
}

#screen-spacer {
    min-height: 2.5rem;
    width: 100%;
}

/* Intro / ASCII Cat */
#animation {
    margin: 0;
    padding: 0 0 0.35rem 0;
    color: var(--mp-text, #2d2a2e);
    font-family: var(--mono-font, monospace);
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    border-bottom: 1px dashed var(--mp-border);
}

/* Command History */
.history-list {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    padding-top: 0.2rem;
}

.history-entry {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
}

.input-row {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: 0.65rem;
    border: none;
    outline: none;
    color: var(--mp-orange, #fc9867);
}

.current-input-row {
    padding: 0.2rem 0;
}

.prefix {
    flex-shrink: 0;
    color: var(--mp-green, #a9dc76);
    font-weight: 600;
    user-select: none;
    line-height: 1.55;
}

.history-input {
    flex: 1;
    font-weight: 500;
    line-height: 1.55;
    word-break: break-all;
}

.history-text {
    margin: 0;
    padding: 0.25rem 0 0.25rem 0.85rem;
    border-left: 2px solid var(--mp-border-strong);
    color: var(--mp-text, #2d2a2e);
    font-family: var(--mono-font, monospace);
    line-height: 1.65;
    overflow-wrap: break-word;
    white-space: pre-wrap;
}

/* Input Area */
#input-container {
    visibility: hidden;
}

#secondary-input {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
}

#entry {
    display: flex;
    flex-direction: row;
    align-items: center;
    min-height: 1.55em;
    flex-wrap: nowrap;
}

#default-text {
    color: var(--mp-text-muted, #939293);
    user-select: none;
    font-style: italic;
    margin-right: 0.35rem;
}

.line {
    width: 0ch;
    border: none;
    outline: none;
    color: var(--mp-orange, #fc9867);
    font-weight: 500;
    background-color: transparent;
}

.inline {
    margin: 0;
    padding: 0;
}

#terminal-input {
    caret-color: transparent;
    font-family: var(--mono-font, monospace) !important;
    font-size: 14px !important;
    line-height: 1.55;
    margin: 0;
    padding: 0;
    background-color: transparent;
}

/* Cursor & Ghost Completion */
#cursor {
    width: 0.9ch;
    height: 1.15em;
    display: inline-block;
    background-color: var(--mp-text, #fcfcfa);
    vertical-align: middle;
    visibility: hidden;
    animation: cursorBlink 1s steps(2, start) infinite;
    border-radius: 1px;
}

#cursor.cursor-visible {
    visibility: visible;
}

@keyframes cursorBlink {
    0%, 49% { opacity: 1; }
    50%, 100% { opacity: 0; }
}

.ghost-completion {
    color: var(--mp-text-faint, #918889);
    user-select: none;
    pointer-events: none;
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
}

.ghost-tab-badge {
    font-size: 0.68rem;
    padding: 0.04rem 0.32rem;
    border-radius: 3px;
    border: 1px solid var(--mp-border);
    background-color: var(--mp-bg-subtle);
    color: var(--mp-text-muted);
    line-height: 1.3;
}

/* Autocomplete Popover */
.autofill-popover {
    margin-top: 0.45rem;
    max-width: 34rem;
    background-color: var(--mp-bg);
    border: 1px solid var(--mp-border-strong);
    border-radius: 6px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
    overflow: hidden;
}

.autofill-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.32rem 0.7rem;
    background-color: var(--mp-bg-subtle);
    border-bottom: 1px solid var(--mp-border);
    font-size: 0.72rem;
    color: var(--mp-text-muted);
    user-select: none;
}

.autofill-hint kbd {
    font-family: var(--mono-font, monospace);
    font-size: 0.68rem;
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    border: 1px solid var(--mp-border-strong);
    background-color: var(--mp-bg-elevated);
    color: var(--mp-text-body);
}

#autofill {
    display: flex;
    flex-direction: column;
    list-style-type: none;
    margin: 0;
    padding: 0.25rem;
    max-height: 13.5rem;
    overflow-y: auto;
}

.autofill-text-rec {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.34rem 0.6rem;
    border-radius: 4px;
    border-left: 3px solid transparent;
    color: var(--mp-text-body);
    cursor: pointer;
    transition: background-color 0.1s ease, border-color 0.1s ease;
}

.autofill-text-rec.selected {
    background-color: var(--mp-bg-subtle);
    border-left-color: var(--mp-orange);
}

.autofill-cmd-name {
    font-weight: 500;
    color: var(--mp-text);
    flex-shrink: 0;
}

.autofill-match {
    color: var(--mp-orange);
    font-weight: 700;
}

.autofill-desc {
    font-size: 0.76rem;
    color: var(--mp-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

/* Formatted Inline Spans */
:global(.fmt-code) {
    background-color: var(--mp-bg-subtle, #2d2a2e);
    color: var(--mp-red, #ff6188);
    border: 1px solid var(--mp-border);
    padding: 0.08rem 0.42rem;
    margin: 0 0.08rem;
    border-radius: 4px;
    font-weight: 500;
}

:global(.fmt-link) {
    color: var(--mp-purple, #ab9df2);
    text-decoration: underline;
    text-underline-offset: 3px;
}

:global(.fmt-link:hover) {
    color: var(--mp-red, #ff6188);
}

::selection {
    color: var(--mp-bg, #221f22);
    background-color: var(--mp-text, #fcfcfa);
}
</style>
