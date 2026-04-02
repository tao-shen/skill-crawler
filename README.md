# Skill Crawler

Automatically crawls GitHub every 5 minutes to discover all open-source `SKILL.md` files (Claude Code skills, Cursor skills, Codex skills, etc.).

## Features

- **Auto crawl** via GitHub Actions (every 5 min)
- **Web dashboard** showing total skill count + searchable list
- **RSS feed** for subscribing to new skill discoveries
- **Deduplication** — only new skills get added

## How it works

1. GitHub Actions triggers `scripts/crawl.js` on a cron schedule
2. The crawler searches GitHub Code Search API with multiple queries targeting `SKILL.md` files
3. Results are deduplicated and merged into `data/skills.json`
4. An RSS feed (`feed.xml`) is generated
5. The dashboard (`index.html`) is deployed to GitHub Pages

## Local usage

```bash
# Set your GitHub token for higher rate limits
export GITHUB_TOKEN=ghp_xxx

# Run the crawler
npm run crawl

# Preview the dashboard
npm run serve
```

## Dashboard

Visit: https://tao-shen.github.io/skill-crawler/

## Subscribe

RSS: https://tao-shen.github.io/skill-crawler/feed.xml
