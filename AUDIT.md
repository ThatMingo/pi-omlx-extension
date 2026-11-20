# Pi oMLX extension audit

20 November 2026

## Verdict

Use `refactor/62sol-codex`. The comparison branch is an improvement over the local snapshot. It simplifies the refresh code, fixes image capability detection, and reports missing-Pi tests accurately. The audit branch keeps those changes and uses the reasoning levels that oMLX now publishes. It also fixes cases where both reviewed versions could send inference to the wrong URL or replace a healthy catalog with invalid data.

The original folder was a file snapshot without Git metadata. Every TypeScript file, test fixture and package configuration matched `main` byte for byte. The local README differed in naming, examples and repository notes, and the snapshot omitted `.gitignore`. I created the work branch from `main` in a separate local clone and used its README as the base. [Comparison commit and diff](https://github.com/ThatMingo/pi-omlx-extension/compare/4edc613c48f2082808c2f20a740c429e2d26b4d0...ae69849733148d69d94fb18115a478fa01620199)

| Version | Runtime lines across two files | Tests against Pi 1.5.2 |
| --- | ---: | ---: |
| Local snapshot / `main` `4edc613` | 353 | 44 passed |
| `refactor/simplify-omlx-extension` `ae69849` | 277 | 46 passed |
| `refactor/62sol-codex` | 238 | 53 passed |

## Findings and fixes

| Priority | Finding | Fix and evidence |
| --- | --- | --- |
| Medium | The local snapshot inferred thinking controls from template metadata. The comparison branch added family rules but ignored the final `reasoning_levels` array already emitted by oMLX. Models could show stale choices when the server's rules change. | Use the server array, including an explicit empty array. Keep the verified K2 Horizon, DeepSeek V4/V4.1, GPT-OSS and MiniMax M3 rules for older servers. Tests cover missing and unknown stops, toggle-only behavior and the payload Pi builds for a forced-thinking model. [oMLX status route](https://raw.githubusercontent.com/jundot/omlx/main/omlx/server.py) |
| Medium | Both versions added `/v1` for discovery from a bare host but stored the bare host on Pi's models. Pi then sent inference to `/chat/completions` on that host. | Normalize the API base used in discovery, inference and offline restoration. A test against Pi's request builder captures both endpoint URLs. [Pi integration test](test/pi-integration.test.ts) |
| Medium | The local snapshot inferred vision support from `engine_type`. oMLX can serve a text-only Gemma 4 model through its VLM engine. | Adopt the comparison branch's use of `model_type` and verify both text-only and image-capable cases. [oMLX model discovery](https://raw.githubusercontent.com/jundot/omlx/main/omlx/model_discovery.py) |
| Medium | Both versions checked that the status result was an array and trusted its rows. A wrong response such as `{"models":[{}]}` could replace a healthy catalog with an empty one. | Reject malformed model entries before publishing and preserve the current catalog. A successful `{"models":[]}` still clears it. An unusable saved list falls through to Pi's existing catalog. [Refresh tests](test/extension.test.ts) |
| Low | Both versions included server-supplied error codes and raw transport messages in catalog errors. Those strings could include sensitive request details. | Report the endpoint and HTTP status or a local failure description. Tests verify that server error text, malformed JSON and transport errors do not print the mock bearer key. [Catalog tests](test/omlx.test.ts) |
| Low | The original integration suite failed on import when Pi was absent, and startup tests reported passing without exercising Pi. Both reviewed versions also failed typechecking against Pi 1.5.2's persisted model type. TypeScript 6 independently flagged the redundant `baseUrl` setting. | Adopt proper test skips, use Pi's complete chat-model type for persistence, and remove the redundant compiler option. The typecheck now passes with TypeScript 6.0.2. [TypeScript configuration](tsconfig.json) |
| Low | The verification script omitted Pi's saved login and could send inference to an explicitly named unloaded model. It also treated Pi stream error events as successful probes. | Resolve saved API keys through Pi, require the target to be loaded in the status snapshot and fail the check on stream errors. A loopback smoke test verified that a stored mock key authenticated the catalog GET and that an explicitly named unloaded model received no inference request. [Verification script](scripts/verify-omlx.ts) |

## Simplification and preserved behavior

- The two runtime files are 115 lines shorter than `main`. The entry point now handles only Pi registration, offline restoration and generation-checked publication. The other file handles the oMLX request and model mapping.
- Dynamic discovery still replaces the catalog when models are added or removed. Startup still restores reasoning capability before Pi chooses the model, and Pi owns catalog persistence. Publication, cancellation, offline use and changed server URLs are covered by the tests.
- The extension still uses Pi's credentials and native model and thinking selectors. Filtering, token limits, visible reasoning and the existing request format are covered by catalog or Pi integration tests. The extension continues to use a single read-only discovery endpoint.

## Verification and limits

- `npm test` passed all 53 tests with Node 26.5.0 and Pi 1.5.2. With `PI_PACKAGE_DIR` set to an absent path, 37 passed and the 16 Pi-dependent cases were explicitly skipped.
- `npm run typecheck` passed with TypeScript 6.0.2 available on `PATH`. The optional compiler configuration still references the Homebrew Pi install. Tests and the verification script accept `PI_PACKAGE_DIR`.
- `npm run check` passed with oMLX 0.8.0. Pi received three chat models and excluded two drafters and the MarkItDown service. The check captured the reasoning payloads without inference.
- `npm run check:live` passed six probes on the already-loaded `Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS`. All six answered `42`. Thinking off emitted zero reasoning characters. Enabled and clamped levels emitted reasoning and used the expected effort values.
- First startup still uses Pi's available catalog until an initial network refresh succeeds. Alternate model families and catalog changes were verified with fixtures and the mock server. The live catalog contained Qwen models.
