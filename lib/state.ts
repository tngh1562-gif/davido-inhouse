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

export interface MusicTrack {
  videoId: string
  title: string
  channel: string
  thumbnail: string
  requestedBy: string
  addedAt: number
}

export interface MusicState {
  queue: MusicTrack[]
  currentIdx: number
  playing: boolean
}

export interface AppState {
  vote: VoteState
  roulette: { items: RouletteItem[] }
  music: MusicState
  channelId: string | null
}

declare global {
  var __appState: AppState | undefined
}

export function getState(): AppState {
  if (!global.__appState) {
    global.__appState = {
      vote: { active: false, title: '', items: [], startedAt: null },
      roulette: { items: [] },
      music: { queue: [], currentIdx: 0, playing: false },
      channelId: null,
    }
  }
  if (!global.__appState.music) {
    global.__appState.music = { queue: [], currentIdx: 0, playing: false }
  }
  return global.__appState
}

export function setState(updater: (s: AppState) => void) {
  const s = getState()
  updater(s)
}
