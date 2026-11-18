# MCP Servers

The repo ships a project-scoped [MCP](https://modelcontextprotocol.io) server in **`.mcp.json`** (repo root). MCP clients such as Claude Code pick this file up automatically and ask for a one-time approval the first time you open a session in the repo. Driving a real browser is not an MCP server here but a pinned CLI: see [Browser automation](./browser-automation.md).

## `Astro Docs`

The official Astro documentation MCP server (`https://mcp.docs.astro.build/mcp`, an HTTP server, no local process). It gives the agent searchable access to current Astro docs, so answers about routing, integrations, `astro:env`, view transitions, and adapter behavior match the framework rather than stale training data.

Any server added here that runs through `npx` gets an exact version, never `@latest`: `npx -y` runs outside the lockfile, on the machine that holds the local `.env`, so an unpinned tag would run whatever was published last, unreviewed. Pick a release that is at least a week old (`npm view <package> time`); fresh publishes are when a hijacked package is most likely to slip through.

## Example prompts

- "Check the Astro docs for how injectRoute registers on-demand routes"
- "What do the Astro docs say about route caching with the Cloudflare adapter?"
