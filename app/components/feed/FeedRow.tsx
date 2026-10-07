import { useT } from "@agent-native/core/client/i18n";
import { IconLink } from "@tabler/icons-react";
import { useState } from "react";

export interface FeedItem {
  id: string;
  title: string;
  url: string;
  discussionUrl: string | null;
  imageUrl: string | null;
  author: string | null;
  postedAt: string | null;
  source: { id: string; name: string; type: string; origin: string };
  summary: { text: string; citationCount: number; articleUnreadable: boolean };
  relevance: number;
  importance: number;
  reason: string;
  metrics: { points?: number; comments?: number };
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

/** Square thumbnail; a link glyph stands in when there is no image or it fails to load. */
function Thumbnail({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  // Thumbnails must be https: the server only stores https URLs, and browsers block http images on https pages.
  const url = src?.startsWith("https://") ? safeHref(src) : undefined;
  return (
    <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted text-muted-foreground" aria-hidden="true">
      {url && !failed ? (
        <img
          src={url}
          alt=""
          width={64}
          height={64}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      ) : (
        <IconLink className="size-5" strokeWidth={1.5} />
      )}
    </div>
  );
}

/** One feed entry: rank, relevance, thumbnail, title, and a single meta line. Summary and reasoning expand in place. */
export function FeedRow({ item, rank, defaultOpen = false }: { item: FeedItem; rank: number; defaultOpen?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const articleHref = safeHref(item.url);
  const discussionHref = safeHref(item.discussionUrl);
  const posted = relativeTime(item.postedAt);
  const domain = domainOf(item.url);
  const panelId = `feed-item-${item.id}`;
  const dot = <span aria-hidden="true">·</span>;

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

      <Thumbnail src={item.imageUrl} />

      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] leading-snug">
          {articleHref ? (
            <a
              href={articleHref}
              target="_blank"
              rel="noopener noreferrer"
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
          {dot}
          <span>{t("feed.importance", { value: item.importance })}</span>
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
