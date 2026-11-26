---
name: telegram-channel-webhook
description: Fix for the official Claude Code Telegram plugin that stops receiving messages (silent MCP death, never reconnects) by replacing polling with a self-hosted webhook channel server. Use when a Telegram-driven Claude Code bot goes deaf, shows "/mcp failed", or when running several always-on Telegram bots on one machine.
---

# Telegram channel: webhook instead of polling

## The problem
The official Telegram plugin polls from a stdio MCP server. When the harness recycles that process (opening `/mcp`, another plugin re-authing, long idle) it is never respawned: the bot can still send but stops receiving, until someone runs `/reload-plugins`.
Upstream, still open when checked 2026-08-24:
- anthropics/claude-plugins-official#1680 (MCP disconnects, needs manual reload)
- anthropics/claude-code#36427 (bot sends but stops receiving)
- anthropics/claude-code#24350 (stdio MCP servers never auto-reconnect; HTTP/SSE ones do)
A watchdog that restarts frozen sessions works around it. This skill removes the polling instead.

## The fix
Telegram pushes to you. A small channel server (`webhook.ts`, Bun) per bot receives the POST on 127.0.0.1 and forwards it to Claude as a `claude/channel` notification. nginx terminates TLS and routes by path, so one public port serves every bot.

1. `bun install`, copy `bot.env.example` per bot and fill it. One `WEBHOOK_PORT` per bot.
2. Project `.mcp.json`: server name `telegram-webhook`, command `run.sh`, args `[<path to that bot's env file>]`.
3. nginx: see `nginx.conf.example`. Reload nginx after cert renewal; no bot restart needed.
4. Register: `setWebhook` with `url=https://<host>/<bot>/` and `secret_token=<TELEGRAM_WEBHOOK_SECRET>`. Check `getWebhookInfo` for `last_error_message`.
5. Start Claude with `--dangerously-load-development-channels server:telegram-webhook`. It shows a one-time confirm dialog on every start; an unattended supervisor must answer Enter.

Security: requests are accepted only with the secret header; messages only from `TELEGRAM_ALLOW_FROM` sender ids (the sender, not the chat); the server binds 127.0.0.1.

## Gotchas hit in practice
- **Duplicate official plugin.** A global `enabledPlugins` entry runs the official plugin alongside yours. Turn it off per project in `.claude/settings.local.json`.
- **Trailing slashes.** URL, nginx `location` and `proxy_pass` must all end in `/`, otherwise nginx answers 301 and Telegram stops retrying.
- **New bot, `Connection timed out` on :443.** `getWebhookInfo` showed it and nothing reached nginx; registering on :8443 fixed it. Root cause not found, older bots on :443 kept working. Telegram allows 443, 80, 88, 8443.
- **`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` broke delivery.** nginx and the local port both returned 200, but messages never reached the session. Removing it fixed it. Cause inferred, not proven. After any env change, send a real message to test.
- **Local `curl --resolve` only proves nginx routing**, not that Telegram can reach you. Verify with `getWebhookInfo` plus the nginx access log.
- **Plain text never reaches the phone.** A turn that started from a channel message must end with the `reply` tool call. A Stop hook that checks for one (any reply after the last inbound message) is a cheap backstop. A strict one-reply-per-message counter false-blocks when one reply covers a burst.

## Limits
Written for personal use on one machine and not battle-tested for long. Text, photos and documents only (no voice or stickers). No retry on failed `sendMessage`. Needs a public HTTPS endpoint. Pending updates queue at Telegram if your server is down, then arrive in a burst.
