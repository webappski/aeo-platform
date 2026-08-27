#!/usr/bin/env bash
#
# smoke-tarball.sh — post-pack smoke for aeo-platform.
#
# `npm test` runs the suite against the working tree; it cannot see what the
# PUBLISHED tarball looks like. This packs the real tarball, installs it into a
# clean dir, and verifies the bin actually runs there — catching the classes a
# working-tree test misses: a file dropped from `files:`, a corrupted shebang,
# an undeclared runtime dep, a broken `bin` mapping, a postinstall that aborts.
#
# Wired into `prepublishOnly` so a bad publish is blocked BEFORE it reaches npm
# (npm publish is public + irreversible). Per Архип proposal 2026-05-25
# post-publish-smoke-procedure.md (Вариант C). ~30-60s, zero LLM cost.
#
# Exit 0 = clean; exit 1 = smoke failed (block the publish).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PKG_NAME="$(node -p "require('./package.json').name")"
PKG_VERSION="$(node -p "require('./package.json').version")"
# EVERY declared alias, not just the first. `bin` maps two names at the
# package's own choosing — `aeo-platform` (current) and `aeo-tracker` (the
# legacy name, which every install predating the rename still invokes). This
# used to read `Object.keys(...)[0]`, so the legacy alias was never exercised
# and a broken mapping on it would have published clean. Install is the
# never-fail surface: an alias that does not run is a dead install.
BIN_NAMES="$(node -p "Object.keys(require('./package.json').bin || {}).join('\n')")"
[ -n "$BIN_NAMES" ] || { echo "smoke FAIL: no bin declared in package.json"; exit 1; }

SMOKE_DIR="${TMPDIR:-/tmp}/aeo-smoke-$$"
TARBALL=""
cleanup() {
  rm -rf "$SMOKE_DIR"
  [ -n "$TARBALL" ] && rm -f "$REPO_ROOT/$TARBALL" 2>/dev/null || true
}
trap cleanup EXIT

echo "smoke: packing $PKG_NAME@$PKG_VERSION ..."
# `npm pack` does NOT re-trigger prepublishOnly (only prepare/prepack) — no recursion.
TARBALL="$(npm pack 2>/dev/null | tail -n1)"
[ -f "$REPO_ROOT/$TARBALL" ] || { echo "smoke FAIL: npm pack produced no tarball ($TARBALL)"; exit 1; }

rm -rf "$SMOKE_DIR"; mkdir -p "$SMOKE_DIR"
cp "$REPO_ROOT/$TARBALL" "$SMOKE_DIR/"
cd "$SMOKE_DIR"

echo "smoke: installing tarball into clean $SMOKE_DIR ..."
npm init -y >/dev/null 2>&1
npm install --silent "./$TARBALL" >/dev/null 2>&1 || { echo "smoke FAIL: npm install of tarball failed"; exit 1; }

BIN_COUNT=0
while IFS= read -r BIN_NAME; do
  [ -n "$BIN_NAME" ] || continue
  BIN_COUNT=$((BIN_COUNT + 1))

  BIN_PATH="./node_modules/.bin/$BIN_NAME"
  [ -x "$BIN_PATH" ] || { echo "smoke FAIL: bin '$BIN_NAME' missing/non-executable after install"; exit 1; }

  echo "smoke: $BIN_NAME --version"
  OUT="$("$BIN_PATH" --version 2>&1)" || { echo "smoke FAIL: $BIN_NAME --version exited non-zero: $OUT"; exit 1; }
  echo "$OUT" | grep -qF "$PKG_VERSION" || { echo "smoke FAIL: $BIN_NAME --version '$OUT' != package.json $PKG_VERSION"; exit 1; }

  echo "smoke: $BIN_NAME --help"
  "$BIN_PATH" --help >/dev/null 2>&1 || { echo "smoke FAIL: $BIN_NAME --help exited non-zero"; exit 1; }
done <<EOF
$BIN_NAMES
EOF

[ "$BIN_COUNT" -gt 0 ] || { echo "smoke FAIL: no bin alias was exercised"; exit 1; }

echo "smoke OK: $PKG_NAME@$PKG_VERSION installs clean from tarball; all $BIN_COUNT bin alias(es) run."
