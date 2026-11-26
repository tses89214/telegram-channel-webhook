// Manual end-to-end check: spawns webhook.ts as Claude would (stdio MCP), sends a prompt via the
// reply tool, then waits for you to message the bot and prints the channel notification it emits.
// usage: set -a; . bot.env; set +a; bun run e2e.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const chat = process.env.TELEGRAM_ALLOW_FROM!.split(',')[0] // a private chat id equals the user id
const c = new Client({ name: 'e2e', version: '0' }, { capabilities: {} })
const got = new Promise<any>(res => { c.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') res(n.params) } })
await c.connect(new StdioClientTransport({ command: 'bun', args: ['run', 'webhook.ts'], env: process.env as any }))
console.log('tools:', (await c.listTools()).tools.map(t => t.name))
console.log('reply:', (await c.callTool({ name: 'reply', arguments: { chat_id: chat, text: 'e2e test: send me any message now' } })).content)
const r = await Promise.race([got, new Promise(r => setTimeout(() => r('TIMEOUT'), 180000))])
console.log('inbound:', r)
await c.close(); process.exit(r === 'TIMEOUT' ? 1 : 0)
