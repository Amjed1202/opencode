# V1 RC3 Windows package evidence

RC3 was built on 2026-09-07 after the coordinator released the final source freeze. It includes the corrected Claude rate-limit error projection, desktop error presentation and runtime-manager terminal-event delivery fix, together with the Codex pre-write approval controls. Electron is 42.3.3; Bun is 1.3.14, revision `0d9b296af33f2b851fcbf4df3e9ec89751734ba4`.

- Folder: `outputs/Harness-windows-x64-v1-rc3` beside the repository.
- Archive: `outputs/Harness-windows-x64-v1-rc3-59a991f7.zip`, 186,545,461 bytes.
- ZIP SHA-256: `4b9a1838a0ce11ce66b4438c3d31a4cddcc28faead7d09df8efd62e3e9c11812`.
- Manifest SHA-256: `4c17e13b8ca3fb64ed083b560992cd75475b70658926c4fcd4b896bc605c0493`.
- Packaged host SHA-256: `bbca12d7ade825fb03a2cbffa999a8e283a89309f2acf6985c47c2aca625cb92`.

[The package record](v1-rc3-package-results.json) contains 174 source/build/check input hashes across all four Harness packages, including both native adapters, and two packaging-workflow hashes. Those snapshots were captured before building. All six compiled output hashes were captured immediately after the successful build and before either smoke test. Source, workflow and compiled bytes remained unchanged through final recording; every packaged compiled output matches that initial output snapshot.

Desktop typecheck and build passed. Packaging tests passed **6 tests and 29 assertions**. Development and portable Electron smoke tests each passed with **two launches per smoke test**. Portable launch used the bundled Bun executable, minimal system `PATH`, fresh private data and an isolated renderer, with no configured native provider. [Development](v1-rc3-electron-development.log), [portable](v1-rc3-electron-portable.log), [build](v1-rc3-build.log) and [packaging-test](v1-rc3-package-unit.log) logs are retained.

The folder's **96 manifest-listed files** and all **97 ZIP entries**, including the manifest, passed byte-size and SHA-256 checks. There were zero missing files, unexpected entries or hash mismatches. [Archive verification](v1-rc3-archive-verification.json) uses direct .NET SHA-256 and canonical path separators while rejecting duplicate or unexpected entries. Only `Harness.exe` and `resources/runtime/bun.exe` are executable files; native provider binaries and credentials are excluded.

[Preservation checks](v1-rc3-preserved-packages.json) verified RC1 and RC2 folders against every manifest file and their archives against recorded hashes, before and after RC3 work. Forty-one prior evidence files, including the historical and current desktop screenshots, retained their exact hashes. RC3 uses new evidence filenames; earlier candidates and evidence remain intact.

This is an unsigned portable development package without an installer, updater or publication. Packaging submitted zero provider prompts and used no native provider configuration. These startup checks do not establish live provider acceptance; that evidence is recorded separately by the coordinator.
