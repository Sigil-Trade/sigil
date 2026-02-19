#!/usr/bin/env bash
set -euo pipefail

# AgentShield OpenClaw Skill Installer
# Copies the skill to OpenClaw's workspace and configures the MCP server.

SKILL_DIR="${HOME}/.openclaw/workspace/skills/agent-shield"
CONFIG_FILE="${HOME}/.openclaw/openclaw.json"
WALLET_DIR="${HOME}/.agentshield/wallets"

echo "==> Installing AgentShield skill for OpenClaw..."

# 1. Copy SKILL.md
mkdir -p "${SKILL_DIR}"
cp "$(dirname "$0")/SKILL.md" "${SKILL_DIR}/SKILL.md"
echo "    Copied SKILL.md to ${SKILL_DIR}/"

# 2. Create agent wallet directory if it doesn't exist
if [ ! -d "${WALLET_DIR}" ]; then
  mkdir -p "${WALLET_DIR}"
  echo "    Created wallet directory at ${WALLET_DIR}/"
  echo "    NOTE: Place your agent keypair at ${WALLET_DIR}/agent.json"
fi

# 3. Merge MCP config into openclaw.json
if [ -f "${CONFIG_FILE}" ]; then
  # Check if agent-shield is already configured
  if grep -q '"agent-shield"' "${CONFIG_FILE}" 2>/dev/null; then
    echo "    MCP config already present in ${CONFIG_FILE} — skipping"
  else
    echo "    WARNING: ${CONFIG_FILE} exists but does not contain agent-shield config."
    echo "    Please manually add the MCP config from openclaw.json to your config file."
    echo "    See: $(dirname "$0")/openclaw.json"
  fi
else
  mkdir -p "$(dirname "${CONFIG_FILE}")"
  cp "$(dirname "$0")/openclaw.json" "${CONFIG_FILE}"
  echo "    Created ${CONFIG_FILE} with AgentShield MCP config"
fi

echo ""
echo "==> Done! Start OpenClaw to verify AgentShield tools are available."
echo "    If you haven't yet, install the MCP server: npm install -g @agent-shield/mcp"
