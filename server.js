import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN; // optional, see note in other servers

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.error("Missing required env vars: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO");
  process.exit(1);
}

const GH_API = "https://api.github.com";
const ghHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "blog-mcp",
};

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

async function ghFetch(url, opts = {}) {
  const res = await fetch(url, { headers: ghHeaders, ...opts });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}

async function getFileSha(path) {
  const res = await ghFetch(
    `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path)}?ref=${GITHUB_BRANCH}`
  );
  if (res.status === 404) return null;
  const data = await res.json();
  return data.sha || null;
}

async function listPosts() {
  const res = await ghFetch(
    `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/_posts?ref=${GITHUB_BRANCH}`
  );
  if (res.status === 404) return [];
  const data = await res.json();
  return (data || [])
    .filter((f) => f.name.endsWith(".md"))
    .map((f) => f.path)
    .sort()
    .reverse();
}

async function writeFile(path, content, message) {
  const sha = await getFileSha(path);
  const body = {
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await fetch(
    `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`,
    { method: "PUT", headers: { ...ghHeaders, "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} writing ${path}: ${errBody.slice(0, 300)}`);
  }
  return sha ? "updated" : "created";
}

async function readFile(path) {
  const res = await ghFetch(
    `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path)}?ref=${GITHUB_BRANCH}`
  );
  if (res.status === 404) throw new Error(`'${path}' not found`);
  const data = await res.json();
  return Buffer.from(data.content, data.encoding || "base64").toString("utf-8");
}

function buildServer() {
  const server = new McpServer({ name: "blog", version: "1.0.0" });

  server.tool(
    "create_post",
    "Publish a new blog post. Creates a properly formatted Jekyll post file directly in the blog's GitHub repo — GitHub Pages rebuilds and publishes it automatically, live within a minute or two.",
    {
      title: z.string().describe("Post title"),
      content: z.string().describe("Post body in Markdown. Do not include the frontmatter — that's generated automatically."),
      code: z.string().optional().describe("Catalog code, e.g. 'AST-002' (astronomy), 'MATH-001', 'BIO-001', 'CHEM-001', 'PHYS-001', 'AI-001', 'LING-001'. Matches the existing tag/prefix system — check existing posts with list_posts before picking a number to avoid duplicates."),
      date: z.string().optional().describe("YYYY-MM-DD. Defaults to today."),
    },
    async ({ title, content, code, date }) => {
      try {
        const day = date || new Date().toISOString().slice(0, 10);
        const slug = slugify(title);
        const path = `_posts/${day}-${slug}.md`;

        const frontmatter = [
          "---",
          "layout: post",
          `title: "${title.replace(/"/g, '\\"')}"`,
          `date: ${day}`,
          code ? `code: ${code}` : null,
          "---",
        ].filter(Boolean).join("\n");

        const fullContent = `${frontmatter}\n\n${content}\n`;
        const result = await writeFile(path, fullContent, `New post: ${title}`);

        return {
          content: [{ type: "text", text: `Post ${result}: ${path}\nWill be live at the blog's URL + /${day.replace(/-/g, "/")}/${slug}.html within a minute or two of GitHub Pages rebuilding.` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error creating post: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_posts",
    "List existing blog posts (filenames, newest first) — check this before picking a new catalog code to avoid duplicate numbers.",
    {},
    async () => {
      try {
        const posts = await listPosts();
        return { content: [{ type: "text", text: posts.length ? posts.join("\n") : "(no posts yet)" }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "read_post",
    "Read the full content of an existing post, e.g. to edit it.",
    { path: z.string().describe("Post path as returned by list_posts, e.g. '_posts/2026-08-18-title.md'") },
    async ({ path }) => {
      try {
        const content = await readFile(path);
        return { content: [{ type: "text", text: content }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "update_post",
    "Overwrite an existing post's full content (including frontmatter). Read it first with read_post, edit, then write back the complete file.",
    {
      path: z.string().describe("Post path as returned by list_posts"),
      content: z.string().describe("Complete new file content, including the --- frontmatter block"),
    },
    async ({ path, content }) => {
      try {
        const result = await writeFile(path, content, `Update post: ${path}`);
        return { content: [{ type: "text", text: `Post ${result}: ${path}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}

async function getLikes() {
  try {
    return JSON.parse(await readFile("_data/likes.json"));
  } catch {
    return {};
  }
}

async function incrementLikes(slug) {
  const likes = await getLikes();
  likes[slug] = (likes[slug] || 0) + 1;
  await writeFile("_data/likes.json", JSON.stringify(likes, null, 2), `Like: ${slug}`);
  return likes[slug];
}

const app = express();
app.use(express.json({ limit: "5mb" }));

// Public, unauthenticated REST endpoints for the blog's own like button —
// separate from /mcp, which is Claude's connector. CORS-open since the
// blog itself (a different origin, GitHub Pages) calls these from a
// visitor's browser.
app.use("/api", (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/api/likes/:slug", async (req, res) => {
  try {
    const likes = await getLikes();
    res.json({ slug: req.params.slug, count: likes[req.params.slug] || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/likes/:slug", async (req, res) => {
  try {
    const count = await incrementLikes(req.params.slug);
    res.json({ slug: req.params.slug, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (_req, res) => res.send("Blog MCP server is running."));

app.use((req, res, next) => {
  if (req.path === "/" || req.path.startsWith("/api/")) return next();
  if (AUTH_TOKEN) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${AUTH_TOKEN}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  next();
});

app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Blog MCP server listening on port ${PORT}`);
  console.log(`Repo: ${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH}`);
});
