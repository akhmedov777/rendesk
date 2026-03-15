import type { Component } from "solid-js"
import type { IconProps } from "@rendesk/ui/icon"
import { createSimpleContext } from "@rendesk/ui/context"

export type SettingsDialogTab = {
  value: string
  label: string
  icon?: IconProps["name"]
  component: Component
}

export const { use: useSettingsDialogTabs, provider: SettingsDialogTabsProvider } = createSimpleContext({
  name: "SettingsDialogTabs",
  init: (props: { value: SettingsDialogTab[] }) => props.value,
})
