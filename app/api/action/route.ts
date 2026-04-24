import { NextRequest, NextResponse } from 'next/server'
import { getState, setState } from '@/lib/state'
import { searchYouTube } from '@/lib/youtube'
import { connectChzzk, disconnectChzzk, broadcastSSE, isChzzkConnected } from '@/lib/chzzk'

export const runtime = 'nodejs'

const COLORS = ['#4285f4','#ea4335','#34a853','#fbbc04','#9c27b0','#00bcd4','#ff5722','#607d8b']

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { type } = body

  switch (type) {

    case 'connect_chzzk':
      await connectChzzk(body.channelId)
      return NextResponse.json({ ok: true })

    case 'disconnect_chzzk':
      disconnectChzzk()
      return NextResponse.json({ ok: true })

    case 'get_state':
      return NextResponse.json({
        ...getState(),
        chzzkConnected: isChzzkConnected(),
      })

    // ── 투표 ──────────────────────
    case 'start_vote': {
      const items = (body.items as string[]).filter(i => i.trim()).map((label, i) => ({
        label,
        votes: [] as string[],
        color: COLORS[i % COLORS.length],
      }))
      setState(s => {
        s.vote = { active: true, title: body.title || '투표', items, startedAt: Date.now() }
      })
      broadcastSSE('vote_started', getState().vote)
      return NextResponse.json({ ok: true })
    }

    case 'end_vote':
      setState(s => { s.vote.active = false })
      broadcastSSE('vote_ended', getState().vote)
      return NextResponse.json({ ok: true })

    case 'reset_vote':
      setState(s => { s.vote = { active: false, title: '', items: [], startedAt: null } })
      broadcastSSE('vote_reset', {})
      return NextResponse.json({ ok: true })

    // ── 룰렛 ──────────────────────
    case 'set_roulette':
      setState(s => { s.roulette.items = body.items || [] })
      broadcastSSE('roulette_updated', getState().roulette)
      return NextResponse.json({ ok: true })

    case 'vote_to_roulette': {
      const items = getState().vote.items.map(it => ({
        label: it.label,
        weight: it.votes.length || 1,
        color: it.color,
      }))
      setState(s => { s.roulette.items = items })
      broadcastSSE('roulette_updated', getState().roulette)
      return NextResponse.json({ ok: true })
    }

    // ── 음악 ──────────────────────
    case 'music_next': {
      const state = getState()
      const q = state.music.queue
      setState(s => {
        if (s.music.currentIdx < q.length - 1) s.music.currentIdx++
        else s.music.currentIdx = 0
        s.music.playing = true
      })
      broadcastSSE('music_state', getState().music)
      return NextResponse.json({ ok: true })
    }
    case 'music_prev': {
      setState(s => {
        if (s.music.currentIdx > 0) s.music.currentIdx--
        else s.music.currentIdx = Math.max(0, getState().music.queue.length - 1)
        s.music.playing = true
      })
      broadcastSSE('music_state', getState().music)
      return NextResponse.json({ ok: true })
    }
    case 'music_play_idx': {
      setState(s => { s.music.currentIdx = body.idx; s.music.playing = true })
      broadcastSSE('music_state', getState().music)
      return NextResponse.json({ ok: true })
    }
    case 'music_remove': {
      setState(s => {
        s.music.queue.splice(body.idx, 1)
        if (s.music.currentIdx >= s.music.queue.length) s.music.currentIdx = Math.max(0, s.music.queue.length - 1)
      })
      broadcastSSE('music_state', getState().music)
      return NextResponse.json({ ok: true })
    }
    case 'music_search': {
      const results = await searchYouTube(body.query, 8)
      return NextResponse.json({ ok: true, results })
    }
    case 'music_add_track': {
      const track = body.track
      if (!track?.videoId) return NextResponse.json({ ok: false })
      setState(s => {
        if (s.music.queue.some((t: any) => t.videoId === track.videoId)) return
        s.music.queue.push({ ...track, requestedBy: body.requestedBy || '방장', addedAt: Date.now() })
        if (s.music.queue.length === 1) { s.music.currentIdx = 0; s.music.playing = true }
      })
      broadcastSSE('music_state', getState().music)
      return NextResponse.json({ ok: true })
    }
    case 'music_manual_add': {
      const results = await searchYouTube(body.query, 1)
      const track = results[0]
      if (!track) return NextResponse.json({ ok: false, error: '검색 실패' })
      setState(s => {
        if (s.music.queue.some((t: any) => t.videoId === track.videoId)) return
        s.music.queue.push({ ...track, requestedBy: body.requestedBy || '방장', addedAt: Date.now() })
        if (s.music.queue.length === 1) { s.music.currentIdx = 0; s.music.playing = true }
      })
      broadcastSSE('music_state', getState().music)
      return NextResponse.json({ ok: true, track })
    }
    case 'music_clear': {
      setState(s => { s.music.queue = []; s.music.currentIdx = 0; s.music.playing = false })
      broadcastSSE('music_state', getState().music)
      return NextResponse.json({ ok: true })
    }
    case 'music_set_playing': {
      setState(s => { s.music.playing = body.playing })
      broadcastSSE('music_state', getState().music)
      return NextResponse.json({ ok: true })
    }

    default:
      return NextResponse.json({ error: 'unknown type' }, { status: 400 })
  }
}
