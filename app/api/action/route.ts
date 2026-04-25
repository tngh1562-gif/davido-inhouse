import { NextRequest, NextResponse } from 'next/server'
import { getStore } from '@/lib/store'
import { searchYouTube } from '@/lib/youtube'
import { connectChzzk, disconnectChzzk, isChzzkConnected } from '@/lib/chzzk'

export const runtime = 'nodejs'

const COLORS = ['#4285f4','#ea4335','#34a853','#fbbc04','#9c27b0','#00bcd4','#ff5722','#607d8b']
const PASSWORD = process.env.APP_PASSWORD || '09870987'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { type } = body

  if (type !== 'login' && type !== 'logout') {
    const auth = req.cookies.get('auth')?.value
    const isDev = process.env.NODE_ENV === 'development'
    if (!isDev && auth !== 'ok') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
  }

  const store = getStore()

  switch (type) {
    // ── 인증 ──
    case 'login': {
      const ok = body.password === PASSWORD
      if (ok) {
        const res = NextResponse.json({ ok: true })
        res.cookies.set('auth', 'ok', { httpOnly: true, maxAge: 60*60*24*30, sameSite: 'lax', path: '/' })
        return res
      }
      return NextResponse.json({ ok: false }, { status: 401 })
    }
    case 'logout': {
      const res = NextResponse.json({ ok: true })
      res.cookies.delete('auth')
      return res
    }

    // ── 치지직 ──
    case 'connect_chzzk':
      await connectChzzk(body.channelId)
      return NextResponse.json({ ok: true })
    case 'disconnect_chzzk':
      disconnectChzzk()
      return NextResponse.json({ ok: true })

    // ── 투표 ──
    case 'start_vote': {
      const items = (body.items as string[]).map((label, i) => ({
        label, votes: [], color: COLORS[i % COLORS.length]
      }))
      store.vote = { active: true, title: body.title || '투표', items, startedAt: Date.now() }
      return NextResponse.json({ ok: true })
    }
    case 'end_vote':
      store.vote.active = false
      return NextResponse.json({ ok: true })
    case 'reset_vote':
      store.vote = { active: false, title: '', items: [], startedAt: null }
      store.chatLog = []
      return NextResponse.json({ ok: true })

    // ── 룰렛 ──
    case 'set_roulette':
      store.roulette.items = body.items || []
      return NextResponse.json({ ok: true })
    case 'vote_to_roulette': {
      const items = store.vote.items.map((it, i) => ({
        label: it.label, weight: it.votes.length || 1, color: COLORS[i % COLORS.length]
      }))
      store.roulette.items = items
      return NextResponse.json({ ok: true })
    }

    // ── 음악 ──
    case 'music_search': {
      const results = await searchYouTube(body.query, 8)
      return NextResponse.json({ ok: true, results })
    }
    case 'music_add_track': {
      const track = body.track
      if (!track?.videoId) return NextResponse.json({ ok: false })
      if (!store.music.queue.some((t: any) => t.videoId === track.videoId)) {
        store.music.queue.push({ ...track, requestedBy: body.requestedBy || '방장', addedAt: Date.now() })
        if (store.music.queue.length === 1) { store.music.currentIdx = 0; store.music.playing = true }
      }
      return NextResponse.json({ ok: true })
    }
    case 'music_manual_add': {
      const results = await searchYouTube(body.query, 1)
      const track = results[0]
      if (!track) return NextResponse.json({ ok: false })
      if (!store.music.queue.some((t: any) => t.videoId === track.videoId)) {
        store.music.queue.push({ ...track, requestedBy: body.requestedBy || '방장', addedAt: Date.now() })
        if (store.music.queue.length === 1) { store.music.currentIdx = 0; store.music.playing = true }
      }
      return NextResponse.json({ ok: true, track })
    }
    case 'music_next':
      if (store.music.queue.length > 0) {
        store.music.currentIdx = (store.music.currentIdx + 1) % store.music.queue.length
        store.music.playing = true
      }
      return NextResponse.json({ ok: true })
    case 'music_prev':
      if (store.music.queue.length > 0) {
        store.music.currentIdx = (store.music.currentIdx - 1 + store.music.queue.length) % store.music.queue.length
        store.music.playing = true
      }
      return NextResponse.json({ ok: true })
    case 'music_play_idx':
      store.music.currentIdx = body.idx
      store.music.playing = true
      return NextResponse.json({ ok: true })
    case 'music_remove':
      store.music.queue.splice(body.idx, 1)
      if (store.music.currentIdx >= store.music.queue.length) {
        store.music.currentIdx = Math.max(0, store.music.queue.length - 1)
      }
      return NextResponse.json({ ok: true })
    case 'music_clear':
      store.music.queue = []; store.music.currentIdx = 0; store.music.playing = false
      return NextResponse.json({ ok: true })
    case 'music_set_playing':
      store.music.playing = body.playing
      return NextResponse.json({ ok: true })

    case 'get_state':
      return NextResponse.json({ ...store, chzzkConnected: isChzzkConnected() })

    default:
      return NextResponse.json({ error: 'unknown type' }, { status: 400 })
  }
}
