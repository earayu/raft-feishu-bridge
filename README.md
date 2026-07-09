# raft-feishu-bridge

A lightweight Feishu (Lark) ↔ Raft bridge.

The bridge keeps Feishu Open Platform details in one place and uses a Raft
external-agent profile for the Raft side. It replaces legacy machine-key /
`SLOCK_AGENT_TOKEN_FILE` bootstrapping with `raft agent login` + `RAFT_PROFILE`.

## Architecture

```text
Feishu IM event
  -> bridge.mjs
  -> normalized JSON payload
  -> raft-handler.mjs
  -> raft message send --target <target>
  -> Raft agent / channel / DM

Raft side outbound command
  -> feishu-command.mjs
  -> send.mjs / send-image.mjs / send-file.mjs
  -> Feishu OpenAPI
```

`bridge.mjs` still supports generic command/webhook handlers, but the
recommended Raft path is `raft-handler.mjs`.

## Setup

1. Create a Feishu custom app.
2. Enable the bot and WebSocket event subscription.
3. Add required scopes:
   - `im:message`
   - `im:message.receive_v1`
   - optional: `contact:user.base:readonly`
4. Run:

```bash
npm install
npm run register
```

This writes `app.json`, which is ignored by git.

## Raft External Agent Login

Create or choose a Raft agent identity for inbound Feishu transport, then log it
in on the machine running the bridge:

```bash
raft agent login \
  --server https://api.raft.build \
  --agent <agent-id> \
  --profile-slug feishu-bridge
```

After browser approval, verify:

```bash
raft agent login status \
  --server https://api.raft.build \
  --agent <agent-id> \
  --profile-slug feishu-bridge
```

The bridge uses this profile:

```bash
export RAFT_PROFILE=feishu-bridge
```

## Run

For Raft:

```bash
export RAFT_PROFILE=feishu-bridge
export BRIDGE_DEFAULT_TARGET='dm:@飞书'
export AGENT_HANDLER_CMD='node ./raft-handler.mjs'
npm run healthcheck
npm run bridge
```

Or use the wrapper:

```bash
RAFT_PROFILE=feishu-bridge BRIDGE_DEFAULT_TARGET='dm:@飞书' npm start
```

On macOS, adapt `launchd.example.plist` and load it with `launchctl`.

## Routing

Create `routing.json` to map Feishu chat IDs to Raft targets:

```json
{
  "oc_xxxxxxxxxxxxxxxxxxxx": "dm:@飞书",
  "oc_yyyyyyyyyyyyyyyyyyyy": "#some-channel"
}
```

Unmapped chats use `BRIDGE_DEFAULT_TARGET`.

## State

Runtime state is stored in `state/bridge-state.json` by default and is ignored by
git. Override with:

```bash
export BRIDGE_STATE_DIR=/var/lib/raft-feishu-bridge
```

The state file contains:

- recently seen Feishu message IDs for deduplication
- Feishu message → Raft target mapping
- attachment metadata
- last dispatch health status

## Health Checks

Run:

```bash
npm run healthcheck
```

It validates `app.json`, production handler configuration, non-default Raft
target, and Raft profile auth when applicable.

Optional failure notification:

```bash
export BRIDGE_HEALTH_NOTIFY_TARGET='dm:@飞书'
```

`bridge.mjs` also records dispatch failures into the state file and can send a
Raft notification through `BRIDGE_HEALTH_NOTIFY_TARGET`.

## Feishu -> Raft Payload

Handlers receive normalized JSON:

```json
{
  "event": "message",
  "target": "dm:@飞书",
  "chat_id": "oc_xxx",
  "chat_type": "group",
  "message_id": "om_xxx",
  "sender_open_id": "ou_xxx",
  "sender_name": "张三",
  "text": "hello",
  "attachments": [
    {
      "kind": "image",
      "local_path": "/tmp/feishu-bridge-attachments/...",
      "filename": "image.jpg",
      "file_key": "img_xxx"
    }
  ],
  "timestamp": "2026-07-09T00:00:00.000Z",
  "raw": {}
}
```

`raft-handler.mjs` uploads `attachments[].local_path` to Raft and includes the
attachment IDs on the Raft message.

## Raft -> Feishu Commands

Prefer `feishu-command.mjs` as the structured outbound entrypoint:

```bash
echo '{"action":"send_text","reply_to":"om_xxx","text":"收到"}' | node feishu-command.mjs
echo '{"action":"send_image","reply_to":"om_xxx","path":"/tmp/chart.png"}' | node feishu-command.mjs
echo '{"action":"send_file","chat_id":"oc_xxx","path":"/tmp/report.pdf"}' | node feishu-command.mjs
```

Low-level helpers remain available:

- `send.mjs` for text
- `send-image.mjs` for inline images
- `send-file.mjs` for files
- `search.mjs` for Feishu history search
- `context.mjs` for recent Feishu context

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `RAFT_PROFILE` | `feishu-bridge` in `start-bridge.sh` | Raft external-agent profile slug |
| `RAFT_BIN` | `raft` from `PATH` | Raft CLI path |
| `AGENT_HANDLER_CMD` | `node ./raft-handler.mjs` in `start-bridge.sh` | Command handler for inbound Feishu messages |
| `AGENT_HANDLER_WEBHOOK` | unset | Alternative HTTP handler |
| `BRIDGE_DEFAULT_TARGET` | `dm:@飞书` in `start-bridge.sh` | Fallback Raft target |
| `BRIDGE_STATE_DIR` | `./state` | State directory |
| `BRIDGE_HEALTH_NOTIFY_TARGET` | unset | Raft target for health failure notifications |
| `KEEP_ATTACHMENTS` | unset | Set `1` to keep downloaded Feishu attachments |

## Notes

- Do not commit `app.json`, `routing.json`, `state/`, or `logs/`.
- The sender identity on Raft should be a dedicated external agent, not the
  human-facing agent itself. That keeps provenance clear and avoids self-message
  delivery ambiguity.
- `raft agent bridge` is for external runtime wake adapters such as Hermes or
  Claude Code channel plugins. The Feishu webhook path only needs
  `raft-handler.mjs` plus the external-agent profile credential.
