import { Dialog } from "@rendesk/ui/dialog"

type Props = {
  back?: "providers" | "close"
}

export function DialogCustomProvider(_props: Props) {
  return (
    <Dialog title="Managed providers">
      <div class="px-2.5 pb-4 text-14-regular text-text-base">
        Custom providers are disabled. Provider configuration is managed by infrastructure in this desktop build.
      </div>
    </Dialog>
  )
}
