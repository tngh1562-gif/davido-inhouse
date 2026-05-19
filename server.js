// =============================================
//  다비도의 내전 - 통합 서버
//  npm install ws express chzzk
//  실행: node server.js
// =============================================

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

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
const DISCORD_CONFIG_FILE = path.join(DATA_DIR, 'discord-config.json');
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

function writeViewerUpsert(viewer) {
  const existing = readInhouseDB();
  const viewers = mergeViewers(existing.viewers, [viewer]);
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

function upsertViewerFromDiscordRegistration(body) {
  const db = readInhouseDB();
  const discordId = normalizeRegisterText(body.discordId || body.discordUserId || body.userId || body.memberId, 40).replace(/\D/g, '');
  const name = normalizeRegisterName(body);
  const chzzk = normalizeRegisterText(body.chzzk || body.chzzkNick || body.chzzkNickname || body.chzzkName || body.chatName || body.chatNickname || body['치지직'], 120);
  const tier = normalizeRegisterTier(body.tier || body.rank || body.lolTier || body['티어']);
  const memo = normalizeRegisterText(body.memo || body.note, 500);
  const positions = normalizeRegisterPositions(body);
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
    if (discordId) viewer.discordId = discordId;
    viewer.updatedAt = now;
    viewer.registeredFrom = viewer.registeredFrom || 'discord';
  }

  db.vid = Math.max(Number(db.vid) || 0, Number(viewer.id) || 0);
  return { db: writeViewerUpsert(viewer), viewer };
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

function writeDiscordConfig(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = normalizeDiscordConfig({ ...readDiscordConfig(), ...(data || {}), updatedAt: new Date().toISOString() });
  const tmp = DISCORD_CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, DISCORD_CONFIG_FILE);
  return payload;
}

app.get('/api/inhouse-db', (req, res) => {
  res.json(readInhouseDB());
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

function handleDiscordInhouseRegister(req, res) {
  if (!validateDiscordBotSecret(req, res)) return;
  try {
    const result = upsertViewerFromDiscordRegistration(req.body || {});
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

app.get('/api/discord-config', (req, res) => {
  res.json(readDiscordConfig());
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
    if (!fs.existsSync(MANUAL_BACKUP_DIR)) fs.mkdirSync(MANUAL_BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `backup-${stamp}.json`;
    const data = { savedAt: new Date().toISOString(), version: 1, inhouseDb, discordConfig };
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
    const { inhouseDb, discordConfig, version } = req.body || {};
    if (!inhouseDb || !Array.isArray(inhouseDb.viewers)) {
      return res.status(400).json({ ok: false, error: '유효하지 않은 백업 파일입니다. (viewers 배열 없음)' });
    }
    writeInhouseDB(inhouseDb);
    if (discordConfig && typeof discordConfig === 'object') writeDiscordConfig(discordConfig);
    console.log(`[IMPORT_BACKUP] restored: viewers=${inhouseDb.viewers.length}, version=${version}`);
    res.json({ ok: true, restored: { viewers: inhouseDb.viewers.length } });
  } catch (err) {
    console.error('[IMPORT_BACKUP] failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/discord-config', (req, res) => {
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

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = Buffer.from(JSON.stringify(payload || {}), 'utf8');
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
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
  return db.viewers.find(viewer =>
    normalizeChatName(viewer.chzzk) === key || normalizeChatName(viewer.name) === key
  ) || db.viewers.find(viewer => {
    const chzzk = normalizeChatName(viewer.chzzk);
    const name = normalizeChatName(viewer.name);
    return (chzzk && (chzzk.includes(key) || key.includes(chzzk)))
      || (name && (name.includes(key) || key.includes(name)));
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

// ── WebSocket 클라이언트 ──
wss.on('connection', (ws) => {
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
  const WS = require('ws');
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
      if (msg.cmd === 93101) { handleChat(msg); }
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
    return;
    if (state.channelId === originalChannelId) {
      console.log('[CHZZK] 재연결 5초 후...');
      setTimeout(async () => {
        let newToken = null;
        try {
          const res = await fetch(`https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${chatChannelId}&chatType=STREAMING`,
            { headers: chzzkHeaders() });
          const json = await res.json();
          newToken = json?.content?.accessToken || null;
        } catch {}
        connectChatWs(chatChannelId, originalChannelId, newToken);
      }, 5000);
    }
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

    if (/^!참가(?:\s|$)/.test(text)) {
      broadcast({ type: 'inhouse_join', nickname, text, ts: Date.now() });
    }

    // 투표
    if (state.vote.active) {
      const m = text.match(/^!투표\s*(\d+)$/);
      if (m) {
        const idx = parseInt(m[1]) - 1;
        if (idx >= 0 && idx < state.vote.items.length) {
          state.vote.items.forEach(it => { it.votes = it.votes.filter(v => v !== nickname); });
          state.vote.items[idx].votes.push(nickname);
        }
      }
    }

    // 신청곡
    if (text.startsWith('!신청곡 ')) {
      const query = text.slice(5).trim();
      if (query) handleMusicRequest(nickname, query);
    }

    broadcast({ type: 'chat', nickname, text, ts: Date.now() });
    broadcast({ type: 'vote_update', vote: state.vote });
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
      broadcastState();
      return res.json({ ok: true });

    case 'set_bot_enabled':
      state.bot.enabled = body.enabled !== false;
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
        items: (body.items || []).map((label, i) => ({ label, votes: [], color: COLORS[i % COLORS.length] })),
        startedAt: Date.now(),
      };
      broadcast({ type: 'vote_update', vote: state.vote });
      return res.json({ ok: true });

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
server.listen(PORT, () => {
  console.log('========================================');
  console.log(`  다비도의 내전 서버 실행 중`);
  console.log(`  http://localhost:${PORT}`);
  console.log('========================================');
  startLcuPolling();
});
