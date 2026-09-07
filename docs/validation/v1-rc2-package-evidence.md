# V1 RC2 Windows package evidence

RC2 packages the source released by the coordinator on 2026-09-07, including the corrected Codex permission configuration and the updated desktop scope disclosure. It uses Electron 42.3.3 and Bun 1.3.14, revision `0d9b296af33f2b851fcbf4df3e9ec89751734ba4`.

- Folder: `outputs/Harness-windows-x64-v1-rc2` beside the repository.
- Archive: `outputs/Harness-windows-x64-v1-rc2-44d4bf45.zip`, 186,544,738 bytes.
- ZIP SHA-256: `24e4127f90c2634dcde02c3afe56f73fcc9ebc1eee7ab7882c8d1c4abd5630f1`.
- Manifest SHA-256: `95b54c3cfd61c8b5681d58e7ac0195d262e8d3f7300b9f077bd237a3372c8ebe`.

[The package record](v1-rc2-package-results.json) captures 168 source/build input hashes across all four Harness packages, including both native adapters, and all six compiled output hashes. Source hashes stayed unchanged across build and verification. The development smoke was repeated after capturing the full compiled-output snapshot; the portable package matches that snapshot exactly.

Desktop typecheck and build passed. Packaging tests passed 6 tests with 29 assertions. Development and portable Electron smoke tests each passed, with two launches per smoke test. Portable launch used bundled Bun, a minimal system `PATH`, fresh private test data, no configured native account, and an isolated renderer.

The folder's 96 manifest-listed files and all 97 ZIP entries, including the manifest itself, passed byte-size and SHA-256 checks. There were zero missing files, unexpected entries or hash mismatches. Only `Harness.exe` and `resources/runtime/bun.exe` are executable files. The native provider binaries and credentials are excluded.

Two initial scratch ZIP-verifier attempts are preserved: Windows PowerShell did not expose `Get-FileHash`, then its ZIP path separators required normalization. The corrected verifier uses direct .NET SHA-256, normalizes separators while rejecting duplicate/unexpected paths, and passed against unchanged artifact bytes. [The final result](v1-rc2-archive-verification-final.json) and both earlier failures remain recorded.

RC1 artifacts and prior evidence are retained; [preservation checks](v1-rc2-rc1-preservation.json) compare the old folder and archive against the recorded RC1 hashes and confirm the original desktop screenshot was restored.

This is an unsigned portable development package, without an installer, updater or publication. Packaging submitted no provider prompts and does not establish live provider acceptance; that evidence is tracked separately by the coordinator.
