"use client";

import { useState, useTransition } from "react";
import { Description, Input, Label, Switch, TextField, toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import SearchSelect from "@/components/console/search-select";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { McpMediaModel, McpServerView } from "@/types/mcp";
import { createMediaMcpServerAction, updateMediaMcpServerAction } from "../_action";

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
  const [imageModel, setImageModel] = useState(editing?.imageModel ?? models.find((model) => model.media)?.alias ?? "");
  const [global, setGlobal] = useState(editing?.global ?? false);
  const [pending, start] = useTransition();
  const mode = editing ? "edit" : "add";

  function save(close: () => void) {
    start(async () => {
      const input = { name, description, imageModel, global, enabled: editing?.enabled ?? true };
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
      title={t("media.title", { mode, name: editing?.name ?? "" })}
      description={t("media.description")}
      submitLabel={t("form.submit", { mode })}
      pending={pending}
      isSubmitDisabled={!name.trim() || !imageModel}
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
      <SearchSelect
        label={t("media.imageModel")}
        description={t("media.imageModelHint")}
        placeholder={t("media.imageModelPlaceholder")}
        items={models.map((model) => ({
          id: model.alias,
          label: model.label || model.alias,
          detail: model.media ? t("media.mediaModel") : undefined,
        }))}
        value={imageModel}
        onChange={setImageModel}
        isDisabled={pending}
      />
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
