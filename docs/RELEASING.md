# Releasing

## Names

- GitHub repository: `TachikomaGundam/AsylumWarden` (user account, not an org).
- npm package: `asylumwarden` (unscoped, all lowercase).

Case matters. Do not publish `AsylumWarden`, `asylum-warden`, or any scoped
variant.

## npm authentication

The initial machine probe showed `npm whoami` returning `E401`. The owner must
authenticate before the package can be created or published:

```sh
cd ~/workspace/harness/AsylumWarden && npm login
```

Publishing uses the unscoped public package:

```sh
cd ~/workspace/harness/AsylumWarden && npm publish
```

The package stays `private: true` and version `0.0.0` until the first reviewed
release. Do not publish an empty placeholder just to reserve the name.

## Versioning

- `0.x` while the contract is unstable.
- The CLI and manifest schema carry a version field.
- A breaking contract change increments the minor version before 1.0.

## Provenance

GitHub Actions publishes with OIDC provenance. The GitHub owner is a user
account, so the workflow must be scoped to `TachikomaGundam/AsylumWarden`.
No long-lived npm token is stored in the repository.

## Release gate

Before a tag:

1. All tests pass.
2. The release candidate is built from the exact commit.
3. The tarball excludes `.env`, state, logs, and local absolute paths.
4. The release receipt is committed.
5. The owner pushes the tag and publishes; the agent does not hold the key.
