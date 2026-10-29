# Editor — notes for agents

## Releasing

Kehikot installs and updates this module from its GitHub releases, not from `main`.
Nobody tags by hand: merging the version bump is the release.

1. Bump `version` in `package.json` (semver). It is the only place the version
   is written: the manifest reads it.
2. Write `notes/<version>.md`: what a person notices (see `notes/README.md`).
3. Open a PR with both; merge it.
4. On that push to `main`, `.github/workflows/release.yml` (the shared
   `module-release.yml` in Jalez/kehikko-desktop) sees that `package.json`'s
   version is newer than the latest `v*` tag and that the notes exist, creates
   the annotated tag `v<version>` on the merge commit, checks the notes,
   typechecks and tests, then publishes the release "Editor <version>" in the
   same run. A push that keeps the version releases nothing; a newer version
   without notes fails the run. If a check fails nothing is published: fix it
   in a PR with a newer version.
