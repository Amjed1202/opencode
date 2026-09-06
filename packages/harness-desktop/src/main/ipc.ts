import { dialog, ipcMain } from "electron"
import type { BrowserWindow } from "electron"
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { basename } from "node:path"
import { desktopChannels } from "../shared/contracts"
import type { DesktopConfiguration, DesktopOperation, DesktopState } from "../shared/contracts"
import { decodeDesktopRequest } from "../shared/requests"
import { createSenderGuard } from "./security"
import type { HostClient } from "./host-client"
import { nativeCopy } from "./copy"

export function registerDesktopIpc(window: BrowserWindow, host: HostClient, documentUrl: string) {
  const guard = createSenderGuard(window.webContents, documentUrl)
  const registered: string[] = []
  let choosing = false
  for (const [method, channel] of Object.entries(desktopChannels)) {
    if (method === "changed") continue
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      guard(event)
      if (args.length > 1) throw new Error("Invalid desktop request")
      if (method === "selectRuntime" && choosing) throw new Error("Finish the current file selection first")
      if (method.startsWith("choose")) {
        decodeDesktopRequest("getState", args[0])
        if (choosing) throw new Error("Finish the current folder or file selection first")
        choosing = true
        try {
          const current = (await host.request("getState")) as DesktopState
          guard(event)
          if (current.session) throw new Error("Restart before changing an attached session")
          const title =
            method === "chooseWorkspace"
              ? nativeCopy.repository
              : method === "chooseRuntime"
                ? current.configuration.runtime === "claude"
                  ? nativeCopy.claudeRuntime
                  : nativeCopy.runtime
                : method === "chooseNativeHome"
                  ? current.configuration.runtime === "claude"
                    ? nativeCopy.claudeHome
                    : nativeCopy.home
                  : nativeCopy.skills
          const selection = await dialog.showOpenDialog(window, {
            title,
            properties: method === "chooseRuntime" ? ["openFile"] : ["openDirectory"],
          })
          guard(event)
          if (selection.canceled || selection.filePaths.length !== 1) return current
          const path = await realpath(selection.filePaths[0]!)
          guard(event)
          const configuration: DesktopConfiguration = {
            ...current.configuration,
            ...(method === "chooseWorkspace"
              ? {
                  workspace: {
                    id: createHash("sha256")
                      .update(process.platform === "win32" ? path.toLowerCase() : path)
                      .digest("hex"),
                    name: basename(path),
                    path,
                  },
                }
              : method === "chooseRuntime"
                ? { executable: path }
                : method === "chooseNativeHome"
                  ? { nativeHome: path }
                  : { userSkillsRoot: path }),
          }
          const state = await host.request("configure", configuration)
          guard(event)
          return state
        } finally {
          choosing = false
        }
      }
      const operation = method as DesktopOperation
      const input = decodeDesktopRequest(operation, args[0])
      const result = await host.request(operation, input)
      guard(event)
      return result
    })
    registered.push(channel)
  }
  return () => registered.forEach((channel) => ipcMain.removeHandler(channel))
}
