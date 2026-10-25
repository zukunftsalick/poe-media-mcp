#!/bin/bash
# Saves your Gemini API key into the poe-media server's env in Claude Desktop's config.
# The key is typed hidden and only written to that local config file (a backup is made first).
set -euo pipefail
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
[ -f "$CFG" ] || { echo "Claude Desktop config not found at: $CFG"; exit 1; }
read -r -s -p "Paste your Gemini API key (it stays hidden), then press Enter: " GEMINI_KEY; echo
[ -n "$GEMINI_KEY" ] || { echo "No key entered, nothing changed."; exit 1; }
cp "$CFG" "$CFG.bak-$(date +%Y%m%d-%H%M%S)"
GEMINI_KEY="$GEMINI_KEY" /usr/bin/python3 - "$CFG" <<'PY'
import json, os, sys
path = sys.argv[1]
with open(path) as f:
    cfg = json.load(f)
servers = cfg.get("mcpServers", {})
if "poe-media" not in servers:
    sys.exit("No 'poe-media' server in the config; nothing changed. Server names found: " + ", ".join(servers))
servers["poe-media"].setdefault("env", {})["GEMINI_API_KEY"] = os.environ["GEMINI_KEY"].strip()
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
print("Saved. Now quit Claude completely (Cmd+Q) and open it again so the server picks up the key.")
PY
