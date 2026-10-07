import { useT } from "@agent-native/core/client/i18n";
import { actionErrorMessage, useActionMutation, useActionQuery } from "@agent-native/core/client/hooks";
import { sendToAgentChat } from "@agent-native/core/client/agent-chat";
import { useSetPageTitle } from "@agent-native/toolkit/app-shell";
import { Link } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { APP_TITLE } from "@/lib/app-config";

export function meta() {
  return [{ title: `Feed — ${APP_TITLE}` }];
}

interface FeedItem {
  id: string;
  title: string;
  url: string;
  discussionUrl: string | null;
  author: string | null;
  postedAt: string | null;
  source: { id: string; name: string; type: string; origin: string };
  summary: { text: string; citationCount: number; articleUnreadable: boolean };
  relevance: number;
  importance: number;
  reason: string;
  metrics: { points?: number; comments?: number };
}

interface FeedProgress {
  sources: number;
  needArticle: number;
  needSummary: number;
  needScore: number;
  ready: number;
}

/** Links come from the open web; only ever render http(s) ones. */
function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const diff = ms - Date.now();
  for (const [unit, size] of [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000]] as const) {
    if (Math.abs(diff) >= size) return rtf.format(Math.round(diff / size), unit);
  }
  return rtf.format(0, "second");
}

const chip = "rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground";

function FeedCard({ item }: { item: FeedItem }) {
  const t = useT();
  const articleHref = safeHref(item.url);
  const discussionHref = safeHref(item.discussionUrl);
  const posted = relativeTime(item.postedAt);
  return (
    <article className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{item.source.name}</span>
        <span className={chip}>{item.source.origin === "user" ? t("feed.trusted") : t("feed.discovered")}</span>
        {posted ? <span>{posted}</span> : null}
        {item.author ? <span>· {item.author}</span> : null}
      </div>

      <h2 className="mt-1.5 text-base font-semibold leading-snug">
        {articleHref ? (
          <a href={articleHref} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {item.title}
          </a>
        ) : (
          item.title
        )}
      </h2>

      <p className={`mt-2 text-sm leading-relaxed ${item.summary.articleUnreadable ? "italic text-muted-foreground" : ""}`}>
        {item.summary.text}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className={chip}>{t("feed.relevance", { value: item.relevance })}</span>
        <span className={chip}>{t("feed.importance", { value: item.importance })}</span>
        {item.summary.articleUnreadable ? (
          <span className={chip}>{t("feed.unreadable")}</span>
        ) : item.summary.citationCount > 0 ? (
          <span className={chip}>{t("feed.citations", { count: item.summary.citationCount })}</span>
        ) : null}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium">{t("feed.why")}: </span>
        {item.reason}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {articleHref ? (
          <a href={articleHref} target="_blank" rel="noopener noreferrer" className="font-medium underline-offset-2 hover:underline">
            {t("feed.readArticle")}
          </a>
        ) : null}
        {discussionHref ? (
          <a href={discussionHref} target="_blank" rel="noopener noreferrer" className="font-medium underline-offset-2 hover:underline">
            {t("feed.discussion")}
          </a>
        ) : null}
        {item.metrics.points !== undefined ? <span className="text-muted-foreground">{t("feed.points", { count: item.metrics.points })}</span> : null}
        {item.metrics.comments !== undefined ? <span className="text-muted-foreground">{t("feed.comments", { count: item.metrics.comments })}</span> : null}
      </div>
    </article>
  );
}

interface DailyUpdate {
  configured: boolean;
  enabled: boolean;
  hour: number;
  timezone: string;
  nextRun: string | null;
  lastRun: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

function hourLabel(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric" });
}

/** Turn the daily automation on or off and pick its hour; shows how the last run went. */
function DailyUpdateRow() {
  const t = useT();
  const { data } = useActionQuery("get-daily-update", {});
  const save = useActionMutation("set-daily-update");
  const status: DailyUpdate | undefined = data;
  if (!status) return null;

  const change = (vars: { enabled: boolean; hour?: number }) =>
    save.mutate(
      {
        ...vars,
        // A first-time setup uses the browser's zone; later changes keep the saved one.
        ...(status.configured ? {} : { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      },
      { onError: (err) => toast.error(actionErrorMessage(err) ?? t("feed.daily.saveFailed")) },
    );

  const lastRun = status.lastRun ? relativeTime(status.lastRun) : null;
  const next = status.enabled && status.nextRun ? relativeTime(status.nextRun) : null;

  return (
    <div className="mt-4 rounded-lg border border-border px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-medium">{t("feed.daily.title")}</span>
        {status.enabled ? (
          <>
            <span className="text-muted-foreground">{t("feed.daily.on")}</span>
            <select
              aria-label={t("feed.daily.hourLabel")}
              value={status.hour}
              disabled={save.isPending}
              onChange={(e) => change({ enabled: true, hour: Number(e.target.value) })}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">{t("feed.daily.timezoneNote", { timezone: status.timezone })}</span>
          </>
        ) : (
          <span className="flex-1 text-muted-foreground">{t("feed.daily.off")}</span>
        )}
        <Button
          size="sm"
          variant="outline"
          className="ms-auto"
          disabled={save.isPending}
          onClick={() => change({ enabled: !status.enabled })}
        >
          {status.enabled ? t("feed.daily.turnOff") : t("feed.daily.turnOn")}
        </Button>
      </div>
      {status.configured ? (
        <p className={`mt-2 text-xs ${status.lastStatus === "error" ? "text-destructive" : "text-muted-foreground"}`}>
          {status.lastRun
            ? status.lastStatus === "error"
              ? t("feed.daily.lastFailed", { time: lastRun ?? "", error: status.lastError ?? "" })
              : status.lastStatus === "success"
                ? t("feed.daily.lastOk", { time: lastRun ?? "" })
                : t("feed.daily.lastOther", { time: lastRun ?? "", status: status.lastStatus ?? "" })
            : t("feed.daily.neverRan")}
          {next ? ` · ${t("feed.daily.next", { time: next })}` : ""}
        </p>
      ) : null}
    </div>
  );
}

export default function FeedPage() {
  const t = useT();
  useSetPageTitle(t("feed.title"));
  const { data, isLoading, error } = useActionQuery("list-feed", {});

  const feedItems: FeedItem[] = data?.items ?? [];
  const progress: FeedProgress | undefined = data?.progress;
  const waiting = progress ? progress.needArticle + progress.needSummary + progress.needScore : 0;

  // Fetching and summarizing are AI work, so they run in the agent sidebar where
  // the user can watch, steer, and review them.
  const runInAgent = (message: string) => sendToAgentChat({ message, submit: true, openSidebar: true });

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("feed.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("feed.description")}</p>
        </div>
        {progress && progress.sources > 0 ? (
          <Button onClick={() => runInAgent(t("feed.refreshPrompt"))} title={t("feed.updateHint")}>
            {t("feed.update")}
          </Button>
        ) : null}
      </div>

      <DailyUpdateRow />

      {waiting > 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-muted px-4 py-3 text-sm" role="status">
          <span className="flex-1">{t("feed.waiting", { count: waiting })}</span>
          <Button size="sm" variant="outline" onClick={() => runInAgent(t("feed.finishPrompt"))}>
            {t("feed.finishWaiting", { count: waiting })}
          </Button>
        </div>
      ) : null}

      <section className="mt-6 space-y-4" aria-live="polite">
        {isLoading ? (
          <div className="space-y-3" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-36 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">{actionErrorMessage(error) ?? t("feed.loadFailed")}</p>
        ) : progress && progress.sources === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <h2 className="text-sm font-medium">{t("feed.noSourcesTitle")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("feed.noSourcesDescription")}</p>
            <Button asChild className="mt-4" variant="outline">
              <Link to="/sources">{t("feed.goToSources")}</Link>
            </Button>
          </div>
        ) : feedItems.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <h2 className="text-sm font-medium">{t("feed.emptyTitle")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("feed.emptyDescription")}</p>
          </div>
        ) : (
          feedItems.map((item) => <FeedCard key={item.id} item={item} />)
        )}
      </section>
    </div>
  );
}
