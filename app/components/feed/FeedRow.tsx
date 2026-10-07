import { useT } from "@agent-native/core/client/i18n";
import { useState } from "react";

export interface FeedItem {
  id: string;
  title: string;
  url: string;
  discussionUrl: string | null;
  author: string | null;
  postedAt: string | null;
  source: { id: string; name: string; type: string; origin: string };
  summary: { text: string; citationCount: number; articleUnreadable: boolean };
  relevance: number;
  importance: number | null;
  reason: string;
  metrics: { points?: number; comments?: number };
  feedback: FeedbackState;
}

export interface FeedbackState {
  liked: boolean;
  skipped: boolean;
  saved: boolean;
  opened: boolean;
}

export type FeedbackSignal = "like" | "skip" | "save";

/**
 * What pressing a feedback button does: the new state and whether the signal is
 * now on. Like and skip are mutually exclusive; save is independent. Mirrors the
 * server's rules so the UI can update before the save returns.
 */
export function toggleFeedback(fb: FeedbackState, signal: FeedbackSignal): { next: FeedbackState; active: boolean } {
  const active = !(signal === "like" ? fb.liked : signal === "skip" ? fb.skipped : fb.saved);
  return {
    active,
    next: {
      ...fb,
      liked: signal === "like" ? active : signal === "skip" && active ? false : fb.liked,
      skipped: signal === "skip" ? active : signal === "like" && active ? false : fb.skipped,
      saved: signal === "save" ? active : fb.saved,
    },
  };
}

/** Links come from the open web; only ever render http(s) ones. */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function relativeTime(iso: string | null): string | null {
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

/** Hostname of a link, without "www.", for the small "(domain)" next to a title. */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** One feed entry: rank, relevance, title, and a single meta line. Summary and reasoning expand in place. */
export function FeedRow({
  item,
  rank,
  defaultOpen = false,
  view = "feed",
  onFeedback,
  onOpen,
}: {
  item: FeedItem;
  rank: number;
  defaultOpen?: boolean;
  /** In the Saved view a skipped item stays visible; in the Feed view it collapses to an undo line. */
  view?: "feed" | "saved";
  /** Persist a feedback change. Rejecting reverts the optimistic state. */
  onFeedback?: (signal: FeedbackSignal, active: boolean) => Promise<unknown> | void;
  /** Called when the user opens the article. */
  onOpen?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  // Feedback is applied immediately and rolled back if saving fails.
  const [fb, setFb] = useState<FeedbackState>(item.feedback);

  const toggle = (signal: FeedbackSignal) => {
    const previous = fb;
    const { next, active } = toggleFeedback(fb, signal);
    setFb(next);
    Promise.resolve(onFeedback?.(signal, active)).catch(() => setFb(previous));
  };
  const articleHref = safeHref(item.url);
  const discussionHref = safeHref(item.discussionUrl);
  const posted = relativeTime(item.postedAt);
  const domain = domainOf(item.url);
  const panelId = `feed-item-${item.id}`;
  const dot = <span aria-hidden="true">·</span>;

  if (fb.skipped && view === "feed") {
    return (
      <li className="flex items-center gap-2 py-2 ps-8 text-xs text-muted-foreground sm:gap-3">
        <span className="min-w-0 truncate">{t("feed.skippedNotice", { title: item.title })}</span>
        <button
          type="button"
          onClick={() => toggle("skip")}
          className="rounded font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("feed.undo")}
        </button>
      </li>
    );
  }

  const action = (signal: FeedbackSignal, pressed: boolean, label: string, pressedLabel = label) => (
    <button
      key={signal}
      type="button"
      onClick={() => toggle(signal)}
      aria-pressed={pressed}
      className={`rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${pressed ? "font-semibold text-foreground" : ""}`}
    >
      {pressed ? pressedLabel : label}
    </button>
  );

  return (
    <li className="flex items-start gap-2 py-3 sm:gap-3">
      <span className="w-6 shrink-0 pt-1 text-end text-sm tabular-nums text-muted-foreground">{rank}</span>

      <div
        className="w-10 shrink-0 pt-0.5 text-center"
        title={item.reason}
        role="img"
        aria-label={t("feed.relevanceTitle", { value: item.relevance })}
      >
        <div className="text-base font-semibold leading-none tabular-nums">{item.relevance}</div>
        <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">{t("feed.relShort")}</div>
      </div>

      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] leading-snug">
          {articleHref ? (
            <a
              href={articleHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => onOpen?.()}
              onAuxClick={() => onOpen?.()}
              className="font-medium visited:text-muted-foreground hover:underline"
            >
              {item.title}
            </a>
          ) : (
            <span className="font-medium">{item.title}</span>
          )}
          {domain ? <span className="ms-1.5 text-xs text-muted-foreground">({domain})</span> : null}
        </h2>

        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
          <span>{item.source.name}</span>
          <span>{item.source.origin === "user" ? t("feed.trusted") : t("feed.discovered")}</span>
          {posted ? <>{dot}<span>{posted}</span></> : null}
          {item.author ? <>{dot}<span>{t("feed.by", { author: item.author })}</span></> : null}
          {item.metrics.points !== undefined ? <>{dot}<span>{t("feed.points", { count: item.metrics.points })}</span></> : null}
          {discussionHref ? (
            <>
              {dot}
              <a href={discussionHref} target="_blank" rel="noopener noreferrer" className="hover:underline">
                {item.metrics.comments !== undefined ? t("feed.comments", { count: item.metrics.comments }) : t("feed.discussion")}
              </a>
            </>
          ) : null}
          {item.importance !== null ? <>{dot}<span>{t("feed.importance", { value: item.importance })}</span></> : null}
          {item.summary.articleUnreadable ? <>{dot}<span className="italic">{t("feed.unreadable")}</span></> : null}
          {dot}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={panelId}
            className="rounded font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {open ? t("feed.hideSummary") : t("feed.showSummary")}
          </button>
          {dot}
          {action("like", fb.liked, t("feed.like"), t("feed.liked"))}
          {action("skip", fb.skipped, t("feed.skip"))}
          {action("save", fb.saved, t("feed.save"), t("feed.saved"))}
        </p>

        {open ? (
          <div id={panelId} className="mt-2 max-w-prose space-y-1.5 text-sm">
            <p className={item.summary.articleUnreadable ? "italic text-muted-foreground" : ""}>{item.summary.text}</p>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">{t("feed.why")}: </span>
              {item.reason}
              {!item.summary.articleUnreadable && item.summary.citationCount > 0
                ? ` · ${t("feed.citations", { count: item.summary.citationCount })}`
                : ""}
            </p>
          </div>
        ) : null}
      </div>
    </li>
  );
}
