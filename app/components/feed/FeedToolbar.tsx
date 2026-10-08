import { useT } from "@agent-native/core/client/i18n";

export type FeedView = "feed" | "saved";
export type FeedSort = "ranked" | "newest";

export interface FeedToolbarProps {
  view: FeedView;
  onViewChange: (view: FeedView) => void;
  sort: FeedSort;
  onSortChange: (sort: FeedSort) => void;
  hideRead: boolean;
  onHideReadChange: (hide: boolean) => void;
  /** How many items in the current view the user has already opened. */
  readCount: number;
}

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Feed / Saved tabs on the left; sort order and the hide-read filter on the right. */
export function FeedToolbar({ view, onViewChange, sort, onSortChange, hideRead, onHideReadChange, readCount }: FeedToolbarProps) {
  const t = useT();
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-sm">
      <div className="flex gap-4" role="group" aria-label={t("feed.viewLabel")}>
        {(["feed", "saved"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => onViewChange(v)}
            aria-pressed={view === v}
            className={`rounded pb-0.5 hover:text-foreground ${focusRing} ${view === v ? "border-b-2 border-foreground font-medium text-foreground" : "text-muted-foreground"}`}
          >
            {v === "feed" ? t("feed.tabFeed") : t("feed.tabSaved")}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex items-center gap-1.5" role="group" aria-label={t("feed.sortLabel")}>
          <span className="text-xs text-muted-foreground">{t("feed.sortLabel")}</span>
          <div className="flex overflow-hidden rounded-md border border-input">
            {(["ranked", "newest"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onSortChange(s)}
                aria-pressed={sort === s}
                className={`px-2.5 py-1 text-xs ${focusRing} ${sort === s ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {s === "ranked" ? t("feed.sortRanked") : t("feed.sortNewest")}
              </button>
            ))}
          </div>
        </div>

        <label className="flex cursor-pointer items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={hideRead}
            onChange={(e) => onHideReadChange(e.target.checked)}
            className={`size-3.5 rounded border-input ${focusRing}`}
          />
          <span className={hideRead ? "font-medium text-foreground" : "text-muted-foreground"}>
            {readCount > 0 ? t("feed.hideReadCount", { count: readCount }) : t("feed.hideRead")}
          </span>
        </label>
      </div>
    </div>
  );
}
