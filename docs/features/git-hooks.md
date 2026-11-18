# Git Hooks

This project uses [Lefthook](https://github.com/evilmartians/lefthook) for Git hooks. Rules live in `lefthook.yml`.

## Pre-commit Behavior

Staged files are checked with Biome to enforce formatting and lint quality, and fixes are staged back. Staged `.ts`, `.tsx`, and `.astro` files also trigger `astro check`, which typechecks the project (`.astro` and `.ts` together) in one pass.

## Commit-msg Behavior

The commit message is checked against Conventional Commits by commitlint. Rules live in `commitlint.config.mjs`; the reasoning, plus the type and scope vocabulary in use, lives in the `conventional-commits` skill.

## Tests

No hook runs `npm test`, and there is no pre-push hook. CI runs it on every push that changes code (see [Continuous integration and deploys](./ci.md)); run it locally before you push too, and `npm run i18n:check` for the locale mode you are not running; see [Internationalization](./internationalization.md#testing-both-modes).

## The tools the hooks run

Every hook runs its tool through `npx --no`, so it only ever runs the version `npm install` put in `node_modules` (the exact one `package.json` pins) and never fetches a package. `--package` names the package that provides the command (`--package=astro`, `--package=@commitlint/cli`), so a differently named package left in the npx cache cannot answer for it. A hook whose tool is missing fails rather than downloading one: run `npm install`.

## Setup

Hooks are installed automatically during:

```bash
npm install
```
