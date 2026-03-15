declare module "electron" {
  export const app: any
  export const BrowserWindow: any
  export const Menu: any
  export const clipboard: any
  export const dialog: any
  export const ipcMain: any
  export const ipcRenderer: any
  export const shell: any
  export const contextBridge: any
  export const nativeTheme: any
}

declare module "localtunnel" {
  type LocalTunnelHandle = {
    url: string
    close: () => void | Promise<void>
    on?: (event: "error" | "close", listener: (...args: any[]) => void) => void
    off?: (event: "error" | "close", listener: (...args: any[]) => void) => void
    removeListener?: (event: "error" | "close", listener: (...args: any[]) => void) => void
  }

  export default function localtunnel(input: {
    port: number
    local_host?: string
  }): Promise<LocalTunnelHandle>
}
