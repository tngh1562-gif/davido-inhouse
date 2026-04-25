import { getState, setState } from './state'
import { searchYouTube } from './youtube'

declare global {
  var __chzzkWs: any | undefined
  var __sseClients: Set<any> | undefined
}

export function getSseClients(): Set<any> {
  if (!global.__sseClients) global.__sseClients = new Set()
  return global.__sseClients
}

export function broadcastSSE(type: string, data: any) {
  const msg = `data: ${JSON.stringify({ type, data })}\n\n`
  getSseClients().forEach((res: any) => {
    try { res.write(msg) } catch {}
  })
}

export async function connectChzzk(channelId: string) {
  if (global.__chzzkWs) {
    try { global.__chzzkWs.terminate?.() || global.__chzzkWs.close() } catch {}
    global.__chzzkWs = null
  }

  setState(s => { s.channelId = channelId })

  let chatChannelId = channelId
  try {
    const res = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${channelId}/live-detail`)
    const json = await res.json()
    chatChannelId = json?.content?.chatChannelId || channelId
    console.log('[CHZZK] chatChannelId:', chatChannelId)
  } catch {
    console.log('[CHZZK] using channelId directly')
  }

  connectChatWs(chatChannelId, channelId)
}

function connectChatWs(chatChannelId: string, originalChannelId: string) {
  // Next.js 번들링 우회: require를 동적으로
  let WS: any
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    WS = eval("require")('ws')
    console.log('[CHZZK] ws loaded, version:', eval("require")('ws/package.json').version)
  } catch(e: any) {
    console.error('[CHZZK] ws load failed:', e.message)
    broadcastSSE('error', { message: 'ws 패키지 로드 실패' })
    return
  }

  console.log('[CHZZK] connecting...')
  
  const ws = new WS('wss://kr-ss1.chat.naver.com/chat', {
    perMessageDeflate: false,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
    }
  })
  
  global.__chzzkWs = ws

  ws.on('open', () => {
    console.log('[CHZZK] open! sending auth...')
    const payload = JSON.stringify({
      ver: '2', cmd: 100, svcid: 'game',
      cid: chatChannelId,
      bdy: { uid: null, devType: 2001, accTkn: null, auth: 'READ' },
      tid: 1,
    })
    ws.send(payload)
    broadcastSSE('chzzk_connected', { channelId: originalChannelId })
  })

  ws.on('message', (raw: any) => {
    try {
      const str = typeof raw === 'string' ? raw : raw.toString('utf8')
      const msg = JSON.parse(str)
      handleMessage(msg, ws)
    } catch {}
  })

  ws.on('close', (code: number) => {
    console.log('[CHZZK] closed, code:', code)
    broadcastSSE('chzzk_disconnected', {})
    if (getState().channelId === originalChannelId) {
      setTimeout(() => connectChatWs(chatChannelId, originalChannelId), 5000)
    }
  })

  ws.on('error', (err: Error) => {
    console.error('[CHZZK] ws error:', err.message)
  })
}

function handleMessage(msg: any, ws: any) {
  if (msg.cmd === 0) {
    ws.send(JSON.stringify({ ver: '2', cmd: 10000 }))
    return
  }

  if (msg.cmd === 93101) {
    const chats = msg.bdy?.messageList || []
    chats.forEach((chat: any) => {
      const nickname: string = chat.profile?.nickname || '익명'
      const text: string = (chat.msg || '').trim()

      broadcastSSE('chat', { nickname, text })

      const state = getState()
      if (state.vote.active) {
        const m = text.match(/^!투표(\d+)$/)
        if (m) {
          const idx = parseInt(m[1]) - 1
          if (idx >= 0 && idx < state.vote.items.length) {
            setState(s => {
              s.vote.items.forEach(it => { it.votes = it.votes.filter(v => v !== nickname) })
              s.vote.items[idx].votes.push(nickname)
            })
            broadcastSSE('vote_update', getState().vote)
          }
        }
      }

      if (text.startsWith('!신청곡 ')) {
        const query = text.slice(5).trim()
        if (query) handleMusicRequest(nickname, query)
      }
    })
  }
}

async function handleMusicRequest(nickname: string, query: string) {
  const results = await searchYouTube(query, 1)
  const track = results[0]
  if (!track) return

  const state = getState()
  if (state.music.queue.some((t: any) => t.videoId === track.videoId)) {
    broadcastSSE('chat', { nickname: '🎵 신청곡', text: `이미 대기열에 있습니다`, isSystem: true })
    return
  }

  setState(s => {
    s.music.queue.push({ ...track, requestedBy: nickname, addedAt: Date.now() })
  })

  broadcastSSE('chat', {
    nickname: '🎵 신청곡',
    text: `[${nickname}] "${track.title}" 추가! (${getState().music.queue.length}번째)`,
    isSystem: true,
  })
  broadcastSSE('music_state', getState().music)
}

export function disconnectChzzk() {
  if (global.__chzzkWs) {
    setState(s => { s.channelId = null })
    try { global.__chzzkWs.terminate?.() || global.__chzzkWs.close() } catch {}
    global.__chzzkWs = null
    broadcastSSE('chzzk_disconnected', {})
  }
}

export function isChzzkConnected(): boolean {
  return global.__chzzkWs?.readyState === 1
}
