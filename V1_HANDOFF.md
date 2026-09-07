# Harness V1 RC3 handoff

RC3 is the current unsigned Windows x64 release candidate. Its application source is committed as `4e47763ddf193a7cd6cc431378fb6c68d069244e` and was verified on the fork's `runtime-foundation` branch. [Source commit](https://github.com/Amjed1202/opencode/commit/4e47763ddf193a7cd6cc431378fb6c68d069244e).

## Open the application

The existing unpacked application is `outputs/Harness-windows-x64-v1-rc3/Harness.exe` in the task workspace, beside this repository. Run that executable with its entire folder intact.

For a separate copy, fully extract `outputs/Harness-windows-x64-v1-rc3-59a991f7.zip` into a new empty folder, then run `Harness.exe` inside the extracted application folder. Do not run it directly from Explorer's ZIP view. Bun and Electron are included; native Codex and Claude executables are selected separately.

Archive size: **186,545,461 bytes**. SHA-256:

```text
4b9a1838a0ce11ce66b4438c3d31a4cddcc28faead7d09df8efd62e3e9c11812
```

The application keeps private history and encrypted reviews under `%APPDATA%\Harness`. Keep this data separate from repositories and native account directories. [Full setup and storage instructions](DESKTOP.md), [package verification](docs/validation/v1-rc3-package-evidence.md).

## Connect a runtime

Use the app's pickers to select a repository, the native executable and its account home. Supported versions are **Codex 0.153.4** and **Claude Code 2.1.251**. Authentication remains in the selected native runtime. Check the connection, explicitly choose a model, review the spending/boundary acknowledgments, and start a conversation. Sending a prompt is a separate action.

Codex requires relevant file contents in the prompt; native repository browsing, shell commands and test execution are disabled. Exact workspace patches require protected review. Claude supports bounded Read/Edit/Write tools and explicitly selected compatible standalone Skills. Supporting Skill resources, arbitrary plugins, hooks, shell tools and subagents are outside this candidate. [Skill compatibility and activation](CLAUDE_SKILLS.md).

## Verified and outstanding

- Codex live denial, protected approval, fixed fixture tests, interruption, saved history and exact resume passed.
- RC3 local validation passed **772 unit/process tests** and **23 browser/Electron tests**, with two platform skips. Typechecks, build and every packaged/archive file passed verification. Lint has zero errors and 502 recorded warnings.
- Claude native subscription admission, model selection and input acknowledgment were observed. Its first live input received a weekly rate-limit rejection before any tools or Skill invocation. The provider reported a reset at **September 10, 2026, 03:00 Europe/Rome**; future availability must be checked again.
- Claude live denial, approval, standalone Skill invocation, interruption and exact resume remain pending. The failed input is uncertain and must not be automatically replayed. Successful process cleanup does not settle it.

The approved live budgets remain **Codex 4/4** and **Claude 1/4**. The remaining Claude sequence needs four new inputs; three are still authorized. Completing that sequence requires an additional prompt allowance or an explicitly revised scope. No provider test, limit increase, spending-setting change or API fallback is triggered by opening the app or reading this guide.

This candidate has one attached conversation at a time and an unsigned portable package. OpenCode execution, collaboration, remote nodes, installers, signing and updates are later milestones. [Acceptance status](V1_STATUS.md), [test records and limitations](VALIDATION.md).
