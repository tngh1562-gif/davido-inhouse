import { NextRequest, NextResponse } from 'next/server'
import { getState } from '@/lib/state'
import { isChzzkConnected } from '@/lib/chzzk'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const auth = req.cookies.get('auth')?.value
  const isDev = process.env.NODE_ENV === 'development'
  if (!isDev && auth !== 'ok') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const state = getState()
  return NextResponse.json({
    vote: state.vote,
    roulette: state.roulette,
    music: state.music,
    channelId: state.channelId,
    chzzkConnected: isChzzkConnected(),
    chatLog: state.chatLog || [],
  })
}
