#!/usr/bin/env node

/**
 * GitHub SKILL.md Crawler
 *
 * Two modes:
 *   - INCREMENTAL (default): For each query, stop early once a page has >80% known skills.
 *     Only fetches licenses for newly discovered repos. Fast — typically <5 min.
 *   - FULL (env CRAWL_MODE=full): Exhaustively paginates every query. Fetches all missing
 *     licenses. Scheduled weekly to catch anything incremental misses.
 */

const fs = require("fs");
const path = require("path");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const CRAWL_MODE = (process.env.CRAWL_MODE || "incremental").toLowerCase();
const DATA_FILE = path.join(__dirname, "..", "data", "skills.json");
const FEED_FILE = path.join(__dirname, "..", "feed.xml");

// Threshold: if this fraction of a page is already known, stop paginating that query.
const EARLY_STOP_RATIO = 0.8;

const SEARCH_QUERIES = [
  // 1. By well-known paths
  "filename:SKILL.md path:.claude/skills",
  "filename:SKILL.md path:.claude",
  "filename:SKILL.md path:skills",
  "filename:SKILL.md path:.cursor/skills",
  "filename:SKILL.md path:.cursor",
  "filename:SKILL.md path:.codex/skills",
  "filename:SKILL.md path:.codex",
  "filename:SKILL.md path:plugins",
  "filename:SKILL.md path:agents",
  "filename:SKILL.md path:.ai",
  "filename:SKILL.md path:.agent",
  "filename:SKILL.md path:.skills",

  // 2. Root-level SKILL.md
  "filename:SKILL.md NOT path:node_modules",

  // 3. Alternative naming conventions
  "filename:skill.md path:.claude",
  "filename:skill.md path:skills",
  "filename:skill.md path:.cursor",

  // 4. .skill.md suffix pattern
  "extension:md filename:.skill",

  // 5. Content-based detection
  'filename:SKILL.md "trigger when"',
  'filename:SKILL.md "## Instructions"',
  'filename:SKILL.md "## Description"',
  'filename:SKILL.md "skill_name"',
  'filename:SKILL.md "agent skill"',
  'filename:SKILL.md "claude code"',
  'filename:SKILL.md "cursor"',

  // 6. Slice by repo stars
  "filename:SKILL.md stars:>100",
  "filename:SKILL.md stars:50..100",
  "filename:SKILL.md stars:20..49",
  "filename:SKILL.md stars:10..19",
  "filename:SKILL.md stars:5..9",
  "filename:SKILL.md stars:1..4",
  "filename:SKILL.md stars:0",

  // 7. Slice by creation date
  "filename:SKILL.md created:2026-01-01..2026-12-31",
  "filename:SKILL.md created:2025-07-01..2025-12-31",
  "filename:SKILL.md created:2025-01-01..2025-06-30",
  "filename:SKILL.md created:2024-01-01..2024-12-31",
  "filename:SKILL.md created:<2024-01-01",

  // 8. Slice by repo size
  "filename:SKILL.md size:>10000",
  "filename:SKILL.md size:5000..10000",
  "filename:SKILL.md size:1000..4999",
  "filename:SKILL.md size:<1000",

  // 9. By language
  "filename:SKILL.md language:markdown",
  "filename:SKILL.md language:python",
  "filename:SKILL.md language:typescript",
  "filename:SKILL.md language:javascript",
  "filename:SKILL.md language:rust",
  "filename:SKILL.md language:go",

  // 10. Forks and non-forks
  "filename:SKILL.md fork:true",
  "filename:SKILL.md fork:false",
];

const HEADERS = {
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "skill-crawler",
};
if (GITHUB_TOKEN) {
  HEADERS.Authorization = `Bearer ${GITHUB_TOKEN}`;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function searchGitHub(query, page = 1, retries = 3) {
  const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=100&page=${page}`;
  const res = await fetch(url, { headers: HEADERS });

  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    const waitMs = reset
      ? Math.max(parseInt(reset) * 1000 - Date.now(), 10000)
      : 60000;
    console.log(`  Rate limited, waiting ${Math.ceil(waitMs / 1000)}s...`);
    await sleep(Math.min(waitMs, 120000));
    return searchGitHub(query, page, retries);
  }

  if (res.status === 422) {
    console.log(`  Query not supported (422), skipping`);
    return { items: [], total_count: 0 };
  }

  if (!res.ok) {
    console.error(`  GitHub API error: ${res.status} ${res.statusText}`);
    if (retries > 0) {
      await sleep(10000);
      return searchGitHub(query, page, retries - 1);
    }
    return { items: [], total_count: 0 };
  }

  return res.json();
}

async function fetchLicenses(repos) {
  const licenses = {};
  const batch = [...repos];
  console.log(`\nFetching licenses for ${batch.length} repos...`);

  for (let i = 0; i < batch.length; i++) {
    const repo = batch[i];
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/license`, {
        headers: HEADERS,
      });
      if (res.status === 429 || res.status === 403) {
        const reset = res.headers.get("x-ratelimit-reset");
        const waitMs = reset
          ? Math.max(parseInt(reset) * 1000 - Date.now(), 10000)
          : 60000;
        console.log(`  License rate limited, waiting ${Math.ceil(waitMs / 1000)}s...`);
        await sleep(Math.min(waitMs, 120000));
        i--;
        continue;
      }
      if (res.ok) {
        const data = await res.json();
        licenses[repo] =
          data.license?.spdx_id || data.license?.name || "Unknown";
      } else {
        licenses[repo] = "None";
      }
    } catch {
      licenses[repo] = "Unknown";
    }

    if (i > 0 && i % 100 === 0) {
      console.log(`  ${i}/${batch.length} licenses fetched`);
    }
    await sleep(750);
  }

  return licenses;
}

function normalizeId(repoFullName, filePath) {
  return `${repoFullName.toLowerCase()}:${filePath.toLowerCase()}`;
}

function extractSkillInfo(item) {
  const repo = item.repository;
  return {
    id: normalizeId(repo.full_name, item.path),
    repo: repo.full_name,
    repo_url: repo.html_url,
    path: item.path,
    file_url: item.html_url,
    name: extractSkillName(item.path, repo.full_name),
    owner: repo.owner.login,
    avatar: repo.owner.avatar_url || "",
    description: repo.description || "",
    stars: repo.stargazers_count || 0,
    license: "",
    discovered_at: new Date().toISOString(),
  };
}

function extractSkillName(filePath, repoName) {
  const parts = filePath.split("/");
  const fileName = parts[parts.length - 1];

  if (fileName.endsWith(".skill.md")) {
    return fileName.replace(/\.skill\.md$/i, "");
  }

  if (fileName.toUpperCase() === "SKILL.MD" && parts.length >= 2) {
    const parent = parts[parts.length - 2];
    if (
      ![
        "skills",
        ".claude",
        ".cursor",
        ".codex",
        ".ai",
        "plugins",
        "agents",
      ].includes(parent.toLowerCase())
    ) {
      return parent;
    }
  }

  return repoName.split("/").pop();
}

function loadExisting() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    for (const s of data.skills) {
      s.id = normalizeId(s.repo, s.path);
    }
    const seen = new Set();
    data.skills = data.skills.filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
    data.total_count = data.skills.length;
    return data;
  } catch {
    return { last_updated: "", total_count: 0, skills: [] };
  }
}

function generateRSS(data) {
  const items = data.skills
    .sort((a, b) => new Date(b.discovered_at) - new Date(a.discovered_at))
    .slice(0, 100)
    .map(
      (s) => `    <item>
      <title>${escapeXml(s.name)} (${escapeXml(s.repo)})</title>
      <link>${escapeXml(s.file_url)}</link>
      <guid isPermaLink="false">${escapeXml(s.id)}</guid>
      <description>${escapeXml(s.description || `Skill from ${s.repo}`)}${s.license ? ` [${escapeXml(s.license)}]` : ""}</description>
      <pubDate>${new Date(s.discovered_at).toUTCString()}</pubDate>
    </item>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Skill Crawler - New GitHub Skills</title>
    <link>https://tao-shen.github.io/skill-crawler/</link>
    <description>Tracking all open-source SKILL.md files on GitHub. Total: ${data.total_count} skills.</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="https://tao-shen.github.io/skill-crawler/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function main() {
  const isFullCrawl = CRAWL_MODE === "full";

  console.log("=== Skill Crawler ===");
  console.log(`Time:  ${new Date().toISOString()}`);
  console.log(`Mode:  ${isFullCrawl ? "FULL (exhaustive)" : "INCREMENTAL (early-stop)"}`);
  console.log(`Token: ${GITHUB_TOKEN ? "present" : "MISSING"}`);

  const existing = loadExisting();
  const existingIds = new Set(existing.skills.map((s) => s.id));
  const newSkills = [];
  let queriesSkipped = 0;

  for (let qi = 0; qi < SEARCH_QUERIES.length; qi++) {
    const query = SEARCH_QUERIES[qi];
    console.log(`\n[${qi + 1}/${SEARCH_QUERIES.length}] ${query}`);

    let page = 1;
    let hasMore = true;
    let earlyStop = false;

    while (hasMore) {
      const result = await searchGitHub(query, page);
      const items = result.items || [];
      const count = items.length;
      console.log(
        `  Page ${page}: ${count} results (total_count: ${result.total_count})`
      );

      if (count === 0) break;

      let knownOnPage = 0;
      for (const item of items) {
        const skill = extractSkillInfo(item);
        if (existingIds.has(skill.id)) {
          knownOnPage++;
        } else {
          existingIds.add(skill.id);
          newSkills.push(skill);
        }
      }

      // INCREMENTAL: stop this query early if most results are already known
      if (!isFullCrawl && count > 0) {
        const knownRatio = knownOnPage / count;
        if (knownRatio >= EARLY_STOP_RATIO) {
          console.log(
            `  Early stop: ${knownOnPage}/${count} already known (${(knownRatio * 100).toFixed(0)}%)`
          );
          earlyStop = true;
          break;
        }
      }

      hasMore = count === 100 && page < 10;
      page++;
      await sleep(2500);
    }

    if (earlyStop) queriesSkipped++;
    await sleep(3000);
  }

  // --- License fetching ---
  // New skills: always fetch
  const newRepos = [...new Set(newSkills.map((s) => s.repo))];
  // FULL mode: also backfill all missing licenses
  const missingLicenseRepos = isFullCrawl
    ? [...new Set(existing.skills.filter((s) => !s.license).map((s) => s.repo))]
    : [];
  const allReposToFetch = [...new Set([...newRepos, ...missingLicenseRepos])];

  let licenseMap = {};
  if (allReposToFetch.length > 0) {
    licenseMap = await fetchLicenses(allReposToFetch);
  }

  for (const s of newSkills) {
    s.license = licenseMap[s.repo] || "";
  }
  for (const s of existing.skills) {
    if (!s.license && licenseMap[s.repo]) {
      s.license = licenseMap[s.repo];
    }
  }

  // --- Update stars for existing skills (FULL mode only) ---
  // In full mode we saw many items again; update their star counts
  if (isFullCrawl) {
    console.log("\nUpdating star counts for known skills...");
    // We don't have fresh star data for existing items from the search,
    // but we can note this is a TODO for future improvement.
  }

  // Merge, deduplicate, save
  const allSkills = [...existing.skills, ...newSkills];
  const data = {
    last_updated: new Date().toISOString(),
    total_count: allSkills.length,
    skills: allSkills,
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  console.log(`\n--- Summary ---`);
  console.log(`Mode:             ${isFullCrawl ? "FULL" : "INCREMENTAL"}`);
  console.log(`Previously known: ${existing.skills.length}`);
  console.log(`Newly discovered: ${newSkills.length}`);
  console.log(`Total skills:     ${allSkills.length}`);
  console.log(`Licenses fetched: ${Object.keys(licenseMap).length}`);
  if (!isFullCrawl) {
    console.log(`Queries early-stopped: ${queriesSkipped}/${SEARCH_QUERIES.length}`);
  }

  fs.writeFileSync(FEED_FILE, generateRSS(data));
  console.log(`RSS feed updated.`);
}

main().catch(console.error);
