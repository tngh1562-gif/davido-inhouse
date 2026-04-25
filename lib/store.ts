// 전역 싱글톤 스토어 - Next.js에서 모든 API Route가 공유
import { VoteState, RouletteItem, MusicTrack } from './state'

export interface ChatMessage {
  nickname: string
  text: string
  isSystem?: boolean
}

export interface Store {
  vote: VoteState
  roulette: { items: RouletteItem[] }
  music: { queue: MusicTrack[]; currentIdx: number; playing: boolean }
  channelId: string | null
  chatLog: ChatMessage[]
  chzzkWs: any
  chzzkPing: any
}

const defaultStore = (): Store => ({
  vote: { active: false, title: '', items: [], startedAt: null },
  roulette: { items: [] },
  music: { queue: [], currentIdx: 0, playing: false },
  channelId: null,
  chatLog: [],
  chzzkWs: null,
  chzzkPing: null,
})

// globalThis에 저장해서 모든 모듈이 같은 객체 참조
if (!(globalThis as any).__store) {
  (globalThis as any).__store = defaultStore()
}

export function getStore(): Store {
  return (globalThis as any).__store as Store
}
