import { NextRequest } from 'next/server'
import { isChzzkConnected } from '@/lib/chzzk'
import { getState } from '@/lib/state'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      // 연결 즉시 현재 상태 전송
      const state = getState()
      const initMsg = `data: ${JSON.stringify({
        type: 'full_state',
        data: {
          vote: state.vote,
          roulette: state.roulette,
          music: state.music,
          channelId: state.channelId,
          chzzkConnected: isChzzkConnected(),
        }
      })}\n\n`
      controller.enqueue(encoder.encode(initMsg))

      // SSE 클라이언트 등록
      const client = {
        write: (msg: string) => {
          try { controller.enqueue(encoder.encode(msg)) } catch {}
        }
      }
      new Set().add(client)

      // 연결 해제 시 제거
      req.signal.addEventListener('abort', () => {
        new Set().delete(client)
        controller.close()
      })
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    }
  })
}
