#!/usr/bin/env bash
set -euo pipefail

# AgentShield OpenClaw Skill Installer
# Idempotent — safe to run multiple times.
# Does NOT execute remote code. Only copies files and merges JSON config.

MCP_VERSION="0.4.7"
SKILL_DIR="${HOME}/.openclaw/workspace/skills/agent-shield"
CONFIG_FILE="${HOME}/.openclaw/openclaw.json"
SHIELD_DIR="${HOME}/.agentshield"

echo "==> Installing AgentShield skill for OpenClaw..."

# 0. Check npx availability
if ! command -v npx &>/dev/null; then
  echo "ERROR: npx is not installed. Install Node.js 18+ first."
  echo "       https://nodejs.org/"
  exit 1
fi

# 1. Copy SKILL.md
mkdir -p "${SKILL_DIR}"
cp "$(dirname "$0")/SKILL.md" "${SKILL_DIR}/SKILL.md"
echo "    Copied SKILL.md to ${SKILL_DIR}/"

# 2. Create AgentShield config directory with restricted permissions
if [ ! -d "${SHIELD_DIR}" ]; then
  mkdir -p "${SHIELD_DIR}" && chmod 700 "${SHIELD_DIR}"
  echo "    Created ${SHIELD_DIR}/ (mode 700)"
fi

# 3. Merge MCP config into openclaw.json (idempotent)
MCP_ENTRY=$(cat <<JSONEOF
{
  "command": "npx",
  "args": ["@agent-shield/mcp@${MCP_VERSION}"],
  "env": {
    "AGENTSHIELD_RPC_URL": "https://api.devnet.solana.com"
  }
}
JSONEOF
)

if [ -f "${CONFIG_FILE}" ]; then
  if grep -q "@agent-shield/mcp@${MCP_VERSION}" "${CONFIG_FILE}" 2>/dev/null; then
    echo "    MCP config already present (v${MCP_VERSION}) in ${CONFIG_FILE} — skipping"
  else
    # Merge using node (available since npx check passed)
    node -e "
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync('${CONFIG_FILE}', 'utf-8'));
      if (!cfg.agents) cfg.agents = {};
      if (!cfg.agents.default) cfg.agents.default = {};
      if (!cfg.agents.default.mcp) cfg.agents.default.mcp = {};
      cfg.agents.default.mcp['agent-shield'] = ${MCP_ENTRY};
      fs.writeFileSync('${CONFIG_FILE}', JSON.stringify(cfg, null, 2) + '\n');
    "
    echo "    Merged agent-shield MCP config into ${CONFIG_FILE}"
  fi
else
  mkdir -p "$(dirname "${CONFIG_FILE}")"
  cp "$(dirname "$0")/openclaw.json" "${CONFIG_FILE}"
  echo "    Created ${CONFIG_FILE} with AgentShield MCP config"
fi

echo ""
echo "==> Done! AgentShield skill installed."
echo ""
echo "    Start OpenClaw and say: \"Set up AgentShield\""
echo "    The agent will guide you through security setup."
echo ""
echo "    MCP server: @agent-shield/mcp@${MCP_VERSION}"
echo "    No wallet needed at install time — the agent creates one during setup."
