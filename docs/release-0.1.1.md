# Git marketplace distribution 0.1.1

The repository root exposes `.agents/plugins/marketplace.json`, selecting `./plugins/research-locus`. That directory contains the portable manifest, OpenAI compatibility metadata, stdio launcher, prebuilt browser UI, fully bundled server, skill, icon and dependency notices. Researchers need Node.js 22+ but no npm dependency install or compiler.

The official `global` entrypoint and monochrome server icon are advertised over MCP. A host that implements OpenAI MCP Extensions can surface them in primary navigation. No server-side pin API exists in the audited spec; native placement and any Pin menu remain host-controlled and unverified here.

## Local verification on Windows

- TypeScript check, 42 tests and build: PASS.
- Copy of installable plugin outside the source tree, in a path containing spaces, without node_modules: PASS.
- Stdio discovery: 13 tools, global entrypoint metadata and fallback icon asserted; initial home renders catalog: PASS.
- Two independent persisted sessions and restart recovery: PASS.
- HTTP preview delivers the exact packaged HTML (apart from its routing token): PASS.
- Native desktop installation, sidebar visibility/Pin, actual host file bridge and cross-platform execution: NOT_RUN.

Run `npm run build:marketplace` then `npm run smoke:marketplace` to reproduce packaging checks. Result is written to ignored `artifacts/marketplace-verification.json`; installed BUILD.json contains build digests. Earlier docs describe the 0.1.0 local prototype; their screenshots and local exports are not shipped with this repository. The current tutorial is `docs/install-and-use.zh-CN.md`.

This release keeps the existing repository license and excludes saved research sessions, private configuration, access tokens, node_modules, development logs and prior research exports. It does not deploy a remote MCP service or publish to the OpenAI universal directory.
