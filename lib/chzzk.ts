import { getState, setState } from './state'
import { searchYouTube } from './youtube'

declare global {
  var __chzzkWs: any | undefined
  var __chzzkPing: any | undefined
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
    try { global.__chzzkWs.terminate() } catch {}
    global.__chzzkWs = null
  }
  if (global.__chzzkPing) {
    clearInterval(global.__chzzkPing)
    global.__chzzkPing = null
  }

  setState(s => { s.channelId = channelId })

  // 채팅 채널 ID 가져오기
  let chatChannelId = channelId
  try {
    const res = await fetch(`https://api.chzzk.naver.com/service/v2/channels/${channelId}/live-detail`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    const json = await res.json()
    chatChannelId = json?.content?.chatChannelId || channelId
    console.log('[CHZZK] chatChannelId:', chatChannelId)
  } catch {
    console.log('[CHZZK] using channelId directly:', channelId)
  }

  connectChatWs(chatChannelId, channelId)
}

function connectChatWs(chatChannelId: string, originalChannelId: string) {
  const WS = eval("require")('ws')

  // 치지직 채팅 서버 - 여러 서버 중 하나 선택
  const servers = [
    'wss://kr-ss1.chat.naver.com/chat',
    'wss://kr-ss2.chat.naver.com/chat',
    'wss://kr-ss3.chat.naver.com/chat',
  ]
  const serverUrl = servers[Math.floor(Math.random() * servers.length)]
  
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
    console.log('[CHZZK] open, sending connect packet...')
    
    // 치지직 공식 연결 패킷
    const connectPacket = {
      ver: '3',
      cmd: 100,
      svcid: 'game',
      cid: chatChannelId,
      bdy: {
        uid: null,
        devType: 2001,
        accTkn: null,
        auth: 'READ',
        libVer: '4.9.1',
        osVer: 'Windows/10',
        devName: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        locale: 'ko',
        chzzkTk: null,
      },
      tid: 1,
    }
    ws.send(JSON.stringify(connectPacket))
    
    // PING 30초마다
    global.__chzzkPing = setInterval(() => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ ver: '3', cmd: 0 }))
      }
    }, 20000)
    
    broadcastSSE('chzzk_connected', { channelId: originalChannelId })
  })

  ws.on('message', (raw: any) => {
    try {
      const str = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
      const msg = JSON.parse(str)
      
      // PONG 응답
      if (msg.cmd === 10000 || msg.cmd === 0) {
        ws.send(JSON.stringify({ ver: '3', cmd: 10000 }))
        return
      }
      
      handleMessage(msg)
    } catch {}
  })

  ws.on('close', (code: number, reason: any) => {
    console.log('[CHZZK] closed, code:', code, 'reason:', reason?.toString())
    if (global.__chzzkPing) {
      clearInterval(global.__chzzkPing)
      global.__chzzkPing = null
    }
    broadcastSSE('chzzk_disconnected', {})
    // 재연결
    if (getState().channelId === originalChannelId) {
      console.log('[CHZZK] reconnecting in 5s...')
      setTimeout(() => connectChatWs(chatChannelId, originalChannelId), 5000)
    }
  })

  ws.on('error', (err: Error) => {
    console.error('[CHZZK] error:', err.message)
  })
}

function handleMessage(msg: any) {
  // 채팅 메시지 (cmd 93101)
  if (msg.cmd === 93101) {
    const chats = msg.bdy?.messageList || []
    chats.forEach((chat: any) => {
      const nickname: string = chat.profile?.nickname || '익명'
      const text: string = (chat.msg || '').trim()
      if (!text) return

      broadcastSSE('chat', { nickname, text })

      // 투표 처리
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

      // 신청곡 처리
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
