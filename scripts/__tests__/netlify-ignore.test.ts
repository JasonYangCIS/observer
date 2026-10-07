import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../netlify-ignore.sh");
const repo = mkdtempSync(join(tmpdir(), "observer-ignore-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function git(...args: string[]): string {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function write(path: string, content: string) {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

git("init", "-q");
git("config", "user.email", "test@example.com");
git("config", "user.name", "Test");
mkdirSync(join(repo, "scripts"));
copyFileSync(SCRIPT, join(repo, "scripts/netlify-ignore.sh"));
for (const f of ["app/root.tsx", "server/db/schema.ts", "actions/a.ts", "AGENTS.md", "package.json", "netlify.toml", "README.md", "OPERATIONS.md", ".github/workflows/ci.yml", "server/lib/__tests__/a.test.ts", "app/x.test.tsx"]) {
  write(f, "v1\n");
}
git("add", "-A");
git("commit", "-qm", "base");
const BASE = git("rev-parse", "HEAD");

/** Commit `files` on top of BASE and run the ignore script as Netlify would; returns its exit code. */
function run(files: string[], env: Record<string, string | undefined> = {}): number {
  git("checkout", "-q", "--detach", BASE);
  for (const f of files) write(f, `changed ${Math.random()}\n`);
  git("add", "-A");
  git("commit", "-qm", "change", "--allow-empty");
  const head = git("rev-parse", "HEAD");
  // Inherit the environment (git must be on PATH) but control the two variables Netlify sets.
  const base = { ...process.env };
  delete base.CACHED_COMMIT_REF;
  delete base.COMMIT_REF;
  const result = spawnSync("bash", ["scripts/netlify-ignore.sh"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...base, CACHED_COMMIT_REF: BASE, COMMIT_REF: head, ...env },
  });
  return result.status ?? -1;
}

const SKIP = 0;
const BUILD = 1;

describe("netlify-ignore.sh", () => {
  it("skips builds for changes that cannot alter the deployed app", () => {
    expect(run(["README.md"])).toBe(SKIP);
    expect(run(["OPERATIONS.md", "PLAN.md"])).toBe(SKIP);
    expect(run([".github/workflows/ci.yml"])).toBe(SKIP);
    expect(run(["server/lib/__tests__/a.test.ts"])).toBe(SKIP);
    expect(run(["app/x.test.tsx", "server/lib/__tests__/b.test.ts"])).toBe(SKIP);
    expect(run([])).toBe(SKIP); // empty commit
  });

  it("builds when anything the app ships changes", () => {
    for (const file of ["app/root.tsx", "server/db/schema.ts", "actions/a.ts", "AGENTS.md", "package.json", "netlify.toml", ".agents/skills/x/SKILL.md", "scripts/migrate-production.ts", "pnpm-lock.yaml"]) {
      expect(run([file]), file).toBe(BUILD);
    }
  });

  it("builds a mixed change if any part of it ships", () => {
    expect(run(["README.md", "server/lib/ingest.ts"])).toBe(BUILD);
    expect(run(["server/lib/__tests__/a.test.ts", "actions/b.ts"])).toBe(BUILD);
  });

  it("builds when it cannot compare (no previous build, or an unknown commit)", () => {
    expect(run(["README.md"], { CACHED_COMMIT_REF: "" })).toBe(BUILD);
    expect(run(["README.md"], { COMMIT_REF: "" })).toBe(BUILD);
    expect(run(["README.md"], { CACHED_COMMIT_REF: "0000000000000000000000000000000000000000" })).toBe(BUILD);
    expect(run(["README.md"], { CACHED_COMMIT_REF: "not-a-commit" })).toBe(BUILD);
  });
});
