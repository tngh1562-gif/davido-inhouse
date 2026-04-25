import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

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
  chatLog: { nickname: string; text: string; isSystem?: boolean }[]
}

const STATE_FILE = join(process.cwd(), '.state.json')

const DEFAULT_STATE: AppState = {
  vote: { active: false, title: '', items: [], startedAt: null },
  roulette: { items: [] },
  music: { queue: [], currentIdx: 0, playing: false },
  channelId: null,
  chatLog: [],
}

export function getState(): AppState {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = readFileSync(STATE_FILE, 'utf8')
      const parsed = JSON.parse(raw)
      return { ...DEFAULT_STATE, ...parsed }
    }
  } catch {}
  return { ...DEFAULT_STATE }
}

export function setState(updater: (s: AppState) => void) {
  const s = getState()
  updater(s)
  try {
    writeFileSync(STATE_FILE, JSON.stringify(s), 'utf8')
  } catch(e: any) {
    console.error('[STATE] write error:', e.message)
  }
}
