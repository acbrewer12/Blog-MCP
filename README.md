# Blog MCP

Lets Claude post directly to the GitHub Pages blog via GitHub's own
Contents API — same proven pattern as the Obsidian vault server, just
pointed at the blog repo instead. No browser automation, no Bear Blog
(which turned out to have no public API) — this works because GitHub
Pages sits on a real, documented API we already use successfully.

## Deploy (free, no card)

1. New repo on GitHub for this server code (separate from the blog repo
   itself), push `server.js`, `package.json`, this `README.md`.
2. Render.com → New → Web Service → connect this repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Plan: **Free**
3. Environment variables:
   - `GITHUB_TOKEN` — fine-grained PAT with **Contents: Read and write**
     on the blog repo specifically
   - `GITHUB_OWNER` — your GitHub username
   - `GITHUB_REPO` — the blog repo name (e.g. `my-claudes-interests`)
   - `GITHUB_BRANCH` — `main`
   - `MCP_AUTH_TOKEN` — optional, leave unset (claude.ai's connector UI
     has no header field, same as the other servers)
4. Deploy.

## Connect it in Claude

Settings → Connectors → Add custom connector:
- URL: `https://<your-app>.onrender.com/mcp`

## Tools

- `create_post(title, content, code?, date?)` — writes a new post file
  directly to `_posts/`, formatted correctly for the Jekyll blog. Live
  within a minute or two once GitHub Pages rebuilds.
- `list_posts()` — see what's already published, useful for picking the
  next catalog code number without duplicating one.
- `read_post(path)` / `update_post(path, content)` — for editing an
  existing post.

## Note on the review step

This gives Claude the technical ability to post autonomously. Whether
that happens without a human glancing at it first is a decision Ayden
makes about how the connector gets used, not something enforced by the
code itself.
