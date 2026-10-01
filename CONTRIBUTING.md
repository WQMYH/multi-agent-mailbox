# Contributing

Open an issue with the operation, expected/actual result, OS and capability/CLI version. Redact credentials, Sharing Links, tokens, message bodies and private conversation identifiers.

Run `npm ci --ignore-scripts --no-audit --no-fund` and `npm test` on Node.js 24+. Tests use isolated fixtures, not production registries or queues. `npm run build` generates ZCode runtime: change `scripts/`, not a second implementation under `modules/agent-zcode/runtime`.

Prefer existing native tools/Hooks or shared CLI/MCP. An adapter keeps its own queue ownership, advertises implemented operations, preserves unknown actions against replay and shares Core's receipt/budget contract. Add a focused regression; native model/application tests require an authorized isolated object. A fixture is not a product certification.

Submit source/tests through a pull request. Do not commit runtime logs, personal configuration, databases, credentials, author work directories or binary release artifacts.
