// =============================================
//  다비도의 내전 - 통합 서버
//  npm install ws express chzzk
//  실행: node server.js
// =============================================

const express = require('express');
const ws_module = require('ws');
const { WebSocketServer } = ws_module;
const WebSocket = ws_module; // alias for connectChatWs
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const CHAMPION_KO_MAP = require('./data/champion-ko-map.json');
const CHAMPION_ID_BY_LOWER = new Map(Object.values(CHAMPION_KO_MAP).map(id => [id.toLowerCase(), id]));

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.disable('etag');
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

const IS_RAILWAY = !!(
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.RAILWAY_PROJECT_ID ||
  process.env.RAILWAY_SERVICE_ID
);

function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (IS_RAILWAY && fs.existsSync('/data')) return '/data';
  return path.join(__dirname, 'data');
}

const DATA_DIR = resolveDataDir();
const INHOUSE_DB_FILE = path.join(DATA_DIR, 'inhouse-db.json');
const SEED_INHOUSE_DB_FILE = path.join(__dirname, 'data', 'inhouse-db.seed.json');
const INHOUSE_BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MANUAL_BACKUP_DIR = path.join(DATA_DIR, 'manual-backups');
const MAX_MANUAL_BACKUPS = 5;
const BOT_AUTH_FILE = path.join(DATA_DIR, 'bot-auth.json');
const BOT_STATE_FILE = path.join(DATA_DIR, 'bot-state.json');
const DISCORD_CONFIG_FILE = path.join(DATA_DIR, 'discord-config.json');
const ROULETTE_CONFIG_FILE = path.join(DATA_DIR, 'roulette-config.json');
const WEFLAB_SYNC_FILE = path.join(DATA_DIR, 'weflab-sync.json');
const CUSTOM_CMDS_FILE = path.join(DATA_DIR, 'custom-commands.json');
// Optional: lets the inhouse site ask the separate Discord bot service to send button messages.
function normalizeDiscordBotApiUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/health$/, '')
    .replace(/\/api\/inhouse-register-button$/, '');
}

const DISCORD_BOT_API_URL = normalizeDiscordBotApiUrl(process.env.DISCORD_BOT_API_URL);
const DISCORD_BOT_API_SECRET = process.env.DISCORD_BOT_API_SECRET || '';

const VIEWER_SERVER_URL = (process.env.VIEWER_SERVER_URL || '').replace(/\/+$/, '');
const VIEWER_SERVER_SECRET = process.env.VIEWER_SERVER_SECRET || 'davido-admin';

// ── 사이트 접속 비밀번호 (서버 사이드 세션) ──────────────────────────────────
const SITE_CONFIG_FILE   = path.join(DATA_DIR, 'site-config.json');
const SITE_SESSIONS_FILE = path.join(DATA_DIR, 'site-sessions.json');
const POINT_LOG_FILE     = path.join(DATA_DIR, 'point-log.json');
const SITE_SESSION_COOKIE = 'siteSession';
const SITE_SESSION_MAXAGE = 30 * 24 * 60 * 60; // 30일 (초)

// 서버 재시작 후에도 로그인 유지되도록 파일에 세션 토큰 저장
const siteSessions = new Set();
try { JSON.parse(fs.readFileSync(SITE_SESSIONS_FILE, 'utf8')).forEach(t => siteSessions.add(t)); } catch {}

function saveSiteSessions() {
  try { fs.writeFileSync(SITE_SESSIONS_FILE, JSON.stringify([...siteSessions])); } catch {}
}
function loadSiteConfig() {
  try { return JSON.parse(fs.readFileSync(SITE_CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveSiteConfig(cfg) {
  fs.writeFileSync(SITE_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
function getSitePassword() {
  return process.env.SITE_PASSWORD || loadSiteConfig().sitePassword || '';
}
function parseSiteCookies(cookieHeader) {
  const out = {};
  String(cookieHeader || '').split(';').forEach(p => {
    const eq = p.indexOf('=');
    if (eq < 0) return;
    out[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
  });
  return out;
}
function isSiteAuthenticated(req) {
  const pw = getSitePassword();
  if (!pw) return true;
  return siteSessions.has(parseSiteCookies(req.headers.cookie)[SITE_SESSION_COOKIE] || '');
}
// OBS 오버레이 경로는 인증 불필요 (브라우저 소스가 쿠키 없이 접근)
function isPublicPath(p) {
  return p === '/login.html' || p.startsWith('/api/site-') ||
    p.includes('overlay') || p === '/favicon.ico' || p.startsWith('/models/') ||
    // 봇 API (자체 secret 검증)
    p.startsWith('/api/inhouse-register') || p.startsWith('/api/discord-') ||
    p.startsWith('/api/register-') || p === '/api/inhouse-link' ||
    p === '/api/link-discord' || p === '/api/inhouse-register-mosts' ||
    // OBS 오버레이에서 쿠키 없이 읽는 읽기 전용 엔드포인트
    p === '/api/vote-state' || p === '/api/inhouse-db' || p === '/api/viewer-points' ||
    p === '/api/viewer-deduct' || p === '/api/viewer-grant' || p === '/api/viewer-shop-buy' ||
    p === '/api/viewer-timing-winner' || p === '/api/viewer-inventory' || p === '/api/viewer-pawn-sell';
}

// 인증 미들웨어 — express.static 보다 먼저 등록
app.use((req, res, next) => {
  if (isPublicPath(req.path)) return next();
  if (isSiteAuthenticated(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: '인증이 필요합니다' });
  res.redirect('/login.html');
});

// 브루트포스 방지: IP당 10분에 10회 + 전체 10분에 30회 초과 시 차단
const loginFailMap = new Map(); // ip → { count, firstAt }
const LOGIN_MAX_FAIL = 10;       // IP당 최대 실패 횟수
const LOGIN_BLOCK_MS = 10 * 60 * 1000; // 10분
let globalFailCount = 0;         // 전체 실패 누적
let globalFailWindowStart = Date.now();
const GLOBAL_MAX_FAIL = 30;      // 전체 최대 실패 횟수 (분산 공격 대응)

function getClientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
}

// 로그인
app.post('/api/site-login', (req, res) => {
  const pw = getSitePassword();
  if (!pw) return res.json({ ok: true });

  const ip = getClientIp(req);
  const now = Date.now();

  // 전체 실패 카운터 윈도우 초기화
  if (now - globalFailWindowStart >= LOGIN_BLOCK_MS) {
    globalFailCount = 0;
    globalFailWindowStart = now;
  }

  // 전체 실패 한도 초과 (분산 공격 차단)
  if (globalFailCount >= GLOBAL_MAX_FAIL) {
    const remainSec = Math.ceil((LOGIN_BLOCK_MS - (now - globalFailWindowStart)) / 1000);
    return res.status(429).json({ ok: false, error: `서버가 잠시 잠겼습니다. ${remainSec}초 후 다시 시도하세요.` });
  }

  // IP별 실패 한도 초과
  const fail = loginFailMap.get(ip);
  if (fail && (now - fail.firstAt) < LOGIN_BLOCK_MS && fail.count >= LOGIN_MAX_FAIL) {
    const remainSec = Math.ceil((LOGIN_BLOCK_MS - (now - fail.firstAt)) / 1000);
    return res.status(429).json({ ok: false, error: `너무 많은 시도입니다. ${remainSec}초 후 다시 시도하세요.` });
  }

  if (req.body.password !== pw) {
    // IP별 카운터
    const entry = fail && (now - fail.firstAt) < LOGIN_BLOCK_MS ? fail : { count: 0, firstAt: now };
    entry.count++;
    loginFailMap.set(ip, entry);
    // 전체 카운터
    globalFailCount++;
    return res.status(403).json({ ok: false, error: '비밀번호가 틀렸습니다' });
  }

  loginFailMap.delete(ip); // 성공 시 IP 카운터 초기화
  const token = crypto.randomBytes(32).toString('hex');
  siteSessions.add(token);
  saveSiteSessions();
  res.setHeader('Set-Cookie', `${SITE_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Max-Age=${SITE_SESSION_MAXAGE}; Path=/`);
  res.json({ ok: true });
});

// 비밀번호 변경 (로그인된 상태에서만 가능)
app.post('/api/site-set-password', (req, res) => {
  if (!isSiteAuthenticated(req)) return res.status(401).json({ ok: false, error: '인증이 필요합니다' });
  const newPw = String(req.body.newPassword || '').trim();
  if (!newPw) return res.status(400).json({ ok: false, error: '비밀번호를 입력해주세요' });
  const cfg = loadSiteConfig();
  cfg.sitePassword = newPw;
  saveSiteConfig(cfg);
  // 기존 세션 전부 만료 → 새 토큰 발급 (현재 관리자만 즉시 재로그인)
  siteSessions.clear();
  const token = crypto.randomBytes(32).toString('hex');
  siteSessions.add(token);
  saveSiteSessions();
  res.setHeader('Set-Cookie', `${SITE_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Max-Age=${SITE_SESSION_MAXAGE}; Path=/`);
  res.json({ ok: true });
});

// 비밀번호 설정 여부 확인 (로그인 페이지에서 호출)
app.get('/api/site-auth-status', (req, res) => {
  res.json({ hasPassword: !!getSitePassword(), authenticated: isSiteAuthenticated(req) });
});

// 정적 파일 서빙 (인증 미들웨어 이후)
app.get('/', (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'));
});
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: res => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));

// 경매사이트 결과화면 "디스코드 이동" 버튼용 — 경매 전용 음성채널/역할 (내전사이트 채널과 별도)
const AUCTION_VOICE_LOBBY_ID = '1513880611386036354';
const AUCTION_TEAM_VOICE_IDS = ['1513879916603506858','1513879935696240640','1513879983003533422','1513880001207078952'];
const AUCTION_TEAM_ROLE_IDS  = ['1514998921737277624','1514998928519467209','1513871886608764938','1513871903763337276'];

function defaultInhouseDB() {
  return {
    players: [],
    history: [],
    viewers: [],
    curBlue: [],
    curRed: [],
    pid: 0,
    vid: 0,
    updatedAt: null,
  };
}

function normalizeInhouseDB(data) {
  return {
    players: Array.isArray(data?.players) ? data.players : [],
    history: Array.isArray(data?.history) ? data.history : [],
    viewers: Array.isArray(data?.viewers) ? data.viewers : [],
    curBlue: Array.isArray(data?.curBlue) ? data.curBlue : [],
    curRed: Array.isArray(data?.curRed) ? data.curRed : [],
    pid: Number.isFinite(Number(data?.pid)) ? Number(data.pid) : 0,
    vid: Number.isFinite(Number(data?.vid)) ? Number(data.vid) : 0,
    updatedAt: data?.updatedAt || null,
  };
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function latestBackupFile() {
  try {
    if (!fs.existsSync(INHOUSE_BACKUP_DIR)) return null;
    return fs.readdirSync(INHOUSE_BACKUP_DIR)
      .filter(name => /^inhouse-db-\d+\.json$/.test(name))
      .sort()
      .pop() || null;
  } catch (err) {
    console.error('[INHOUSE_DB] backup scan failed:', err.message);
    return null;
  }
}

function backupInhouseDB(data) {
  try {
    if (!data || !Array.isArray(data.viewers) || !data.viewers.length) return;
    if (!fs.existsSync(INHOUSE_BACKUP_DIR)) fs.mkdirSync(INHOUSE_BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const file = path.join(INHOUSE_BACKUP_DIR, `inhouse-db-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');

    const backups = fs.readdirSync(INHOUSE_BACKUP_DIR)
      .filter(name => /^inhouse-db-\d+\.json$/.test(name))
      .sort();
    backups.slice(0, Math.max(0, backups.length - 30)).forEach(name => {
      fs.unlinkSync(path.join(INHOUSE_BACKUP_DIR, name));
    });
  } catch (err) {
    console.error('[INHOUSE_DB] backup failed:', err.message);
  }
}

function mergeViewers(existing, incoming) {
  const merged = [];
  const indexById = new Map();
  const indexByName = new Map();
  const remember = (viewer, index) => {
    if (!viewer || !viewer.name) return;
    if (Number.isFinite(Number(viewer.id))) indexById.set(Number(viewer.id), index);
    indexByName.set(String(viewer.name).trim().toLowerCase(), index);
  };

  existing.forEach(viewer => {
    if (!viewer || !viewer.name) return;
    merged.push({ ...viewer });
    remember(viewer, merged.length - 1);
  });

  incoming.forEach(viewer => {
    if (!viewer || !viewer.name) return;
    const id = Number(viewer.id);
    const key = String(viewer.name).trim().toLowerCase();
    const priorIndex = (Number.isFinite(id) ? indexById.get(id) : undefined) ?? indexByName.get(key);
    const prior = Number.isInteger(priorIndex) ? merged[priorIndex] : {};
    const next = { ...prior, ...viewer };
    if (Number.isInteger(priorIndex)) {
      merged[priorIndex] = next;
      remember(next, priorIndex);
    } else {
      merged.push(next);
      remember(next, merged.length - 1);
    }
  });

  return merged;
}

function writeViewerUpsert(viewer, clearDiscordId) {
  const existing = readInhouseDB();
  let base = existing.viewers;
  if (clearDiscordId) {
    base = base.map(v =>
      String(v.discordId || '').replace(/\D/g, '') === clearDiscordId && String(v.id) !== String(viewer.id)
        ? { ...v, discordId: undefined }
        : v
    );
  }
  const viewers = mergeViewers(base, [viewer]);
  return writeInhouseDB(
    {
      baseUpdatedAt: existing.updatedAt,
      viewers,
      vid: Math.max(Number(existing.vid) || 0, ...viewers.map(v => Number(v.id) || 0)),
    },
    { mergeViewers: true }
  );
}

function readInhouseDB() {
  try {
    if (fs.existsSync(INHOUSE_DB_FILE)) return { ...defaultInhouseDB(), ...normalizeInhouseDB(readJsonFile(INHOUSE_DB_FILE)) };

    const backup = latestBackupFile();
    if (backup) {
      const restored = { ...defaultInhouseDB(), ...normalizeInhouseDB(readJsonFile(path.join(INHOUSE_BACKUP_DIR, backup))) };
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(INHOUSE_DB_FILE, JSON.stringify(restored), 'utf8');
      return restored;
    }

    if (!IS_RAILWAY && fs.existsSync(SEED_INHOUSE_DB_FILE)) {
      const seeded = { ...defaultInhouseDB(), ...normalizeInhouseDB(readJsonFile(SEED_INHOUSE_DB_FILE)) };
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(INHOUSE_DB_FILE, JSON.stringify(seeded), 'utf8');
      return seeded;
    }

    return defaultInhouseDB();
  } catch (err) {
    console.error('[INHOUSE_DB] read failed:', err.message);
    return defaultInhouseDB();
  }
}

function writeInhouseDB(data, options = {}) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const existing = readInhouseDB();
  backupInhouseDB(existing);

  const incoming = normalizeInhouseDB(data || {});
  const hasIncomingViewers = Array.isArray(data?.viewers);
  const hasIncomingPlayers = Array.isArray(data?.players);
  const hasIncomingHistory = Array.isArray(data?.history);
  const hasIncomingBlue = Array.isArray(data?.curBlue);
  const hasIncomingRed = Array.isArray(data?.curRed);
  if (options.mergeViewers !== true && existing.updatedAt) {
    const baseUpdatedAt = data?.baseUpdatedAt || data?.updatedAt || null;
    if (!baseUpdatedAt || baseUpdatedAt !== existing.updatedAt) {
      const err = new Error('stale_db_snapshot');
      err.statusCode = 409;
      err.currentUpdatedAt = existing.updatedAt;
      throw err;
    }
  }
  const viewers = !hasIncomingViewers
    ? existing.viewers
    : options.mergeViewers === true
    ? mergeViewers(existing.viewers, incoming.viewers)
    : incoming.viewers;
  if (hasIncomingViewers && options.mergeViewers !== true && !data?.allowViewerShrink) {
    const oldCount = Array.isArray(existing.viewers) ? existing.viewers.length : 0;
    const nextCount = Array.isArray(viewers) ? viewers.length : 0;
    const suspiciousDrop = oldCount >= 20 && nextCount < oldCount - 5 && nextCount < Math.floor(oldCount * 0.95);
    if (suspiciousDrop) {
      const err = new Error('viewer_db_shrink_guard');
      err.statusCode = 409;
      err.currentViewers = oldCount;
      err.incomingViewers = nextCount;
      throw err;
    }
  }
  const maxViewerId = viewers.reduce((max, viewer) => Math.max(max, Number(viewer.id) || 0), 0);
  const payload = {
    ...incoming,
    players: hasIncomingPlayers ? incoming.players : existing.players,
    history: hasIncomingHistory ? incoming.history : existing.history,
    viewers,
    curBlue: hasIncomingBlue ? incoming.curBlue : existing.curBlue,
    curRed: hasIncomingRed ? incoming.curRed : existing.curRed,
    pid: Number.isFinite(Number(data?.pid)) ? Number(data.pid) : existing.pid,
    vid: hasIncomingViewers ? Math.max(incoming.vid || 0, existing.vid || 0, maxViewerId) : Math.max(existing.vid || 0, maxViewerId),
    updatedAt: new Date().toISOString(),
  };
  const tmp = INHOUSE_DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmp, INHOUSE_DB_FILE);
  return payload;
}

function normalizeRegisterText(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

function normalizeRegisterTier(value) {
  const raw = normalizeRegisterText(value, 40);
  if (!raw) return '';
  const upper = raw.toUpperCase().replace(/\s+/g, '');
  const compact = upper
    .replace(/^IRON/, 'IR').replace(/^아이언/, 'IR')
    .replace(/^BRONZE/, 'BR').replace(/^브론즈/, 'BR')
    .replace(/^SILVER/, 'SI').replace(/^실버/, 'SI')
    .replace(/^GOLD/, 'GO').replace(/^골드/, 'GO')
    .replace(/^PLATINUM/, 'PL').replace(/^플래티넘/, 'PL').replace(/^플레티넘/, 'PL').replace(/^플래/, 'PL')
    .replace(/^EMERALD/, 'EM').replace(/^에메랄드/, 'EM')
    .replace(/^DIAMOND/, 'DI').replace(/^다이아몬드/, 'DI').replace(/^다이아/, 'DI')
    .replace(/^MASTER/, 'MS').replace(/^마스터/, 'MS')
    .replace(/^GRANDMASTER/, 'GM').replace(/^그랜드마스터/, 'GM')
    .replace(/^CHALLENGER/, 'CH').replace(/^챌린저/, 'CH');
  if (/^(CH|GM)$/.test(compact)) return compact;
  if (/^M(?:S|ASTER)?\d*$/.test(compact)) return 'MS' + (compact.match(/\d+/)?.[0] || '0');
  const m = compact.match(/^(IR|BR|SI|GO|PL|EM|DI)([1-4])$/);
  return m ? `${m[1]}${m[2]}` : raw;
}

function normalizeRegisterPosition(value) {
  const raw = normalizeRegisterText(value, 30);
  const key = raw.toLowerCase().replace(/\s+/g, '');
  const map = {
    top: '탑', t: '탑', 탑: '탑',
    jug: '정글', jg: '정글', jgl: '정글', jungle: '정글', j: '정글', 정글: '정글',
    mid: '미드', m: '미드', 미드: '미드',
    adc: '원딜', ad: '원딜', bot: '원딜', 원딜: '원딜',
    sup: '서포터', supp: '서포터', support: '서포터', spt: '서포터', 서폿: '서포터', 서포터: '서포터',
    fill: '무관', any: '무관', none: '무관', 무관: '무관', '-': '무관',
  };
  return map[key] || raw || '무관';
}

function normalizeRegisterPositions(body) {
  const koreanPositions = body['포지션'];
  const singularPosition = body.position || body.pos || koreanPositions;
  const hasPositions = Array.isArray(body.positions)
    || singularPosition
    || body.position1 || body.pos1 || body.mainPosition || body.mainPos
    || body.position2 || body.pos2 || body.subPosition || body.subPos
    || body.position3 || body.pos3;
  if (!hasPositions) return [];
  const raw = Array.isArray(body.positions)
    ? body.positions
    : Array.isArray(singularPosition)
      ? singularPosition
      : singularPosition
        ? String(singularPosition).split(/[,/|]/)
    : [body.position1 || body.pos1 || body.mainPosition || body.mainPos, body.position2 || body.pos2 || body.subPosition || body.subPos, body.position3 || body.pos3];
  const positions = raw.map(normalizeRegisterPosition).filter(Boolean).slice(0, 3);
  while (positions.length < 3) positions.push('무관');
  return positions;
}

function normalizeRegisterName(body) {
  const direct = normalizeRegisterText(body.name || body.lolName || body.lolNickname || body.riotName || body.riotNickname || body.riotId || body.summonerName || body['룰닉'] || body['롤닉'], 120);
  if (direct) return direct;
  const gameName = normalizeRegisterText(body.gameName || body.lolId || body.game_name, 80);
  const tagLine = normalizeRegisterText(body.tagLine || body.tag || body.riotTag, 30).replace(/^#/, '');
  if (gameName && tagLine) return `${gameName}#${tagLine}`;
  return gameName;
}

function normalizeChampionName(raw) {
  const name = String(raw || '').replace(/\s+/g, '');
  if (!name) return null;
  if (CHAMPION_KO_MAP[name]) return CHAMPION_KO_MAP[name];
  return CHAMPION_ID_BY_LOWER.get(name.toLowerCase()) || null;
}

function normalizeRegisterMosts(body) {
  const raw = Array.isArray(body.mosts)
    ? body.mosts
    : [
        body.most1 || body.most_1 || body['모스트1'],
        body.most2 || body.most_2 || body['모스트2'],
        body.most3 || body.most_3 || body['모스트3'],
      ];
  return raw.map(normalizeChampionName).filter(Boolean).slice(0, 3);
}

function upsertViewerMostsFromDiscord(body) {
  const db = readInhouseDB();
  const discordId = normalizeRegisterText(body.discordId || body.discordUserId || body.userId || body.memberId, 40).replace(/\D/g, '');
  const name = normalizeRegisterName(body);
  const chzzk = normalizeRegisterText(body.chzzk || body.chzzkNick || body.chzzkNickname || body.chzzkName || body.chatName || body.chatNickname || body['치지직'], 120);
  const mosts = normalizeRegisterMosts(body);

  if (!mosts.length) {
    const err = new Error('인식할 수 있는 챔피언 이름이 없습니다.');
    err.statusCode = 400;
    throw err;
  }
  if (!discordId && !name && !chzzk) {
    const err = new Error('등록할 닉네임 또는 디스코드 ID가 필요합니다.');
    err.statusCode = 400;
    throw err;
  }

  const norm = value => String(value || '').trim().toLowerCase();
  const cleanName = norm(name);
  const cleanChzzk = norm(chzzk);
  const viewer = db.viewers.find(v => discordId && String(v.discordId || '').replace(/\D/g, '') === discordId)
    || db.viewers.find(v => cleanChzzk && norm(v.chzzk) === cleanChzzk)
    || db.viewers.find(v => cleanName && norm(v.name) === cleanName);

  if (!viewer) {
    const err = new Error('내전 참가 등록을 먼저 진행해주세요.');
    err.statusCode = 404;
    throw err;
  }

  viewer.mosts = mosts;
  viewer.updatedAt = Date.now();
  return { db: writeViewerUpsert(viewer, null), viewer, mosts };
}

function upsertViewerFromDiscordRegistration(body) {
  const db = readInhouseDB();
  const discordId = normalizeRegisterText(body.discordId || body.discordUserId || body.userId || body.memberId, 40).replace(/\D/g, '');
  const name = normalizeRegisterName(body);
  const chzzk = normalizeRegisterText(body.chzzk || body.chzzkNick || body.chzzkNickname || body.chzzkName || body.chatName || body.chatNickname || body['치지직'], 120);
  const tier = normalizeRegisterTier(body.tier || body.rank || body.lolTier || body['티어']);
  const memo = normalizeRegisterText(body.memo || body.note, 500);
  const positions = normalizeRegisterPositions(body);
  const mic = (() => {
    const raw = String(body.mic || body.microphone || body['마이크'] || '').trim().toLowerCase();
    if (!raw) return undefined;
    if (['가능','yes','y','o','ㅇ','1','true','ok','됨'].includes(raw)) return '가능';
    if (['부분','부분가능','partial','가끔'].includes(raw)) return '부분가능';
    return '불가';
  })();
  const now = Date.now();

  if (!discordId && !name && !chzzk) {
    const err = new Error('등록할 닉네임 또는 디스코드 ID가 필요합니다.');
    err.statusCode = 400;
    throw err;
  }

  const norm = value => String(value || '').trim().toLowerCase();
  const cleanName = norm(name);
  const cleanChzzk = norm(chzzk);
  let viewer = db.viewers.find(v => discordId && String(v.discordId || '').replace(/\D/g, '') === discordId)
    || db.viewers.find(v => cleanChzzk && norm(v.chzzk) === cleanChzzk)
    || db.viewers.find(v => cleanName && norm(v.name) === cleanName);

  if (!viewer) {
    if (!name) {
      const err = new Error('신규 등록은 롤 닉네임이 필요합니다.');
      err.statusCode = 400;
      throw err;
    }
    if (!tier) {
      const err = new Error('신규 등록은 티어가 필요합니다.');
      err.statusCode = 400;
      throw err;
    }
    viewer = {
      id: Math.max(Number(db.vid) || 0, ...db.viewers.map(v => Number(v.id) || 0)) + 1,
      name,
      chzzk,
      tier,
      positions: positions.length ? positions : ['무관', '무관', '무관'],
      memo,
      mic: mic || '불가',
      discordId,
      added: now,
      registeredFrom: 'discord',
    };
    db.viewers.push(viewer);
  } else {
    if (name) viewer.name = name;
    if (chzzk) viewer.chzzk = chzzk;
    if (tier) viewer.tier = tier;
    if (positions.length) viewer.positions = positions;
    if (memo) viewer.memo = memo;
    if (mic !== undefined) viewer.mic = mic;
    if (discordId) viewer.discordId = discordId;
    viewer.updatedAt = now;
    viewer.registeredFrom = viewer.registeredFrom || 'discord';
  }

  db.vid = Math.max(Number(db.vid) || 0, Number(viewer.id) || 0);
  return { db: writeViewerUpsert(viewer, discordId || null), viewer };
}

function defaultDiscordConfig() {
  return {
    registerButtonEnabled: true,
    recentPlacementEnabled: true,
    channelOverrides: {},
    buttonOnly: false,
    plainMessage: false,
    buttonLabel: '내전 참가 등록',
    buttonStyle: 'primary',
    panelTitle: '내전 참가 등록',
    panelDescription: '내전 참가 등록은 전체 정보를 입력하고, 디코 연동은 기존 DB 유저가 치지직 닉네임만 입력해 디스코드 ID를 연결합니다.',
    messageContent: '# 내전 참가 등록\n처음 등록하는 사람은 내전 참가 등록 버튼을 눌러주세요.\n이미 시청자 DB에 등록된 사람은 디코 연동 버튼을 누르고 치지직 닉네임만 입력하면 음성방 이동 기능을 사용할 수 있습니다.',
    voiceLobbyChannelId: '',
    voiceBlueChannelId: '',
    voiceRedChannelId: '',
    updatedAt: null,
  };
}

function normalizeDiscordConfig(data) {
  const base = defaultDiscordConfig();
  const style = ['primary', 'success', 'danger', 'secondary'].includes(data?.buttonStyle) ? data.buttonStyle : base.buttonStyle;
  const channelOverrides = {};
  if (data?.channelOverrides && typeof data.channelOverrides === 'object') {
    Object.entries(data.channelOverrides).forEach(([channelId, value]) => {
      const id = String(channelId || '').replace(/\D/g, '');
      if (!id) return;
      channelOverrides[id] = { recentPlacementEnabled: value?.recentPlacementEnabled !== false };
    });
  }
  return {
    registerButtonEnabled: data?.registerButtonEnabled !== false,
    recentPlacementEnabled: data?.recentPlacementEnabled !== false,
    channelOverrides,
    buttonOnly: data?.buttonOnly === true,
    plainMessage: data?.plainMessage === true,
    buttonLabel: String(data?.buttonLabel || base.buttonLabel).slice(0, 80),
    buttonStyle: style,
    panelTitle: String(data?.panelTitle || base.panelTitle).slice(0, 120),
    panelDescription: String(data?.panelDescription || base.panelDescription).slice(0, 1800),
    messageContent: String(data?.messageContent || data?.panelDescription || base.messageContent).slice(0, 1900),
    voiceLobbyChannelId: String(data?.voiceLobbyChannelId || '').replace(/\D/g, ''),
    voiceBlueChannelId: String(data?.voiceBlueChannelId || '').replace(/\D/g, ''),
    voiceRedChannelId: String(data?.voiceRedChannelId || '').replace(/\D/g, ''),
    updatedAt: data?.updatedAt || null,
  };
}

function readDiscordConfig() {
  try {
    if (fs.existsSync(DISCORD_CONFIG_FILE)) return normalizeDiscordConfig(readJsonFile(DISCORD_CONFIG_FILE));
  } catch (err) {
    console.error('[DISCORD_CONFIG] read failed:', err.message);
  }
  return defaultDiscordConfig();
}

function readCustomCmds() {
  try {
    if (fs.existsSync(CUSTOM_CMDS_FILE)) return JSON.parse(fs.readFileSync(CUSTOM_CMDS_FILE, 'utf8'));
  } catch {}
  return [];
}
function writeCustomCmds(list) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CUSTOM_CMDS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function writeDiscordConfig(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = normalizeDiscordConfig({ ...readDiscordConfig(), ...(data || {}), updatedAt: new Date().toISOString() });
  const tmp = DISCORD_CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, DISCORD_CONFIG_FILE);
  return payload;
}

function defaultRouletteConfig() {
  return {
    enabled: true,
    triggerAmount: 1500,
    exactAmountOnly: true,
    autoSpin: true,
    saveToStorage: true,
    overlayTitle: '1500치즈 룰렛',
    items: [
      { id: 'reward-1', label: '벌칙 면제권', weight: 25, storageReward: '벌칙 면제권', color: '#00c8a0', enabled: true },
      { id: 'reward-2', label: '다시 돌리기', weight: 25, storageReward: '', color: '#4d9fff', enabled: true },
      { id: 'reward-3', label: '꽝', weight: 50, storageReward: '', color: '#64748b', enabled: true },
    ],
    history: [],
    updatedAt: null,
  };
}

function normalizeRouletteItem(item, index = 0) {
  const colors = ['#00c8a0', '#4d9fff', '#ffc94d', '#a78bfa', '#dc2626', '#22c55e', '#f97316', '#e879f9'];
  return {
    id: String(item?.id || `reward-${Date.now()}-${index}`).slice(0, 80),
    label: String(item?.label || item?.name || '새 룰렛').trim().slice(0, 80),
    weight: Math.max(0.1, Math.min(100, Number(item?.probability ?? item?.chance ?? item?.weight) || 1)),
    storageReward: String(item?.storageReward || '').trim().slice(0, 80),
    color: /^#[0-9a-f]{6}$/i.test(String(item?.color || '')) ? String(item.color) : colors[index % colors.length],
    enabled: item?.enabled !== false,
  };
}

function normalizeRouletteConfig(data) {
  const base = defaultRouletteConfig();
  const items = Array.isArray(data?.items)
    ? data.items.map(normalizeRouletteItem).filter(item => item.label)
    : base.items;
  const history = Array.isArray(data?.history)
    ? data.history.slice(-80).map(entry => ({
        id: String(entry?.id || '').slice(0, 80),
        nickname: String(entry?.nickname || '').slice(0, 80),
        amount: Number(entry?.amount) || 0,
        result: String(entry?.result || '').slice(0, 80),
        storageReward: String(entry?.storageReward || '').slice(0, 80),
        source: String(entry?.source || 'manual').slice(0, 30),
        createdAt: entry?.createdAt || new Date().toISOString(),
      }))
    : [];
  return {
    enabled: data?.enabled !== false,
    triggerAmount: Math.max(1, Math.min(1000000, Math.round(Number(data?.triggerAmount) || base.triggerAmount))),
    exactAmountOnly: data?.exactAmountOnly !== false,
    autoSpin: data?.autoSpin !== false,
    saveToStorage: data?.saveToStorage !== false,
    overlayTitle: String(data?.overlayTitle || base.overlayTitle).trim().slice(0, 80),
    items,
    history,
    updatedAt: data?.updatedAt || null,
  };
}

function readRouletteConfig() {
  try {
    if (fs.existsSync(ROULETTE_CONFIG_FILE)) return normalizeRouletteConfig(readJsonFile(ROULETTE_CONFIG_FILE));
  } catch (err) {
    console.error('[ROULETTE_CONFIG] read failed:', err.message);
  }
  return defaultRouletteConfig();
}

function writeRouletteConfig(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = normalizeRouletteConfig({ ...readRouletteConfig(), ...(data || {}), updatedAt: new Date().toISOString() });
  const tmp = ROULETTE_CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, ROULETTE_CONFIG_FILE);
  return payload;
}

function pickRouletteItem(items) {
  const pool = (Array.isArray(items) ? items : []).filter(item => item.enabled !== false && item.weight > 0);
  if (!pool.length) return null;
  const total = pool.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * total;
  for (const item of pool) {
    roll -= item.weight;
    if (roll < 0) return item;
  }
  return pool[pool.length - 1];
}

// 룰렛 당첨 시 보관함봇에 보상을 자동 지급하고, 관리자 화면에 실시간 반영되도록 알림
async function grantStorageReward({ nickname, rewardName, count = 1 }) {
  if (!nickname || !rewardName) return;
  if (!DISCORD_BOT_API_URL || !DISCORD_BOT_API_SECRET) return;
  try {
    const result = await postJson(`${DISCORD_BOT_API_URL}/api/bot-command`, {
      secret: DISCORD_BOT_API_SECRET,
      command: '추가',
      options: { 닉네임: nickname, 보상이름: rewardName, 개수: count },
    });
    if (result?.ok) {
      console.log(`[STORAGE] ${nickname} 보관함에 "${rewardName}" +${count} 지급 완료`);
      broadcast({ type: 'storage_update', nickname, rewardName, count });
    } else {
      console.warn(`[STORAGE] ${nickname} 보관함 지급 실패:`, result?.error || result?.message);
    }
  } catch (err) {
    console.warn(`[STORAGE] ${nickname} 보관함 지급 호출 실패:`, err.message);
  }
}

// ── 위플랩(weflab.com) 룰렛 결과 자동 동기화 ──────────────────────────
// 시청자가 실제로 보는 룰렛은 위플랩이라, weflab.com/alertlist 의 내부 API를
// 주기적으로 폴링해서 새 결과가 생기면 그대로 보관함에 반영한다.
const WEFLAB_POLL_MS = 20000; // 20초마다 확인
const WEFLAB_API_URL = 'https://weflab.com/api/';

function loadWeflabSync() {
  try {
    if (fs.existsSync(WEFLAB_SYNC_FILE)) {
      const saved = readJsonFile(WEFLAB_SYNC_FILE);
      if (saved && typeof saved === 'object') {
        return {
          cookie: String(saved.cookie || ''),
          lastIdx: String(saved.lastIdx || ''),
          enabled: saved.enabled !== false,
        };
      }
    }
  } catch (e) {}
  return { cookie: '', lastIdx: '', enabled: true };
}

function saveWeflabSync() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WEFLAB_SYNC_FILE, JSON.stringify({
      cookie: weflabSync.cookie,
      lastIdx: weflabSync.lastIdx,
      enabled: weflabSync.enabled,
    }), 'utf8');
  } catch (e) {
    console.error('[WEFLAB_SYNC] 저장 실패:', e.message);
  }
}

const weflabSync = Object.assign(loadWeflabSync(), { lastPollAt: null, lastError: null });

function weflabSyncStatusPayload() {
  return {
    enabled: weflabSync.enabled !== false,
    hasCookie: !!weflabSync.cookie,
    lastIdx: weflabSync.lastIdx || '',
    lastPollAt: weflabSync.lastPollAt || null,
    lastError: weflabSync.lastError || null,
  };
}

function parseCookieString(cookieStr) {
  const map = {};
  String(cookieStr || '').split(';').forEach(pair => {
    const eq = pair.indexOf('=');
    if (eq === -1) return;
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (key) map[key] = val;
  });
  return map;
}

function postForm(url, formData, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = Buffer.from(
      Object.entries(formData).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? '')}`).join('&'),
      'utf8'
    );
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': body.length,
        ...extraHeaders,
      },
      timeout: 15000,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
        if (res.statusCode >= 400) {
          const err = new Error(data.error || `HTTP ${res.statusCode}`);
          err.data = data;
          reject(err);
          return;
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request_timeout')));
    req.write(body);
    req.end();
  });
}

function formatWeflabDate(date) {
  // 서버 타임존(예: UTC)에 관계없이 항상 KST(UTC+9) 기준으로 포맷 — 위플랩은 한국 서비스라 KST로 해석함
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${kst.getUTCFullYear()}${pad(kst.getUTCMonth() + 1)}${pad(kst.getUTCDate())}${pad(kst.getUTCHours())}${pad(kst.getUTCMinutes())}`;
}

// 위플랩 룰렛 항목명 → 보관함봇 보상명이 다른 경우 매핑 (예: "내전 1판 연장" → "내전 1판 연장권")
const WEFLAB_REWARD_ALIAS = {
  '내전 1판 연장': '내전 1판 연장권',
};

// 위플랩 alertlist 항목 1건을 파싱해서 결과 항목명 배열로 반환 ([["꽝꽝꽝꽝꽝꽝","50"], ...] → ["꽝꽝꽝꽝꽝꽝", ...])
function parseWeflabResultNames(entry) {
  let names = [];
  try {
    const list = JSON.parse(entry?.list || '[]');
    if (Array.isArray(list)) names = list.map(row => String(row?.[0] || '').trim()).filter(Boolean);
  } catch (e) {}
  if (!names.length && entry?.roulette) names = [String(entry.roulette).trim()];
  return names.map(name => WEFLAB_REWARD_ALIAS[name] || name);
}

async function processWeflabAlertEntry(entry) {
  const nickname = String(entry?.name || '').trim();
  if (!nickname) return;
  const results = parseWeflabResultNames(entry);
  if (!results.length) return;

  console.log(`[WEFLAB_SYNC] ${nickname} 룰렛 결과 ${results.length}건 감지: ${results.join(', ')}`);
  for (const rewardName of results) {
    await grantStorageReward({ nickname, rewardName });
  }
}

let weflabPolling = false;
async function pollWeflabAlerts() {
  if (weflabPolling) return;
  if (!weflabSync.enabled || !weflabSync.cookie) return;
  weflabPolling = true;
  try {
    const cookies = parseCookieString(weflabSync.cookie);
    const loginIdx = cookies['login_idx'] || '';
    if (!loginIdx) {
      weflabSync.lastError = '쿠키에서 login_idx 값을 찾을 수 없습니다. 쿠키 값을 다시 확인해주세요.';
      return;
    }

    const now = new Date();
    const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const end = new Date(now.getTime() + 60 * 60 * 1000);

    const resp = await postForm(WEFLAB_API_URL, {
      type: 'alertlist_load',
      pagetype: 'setup',
      idx: loginIdx,
      pageid: 'alertlist',
      preset: '0',
      'ver[server]': '20240607',
      'ver[socket]': '20240607',
      lastdate: '',
      'filter[start]': formatWeflabDate(start),
      'filter[end]': formatWeflabDate(end),
      'filter[min]': '0',
      'filter[type]': 'all',
      'filter[search]': '',
    }, { Cookie: weflabSync.cookie });

    weflabSync.lastPollAt = new Date().toISOString();

    if (resp?.result !== 'success' || !Array.isArray(resp?.data)) {
      weflabSync.lastError = `위플랩 응답 오류 (쿠키가 만료됐을 수 있어요): ${resp?.result || 'unknown'}`;
      return;
    }
    weflabSync.lastError = null;
    if (!resp.data.length) return;

    if (!weflabSync.lastIdx) {
      // 최초 동기화: 과거 내역까지 한꺼번에 지급되는 것을 막기 위해 기준점만 설정
      weflabSync.lastIdx = String(resp.data[0].idx || '');
      saveWeflabSync();
      console.log(`[WEFLAB_SYNC] 최초 연동 — 기준점 idx=${weflabSync.lastIdx} (이전 내역은 지급하지 않음)`);
      return;
    }

    const lastIdxNum = Number(weflabSync.lastIdx) || 0;
    const newEntries = resp.data
      .filter(e => Number(e?.idx) > lastIdxNum)
      .reverse(); // 오래된 것부터 순서대로 처리

    for (const entry of newEntries) {
      await processWeflabAlertEntry(entry);
      weflabSync.lastIdx = String(entry.idx);
      saveWeflabSync();
    }
  } catch (err) {
    weflabSync.lastPollAt = new Date().toISOString();
    weflabSync.lastError = err.message || '위플랩 호출 실패';
    console.warn('[WEFLAB_SYNC] 폴링 실패:', err.message);
  } finally {
    weflabPolling = false;
  }
}

async function runRouletteSpin({ nickname = '테스트', amount, source = 'manual' } = {}) {
  const cfg = readRouletteConfig();
  const paid = Number(amount) || cfg.triggerAmount;
  const spinCount = Math.floor(paid / cfg.triggerAmount);

  // exactAmountOnly: must be exact multiple; otherwise any amount >= trigger is 1 spin
  const allowed = cfg.exactAmountOnly
    ? paid % cfg.triggerAmount === 0 && spinCount >= 1
    : paid >= cfg.triggerAmount;
  if (!allowed || spinCount < 1) {
    const err = new Error(`trigger_amount_mismatch:${paid}`);
    err.statusCode = 400;
    throw err;
  }

  if (!(cfg.items || []).some(it => it.enabled !== false && it.label)) {
    const err = new Error('roulette_items_empty');
    err.statusCode = 400;
    throw err;
  }

  // Pick all winners upfront and save all to history at once
  const entries = [];
  let currentCfg = cfg;
  for (let i = 0; i < spinCount; i++) {
    const item = pickRouletteItem(currentCfg.items);
    if (!item) break;
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      nickname: String(nickname || '테스트').slice(0, 80),
      amount: paid,
      result: item.label,
      storageReward: currentCfg.saveToStorage ? item.storageReward : '',
      source,
      createdAt: new Date().toISOString(),
      ...(spinCount > 1 ? { spinIndex: i + 1, spinTotal: spinCount } : {}),
    };
    const nextHistory = [...(currentCfg.history || []), entry].slice(-80);
    currentCfg = writeRouletteConfig({ history: nextHistory });
    entries.push(entry);
  }

  // Broadcast spin 1 immediately; schedule subsequent spins every 2s
  const SPIN_GAP_MS = 2000; // 스핀 1회 = 2초
  broadcast({ type: 'roulette_admin_result', result: entries[0], config: currentCfg });
  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i];
    setTimeout(() => broadcast({ type: 'roulette_admin_result', result: entry, config: currentCfg }), i * SPIN_GAP_MS);
  }
  // 보관함 지급도 각 회차의 결과가 화면에 뜨는 시점(스핀 시작 + 스핀 1회 길이)에 맞춰 실행
  entries.forEach((entry, i) => {
    if (!entry.storageReward) return;
    setTimeout(() => grantStorageReward({ nickname: entry.nickname, rewardName: entry.storageReward }), (i + 1) * SPIN_GAP_MS);
  });

  return { entry: entries[0], entries, config: currentCfg };
}

app.get('/api/livegame', (req, res) => {
  let done = false;
  const fail = (msg) => { if (done) return; done = true; res.status(503).json({ error: msg }); };
  const req2 = http.get('http://127.0.0.1:2999/liveclientdata/allgamedata', { timeout: 2000 }, res2 => {
    if (done) { res2.resume(); return; }
    done = true;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.status(res2.statusCode);
    res2.pipe(res);
  });
  req2.on('error', () => fail('lcu_not_running'));
  req2.on('timeout', () => { req2.destroy(); fail('lcu_timeout'); });
});

app.get('/api/inhouse-db', (req, res) => {
  res.json(readInhouseDB());
});

// 뷰어 배팅 제어 프록시 (inhouse → viewer-server)
app.post('/api/viewer-bet', async (req, res) => {
  if (!VIEWER_SERVER_URL) return res.json({ ok: false, error: 'VIEWER_SERVER_URL 미설정' });
  try {
    const result = await postJson(`${VIEWER_SERVER_URL}/api/admin/bet`, req.body, { 'x-admin-secret': VIEWER_SERVER_SECRET });
    res.json(result);
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// 시청자 포인트 조회 (뷰어 플랫폼 실시간 연동용)
app.get('/api/viewer-points', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const nickname = String(req.query.nickname || '').trim();
  if (!nickname) return res.json({ ok: false, error: 'nickname 필요' });
  const viewer = findViewerByChzzkNickname(nickname);
  if (!viewer) return res.json({ ok: false, points: 0 });
  const points = Math.max(0, Number(viewer.pass) || 0);
  res.json({ ok: true, points, name: viewer.name || nickname });
});

// 뷰어 서버 미니게임 포인트 차감/지급 헬퍼
// ── 포인트 로그 ──────────────────────────────────────────
const POINT_LOG_CHANNEL = process.env.POINT_LOG_CHANNEL_ID || '1519309432394219583';

function addPointLog(nickname, delta, reason, before, after) {
  try {
    if (!fs.existsSync(POINT_LOG_FILE)) fs.writeFileSync(POINT_LOG_FILE, JSON.stringify({ logs: [] }), 'utf8');
    const data = JSON.parse(fs.readFileSync(POINT_LOG_FILE, 'utf8'));
    if (!Array.isArray(data.logs)) data.logs = [];
    data.logs.unshift({ nickname, delta, reason: reason || '', before, after, at: Date.now() });
    data.logs = data.logs.slice(0, 2000);
    fs.writeFileSync(POINT_LOG_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch(e) { console.error('[POINT_LOG]', e.message); }

  // 디스코드 포인트 로그 채널 전송
  if (DISCORD_BOT_API_URL && DISCORD_BOT_API_SECRET) {
    const sign = delta >= 0 ? '+' : '';
    const arrow = delta >= 0 ? '▲' : '▼';
    // reason에서 게임명 추출 (이모지 + 앞부분)
    const reasonText = reason
      ? reason.replace(/\s*\([^)]*\)\s*$/, '').trim()  // 괄호 제거
      : (delta >= 0 ? '지급' : '차감');
    const content = [
      `**${arrow} ${nickname}**`,
      `\`${sign}${delta}P\` → \`${after}P\``,
      reasonText ? `— ${reasonText}` : ''
    ].filter(Boolean).join('  ');
    postJson(`${DISCORD_BOT_API_URL}/api/send-channel-message`, {
      secret: DISCORD_BOT_API_SECRET,
      channelId: POINT_LOG_CHANNEL,
      content
    }).catch(e => console.warn('[POINT_LOG_DISCORD]', e.message));
  }
}

function viewerPointsDelta(nickname, delta, reason, retries = 5) {
  if (!nickname) return null;
  const key = normalizeChatName(nickname);
  if (!key) return null;
  const stripTag = n => normalizeChatName(String(n || '').replace(/#.+$/, ''));
  // findViewerByChzzkNickname과 완전히 동일한 매칭 로직
  const findInDB = (viewers) => viewers.find(v =>
    normalizeChatName(v.chzzk) === key ||
    normalizeChatName(v.name) === key ||
    stripTag(v.name) === key ||
    (key.length >= 2 && normalizeChatName(v.chzzk || '').includes(key)) ||
    (key.length >= 2 && normalizeChatName(v.name || '').includes(key))
  ) || null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const db = readInhouseDB();
      const v = findInDB(db.viewers);
      if (!v) return null;
      const before = Math.max(0, Number(v.pass) || 0);
      v.pass = Math.max(0, before + delta);
      if (!Array.isArray(v.pointHistory)) v.pointHistory = [];
      v.pointHistory.unshift({ id: Date.now(), amount: delta, reason: reason || (delta >= 0 ? '지급' : '차감'), at: Date.now() });
      v.pointHistory = v.pointHistory.slice(0, 200);
      writeInhouseDB(db);
      addPointLog(nickname, delta, reason, before, v.pass);
      // 인하우스 사이트 브라우저에 DB 변경 알림 (캐시 동기화)
      broadcast({ type: 'viewer_pass_changed', nickname, pass: v.pass });
      return v.pass;
    } catch(e) {
      if (e.message === 'stale_db_snapshot' && attempt < retries - 1) continue;
      throw e;
    }
  }
  return null;
}

// 뷰어 서버 미니게임 포인트 차감 (secret 검증)
app.post('/api/viewer-deduct', (req, res) => {
  try {
    if (req.headers['x-viewer-secret'] !== (VIEWER_SERVER_SECRET || 'davido-admin')) return res.status(403).json({ ok: false, error: '권한 없음' });
    const nickname = String(req.body.nickname || '').trim();
    const amount = Number(req.body.amount) || 0;
    const reason = String(req.body.reason || '차감').slice(0, 80);
    const viewer = findViewerByChzzkNickname(nickname);
    if (!viewer) return res.json({ ok: false, error: '시청자 없음' });
    const current = Math.max(0, Number(viewer.pass) || 0);
    if (current < amount) return res.json({ ok: false, error: `포인트 부족 (보유: ${current}P)` });
    const after = viewerPointsDelta(nickname, -amount, reason);
    res.json({ ok: true, points: after });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// 뷰어 서버 미니게임 포인트 지급 (secret 검증)
app.post('/api/viewer-grant', (req, res) => {
  try {
    if (req.headers['x-viewer-secret'] !== (VIEWER_SERVER_SECRET || 'davido-admin')) return res.status(403).json({ ok: false, error: '권한 없음' });
    const nickname = String(req.body.nickname || '').trim();
    const amount = Number(req.body.amount) || 0;
    const reason = String(req.body.reason || '지급').slice(0, 80);
    if (!findViewerByChzzkNickname(nickname)) return res.json({ ok: false, error: '시청자 없음' });
    const after = viewerPointsDelta(nickname, amount, reason);
    res.json({ ok: true, points: after });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// 포인트 로그 조회 API
app.get('/api/point-log', (req, res) => {
  try {
    if (req.headers['x-viewer-secret'] !== (VIEWER_SERVER_SECRET || 'davido-admin') &&
        req.headers['x-secret'] !== (process.env.BOT_API_SECRET || '')) {
      return res.status(403).json({ ok: false, error: '권한 없음' });
    }
    const nickname = req.query.nickname ? String(req.query.nickname).trim() : null;
    const limit = Math.min(200, parseInt(req.query.limit) || 50);
    if (!fs.existsSync(POINT_LOG_FILE)) return res.json({ ok: true, logs: [] });
    const data = JSON.parse(fs.readFileSync(POINT_LOG_FILE, 'utf8'));
    let logs = data.logs || [];
    if (nickname) {
      const key = normalizeChatName(nickname);
      logs = logs.filter(l => normalizeChatName(l.nickname) === key);
    }
    res.json({ ok: true, logs: logs.slice(0, limit) });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// 뷰어 상점 구매 처리: 포인트 차감 + 보관함봇 추가
app.post('/api/viewer-shop-buy', async (req, res) => {
  try {
    if (req.headers['x-viewer-secret'] !== (VIEWER_SERVER_SECRET || 'davido-admin'))
      return res.status(403).json({ ok: false, error: '권한 없음' });
    const { nickname, itemName, price } = req.body;
    if (!nickname || !itemName || !price) return res.json({ ok: false, error: '파라미터 누락' });
    // 1. 포인트 확인 및 차감
    const viewer = findViewerByChzzkNickname(nickname);
    if (!viewer) return res.json({ ok: false, error: '시청자 없음 (내전 등록 필요)' });
    const current = Math.max(0, Number(viewer.pass) || 0);
    if (current < price) return res.json({ ok: false, error: `포인트 부족 (보유: ${current}P, 필요: ${price}P)` });
    const after = viewerPointsDelta(nickname, -price, `🛒 상점 구매: ${itemName} (-${price}P)`);
    // 2. 보관함봇에 아이템 추가
    if (DISCORD_BOT_API_URL && DISCORD_BOT_API_SECRET) {
      try {
        const result = await postJson(`${DISCORD_BOT_API_URL}/api/bot-command`, {
          secret: DISCORD_BOT_API_SECRET,
          command: '추가',
          options: { 닉네임: nickname, 보상이름: itemName, 개수: 1 }
        });
        if (!result.ok) {
          viewerPointsDelta(nickname, price); // 환불
          return res.json({ ok: false, error: `보관함 추가 실패: ${result.error || '봇 오류'}` });
        }
      } catch(e) {
        viewerPointsDelta(nickname, price); // 환불
        return res.json({ ok: false, error: `보관함봇 연결 실패: ${e.message}` });
      }
    }
    res.json({ ok: true, points: after });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// ── 전당포 아이템 가격표 (상점가 - 50P) ──
const PAWN_PRICES = {
  '선참권': 70,          // 120 - 50
  '노밴권': 190,         // 240 - 50
  '종일권': 410,         // 460 - 50
  '내전 1판 연장권': 550, // 600 - 50
};
const PAWN_DAILY_LIMIT = 10;
const PAWN_LOG_FILE = path.join(DATA_DIR, 'pawn-log.json');
if (!fs.existsSync(PAWN_LOG_FILE)) fs.writeFileSync(PAWN_LOG_FILE, '{}', 'utf8');

function getPawnLog() {
  try { return JSON.parse(fs.readFileSync(PAWN_LOG_FILE, 'utf8')); } catch { return {}; }
}
function savePawnLog(log) { fs.writeFileSync(PAWN_LOG_FILE, JSON.stringify(log, null, 2), 'utf8'); }

// 보관함 조회
app.get('/api/viewer-inventory', async (req, res) => {
  try {
    if (req.headers['x-viewer-secret'] !== (VIEWER_SERVER_SECRET || 'davido-admin'))
      return res.status(403).json({ ok: false, error: '권한 없음' });
    const { nickname } = req.query;
    if (!nickname) return res.json({ ok: false, error: '닉네임 필요' });
    if (!DISCORD_BOT_API_URL || !DISCORD_BOT_API_SECRET)
      return res.json({ ok: false, error: '보관함봇 미설정' });
    const result = await postJson(`${DISCORD_BOT_API_URL}/api/bot-command`, {
      secret: DISCORD_BOT_API_SECRET,
      command: '보관함조회',
      options: { 닉네임: nickname }
    });
    res.json(result);
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// 전당포 판매
app.post('/api/viewer-pawn-sell', async (req, res) => {
  try {
    if (req.headers['x-viewer-secret'] !== (VIEWER_SERVER_SECRET || 'davido-admin'))
      return res.status(403).json({ ok: false, error: '권한 없음' });
    const { nickname, itemName } = req.body;
    if (!nickname || !itemName) return res.json({ ok: false, error: '파라미터 누락' });

    const price = PAWN_PRICES[itemName];
    if (!price) return res.json({ ok: false, error: `판매 불가 아이템: ${itemName}` });

    // 일일 거래 횟수 확인
    const today = new Date(Date.now() + 9*3600000).toISOString().slice(0,10);
    const log = getPawnLog();
    const key = `${nickname}:${today}`;
    const usedToday = log[key] || 0;
    if (usedToday >= PAWN_DAILY_LIMIT)
      return res.json({ ok: false, error: `오늘 전당포 거래 한도 초과 (${PAWN_DAILY_LIMIT}회/일)` });

    // 보관함에서 아이템 차감
    if (!DISCORD_BOT_API_URL || !DISCORD_BOT_API_SECRET)
      return res.json({ ok: false, error: '보관함봇 미설정' });
    const deduct = await postJson(`${DISCORD_BOT_API_URL}/api/bot-command`, {
      secret: DISCORD_BOT_API_SECRET,
      command: '차감',
      options: { 닉네임: nickname, 보상이름: itemName, 개수: 1 }
    });
    if (!deduct.ok) return res.json({ ok: false, error: `차감 실패: ${deduct.error}` });

    // 포인트 지급
    const after = viewerPointsDelta(nickname, price, `🏪 전당포: ${itemName} 판매 (+${price}P)`);

    // 거래 횟수 기록
    log[key] = usedToday + 1;
    savePawnLog(log);

    res.json({ ok: true, points: after, usedToday: usedToday + 1, limit: PAWN_DAILY_LIMIT });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// 타이밍 복권 당첨자 저장소 (뷰어 서버 배포 후에도 유지)
const TIMING_WINNER_FILE = path.join(DATA_DIR, 'timing-winner.json');
app.route('/api/viewer-timing-winner')
  .get((req, res) => {
    try { res.json(JSON.parse(fs.readFileSync(TIMING_WINNER_FILE, 'utf8'))); }
    catch { res.json({}); }
  })
  .post((req, res) => {
    if (req.headers['x-viewer-secret'] !== (VIEWER_SERVER_SECRET || 'davido-admin'))
      return res.status(403).json({ ok: false });
    try {
      fs.writeFileSync(TIMING_WINNER_FILE, JSON.stringify(req.body || {}));
      res.json({ ok: true });
    } catch(e) { res.json({ ok: false, error: e.message }); }
  });

// 채팅 투표 현황 (경매사이트 등 외부 연동용)
app.get('/api/vote-state', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ ok: true, vote: state.vote });
});

app.post('/api/inhouse-db', (req, res) => {
  try {
    res.json({ ok: true, data: writeInhouseDB(req.body || {}, { mergeViewers: false }) });
  } catch (err) {
    console.error('[INHOUSE_DB] write failed:', err.message);
    res.status(err.statusCode || 500).json({
      ok: false,
      error: err.message || 'write_failed',
      currentUpdatedAt: err.currentUpdatedAt,
      currentViewers: err.currentViewers,
      incomingViewers: err.incomingViewers,
    });
  }
});

function validateDiscordBotSecret(req, res) {
  if (!DISCORD_BOT_API_SECRET) return true;
  const supplied = req.body?.secret || req.headers['x-discord-bot-secret'] || req.headers['x-inhouse-secret'];
  if (supplied === DISCORD_BOT_API_SECRET) return true;
  res.status(401).json({ ok: false, error: 'invalid_secret' });
  return false;
}

app.post('/api/start-inhouse', async (req, res) => {
  try {
    const db = readInhouseDB();
    const cfg = readDiscordConfig();
    const lobbyChannelId = String(cfg.voiceLobbyChannelId || '').replace(/\D/g, '');
    const blueChannelId  = String(cfg.voiceBlueChannelId  || '').replace(/\D/g, '');
    const redChannelId   = String(cfg.voiceRedChannelId   || '').replace(/\D/g, '');
    if (!lobbyChannelId || !blueChannelId || !redChannelId)
      return res.json({ ok: false, error: '음성채널 ID 미설정 (내전사이트 설정 탭에서 저장하세요)' });
    if (!DISCORD_BOT_API_URL || !DISCORD_BOT_API_SECRET)
      return res.json({ ok: false, error: 'DISCORD_BOT_API_URL / DISCORD_BOT_API_SECRET 환경변수 필요' });
    const getIds = arr => (Array.isArray(arr) ? arr : [])
      .map(p => {
        const viewer = (db.viewers || []).find(v => Number(v.id) === Number(p.id || p.viewerId));
        return String(viewer?.discordId || p.discordId || '').replace(/\D/g, '');
      }).filter(Boolean);
    const blueDiscordIds = getIds(db.curBlue);
    const redDiscordIds  = getIds(db.curRed);
    if (!blueDiscordIds.length && !redDiscordIds.length)
      return res.json({ ok: false, error: '디스코드 연동된 팀원이 없습니다' });
    const result = await postJson(`${DISCORD_BOT_API_URL}/api/move-voice-teams`, {
      secret: DISCORD_BOT_API_SECRET,
      lobbyChannelId, blueChannelId, redChannelId,
      blueDiscordIds, redDiscordIds,
    });
    console.log('[START_INHOUSE] moved:', result);
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err.message || '실패' });
  }
});

// 경매사이트 결과화면 - 1~4팀 디스코드 음성 이동 + 역할 부여
app.post('/api/auction-move-voice-teams', async (req, res) => {
  if (!DISCORD_BOT_API_URL || !DISCORD_BOT_API_SECRET) {
    return res.json({ ok: false, error: 'DISCORD_BOT_API_URL / DISCORD_BOT_API_SECRET 환경변수가 필요합니다.' });
  }
  const cleanIds = arr => Array.isArray(arr) ? arr.map(id => String(id || '').replace(/\D/g, '')).filter(Boolean) : [];
  const teamsIn = Array.isArray(req.body?.teams) ? req.body.teams : [];
  const teams = teamsIn.slice(0, AUCTION_TEAM_VOICE_IDS.length).map((t, i) => ({
    name: String(t?.name || `${i + 1}팀`),
    channelId: AUCTION_TEAM_VOICE_IDS[i],
    roleId: AUCTION_TEAM_ROLE_IDS[i],
    discordIds: cleanIds(t?.discordIds),
  })).filter(t => t.discordIds.length);
  if (!teams.length) return res.json({ ok: false, error: '디스코드 연동된 팀원이 없습니다.' });
  try {
    const result = await postJson(`${DISCORD_BOT_API_URL}/api/move-voice-teams-multi`, {
      secret: DISCORD_BOT_API_SECRET,
      lobbyChannelId: AUCTION_VOICE_LOBBY_ID,
      teams,
    });
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: `${err.message || '보관함봇 호출 실패'}` });
  }
});

function handleDiscordInhouseRegister(req, res) {
  if (!validateDiscordBotSecret(req, res)) return;
  try {
    const result = upsertViewerFromDiscordRegistration(req.body || {});
    broadcastState();
    res.json({
      ok: true,
      viewer: result.viewer,
      viewers: result.db.viewers.length,
      vid: result.db.vid,
    });
  } catch (err) {
    res.status(err.statusCode || 400).json({ ok: false, error: err.message || 'register_failed' });
  }
}

app.post('/api/inhouse-register', handleDiscordInhouseRegister);
app.post('/api/discord-inhouse-register', handleDiscordInhouseRegister);
app.post('/api/register-viewer', handleDiscordInhouseRegister);
app.post('/api/discord-link', handleDiscordInhouseRegister);
app.post('/api/inhouse-link', handleDiscordInhouseRegister);
app.post('/api/link-discord', handleDiscordInhouseRegister);

app.post('/api/inhouse-register-mosts', (req, res) => {
  if (!validateDiscordBotSecret(req, res)) return;
  try {
    const result = upsertViewerMostsFromDiscord(req.body || {});
    broadcastState();
    res.json({
      ok: true,
      viewer: result.viewer,
      mosts: result.mosts,
    });
  } catch (err) {
    res.status(err.statusCode || 400).json({ ok: false, error: err.message || 'register_failed' });
  }
});

app.get('/api/discord-config', (req, res) => {
  res.json(readDiscordConfig());
});

app.get('/api/roulette-config', (req, res) => {
  res.json(readRouletteConfig());
});

app.post('/api/roulette-config', (req, res) => {
  if (!isSiteAuthenticated(req)) return res.status(401).json({ ok: false, error: '인증 필요' });
  try {
    res.json({ ok: true, data: writeRouletteConfig(req.body || {}) });
  } catch (err) {
    console.error('[ROULETTE_CONFIG] write failed:', err.message);
    res.status(500).json({ ok: false, error: 'write_failed' });
  }
});

app.post('/api/roulette-test', async (req, res) => {
  try {
    const result = await runRouletteSpin({
      nickname: req.body?.nickname || '테스트시청자',
      amount: req.body?.amount,
      source: 'manual_test',
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message || 'roulette_test_failed' });
  }
});

app.get('/api/weflab-sync', (req, res) => {
  res.json(weflabSyncStatusPayload());
});

app.post('/api/weflab-sync', (req, res) => {
  const body = req.body || {};
  if (typeof body.cookie === 'string') {
    weflabSync.cookie = body.cookie.trim();
    weflabSync.lastError = null;
    // lastIdx는 유지 — 쿠키가 만료돼서 갱신하는 경우, 끊겨있던 동안의 결과도 이어서 처리하기 위함
  }
  if (typeof body.enabled === 'boolean') {
    weflabSync.enabled = body.enabled;
  }
  saveWeflabSync();
  res.json({ ok: true, data: weflabSyncStatusPayload() });
});

// 1회성 검증용: 닉네임+시간으로 특정 결과 1건만 찾아서 강제로 처리(보관함 지급까지) — lastIdx는 건드리지 않음
app.post('/api/weflab-sync-test-entry', async (req, res) => {
  try {
    if (!weflabSync.cookie) return res.status(400).json({ ok: false, error: '먼저 위플랩 세션 쿠키를 저장해주세요' });
    const cookies = parseCookieString(weflabSync.cookie);
    const loginIdx = cookies['login_idx'] || '';
    if (!loginIdx) return res.status(400).json({ ok: false, error: '쿠키에서 login_idx를 찾을 수 없습니다' });

    const nickname = String(req.body?.nickname || '').trim();
    const timeHint = String(req.body?.createTime || '').trim();
    if (!nickname) return res.status(400).json({ ok: false, error: '닉네임을 입력해주세요' });

    const now = new Date();
    const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const end = new Date(now.getTime() + 60 * 60 * 1000);
    const resp = await postForm(WEFLAB_API_URL, {
      type: 'alertlist_load', pagetype: 'setup', idx: loginIdx, pageid: 'alertlist', preset: '0',
      'ver[server]': '20240607', 'ver[socket]': '20240607', lastdate: '',
      'filter[start]': formatWeflabDate(start), 'filter[end]': formatWeflabDate(end),
      'filter[min]': '0', 'filter[type]': 'all', 'filter[search]': '',
    }, { Cookie: weflabSync.cookie });

    if (resp?.result !== 'success' || !Array.isArray(resp?.data)) {
      return res.status(502).json({ ok: false, error: `위플랩 응답 오류 (쿠키 만료 가능): ${resp?.result || 'unknown'}` });
    }

    const candidates = resp.data.filter(e => String(e?.name || '').trim() === nickname);
    if (!candidates.length) {
      return res.status(404).json({ ok: false, error: `최근 7일 내역에서 "${nickname}" 결과를 찾지 못했습니다` });
    }
    const onlyDigits = s => String(s || '').replace(/\D/g, '');
    const hintDigits = onlyDigits(timeHint);
    const target = hintDigits
      ? (candidates.find(e => onlyDigits(e?.create_time).includes(hintDigits)) || candidates[0])
      : candidates[0];

    await processWeflabAlertEntry(target);
    res.json({
      ok: true,
      entry: { name: target.name, create_time: target.create_time, idx: target.idx, results: parseWeflabResultNames(target) },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || '테스트 실행 실패' });
  }
});

// 내장(하드코딩) 명령어 — 실제 봇 응답 텍스트 표시
// 동적 응답 명령어(!포인트, !승률, !참가, !투표N)는 응답 수정 불가 → 목록에서 제외
const BUILTIN_CMDS = [
  { cmd: '!디코', text: '다비도 디스코드 👉 https://discord.gg/2fxXMQH7', builtin: true },
];

// 커스텀 명령어 CRUD
app.get('/api/custom-commands', (req, res) => {
  const custom = readCustomCmds();
  // 내장 명령어 중 커스텀으로 덮어쓴 것은 제외
  const customKeys = new Set(custom.map(c => c.cmd));
  const builtins = BUILTIN_CMDS.filter(b => !customKeys.has(b.cmd));
  res.json([...builtins, ...custom]);
});
app.post('/api/custom-commands', (req, res) => {
  const { cmd, text } = req.body || {};
  const command = String(cmd || '').trim();
  const response = String(text || '').trim();
  if (!command || !response) return res.status(400).json({ ok: false, error: '명령어와 응답 내용이 필요합니다.' });
  const normalized = command.startsWith('!') ? command.toLowerCase() : ('!' + command).toLowerCase();
  const list = readCustomCmds().filter(c => c.cmd !== normalized);
  list.push({ cmd: normalized, text: response });
  writeCustomCmds(list);
  broadcast({ type: 'custom_cmds_update', commands: list });
  res.json({ ok: true, commands: list });
});
app.delete('/api/custom-commands/:cmd', (req, res) => {
  const target = decodeURIComponent(req.params.cmd).toLowerCase();
  const list = readCustomCmds().filter(c => c.cmd !== target);
  writeCustomCmds(list);
  broadcast({ type: 'custom_cmds_update', commands: list });
  res.json({ ok: true, commands: list });
});

app.get('/api/version', (req, res) => {
  const commit = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || 'local';
  res.json({
    ok: true,
    commit,
    shortCommit: commit === 'local' ? 'local' : commit.slice(0, 8),
    marker: 'index-redirect-chzzk-timeout-2026-05-17',
    storage: {
      railway: IS_RAILWAY,
      dataDir: DATA_DIR,
      dbFileExists: fs.existsSync(INHOUSE_DB_FILE),
    },
    servedAt: new Date().toISOString(),
  });
});

app.get('/api/storage-status', (req, res) => {
  const db = readInhouseDB();
  const backupCount = (() => {
    try {
      if (!fs.existsSync(INHOUSE_BACKUP_DIR)) return 0;
      return fs.readdirSync(INHOUSE_BACKUP_DIR)
        .filter(name => /^inhouse-db-\d+\.json$/.test(name))
        .length;
    } catch (err) {
      return 0;
    }
  })();

  res.json({
    ok: true,
    railway: IS_RAILWAY,
    dataDir: DATA_DIR,
    dbFile: INHOUSE_DB_FILE,
    dbFileExists: fs.existsSync(INHOUSE_DB_FILE),
    backupCount,
    viewers: Array.isArray(db.viewers) ? db.viewers.length : 0,
    blue: Array.isArray(db.curBlue) ? db.curBlue.length : 0,
    red: Array.isArray(db.curRed) ? db.curRed.length : 0,
    vid: db.vid,
    updatedAt: db.updatedAt,
    servedAt: new Date().toISOString(),
  });
});

// 수동 백업 저장 (최대 5개, 초과 시 오래된 것 삭제)
app.post('/api/save-backup', (req, res) => {
  try {
    const inhouseDb = readInhouseDB();
    const discordConfig = readDiscordConfig();
    const rouletteConfig = readRouletteConfig();
    if (!fs.existsSync(MANUAL_BACKUP_DIR)) fs.mkdirSync(MANUAL_BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `backup-${stamp}.json`;
    const data = { savedAt: new Date().toISOString(), version: 2, inhouseDb, discordConfig, rouletteConfig };
    fs.writeFileSync(path.join(MANUAL_BACKUP_DIR, filename), JSON.stringify(data), 'utf8');
    // 5개 초과 시 오래된 파일 삭제
    const all = fs.readdirSync(MANUAL_BACKUP_DIR)
      .filter(n => n.startsWith('backup-') && n.endsWith('.json')).sort();
    all.slice(0, Math.max(0, all.length - MAX_MANUAL_BACKUPS))
      .forEach(n => fs.unlinkSync(path.join(MANUAL_BACKUP_DIR, n)));
    const remaining = Math.min(all.length, MAX_MANUAL_BACKUPS);
    console.log(`[SAVE_BACKUP] saved: ${filename}, total: ${remaining}`);
    res.json({ ok: true, filename, savedAt: data.savedAt, total: remaining });
  } catch (err) {
    console.error('[SAVE_BACKUP] failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 봇 config 조회 프록시
app.get('/api/bot-config', async (req, res) => {
  if (!DISCORD_BOT_API_URL) return res.json({ ok: false, error: 'BOT API URL 없음' });
  try {
    const data = await getJson(`${DISCORD_BOT_API_URL}/api/config`);
    res.json(data);
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// 채널 메시지 전송 프록시
app.post('/api/send-channel-message', async (req, res) => {
  const { channelId, content, includeRegisterButton } = req.body || {};
  if (!DISCORD_BOT_API_URL || !DISCORD_BOT_API_SECRET) {
    return res.json({ ok: false, error: 'BOT API 환경변수가 필요합니다.' });
  }
  try {
    const result = await postJson(`${DISCORD_BOT_API_URL}/api/send-channel-message`, {
      secret: DISCORD_BOT_API_SECRET, channelId, content, includeRegisterButton: !!includeRegisterButton,
    });
    res.json(result);
  } catch (err) { res.json({ ok: false, error: err.message || '봇 연결 실패' }); }
});

// 봇 명령어 프록시 (인하우스 사이트 → 보관함봇)
app.post('/api/proxy-bot-command', async (req, res) => {
  const { command, options } = req.body || {};
  if (!DISCORD_BOT_API_URL || !DISCORD_BOT_API_SECRET) {
    return res.json({ ok: false, error: 'DISCORD_BOT_API_URL / DISCORD_BOT_API_SECRET 환경변수가 필요합니다.' });
  }
  try {
    const result = await postJson(`${DISCORD_BOT_API_URL}/api/bot-command`, {
      secret: DISCORD_BOT_API_SECRET,
      command: command || '',
      options: options || {},
    });
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err.message || '봇 연결 실패' });
  }
});

// 백업 목록 조회
app.post('/api/vote-reward-deduct', async (req, res) => {
  const vote = req.body?.vote || {};
  if (!DISCORD_BOT_API_URL || !DISCORD_BOT_API_SECRET) {
    return res.json({ ok: false, error: 'DISCORD_BOT_API_URL / DISCORD_BOT_API_SECRET 환경변수가 필요합니다.' });
  }
  try {
    const botConfigResult = await getJson(`${DISCORD_BOT_API_URL}/api/config`);
    if (!botConfigResult?.ok) {
      return res.json({ ok: false, error: botConfigResult?.error || '보관함봇 config 조회 실패' });
    }

    const config = botConfigResult.config || {};
    const botUsers = Array.isArray(config.users) ? config.users : [];
    const rewards = Array.isArray(config.rewards) ? config.rewards : [];
    const sponsorRewards = Array.isArray(config.sponsor_rewards) ? config.sponsor_rewards : [];
    const allRewards = [...new Set([...rewards, ...sponsorRewards])];
    const viewers = readInhouseDB().viewers || [];
    const items = Array.isArray(vote.items) ? vote.items : [];
    const targets = items.filter(item => allRewards.includes(item?.label) && Array.isArray(item.votes) && item.votes.length > 0);
    const results = [];

    for (const item of targets) {
      for (const voterNick of item.votes) {
        const viewer = findRewardViewer(viewers, voterNick);
        const botUser = findRewardBotUser(botUsers, voterNick, viewer);
        if (!botUser) {
          results.push({ reward: item.label, nick: voterNick, ok: false, msg: '봇 config에서 유저를 찾지 못함' });
          continue;
        }

        const counts = botUser.counts || {};
        if (!counts[item.label] || counts[item.label] <= 0) {
          results.push({ reward: item.label, nick: voterNick, ok: false, msg: `${botUser.name} ${item.label} 보유 없음` });
          continue;
        }

        const result = await postJson(`${DISCORD_BOT_API_URL}/api/bot-command`, {
          secret: DISCORD_BOT_API_SECRET,
          command: '차감',
          options: { 닉네임: botUser.name, 보상이름: item.label, 개수: 1 },
        });
        results.push({
          reward: item.label,
          nick: voterNick,
          ok: result.ok === true,
          msg: result.ok ? `${botUser.name} ${item.label} -1` : (result.error || result.message || '차감 실패'),
          botName: botUser.name,
          viewerName: viewer?.name || '',
          chzzk: viewer?.chzzk || '',
        });
      }
    }

    res.json({ ok: true, results });
  } catch (err) {
    res.json({ ok: false, error: err.message || '보상 자동 차감 실패' });
  }
});

app.get('/api/backups', (req, res) => {
  try {
    if (!fs.existsSync(MANUAL_BACKUP_DIR)) return res.json({ ok: true, backups: [] });
    const backups = fs.readdirSync(MANUAL_BACKUP_DIR)
      .filter(n => n.startsWith('backup-') && n.endsWith('.json'))
      .sort().reverse()
      .map(name => {
        const stat = fs.statSync(path.join(MANUAL_BACKUP_DIR, name));
        return { filename: name, size: stat.size, savedAt: stat.mtime };
      });
    res.json({ ok: true, backups });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 백업 파일 다운로드
app.get('/api/backups/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    if (!/^backup-[\w.-]+\.json$/.test(filename)) return res.status(400).json({ ok: false, error: '잘못된 파일명' });
    const filepath = path.join(MANUAL_BACKUP_DIR, filename);
    if (!fs.existsSync(filepath)) return res.status(404).json({ ok: false, error: '파일 없음' });
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.sendFile(path.resolve(filepath));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 백업에서 복원
app.post('/api/import-backup', (req, res) => {
  try {
    const { inhouseDb, discordConfig, rouletteConfig, version } = req.body || {};
    if (!inhouseDb || !Array.isArray(inhouseDb.viewers)) {
      return res.status(400).json({ ok: false, error: '유효하지 않은 백업 파일입니다. (viewers 배열 없음)' });
    }
    writeInhouseDB(inhouseDb);
    if (discordConfig && typeof discordConfig === 'object') writeDiscordConfig(discordConfig);
    if (rouletteConfig && typeof rouletteConfig === 'object') writeRouletteConfig(rouletteConfig);
    console.log(`[IMPORT_BACKUP] restored: viewers=${inhouseDb.viewers.length}, version=${version}`);
    res.json({ ok: true, restored: { viewers: inhouseDb.viewers.length } });
  } catch (err) {
    console.error('[IMPORT_BACKUP] failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/discord-config', (req, res) => {
  if (!isSiteAuthenticated(req)) return res.status(401).json({ ok: false, error: '인증 필요' });
  try {
    res.json({ ok: true, data: writeDiscordConfig(req.body || {}) });
  } catch (err) {
    console.error('[DISCORD_CONFIG] write failed:', err.message);
    res.status(500).json({ ok: false, error: 'write_failed' });
  }
});

// ── 상태 ──
const state = {
  channelId: null,
  chzzkConnected: false,
  vote: { active: false, title: '내전 투표', items: [], startedAt: null },
  roulette: { items: [] },
  music: { queue: [], currentIdx: 0, playing: false },
  inhouseTeams: { blue: [], red: [], updatedAt: null },
  lcuDraft: { connected: false, inChampSelect: false, error: null, session: null, updatedAt: null },
  bot: {
    enabled: true,
    sendToChat: false,
    hasAuth: false,
    status: 'idle',
    lastSendError: null,
    commandCount: 0,
    lastCommand: null,
    lastReply: null,
    macros: [
      { id: 'join', title: '내전 참가 안내', text: '!참가 를 치면 내전 참가 신청이 됩니다.' },
      { id: 'point', title: '포인트 안내', text: '!포인트 로 내전 포인트를 확인할 수 있습니다.' },
      { id: 'rule', title: '내전 안내', text: '내전 참가자는 방송 화면과 내전사이트 안내를 확인해주세요.' },
    ],
  },
  chatLog: [],
};

const savedBotState = loadBotRuntimeState();
if (savedBotState.channelId) state.channelId = normalizeChzzkChannelId(savedBotState.channelId);
if (savedBotState.bot && typeof savedBotState.bot === 'object') {
  state.bot.enabled = savedBotState.bot.enabled !== false;
  state.bot.sendToChat = savedBotState.bot.sendToChat === true;
}

let chzzkWs = null;
let chzzkPing = null;
let chzzkChatChannelId = null;
let chzzkExtraToken = null;
let chzzkSid = null;
let chzzkTid = 10;
let chzzkReconnectTimer = null;
let chzzkReconnectDelay = 5000;
let chzzkAuthed = false;
let chzzkLastMessageAt = 0;
const recentChatKeys = new Map();
const CHZZK_CMD = {
  PING: 0,
  CONNECT: 100,
  PONG: 10000,
  CONNECTED: 10100,
  REQUEST_RECENT_CHAT: 5101,
  RECENT_CHAT: 15101,
  CHAT: 93101,
  DONATION: 93102,
};
function loadBotAuth() {
  try {
    if (fs.existsSync(BOT_AUTH_FILE)) {
      const saved = JSON.parse(fs.readFileSync(BOT_AUTH_FILE, 'utf8'));
      return {
        nidAut: saved.nidAut || process.env.CHZZK_NID_AUT || '',
        nidSes: saved.nidSes || process.env.CHZZK_NID_SES || '',
      };
    }
  } catch (e) {}
  return { nidAut: process.env.CHZZK_NID_AUT || '', nidSes: process.env.CHZZK_NID_SES || '' };
}

function saveBotAuth(nidAut, nidSes) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BOT_AUTH_FILE, JSON.stringify({ nidAut, nidSes, savedAt: new Date().toISOString() }), 'utf8');
  } catch (e) {
    console.error('[BOT_AUTH] save failed:', e.message);
  }
}

const chzzkAuth = loadBotAuth();

function loadBotRuntimeState() {
  try {
    if (!fs.existsSync(BOT_STATE_FILE)) return {};
    const saved = readJsonFile(BOT_STATE_FILE);
    return saved && typeof saved === 'object' ? saved : {};
  } catch (e) {
    console.error('[BOT_STATE] load failed:', e.message);
    return {};
  }
}

function saveBotRuntimeState() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BOT_STATE_FILE, JSON.stringify({
      channelId: state.channelId || null,
      bot: {
        enabled: state.bot.enabled !== false,
        sendToChat: state.bot.sendToChat === true,
      },
      savedAt: new Date().toISOString(),
    }), 'utf8');
  } catch (e) {
    console.error('[BOT_STATE] save failed:', e.message);
  }
}

function normalizeChzzkChannelId(value) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    raw = parsed.pathname.split('/').filter(Boolean).pop() || '';
  } catch {}
  raw = raw.replace(/^@/, '').split(/[?#]/)[0].trim();
  return /^[A-Za-z0-9_-]{3,100}$/.test(raw) ? raw : '';
}

function hasChzzkAuth() {
  return !!(chzzkAuth.nidAut && chzzkAuth.nidSes);
}

function chzzkCookieHeader() {
  if (!hasChzzkAuth()) return '';
  return `NID_AUT=${chzzkAuth.nidAut}; NID_SES=${chzzkAuth.nidSes}`;
}

function chzzkHeaders(extra = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Origin': 'https://chzzk.naver.com',
    'Referer': 'https://chzzk.naver.com/',
    ...extra,
  };
  const cookie = chzzkCookieHeader();
  if (cookie) headers.Cookie = cookie;
  return headers;
}

async function fetchChzzkJson(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.message || json?.error || `HTTP ${res.status}`);
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('치지직 API 응답 시간이 초과됐습니다.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function postJson(url, payload, extraHeaders) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = Buffer.from(JSON.stringify(payload || {}), 'utf8');
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        ...(extraHeaders || {}),
      },
      timeout: 10000,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
        if (res.statusCode >= 400) {
          const err = new Error(data.error || `HTTP ${res.statusCode}`);
          err.data = data;
          reject(err);
          return;
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request_timeout')));
    req.write(body);
    req.end();
  });
}

// ── 브로드캐스트 ──
function getJson(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(target, { timeout: 10000 }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
        if (res.statusCode >= 400) {
          const err = new Error(data.error || `HTTP ${res.statusCode}`);
          err.data = data;
          reject(err);
          return;
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request_timeout')));
  });
}

function normalizeRewardNick(value, leet = false) {
  const key = String(value || '')
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[#＃].*$/g, '')
    .replace(/[^\p{L}\p{N}가-힣]/gu, '');
  return leet ? key.replace(/2/g, 'e') : key;
}

function rewardNickKeys(value) {
  const raw = String(value || '').trim();
  const taglessRaw = raw.split(/[#＃]/)[0];
  return [...new Set([
    normalizeRewardNick(raw),
    normalizeRewardNick(taglessRaw),
    normalizeRewardNick(raw, true),
    normalizeRewardNick(taglessRaw, true),
  ].filter(Boolean))];
}

function rewardEntityKeys(entity) {
  if (!entity) return [];
  return [...new Set([
    ...rewardNickKeys(entity.name),
    ...rewardNickKeys(entity.chzzk),
  ])];
}

function rewardKeysMatch(leftKeys, rightKeys) {
  for (const left of leftKeys) {
    for (const right of rightKeys) {
      if (!left || !right) continue;
      if (left === right) return true;
      if (left.length >= 2 && right.length >= 2 && (left.includes(right) || right.includes(left))) return true;
    }
  }
  return false;
}

function findRewardViewer(viewers, voterNick) {
  const voterKeys = rewardNickKeys(voterNick);
  return viewers.find(viewer => rewardKeysMatch(rewardEntityKeys(viewer), voterKeys)) || null;
}

function findRewardBotUser(botUsers, voterNick, viewer) {
  const searchKeys = [...new Set([
    ...rewardNickKeys(voterNick),
    ...rewardEntityKeys(viewer),
  ])];
  return botUsers.find(user => rewardKeysMatch(rewardEntityKeys(user), searchKeys)) || null;
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function broadcastState() {
  state.bot.hasAuth = hasChzzkAuth();
  broadcast({ type: 'state', data: publicState() });
}

function publicState() {
  state.bot.hasAuth = hasChzzkAuth();
  const wsOpen = chzzkWs?.readyState === 1;
  const recentlyReceivedChat = Date.now() - chzzkLastMessageAt < 60000;
  return { ...state, chzzkConnected: wsOpen && (chzzkAuthed || recentlyReceivedChat) };
}

function normalizeChatName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function displayViewerName(viewer, fallback) {
  return String(viewer?.name || fallback || '').replace(/#.+$/, '').trim();
}

function findViewerByChzzkNickname(nickname) {
  const key = normalizeChatName(nickname);
  if (!key) return null;
  const db = readInhouseDB();
  const stripTag = n => normalizeChatName(String(n || '').replace(/#.+$/, ''));
  return db.viewers.find(viewer =>
    normalizeChatName(viewer.chzzk) === key ||
    normalizeChatName(viewer.name) === key ||
    stripTag(viewer.name) === key
  ) || db.viewers.find(viewer => {
    const chzzk = normalizeChatName(viewer.chzzk);
    const name = normalizeChatName(viewer.name);
    const nameNoTag = stripTag(viewer.name);
    return (chzzk && (chzzk.includes(key) || key.includes(chzzk)))
      || (name && (name.includes(key) || key.includes(name)))
      || (nameNoTag && (nameNoTag.includes(key) || key.includes(nameNoTag)));
  }) || null;
}

function sendBotNotice(targetNickname, text) {
  const payload = {
    type: 'bot_reply',
    nickname: targetNickname,
    text,
    ts: Date.now(),
  };
  state.bot.commandCount += 1;
  state.bot.lastReply = payload;
  broadcast(payload);
  broadcast({ type: 'chat', nickname: '다비도 봇', text, ts: payload.ts, isSystem: true });
  if (state.bot.sendToChat) sendChzzkChat(text);
  broadcastState();
}

function sendChzzkChat(text) {
  const msg = String(text || '').trim();
  if (!msg) return false;
  if (!chzzkWs || chzzkWs.readyState !== 1 || !chzzkChatChannelId) {
    state.bot.lastSendError = '치지직 채팅에 연결되어 있지 않습니다.';
    broadcastState();
    return false;
  }

  try {
    const extras = JSON.stringify({
      chatType: 'STREAMING',
      osType: 'PC',
      extraToken: chzzkExtraToken || '',
      streamingChannelId: state.channelId || chzzkChatChannelId,
      emojis: {},
    });
    const packet = {
      ver: '3',
      cmd: 3101,
      svcid: 'game',
      cid: chzzkChatChannelId,
      bdy: { msg, msgTypeCode: 1, extras, msgTime: Date.now() },
      ...(chzzkSid ? { sid: chzzkSid } : {}),
      tid: ++chzzkTid,
    };
    chzzkWs.send(JSON.stringify(packet));
    state.bot.lastSendError = null;
    return true;
  } catch (err) {
    state.bot.lastSendError = err.message || '치지직 채팅 전송 실패';
    broadcastState();
    return false;
  }
}

function handlePointCommand(nickname) {
  const viewer = findViewerByChzzkNickname(nickname);
  if (!viewer) {
    sendBotNotice(nickname, `${nickname}님은 아직 시청자 DB에 등록되어 있지 않습니다.`);
    return true;
  }
  const points = Math.max(0, Number(viewer.pass) || 0);
  const name = displayViewerName(viewer, nickname);
  sendBotNotice(nickname, `${name}님의 내전 포인트는 ${points}P 입니다.`);
  return true;
}

function handleWinrateCommand(nickname) {
  const viewer = findViewerByChzzkNickname(nickname);
  if (!viewer) {
    sendBotNotice(nickname, `${nickname}님은 아직 시청자 DB에 등록되어 있지 않습니다.`);
    return true;
  }
  const st = viewer.stats || { w: 0, l: 0, d: 0 };
  const w = Math.max(0, Number(st.w) || 0);
  const l = Math.max(0, Number(st.l) || 0);
  const d = Math.max(0, Number(st.d) || 0);
  const total = w + l + d;
  const name = displayViewerName(viewer, nickname);
  if (total === 0) {
    sendBotNotice(nickname, `${name}님의 내전 기록이 없습니다.`);
    return true;
  }
  const wr = Math.round((w / total) * 100);
  const drawPart = d > 0 ? ` 무${d}` : '';
  sendBotNotice(nickname, `${name}님의 내전 승률: ${w}승 ${l}패${drawPart} (${wr}%) — 총 ${total}게임`);
  return true;
}

// ── WebSocket 클라이언트 ──
wss.on('connection', (ws, req) => {
  if (!isSiteAuthenticated(req)) {
    ws.close(4401, 'Unauthorized');
    return;
  }
  console.log('[WS] 브라우저 연결');
  ws.send(JSON.stringify({ type: 'state', data: publicState() }));
  ws.send(JSON.stringify({ type: 'lcu_champ_select', data: state.lcuDraft }));
});

// ── 롤 클라이언트 LCU 연동 ──
const LCU_LOCKFILE_CANDIDATES = [
  () => process.env.LCU_LOCKFILE,
  () => process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Riot Games', 'League of Legends', 'lockfile'),
  () => 'C:\\Riot Games\\League of Legends\\lockfile',
  () => 'C:\\Program Files\\Riot Games\\League of Legends\\lockfile',
  () => 'C:\\Program Files (x86)\\Riot Games\\League of Legends\\lockfile',
].filter(Boolean);

let lcuCreds = null;
let lcuLastSig = '';
let lcuPollTimer = null;

function findLcuLockfile() {
  for (const getPath of LCU_LOCKFILE_CANDIDATES) {
    const file = getPath();
    if (file && fs.existsSync(file)) return file;
  }
  return null;
}

function readLcuLockfile() {
  const file = findLcuLockfile();
  if (!file) return null;
  const [name, pid, port, password, protocol] = fs.readFileSync(file, 'utf8').trim().split(':');
  if (!port || !password) return null;
  return { file, name, pid, port, password, protocol: protocol || 'https' };
}

function lcuRequest(endpoint) {
  return new Promise((resolve, reject) => {
    if (!lcuCreds) return reject(new Error('lcu_not_connected'));
    const auth = Buffer.from(`riot:${lcuCreds.password}`).toString('base64');
    const req = https.request({
      hostname: '127.0.0.1',
      port: lcuCreds.port,
      path: endpoint,
      method: 'GET',
      rejectUnauthorized: false,
      headers: { Authorization: `Basic ${auth}` },
      timeout: 1200,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`lcu_${res.statusCode}`));
        try { resolve(body ? JSON.parse(body) : null); }
        catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('lcu_timeout')));
    req.on('error', reject);
    req.end();
  });
}

function simplifyChampSelect(session) {
  if (!session) return null;
  const myTeam = Array.isArray(session.myTeam) ? session.myTeam : [];
  const theirTeam = Array.isArray(session.theirTeam) ? session.theirTeam : [];
  const teamByCell = new Map();
  myTeam.forEach((p, idx) => teamByCell.set(p.cellId, { side: 'blue', idx, player: p }));
  theirTeam.forEach((p, idx) => teamByCell.set(p.cellId, { side: 'red', idx, player: p }));

  const actions = [];
  (Array.isArray(session.actions) ? session.actions : []).flat().forEach(action => {
    if (!action || !['ban', 'pick'].includes(action.type)) return;
    const meta = teamByCell.get(action.actorCellId) || { side: 'blue', idx: 0, player: {} };
    actions.push({
      id: action.id,
      type: action.type,
      side: meta.side,
      idx: meta.idx,
      championId: Number(action.championId || 0),
      completed: !!action.completed,
      inProgress: !!action.isInProgress,
      actorCellId: action.actorCellId,
    });
  });

   const tentativeByCell = new Map();
  actions.forEach(a => {
    if (a.type === 'pick' && a.inProgress && a.championId) {
      tentativeByCell.set(a.actorCellId, a.championId);
    }
  });

  const player = (p, idx) => {
    const lockedId = Number(p.championId || 0);
    const tentativeId = tentativeByCell.get(p.cellId) || 0;
    return {
      idx,
      cellId: p.cellId,
      championId: lockedId || tentativeId,
      isLocked: lockedId > 0,
      summonerId: p.summonerId,
      name: p.displayName || p.summonerName || p.gameName || `참가자 ${idx + 1}`,
      lane: p.assignedPosition || '',
    };
  };

  return {
    timer: session.timer || null,
    localPlayerCellId: session.localPlayerCellId,
    blue: myTeam.map(player),
    red: theirTeam.map(player),
    actions,
  };
}

async function pollLcuDraft() {
  if (state.lcuDraft?.source === 'relay' && Date.now() - Number(state.lcuDraft.updatedAt || 0) < 5000) {
    return;
  }
  try {
    const nextCreds = readLcuLockfile();
    if (!nextCreds) {
      lcuCreds = null;
      updateLcuDraft({ connected: false, inChampSelect: false, error: '롤 클라이언트를 찾지 못했습니다.', session: null });
      return;
    }
    lcuCreds = nextCreds;
    const session = await lcuRequest('/lol-champ-select/v1/session');
    updateLcuDraft({
      connected: true,
      inChampSelect: !!session,
      error: null,
      session: simplifyChampSelect(session),
    });
  } catch (err) {
    updateLcuDraft({
      connected: !!lcuCreds,
      inChampSelect: false,
      error: err.message,
      session: null,
    });
  }
}

function updateLcuDraft(next) {
  state.lcuDraft = { ...next, updatedAt: Date.now() };
  const sig = JSON.stringify(state.lcuDraft);
  if (sig === lcuLastSig) return;
  lcuLastSig = sig;
  broadcast({ type: 'lcu_champ_select', data: state.lcuDraft });
}

function startLcuPolling() {
  if (lcuPollTimer) return;
  pollLcuDraft();
  lcuPollTimer = setInterval(pollLcuDraft, 1200);
}

function scheduleChzzkReconnect(chatChannelId, originalChannelId) {
  if (!state.channelId || state.channelId !== originalChannelId) return;
  if (chzzkReconnectTimer) return;
  state.bot.status = 'reconnecting';
  broadcastState();
  const delay = chzzkReconnectDelay;
  chzzkReconnectDelay = Math.min(chzzkReconnectDelay * 2, 60000);
  console.log(`[CHZZK] reconnect in ${delay}ms`);
  chzzkReconnectTimer = setTimeout(async () => {
    chzzkReconnectTimer = null;
    let newToken = null;
    let newUid = null;
    try {
      const json = await fetchChzzkJson(
        `https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${chatChannelId}&chatType=STREAMING`,
        { headers: chzzkHeaders() }
      );
      newToken = json?.content?.accessToken || null;
      newUid = json?.content?.userIdHash || null;
      chzzkExtraToken = json?.content?.extraToken || null;
    } catch (err) {
      state.bot.lastSendError = err.message || '치지직 토큰 갱신 실패';
    }
    connectChatWs(chatChannelId, originalChannelId, newToken, newUid, chzzkExtraToken);
  }, delay);
}

// ── 치지직 연결 ──
async function connectChzzk(channelId) {
  channelId = normalizeChzzkChannelId(channelId);
  if (!channelId) {
    state.bot.status = 'idle';
    state.bot.lastSendError = '치지직 채널 ID 또는 채널 URL을 확인하세요.';
    broadcastState();
    throw new Error(state.bot.lastSendError);
  }
  clearTimeout(chzzkReconnectTimer);
  chzzkReconnectTimer = null;
  chzzkAuthed = false;
  state.bot.status = 'connecting';
  broadcastState();
  // 기존 연결 완전히 종료
  if (chzzkPing) { clearInterval(chzzkPing); chzzkPing = null; }
  if (chzzkWs) {
    chzzkWs.removeAllListeners();
    try { chzzkWs.terminate(); } catch {}
    chzzkWs = null;
  }
  chzzkChatChannelId = null;
  // 잠시 대기 후 연결 (이전 연결 정리 시간)
  await new Promise(r => setTimeout(r, 500));

  state.channelId = channelId;
  saveBotRuntimeState();
  if (state.bot.sendToChat && !hasChzzkAuth()) {
    state.bot.lastSendError = '채팅답장 ON 상태지만 봇 계정 인증이 없어 읽기 연결만 시도합니다.';
  }

  let chatChannelId = channelId;
  try {
    const json = await fetchChzzkJson(
      `https://api.chzzk.naver.com/service/v2/channels/${channelId}/live-detail`,
      { headers: chzzkHeaders() }
    );
    chatChannelId = json?.content?.chatChannelId || channelId;
    chzzkChatChannelId = chatChannelId;
    console.log('[CHZZK] chatChannelId:', chatChannelId);
  } catch (e) { chzzkChatChannelId = chatChannelId; console.log('[CHZZK] chatChannelId fallback:', e.message); }

  let accessToken = null;
  let botUid = null;
  try {
    const json = await fetchChzzkJson(
      `https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${chatChannelId}&chatType=STREAMING`,
      { headers: chzzkHeaders() }
    );
    const content = json?.content || {};
    accessToken = content.accessToken || null;
    botUid = content.userIdHash || null;
    chzzkExtraToken = content.extraToken || null;
  } catch (e) { console.log('[CHZZK] token failed:', e.message); }

  // uid가 없으면 봇 계정 프로필 API로 조회
  if (!botUid && hasChzzkAuth()) {
    try {
      const j = await fetchChzzkJson(
        'https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus',
        { headers: chzzkHeaders() }
      );
      botUid = (j?.content || j)?.userIdHash || null;
    } catch (e) { console.log('[CHZZK] uid fetch failed:', e.message); }
  }

  connectChatWs(chatChannelId, channelId, accessToken, botUid, chzzkExtraToken);
}

function connectChatWs(chatChannelId, originalChannelId, accessToken, botUid = null, extraToken = null) {
  const WS = ws_module;
  chzzkAuthed = false;
  const chatAuthMode = state.bot.sendToChat && hasChzzkAuth() ? 'SEND' : 'READ';
  const serverNum = Math.floor(Math.random() * 9) + 1;
  const url = `wss://kr-ss${serverNum}.chat.naver.com/chat`;
  console.log('[CHZZK] connecting to', url);

  const ws = new WS(url, {
    perMessageDeflate: false,
    handshakeTimeout: 10000,
    headers: {
      ...chzzkHeaders(),
    }
  });
  chzzkWs = ws;
  const connectGuard = setTimeout(() => {
    if (state.channelId !== originalChannelId || chzzkAuthed) return;
    state.bot.status = 'closed';
    state.bot.lastSendError = '치지직 채팅 서버가 연결 성공 응답을 주지 않았습니다.';
    broadcastState();
    try { ws.terminate(); } catch {}
  }, 12000);

  ws.on('open', () => {
    console.log('[CHZZK] open!');
    // 연결 확인 패킷 먼저 대기
    setTimeout(() => {
      ws.send(JSON.stringify({
        ver: '3', cmd: CHZZK_CMD.CONNECT, svcid: 'game', cid: chatChannelId,
        bdy: { uid: chatAuthMode === 'SEND' ? botUid : null, devType: 2001, accTkn: accessToken, auth: chatAuthMode,
               libVer: '4.9.1', osVer: 'Windows/10', devName: 'Chrome/120.0.0.0',
               locale: 'ko', chzzkTk: extraToken },
        tid: 1,
      }));
    }, 500);
    chzzkPing = setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ ver: '3', cmd: 0 }));
    }, 20000);
    broadcastState();
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
      if (msg.cmd === CHZZK_CMD.PING) { ws.send(JSON.stringify({ ver: '3', cmd: CHZZK_CMD.PONG })); return; }
      if (msg.cmd === CHZZK_CMD.PONG) return;
      if (msg.cmd === CHZZK_CMD.CONNECTED || msg.cmd === CHZZK_CMD.CONNECT) {
        clearTimeout(connectGuard);
        chzzkAuthed = true;
        chzzkSid = msg.bdy?.sid || null;
        chzzkReconnectDelay = 5000;
        state.bot.status = chatAuthMode === 'SEND' ? 'connected-send' : 'connected-read';
        state.bot.lastSendError = null;
        if (chatAuthMode === 'READ' && state.bot.sendToChat && !hasChzzkAuth()) {
          state.bot.lastSendError = '봇 계정 인증이 없어 채팅 읽기만 연결됐습니다.';
        }
        console.log('[CHZZK] connected:', chatAuthMode, '| sid:', chzzkSid ? '획득' : 'null');

        // SEND 모드인데 sid가 없으면 → 인증 실패, READ로 폴백
        if (chatAuthMode === 'SEND' && !chzzkSid) {
          console.log('[CHZZK] SEND 인증 실패(sid 없음) - 봇 계정 NID 확인 필요');
          state.bot.sendToChat = false;
          state.bot.status = 'connected-read';
          state.bot.lastSendError = '채팅 답장 연결 실패. 봇 계정 NID_AUT/NID_SES를 다시 입력해주세요.';
          broadcastState();
          // READ 모드로 재연결
          try { ws.terminate(); } catch(e) {}
          return;
        }

        // READ 모드에서만 최근 채팅 구독
        if (chatAuthMode === 'READ') {
          try {
            ws.send(JSON.stringify({
              ver: '3', cmd: CHZZK_CMD.REQUEST_RECENT_CHAT, svcid: 'game', cid: chatChannelId,
              bdy: { recentMessageCount: 30, userCount: 0 }, tid: 2,
            }));
          } catch(e) {}
        }
        broadcastState();
        return;
      }
      if (msg.cmd === 100) return;
      if (msg.cmd === 93101) { handleChat(msg); return; }
      if (msg.cmd === 93102) { handleDonation(msg); return; }
      // 미확인 cmd는 무시
    } catch (e) { console.log('[CHZZK] parse error:', e.message); }
  });

  ws.on('close', (code) => {
    console.log('[CHZZK] closed:', code);
    clearTimeout(connectGuard);
    if (chzzkPing) { clearInterval(chzzkPing); chzzkPing = null; }
    chzzkAuthed = false;
    state.bot.status = 'closed';
    if (state.channelId === originalChannelId && !state.bot.lastSendError) {
      state.bot.lastSendError = `치지직 채팅 연결이 끊겼습니다. (${code})`;
    }
    broadcastState();
    scheduleChzzkReconnect(chatChannelId, originalChannelId);
  });

  ws.on('error', (err) => {
    clearTimeout(connectGuard);
    state.bot.lastSendError = err.message || '치지직 채팅 웹소켓 연결 실패';
    broadcastState();
    console.error('[CHZZK] error:', err.message);
  });
}

function handleChat(msg) {
  const chats = Array.isArray(msg.bdy) ? msg.bdy : (msg.bdy?.messageList || []);
  chats.forEach(chat => {
    const rawProfile = chat.profile;
    const profile = typeof rawProfile === "string" ? JSON.parse(rawProfile || "{}") : (rawProfile || {});
    const nickname = profile.nickname || chat.nickname || "unknown";
    const text = (chat.msg || chat.message || chat.content || '').trim();
    if (!text) return;
    const now = Date.now();
    const messageTime = Number(chat.msgTime || chat.ctime || chat.createTime || 0);
    const chatKey = [
      chat.msgId || chat.messageId || chat.sid || '',
      nickname,
      text,
      messageTime || Math.floor(now / 1000),
    ].join('|');
    const lastSeen = recentChatKeys.get(chatKey) || 0;
    if (now - lastSeen < 3000) return;
    recentChatKeys.set(chatKey, now);
    for (const [key, seenAt] of recentChatKeys) {
      if (now - seenAt > 30000) recentChatKeys.delete(key);
    }

    chzzkLastMessageAt = now;
    if (!chzzkAuthed || state.bot.status === 'connecting' || state.bot.status === 'closed') {
      chzzkAuthed = true;
      chzzkReconnectDelay = 5000;
      state.bot.status = state.bot.sendToChat && hasChzzkAuth() ? 'connected-send' : 'connected-read';
      broadcastState();
    }
    console.log('[CHAT] keys:', Object.keys(chat).join(','), 'nick:', nickname, 'text:', text);

    state.chatLog.push({ nickname, text, ts: now });
    if (state.chatLog.length > 300) state.chatLog.shift();

    if (/^!포인트(?:\s|$)/.test(text)) {
      state.bot.lastCommand = { nickname, text, command: '!포인트', ts: Date.now() };
      handlePointCommand(nickname);
    }

    if (/^!승률(?:\s|$)/.test(text)) {
      state.bot.lastCommand = { nickname, text, command: '!승률', ts: Date.now() };
      handleWinrateCommand(nickname);
    }

    if (/^!참가(?:\s|$)/.test(text)) {
      broadcast({ type: 'inhouse_join', nickname, text, ts: Date.now() });
    }

    // 커스텀 명령어 우선 체크 (내장 명령어 오버라이드 가능)
    const _cmdKey = text.trim().toLowerCase().split(/\s/)[0];
    const _custom = readCustomCmds().find(c => c.cmd === _cmdKey);
    if (_custom) {
      sendBotNotice(nickname, _custom.text);
    } else if (/^!디코(?:\s|$)/.test(text)) {
      sendBotNotice(nickname, '다비도 디스코드 👉 https://discord.gg/2fxXMQH7');
    }

    // 투표
    if (state.vote.active) {
      const m = text.match(/^!투표\s*(\d+)$/);
      if (m) {
        const idx = parseInt(m[1]) - 1;
        if (idx >= 0 && idx < state.vote.items.length) {
          // 항목이 있으면 !투표5(취소 항목 포함)도 일반 투표와 동일하게 집계
          state.vote.items.forEach(it => { it.votes = it.votes.filter(v => v !== nickname); });
          state.vote.items[idx].votes.push(nickname);
        } else if (idx === 4) {
          // 취소 항목이 없는 투표에서는 !투표5 = 내 투표 취소
          state.vote.items.forEach(it => { it.votes = it.votes.filter(v => v !== nickname); });
        }
      }
    }

    // 신청곡
    if (text.startsWith('!신청곡 ')) {
      const query = text.slice(5).trim();
      if (query) handleMusicRequest(nickname, query);
    }

    // 시청자 사이트 채팅 인증 코드 감지 (!인증 XXXXX)
    if (VIEWER_SERVER_URL) {
      const authMatch = text.trim().match(/^!인증\s+([A-HJ-NP-Z2-9]{5})$/i);
      if (authMatch) {
        console.log(`[AUTH] 코드 감지: ${authMatch[1]} by ${nickname}`);
        postJson(`${VIEWER_SERVER_URL}/api/auth/confirm`, { token: authMatch[1].toUpperCase(), name: nickname }, { 'x-admin-secret': VIEWER_SERVER_SECRET })
          .then(() => { console.log(`[AUTH] 인증 성공: ${nickname}`); sendBotNotice(nickname, `✅ ${nickname}님 인증 완료!`); })
          .catch(err => { console.log(`[AUTH] 인증 실패: ${err.message}`); sendBotNotice(nickname, `❌ 인증 실패: ${err.message}`); });
      }
    }

    broadcast({ type: 'chat', nickname, text, ts: Date.now() });
    broadcast({ type: 'vote_update', vote: state.vote });
  });
}

function handleDonation(msg) {
  const chats = Array.isArray(msg.bdy) ? msg.bdy : (msg.bdy?.messageList || []);
  chats.forEach(chat => {
    const rawProfile = chat.profile;
    const profile = typeof rawProfile === 'string' ? JSON.parse(rawProfile || '{}') : (rawProfile || {});
    const nickname = profile.nickname || chat.nickname || 'unknown';

    let payAmount = 0;
    let payType = '';
    try {
      const extras = typeof chat.extras === 'string' ? JSON.parse(chat.extras) : (chat.extras || {});
      payAmount = Number(extras.payAmount || extras.amount || 0);
      payType = String(extras.payType || extras.pay_type || '').toUpperCase();
    } catch (e) {}

    console.log('[DONATION]', nickname, payType || '(타입없음)', payAmount, '치즈 | keys:', Object.keys(chat).join(','));

    // 룰렛 결과/보관함 지급은 위플랩 동기화(pollWeflabAlerts)가 전담 — 자체 추첨은 비활성화
    // (시청자가 보는 룰렛은 위플랩이고, 우리 쪽에서 별도로 무작위 추첨하면 결과가 어긋남)
  });
}

async function handleMusicRequest(nickname, query) {
  const track = await searchYouTube(query);
  if (!track) return;
  if (state.music.queue.some(t => t.videoId === track.videoId)) return;
  state.music.queue.push({ ...track, requestedBy: nickname, addedAt: Date.now() });
  if (state.music.queue.length === 1) { state.music.currentIdx = 0; state.music.playing = true; }
  broadcast({ type: 'music_update', music: state.music });
  broadcast({ type: 'chat', nickname: '🎵 신청곡', text: `[${nickname}] "${track.title}" 추가!`, ts: Date.now(), isSystem: true });
}

// ── YouTube 검색 ──
async function searchYouTube(query, max = 8) {
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%3D%3D`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR' } });
    const html = await res.text();
    const match = html.match(/var ytInitialData = (\{.+?\});<\/script>/);
    if (!match) return max === 1 ? null : [];
    const data = JSON.parse(match[1]);
    const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents;
    if (!contents) return max === 1 ? null : [];
    const results = [];
    for (const item of contents) {
      const v = item?.videoRenderer;
      if (!v?.videoId) continue;
      // 임베드 불가 영상 제외
      if (v.badges?.some(b => b?.metadataBadgeRenderer?.label === 'Unlicensed')) continue;
      results.push({
        videoId: v.videoId,
        title: v.title?.runs?.[0]?.text || '',
        channel: v.ownerText?.runs?.[0]?.text || '',
        thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
        duration: v.lengthText?.simpleText || '',
      });
      if (results.length >= max) break;
    }
    return max === 1 ? (results[0] || null) : results;
  } catch { return max === 1 ? null : []; }
}

// ── API ──
const COLORS = ['#4285f4','#ea4335','#34a853','#fbbc04','#9c27b0','#00bcd4','#ff5722','#e91e63'];
const PASSWORD = process.env.APP_PASSWORD || '09870987';

app.post('/api/action', async (req, res) => {
  const { type, ...body } = req.body;

  switch (type) {
    case 'connect_chzzk':
      try {
        await connectChzzk(body.channelId);
        saveBotRuntimeState();
        return res.json({ ok: true, data: publicState() });
      } catch (err) {
        return res.status(400).json({ ok: false, error: err.message || '치지직 연결 실패', data: publicState() });
      }

    case 'disconnect_chzzk':
      clearTimeout(chzzkReconnectTimer);
      chzzkReconnectTimer = null;
      if (chzzkWs) { try { chzzkWs.terminate(); } catch {} chzzkWs = null; }
      if (chzzkPing) { clearInterval(chzzkPing); chzzkPing = null; }
      state.channelId = null;
      chzzkChatChannelId = null;
      chzzkAuthed = false;
      state.bot.status = 'idle';
      saveBotRuntimeState();
      broadcastState();
      return res.json({ ok: true });

    case 'set_bot_enabled':
      state.bot.enabled = body.enabled !== false;
      saveBotRuntimeState();
      broadcastState();
      return res.json({ ok: true, bot: state.bot });

    case 'set_bot_chat_send':
      state.bot.sendToChat = body.enabled === true;
      state.bot.lastSendError = null;
      if (state.bot.sendToChat && !hasChzzkAuth()) {
        state.bot.lastSendError = '치지직 채팅 답장을 쓰려면 봇 계정 NID_AUT/NID_SES 인증이 필요합니다.';
      }
      if (state.channelId) connectChzzk(state.channelId).catch(err => {
        state.bot.lastSendError = err.message || '치지직 재연결 실패';
        broadcastState();
      });
      saveBotRuntimeState();
      broadcastState();
      return res.json({ ok: true, bot: state.bot });

    case 'set_bot_auth':
      chzzkAuth.nidAut = String(body.nidAut || '').trim();
      chzzkAuth.nidSes = String(body.nidSes || '').trim();
      saveBotAuth(chzzkAuth.nidAut, chzzkAuth.nidSes);
      state.bot.hasAuth = hasChzzkAuth();
      state.bot.lastSendError = hasChzzkAuth() ? null : 'NID_AUT/NID_SES가 모두 필요합니다.';
      if (state.channelId) connectChzzk(state.channelId).catch(err => {
        state.bot.lastSendError = err.message || '치지직 재연결 실패';
        broadcastState();
      });
      broadcastState();
      return res.json({ ok: true, bot: state.bot });

    case 'clear_bot_auth':
      chzzkAuth.nidAut = '';
      chzzkAuth.nidSes = '';
      saveBotAuth('', '');
      state.bot.hasAuth = false;
      state.bot.sendToChat = false;
      state.bot.lastSendError = null;
      if (state.channelId) connectChzzk(state.channelId).catch(err => {
        state.bot.lastSendError = err.message || '치지직 재연결 실패';
        broadcastState();
      });
      saveBotRuntimeState();
      broadcastState();
      return res.json({ ok: true, bot: state.bot });

    case 'bot_notice':
      sendBotNotice(body.nickname || '방송공지', body.text || '');
      return res.json({ ok: true, bot: state.bot });

    case 'bot_send_test':
      sendChzzkChat(body.text || '다비도 봇 테스트');
      return res.json({ ok: true, bot: state.bot });

    case 'send_discord_register_button': {
      const channelId = String(body.channelId || '').replace(/\D/g, '');
      if (!channelId) return res.json({ ok: false, error: '디스코드 채널 ID가 필요합니다.' });
      if (!DISCORD_BOT_API_URL || !DISCORD_BOT_API_SECRET) {
        return res.json({ ok: false, error: 'DISCORD_BOT_API_URL / DISCORD_BOT_API_SECRET 환경변수가 필요합니다.' });
      }
      const botApiEndpoint = `${DISCORD_BOT_API_URL}/api/inhouse-register-button`;
      const baseUrl = String(process.env.PUBLIC_BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN || `${req.protocol}://${req.get('host')}`)
        .replace(/^([^:]+:\/\/)?([^/]+)$/, (all, proto, host) => proto ? all : `https://${host}`)
        .replace(/\/+$/, '');
      const cfg = readDiscordConfig();
      try {
        const result = await postJson(botApiEndpoint, {
          secret: DISCORD_BOT_API_SECRET,
          channelId,
          apiBaseUrl: baseUrl,
          siteUrl: baseUrl,
          registerEndpoint: `${baseUrl}/api/inhouse-register`,
          linkEndpoint: `${baseUrl}/api/discord-link`,
          endpoints: {
            register: `${baseUrl}/api/inhouse-register`,
            link: `${baseUrl}/api/discord-link`,
          },
          discordConfig: cfg,
        });
        return res.json(result);
      } catch (err) {
        return res.json({ ok: false, error: `${err.message || '보관함봇 호출 실패'} (${botApiEndpoint})` });
      }
    }

    case 'move_discord_voice_teams': {
      const cfg = readDiscordConfig();
      const lobbyChannelId = String(body.lobbyChannelId || cfg.voiceLobbyChannelId || '').replace(/\D/g, '');
      const blueChannelId = String(body.blueChannelId || cfg.voiceBlueChannelId || '').replace(/\D/g, '');
      const redChannelId = String(body.redChannelId || cfg.voiceRedChannelId || '').replace(/\D/g, '');
      const cleanIds = value => Array.isArray(value)
        ? value.map(id => String(id || '').replace(/\D/g, '')).filter(Boolean)
        : [];
      const blueDiscordIds = cleanIds(body.blueDiscordIds);
      const redDiscordIds = cleanIds(body.redDiscordIds);
      if (!lobbyChannelId || !blueChannelId || !redChannelId) {
        return res.json({ ok: false, error: '내전대기방 / 1팀 / 2팀 음성채널 ID를 먼저 저장하세요.' });
      }
      if (blueChannelId === redChannelId || lobbyChannelId === blueChannelId || lobbyChannelId === redChannelId) {
        return res.json({ ok: false, error: '내전대기방, 1팀, 2팀 음성채널 ID는 서로 다른 채널이어야 합니다.' });
      }
      if (!blueDiscordIds.length && !redDiscordIds.length) {
        return res.json({ ok: false, error: '팀원 중 디스코드 등록이 안 된 사람이 있습니다.' });
      }
      if (!DISCORD_BOT_API_URL || !DISCORD_BOT_API_SECRET) {
        return res.json({ ok: false, error: 'DISCORD_BOT_API_URL / DISCORD_BOT_API_SECRET 환경변수가 필요합니다.' });
      }
      const botApiEndpoint = `${DISCORD_BOT_API_URL}/api/move-voice-teams`;
      try {
        const result = await postJson(botApiEndpoint, {
          secret: DISCORD_BOT_API_SECRET,
          lobbyChannelId,
          blueChannelId,
          redChannelId,
          blueDiscordIds,
          redDiscordIds,
        });
        return res.json(result);
      } catch (err) {
        return res.json({ ok: false, error: `${err.message || '보관함봇 호출 실패'} (${botApiEndpoint})` });
      }
    }

    case 'start_vote':
      state.vote = {
        active: true,
        title: body.title || '내전 투표',
        items: (body.items || []).map((label, i) => ({ label, votes: [], excluded: [], color: COLORS[i % COLORS.length] })),
        startedAt: Date.now(),
      };
      broadcast({ type: 'vote_update', vote: state.vote });
      return res.json({ ok: true });

    case 'vote_exclude': {
      const it = state.vote.items[body.voteIdx];
      if (it && body.name) {
        if (!Array.isArray(it.excluded)) it.excluded = [];
        if (!it.excluded.includes(body.name)) it.excluded.push(body.name);
        broadcast({ type: 'vote_update', vote: state.vote });
      }
      return res.json({ ok: true });
    }

    case 'vote_unexclude': {
      const it = state.vote.items[body.voteIdx];
      if (it && body.name) {
        it.excluded = (it.excluded || []).filter(n => n !== body.name);
        broadcast({ type: 'vote_update', vote: state.vote });
      }
      return res.json({ ok: true });
    }

    case 'end_vote':
      state.vote.active = false;
      broadcast({ type: 'vote_update', vote: state.vote });
      return res.json({ ok: true });

    case 'reset_vote':
      state.vote = { active: false, title: '내전 투표', items: [], startedAt: null };
      state.chatLog = [];
      broadcast({ type: 'vote_update', vote: state.vote });
      return res.json({ ok: true });

    case 'set_roulette':
      state.roulette.items = body.items || [];
      broadcast({ type: 'roulette_update', roulette: state.roulette });
      return res.json({ ok: true });

    case 'set_inhouse_teams':
      state.inhouseTeams = {
        blue: Array.isArray(body.blue) ? body.blue : [],
        red: Array.isArray(body.red) ? body.red : [],
        updatedAt: Date.now(),
      };
      broadcast({ type: 'inhouse_teams_update', inhouseTeams: state.inhouseTeams });
      return res.json({ ok: true });

    case 'vote_to_roulette':
      state.roulette.items = state.vote.items.map((it, i) => ({
        label: it.label, weight: it.votes.length || 1, color: COLORS[i % COLORS.length]
      }));
      broadcast({ type: 'roulette_update', roulette: state.roulette });
      return res.json({ ok: true });

    case 'music_search': {
      const results = await searchYouTube(body.query, 8);
      return res.json({ ok: true, results });
    }
    case 'music_add': {
      const track = body.track;
      if (!track?.videoId) return res.json({ ok: false });
      if (!state.music.queue.some(t => t.videoId === track.videoId)) {
        state.music.queue.push({ ...track, requestedBy: body.requestedBy || '방장', addedAt: Date.now() });
        if (state.music.queue.length === 1) { state.music.currentIdx = 0; state.music.playing = true; }
      }
      broadcast({ type: 'music_update', music: state.music });
      return res.json({ ok: true });
    }
    case 'music_next':
      if (state.music.queue.length) {
        state.music.currentIdx = (state.music.currentIdx + 1) % state.music.queue.length;
        state.music.playing = true;
      }
      broadcast({ type: 'music_update', music: state.music });
      return res.json({ ok: true });

    case 'music_prev':
      if (state.music.queue.length) {
        state.music.currentIdx = (state.music.currentIdx - 1 + state.music.queue.length) % state.music.queue.length;
        state.music.playing = true;
      }
      broadcast({ type: 'music_update', music: state.music });
      return res.json({ ok: true });

    case 'music_play_idx':
      state.music.currentIdx = body.idx;
      state.music.playing = true;
      broadcast({ type: 'music_update', music: state.music });
      return res.json({ ok: true });

    case 'music_remove':
      state.music.queue.splice(body.idx, 1);
      if (state.music.currentIdx >= state.music.queue.length)
        state.music.currentIdx = Math.max(0, state.music.queue.length - 1);
      broadcast({ type: 'music_update', music: state.music });
      return res.json({ ok: true });

    case 'music_clear':
      state.music = { queue: [], currentIdx: 0, playing: false };
      broadcast({ type: 'music_update', music: state.music });
      return res.json({ ok: true });

    case 'get_state':
      return res.json(publicState());

    case 'test_point_command':
      handlePointCommand(body.nickname || '다비도');
      return res.json({ ok: true, bot: state.bot });

    case 'get_lcu_draft':
      return res.json({ ok: true, data: state.lcuDraft });

    case 'set_lcu_draft':
      updateLcuDraft({
        ...(body.data || {}),
        source: 'relay',
      });
      return res.json({ ok: true });

    default:
      return res.json({ error: 'unknown' }, 400);
  }
});

const PORT = process.env.PORT || 3000;
function restoreChzzkConnectionAfterBoot() {
  if (!state.channelId || state.bot.enabled === false) return;
  state.bot.status = 'reconnecting';
  state.bot.lastSendError = null;
  broadcastState();
  console.log(`[CHZZK] restoring saved channel: ${state.channelId}`);
  connectChzzk(state.channelId).catch(err => {
    state.bot.status = 'closed';
    state.bot.lastSendError = err.message || '치지직 자동 재연결 실패';
    broadcastState();
  });
}

server.listen(PORT, () => {
  console.log('========================================');
  console.log(`  다비도의 내전 서버 실행 중`);
  console.log(`  http://localhost:${PORT}`);
  console.log('========================================');
  startLcuPolling();
  setTimeout(restoreChzzkConnectionAfterBoot, 1500);
  setInterval(() => { pollWeflabAlerts().catch(() => {}); }, WEFLAB_POLL_MS);
});
