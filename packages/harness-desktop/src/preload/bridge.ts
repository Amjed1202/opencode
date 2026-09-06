import type { InteractionReview } from "@harness/protocol"
import { desktopChannels } from "../shared/contracts"
import type { DesktopAPI, DesktopState } from "../shared/contracts"

export interface PreloadIpc {
  invoke(channel: string, input?: unknown): Promise<unknown>
  on(channel: string, listener: (event: unknown, state: DesktopState) => void): unknown
  removeListener(channel: string, listener: (event: unknown, state: DesktopState) => void): unknown
}

/** Only these fixed application operations cross contextBridge; Electron events stay private. */
export function createDesktopBridge(ipc: PreloadIpc): DesktopAPI {
  const subscriptions = new Set<(event: unknown, state: DesktopState) => void>()
  return Object.freeze({
    getState: () => ipc.invoke(desktopChannels.getState) as Promise<DesktopState>,
    chooseWorkspace: () => ipc.invoke(desktopChannels.chooseWorkspace) as Promise<DesktopState>,
    chooseRuntime: () => ipc.invoke(desktopChannels.chooseRuntime) as Promise<DesktopState>,
    selectRuntime: (input) => ipc.invoke(desktopChannels.selectRuntime, input) as Promise<DesktopState>,
    chooseNativeHome: () => ipc.invoke(desktopChannels.chooseNativeHome) as Promise<DesktopState>,
    chooseSkillsRoot: () => ipc.invoke(desktopChannels.chooseSkillsRoot) as Promise<DesktopState>,
    refresh: () => ipc.invoke(desktopChannels.refresh) as Promise<DesktopState>,
    start: (input) => ipc.invoke(desktopChannels.start, input) as Promise<DesktopState>,
    send: (input) => ipc.invoke(desktopChannels.send, input) as Promise<DesktopState>,
    interrupt: () => ipc.invoke(desktopChannels.interrupt) as Promise<DesktopState>,
    review: (input) => ipc.invoke(desktopChannels.review, input) as Promise<InteractionReview>,
    resolvePermission: (input) => ipc.invoke(desktopChannels.resolvePermission, input) as Promise<DesktopState>,
    resolveInput: (input) => ipc.invoke(desktopChannels.resolveInput, input) as Promise<DesktopState>,
    onState(listener) {
      if (typeof listener !== "function" || subscriptions.size >= 32) throw new Error("Invalid desktop subscription")
      const receive = (_event: unknown, state: DesktopState) => listener(state)
      subscriptions.add(receive)
      ipc.on(desktopChannels.changed, receive)
      return () => {
        if (!subscriptions.delete(receive)) return
        ipc.removeListener(desktopChannels.changed, receive)
      }
    },
  } satisfies DesktopAPI)
}
