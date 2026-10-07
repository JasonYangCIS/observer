import { useT } from "@agent-native/core/client/i18n";
import { actionErrorMessage, useActionMutation, useActionQuery } from "@agent-native/core/client/hooks";
import { useSetPageTitle } from "@agent-native/toolkit/app-shell";
import { useState } from "react";
import { toast } from "sonner";

import { AddSourceForm, type AddPayload } from "@/components/sources/AddSourceForm";
import { Button } from "@/components/ui/button";
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
  trustWeight: number;
  healthStatus: string | null;
  healthReason: string | null;
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

  const importOpml = useActionMutation("import-opml");
  const health = useActionMutation("check-source-health");
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);

  const sources: SourceView[] = data?.sources ?? [];

  const addSource = (payload: AddPayload) =>
    manage.mutate(payload, {
      onSuccess: () => toast.success(t("sources.added")),
      onError: (err) => toast.error(actionErrorMessage(err) ?? t("sources.addFailed")),
    });

  const importFeeds = (opml: string) =>
    importOpml.mutate(
      { opml },
      {
        onSuccess: (r: { added: number; skippedDuplicate: number; skippedInvalid: number; skippedOverLimit: number }) => {
          const skipped = r.skippedDuplicate + r.skippedInvalid + r.skippedOverLimit;
          toast.success(t("sources.imported", { added: r.added, skipped }));
        },
        onError: (err) => toast.error(actionErrorMessage(err) ?? t("sources.importFailed")),
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("sources.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("sources.description")}</p>
        </div>
        {sources.length > 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={health.isPending}
            onClick={() =>
              health.mutate(
                {},
                {
                  onSuccess: (r: { checked: number; needsAttention: unknown[] }) =>
                    toast.success(t("sources.checked", { count: r.checked, attention: r.needsAttention.length })),
                  onError: (err) => toast.error(actionErrorMessage(err) ?? t("sources.checkFailed")),
                },
              )
            }
          >
            {health.isPending ? t("sources.checking") : t("sources.checkHealth")}
          </Button>
        ) : null}
      </div>

      <AddSourceForm
        existingTypes={sources.map((s) => s.type)}
        pending={manage.isPending && manage.variables?.operation === "add"}
        onAdd={addSource}
        onImportOpml={importFeeds}
        importing={importOpml.isPending}
      />

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
            <Button className="mt-4" variant="outline" onClick={() => addSource({ operation: "add", type: "hn" })} disabled={manage.isPending}>
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
                        {t(`sources.kind.${s.type}`, { defaultValue: t("sources.kind.rss") })}
                      </span>
                      {s.origin === "user" ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {t("sources.trusted")}
                        </span>
                      ) : null}
                      {s.healthStatus && s.healthStatus !== "ok" && s.enabled ? (
                        <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive" title={s.healthReason ?? undefined}>
                          {t(`sources.health.${s.healthStatus}`, { defaultValue: s.healthStatus })}
                        </span>
                      ) : null}
                      {Math.abs(s.trustWeight - 1) >= 0.05 ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title={t("sources.trustHint")}>
                          {t("sources.trust", { value: s.trustWeight.toFixed(2) })}
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
