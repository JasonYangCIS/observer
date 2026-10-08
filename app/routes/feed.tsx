import { useT } from "@agent-native/core/client/i18n";
import { actionErrorMessage, useActionMutation, useActionQuery } from "@agent-native/core/client/hooks";
import { sendToAgentChat } from "@agent-native/core/client/agent-chat";
import { useSetPageTitle } from "@agent-native/toolkit/app-shell";
import { Link } from "react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { FeedRow, relativeTime, type FeedItem, type FeedbackSignal } from "@/components/feed/FeedRow";
import { FeedToolbar, type FeedSort, type FeedView } from "@/components/feed/FeedToolbar";
import { Button } from "@/components/ui/button";
import { APP_TITLE } from "@/lib/app-config";

const SORT_KEY = "observer.feed.sort";
const HIDE_READ_KEY = "observer.feed.hideRead";

export function meta() {
  return [{ title: `Feed — ${APP_TITLE}` }];
}

interface FeedProgress {
  sources: number;
  needArticle: number;
  needSummary: number;
  needScore: number;
  ready: number;
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
  const [view, setView] = useState<FeedView>("feed");
  const [sort, setSortState] = useState<FeedSort>("ranked");
  const [hideRead, setHideReadState] = useState(false);

  // Remember the sort order and filter in this browser. Stored after mount so the first
  // render matches the server's, and a blocked or cleared store simply means the defaults.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(SORT_KEY) === "newest") setSortState("newest");
      if (window.localStorage.getItem(HIDE_READ_KEY) === "1") setHideReadState(true);
    } catch {
      // Storage unavailable: keep the defaults.
    }
  }, []);
  const remember = (key: string, value: string) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Not remembering is fine.
    }
  };
  const setSort = (next: FeedSort) => {
    setSortState(next);
    remember(SORT_KEY, next);
  };
  const setHideRead = (next: boolean) => {
    setHideReadState(next);
    remember(HIDE_READ_KEY, next ? "1" : "0");
  };

  // Re-fetch when switching views so a just-saved item shows up under Saved.
  const { data, isLoading, error } = useActionQuery("list-feed", { view, sort, hideRead }, { refetchOnMount: "always" });
  const readCount: number = data?.readCount ?? 0;
  const feedback = useActionMutation("record-feedback", { skipActionQueryInvalidation: true });

  /** Persist feedback; the row already shows the change, so a failure only needs a toast and a rollback. */
  const saveFeedback = (itemId: string) => async (signal: FeedbackSignal, active: boolean) => {
    try {
      await feedback.mutateAsync({ itemId, signal, active });
    } catch (err) {
      toast.error(actionErrorMessage(err) ?? t("feed.feedbackFailed"));
      throw err;
    }
  };
  // Opening an article is a quiet signal; never interrupt the user if it fails.
  const recordOpened = (itemId: string) => () => {
    feedback.mutate({ itemId, signal: "opened", active: true });
  };

  const feedItems: FeedItem[] = data?.items ?? [];
  const progress: FeedProgress | undefined = data?.progress;
  const waiting = progress ? progress.needArticle + progress.needSummary + progress.needScore : 0;

  // Fetching and summarizing are AI work, so they run in the agent sidebar where
  // the user can watch, steer, and review them.
  const runInAgent = (message: string) => sendToAgentChat({ message, submit: true, openSidebar: true });

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6">
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

      <FeedToolbar
        view={view}
        onViewChange={setView}
        sort={sort}
        onSortChange={setSort}
        hideRead={hideRead}
        onHideReadChange={setHideRead}
        readCount={readCount}
      />

      <section className="mt-4" aria-live="polite">
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
        ) : feedItems.length === 0 && hideRead && readCount > 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <h2 className="text-sm font-medium">{t("feed.caughtUpTitle")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("feed.caughtUpDescription")}</p>
          </div>
        ) : feedItems.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <h2 className="text-sm font-medium">{t("feed.emptyTitle")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{view === "saved" ? t("feed.savedEmpty") : t("feed.emptyDescription")}</p>
          </div>
        ) : (
          <ol className="divide-y divide-border border-y border-border">
            {feedItems.map((item, index) => (
              <FeedRow
                key={item.id}
                item={item}
                rank={index + 1}
                view={view}
                onFeedback={saveFeedback(item.id)}
                onOpen={recordOpened(item.id)}
              />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
