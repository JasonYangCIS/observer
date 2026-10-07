import { useT } from "@agent-native/core/client/i18n";
import { actionErrorMessage, useActionMutation, useActionQuery } from "@agent-native/core/client/hooks";
import { sendToAgentChat } from "@agent-native/core/client/agent-chat";
import { useSetPageTitle } from "@agent-native/toolkit/app-shell";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { InterestsForm } from "@/components/interests/InterestsForm";
import { relativeTime } from "@/components/feed/FeedRow";
import { APP_TITLE } from "@/lib/app-config";

export function meta() {
  return [{ title: `Interests — ${APP_TITLE}` }];
}

interface InterestsData {
  profileText: string;
  updatedAt: string;
  isDefault: boolean;
  defaultText: string;
  staleScores: number;
}

export default function InterestsPage() {
  const t = useT();
  useSetPageTitle(t("interests.title"));
  const { data, isLoading, error } = useActionQuery("get-interests", {}, { refetchOnMount: "always" });
  const save = useActionMutation("update-interests");
  const saved: InterestsData | undefined = data;

  // The draft starts from the saved text and is reset whenever the saved text changes
  // (first load, a save, or the agent editing the profile in the sidebar).
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (saved) setDraft(saved.profileText);
  }, [saved?.profileText]);

  const dirty = !!saved && draft.trim() !== saved.profileText.trim();

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-6">
      <h1 className="text-xl font-semibold">{t("interests.title")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t("interests.description")}</p>

      {isLoading || !saved ? (
        error ? (
          <p className="mt-6 text-sm text-destructive">{actionErrorMessage(error) ?? t("interests.loadFailed")}</p>
        ) : (
          <div className="mt-6 h-48 animate-pulse rounded-md bg-muted" aria-hidden="true" />
        )
      ) : (
        <InterestsForm
          value={draft}
          onChange={setDraft}
          dirty={dirty}
          saving={save.isPending}
          isDefault={saved.isDefault}
          lastChanged={relativeTime(saved.updatedAt.includes("T") ? saved.updatedAt : saved.updatedAt.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"))}
          staleScores={saved.staleScores}
          onSave={() =>
            save.mutate(
              { profileText: draft },
              {
                onSuccess: () => toast.success(t("interests.saved")),
                onError: (err) => toast.error(actionErrorMessage(err) ?? t("interests.saveFailed")),
              },
            )
          }
          onReset={() => setDraft(saved.defaultText)}
          onAskAgent={() => sendToAgentChat({ message: t("interests.askPrompt"), submit: false, openSidebar: true })}
        />
      )}
    </div>
  );
}
