// 치지직 채팅 연결 (비공식 WebSocket API)
// 참고: https://github.com/kimcore/chzzk

import { getState, setState } from './state'
import { searchYouTube, YTTrack } from './youtube'

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
  // 기존 연결 종료
  if (global.__chzzkWs) {
    try { global.__chzzkWs.close() } catch {}
    global.__chzzkWs = null
  }

  setState(s => { s.channelId = channelId })

  // 채팅 채널 정보 가져오기 (비공식 API)
  let chatChannelId = channelId
  try {
    const res = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${channelId}/live-detail`)
    const json = await res.json()
    chatChannelId = json?.content?.chatChannelId || channelId
  } catch (e) {
    console.error('[CHZZK] failed to get chatChannelId, using channelId directly')
  }

  connectChatWs(chatChannelId, channelId)
}

function connectChatWs(chatChannelId: string, originalChannelId: string) {
  // Node.js 환경에서 ws 패키지 사용
  let WebSocket: any
  try {
    WebSocket = require('ws')
  } catch {
    console.error('[CHZZK] ws package not found')
    broadcastSSE('error', { message: 'ws 패키지가 필요합니다: npm install ws' })
    return
  }

  const ws = new WebSocket('wss://kr-ss1.chat.naver.com/chat')
  global.__chzzkWs = ws

  ws.on('open', () => {
    console.log('[CHZZK] connected to chat server')
    ws.send(JSON.stringify({
      ver: '2', cmd: 100, svcid: 'game',
      cid: chatChannelId,
      bdy: { uid: null, devType: 2001, accTkn: null, auth: 'READ' },
      tid: 1,
    }))
    broadcastSSE('chzzk_connected', { channelId: originalChannelId })
  })

  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString())
      handleMessage(msg)
    } catch {}
  })

  ws.on('close', () => {
    console.log('[CHZZK] disconnected')
    broadcastSSE('chzzk_disconnected', {})
    // 5초 후 재연결
    if (getState().channelId === originalChannelId) {
      setTimeout(() => connectChatWs(chatChannelId, originalChannelId), 5000)
    }
  })

  ws.on('error', (err: Error) => {
    console.error('[CHZZK] error:', err.message)
    broadcastSSE('error', { message: err.message })
  })
}

function handleMessage(msg: any) {
  // PING → PONG
  if (msg.cmd === 0) {
    if (global.__chzzkWs?.readyState === 1) {
      global.__chzzkWs.send(JSON.stringify({ ver: '2', cmd: 10000 }))
    }
    return
  }

  // 채팅 메시지
  if (msg.cmd === 93101) {
    const chats = msg.bdy?.messageList || []
    chats.forEach((chat: any) => {
      const nickname: string = chat.profile?.nickname || '익명'
      const text: string = (chat.msg || '').trim()

      broadcastSSE('chat', { nickname, text })

      // !투표N 처리
      const state = getState()
      if (state.vote.active) {
        const m = text.match(/^!투표(\d+)$/)
        if (m) {
          const idx = parseInt(m[1]) - 1
          if (idx >= 0 && idx < state.vote.items.length) {
            const alreadyVoted = state.vote.items.some(it => it.votes.includes(nickname))
            if (!alreadyVoted) {
              setState(s => { s.vote.items[idx].votes.push(nickname) })
              broadcastSSE('vote_update', getState().vote)
            }
          }
        }
      }
      // !신청곡 처리
      if (text.startsWith('!신청곡 ') || text.startsWith('!신청곡 ')) {
        const query = text.replace(/^!신청곡\s*/, '').trim()
        if (query) {
          handleMusicRequest(nickname, query)
        }
      }
    })
  }
}

async function handleMusicRequest(nickname: string, query: string) {
  const results = await searchYouTube(query, 1)
  const track = results[0]
  if (!track) {
    broadcastSSE('music_error', { message: `"${query}" 검색 실패`, nickname })
    return
  }
  const state = getState()
  // 중복 체크
  if (state.music.queue.some(t => t.videoId === track.videoId)) {
    broadcastSSE('music_duplicate', { title: track.title, nickname })
    return
  }
  setState(s => {
    s.music.queue.push({
      ...track,
      requestedBy: nickname,
      addedAt: Date.now(),
    })
  })
  broadcastSSE('music_queued', {
    track: { ...track, requestedBy: nickname, addedAt: Date.now() },
    queue: getState().music.queue,
  })
}

export function disconnectChzzk() {
  if (global.__chzzkWs) {
    setState(s => { s.channelId = null })
    try { global.__chzzkWs.close() } catch {}
    global.__chzzkWs = null
    broadcastSSE('chzzk_disconnected', {})
  }
}

export function isChzzkConnected(): boolean {
  return global.__chzzkWs?.readyState === 1
}
