import { createEffect, createMemo, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { IconButton } from "@rendesk/ui/icon-button"
import { Icon } from "@rendesk/ui/icon"
import { Button } from "@rendesk/ui/button"
import { Tooltip, TooltipKeybind } from "@rendesk/ui/tooltip"
import { useTheme } from "@rendesk/ui/theme"

import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { applyPath, backPath, forwardPath } from "./titlebar-history"

const desktopBridge = () =>
  (window as typeof window & {
    __BACKOFFICE__?: {
      setTheme?: (theme: "light" | "dark" | null) => Promise<void>
      toggleMaximize?: () => Promise<void>
      minimize?: () => Promise<void>
      close?: () => Promise<void>
    }
  }).__BACKOFFICE__

export function Titlebar() {
  const layout = useLayout()
  const platform = usePlatform()
  const command = useCommand()
  const language = useLanguage()
  const theme = useTheme()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()

  const mac = createMemo(() => platform.platform === "desktop" && platform.os === "macos")
  const windows = createMemo(() => platform.platform === "desktop" && platform.os === "windows")
  const web = createMemo(() => platform.platform === "web")
  const zoom = () => platform.webviewZoom?.() ?? 1
  const minHeight = () => (mac() ? `${40 / zoom()}px` : undefined)

  const [history, setHistory] = createStore({
    stack: [] as string[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`

  createEffect(() => {
    const current = path()

    untrack(() => {
      const next = applyPath(history, current)
      if (next === history) return
      setHistory(next)
    })
  })

  const canBack = createMemo(() => history.index > 0)
  const canForward = createMemo(() => history.index < history.stack.length - 1)

  const back = () => {
    const next = backPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  const forward = () => {
    const next = forwardPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  command.register(() => [
    {
      id: "common.goBack",
      title: language.t("common.goBack"),
      category: language.t("command.category.view"),
      keybind: "mod+[",
      onSelect: back,
    },
    {
      id: "common.goForward",
      title: language.t("common.goForward"),
      category: language.t("command.category.view"),
      keybind: "mod+]",
      onSelect: forward,
    },
  ])

  createEffect(() => {
    if (platform.platform !== "desktop") return

    const scheme = theme.colorScheme()
    const value = scheme === "system" ? null : scheme

    void desktopBridge()?.setTheme?.(value).catch(() => undefined)
  })

  const interactive = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false

    const selector =
      "button, a, input, textarea, select, option, [role='button'], [role='menuitem'], [contenteditable='true'], [contenteditable='']"

    return !!target.closest(selector)
  }

  const drag = (e: MouseEvent) => {
    if (platform.platform !== "desktop") return
    if (e.buttons !== 1) return
    if (interactive(e.target)) return
  }

  const maximize = (e: MouseEvent) => {
    if (platform.platform !== "desktop") return
    if (interactive(e.target)) return
    if (e.target instanceof Element && e.target.closest("[data-window-controls-anchor]")) return

    e.preventDefault()
    void desktopBridge()?.toggleMaximize?.().catch(() => undefined)
  }

  return (
    <header
      class="h-10 shrink-0 bg-background-base relative grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center"
      style={{ "min-height": minHeight() }}
      data-window-drag-region
      onMouseDown={drag}
      onDblClick={maximize}
    >
      <div
        classList={{
          "flex items-center min-w-0": true,
          "pl-2": !mac(),
        }}
      >
        <Show when={mac()}>
          <div class="h-full shrink-0" style={{ width: `${72 / zoom()}px` }} />
          <div class="xl:hidden w-10 shrink-0 flex items-center justify-center">
            <IconButton
              icon="menu"
              variant="ghost"
              class="titlebar-icon rounded-md"
              onClick={layout.mobileSidebar.toggle}
              aria-label={language.t("sidebar.menu.toggle")}
              aria-expanded={layout.mobileSidebar.opened()}
            />
          </div>
        </Show>
        <Show when={!mac()}>
          <div class="xl:hidden w-[48px] shrink-0 flex items-center justify-center">
            <IconButton
              icon="menu"
              variant="ghost"
              class="titlebar-icon rounded-md"
              onClick={layout.mobileSidebar.toggle}
              aria-label={language.t("sidebar.menu.toggle")}
              aria-expanded={layout.mobileSidebar.opened()}
            />
          </div>
        </Show>
        <div class="flex items-center gap-1 shrink-0">
          <TooltipKeybind
            class={web() ? "hidden xl:flex shrink-0 ml-14" : "hidden xl:flex shrink-0 ml-2"}
            placement="bottom"
            title={language.t("command.sidebar.toggle")}
            keybind={command.keybind("sidebar.toggle")}
          >
            <Button
              variant="ghost"
              class="group/sidebar-toggle titlebar-icon w-8 h-6 p-0 box-border"
              onClick={layout.sidebar.toggle}
              aria-label={language.t("command.sidebar.toggle")}
              aria-expanded={layout.sidebar.opened()}
            >
              <div class="relative flex items-center justify-center size-4 [&>*]:absolute [&>*]:inset-0">
                <Icon
                  size="small"
                  name={layout.sidebar.opened() ? "layout-left-partial" : "layout-left"}
                  class="group-hover/sidebar-toggle:hidden"
                />
                <Icon size="small" name="layout-left-partial" class="hidden group-hover/sidebar-toggle:inline-block" />
                <Icon
                  size="small"
                  name={layout.sidebar.opened() ? "layout-left" : "layout-left-partial"}
                  class="hidden group-active/sidebar-toggle:inline-block"
                />
              </div>
            </Button>
          </TooltipKeybind>
          <div class="hidden xl:flex items-center shrink-0">
            <Show when={params.dir}>
              <TooltipKeybind
                placement="bottom"
                title={language.t("command.session.new")}
                keybind={command.keybind("session.new")}
                openDelay={2000}
              >
                <Button
                  variant="ghost"
                  icon="new-session"
                  class="titlebar-icon w-8 h-6 p-0 box-border"
                  onClick={() => {
                    if (!params.dir) return
                    navigate(`/${params.dir}/session`)
                  }}
                  aria-label={language.t("command.session.new")}
                />
              </TooltipKeybind>
            </Show>
            <div class="flex items-center gap-0" classList={{ "ml-1": !!params.dir }}>
              <Tooltip placement="bottom" value={language.t("common.goBack")} openDelay={2000}>
                <Button
                  variant="ghost"
                  icon="chevron-left"
                  class="titlebar-icon w-6 h-6 p-0 box-border"
                  disabled={!canBack()}
                  onClick={back}
                  aria-label={language.t("common.goBack")}
                />
              </Tooltip>
              <Tooltip placement="bottom" value={language.t("common.goForward")} openDelay={2000}>
                <Button
                  variant="ghost"
                  icon="chevron-right"
                  class="titlebar-icon w-6 h-6 p-0 box-border"
                  disabled={!canForward()}
                  onClick={forward}
                  aria-label={language.t("common.goForward")}
                />
              </Tooltip>
            </div>
          </div>
        </div>
        <div id="opencode-titlebar-left" class="flex items-center gap-3 min-w-0 px-2" />
      </div>

      <div class="min-w-0 flex items-center justify-center pointer-events-none">
        <div id="opencode-titlebar-center" class="pointer-events-auto min-w-0 flex justify-center w-fit max-w-full" />
      </div>

      <div
        classList={{
          "flex items-center min-w-0 justify-end": true,
          "pr-2": !windows(),
        }}
        data-window-drag-region
        onMouseDown={drag}
      >
        <div id="opencode-titlebar-right" class="flex items-center gap-1 shrink-0 justify-end" />
        <Show when={windows()}>
          <div class="w-6 shrink-0" />
          <div data-window-controls-anchor class="flex flex-row">
            <button
              class="w-[46px] h-10 inline-flex items-center justify-center text-foreground-dimmed hover:bg-black/10 dark:hover:bg-white/10"
              onClick={() => void desktopBridge()?.minimize?.().catch(() => undefined)}
              aria-label="Minimize"
            >
              <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
                <rect width="10" height="1" />
              </svg>
            </button>
            <button
              class="w-[46px] h-10 inline-flex items-center justify-center text-foreground-dimmed hover:bg-black/10 dark:hover:bg-white/10"
              onClick={() => void desktopBridge()?.toggleMaximize?.().catch(() => undefined)}
              aria-label="Maximize"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1">
                <rect x="0.5" y="0.5" width="9" height="9" />
              </svg>
            </button>
            <button
              class="w-[46px] h-10 inline-flex items-center justify-center text-foreground-dimmed hover:bg-[#c42b1c] hover:text-white"
              onClick={() => void desktopBridge()?.close?.().catch(() => undefined)}
              aria-label="Close"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1">
                <line x1="0" y1="0" x2="10" y2="10" />
                <line x1="10" y1="0" x2="0" y2="10" />
              </svg>
            </button>
          </div>
        </Show>
      </div>
    </header>
  )
}
