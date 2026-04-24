import { NextRequest, NextResponse } from 'next/server'
import { getState, setState } from '@/lib/state'
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

    default:
      return NextResponse.json({ error: 'unknown type' }, { status: 400 })
  }
}
