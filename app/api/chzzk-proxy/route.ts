import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

// 브라우저 CORS 우회용 프록시
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const channelId = searchParams.get('channelId')
  if (!channelId) return NextResponse.json({ error: 'no channelId' }, { status: 400 })

  // chatChannelId 가져오기
  let chatChannelId = channelId
  try {
    const r = await fetch(
      `https://api.chzzk.naver.com/service/v2/channels/${channelId}/live-detail`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://chzzk.naver.com/' } }
    )
    const json = await r.json()
    chatChannelId = json?.content?.chatChannelId || channelId
  } catch {}

  // 액세스 토큰
  let accessToken = null
  try {
    const r = await fetch(
      `https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${chatChannelId}&chatType=STREAMING`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://chzzk.naver.com/' } }
    )
    const json = await r.json()
    accessToken = json?.content?.accessToken || null
  } catch {}

  return NextResponse.json({ chatChannelId, accessToken })
}
