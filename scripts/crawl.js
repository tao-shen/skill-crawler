#!/usr/bin/env node

/**
 * GitHub SKILL.md Crawler
 * Exhaustively searches GitHub for all repositories containing SKILL.md files.
 * Fetches license info, deduplicates by normalized repo+path, and maintains an index.
 */

const fs = require("fs");
const path = require("path");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DATA_FILE = path.join(__dirname, "..", "data", "skills.json");
const FEED_FILE = path.join(__dirname, "..", "feed.xml");

// --- Exhaustive search queries ---
// GitHub code search caps at 1000 results per query, so we slice by multiple axes
// to maximize coverage: path, filename pattern, content keywords, language, stars, size, date ranges.
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

  // 2. Root-level SKILL.md (no path qualifier = broader match)
  "filename:SKILL.md NOT path:node_modules",

  // 3. Alternative naming conventions
  "filename:skill.md path:.claude",
  "filename:skill.md path:skills",
  "filename:skill.md path:.cursor",

  // 4. .skill.md suffix pattern (e.g. my-tool.skill.md)
  "extension:md filename:.skill",

  // 5. Content-based detection (catches non-standard paths)
  'filename:SKILL.md "trigger when"',
  'filename:SKILL.md "## Instructions"',
  'filename:SKILL.md "## Description"',
  'filename:SKILL.md "skill_name"',
  'filename:SKILL.md "agent skill"',
  'filename:SKILL.md "claude code"',
  'filename:SKILL.md "cursor"',

  // 6. Slice by repo stars to get past 1000-result cap
  "filename:SKILL.md stars:>100",
  "filename:SKILL.md stars:50..100",
  "filename:SKILL.md stars:20..49",
  "filename:SKILL.md stars:10..19",
  "filename:SKILL.md stars:5..9",
  "filename:SKILL.md stars:1..4",
  "filename:SKILL.md stars:0",

  // 7. Slice by creation date ranges (2024-2026) to get past caps
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

  // 9. By language to diversify results
  "filename:SKILL.md language:markdown",
  "filename:SKILL.md language:python",
  "filename:SKILL.md language:typescript",
  "filename:SKILL.md language:javascript",
  "filename:SKILL.md language:rust",
  "filename:SKILL.md language:go",

  // 10. Forks and non-forks separately
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
      ? Math.max((parseInt(reset) * 1000 - Date.now()), 10000)
      : 60000;
    console.log(`  Rate limited, waiting ${Math.ceil(waitMs / 1000)}s...`);
    await sleep(Math.min(waitMs, 120000));
    return searchGitHub(query, page, retries);
  }

  if (res.status === 422) {
    // Validation error — query not supported, skip
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

// Batch-fetch license info for repos we haven't fetched yet
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
          ? Math.max((parseInt(reset) * 1000 - Date.now()), 10000)
          : 60000;
        console.log(`  License rate limited, waiting ${Math.ceil(waitMs / 1000)}s...`);
        await sleep(Math.min(waitMs, 120000));
        i--; // retry this one
        continue;
      }
      if (res.ok) {
        const data = await res.json();
        licenses[repo] = data.license?.spdx_id || data.license?.name || "Unknown";
      } else {
        licenses[repo] = "None";
      }
    } catch {
      licenses[repo] = "Unknown";
    }

    if (i > 0 && i % 50 === 0) {
      console.log(`  ${i}/${batch.length} licenses fetched`);
    }
    // Core API rate: 5000/hr with token ≈ 1.4/s
    await sleep(750);
  }

  return licenses;
}

function normalizeId(repoFullName, filePath) {
  // Normalize to lowercase for dedup
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
    license: "", // filled later
    discovered_at: new Date().toISOString(),
  };
}

function extractSkillName(filePath, repoName) {
  const parts = filePath.split("/");

  // Handle .skill.md pattern: e.g. my-tool.skill.md → my-tool
  const fileName = parts[parts.length - 1];
  if (fileName.endsWith(".skill.md")) {
    return fileName.replace(/\.skill\.md$/i, "");
  }

  // Handle SKILL.md in a directory: skills/my-skill/SKILL.md → my-skill
  if (fileName.toUpperCase() === "SKILL.MD" && parts.length >= 2) {
    const parent = parts[parts.length - 2];
    // Skip generic parent dirs
    if (!["skills", ".claude", ".cursor", ".codex", ".ai", "plugins", "agents"].includes(parent.toLowerCase())) {
      return parent;
    }
  }

  // Fallback: repo name
  return repoName.split("/").pop();
}

function loadExisting() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    // Re-normalize all existing IDs for dedup consistency
    for (const s of data.skills) {
      s.id = normalizeId(s.repo, s.path);
    }
    // Deduplicate existing data
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
  console.log("=== Skill Crawler ===");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Token: ${GITHUB_TOKEN ? "present" : "MISSING — rate limits will be very low!"}`);

  const existing = loadExisting();
  const existingIds = new Set(existing.skills.map((s) => s.id));
  const newSkills = [];

  for (let qi = 0; qi < SEARCH_QUERIES.length; qi++) {
    const query = SEARCH_QUERIES[qi];
    console.log(`\n[${qi + 1}/${SEARCH_QUERIES.length}] ${query}`);

    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const result = await searchGitHub(query, page);
      const count = result.items?.length || 0;
      console.log(`  Page ${page}: ${count} results (total_count: ${result.total_count})`);

      if (!result.items || count === 0) break;

      for (const item of result.items) {
        const skill = extractSkillInfo(item);
        if (!existingIds.has(skill.id)) {
          existingIds.add(skill.id);
          newSkills.push(skill);
        }
      }

      // GitHub caps at 1000 results (10 pages × 100)
      hasMore = count === 100 && page < 10;
      page++;
      await sleep(2500);
    }

    await sleep(3000);
  }

  // Fetch licenses for repos of new skills
  const newRepos = [...new Set(newSkills.map((s) => s.repo))];
  // Also fetch for existing skills missing license
  const missingLicenseRepos = [
    ...new Set(existing.skills.filter((s) => !s.license).map((s) => s.repo)),
  ];
  const allReposToFetch = [...new Set([...newRepos, ...missingLicenseRepos])];

  let licenseMap = {};
  if (allReposToFetch.length > 0) {
    licenseMap = await fetchLicenses(allReposToFetch);
  }

  // Apply licenses to new skills
  for (const s of newSkills) {
    s.license = licenseMap[s.repo] || "";
  }
  // Backfill licenses for existing skills
  for (const s of existing.skills) {
    if (!s.license && licenseMap[s.repo]) {
      s.license = licenseMap[s.repo];
    }
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
  console.log(`Previously known: ${existing.skills.length}`);
  console.log(`Newly discovered: ${newSkills.length}`);
  console.log(`Total skills:     ${allSkills.length}`);
  console.log(`Licenses fetched: ${Object.keys(licenseMap).length}`);

  // Generate RSS feed
  fs.writeFileSync(FEED_FILE, generateRSS(data));
  console.log(`RSS feed updated.`);
}

main().catch(console.error);
