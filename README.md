# peckhamr.com

Personal portfolio site made by me. Built with [SvelteKit](https://kit.svelte.dev/) and statically generated to plain HTML/CSS/JS via `@sveltejs/adapter-static`.

## Tech Stack

- SvelteKit: file-based routing, layout composition, and static prerendering (`+layout.js` sets `trailingSlash: 'always'`; each route exports `prerender = true`).
- Svelte 5: reactivity through `$state` runes; component composition via `{#snippet}` blocks and `{@render}`.
- Vite 7: dev server and production bundler (`vite.config.ts` loads the `sveltekit()` plugin).
- DOMPurify: sanitises all user-generated HTML before rendering to prevent XSS in terminal output.

## Project Structure

```
src/
  app.html                  # shell HTML
  Terminal.svelte           # self-contained terminal component (commands, autocomplete, history)
  routes/
    +layout.svelte          # global styles (monospace, dark background)
    +page.svelte            # home page, equivalent to index.html. includes embedded Terminal component
    terminal/
      +page.svelte          # full-screen terminal page
static/
  vocab/                    # Chinese study CSVs, might be used for a future addition
  ryan_peckham_resume.pdf   # resume PDF served at /ryan_peckham_resume.pdf
```

## How It Works

The home page (`+page.svelte`) is a single-column layout with a bio section, social links, project cards, and a `<Terminal />` component rendered inside a collapsible `<details>` wrapper. The terminal route (`/terminal`) renders the same `<Terminal />` component at full viewport size.

`Terminal.svelte` is the core of the site. On mount it typewrites a random ASCII cat, because I love cats, and a short intro message into a `<pre>` element using a character-by-character `setInterval` loop. Input is captured via a hidden `<input>` element; a blinking CSS cursor sits beside it. Commands are dispatched from a `commands` object that maps names to `Command` instances, each holding a `func` that returns a raw HTML string (sanitised through `DOMPurify`). Autocomplete suggestions are filtered against command names or per-command recommendation pools and rendered as a floating `<ul>` below the input. Command history is stored in a `$state` array and replayed above the current input line (a rune is used for instant and automatic updates of HTML content). Output is rendered as raw HTML (`{@html}`) after sanitisation, allowing inline `<span>` formatting, links, and `<code>` badges.

Because the static adapter writes every prerendered route to `dist/`, the site can be served from any static host (GitHub Pages, Nginx, etc.) with no server-side runtime. In my case, I registered the domain from Porkbun and am hosting it through DigitalOcean using simple DNS record swapping.

## Development

```bash
npm install
npm run dev      # start dev server on localhost:8080

npm run build    # output to dist/, read and updated by DigitalOcean on commit push
npm run check    # type-check via svelte-check
```

## License

Private. Not publicly licensed.
