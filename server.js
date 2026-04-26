// =============================================
//  다비도의 내전 - 통합 서버
//  npm install ws express chzzk
//  실행: node server.js
// =============================================

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── 상태 ──
const state = {
  channelId: null,
  chzzkConnected: false,
  vote: { active: false, title: '내전 투표', items: [], startedAt: null },
  roulette: { items: [] },
  music: { queue: [], currentIdx: 0, playing: false },
  chatLog: [],
};

let chzzkWs = null;
let chzzkPing = null;

// ── 브로드캐스트 ──
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function broadcastState() {
  broadcast({ type: 'state', data: { ...state, chzzkConnected: chzzkWs?.readyState === 1 } });
}

// ── WebSocket 클라이언트 ──
wss.on('connection', (ws) => {
  console.log('[WS] 브라우저 연결');
  ws.send(JSON.stringify({ type: 'state', data: { ...state, chzzkConnected: chzzkWs?.readyState === 1 } }));
});

// ── 치지직 연결 ──
async function connectChzzk(channelId) {
  if (chzzkWs) { try { chzzkWs.terminate(); } catch {} chzzkWs = null; }
  if (chzzkPing) { clearInterval(chzzkPing); chzzkPing = null; }

  state.channelId = channelId;

  let chatChannelId = channelId;
  try {
    const res = await fetch(`https://api.chzzk.naver.com/service/v2/channels/${channelId}/live-detail`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://chzzk.naver.com/' } });
    const json = await res.json();
    chatChannelId = json?.content?.chatChannelId || channelId;
    console.log('[CHZZK] chatChannelId:', chatChannelId);
  } catch (e) { console.log('[CHZZK] chatChannelId fallback:', e.message); }

  let accessToken = null;
  try {
    const res = await fetch(`https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${chatChannelId}&chatType=STREAMING`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://chzzk.naver.com/' } });
    const json = await res.json();
    accessToken = json?.content?.accessToken || null;
    console.log('[CHZZK] accessToken:', accessToken ? '획득' : '없음');
  } catch (e) { console.log('[CHZZK] token failed:', e.message); }

  connectChatWs(chatChannelId, channelId, accessToken);
}

function connectChatWs(chatChannelId, originalChannelId, accessToken) {
  const WS = require('ws');
  const serverNum = Math.floor(Math.random() * 9) + 1;
  const url = `wss://kr-ss${serverNum}.chat.naver.com/chat`;
  console.log('[CHZZK] connecting to', url);

  const ws = new WS(url, {
    perMessageDeflate: false,
    handshakeTimeout: 10000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Origin': 'https://chzzk.naver.com',
      'Referer': 'https://chzzk.naver.com/',
    }
  });
  chzzkWs = ws;

  ws.on('open', () => {
    console.log('[CHZZK] open!');
    // 연결 확인 패킷 먼저 대기
    setTimeout(() => {
      ws.send(JSON.stringify({
        ver: '3', cmd: 100, svcid: 'game', cid: chatChannelId,
        bdy: { uid: null, devType: 2001, accTkn: accessToken, auth: 'READ',
               libVer: '4.9.1', osVer: 'Windows/10', devName: 'Chrome/120.0.0.0',
               locale: 'ko', chzzkTk: null },
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
      console.log('[CHZZK] recv cmd:', msg.cmd);
      if (msg.cmd === 0) { ws.send(JSON.stringify({ ver: '3', cmd: 10000 })); return; }
      if (msg.cmd === 10000) return;
      if (msg.cmd === 100) { console.log('[CHZZK] 인증 응답:', JSON.stringify(msg.bdy)); return; }
      if (msg.cmd === 93101) { console.log('[CHZZK] chat raw:', JSON.stringify(msg.bdy).slice(0,200)); handleChat(msg); }
    } catch (e) { console.log('[CHZZK] parse error:', e.message); }
  });

  ws.on('close', (code) => {
    console.log('[CHZZK] closed:', code);
    if (chzzkPing) { clearInterval(chzzkPing); chzzkPing = null; }
    broadcastState();
    if (state.channelId === originalChannelId) {
      console.log('[CHZZK] 재연결 5초 후...');
      setTimeout(async () => {
        let newToken = null;
        try {
          const res = await fetch(`https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${chatChannelId}&chatType=STREAMING`,
            { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://chzzk.naver.com/' } });
          const json = await res.json();
          newToken = json?.content?.accessToken || null;
        } catch {}
        connectChatWs(chatChannelId, originalChannelId, newToken);
      }, 5000);
    }
  });

  ws.on('error', (err) => console.error('[CHZZK] error:', err.message));
}

function handleChat(msg) {
  const chats = msg.bdy?.messageList || [];
  chats.forEach(chat => {
    const nickname = chat.profile?.nickname || '익명';
    const text = (chat.msg || '').trim();
    if (!text) return;
    console.log('[CHAT]', nickname, ':', text);

    state.chatLog.push({ nickname, text, ts: Date.now() });
    if (state.chatLog.length > 300) state.chatLog.shift();

    // 투표
    if (state.vote.active) {
      const m = text.match(/^!투표(\d+)$/);
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
      await connectChzzk(body.channelId);
      return res.json({ ok: true });

    case 'disconnect_chzzk':
      if (chzzkWs) { try { chzzkWs.terminate(); } catch {} chzzkWs = null; }
      if (chzzkPing) { clearInterval(chzzkPing); chzzkPing = null; }
      state.channelId = null;
      broadcastState();
      return res.json({ ok: true });

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
      return res.json({ ...state, chzzkConnected: chzzkWs?.readyState === 1 });

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
});
