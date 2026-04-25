import { NextRequest, NextResponse } from 'next/server'
import { getStore } from '@/lib/store'
import { isChzzkConnected } from '@/lib/chzzk'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const auth = req.cookies.get('auth')?.value
  const isDev = process.env.NODE_ENV === 'development'
  if (!isDev && auth !== 'ok') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const store = getStore()
  return NextResponse.json({
    vote: store.vote,
    roulette: store.roulette,
    music: store.music,
    channelId: store.channelId,
    chzzkConnected: isChzzkConnected(),
    chatLog: store.chatLog,
  })
}
