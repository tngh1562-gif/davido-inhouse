import { getState, setState } from './state'
import { searchYouTube } from './youtube'

declare global {
  var __chzzkWs: any | undefined
  var __chzzkPing: any | undefined
  var __sseClients: Set<any> | undefined
  var __chatLog: {nickname:string,text:string,isSystem?:boolean}[] | undefined
}

export function getSseClients(): Set<any> {
  if (!global.__sseClients) global.__sseClients = new Set()
  return global.__sseClients
}

export function getChatLog() {
  if (!global.__chatLog) global.__chatLog = []
  return global.__chatLog
}

export function broadcastSSE(type: string, data: any) {
  const msg = `data: ${JSON.stringify({ type, data })}\n\n`
  getSseClients().forEach((res: any) => {
    try { res.write(msg) } catch {}
  })
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

  // step1: 채널 정보로 chatChannelId 가져오기
  let chatChannelId = channelId
  let accessToken = null
  
  try {
    // 라이브 디테일에서 chatChannelId 가져오기
    const liveRes = await fetch(
      `https://api.chzzk.naver.com/service/v2/channels/${channelId}/live-detail`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://chzzk.naver.com/' } }
    )
    const liveJson = await liveRes.json()
    chatChannelId = liveJson?.content?.chatChannelId || channelId
    console.log('[CHZZK] chatChannelId:', chatChannelId)
  } catch(e: any) {
    console.log('[CHZZK] live-detail failed:', e.message)
  }

  // step2: 채팅 액세스 토큰 가져오기
  try {
    const tokenRes = await fetch(
      `https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${chatChannelId}&chatType=STREAMING`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://chzzk.naver.com/' } }
    )
    const tokenJson = await tokenRes.json()
    accessToken = tokenJson?.content?.accessToken || null
    console.log('[CHZZK] accessToken:', accessToken ? 'OK' : 'null')
  } catch(e: any) {
    console.log('[CHZZK] token failed:', e.message)
  }

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
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Origin': 'https://chzzk.naver.com',
      'Referer': 'https://chzzk.naver.com/',
    }
  })

  global.__chzzkWs = ws

  ws.on('open', () => {
    console.log('[CHZZK] open, authenticating...')
    ws.send(JSON.stringify({
      ver: '3',
      cmd: 100,
      svcid: 'game',
      cid: chatChannelId,
      bdy: {
        uid: null,
        devType: 2001,
        accTkn: accessToken,
        auth: 'READ',
        libVer: '4.9.1',
        osVer: 'Windows/10',
        devName: 'Chrome/120.0.0.0',
        locale: 'ko',
        chzzkTk: null,
      },
      tid: 1,
    }))

    global.__chzzkPing = setInterval(() => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ ver: '3', cmd: 0 }))
        console.log('[CHZZK] ping sent')
      }
    }, 20000)

    broadcastSSE('chzzk_connected', { channelId: originalChannelId })
  })

  ws.on('message', (raw: any) => {
    try {
      const str = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
      const msg = JSON.parse(str)
      console.log('[CHZZK] msg cmd:', msg.cmd)

      if (msg.cmd === 0) {
        ws.send(JSON.stringify({ ver: '3', cmd: 10000 }))
        return
      }
      if (msg.cmd === 10000) return // pong

      handleMessage(msg)
    } catch(e: any) {
      console.log('[CHZZK] parse error:', e.message)
    }
  })

  ws.on('close', (code: number, reason: any) => {
    const reasonStr = reason ? reason.toString() : ''
    console.log('[CHZZK] closed code:', code, 'reason:', reasonStr)
    if (global.__chzzkPing) {
      clearInterval(global.__chzzkPing)
      global.__chzzkPing = null
    }
    broadcastSSE('chzzk_disconnected', {})
    if (getState().channelId === originalChannelId) {
      setTimeout(() => connectChatWs(chatChannelId, originalChannelId, accessToken), 5000)
    }
  })

  ws.on('error', (err: Error) => {
    console.error('[CHZZK] error:', err.message)
  })
}

function handleMessage(msg: any) {
  if (msg.cmd === 93101) {
    const chats = msg.bdy?.messageList || []
    chats.forEach((chat: any) => {
      const nickname: string = chat.profile?.nickname || '익명'
      const text: string = (chat.msg || '').trim()
      if (!text) return

      // chatLog에 저장 (최대 200개)
      if (!global.__chatLog) global.__chatLog = []
      global.__chatLog.push({ nickname, text })
      if (global.__chatLog.length > 200) global.__chatLog.shift()
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
    if (!global.__chatLog) global.__chatLog = []
  global.__chatLog.push({ nickname: '🎵 신청곡', text: '이미 대기열에 있습니다', isSystem: true })
  broadcastSSE('chat', { nickname: '🎵 신청곡', text: `이미 대기열에 있습니다`, isSystem: true })
    return
  }

  setState(s => {
    s.music.queue.push({ ...track, requestedBy: nickname, addedAt: Date.now() })
  })

  const sysMsg = { nickname: '🎵 신청곡', text: `[${nickname}] "${track.title}" 추가! (${getState().music.queue.length}번째)`, isSystem: true }
  if (!global.__chatLog) global.__chatLog = []
  global.__chatLog.push(sysMsg)
  broadcastSSE('chat', sysMsg)
  broadcastSSE('music_state', getState().music)
}

export function disconnectChzzk() {
  if (global.__chzzkPing) { clearInterval(global.__chzzkPing); global.__chzzkPing = null }
  if (global.__chzzkWs) {
    setState(s => { s.channelId = null })
    try { global.__chzzkWs.terminate() } catch {}
    global.__chzzkWs = null
    broadcastSSE('chzzk_disconnected', {})
  }
}

export function isChzzkConnected(): boolean {
  return global.__chzzkWs?.readyState === 1
}
