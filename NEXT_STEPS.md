# Next steps

Where Observer stands, how to try it locally, what to tell me, how to deploy, and what comes after. Read `PLAN.md` for the product plan, `OPERATIONS.md` for hosting, secrets, and credits, and `AGENTS.md` for the actions the agent can call.

## Where things stand (2026-10-07)

**Built and merged to `main`:** hosting and CI config; seven source types (Hacker News, Lobsters, dev.to, GitHub popular new repos, Product Hunt, subreddits via RSS, any RSS/Atom feed) plus OPML import; fetching with an SSRF-guarded fetch layer; article text extraction with honest `ok | paywalled | failed` states; cited summaries; relevance and importance scores with reasons; clustering of the same story across sources; a compact ranked feed; like, skip, save, and a Saved view; an editable interest profile with re-scoring; exploration slots; source trust learned from feedback; source health checks; a daily update automation. About 200 automated tests, typecheck, and `agent-native:doctor` all pass.

**Not yet verified, because nothing has run for real yet:**
- **A real model driving the skills** (`summary-style`, `score-reason`, `interests`) through the Update feed button.
- **How the screens look and feel in a browser.** I can only test structure and logic, not layout, spacing, dark mode, or phone widths.
- **Netlify.** Deploys are paused to save credits, so nothing since the first setup is deployed. The scheduler firing the daily update, and how long a run can last there, are unknown.

Trying it locally answers the first two. One deploy answers the third.

## Try it locally

```bash
git checkout main && git pull
pnpm install
pnpm dev            # opens http://localhost:8080
```

- Sign in with **Continue as local dev**, then connect an LLM when asked (Builder.io, as you did before).
- Local data lives in `data/pglite` and never touches Supabase. To start fresh, stop the server and delete that folder.
- **Run only one dev server at a time.** A second one can't open the same database and, on exit, removes the file that lets terminal commands (`pnpm action ...`) find your server. If those commands complain, restart `pnpm dev`.
- Schedules don't fire locally. To try the daily update anyway, start with `AGENT_NATIVE_ENABLE_LOCAL_RECURRING_JOBS=1 pnpm dev`; the **Update feed** button does the same work on demand.

### A first session (about 15 minutes)

1. **Sources.** Add Hacker News (it is the only source with real points, which importance and exploration depend on), Lobsters, `r/programming`, and one or two RSS feeds you actually read. Optionally import an OPML file. Click **Fetch now** on each: you should see counts like "Fetched 25 items (25 new)", and a second click should show 0 new.
2. **Feed → Update feed.** The agent sidebar opens and works through fetch, article text, summaries, and scores. Watch the tool calls. It processes up to 15 items per step, so a first run on many sources will not finish everything: use **Finish N waiting items** to continue.
3. **Read the feed.** Hover the relevance number for the reason. Click `summary` to see the summary, "Why this score", and citation count. Check that a story on several sources is one row with "also on". Skim a few summaries against their articles: is anything claimed that the article doesn't say?
4. **Feedback.** Try like, skip, save. A skipped row collapses with an undo; Saved is its own tab. Open a few articles from the title.
5. **Interests.** Open **Interests**, edit the text, and save; the page says how many recent items will be re-scored. Then use **Ask the agent to change it** with something like "more edge rendering, less crypto" and check that the rewrite keeps your wording and only changes what you asked. Run **Update feed** again and see whether the scores move.
6. **Daily update.** On the Feed, turn it on and pick an hour. It will say "Hasn't run yet" until it runs somewhere that runs schedules.
7. **Sources again.** Look for `trust` chips after some feedback, and try **Check health** (a source you break on purpose, like a bad feed URL, should show `failing` after a few fetches).

### Keep an eye on

- **Cost.** **Update feed** spends model credits. Ask the agent for smaller sources while testing ("add Hacker News with a limit of 10").
- **Backlog.** Product Hunt and big OPML imports bring in many items; the agent processes 15 per step, newest first, so older ones wait.
- **Exploration picks** (the "outside your usual interests" tag) only appear with Hacker News items, since only they have measured buzz.

## What to tell me

For anything that feels wrong, the most useful report is: what you did, what you expected, what you saw, and a screenshot for anything visual. Especially:

- Layout problems (spacing, dark mode, narrow windows, the add-source form, the feed row's meta line).
- Summaries that claim things the article doesn't, or scores whose reason doesn't match the item.
- Sources that fail or look wrong, and what error the row shows.
- The agent doing something surprising in the sidebar, or a step that takes too long.
- Anything you wanted to do and couldn't.

## Deploying to Netlify

Do this once you are happy locally and want to spend the credits. `scripts/netlify-ignore.sh` skips builds that can't change the app, and deploy previews are off.

1. **Resume deploys** in Netlify. The first build after the pause will build everything.
2. **Confirm the environment variables** (see `OPERATIONS.md`): `DATABASE_URL` (Supabase transaction pooler), `MIGRATION_DATABASE_URL` (session pooler, Production only), and `BETTER_AUTH_SECRET`. The LLM comes from Builder after sign-in, so no provider key is needed.
3. **Watch the build log.** The migration step at the end applies every pending migration (the framework's, plus the app's versions 1 to 12). If it fails, the old version stays live. Don't paste secrets.
4. **Check Supabase → Table Editor** for the app tables (`sources`, `items`, `summaries`, `scores`, `feedback`, `clusters`, and the rest) and `observer_migrations`. The Data API is intentionally off; see `OPERATIONS.md`.
5. **Smoke test the live site:** sign up, connect Builder, add a source, click **Update feed**.
6. **Test the schedule:** turn on the daily update for an hour a few minutes ahead, then check the Feed's "Last run" line and Netlify's function logs. Record how long the run took and whether it hit a time limit, then put the answer in `PLAN.md` (Phase 1 asks for it).
7. **Watch credits** on Netlify's Usage page. The framework's scheduler function wakes about once a minute; `AGENT_NATIVE_DISABLE_RECURRING_JOBS=1` in the build environment turns it off at the cost of the daily update not firing.

## Known issues and limits

- **SSRF guard over-blocks `192.0.0.0/16`**, which wrongly includes public WordPress.com VIP sites (for example `github.blog`). Those feeds fail with a "network safety check" message. Accepted for now; see `OPERATIONS.md`.
- **Reddit has no scores.** Its JSON API needs OAuth, so subreddits use public RSS. They still cluster with other sources through the article link.
- **GitHub "trending" is popular new repositories** (created this week, most starred), because GitHub has no official trending API.
- **Hacker News Ask HN and Show HN posts** with no article show as "article couldn't be read"; their own text isn't ingested. JavaScript-rendered pages return no text, and a few pages glue words together where the site uses styled inline elements.
- **Clustering matches the same URL only.** The same story at different URLs (a syndicated copy, a different outlet) isn't merged. If a cluster's canonical item sits in a disabled source, its entry is hidden.
- **No comment synthesis** (deferred by decision; the design to use if revisited is in `PLAN.md`).
- **Unauthenticated GitHub search is limited to 10 requests a minute.**

## Small cleanups

- Remove the template's sample `actions/hello.ts` (the plan says to once real actions exist).
- Consider a pre-commit secret scan locally (`gitleaks`); CI already scans every PR.

## What comes next

Decided so far (2026-10-08): **Phase 3b comes first, then teams.** No email or Slack digests, ever for now: Observer is a place you visit.

- **Phase 3b: source modes and discovery (next).** Trusted-only, autonomous, and hybrid modes; `discover-sources`, `evaluate-source`, `review-candidate`; a review queue and "Discovered" badges. This is where the agent first proposes new sources, and where the auto-disable rule for unhealthy discovered sources starts to matter.
- **Teams (after 3b).** One shared feed for a team: shared sources and **one shared team interest profile**, articles processed once for everyone, and personal read, like, skip, and save state. No per-person scoring, and no curation features in the first version. See Phase 5 in `PLAN.md`.
- **Phase 3c: advanced connectors.** An MCP connector (approved servers, read-only tools) and a guarded scraper. The riskiest security surface, so it comes after the rest has been exercised.
- **Phase 4: agent chat and alerts.** The agent knows the selected item ("summarize the comments on this", "more like this"), natural-language questions over the archive, and topic watches with in-app alerts.
- **Agent access** (MCP/A2A so other agents can query Observer) and optional public RSS stay at the end.

Questions worth answering from real use before choosing: Is the feed what you wanted to read? Do the relevance scores feel right, and do the reasons convince you? Is 15 items per step too few or too many? Which sources earn their place? Do you want discovery, or is a hand-picked list enough?
