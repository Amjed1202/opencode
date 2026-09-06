export interface TrustedWebContents {
  readonly mainFrame: { readonly url: string }
  getURL(): string
  isDestroyed(): boolean
}

export interface DesktopIpcEvent {
  readonly sender: TrustedWebContents
  readonly senderFrame: { readonly url: string } | null
}

/** Re-run after awaited work before returning private content to a renderer. */
export function assertTrustedSender(event: DesktopIpcEvent, contents: TrustedWebContents, documentUrl: string): void {
  if (
    !validDocumentUrl(documentUrl) ||
    event.sender !== contents ||
    contents.isDestroyed() ||
    event.senderFrame !== contents.mainFrame ||
    event.senderFrame?.url !== documentUrl ||
    contents.getURL() !== documentUrl
  )
    throw new Error("Untrusted desktop IPC sender")
}

export function createSenderGuard(contents: TrustedWebContents, documentUrl: string) {
  if (!validDocumentUrl(documentUrl)) throw new Error("Invalid desktop document URL")
  return (event: DesktopIpcEvent) => assertTrustedSender(event, contents, documentUrl)
}

function validDocumentUrl(value: string) {
  try {
    const url = new URL(value)
    return (
      url.protocol === "harness:" &&
      url.hostname === "desktop" &&
      url.pathname === "/index.html" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href === value
    )
  } catch {
    return false
  }
}
