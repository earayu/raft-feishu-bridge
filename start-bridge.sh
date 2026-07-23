#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

export RAFT_PROFILE="${RAFT_PROFILE:-feishu-bridge}"
export RAFT_BIN="${RAFT_BIN:-$(command -v raft || true)}"
export BRIDGE_DEFAULT_TARGET="${BRIDGE_DEFAULT_TARGET:-dm:@飞书}"
export BRIDGE_WAKE_HANDLE="${BRIDGE_WAKE_HANDLE:-@飞书}"
export BRIDGE_WAKE_NAMES="${BRIDGE_WAKE_NAMES:-张一鸣}"
export BRIDGE_STATE_DIR="${BRIDGE_STATE_DIR:-$ROOT_DIR/state}"
export AGENT_HANDLER_CMD="${AGENT_HANDLER_CMD:-node $ROOT_DIR/raft-handler.mjs}"

if [ -z "${RAFT_BIN}" ]; then
  echo "RAFT_BIN is empty and raft was not found in PATH" >&2
  exit 1
fi

node "$ROOT_DIR/healthcheck.mjs" --startup
exec node "$ROOT_DIR/bridge.mjs"
