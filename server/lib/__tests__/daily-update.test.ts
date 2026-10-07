import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "observer-daily-"));
process.env.DATABASE_URL = `pglite:${join(dir, "db")}`;

const { closeDbExec } = await import("@agent-native/core/db");
const { resourceGetByPath, resourcePut } = await import("@agent-native/core/resources");
const { parseJobResource, buildJobResourceContent, classifyJobResource } = await import("@agent-native/core/jobs/frontmatter");
const { DAILY_BATCH_SIZE, DAILY_UPDATE_JOB_PATH, DAILY_UPDATE_PROMPT, getDailyUpdate, isValidTimezone, setDailyUpdate } = await import("../daily-update.js");

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const set = (over: Record<string, unknown> = {}, owner = ALICE) =>
  setDailyUpdate({ ownerEmail: owner, orgId: null, enabled: true, hour: 7, timezone: "America/Los_Angeles", ...over } as Parameters<typeof setDailyUpdate>[0]);

afterAll(async () => {
  await closeDbExec();
  rmSync(dir, { recursive: true, force: true });
});

describe("daily update automation", () => {
  it("is unconfigured until the user turns it on", async () => {
    expect(await getDailyUpdate(ALICE)).toMatchObject({ configured: false, enabled: false, nextRun: null, lastRun: null });
  });

  it("writes a scheduled, agentic job that runs as the user, with a next run in the future", async () => {
    const before = Date.now();
    const status = await set({ hour: 6 });
    expect(status).toMatchObject({ configured: true, enabled: true, hour: 6, timezone: "America/Los_Angeles" });
    expect(Date.parse(status.nextRun!)).toBeGreaterThan(before);
    expect(Date.parse(status.nextRun!)).toBeLessThanOrEqual(before + 24 * 3_600_000 + 60_000);

    const resource = await resourceGetByPath(ALICE, DAILY_UPDATE_JOB_PATH);
    const { meta, body } = parseJobResource(resource!.content);
    expect(meta).toMatchObject({ schedule: "0 6 * * *", enabled: true, runAs: "creator", triggerType: "schedule", createdBy: ALICE, timezone: "America/Los_Angeles" });
    expect(body).toContain(DAILY_UPDATE_PROMPT);
    // The framework's own classifier must see a valid scheduled automation, not just parseable text.
    expect(classifyJobResource(resource!.content)).toMatchObject({ kind: "automation", triggerType: "schedule", hasExplicitTriggerType: true });
  });

  it("the prompt only uses actions that exist, stays bounded, and treats articles as untrusted", () => {
    for (const action of ["list-sources", "fetch-source", "fetch-article-text", "get-summary-input", "summarize-item", "get-score-input", "score-item", "check-source-health"]) {
      expect(DAILY_UPDATE_PROMPT).toContain(action);
    }
    expect(DAILY_UPDATE_PROMPT).toContain(`limit ${DAILY_BATCH_SIZE}`);
    expect(DAILY_UPDATE_PROMPT).toMatch(/untrusted/);
    expect(DAILY_UPDATE_PROMPT).toMatch(/never invent a quote/);
    expect(DAILY_UPDATE_PROMPT).toContain("summary-style");
    expect(DAILY_UPDATE_PROMPT).toContain("score-reason");
  });

  it("pauses without deleting, and keeps the scheduler's run history when updated", async () => {
    const resource = await resourceGetByPath(ALICE, DAILY_UPDATE_JOB_PATH);
    const { meta, body } = parseJobResource(resource!.content);
    await resourcePut(ALICE, DAILY_UPDATE_JOB_PATH, buildJobResourceContent({ ...meta, lastRun: "2026-10-06T14:00:00.000Z", lastStatus: "error", lastError: "Source failed" }, body));

    const paused = await set({ enabled: false, hour: 9 });
    expect(paused).toMatchObject({ configured: true, enabled: false, hour: 9, nextRun: null, lastStatus: "error", lastError: "Source failed", lastRun: "2026-10-06T14:00:00.000Z" });
    expect((await getDailyUpdate(ALICE)).enabled).toBe(false);
    expect(await set({ enabled: true })).toMatchObject({ enabled: true, hour: 7 });
  });

  it("rejects an invalid hour or time zone and changes nothing", async () => {
    const before = await getDailyUpdate(ALICE);
    for (const hour of [-1, 24, 7.5]) await expect(set({ hour })).rejects.toThrow(/0 to 23/);
    for (const timezone of ["Mars/Olympus", "", "not a zone"]) await expect(set({ timezone })).rejects.toThrow(/time zone/);
    expect(await getDailyUpdate(ALICE)).toEqual(before);
  });

  it("is per user", async () => {
    await set({ hour: 5 }, BOB);
    expect((await getDailyUpdate(BOB)).hour).toBe(5);
    expect((await getDailyUpdate(ALICE)).hour).not.toBe(5);
    expect((await getDailyUpdate("nobody@example.com")).configured).toBe(false);
  });
});

describe("isValidTimezone", () => {
  it("accepts IANA names and rejects junk", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Europe/London")).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("  ")).toBe(false);
  });
});
