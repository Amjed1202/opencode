export const nativeCopy = {
  title: "Harness",
  repository: "Choose a repository",
  runtime: "Choose the Codex executable",
  claudeRuntime: "Choose the Claude Code executable",
  home: "Choose the native account home containing .codex",
  claudeHome: "Choose the native account home containing .claude",
  skills: "Choose a user Claude Skills folder",
  unavailable:
    "Harness could not open its protected local storage or Bun host. Check the launch configuration. No provider task was started.",
  disconnectedTitle: "Harness — host disconnected",
  disconnected:
    "The local host disconnected. Native work may have an uncertain outcome. Restart and inspect native state before continuing; automatic replay is disabled.",
} as const
