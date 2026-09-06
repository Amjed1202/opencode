import { contextBridge, ipcRenderer } from "electron"
import { createDesktopBridge } from "./bridge"

contextBridge.exposeInMainWorld("harness", createDesktopBridge(ipcRenderer))
