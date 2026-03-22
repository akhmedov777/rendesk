import { type Component } from "solid-js"
import { Dialog } from "@rendesk/ui/dialog"

export const DialogSelectProvider: Component = () => {
  return (
    <Dialog title="Managed providers">
      <div class="px-2.5 pb-4 text-14-regular text-text-base">
        Provider connections are managed by infrastructure in this desktop build.
      </div>
    </Dialog>
  )
}
