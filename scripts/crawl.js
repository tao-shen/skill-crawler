#!/usr/bin/env node

/**
 * GitHub SKILL.md Crawler
 * Searches GitHub for all repositories containing SKILL.md files
 * and maintains a deduplicated index.
 */

const fs = require("fs");
const path = require("path");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DATA_FILE = path.join(__dirname, "..", "data", "skills.json");
const FEED_FILE = path.join(__dirname, "..", "feed.xml");

const SEARCH_QUERIES = [
  "filename:SKILL.md path:.claude/skills",
  "filename:SKILL.md path:skills",
  "filename:SKILL.md path:.cursor/skills",
  "filename:SKILL.md path:.codex/skills",
  'filename:SKILL.md "trigger when"',
  'filename:SKILL.md "## Instructions"',
];

const HEADERS = {
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "skill-crawler",
};
if (GITHUB_TOKEN) {
  HEADERS["Authorization"] = `Bearer ${GITHUB_TOKEN}`;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function searchGitHub(query, page = 1) {
  const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=100&page=${page}`;
  const res = await fetch(url, { headers: HEADERS });

  if (res.status === 403 || res.status === 429) {
    console.log(`  Rate limited, waiting 60s...`);
    await sleep(60000);
    return searchGitHub(query, page);
  }

  if (!res.ok) {
    console.error(`  GitHub API error: ${res.status} ${res.statusText}`);
    return { items: [], total_count: 0 };
  }

  return res.json();
}

function extractSkillInfo(item) {
  const repo = item.repository;
  return {
    id: `${repo.full_name}:${item.path}`,
    repo: repo.full_name,
    repo_url: repo.html_url,
    path: item.path,
    file_url: item.html_url,
    name: extractSkillName(item.path, repo.full_name),
    owner: repo.owner.login,
    description: repo.description || "",
    stars: repo.stargazers_count || 0,
    discovered_at: new Date().toISOString(),
  };
}

function extractSkillName(filePath, repoName) {
  // Try to extract skill name from path like skills/my-skill/SKILL.md
  const parts = filePath.split("/");
  const skillIdx = parts.indexOf("SKILL.md");
  if (skillIdx > 0) {
    return parts[skillIdx - 1];
  }
  // Fallback to repo name
  return repoName.split("/").pop();
}

function loadExisting() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return { last_updated: "", total_count: 0, skills: [] };
  }
}

function generateRSS(data) {
  const items = data.skills
    .sort((a, b) => new Date(b.discovered_at) - new Date(a.discovered_at))
    .slice(0, 50)
    .map(
      (s) => `    <item>
      <title>${escapeXml(s.name)} (${escapeXml(s.repo)})</title>
      <link>${escapeXml(s.file_url)}</link>
      <guid>${escapeXml(s.id)}</guid>
      <description>${escapeXml(s.description || `Skill from ${s.repo}`)}</description>
      <pubDate>${new Date(s.discovered_at).toUTCString()}</pubDate>
    </item>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Skill Crawler - New GitHub Skills</title>
    <link>https://github.com/tao-shen/skill-crawler</link>
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
    .replace(/"/g, "&quot;");
}

async function main() {
  console.log("=== Skill Crawler ===");
  console.log(`Time: ${new Date().toISOString()}`);

  const existing = loadExisting();
  const existingIds = new Set(existing.skills.map((s) => s.id));
  let newSkills = [];

  for (const query of SEARCH_QUERIES) {
    console.log(`\nSearching: ${query}`);

    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const result = await searchGitHub(query, page);
      console.log(
        `  Page ${page}: ${result.items?.length || 0} results (total: ${result.total_count})`
      );

      if (!result.items || result.items.length === 0) break;

      for (const item of result.items) {
        const skill = extractSkillInfo(item);
        if (!existingIds.has(skill.id)) {
          existingIds.add(skill.id);
          newSkills.push(skill);
        }
      }

      // GitHub search API returns max 1000 results, 100 per page
      hasMore = result.items.length === 100 && page < 10;
      page++;

      // Respect rate limits
      await sleep(2000);
    }

    // Wait between different queries to avoid rate limits
    await sleep(5000);
  }

  // Merge and save
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

  // Generate RSS feed
  fs.writeFileSync(FEED_FILE, generateRSS(data));
  console.log(`RSS feed updated.`);
}

main().catch(console.error);
