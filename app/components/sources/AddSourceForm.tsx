import { useT } from "@agent-native/core/client/i18n";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const SOURCE_TYPES = ["rss", "reddit", "hn", "lobsters", "devto", "github", "producthunt"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Types a user can only have one of. The add menu disables them once added. */
const SINGLE_INSTANCE: SourceType[] = ["hn", "lobsters", "producthunt"];

/** The one extra field each type takes, if any, and whether it is required. */
const FIELD: Partial<Record<SourceType, { name: "url" | "subreddit" | "tag" | "language"; required: boolean }>> = {
  rss: { name: "url", required: true },
  reddit: { name: "subreddit", required: true },
  devto: { name: "tag", required: false },
  github: { name: "language", required: false },
};

export type AddPayload = { operation: "add"; type: SourceType } & Partial<Record<"url" | "subreddit" | "tag" | "language", string>>;

/**
 * The `manage-sources` arguments for the chosen type and field value, or null when
 * a required field is empty. Optional fields are omitted when blank.
 */
export function buildAddPayload(type: SourceType, value: string): AddPayload | null {
  const field = FIELD[type];
  const trimmed = value.trim();
  if (field?.required && !trimmed) return null;
  return { operation: "add", type, ...(field && trimmed ? { [field.name]: trimmed } : {}) };
}

export interface AddSourceFormProps {
  /** Types of the sources the user already has. */
  existingTypes: string[];
  pending: boolean;
  onAdd: (payload: AddPayload) => void;
  /** Called with the text of a chosen OPML file. */
  onImportOpml: (text: string) => void;
  importing: boolean;
}

/** Add a source of any supported type, or import a feed reader's OPML export. */
export function AddSourceForm({ existingTypes, pending, onAdd, onImportOpml, importing }: AddSourceFormProps) {
  const t = useT();
  const [type, setType] = useState<SourceType>("rss");
  const [value, setValue] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const field = FIELD[type];
  const taken = (candidate: SourceType) => SINGLE_INSTANCE.includes(candidate) && existingTypes.includes(candidate);

  const labels: Record<SourceType, string> = {
    rss: t("sources.typeRss"),
    reddit: t("sources.typeReddit"),
    hn: t("sources.typeHn"),
    lobsters: t("sources.typeLobsters"),
    devto: t("sources.typeDevto"),
    github: t("sources.typeGithub"),
    producthunt: t("sources.typeProducthunt"),
  };
  const hints: Partial<Record<SourceType, string>> = {
    rss: t("sources.urlHint"),
    reddit: t("sources.redditHint"),
    github: t("sources.githubHint"),
  };

  return (
    <div className="mt-6">
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          const payload = buildAddPayload(type, value);
          if (!payload || taken(type)) return;
          onAdd(payload);
          setValue("");
        }}
        aria-label={t("sources.addTitle")}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="source-kind">{t("sources.typeLabel")}</Label>
          <select
            id="source-kind"
            value={type}
            onChange={(e) => {
              setType(e.target.value as SourceType);
              setValue("");
            }}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {SOURCE_TYPES.map((candidate) => (
              <option key={candidate} value={candidate} disabled={taken(candidate)}>
                {labels[candidate]}
              </option>
            ))}
          </select>
        </div>

        {field ? (
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="source-value">{t(`sources.${field.name}Label`)}</Label>
            <Input
              id="source-value"
              type={field.name === "url" ? "url" : "text"}
              inputMode={field.name === "url" ? "url" : "text"}
              required={field.required}
              value={value}
              placeholder={t(`sources.${field.name}Placeholder`)}
              aria-describedby="source-value-hint"
              onChange={(e) => setValue(e.target.value)}
            />
            {hints[type] ? (
              <p id="source-value-hint" className="text-xs text-muted-foreground">
                {hints[type]}
              </p>
            ) : (
              <span id="source-value-hint" className="sr-only" />
            )}
          </div>
        ) : (
          <div className="min-w-0 flex-1 text-xs text-muted-foreground">{hints[type] ?? ""}</div>
        )}

        <Button type="submit" disabled={pending || taken(type)}>
          {pending ? t("sources.adding") : t("sources.add")}
        </Button>
      </form>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <input
          ref={fileInput}
          type="file"
          accept=".opml,.xml,text/xml,application/xml,text/x-opml"
          className="sr-only"
          aria-label={t("sources.importOpml")}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) onImportOpml(await file.text());
          }}
        />
        <Button type="button" size="sm" variant="outline" disabled={importing} onClick={() => fileInput.current?.click()}>
          {importing ? t("sources.importing") : t("sources.importOpml")}
        </Button>
        <span>{t("sources.importHint")}</span>
      </div>
    </div>
  );
}
