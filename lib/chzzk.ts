import { getStore } from './store'
import { searchYouTube } from './youtube'

export async function connectChzzk(channelId: string) {
  const store = getStore()
  
  if (store.chzzkWs) {
    try { store.chzzkWs.terminate() } catch {}
    store.chzzkWs = null
  }
  if (store.chzzkPing) {
    clearInterval(store.chzzkPing)
    store.chzzkPing = null
  }

  store.channelId = channelId

  let chatChannelId = channelId
  try {
    const res = await fetch(
      `https://api.chzzk.naver.com/service/v2/channels/${channelId}/live-detail`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://chzzk.naver.com/' } }
    )
    const json = await res.json()
    chatChannelId = json?.content?.chatChannelId || channelId
    console.log('[CHZZK] chatChannelId:', chatChannelId)
  } catch { console.log('[CHZZK] using channelId directly') }

  // 액세스 토큰은 브라우저에서만 가능 - null로 연결 시도
  console.log('[CHZZK] connecting without token...')
  connectChatWs(chatChannelId, channelId, null)
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
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
      'Origin': 'https://chzzk.naver.com',
      'Referer': 'https://chzzk.naver.com/',
    }
  })

  const store = getStore()
  store.chzzkWs = ws

  ws.on('open', () => {
    console.log('[CHZZK] open!')
    ws.send(JSON.stringify({
      ver: '3', cmd: 100, svcid: 'game', cid: chatChannelId,
      bdy: {
        uid: null, devType: 2001, accTkn: accessToken, auth: 'READ',
        libVer: '4.9.1', osVer: 'Windows/10', devName: 'Chrome/120.0.0.0',
        locale: 'ko', chzzkTk: null,
      },
      tid: 1,
    }))

    store.chzzkPing = setInterval(() => {
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
    const s = getStore()
    if (s.chzzkPing) { clearInterval(s.chzzkPing); s.chzzkPing = null }
    if (s.channelId === originalChannelId) {
      setTimeout(() => connectChatWs(chatChannelId, originalChannelId, accessToken), 5000)
    }
  })

  ws.on('error', (err: Error) => console.error('[CHZZK] error:', err.message))
}

function handleChatMessage(msg: any) {
  const store = getStore()
  const chats = msg.bdy?.messageList || []
  
  chats.forEach((chat: any) => {
    const nickname: string = chat.profile?.nickname || '익명'
    const text: string = (chat.msg || '').trim()
    if (!text) return

    console.log('[CHZZK] chat:', nickname, ':', text)

    // 채팅 로그 저장
    store.chatLog.push({ nickname, text })
    if (store.chatLog.length > 200) store.chatLog.shift()

    // 투표 처리
    if (store.vote.active) {
      const m = text.match(/^!투표(\d+)$/)
      if (m) {
        const idx = parseInt(m[1]) - 1
        if (idx >= 0 && idx < store.vote.items.length) {
          store.vote.items.forEach(it => {
            it.votes = it.votes.filter(v => v !== nickname)
          })
          store.vote.items[idx].votes.push(nickname)
          console.log('[CHZZK] vote:', nickname, '->', store.vote.items[idx].label)
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

async function handleMusicRequest(nickname: string, query: string) {
  const results = await searchYouTube(query, 1)
  const track = results[0]
  if (!track) return

  const store = getStore()
  if (store.music.queue.some((t: any) => t.videoId === track.videoId)) {
    store.chatLog.push({ nickname: '🎵 신청곡', text: '이미 대기열에 있습니다', isSystem: true })
    return
  }

  store.music.queue.push({ ...track, requestedBy: nickname, addedAt: Date.now() })
  store.chatLog.push({
    nickname: '🎵 신청곡',
    text: `[${nickname}] "${track.title}" 추가! (${store.music.queue.length}번째)`,
    isSystem: true,
  })
}

export function disconnectChzzk() {
  const store = getStore()
  if (store.chzzkPing) { clearInterval(store.chzzkPing); store.chzzkPing = null }
  if (store.chzzkWs) {
    store.channelId = null
    try { store.chzzkWs.terminate() } catch {}
    store.chzzkWs = null
  }
}

export function isChzzkConnected(): boolean {
  return getStore().chzzkWs?.readyState === 1
}
