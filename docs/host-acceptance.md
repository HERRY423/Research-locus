# Native host acceptance

Status: **NOT_RUN**. A local browser, an SDK schema pass, and an in-memory MCP client are not a ChatGPT installation test.

Use [the friend installation guide](friend-install.zh-CN.md) for the packaged launcher and local marketplace. The [current spec audit](spec-audit-2026-10-05.md) supersedes earlier settings-entrypoint descriptions. Structured settings are not implemented.

Use a clean profile or test installation of the built plugin. Do not register a public endpoint until authentication and data isolation are implemented.

1. Confirm installed package version 0.1.1 and BUILD.json digests. Server initialization and tools/list must succeed with no stdout logging outside MCP.
2. Open the global sidebar entry with empty arguments. It must render the standalone project/recent-session home (`ui://research-locus/home`, preferred fullscreen), without an embedded workbench sidebar or another open call. Create a project and two sessions; open each and return home, confirming separate saved records. Open the distinct thread panel beside the conversation and verify it still renders the workbench.
3. Open an allowed `.md` or `.csv` file. Check that its host-provided `resourceUri` is read through the resource bridge. Opening alone must not attach it or run analysis. Unsupported or oversized input must fail visibly.
4. Search composer mentions; choose a claim or evidence resource and confirm resources/read returns exactly that object, including after new attachment. Confirm another URI cannot exploit a matching substring.
5. Select evidence and sync context. Check exact session, project, revision, hash and IDs, without hidden attachment bytes. Send a conflicting/stale model context, including a different session in the same project, and verify it does not change the selected claim. Test a valid deep link.
6. Request targeted review by clicking the control. Confirm request versus completed finding are distinct; submit a finding with the exact current snapshot, then verify it appears.
7. Pause review. Agent submission must fail; resume explicitly. Record an intervention and inspect its rationale and unauthenticated identity label. Change a claim and verify historical decisions are stale and retained.
8. Test native resource picker on a supporting direct MCP client; test unsupported fallback. Registered-server MRTR is a known gap, not an accepted path.
9. Test host file editor with a writable resource and ETag, including initial file entry and returning from home to the same session. Induce a conflict; no silent overwrite may occur. Switching to a different session must clear the previous file's staged content and write handle. Read-only resources and missing version markers must block saving. Reimport changed bytes to trigger stale review state.
10. Restart the server and confirm persistence. Attempt concurrent stale edits and malformed input. Record host version, OS, account surface, installed artifact digests, failures and screenshots.

Production human decisions require an independently authenticated researcher session. No amount of prototype UI clicking, token validation or Agent agreement establishes that identity or scientific validity.
