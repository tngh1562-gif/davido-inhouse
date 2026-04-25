import { NextRequest, NextResponse } from 'next/server'
import { getStore } from '@/lib/store'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const { nickname, text } = await req.json()
  const store = getStore()

  // 채팅 저장
  store.chatLog.push({ nickname, text })
  if (store.chatLog.length > 200) store.chatLog.shift()

  // 투표 처리
  if (store.vote.active) {
    const m = text.match(/^!투표(\d+)$/)
    if (m) {
      const idx = parseInt(m[1]) - 1
      if (idx >= 0 && idx < store.vote.items.length) {
        store.vote.items.forEach(it => { it.votes = it.votes.filter(v => v !== nickname) })
        store.vote.items[idx].votes.push(nickname)
      }
    }
  }

  // 신청곡 처리
  if (text.startsWith('!신청곡 ')) {
    const query = text.slice(5).trim()
    // 비동기로 처리 (응답 블로킹 방지)
    handleMusicRequest(nickname, query, store).catch(() => {})
  }

  return NextResponse.json({ ok: true })
}

async function handleMusicRequest(nickname: string, query: string, store: any) {
  const { searchYouTube } = await import('@/lib/youtube')
  const results = await searchYouTube(query, 1)
  const track = results[0]
  if (!track) return
  if (store.music.queue.some((t: any) => t.videoId === track.videoId)) return
  store.music.queue.push({ ...track, requestedBy: nickname, addedAt: Date.now() })
  store.chatLog.push({
    nickname: '🎵 신청곡',
    text: `[${nickname}] "${track.title}" 추가! (${store.music.queue.length}번째)`,
    isSystem: true,
  })
}
