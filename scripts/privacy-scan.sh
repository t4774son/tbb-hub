#!/usr/bin/env bash
# Kept for old habits: the real scanner is privacy-scan.py.
exec python3 "$(dirname "$0")/privacy-scan.py" "$@"
