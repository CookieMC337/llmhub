"use client";

import { useState, useTransition } from "react";
import { Description, Input, Label, Switch, TextField, toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import SearchSelect from "@/components/console/search-select";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { McpMediaKind, McpMediaModel, McpServerView } from "@/types/mcp";
import { createMediaMcpServerAction, updateMediaMcpServerAction } from "../_action";

const NONE = "none";
const KINDS: readonly McpMediaKind[] = ["image", "speech", "video", "transcription"];

type ModelPicks = Record<McpMediaKind, string>;

function picksOf(server: McpServerView | null, models: McpMediaModel[]): ModelPicks {
  if (server?.media) {
    return {
      image: server.media.image.model,
      speech: server.media.speech.model,
      video: server.media.video.model,
      transcription: server.media.transcription.model,
    };
  }
  return { image: models.find((model) => model.media)?.alias ?? "", speech: "", video: "", transcription: "" };
}

export default function MediaDialog({
  state,
  editing,
  models,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  editing: McpServerView | null;
  models: McpMediaModel[];
  onSaved: (server: McpServerView) => void;
}) {
  const t = useTranslations("Mcp");
  const showError = useErrorToast();
  const [name, setName] = useState(editing?.name ?? "media");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [picks, setPicks] = useState<ModelPicks>(() => picksOf(editing, models));
  const [voice, setVoice] = useState(editing?.media?.speech.voice ?? "");
  const [global, setGlobal] = useState(editing?.global ?? false);
  const [pending, start] = useTransition();
  const mode = editing ? "edit" : "add";
  const items = [
    { id: NONE, label: t("media.none") },
    ...models.map((model) => ({
      id: model.alias,
      label: model.label || model.alias,
      detail: model.media ? t("media.mediaModel") : undefined,
    })),
  ];

  function save(close: () => void) {
    start(async () => {
      const input = {
        name,
        description,
        imageModel: picks.image,
        speechModel: picks.speech,
        speechVoice: voice,
        videoModel: picks.video,
        transcriptionModel: picks.transcription,
        global,
        enabled: editing?.enabled ?? true,
      };
      const result = editing
        ? await updateMediaMcpServerAction({ id: editing.id, ...input })
        : await createMediaMcpServerAction(input);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.server);
      toast(t("form.saved", { mode }), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      size="lg"
      title={t("media.title", { mode, name: editing?.name ?? "" })}
      description={t("media.description")}
      submitLabel={t("form.submit", { mode })}
      pending={pending}
      isSubmitDisabled={!name.trim() || !KINDS.some((kind) => picks[kind])}
      onSubmit={save}
    >
      <TextField fullWidth isRequired value={name} onChange={setName} isDisabled={pending}>
        <Label>{t("form.name")}</Label>
        <Input />
        <Description>{t("form.nameHint")}</Description>
      </TextField>
      <TextField fullWidth value={description} onChange={setDescription} isDisabled={pending}>
        <Label>{t("form.descriptionField")}</Label>
        <Input />
      </TextField>
      {KINDS.map((kind) => (
        <SearchSelect
          key={kind}
          label={t("media.model", { kind })}
          description={t("media.modelHint", { kind })}
          placeholder={t("media.none")}
          items={items}
          value={picks[kind] || NONE}
          onChange={(id) => setPicks((current) => ({ ...current, [kind]: id === NONE ? "" : id }))}
          isDisabled={pending}
        />
      ))}
      {picks.speech ? (
        <TextField fullWidth value={voice} onChange={setVoice} isDisabled={pending}>
          <Label>{t("media.voice")}</Label>
          <Input placeholder="alloy" />
          <Description>{t("media.voiceHint")}</Description>
        </TextField>
      ) : null}
      <Switch isSelected={global} onChange={setGlobal} isDisabled={pending}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Label>{t("media.global")}</Label>
        </Switch.Content>
        <Description>{t("media.globalHint")}</Description>
      </Switch>
    </FormDialog>
  );
}
