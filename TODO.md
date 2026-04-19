# TODO

Post-publish follow-ups deferred from the v1.2.0 release (`mistakes_in_scope`). None block a release; all cause friction within a few releases if ignored.

## 1. Add a LICENSE file

`package.json` declares `"license": "ISC"` but no `LICENSE` file exists in the repo. The npm tarball ships with no license text. Add a top-level `LICENSE` file with the ISC license body and commit in a standalone chore commit.

## 2. Add `.gitattributes` to pin line endings

No `.gitattributes` exists. On Windows, `git diff` emits "LF will be replaced by CRLF" warnings for every modified text file; cross-platform collaborators will see line-ending churn. Add:

```
* text=auto eol=lf
```

Commit in a standalone chore commit. Consider running `git add --renormalize .` afterward so existing files are normalized in one commit.

## 3. Exclude test files and source maps from the npm tarball

`npm publish --dry-run` for v1.2.0 showed ~160 kB of test code shipping to end users (`dist/*/smoke-test.js`, `dist/capture/drafter.test.js`, `dist/capture/hook.test.js`, `dist/ledger/dogfood.js`, `dist/smoke.js`, `dist/smoke-drafter.js`, plus their `.js.map` and `.d.ts` files). Source maps dominate the unpacked size (541 kB total). Pre-existing — was already shipping in v1.1.0.

Options, least invasive first:
- Add a `.npmignore` covering `dist/**/smoke-test.*`, `dist/**/*.test.*`, `dist/smoke.*`, `dist/smoke-drafter.*`, `dist/ledger/dogfood.*`. Source maps stay.
- Add a `tsconfig.build.json` with `"exclude": ["src/**/smoke-test.ts", "src/**/*.test.ts", "src/smoke.ts", "src/smoke-drafter.ts", "src/ledger/dogfood.ts"]` and point `prepublishOnly` at it. Test files are not emitted to `dist/` at all.
- Turn off `"sourceMap"` in `tsconfig.json` for the publish build if debuggability isn't worth the weight.

The second option is cleanest but requires threading both tsconfigs through the `build` and `prepublishOnly` scripts.

## 4. Fix `src/ledger/dogfood.js` to write to a tempdir

`npm run test:dogfood` writes to the real project `.context-ledger/ledger.jsonl` instead of an isolated tempdir. Running dogfood during the v1.2.0 audit appended a duplicate decision entry (`d_1776619826_2d69`, "Event fold uses log order not timestamp order") that had to be reverted before commit. All other smoke tests correctly use `mkdtemp`; dogfood is the outlier.

Fix: mirror the `mkdtemp(join(tmpdir(), "cl-dogfood-"))` pattern used in `src/retrieval/smoke-test.ts` and `src/smoke.ts`. Clean up with `rm(dir, { recursive: true, force: true })` in a `finally`. No other changes needed — the test's assertions don't depend on the ledger path.
