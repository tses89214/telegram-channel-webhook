#!/usr/bin/env bun
// Telegram -> Claude Code channel over a webhook instead of the official plugin's polling.
// One instance per bot, configured by env (see bot.env.example). Listens on 127.0.0.1;
// put nginx (TLS + path routing) in front.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET
const ALLOW_FROM = new Set((process.env.TELEGRAM_ALLOW_FROM ?? '').split(',').filter(Boolean))
const PORT = Number(process.env.WEBHOOK_PORT)
if (!BOT_TOKEN || !SECRET || ALLOW_FROM.size === 0 || !PORT) {
  console.error('need TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_ALLOW_FROM, WEBHOOK_PORT')
  process.exit(1)
}
const api = (method: string) => `https://api.telegram.org/bot${BOT_TOKEN}/${method}`

const mcp = new Server(
  { name: 'telegram-webhook', version: '0.0.1' },
  {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions:
      'Messages arrive as <channel source="telegram-webhook" chat_id="..." message_id="..." user="...">. ' +
      'Reply with the reply tool, passing chat_id back. Pass photo_path to send a local image.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Send a Telegram message back over this channel',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        text: { type: 'string', description: 'Message text, or the caption if photo_path is set' },
        photo_path: { type: 'string', description: 'Local path of an image to send' },
      },
      required: ['chat_id'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name !== 'reply') throw new Error(`unknown tool: ${req.params.name}`)
  const { chat_id, text, photo_path } = req.params.arguments as { chat_id: string; text?: string; photo_path?: string }
  let res: Response
  if (photo_path) {
    const form = new FormData()
    form.append('chat_id', chat_id)
    form.append('photo', Bun.file(photo_path))
    if (text) form.append('caption', text)
    res = await fetch(api('sendPhoto'), { method: 'POST', body: form })
  } else {
    if (!text) throw new Error('reply requires text or photo_path')
    res = await fetch(api('sendMessage'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id, text }),
    })
  }
  return { content: [{ type: 'text', text: res.ok ? 'sent' : `failed: ${await res.text()}` }] }
})

// Telegram getFile caps bot downloads at 20MB; failure is reported in-band so Claude can tell the user.
async function saveInbound(fileId: string, name?: string): Promise<string> {
  try {
    const info: any = await (await fetch(`${api('getFile')}?file_id=${fileId}`)).json()
    if (!info.ok) return `[attachment download failed: ${info.description}]`
    const dir = `${process.env.HOME}/.claude/channels/telegram-inbox`
    Bun.spawnSync(['mkdir', '-p', dir])
    const safe = (name ?? info.result.file_path.split('/').pop()).replace(/[^\w.\-]/g, '_')
    const path = `${dir}/${Date.now()}-${safe}`
    await Bun.write(path, await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${info.result.file_path}`))
    return `[attachment saved: ${path}]`
  } catch (e) {
    return `[attachment download failed: ${e}]`
  }
}

await mcp.connect(new StdioServerTransport())

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1', // only nginx should reach this
  async fetch(req) {
    if (req.method !== 'POST') return new Response('ok')
    // Set at setWebhook time; the only proof the request came from Telegram.
    if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) return new Response('forbidden', { status: 403 })

    let update: any
    try { update = await req.json() } catch { return new Response('ok') } // never 500 to Telegram

    const msg = update.message
    const fileId = msg?.photo?.at(-1)?.file_id ?? msg?.document?.file_id // photo[] is small -> large
    if (!msg?.text && !fileId) return new Response('ok')
    // Gate on the sender, not the chat: anyone in an allowed group could otherwise drive the agent.
    if (!ALLOW_FROM.has(String(msg.from?.id))) return new Response('ok')

    let content: string = msg.text ?? msg.caption ?? ''
    if (fileId) content += `\n${await saveInbound(fileId, msg.document?.file_name)}`
    // A swipe-reply carries the quoted message; it never reaches the session otherwise.
    const quoted = msg.reply_to_message?.text ?? msg.reply_to_message?.caption
    if (quoted) content = `[replying to: ${quoted}]\n${content}`

    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content, meta: { chat_id: String(msg.chat.id), message_id: String(msg.message_id), user: String(msg.from.id) } },
    })
    return new Response('ok')
  },
})
