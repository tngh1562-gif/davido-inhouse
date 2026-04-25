import { getState, setState } from './state'
import { searchYouTube } from './youtube'

declare global {
  var __chzzkWs: any | undefined
  var __chzzkPing: any | undefined
}

export function broadcastSSE(type: string, data: any) {
  // Polling 방식에서는 상태를 파일에 저장하는 것으로 충분
  // 필요시 메모리 캐시용으로만 사용
}

export async function connectChzzk(channelId: string) {
  if (global.__chzzkWs) {
    try { global.__chzzkWs.terminate() } catch {}
    global.__chzzkWs = null
  }
  if (global.__chzzkPing) {
    clearInterval(global.__chzzkPing)
    global.__chzzkPing = null
  }

  setState(s => { s.channelId = channelId })

  let chatChannelId = channelId
  let accessToken = null

  try {
    const res = await fetch(
      `https://api.chzzk.naver.com/service/v2/channels/${channelId}/live-detail`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://chzzk.naver.com/' } }
    )
    const json = await res.json()
    chatChannelId = json?.content?.chatChannelId || channelId
    console.log('[CHZZK] chatChannelId:', chatChannelId)
  } catch { console.log('[CHZZK] using channelId directly') }

  try {
    const res = await fetch(
      `https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${chatChannelId}&chatType=STREAMING`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://chzzk.naver.com/' } }
    )
    const json = await res.json()
    accessToken = json?.content?.accessToken || null
    console.log('[CHZZK] accessToken:', accessToken ? 'OK' : 'null')
  } catch { console.log('[CHZZK] token failed') }

  connectChatWs(chatChannelId, channelId, accessToken)
}

function connectChatWs(chatChannelId: string, originalChannelId: string, accessToken: string | null) {
  const WS = eval("require")('ws')
  const serverNum = Math.floor(Math.random() * 4) + 1
  const serverUrl = `wss://kr-ss${serverNum}.chat.naver.com/chat`
  console.log('[CHZZK] connecting to', serverUrl)

  const ws = new WS(serverUrl, {
    perMessageDeflate: false,
    handshakeTimeout: 10000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
      'Origin': 'https://chzzk.naver.com',
      'Referer': 'https://chzzk.naver.com/',
    }
  })

  global.__chzzkWs = ws

  ws.on('open', () => {
    console.log('[CHZZK] open, authenticating...')
    ws.send(JSON.stringify({
      ver: '3', cmd: 100, svcid: 'game', cid: chatChannelId,
      bdy: {
        uid: null, devType: 2001, accTkn: accessToken, auth: 'READ',
        libVer: '4.9.1', osVer: 'Windows/10', devName: 'Chrome/120.0.0.0',
        locale: 'ko', chzzkTk: null,
      },
      tid: 1,
    }))

    global.__chzzkPing = setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ ver: '3', cmd: 0 }))
    }, 20000)
  })

  ws.on('message', (raw: any) => {
    try {
      const str = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
      const msg = JSON.parse(str)
      if (msg.cmd === 0) { ws.send(JSON.stringify({ ver: '3', cmd: 10000 })); return }
      if (msg.cmd === 10000) return
      if (msg.cmd === 93101) handleChatMessage(msg)
    } catch {}
  })

  ws.on('close', (code: number) => {
    console.log('[CHZZK] closed, code:', code)
    if (global.__chzzkPing) { clearInterval(global.__chzzkPing); global.__chzzkPing = null }
    const state = getState()
    if (state.channelId === originalChannelId) {
      setTimeout(() => connectChatWs(chatChannelId, originalChannelId, accessToken), 5000)
    }
  })

  ws.on('error', (err: Error) => console.error('[CHZZK] error:', err.message))
}

function handleChatMessage(msg: any) {
  const chats = msg.bdy?.messageList || []
  chats.forEach((chat: any) => {
    const nickname: string = chat.profile?.nickname || '익명'
    const text: string = (chat.msg || '').trim()
    if (!text) return

    console.log('[CHZZK] chat:', nickname, text)

    // 파일 상태에 저장
    setState(s => {
      if (!s.chatLog) s.chatLog = []
      s.chatLog.push({ nickname, text })
      if (s.chatLog.length > 200) s.chatLog.shift()

      // 투표 처리
      if (s.vote.active) {
        const m = text.match(/^!투표(\d+)$/)
        if (m) {
          const idx = parseInt(m[1]) - 1
          if (idx >= 0 && idx < s.vote.items.length) {
            s.vote.items.forEach(it => { it.votes = it.votes.filter(v => v !== nickname) })
            s.vote.items[idx].votes.push(nickname)
          }
        }
      }

      // 신청곡
      if (text.startsWith('!신청곡 ')) {
        const query = text.slice(5).trim()
        if (query) {
          handleMusicRequest(nickname, query)
        }
      }
    })
  })
}

async function handleMusicRequest(nickname: string, query: string) {
  const results = await searchYouTube(query, 1)
  const track = results[0]
  if (!track) return

  setState(s => {
    if (s.music.queue.some((t: any) => t.videoId === track.videoId)) return
    s.music.queue.push({ ...track, requestedBy: nickname, addedAt: Date.now() })
    if (!s.chatLog) s.chatLog = []
    s.chatLog.push({
      nickname: '🎵 신청곡',
      text: `[${nickname}] "${track.title}" 추가! (${s.music.queue.length}번째)`,
      isSystem: true,
    })
  })
}

export function disconnectChzzk() {
  if (global.__chzzkPing) { clearInterval(global.__chzzkPing); global.__chzzkPing = null }
  if (global.__chzzkWs) {
    setState(s => { s.channelId = null })
    try { global.__chzzkWs.terminate() } catch {}
    global.__chzzkWs = null
  }
}

export function isChzzkConnected(): boolean {
  return global.__chzzkWs?.readyState === 1
}
