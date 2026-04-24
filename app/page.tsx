'use client'
import { useEffect, useRef, useState } from 'react'

const COLORS = ['#4285f4','#ea4335','#34a853','#fbbc04','#9c27b0','#00bcd4','#ff5722','#607d8b']
const PASSWORD = '09870987'

interface VoteItem { label: string; votes: string[]; color: string }
interface Vote { active: boolean; title: string; items: VoteItem[]; startedAt: number | null }
interface RouletteItem { label: string; weight: number; color: string }
interface MusicTrack { videoId: string; title: string; channel: string; thumbnail: string; requestedBy: string; addedAt: number }
interface MusicState { queue: MusicTrack[]; currentIdx: number; playing: boolean }

export default function Home() {
  const [auth, setAuth]           = useState(false)
  const [pwInput, setPwInput]     = useState('')
  const [pwError, setPwError]     = useState(false)
  const [tab, setTab]             = useState<'inhouse'|'vote'>('inhouse')
  const [chzzkConnected, setChzzkConnected] = useState(false)
  const [channelId, setChannelId] = useState('')
  const [inputCid, setInputCid]   = useState('')
  const [chatLog, setChatLog]     = useState<{nickname:string,text:string}[]>([])
  const [vote, setVote]           = useState<Vote>({ active:false, title:'', items:[], startedAt:null })
  const [voteTitle, setVoteTitle] = useState('내전 투표')
  const [voteItemsText, setVoteItemsText] = useState('첫참\n선참권\n중참\n연참\n취소')
  const [showRoulette, setShowRoulette]   = useState(false)
  const [music, setMusic]   = useState<MusicState>({ queue: [], currentIdx: 0, playing: false })
  const [manualSearch, setManualSearch] = useState('')
  const [searching, setSearching]       = useState(false)
  const playerRef = useRef<any>(null)
  const ytReady   = useRef(false)
  const [rouletteItems, setRouletteItems] = useState<RouletteItem[]>([])
  const [excludedWinners, setExcludedWinners] = useState<string[]>([])
  const [excludeEnabled, setExcludeEnabled]   = useState(true)
  const [rInput, setRInput]   = useState('')
  const [rWeight, setRWeight] = useState('1')
  const [spinning, setSpinning] = useState(false)
  const [winner, setWinner]     = useState<string|null>(null)
  const [angle, setAngle]       = useState(0)
  const [expandedIdx, setExpandedIdx] = useState<number|null>(null)
  const [drawingIdx, setDrawingIdx]   = useState<number|null>(null)  // 추첨 중인 항목
  const [drawWinner, setDrawWinner]   = useState<{idx:number,name:string}|null>(null) // 당첨자
  const [slotNames, setSlotNames]     = useState<string[]>([]) // 슬롯 표시 이름들
  const slotTimerRef = useRef<ReturnType<typeof setInterval>>()
  const [elapsed, setElapsed]   = useState(0)
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const animRef    = useRef<number>()
  const chatEndRef = useRef<HTMLDivElement>(null)
  const timerRef   = useRef<ReturnType<typeof setInterval>>()

  const api = async (type: string, extra?: object) => {
    await fetch('/api/action', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ type, ...extra }),
    })
  }

  useEffect(() => {
    if (!auth) return
    const es = new EventSource('/api/stream')
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        switch(msg.type) {
          case 'full_state':
            setVote(msg.data.vote)
            setRouletteItems(msg.data.roulette?.items || [])
            if (msg.data.music) setMusic(msg.data.music)
            setChzzkConnected(msg.data.chzzkConnected)
            if (msg.data.channelId) setChannelId(msg.data.channelId)
            break
          case 'vote_started': case 'vote_update': case 'vote_ended':
            setVote(msg.data); break
          case 'vote_reset':
            setVote({ active:false, title:'', items:[], startedAt:null }); break
          case 'roulette_updated':
            setRouletteItems(msg.data.items || []); break
          case 'chzzk_connected':
            setChzzkConnected(true); setChannelId(msg.data.channelId); break
          case 'chzzk_disconnected':
            setChzzkConnected(false); setChannelId(''); break
          case 'chat':
            setChatLog(p => [...p.slice(-199), msg.data]); break
          case 'music_queued':
            setMusic(msg.data.queue ? {...msg.data, queue: msg.data.queue} : (p:MusicState) => ({...p, queue:[...p.queue, msg.data.track]}))
            break
          case 'music_state':
            setMusic(msg.data); break
        }
      } catch {}
    }
    return () => es.close()
  }, [auth])

  // YouTube IFrame API 로드
  useEffect(() => {
    if (!auth) return
    const tag = document.createElement('script')
    tag.src = 'https://www.youtube.com/iframe_api'
    document.head.appendChild(tag)
    ;(window as any).onYouTubeIframeAPIReady = () => {
      ytReady.current = true
      const container = document.getElementById('yt-player-container')
      if (!container) return
      playerRef.current = new (window as any).YT.Player(container, {
        width: '1',height: '1',
        playerVars: { autoplay: 1, controls: 0 },
        events: {
          onStateChange: (e: any) => {
            // 영상 끝나면 다음 곡
            if (e.data === 0) api('music_next')
          }
        }
      })
    }
  }, [auth])

  // music 상태 변화에 따른 재생 제어
  useEffect(() => {
    const player = playerRef.current
    if (!player || !ytReady.current) return
    const cur = music.queue[music.currentIdx]
    if (!cur) return
    try {
      if (music.playing) {
        const curId = player.getVideoData?.()?.video_id
        if (curId !== cur.videoId) {
          player.loadVideoById(cur.videoId)
        } else {
          player.playVideo()
        }
      } else {
        player.pauseVideo()
      }
    } catch {}
  }, [music.currentIdx, music.playing, music.queue.length])

  // 타이머
  useEffect(() => {
    if (vote.active && vote.startedAt) {
      setElapsed(Math.max(0, Math.floor((Date.now() - vote.startedAt) / 1000)))
      timerRef.current = setInterval(() => {
        setElapsed(Math.max(0, Math.floor((Date.now() - (vote.startedAt||Date.now())) / 1000)))
      }, 1000)
    } else {
      clearInterval(timerRef.current)
    }
    return () => clearInterval(timerRef.current)
  }, [vote.active, vote.startedAt])

  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
  }

  const activeRouletteItems = excludeEnabled
    ? rouletteItems.filter(it => !excludedWinners.includes(it.label))
    : rouletteItems

  useEffect(() => { if (showRoulette) drawWheel(angle) }, [activeRouletteItems, angle, showRoulette])
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior:'smooth' }) }, [chatLog])

  function drawWheel(rot: number) {
    const c = canvasRef.current; if (!c) return
    const ctx = c.getContext('2d')!
    const W=c.width, H=c.height, cx=W/2, cy=H/2, r=Math.min(cx,cy)-12
    ctx.clearRect(0,0,W,H)
    const items = activeRouletteItems
    if (!items.length) {
      ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2)
      ctx.fillStyle='#f0f4f8'; ctx.fill()
      ctx.strokeStyle='#dde3ec'; ctx.lineWidth=2; ctx.stroke()
      ctx.fillStyle='#8aa8c4'; ctx.font='14px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle'
      ctx.fillText('항목을 추가하세요', cx, cy); return
    }
    const total = items.reduce((s,i)=>s+(i.weight||1),0)
    let a = rot*Math.PI/180
    items.forEach((item,i)=>{
      const slice=(item.weight||1)/total*Math.PI*2
      ctx.beginPath(); ctx.moveTo(cx,cy)
      ctx.arc(cx,cy,r,a,a+slice); ctx.closePath()
      ctx.fillStyle=item.color||COLORS[i%COLORS.length]; ctx.fill()
      ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.stroke()
      const mid=a+slice/2
      ctx.save(); ctx.translate(cx+r*.62*Math.cos(mid),cy+r*.62*Math.sin(mid))
      ctx.rotate(mid+Math.PI/2); ctx.fillStyle='#fff'
      ctx.font='bold 12px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle'
      ctx.fillText(item.label.length>7?item.label.slice(0,7)+'…':item.label,0,0)
      ctx.restore(); a+=slice
    })
    ctx.beginPath(); ctx.arc(cx,cy,18,0,Math.PI*2)
    ctx.fillStyle='#fff'; ctx.fill()
    ctx.strokeStyle='#d4900a'; ctx.lineWidth=3; ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx-10,cy-r+4); ctx.lineTo(cx+10,cy-r+4); ctx.lineTo(cx,cy-r+22)
    ctx.closePath(); ctx.fillStyle='#d4900a'; ctx.fill()
  }

  // 항목별 추첨 함수
  function drawItem(itemIdx: number) {
    const voters = vote.items[itemIdx]?.votes || []
    if (!voters.length) return
    setDrawingIdx(itemIdx)
    setDrawWinner(null)
    setExpandedIdx(null)

    const totalFrames = 40 // 총 슬롯 프레임 수
    let frame = 0
    const winner = voters[Math.floor(Math.random() * voters.length)]

    // 슬롯머신 효과: 처음엔 빠르게, 나중엔 느리게
    const runSlot = () => {
      frame++
      const delay = frame < 20 ? 50 : frame < 30 ? 100 : frame < 36 ? 180 : frame < 39 ? 300 : 500

      // 랜덤 이름 표시
      const randomNames = Array.from({length:3}, ()=> voters[Math.floor(Math.random()*voters.length)])
      setSlotNames(randomNames)

      if (frame < totalFrames) {
        slotTimerRef.current = setTimeout(runSlot, delay)
      } else {
        // 마지막: 당첨자 확정
        setSlotNames([winner])
        setDrawWinner({idx: itemIdx, name: winner})
        setDrawingIdx(null)
      }
    }
    slotTimerRef.current = setTimeout(runSlot, 50)
  }

  function spin() {
    const items = activeRouletteItems
    if (spinning||!items.length) return
    if (animRef.current) cancelAnimationFrame(animRef.current)
    setSpinning(true); setWinner(null)
    const total = items.reduce((s,i)=>s+(i.weight||1),0)
    const rand = Math.random()*total
    let acc=0, winIdx=0
    for (let i=0;i<items.length;i++) { acc+=items[i].weight||1; if(rand<=acc){winIdx=i;break} }
    const sliceDeg=(items[winIdx].weight||1)/total*360
    const winStart=items.slice(0,winIdx).reduce((s,i)=>s+(i.weight||1)/total*360,0)
    const targetDeg=360-(winStart+sliceDeg/2)
    const finalAngle=angle+1800+((targetDeg-angle%360+360)%360)
    const startAngle=angle, startTime=performance.now()
    const animate=(now:number)=>{
      const t=Math.min((now-startTime)/5000,1)
      const ease=1-Math.pow(1-t,4)
      const cur=startAngle+(finalAngle-startAngle)*ease
      setAngle(cur); drawWheel(cur)
      if(t<1){ animRef.current=requestAnimationFrame(animate) }
      else {
        setSpinning(false)
        const winLabel=items[winIdx].label
        setWinner(winLabel); setAngle(cur%360)
        if(excludeEnabled) setExcludedWinners(p=>[...p, winLabel])
      }
    }
    animRef.current=requestAnimationFrame(animate)
  }

  function addRouletteItem() {
    if(!rInput.trim()) return
    const newItems=[...rouletteItems,{label:rInput.trim(),weight:parseInt(rWeight)||1,color:COLORS[rouletteItems.length%COLORS.length]}]
    setRouletteItems(newItems); api('set_roulette',{items:newItems}); setRInput('')
  }
  function removeRouletteItem(idx:number) {
    const newItems=rouletteItems.filter((_,i)=>i!==idx)
    setRouletteItems(newItems); api('set_roulette',{items:newItems})
  }
  function removeExcluded(label:string) { setExcludedWinners(p=>p.filter(w=>w!==label)) }

  // ── 라이트 테마 스타일 ──
  const bg   = '#f5f7fa'
  const card = '#ffffff'
  const bdr  = '#e2e8f0'
  const txt  = '#1a2433'
  const txt2 = '#6b8aaa'
  const acc  = '#d4900a'

  const S = {
    inp: (w='100%', extra:React.CSSProperties={}): React.CSSProperties => ({
      background:'#fff', border:`1px solid ${bdr}`, color:txt,
      borderRadius:'7px', padding:'8px 12px', fontSize:'13px',
      fontFamily:'inherit', outline:'none', width:w,
      boxSizing:'border-box' as const, transition:'border-color .15s', ...extra,
    }),
    card: (extra:React.CSSProperties={}): React.CSSProperties => ({
      background:card, border:`1px solid ${bdr}`,
      borderRadius:'12px', padding:'18px 20px', marginBottom:'12px',
      boxShadow:'0 1px 4px rgba(0,0,0,.06)', ...extra,
    }),
    btn: (bg2=acc, fg='#fff', ghost=false): React.CSSProperties => ({
      padding:'8px 18px', borderRadius:'7px',
      border: ghost ? `1px solid ${bdr}` : 'none',
      background: ghost ? '#fff' : bg2,
      color: ghost ? txt2 : fg,
      cursor:'pointer', fontSize:'13px', fontWeight:600,
      fontFamily:'inherit', whiteSpace:'nowrap' as const, transition:'opacity .15s',
    }),
    label: (): React.CSSProperties => ({
      fontSize:'11px', color:txt2, marginBottom:'5px',
      letterSpacing:'.5px', textTransform:'uppercase' as const, display:'block',
    }),
  }

  if (!auth) return (
    <div style={{minHeight:'100vh',background:bg,display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'\'Noto Sans KR\',sans-serif'}}>
      <div style={{background:card,border:`1px solid ${bdr}`,borderRadius:'14px',padding:'52px',textAlign:'center',width:'360px',boxShadow:'0 8px 32px rgba(0,0,0,.1)'}}>
        <div style={{fontSize:'13px',color:txt2,letterSpacing:'3px',textTransform:'uppercase',marginBottom:'10px'}}>DAVIDO</div>
        <div style={{fontSize:'26px',fontWeight:700,color:acc,marginBottom:'4px'}}>⚔ 다비도의 내전</div>
        <div style={{fontSize:'13px',color:'#b0c0d0',marginBottom:'32px'}}>관리자 전용</div>
        <input type="password" value={pwInput} autoFocus
          onChange={e=>{setPwInput(e.target.value);setPwError(false)}}
          onKeyDown={e=>{if(e.key==='Enter'){if(pwInput===PASSWORD)setAuth(true);else setPwError(true)}}}
          placeholder="비밀번호"
          style={{...S.inp(),marginBottom:'8px',fontSize:'14px',padding:'11px 14px',
            border:`1px solid ${pwError?'#e03020':bdr}`}}
        />
        {pwError&&<div style={{fontSize:'12px',color:'#e03020',marginBottom:'8px'}}>비밀번호가 틀렸습니다</div>}
        <button onClick={()=>{if(pwInput===PASSWORD)setAuth(true);else setPwError(true)}}
          style={{width:'100%',padding:'12px',borderRadius:'8px',border:'none',
            background:acc,color:'#fff',fontWeight:700,fontSize:'14px',
            fontFamily:'inherit',cursor:'pointer',marginTop:'4px'}}>
          입장하기
        </button>
      </div>
    </div>
  )

  const total = vote.items.reduce((s,i)=>s+i.votes.length,0)

  return (
    <div style={{fontFamily:'\'Noto Sans KR\',sans-serif',minHeight:'100vh',background:bg,color:txt}}>

      {/* ── 헤더 ── */}
      <div style={{background:card,borderBottom:`1px solid ${bdr}`,padding:'0 28px',display:'flex',alignItems:'stretch',position:'sticky',top:0,zIndex:200,boxShadow:'0 1px 4px rgba(0,0,0,.06)'}}>
        <div style={{fontSize:'15px',fontWeight:700,color:acc,display:'flex',alignItems:'center',gap:'8px',marginRight:'28px',letterSpacing:'.5px'}}>
          ⚔ <span style={{color:txt}}>다비도의 <span style={{color:acc}}>내전</span></span>
        </div>
        {(['inhouse','vote','music'] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t as any)} style={{
            padding:'0 22px', border:'none',
            borderBottom: tab===t ? `2px solid ${acc}` : '2px solid transparent',
            borderTop: '2px solid transparent',
            background:'none', color: tab===t ? acc : txt2,
            cursor:'pointer', fontSize:'13px', fontFamily:'inherit',
            fontWeight: tab===t ? 700 : 400, transition:'all .15s',
          }}>
            {t==='inhouse' ? '⚔ 내전 진행' : t==='vote' ? '📊 채팅 투표' : '🎵 음악 플레이어'}
          </button>
        ))}


      </div>

      {/* ── 치지직 연결 바 (투표 탭) ── */}
      {tab==='vote' && (
        <div style={{background:card,borderBottom:`1px solid ${bdr}`,padding:'8px 28px',display:'flex',alignItems:'center',gap:'12px',flexWrap:'wrap',boxShadow:'0 1px 3px rgba(0,0,0,.04)'}}>
          <div style={{display:'flex',alignItems:'center',gap:'7px'}}>
            <div style={{width:'7px',height:'7px',borderRadius:'50%',
              background:chzzkConnected?'#22c55e':'#cbd5e0',
              boxShadow:chzzkConnected?'0 0 6px #22c55e':'none',transition:'all .3s'}}/>
            <span style={{fontSize:'12px',color:txt2,fontWeight:500}}>치지직</span>
          </div>
          {chzzkConnected ? <>
            <span style={{fontSize:'12px',color:'#22c55e',fontWeight:600}}>{channelId.slice(0,24)}...</span>
            <button style={{...S.btn('#e03020'),padding:'5px 12px',fontSize:'12px'}} onClick={()=>api('disconnect_chzzk')}>해제</button>
          </> : <>
            <input style={{...S.inp('220px'),padding:'5px 10px',fontSize:'12px'}}
              placeholder="채널 ID" value={inputCid}
              onChange={e=>setInputCid(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&api('connect_chzzk',{channelId:inputCid})}/>
            <button style={{...S.btn(),padding:'5px 14px',fontSize:'12px'}}
              onClick={()=>api('connect_chzzk',{channelId:inputCid})}>연결</button>
            <span style={{fontSize:'11px',color:'#b0c0d0'}}>chzzk.naver.com/<b style={{color:acc}}>채널ID</b></span>
          </>}
          <div style={{marginLeft:'auto',display:'flex',gap:'4px',alignItems:'center'}}>
            {['1','2','3','4','5'].map(n=>(
              <code key={n} style={{background:'#f0f4f8',padding:'2px 8px',borderRadius:'5px',color:acc,fontSize:'11px',border:`1px solid ${bdr}`,fontWeight:700}}>!투표{n}</code>
            ))}
          </div>
        </div>
      )}

      {/* ── 내전 탭 ── */}
      {tab==='inhouse' && (
        <iframe src="/inhouse.html" style={{width:'100%',height:'calc(100vh - 49px)',border:'none',display:'block'}} title="내전 진행"/>
      )}

      {/* ── 투표 탭 ── */}
      {tab==='vote' && (
        <div style={{flex:1,overflow:'auto',padding:'20px 28px'}}>
          <div style={{display:'grid',gridTemplateColumns:'290px 1fr',gap:'16px',alignItems:'start',maxWidth:'1200px',margin:'0 auto'}}>

            {/* 왼쪽 */}
            <div>
              <div style={S.card()}>
                <div style={{fontWeight:700,color:txt,marginBottom:'16px',fontSize:'14px',display:'flex',alignItems:'center',gap:'8px'}}>
                  <span style={{fontSize:'16px'}}>📊</span> 투표 설정
                </div>
                <div style={{marginBottom:'12px'}}>
                  <label style={S.label()}>제목</label>
                  <input style={S.inp()} value={voteTitle} onChange={e=>setVoteTitle(e.target.value)}/>
                </div>
                <div style={{marginBottom:'14px'}}>
                  <label style={S.label()}>항목 <span style={{textTransform:'none',color:'#b0c0d0',fontWeight:400,letterSpacing:0}}>(한 줄에 하나)</span></label>
                  <textarea style={{...S.inp(),height:'105px',resize:'vertical',lineHeight:'1.9'}}
                    value={voteItemsText} onChange={e=>setVoteItemsText(e.target.value)}/>
                </div>
                <div style={{display:'flex',gap:'8px'}}>
                  {!vote.active
                    ? <button style={{...S.btn(),flex:1,padding:'9px 0'}}
                        onClick={()=>api('start_vote',{title:voteTitle,items:voteItemsText.split('\n').filter(i=>i.trim())})}>
                        ▶ 투표 시작
                      </button>
                    : <button style={{...S.btn('#e03020'),flex:1,padding:'9px 0'}}
                        onClick={()=>api('end_vote')}>
                        ■ 투표 종료
                      </button>
                  }
                  <button style={S.btn('#fff','#e03020',true)} onClick={()=>api('reset_vote')}>초기화</button>
                </div>
                {!vote.active&&vote.items.length>0&&(
                  <button style={{...S.btn('#7b2fbe'),marginTop:'10px',width:'100%',padding:'8px 0'}}
                    onClick={()=>{api('vote_to_roulette');setShowRoulette(true)}}>
                    🎡 룰렛으로 넘기기
                  </button>
                )}
              </div>

              {/* 채팅 */}
              <div style={S.card({padding:'16px 18px'})}>
                <div style={{fontWeight:600,color:txt,marginBottom:'10px',fontSize:'13px',display:'flex',alignItems:'center',gap:'7px'}}>
                  <span style={{width:'6px',height:'6px',borderRadius:'50%',
                    background:chzzkConnected?'#22c55e':'#cbd5e0',display:'inline-block',flexShrink:0}}/>
                  실시간 채팅
                </div>
                <div style={{height:'200px',overflowY:'auto',fontSize:'12px',lineHeight:'1.75'}}>
                  {!chzzkConnected
                    ? <div style={{color:'#b0c0d0',textAlign:'center',padding:'28px 0'}}>채널을 연결하세요</div>
                    : chatLog.length===0
                      ? <div style={{color:'#b0c0d0',textAlign:'center',padding:'28px 0'}}>채팅 대기 중...</div>
                      : chatLog.map((c,i)=>(
                          <div key={i} style={{padding:'3px 0',borderBottom:`1px solid ${bdr}`}}>
                            <span style={{color:c.text.startsWith('!투표')?acc:'#4a7abf',marginRight:'6px',fontWeight:600,fontSize:'11px'}}>{c.nickname}</span>
                            <span style={{color:c.text.startsWith('!투표')?'#22c55e':txt,fontSize:'12px'}}>{c.text}</span>
                          </div>
                        ))
                  }
                  <div ref={chatEndRef}/>
                </div>
              </div>
            </div>

            {/* 오른쪽: 투표 결과 - 방송화면 최적화 */}
            <div style={S.card({padding:'24px 28px'})}>
              {/* 헤더 */}
              <div style={{display:'flex',alignItems:'center',gap:'12px',marginBottom:'24px'}}>
                <div style={{fontWeight:800,fontSize:'22px',color:txt,letterSpacing:'-.3px'}}>{vote.title||'투표 결과'}</div>
                {vote.active&&(
                  <span style={{fontSize:'12px',padding:'4px 12px',borderRadius:'20px',
                    background:'rgba(34,197,94,.1)',color:'#16a34a',
                    border:'1px solid rgba(34,197,94,.3)',fontWeight:700,
                    display:'flex',alignItems:'center',gap:'5px'}}>
                    <span style={{width:'6px',height:'6px',borderRadius:'50%',background:'#22c55e',display:'inline-block'}}/>
                    진행 중
                  </span>
                )}
                <span style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:'16px'}}>
                  {vote.active&&(
                    <span style={{
                      fontSize:'24px',fontWeight:800,color:acc,
                      fontFamily:"'Pretendard','Noto Sans KR',sans-serif",
                      fontVariantNumeric:'tabular-nums',letterSpacing:'1px',
                      background:`${acc}12`,border:`1px solid ${acc}30`,
                      borderRadius:'8px',padding:'4px 16px',
                    }}>{fmtTime(elapsed)}</span>
                  )}
                  <span style={{fontSize:'15px',color:txt2}}>총 <b style={{color:txt,fontSize:'18px'}}>{total}</b>표</span>
                </span>
              </div>

              {vote.items.length===0 ? (
                <div style={{textAlign:'center',padding:'80px 0',color:'#b0c0d0'}}>
                  <div style={{fontSize:'48px',marginBottom:'16px',opacity:.3}}>📊</div>
                  <div style={{fontSize:'16px'}}>투표를 시작하면 실시간으로 표시됩니다</div>
                </div>
              ) : vote.items.map((item,i)=>{
                const pct = total>0 ? Math.round(item.votes.length/total*100) : 0
                const isExpanded = expandedIdx===i
                return (
                  <div key={i} style={{
                    marginBottom:'12px',
                    background: isExpanded ? `${item.color}08` : '#f8fafc',
                    border:`2px solid ${isExpanded?item.color+'66':bdr}`,
                    borderRadius:'14px',overflow:'hidden',transition:'all .2s',
                  }}>
                    {/* 메인 행 */}
                    <div onClick={()=>setExpandedIdx(isExpanded?null:i)}
                      style={{padding:'16px 20px',cursor:'pointer',userSelect:'none'}}
                      onMouseEnter={e=>(e.currentTarget.style.background=`${item.color}06`)}
                      onMouseLeave={e=>(e.currentTarget.style.background='transparent')}>

                      {/* 상단: 명령어 + 이름 + 퍼센트 */}
                      <div style={{display:'flex',alignItems:'center',gap:'14px',marginBottom:'10px'}}>
                        <span style={{
                          fontSize:'12px',padding:'3px 11px',borderRadius:'6px',
                          background:`${item.color}12`,color:item.color,
                          border:`1px solid ${item.color}35`,fontWeight:700,
                          letterSpacing:'.3px',flexShrink:0,
                          fontFamily:"'Pretendard','Noto Sans KR',sans-serif",
                        }}>!투표{i+1}</span>
                        <span style={{
                          fontSize:'22px',fontWeight:800,color:txt,
                          flex:1,letterSpacing:'-.3px',
                        }}>{item.label}</span>
                        <div style={{display:'flex',alignItems:'baseline',gap:'6px',flexShrink:0}}>
                          <span style={{
                            fontSize:'36px',fontWeight:900,color:item.color,
                            lineHeight:1,letterSpacing:'-1px',
                          }}>{pct}%</span>
                          <span style={{fontSize:'14px',color:txt2,fontWeight:500}}>{item.votes.length}표</span>
                        </div>
                        <span style={{fontSize:'12px',color:txt2,transition:'transform .2s',
                          transform:isExpanded?'rotate(180deg)':'none',flexShrink:0}}>▼</span>
                      </div>

                      {/* 진행 바 */}
                      <div style={{height:'14px',background:'#e2e8f0',borderRadius:'7px',overflow:'hidden'}}>
                        <div style={{
                          height:'100%',width:`${pct}%`,
                          background:`linear-gradient(90deg, ${item.color}cc, ${item.color})`,
                          borderRadius:'7px',transition:'width .6s ease',
                          boxShadow:`0 2px 8px ${item.color}44`,
                        }}/>
                      </div>
                    </div>

                    {/* 펼쳐진 투표자 목록 */}
                    {isExpanded&&(
                      <div style={{padding:'12px 20px 16px',borderTop:`1px solid ${item.color}22`,background:`${item.color}05`}}>
                        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'10px'}}>
                          <div style={{fontSize:'12px',color:txt2,fontWeight:600,letterSpacing:'.5px',textTransform:'uppercase' as const}}>
                            투표자 {item.votes.length}명
                          </div>
                          {item.votes.length>0&&(
                            <button
                              onClick={e=>{e.stopPropagation();drawItem(i)}}
                              disabled={drawingIdx===i}
                              style={{
                                padding:'5px 14px',borderRadius:'7px',border:`1.5px solid ${item.color}`,
                                background:`${item.color}15`,color:item.color,
                                fontSize:'13px',fontWeight:700,cursor:'pointer',
                                fontFamily:'inherit',transition:'all .15s',
                                opacity:drawingIdx===i?0.6:1,
                              }}>
                              {drawingIdx===i?'추첨 중...':'🎲 추첨하기'}
                            </button>
                          )}
                        </div>
                        {item.votes.length===0
                          ? <div style={{fontSize:'13px',color:'#b0c0d0',fontStyle:'italic'}}>아직 없습니다</div>
                          : <div style={{display:'flex',flexWrap:'wrap',gap:'6px'}}>
                              {item.votes.map((nick,j)=>(
                                <span key={j} style={{
                                  fontSize:'13px',padding:'4px 12px',borderRadius:'20px',
                                  background:`${item.color}15`,color:item.color,
                                  border:`1px solid ${item.color}44`,fontWeight:600,
                                }}>{nick}</span>
                              ))}
                            </div>
                        }
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* 슬롯머신 추첨 모달 */}
          {(drawingIdx!==null||drawWinner!==null)&&(
            <div style={{
              position:'fixed',inset:0,zIndex:1000,
              background:'rgba(0,0,0,.5)',backdropFilter:'blur(4px)',
              display:'flex',alignItems:'center',justifyContent:'center',
            }} onClick={()=>{if(!drawingIdx)setDrawWinner(null)}}>
              <div style={{
                background:'#fff',borderRadius:'20px',padding:'40px 52px',
                textAlign:'center',minWidth:'380px',
                boxShadow:'0 24px 80px rgba(0,0,0,.25)',
                border:`2px solid ${drawWinner?vote.items[drawWinner.idx]?.color||acc:acc}`,
              }} onClick={e=>e.stopPropagation()}>
                <div style={{fontSize:'13px',color:txt2,letterSpacing:'2px',textTransform:'uppercase',marginBottom:'8px'}}>
                  {drawingIdx!==null
                    ? `${vote.items[drawingIdx]?.label} — 추첨 중`
                    : drawWinner ? `${vote.items[drawWinner.idx]?.label} — 당첨자` : ''
                  }
                </div>

                {/* 슬롯 디스플레이 */}
                <div style={{
                  background:'#f5f7fa',border:`2px solid ${bdr}`,
                  borderRadius:'14px',padding:'28px 20px',
                  margin:'16px 0 24px',minHeight:'100px',
                  display:'flex',alignItems:'center',justifyContent:'center',
                  overflow:'hidden',position:'relative',
                }}>
                  {/* 상하 그라데이션 마스크 */}
                  <div style={{position:'absolute',top:0,left:0,right:0,height:'30px',
                    background:'linear-gradient(to bottom,#f5f7fa,transparent)',zIndex:1,pointerEvents:'none'}}/>
                  <div style={{position:'absolute',bottom:0,left:0,right:0,height:'30px',
                    background:'linear-gradient(to top,#f5f7fa,transparent)',zIndex:1,pointerEvents:'none'}}/>

                  {drawingIdx!==null ? (
                    // 슬롯 돌아가는 중
                    <div style={{display:'flex',flexDirection:'column',gap:'4px',alignItems:'center'}}>
                      {slotNames.map((name,idx)=>(
                        <div key={idx} style={{
                          fontSize: idx===1 ? '24px' : '16px',
                          fontWeight: idx===1 ? 800 : 500,
                          color: idx===1 ? acc : '#b0c0d0',
                          opacity: idx===1 ? 1 : 0.5,
                          transition:'all .05s',
                          letterSpacing:'.5px',
                        }}>{name}</div>
                      ))}
                    </div>
                  ) : drawWinner ? (
                    // 당첨자 확정
                    <div style={{
                      fontSize:'28px',fontWeight:800,
                      color:vote.items[drawWinner.idx]?.color||acc,
                      letterSpacing:'1px',
                      animation:'popIn .3s ease',
                    }}>{drawWinner.name}</div>
                  ) : null}
                </div>

                {drawWinner&&(
                  <>
                    <div style={{fontSize:'14px',color:txt2,marginBottom:'20px'}}>
                      🎉 <b style={{color:txt}}>{vote.items[drawWinner.idx]?.label}</b> 투표자 중 당첨!
                    </div>
                    <button
                      onClick={()=>setDrawWinner(null)}
                      style={{...S.btn(),padding:'10px 36px',fontSize:'14px',borderRadius:'8px'}}>
                      확인
                    </button>
                  </>
                )}

                {drawingIdx!==null&&(
                  <div style={{display:'flex',justifyContent:'center',gap:'6px',marginTop:'8px'}}>
                    {[0,1,2].map(d=>(
                      <div key={d} style={{
                        width:'8px',height:'8px',borderRadius:'50%',background:acc,
                        animation:`bounce 0.6s ease ${d*0.15}s infinite`,
                      }}/>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 룰렛 */}
          {showRoulette&&(
            <div style={{maxWidth:'1200px',margin:'16px auto 0',display:'grid',gridTemplateColumns:'380px 1fr',gap:'16px',alignItems:'start'}}>
              <div style={S.card({textAlign:'center'})}>
                <div style={{fontWeight:700,color:acc,marginBottom:'16px',fontSize:'15px'}}>🎡 룰렛</div>
                <canvas ref={canvasRef} width={320} height={320} style={{maxWidth:'100%',display:'block',margin:'0 auto',borderRadius:'50%',border:`2px solid ${bdr}`}}/>
                <button style={{...S.btn(),fontSize:'14px',padding:'11px 44px',marginTop:'16px',
                  opacity:spinning||!activeRouletteItems.length?0.45:1,borderRadius:'8px'}}
                  onClick={spin} disabled={spinning||!activeRouletteItems.length}>
                  {spinning?'돌아가는 중...':'🎡 돌리기'}
                </button>
                <div style={{marginTop:'14px',display:'flex',alignItems:'center',justifyContent:'center',gap:'8px'}}>
                  <label style={{display:'flex',alignItems:'center',gap:'6px',cursor:'pointer',fontSize:'12px',color:txt2,userSelect:'none'}}>
                    <input type="checkbox" checked={excludeEnabled}
                      onChange={e=>setExcludeEnabled(e.target.checked)}
                      style={{accentColor:'#22c55e',width:'14px',height:'14px'}}/>
                    이미 뽑힌 참여자 제외하기
                  </label>
                </div>
                {excludedWinners.length>0&&(
                  <div style={{marginTop:'12px',padding:'10px 14px',background:'#f8fafc',borderRadius:'8px',border:`1px solid ${bdr}`,textAlign:'left'}}>
                    <div style={{fontSize:'10px',color:txt2,marginBottom:'7px',letterSpacing:'.6px',textTransform:'uppercase'}}>제외됨 ({excludedWinners.length}명)</div>
                    <div style={{display:'flex',flexWrap:'wrap',gap:'5px'}}>
                      {excludedWinners.map((w,i)=>(
                        <span key={i} onClick={()=>removeExcluded(w)} title="클릭하여 제외 해제"
                          style={{fontSize:'12px',padding:'3px 8px 3px 10px',borderRadius:'20px',
                            background:'rgba(224,48,32,.08)',color:'#e03020',
                            border:'1px solid rgba(224,48,32,.2)',cursor:'pointer',
                            display:'flex',alignItems:'center',gap:'5px',userSelect:'none'}}
                          onMouseEnter={e=>(e.currentTarget.style.background='rgba(224,48,32,.15)')}
                          onMouseLeave={e=>(e.currentTarget.style.background='rgba(224,48,32,.08)')}>
                          {w} <span style={{fontSize:'10px',opacity:.6}}>✕</span>
                        </span>
                      ))}
                    </div>
                    <button onClick={()=>setExcludedWinners([])}
                      style={{...S.btn('#fff',txt2,true),marginTop:'10px',width:'100%',padding:'6px 0',fontSize:'12px'}}>
                      전체 해제
                    </button>
                  </div>
                )}
                {winner&&(
                  <div style={{marginTop:'14px',padding:'16px',background:`${acc}10`,border:`1px solid ${acc}30`,borderRadius:'8px'}}>
                    <div style={{fontSize:'11px',color:acc,marginBottom:'6px',letterSpacing:'.5px'}}>🎉 당첨</div>
                    <div style={{fontSize:'28px',fontWeight:700,color:acc}}>{winner}</div>
                  </div>
                )}
              </div>
              <div style={S.card()}>
                <div style={{fontWeight:700,color:txt,marginBottom:'14px',fontSize:'14px'}}>항목 설정</div>
                <div style={{display:'flex',gap:'8px',marginBottom:'14px',flexWrap:'wrap'}}>
                  <input style={{...S.inp(),flex:1,minWidth:'100px'}} placeholder="항목명" value={rInput}
                    onChange={e=>setRInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addRouletteItem()}/>
                  <div style={{display:'flex',alignItems:'center',gap:'6px',flexShrink:0}}>
                    <span style={{fontSize:'11px',color:txt2}}>가중치</span>
                    <input style={{...S.inp('52px'),textAlign:'center'}} type="number" min="1"
                      value={rWeight} onChange={e=>setRWeight(e.target.value)}/>
                  </div>
                  <button style={S.btn()} onClick={addRouletteItem}>추가</button>
                </div>
                <div style={{maxHeight:'260px',overflowY:'auto',marginBottom:'14px'}}>
                  {rouletteItems.length===0
                    ? <div style={{textAlign:'center',padding:'24px 0',color:'#b0c0d0',fontSize:'13px'}}>항목이 없습니다</div>
                    : rouletteItems.map((item,i)=>{
                        const t=rouletteItems.reduce((s,it)=>s+(it.weight||1),0)
                        const excluded=excludeEnabled&&excludedWinners.includes(item.label)
                        return (
                          <div key={i} style={{
                            display:'flex',alignItems:'center',gap:'8px',
                            padding:'9px 10px',borderRadius:'7px',marginBottom:'4px',
                            background:excluded?'rgba(224,48,32,.04)':'#f8fafc',
                            border:`1px solid ${excluded?'rgba(224,48,32,.15)':bdr}`,
                            opacity:excluded?0.6:1,transition:'all .15s',
                          }}>
                            <div style={{width:'9px',height:'9px',borderRadius:'3px',background:item.color,flexShrink:0}}/>
                            <span style={{flex:1,fontSize:'13px',color:excluded?'#e03020':txt,textDecoration:excluded?'line-through':'none'}}>{item.label}</span>
                            {excluded&&<span style={{fontSize:'10px',color:'#e03020',opacity:.7}}>제외됨</span>}
                            <span style={{fontSize:'11px',color:txt2}}>{item.weight}w · {Math.round((item.weight||1)/t*100)}%</span>
                            <button style={{background:'none',border:'none',color:'#b0c0d0',cursor:'pointer',fontSize:'15px',padding:'0 2px'}} onClick={()=>removeRouletteItem(i)}>✕</button>
                          </div>
                        )
                      })
                  }
                </div>
                <div style={{display:'flex',gap:'8px',flexWrap:'wrap',borderTop:`1px solid ${bdr}`,paddingTop:'14px'}}>
                  <button style={S.btn('#7b2fbe')} onClick={async()=>{
                    await api('vote_to_roulette')
                    const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'get_state'})})
                    const data=await r.json()
                    if(data.roulette?.items) setRouletteItems(data.roulette.items)
                  }}>← 투표 결과 갱신</button>
                  <button style={S.btn('#fff',txt2,true)} onClick={()=>{setRouletteItems([]);api('set_roulette',{items:[]})}}>전체 삭제</button>
                  <button style={{...S.btn('#fff',txt2,true),marginLeft:'auto'}} onClick={()=>setShowRoulette(false)}>닫기</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 음악 플레이어 탭 ── */}
      {(tab as string)==='music' && (
        <div style={{display:'flex',flexDirection:'column',height:'calc(100vh - 49px)',overflow:'hidden',background:bg}}>

          {/* YouTube IFrame (숨김 - 탭 바꿔도 재생 유지) */}
          <div style={{display:'none'}}>
            <div id="yt-player-container"/>
          </div>

          <div style={{flex:1,overflow:'auto',padding:'20px 28px'}}>
            <div style={{display:'grid',gridTemplateColumns:'360px 1fr',gap:'16px',maxWidth:'1200px',margin:'0 auto',alignItems:'start'}}>

              {/* 왼쪽: 현재 재생 중 + 컨트롤 */}
              <div>
                <div style={S.card()}>
                  <div style={{fontWeight:700,fontSize:'14px',color:txt,marginBottom:'16px',display:'flex',alignItems:'center',gap:'8px'}}>
                    <span>🎵</span> 현재 재생 중
                  </div>

                  {music.queue.length===0 ? (
                    <div style={{textAlign:'center',padding:'32px 0',color:'#b0c0d0'}}>
                      <div style={{fontSize:'36px',marginBottom:'8px',opacity:.3}}>🎵</div>
                      <div style={{fontSize:'13px'}}>신청곡이 없습니다</div>
                      <div style={{fontSize:'12px',marginTop:'4px',opacity:.6}}>채팅에서 !신청곡 노래제목</div>
                    </div>
                  ) : (()=>{
                    const cur = music.queue[music.currentIdx]
                    return cur ? (
                      <div>
                        <img src={cur.thumbnail} alt={cur.title}
                          style={{width:'100%',borderRadius:'10px',marginBottom:'12px',aspectRatio:'16/9',objectFit:'cover'}}/>
                        <div style={{fontSize:'15px',fontWeight:700,color:txt,lineHeight:1.4,marginBottom:'4px'}}>{cur.title}</div>
                        <div style={{fontSize:'12px',color:txt2,marginBottom:'2px'}}>{cur.channel}</div>
                        <div style={{fontSize:'12px',color:acc,fontWeight:600}}>신청: {cur.requestedBy}</div>
                      </div>
                    ) : null
                  })()}

                  {/* 컨트롤 버튼 */}
                  {music.queue.length>0&&(
                    <div style={{display:'flex',justifyContent:'center',gap:'10px',marginTop:'16px',alignItems:'center'}}>
                      <button onClick={()=>api('music_prev')}
                        style={{background:'none',border:`1px solid ${bdr}`,borderRadius:'50%',width:'40px',height:'40px',
                          cursor:'pointer',fontSize:'16px',color:txt,display:'flex',alignItems:'center',justifyContent:'center'}}>⏮</button>
                      <button onClick={()=>api('music_set_playing',{playing:!music.playing})}
                        style={{background:acc,border:'none',borderRadius:'50%',width:'52px',height:'52px',
                          cursor:'pointer',fontSize:'20px',color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',
                          boxShadow:`0 4px 12px ${acc}44`}}>
                        {music.playing?'⏸':'▶'}
                      </button>
                      <button onClick={()=>api('music_next')}
                        style={{background:'none',border:`1px solid ${bdr}`,borderRadius:'50%',width:'40px',height:'40px',
                          cursor:'pointer',fontSize:'16px',color:txt,display:'flex',alignItems:'center',justifyContent:'center'}}>⏭</button>
                    </div>
                  )}
                </div>

                {/* 수동 검색 추가 */}
                <div style={S.card()}>
                  <div style={{fontWeight:700,fontSize:'13px',color:txt,marginBottom:'12px'}}>🔍 직접 추가</div>
                  <div style={{display:'flex',gap:'8px'}}>
                    <input style={{...S.inp(),flex:1}} placeholder="노래 제목 검색..."
                      value={manualSearch} onChange={e=>setManualSearch(e.target.value)}
                      onKeyDown={async e=>{
                        if(e.key==='Enter'&&manualSearch.trim()){
                          setSearching(true)
                          await api('music_manual_add',{query:manualSearch.trim(),requestedBy:'방장'})
                          setManualSearch(''); setSearching(false)
                        }
                      }}/>
                    <button style={{...S.btn(),padding:'8px 14px',opacity:searching?0.5:1}}
                      disabled={searching}
                      onClick={async()=>{
                        if(!manualSearch.trim()) return
                        setSearching(true)
                        await api('music_manual_add',{query:manualSearch.trim(),requestedBy:'방장'})
                        setManualSearch(''); setSearching(false)
                      }}>
                      {searching?'검색 중...':'추가'}
                    </button>
                  </div>
                  <div style={{fontSize:'11px',color:txt2,marginTop:'8px'}}>
                    채팅 명령어: <code style={{background:'#f0f4f8',padding:'1px 6px',borderRadius:'4px',color:acc,fontWeight:700}}>!신청곡 노래제목</code>
                  </div>
                </div>
              </div>

              {/* 오른쪽: 대기열 */}
              <div style={S.card()}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'16px'}}>
                  <div style={{fontWeight:700,fontSize:'14px',color:txt,display:'flex',alignItems:'center',gap:'8px'}}>
                    <span>📋</span> 신청곡 대기열
                    <span style={{fontSize:'12px',fontWeight:500,color:txt2}}>({music.queue.length}곡)</span>
                  </div>
                  {music.queue.length>0&&(
                    <button style={{...S.btn('#fff','#e03020',true),padding:'5px 12px',fontSize:'12px'}}
                      onClick={()=>{if(confirm('대기열을 전부 삭제할까요?'))api('music_clear')}}>전체 삭제</button>
                  )}
                </div>

                {music.queue.length===0 ? (
                  <div style={{textAlign:'center',padding:'60px 0',color:'#b0c0d0'}}>
                    <div style={{fontSize:'40px',marginBottom:'12px',opacity:.3}}>🎵</div>
                    <div style={{fontSize:'14px'}}>신청곡이 없습니다</div>
                    <div style={{fontSize:'12px',marginTop:'6px',opacity:.6}}>시청자가 !신청곡 명령어로 추가할 수 있어요</div>
                  </div>
                ) : (
                  <div style={{display:'flex',flexDirection:'column',gap:'8px'}}>
                    {music.queue.map((track,i)=>{
                      const isCurrent = i===music.currentIdx
                      return (
                        <div key={i} style={{
                          display:'flex',gap:'12px',padding:'10px 12px',
                          borderRadius:'10px',alignItems:'center',
                          background: isCurrent ? `${acc}10` : '#f8fafc',
                          border: `1.5px solid ${isCurrent ? acc+'50' : bdr}`,
                          transition:'all .15s',cursor:'pointer',
                        }} onClick={()=>api('music_play_idx',{idx:i})}>
                          <div style={{position:'relative',flexShrink:0}}>
                            <img src={track.thumbnail} alt={track.title}
                              style={{width:'72px',height:'50px',objectFit:'cover',borderRadius:'6px'}}/>
                            {isCurrent&&(
                              <div style={{position:'absolute',inset:0,background:'rgba(0,0,0,.4)',borderRadius:'6px',
                                display:'flex',alignItems:'center',justifyContent:'center',fontSize:'18px'}}>
                                {music.playing?'🔊':'⏸'}
                              </div>
                            )}
                            <div style={{position:'absolute',top:2,left:2,background:'rgba(0,0,0,.6)',
                              color:'#fff',fontSize:'10px',fontWeight:700,padding:'1px 5px',borderRadius:'3px'}}>
                              {i+1}
                            </div>
                          </div>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:'13px',fontWeight:isCurrent?700:500,color:isCurrent?acc:txt,
                              overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginBottom:'3px'}}>{track.title}</div>
                            <div style={{fontSize:'11px',color:txt2,marginBottom:'2px'}}>{track.channel}</div>
                            <div style={{fontSize:'11px',color:acc,fontWeight:600}}>🙋 {track.requestedBy}</div>
                          </div>
                          <button onClick={e=>{e.stopPropagation();api('music_remove',{idx:i})}}
                            style={{background:'none',border:'none',color:'#b0c0d0',cursor:'pointer',
                              fontSize:'16px',padding:'4px',flexShrink:0,lineHeight:1}}
                            onMouseEnter={e=>(e.currentTarget.style.color='#e03020')}
                            onMouseLeave={e=>(e.currentTarget.style.color='#b0c0d0')}>✕</button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

            <style>{`
        @import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body, button, input, textarea, select { font-family: 'Pretendard', 'Noto Sans KR', sans-serif !important; }
        @keyframes popIn { 0%{transform:scale(0.5);opacity:0} 70%{transform:scale(1.1)} 100%{transform:scale(1);opacity:1} }
        @keyframes bounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6px)} }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #dde3ec; border-radius: 2px; }
        ::-webkit-scrollbar-thumb:hover { background: #c8d3e0; }
        input:focus, textarea:focus { border-color: #a0b8d0 !important; box-shadow: 0 0 0 3px rgba(212,144,10,.1); }
        button:active { opacity: 0.8; }
      `}</style>
    </div>
  )
}
