import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HealthStats } from "../health.js";

const dir = mkdtempSync(join(tmpdir(), "observer-health-"));
process.env.DATABASE_URL = `pglite:${join(dir, "db")}`;

const { runMigrations, closeDbExec } = await import("@agent-native/core/db");
const { APP_MIGRATIONS, APP_MIGRATIONS_TABLE } = await import("../../db/migrations.js");
const { getDb, schema } = await import("../../db/index.js");
const { FAILING_ERRORS, NEVER_FETCHED_DAYS, SKIP_MIN, STALE_DAYS, assessHealth, checkSourceHealth } = await import("../health.js");
const { ingestSource } = await import("../ingest.js");
const { listSources } = await import("../sources.js");
const { recordFeedback } = await import("../feedback.js");
const { eq } = await import("drizzle-orm");

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const healthy: HealthStats = {
  origin: "user", enabled: true, errorCount: 0, lastError: null, lastSuccessAt: ago(0.1), createdAt: ago(10),
  itemCount: 20, newestItemAt: ago(1), likes: 0, saves: 0, skips: 0,
};
const assess = (over: Partial<HealthStats> = {}) => assessHealth({ ...healthy, ...over }, NOW);

describe("assessHealth", () => {
  it("is ok for a source that is fetching and publishing", () => {
    expect(assess()).toEqual({ status: "ok", reasons: [], shouldDisable: false });
  });

  it("flags failing at exactly three failures in a row, with the last error", () => {
    expect(assess({ errorCount: FAILING_ERRORS - 1 }).status).toBe("ok");
    const failing = assess({ errorCount: FAILING_ERRORS, lastError: "timeout: Timed out after 10000ms" });
    expect(failing.status).toBe("failing");
    expect(failing.reasons[0]).toContain("The last 3 fetches failed");
    expect(failing.reasons[0]).toContain("Timed out after 10000ms");
  });

  it("flags a source never fetched successfully two days after it was added, but not sooner or if it is already failing", () => {
    const never = { lastSuccessAt: null, itemCount: 0, newestItemAt: null };
    expect(assess({ ...never, createdAt: ago(NEVER_FETCHED_DAYS - 0.5) }).status).toBe("ok");
    expect(assess({ ...never, createdAt: ago(NEVER_FETCHED_DAYS) }).status).toBe("never_fetched");
    expect(assess({ ...never, createdAt: ago(10), errorCount: FAILING_ERRORS }).status).toBe("failing"); // the more specific problem wins
  });

  it("flags stale only when the newest item is more than 30 days old", () => {
    expect(assess({ newestItemAt: ago(STALE_DAYS - 1) }).status).toBe("ok");
    expect(assess({ newestItemAt: ago(STALE_DAYS + 1) }).status).toBe("stale");
    expect(assess({ newestItemAt: ago(STALE_DAYS + 1) }).reasons[0]).toMatch(/31 days old/);
    expect(assess({ itemCount: 0, newestItemAt: null }).status).toBe("ok"); // nothing to be stale about
    expect(assess({ newestItemAt: "garbage" }).status).toBe("ok");
  });

  it("flags mostly skipped only with enough skips and a high enough share", () => {
    expect(assess({ skips: SKIP_MIN - 1 }).status).toBe("ok"); // too few skips
    expect(assess({ skips: SKIP_MIN }).status).toBe("mostly_skipped");
    expect(assess({ skips: 8, likes: 2 }).status).toBe("mostly_skipped"); // exactly 80%
    expect(assess({ skips: 8, likes: 1, saves: 2 }).status).toBe("ok"); // under 80%
    expect(assess({ skips: 5 }).reasons[0]).toBe("You skipped 5 of the 5 items you reacted to from this source.");
  });

  it("reports the most serious status and lists every problem", () => {
    const bad = assess({ errorCount: 4, newestItemAt: ago(90), skips: 9 });
    expect(bad.status).toBe("failing");
    expect(bad.reasons).toHaveLength(3);
    expect(bad.reasons[0]).toContain("fetches failed");
    expect(bad.reasons[1]).toContain("days old");
    expect(bad.reasons[2]).toContain("skipped");
  });

  it("never assesses a source the user switched off", () => {
    expect(assess({ enabled: false, errorCount: 9, skips: 9 })).toEqual({ status: "ok", reasons: [], shouldDisable: false });
  });

  it("only ever recommends switching off sources the agent discovered, never ones the user added", () => {
    for (const problem of [{ errorCount: 5 }, { newestItemAt: ago(90) }, { skips: 9 }, { lastSuccessAt: null, itemCount: 0, newestItemAt: null, createdAt: ago(10) }]) {
      expect(assess({ ...problem, origin: "user" }).shouldDisable).toBe(false);
      expect(assess({ ...problem, origin: "agent_discovered" }).shouldDisable).toBe(true);
    }
    expect(assess({ origin: "agent_discovered" }).shouldDisable).toBe(false); // healthy discovered sources stay on
  });
});

const ALICE = "alice@example.com";
const BOB = "bob@example.com";

async function addSource(owner = ALICE, over: Partial<typeof schema.sources.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  await getDb().insert(schema.sources).values({ id, ownerEmail: owner, type: "rss", connector: "feed", name: "Feed", lastSuccessAt: ago(0.1), createdAt: ago(10), ...over });
  return id;
}
async function addItem(sourceId: string, owner: string, postedAt: string) {
  const id = crypto.randomUUID();
  await getDb().insert(schema.items).values({ id, ownerEmail: owner, sourceId, externalId: id, url: `https://x.example.com/${id}`, title: "T", postedAt });
  return id;
}
const row = async (id: string) => (await getDb().select().from(schema.sources).where(eq(schema.sources.id, id)))[0];

beforeAll(async () => {
  await runMigrations(APP_MIGRATIONS, { table: APP_MIGRATIONS_TABLE })(null);
});
afterAll(async () => {
  await closeDbExec();
  rmSync(dir, { recursive: true, force: true });
});

describe("checkSourceHealth", () => {
  it("stores each source's status and reason, leaves healthy ones ok, and flags (never disables) a failing user source", async () => {
    const owner = "check@example.com";
    const good = await addSource(owner, { name: "Good" });
    await addItem(good, owner, ago(2));
    const broken = await addSource(owner, { name: "Broken", errorCount: 4, lastError: "http_error: HTTP 404" });
    const old = await addSource(owner, { name: "Old" });
    await addItem(old, owner, ago(60));

    const report = await checkSourceHealth(owner, undefined, NOW);
    expect(report.map((r) => [r.name, r.status, r.autoDisabled]).sort()).toEqual([["Broken", "failing", false], ["Good", "ok", false], ["Old", "stale", false]]);

    expect(await row(good)).toMatchObject({ healthStatus: "ok", healthReason: null, enabled: true });
    expect(await row(broken)).toMatchObject({ healthStatus: "failing", enabled: true, status: "approved" }); // flagged, still on
    expect((await row(broken)).healthReason).toContain("HTTP 404");
    expect((await row(broken)).healthCheckedAt).toBe(new Date(NOW).toISOString());
    expect((await row(old)).healthStatus).toBe("stale");
  });

  it("switches off an unhealthy discovered source and leaves a healthy one alone", async () => {
    const owner = "discovered@example.com";
    const bad = await addSource(owner, { origin: "agent_discovered", errorCount: 5, lastError: "boom" });
    const fine = await addSource(owner, { origin: "agent_discovered", name: "Fine" });
    const report = await checkSourceHealth(owner, undefined, NOW);
    expect(report.find((r) => r.sourceId === bad)).toMatchObject({ status: "failing", autoDisabled: true });
    expect(await row(bad)).toMatchObject({ enabled: false, status: "disabled", healthStatus: "failing" });
    expect(await row(fine)).toMatchObject({ enabled: true, healthStatus: "ok" });
    // A disabled source is not assessed again, and stays off.
    expect((await checkSourceHealth(owner, [bad], NOW))[0]).toMatchObject({ status: "ok", autoDisabled: false });
  });

  it("counts the user's skips, and only on that source", async () => {
    const owner = "skips@example.com";
    const noisy = await addSource(owner, { name: "Noisy" });
    const quiet = await addSource(owner, { name: "Quiet" });
    for (let i = 0; i < 5; i++) await recordFeedback({ ownerEmail: owner, orgId: null, itemId: await addItem(noisy, owner, ago(1)), signal: "skip" });
    await recordFeedback({ ownerEmail: owner, orgId: null, itemId: await addItem(quiet, owner, ago(1)), signal: "like" });
    const report = await checkSourceHealth(owner, undefined, NOW);
    expect(report.find((r) => r.sourceId === noisy)?.status).toBe("mostly_skipped");
    expect(report.find((r) => r.sourceId === quiet)?.status).toBe("ok");
  });

  it("can check one source, and is scoped to the owner", async () => {
    const mine = await addSource(ALICE, { errorCount: 3 });
    const theirs = await addSource(BOB, { errorCount: 3 });
    expect(await checkSourceHealth(ALICE, [mine, theirs], NOW)).toHaveLength(1); // Bob's source is not Alice's to check
    expect((await row(theirs)).healthStatus).toBeNull();
    expect(await checkSourceHealth("nobody@example.com", undefined, NOW)).toEqual([]);
  });

  it("shows up on the Sources list", async () => {
    const owner = "list@example.com";
    const id = await addSource(owner, { errorCount: 3, lastError: "x" });
    await checkSourceHealth(owner, undefined, NOW);
    expect((await listSources(owner)).find((s) => s.id === id)).toMatchObject({ healthStatus: "failing" });
  });
});

describe("health during ingest", () => {
  it("refreshes a source's health after a fetch, failing then recovering", async () => {
    const owner = "ingest-health@example.com";
    const id = await addSource(owner, { config: JSON.stringify({ url: "https://a.example.com/feed" }), lastSuccessAt: null, createdAt: new Date().toISOString() });
    const boom = async () => { throw new Error("upstream down"); };
    for (let i = 0; i < FAILING_ERRORS; i++) await expect(ingestSource({ ownerEmail: owner, sourceId: id, fetchText: boom })).rejects.toThrow();
    expect(await row(id)).toMatchObject({ healthStatus: "failing", enabled: true });

    const feed = `<rss version="2.0"><channel><item><title>Fresh</title><link>https://a.example.com/p</link><guid>1</guid><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;
    await ingestSource({ ownerEmail: owner, sourceId: id, fetchText: async (url) => ({ text: feed, status: 200, contentType: "", finalUrl: url }) });
    expect(await row(id)).toMatchObject({ healthStatus: "ok", errorCount: 0 });
  });
});
