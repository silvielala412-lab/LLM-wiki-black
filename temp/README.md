# Temporary and legacy material

Nothing in this directory is production source. The tracked folders preserve material that may still be useful while keeping the active application tree clean:

- `diagnostics/`: one-off investigation and verification utilities.
- `legacy-scripts/`: superseded start/build scripts retained for reference.
- `notes/`: scratch notes and obsolete planning fragments.
- `release-artifacts/`: small historical patches and release evidence.

Large or machine-local content belongs in the ignored folders `artifacts/`, `local-tests/`, and `logs/`. Product code must not import from `temp/`.
