import { Component } from "solid-js"
import { For, Show } from "solid-js"
import { Dialog } from "@rendesk/ui/dialog"
import { Tabs } from "@rendesk/ui/tabs"
import { Icon } from "@rendesk/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettingsDialogTabs } from "@/context/settings-dialog-tabs"
import { SettingsGeneral } from "./settings-general"
import { SettingsKeybinds } from "./settings-keybinds"
import { Dynamic } from "solid-js/web"

export const DialogSettings: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const extraTabs = useSettingsDialogTabs()

  return (
    <Dialog size="x-large" transition>
      <Tabs orientation="vertical" variant="settings" defaultValue="general" class="h-full settings-dialog">
        <Tabs.List>
          <div class="flex flex-col justify-between h-full w-full">
            <div class="flex flex-col gap-3 w-full pt-3">
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.desktop")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="general">
                      <Icon name="sliders" />
                      {language.t("settings.tab.general")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="shortcuts">
                      <Icon name="keyboard" />
                      {language.t("settings.tab.shortcuts")}
                    </Tabs.Trigger>
                    <For each={extraTabs}>
                      {(tab) => (
                        <Tabs.Trigger value={tab.value}>
                          <Show when={tab.icon}>
                            {(icon) => <Icon name={icon()} />}
                          </Show>
                          {tab.label}
                        </Tabs.Trigger>
                      )}
                    </For>
                  </div>
                </div>
              </div>
            </div>
            <div class="flex flex-col gap-1 pl-1 py-1 text-12-medium text-text-weak">
              <span>{language.t("app.name.desktop")}</span>
              <span class="text-11-regular">v{platform.version}</span>
            </div>
          </div>
        </Tabs.List>
        <Tabs.Content value="general" class="no-scrollbar">
          <SettingsGeneral />
        </Tabs.Content>
        <Tabs.Content value="shortcuts" class="no-scrollbar">
          <SettingsKeybinds />
        </Tabs.Content>
        <For each={extraTabs}>
          {(tab) => (
            <Tabs.Content value={tab.value} class="no-scrollbar">
              <Dynamic component={tab.component} />
            </Tabs.Content>
          )}
        </For>
      </Tabs>
    </Dialog>
  )
}
