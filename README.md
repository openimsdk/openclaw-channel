# @openim/openclaw-channel

OpenIM channel plugin for OpenClaw Gateway.

Chinese documentation: [README.zh-CN.md](https://github.com/openimsdk/openclaw-channel/blob/main/README.zh-CN.md)

## Features

- Direct chat and group chat support
- Inbound and outbound text/image/file messages
- `openim_send_video` is intentionally sent as a file message
- Quote/reply message parsing for inbound context
- Multi-account login via `channels.openim.accounts.<id>`
- Group trigger policy with optional mention-only mode
- Interactive setup command: `openclaw openim setup`

## Installation

Install from npm:

```bash
openclaw plugins install @openim/openclaw-channel
```

Or install from local path:

```bash
openclaw plugins install /path/to/openclaw-channel
```

Repository: https://github.com/openimsdk/openclaw-channel

## Identity Mapping

- npm package name: `@openim/openclaw-channel`
- plugin id: `openclaw-channel` (used in `plugins.entries` and `plugins.allow`)
- channel id: `openim` (used in `channels.openim`)
- setup command: `openclaw openim setup`

## Configuration

### Option 1: Interactive setup (recommended)

```bash
openclaw openim setup
```

### Option 2: Edit `~/.openclaw/openclaw.json`

```json
{
  "channels": {
    "openim": {
      "accounts": {
        "default": {
          "enabled": true,
          "token": "your_token",
          "wsAddr": "ws://127.0.0.1:10001",
          "apiAddr": "http://127.0.0.1:10002"
        }
      }
    }
  }
}
```

`userID` and `platformID` are optional. If omitted, they are auto-derived from JWT token claims (`UserID` and `PlatformID`).

`requireMention` is optional and defaults to `true`.

`inboundWhitelist` is optional. If omitted or empty, inbound handling keeps existing behavior.
If set, only these users can trigger processing:
- direct messages to the account
- group messages where they `@` the account

Single-account fallback (without `accounts`) is supported.

Environment fallback is supported for the `default` account:

- `OPENIM_TOKEN`
- `OPENIM_WS_ADDR`
- `OPENIM_API_ADDR`

Optional env overrides:

- `OPENIM_USER_ID`
- `OPENIM_PLATFORM_ID`

## Agent Tools

- `openim_send_text`
  - `target`: `user:<id>` or `group:<id>`
  - `text`: message text
  - `accountId` (optional): select sending account

- `openim_send_image`
  - `target`: `user:<id>` or `group:<id>`
  - `image`: local path (`file://` supported) or `http(s)` URL
  - `accountId` (optional): select sending account

- `openim_send_video`
  - `target`: `user:<id>` or `group:<id>`
  - `video`: local path (`file://` supported) or `http(s)` URL
  - behavior: sent as a file message (not OpenIM video message)
  - `name` (optional): override filename for URL input
  - `accountId` (optional): select sending account

- `openim_send_file`
  - `target`: `user:<id>` or `group:<id>`
  - `file`: local path (`file://` supported) or `http(s)` URL
  - `name` (optional): override filename for URL input
  - `accountId` (optional): select sending account

## Development

```bash
pnpm run build
pnpm run test:connect
```

For `test:connect`, configure `.env` first (see `.env.example`).

## License

AGPL-3.0-only. See [LICENSE](https://github.com/openimsdk/openclaw-channel/blob/main/LICENSE).
