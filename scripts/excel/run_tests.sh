#!/usr/bin/env bash
# Native spreadsheet bridge test suite (Python unittest + node:test).
# LibreOffice tests start a private headless soffice and skip if it is unavailable.
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 -m unittest discover tests/excel "$@"
node --import tsx --test tests/excel/*.test.ts
