// 서버 전역 상태 (Vercel Edge에서는 메모리가 재시작될 수 있으므로 간단하게 유지)

export interface VoteItem {
  label: string
  votes: string[]
  color: string
}

export interface VoteState {
  active: boolean
  title: string
  items: VoteItem[]
  startedAt: number | null
}

export interface RouletteItem {
  label: string
  weight: number
  color: string
}

export interface AppState {
  vote: VoteState
  roulette: { items: RouletteItem[] }
  channelId: string | null
}

// Node.js 전역 싱글톤 (개발/프로덕션 모두)
declare global {
  var __appState: AppState | undefined
}

export function getState(): AppState {
  if (!global.__appState) {
    global.__appState = {
      vote: { active: false, title: '', items: [], startedAt: null },
      roulette: { items: [] },
      channelId: null,
    }
  }
  return global.__appState
}

export function setState(updater: (s: AppState) => void) {
  const s = getState()
  updater(s)
}
