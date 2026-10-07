import { useT } from "@agent-native/core/client/i18n";
import { actionErrorMessage, useActionMutation, useActionQuery } from "@agent-native/core/client/hooks";
import { useSetPageTitle } from "@agent-native/toolkit/app-shell";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { APP_TITLE } from "@/lib/app-config";

export function meta() {
  return [{ title: `Sources — ${APP_TITLE}` }];
}

interface SourceView {
  id: string;
  name: string;
  type: string;
  url: string | null;
  enabled: boolean;
  origin: string;
  lastSuccessAt: string | null;
  errorCount: number;
  lastError: string | null;
  itemCount: number;
}

function relativeTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, ms] of units) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(0, "second");
}

export default function SourcesPage() {
  const t = useT();
  useSetPageTitle(t("sources.title"));

  const { data, isLoading, error } = useActionQuery("list-sources", {});
  const manage = useActionMutation("manage-sources");
  const fetchSource = useActionMutation("fetch-source");

  const [kind, setKind] = useState<"hn" | "rss">("rss");
  const [url, setUrl] = useState("");
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);

  const sources: SourceView[] = data?.sources ?? [];
  const hasHn = sources.some((s) => s.type === "hn");

  const addSource = (type: "hn" | "rss", feedUrl?: string) =>
    manage.mutate(
      { operation: "add", type, ...(feedUrl ? { url: feedUrl } : {}) },
      {
        onSuccess: () => {
          toast.success(t("sources.added"));
          setUrl("");
        },
        onError: (err) => toast.error(actionErrorMessage(err) ?? t("sources.addFailed")),
      },
    );

  const toggle = (s: SourceView) =>
    manage.mutate(
      { operation: "update", id: s.id, enabled: !s.enabled },
      { onError: (err) => toast.error(actionErrorMessage(err) ?? t("sources.updateFailed")) },
    );

  const remove = (s: SourceView) =>
    manage.mutate(
      { operation: "remove", id: s.id },
      {
        onSuccess: () => toast.success(t("sources.removed")),
        onError: (err) => toast.error(actionErrorMessage(err) ?? t("sources.removeFailed")),
        onSettled: () => setConfirmingRemove(null),
      },
    );

  const fetchNow = (s: SourceView) =>
    fetchSource.mutate(
      { sourceId: s.id },
      {
        onSuccess: (r: { fetched: number; newItems: number }) =>
          toast.success(t("sources.fetched", { total: r.fetched, fresh: r.newItems })),
        onError: (err) => toast.error(actionErrorMessage(err) ?? t("sources.fetchFailed")),
      },
    );

  const fetchingId = fetchSource.isPending ? fetchSource.variables?.sourceId : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6">
      <h1 className="text-xl font-semibold">{t("sources.title")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t("sources.description")}</p>

      <form
        className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (kind === "rss" && !url.trim()) return;
          addSource(kind, kind === "rss" ? url.trim() : undefined);
        }}
        aria-label={t("sources.addTitle")}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="source-kind">{t("sources.typeLabel")}</Label>
          <select
            id="source-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as "hn" | "rss")}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="rss">{t("sources.typeRss")}</option>
            <option value="hn" disabled={hasHn}>
              {t("sources.typeHn")}
            </option>
          </select>
        </div>
        {kind === "rss" ? (
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="source-url">{t("sources.urlLabel")}</Label>
            <Input
              id="source-url"
              type="url"
              inputMode="url"
              required
              value={url}
              placeholder={t("sources.urlPlaceholder")}
              aria-describedby="source-url-hint"
              onChange={(e) => setUrl(e.target.value)}
            />
            <p id="source-url-hint" className="text-xs text-muted-foreground">
              {t("sources.urlHint")}
            </p>
          </div>
        ) : (
          <div className="flex-1" />
        )}
        <Button type="submit" disabled={manage.isPending && manage.variables?.operation === "add"}>
          {manage.isPending && manage.variables?.operation === "add" ? t("sources.adding") : t("sources.add")}
        </Button>
      </form>

      <section className="mt-8" aria-live="polite">
        {isLoading ? (
          <div className="space-y-2" aria-hidden="true">
            {[0, 1].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">{actionErrorMessage(error) ?? t("sources.loadFailed")}</p>
        ) : sources.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <h2 className="text-sm font-medium">{t("sources.emptyTitle")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("sources.emptyDescription")}</p>
            <Button className="mt-4" variant="outline" onClick={() => addSource("hn")} disabled={manage.isPending}>
              {t("sources.addHn")}
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {sources.map((s) => {
              const failing = s.errorCount > 0;
              return (
                <li key={s.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{s.name}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {s.type === "hn" ? t("sources.kindHn") : t("sources.kindRss")}
                      </span>
                      {s.origin === "user" ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {t("sources.trusted")}
                        </span>
                      ) : null}
                      {!s.enabled ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {t("sources.disabled")}
                        </span>
                      ) : null}
                    </div>
                    {s.url ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{s.url}</p> : null}
                    <p className={`mt-1 text-xs ${failing ? "text-destructive" : "text-muted-foreground"}`}>
                      {failing
                        ? `${t("sources.failing", { error: s.lastError ?? "" })} · ${t("sources.failures", { count: s.errorCount })}`
                        : s.lastSuccessAt
                          ? t("sources.lastFetched", { time: relativeTime(s.lastSuccessAt) })
                          : t("sources.neverFetched")}
                      {" · "}
                      {t("sources.items", { count: s.itemCount })}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => fetchNow(s)}
                      disabled={!s.enabled || fetchSource.isPending}
                    >
                      {fetchingId === s.id ? t("sources.fetching") : t("sources.fetchNow")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => toggle(s)} disabled={manage.isPending}>
                      {s.enabled ? t("sources.disable") : t("sources.enable")}
                    </Button>
                    {confirmingRemove === s.id ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => remove(s)}
                        disabled={manage.isPending}
                        title={t("sources.removeHint")}
                      >
                        {t("sources.confirmRemove")}
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => setConfirmingRemove(s.id)}>
                        {t("sources.remove")}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
