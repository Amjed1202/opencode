import { app, BrowserWindow, dialog, net, protocol, safeStorage, session } from "electron"
import { mkdir, realpath, readdir } from "node:fs/promises"
import { dirname, join, delimiter, isAbsolute } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { buildNativeEnvironment } from "../../../harness-control-plane/src/environment"
import { desktopChannels } from "../shared/contracts"
import type { DesktopState } from "../shared/contracts"
import { HostClient } from "./host-client"
import { loadOrCreateArtifactKey } from "./vault"
import { registerDesktopIpc } from "./ipc"
import { nativeCopy } from "./copy"

const documentUrl = "harness://desktop/index.html"
const here = dirname(fileURLToPath(import.meta.url))
const option = (name: string) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const selectedData = option("--harness-data") ?? join(app.getPath("appData"), "Harness-development")
if (!isAbsolute(selectedData)) throw new Error("Harness storage path must be absolute")
app.setName("Harness")
app.setPath("userData", selectedData)
protocol.registerSchemesAsPrivileged([
  { scheme: "harness", privileges: { standard: true, secure: true, supportFetchAPI: true } },
])
let host: HostClient | undefined
let closing = false

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on("before-quit", (event) => {
    if (!host || closing) return
    event.preventDefault()
    closing = true
    void host.close().finally(() => app.quit())
  })
  app.on("window-all-closed", () => app.quit())
  void app
    .whenReady()
    .then(async () => {
      await mkdir(selectedData, { recursive: true, mode: 0o700 })
      const directory = await realpath(selectedData)
      const executable = option("--harness-bun") ?? process.env.HARNESS_BUN_EXECUTABLE
      if (!executable || !isAbsolute(executable)) throw new Error("Explicit Bun executable is required")
      const bun = await realpath(executable)
      const toolPath =
        option("--harness-tool-path") ??
        [
          dirname(bun),
          ...(process.platform === "win32" && process.env.SYSTEMROOT
            ? [join(process.env.SYSTEMROOT, "System32")]
            : ["/usr/bin", "/bin"]),
        ].join(delimiter)
      const environment = buildNativeEnvironment({ inherited: process.env, home: app.getPath("home"), path: toolPath })
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      session.defaultSession.setPermissionCheckHandler(() => false)
      const renderer = join(here, "../renderer")
      const files = await readdir(renderer, { recursive: true, withFileTypes: true })
      const assets = new Map(
        files
          .filter((file) => file.isFile())
          .map((file) => {
            const path = join(file.parentPath, file.name)
            return [pathToFileURL(path).pathname.slice(pathToFileURL(renderer + "/").pathname.length), path]
          }),
      )
      protocol.handle("harness", (request) => {
        const url = new URL(request.url)
        const asset = assets.get(url.pathname.slice(1))
        if (request.method !== "GET" || url.hostname !== "desktop" || url.search || !asset)
          return new Response("Unavailable", { status: 404 })
        return net.fetch(pathToFileURL(asset).href).then((response) => {
          const headers = new Headers(response.headers)
          headers.set(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
          )
          return new Response(response.body, { status: response.status, headers })
        })
      })
      const window = new BrowserWindow({
        width: 1360,
        height: 900,
        minWidth: 760,
        minHeight: 620,
        title: nativeCopy.title,
        backgroundColor: "#f8fafb",
        show: false,
        webPreferences: {
          preload: join(here, "../preload/index.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          webviewTag: false,
          devTools: false,
        },
      })
      window.removeMenu()
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
      window.webContents.on("will-navigate", (event) => event.preventDefault())
      window.webContents.on("will-frame-navigate", (event) => event.preventDefault())
      window.webContents.on("will-attach-webview", (event) => event.preventDefault())
      let lastState: DesktopState | undefined
      const changed = (state: DesktopState) => {
        lastState = state
        if (
          !window.isDestroyed() &&
          window.webContents.getURL() === documentUrl &&
          window.webContents.mainFrame.url === documentUrl
        )
          window.webContents.send(desktopChannels.changed, state)
      }
      host = new HostClient({
        executable: bun,
        worker: join(here, "../host/index.js"),
        environment,
        changed,
        failed: () => {
          if (closing || window.isDestroyed()) return
          window.setTitle(nativeCopy.disconnectedTitle)
          if (lastState)
            changed({
              ...lastState,
              revision: lastState.revision + 1,
              connection: { ...lastState.connection, status: "blocked", reason: nativeCopy.disconnected },
              ...(lastState.session ? { session: { ...lastState.session, status: "uncertain" } } : {}),
              permissions: [],
              inputs: [],
              models: {
                status: lastState.configuration.runtime === "claude" ? "unsupported" : "unavailable",
                items: [],
              },
              notices: [nativeCopy.disconnected],
            })
        },
      })
      const key = await loadOrCreateArtifactKey({ directory, safeStorage })
      try {
        lastState = (await host.request("initialize", {
          directory,
          key: Buffer.from(key).toString("base64"),
          environment,
          toolPath,
        })) as DesktopState
      } finally {
        key.fill(0)
      }
      const unregister = registerDesktopIpc(window, host, documentUrl)
      window.on("closed", unregister)
      await window.loadURL(documentUrl)
      window.show()
    })
    .catch(async () => {
      await host?.close()
      dialog.showErrorBox(nativeCopy.title, nativeCopy.unavailable)
      closing = true
      app.quit()
    })
}
