import { Dialog } from "@rendesk/ui/dialog"

export function DialogConnectProvider(_props: { provider: string }) {
  return (
    <Dialog title="Managed providers">
      <div class="px-2.5 pb-4 text-14-regular text-text-base">
        Provider authentication is managed by infrastructure in this desktop build.
      </div>
    </Dialog>
  )
}
