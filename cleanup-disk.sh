#!/bin/bash
# Disk cleanup: build artifacts, dependency dirs, package caches, unused Docker
# images, browser caches. Dry-run audited 2026-11-11.
# SPARED: git dirs, agent experiment outputs (agent/browser/build, agent/build),
# committed sources under deps/test/fixtures/testdata/vendor/.venv, bun global
# tools, sf CLI, editor extensions, browser profiles/history/logins, Firefox
# site storage, HF models, .opam, session logs.
set -u
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

echo "=== BEFORE ==="; df -h / | tail -1

echo "=== 1/4 build artifacts + dependency dirs ==="
find "$HOME"/Music -path '*/.git' -prune -o -path '*/node_modules/*' -prune -o -path '*/target/*' -prune -o -path '*/.venv/*' -prune -o -path '*/vendor/*' -prune -o -path '*/deps/*' -prune -o -path '*/test/*' -prune -o -path '*/fixtures/*' -prune -o -path '*/testdata/*' -prune -o -path "$HOME/Music/agent/browser/build*" -prune -o -path "$HOME/Music/agent/build*" -prune -o -type d \( -name node_modules -o -name target -o -name __pycache__ -o -name .next -o -name .nuxt -o -name .turbo -o -name coverage -o -name .pytest_cache -o -name build -o -name dist \) -prune -exec rm -rf {} + 2>/dev/null
find "$HOME" -path '*/.git' -prune -o -path "$HOME/.vscode*" -prune -o -path "$HOME/.cursor*" -prune -o -path "$HOME/.windsurf*" -prune -o -path "$HOME/.mozilla*" -prune -o -path "$HOME/.config/google-chrome*" -prune -o -path "$HOME/.opam*" -prune -o -path "$HOME/.bun/*" -prune -o -path "$HOME/.local/share/sf/*" -prune -o -type d \( -name node_modules -o -name target -o -name __pycache__ -o -name .next -o -name .nuxt -o -name .turbo -o -name coverage -o -name .pytest_cache -o -name .mypy_cache -o -name .ruff_cache \) -prune -exec rm -rf {} + 2>/dev/null
find "$HOME" -path '*/.git' -prune -o -path "$HOME/.vscode*" -prune -o -path "$HOME/.cursor*" -prune -o -path "$HOME/.windsurf*" -prune -o -path "$HOME/.bun/*" -prune -o -path "$HOME/.local/share/sf/*" -prune -o -type f -name '*.pyc' -delete 2>/dev/null

echo "=== 2/4 package caches ==="
uv cache clean >/dev/null 2>&1; go clean -cache -modcache >/dev/null 2>&1; npm cache clean --force >/dev/null 2>&1; pip cache purge >/dev/null 2>&1; "$HOME"/.bun/bin/bun pm cache rm >/dev/null 2>&1
rm -rf "$HOME"/.cache/pre-commit "$HOME"/.cache/ms-playwright "$HOME"/.cache/pnpm "$HOME"/.local/share/pnpm/store "$HOME"/.gradle/caches "$HOME"/.cargo/registry/cache "$HOME"/.cache/node-gyp "$HOME"/.cache/golangci-lint "$HOME"/.bun/install/cache

echo "=== 3/4 docker ==="
docker image prune -a -f | tail -1; docker builder prune -f | tail -1

echo "=== 4/4 browser caches ==="
rm -rf "$HOME"/.config/google-chrome/OptGuideOnDeviceModel "$HOME"/.config/google-chrome/OptGuideOnDeviceClassifierModel "$HOME"/.config/google-chrome/ShaderCache "$HOME"/.config/google-chrome/GrShaderCache "$HOME"/.config/google-chrome/Default/GPUCache "$HOME"/.config/google-chrome/GPUPersistentCache
find "$HOME"/.mozilla/firefox -maxdepth 2 -type d \( -name cache2 -o -name startupCache -o -name shader-cache -o -name thumbnails \) -prune -exec rm -rf {} + 2>/dev/null
find "$HOME"/.mozilla/firefox/*/storage/default -maxdepth 2 -type d -name cache -prune -exec rm -rf {} + 2>/dev/null
rm -rf "$HOME"/.mozilla/firefox/*/datareporting

echo "=== AFTER ==="; df -h / | tail -1
