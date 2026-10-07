import { useT } from "@agent-native/core/client/i18n";

export const MAX_PROFILE_CHARS = 2000;
export const MIN_PROFILE_CHARS = 20;

export interface InterestsFormProps {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onReset: () => void;
  onAskAgent: () => void;
  saving: boolean;
  /** The text differs from what is saved. */
  dirty: boolean;
  isDefault: boolean;
  /** "3 hours ago" style text for the last change, or null. */
  lastChanged: string | null;
  /** Recent scores that the saved profile has made stale. */
  staleScores: number;
}

/** Plain editor for the interest profile: the text the agent scores every item against. */
export function InterestsForm({ value, onChange, onSave, onReset, onAskAgent, saving, dirty, isDefault, lastChanged, staleScores }: InterestsFormProps) {
  const t = useT();
  const length = value.trim().length;
  const valid = length >= MIN_PROFILE_CHARS && length <= MAX_PROFILE_CHARS;

  return (
    <form
      className="mt-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && valid && !saving) onSave();
      }}
    >
      <label htmlFor="interests-text" className="text-sm font-medium">
        {t("interests.label")}
      </label>
      <textarea
        id="interests-text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={8}
        maxLength={MAX_PROFILE_CHARS + 500}
        placeholder={t("interests.placeholder")}
        aria-describedby="interests-help"
        className="mt-2 w-full resize-y rounded-md border border-input bg-background p-3 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

      <div id="interests-help" className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className={valid ? "" : "text-destructive"}>{t("interests.charCount", { count: length, max: MAX_PROFILE_CHARS })}</span>
        {dirty ? <span className="font-medium text-foreground">{t("interests.unsaved")}</span> : null}
        {!dirty && lastChanged ? <span>{t("interests.lastChanged", { time: lastChanged })}</span> : null}
        {isDefault && !dirty ? <span>{t("interests.usingDefault")}</span> : null}
        {staleScores > 0 && !dirty ? <span>{t("interests.stale", { count: staleScores })}</span> : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={!dirty || !valid || saving}
          className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {saving ? t("interests.saving") : t("interests.save")}
        </button>
        <button
          type="button"
          onClick={onAskAgent}
          className="h-9 rounded-md border border-input px-4 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("interests.askAgent")}
        </button>
        {!isDefault || dirty ? (
          <button type="button" onClick={onReset} className="rounded text-sm text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {t("interests.resetDefault")}
          </button>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t("interests.askAgentHint")}</p>
    </form>
  );
}
