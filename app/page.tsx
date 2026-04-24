'use client'
import { useEffect, useRef, useState } from 'react'

const COLORS = ['#4285f4','#ea4335','#34a853','#fbbc04','#9c27b0','#00bcd4','#ff5722','#607d8b']
const PASSWORD = '09870987'

interface VoteItem { label: string; votes: string[]; color: string }
interface Vote { active: boolean; title: string; items: VoteItem[]; startedAt: number | null }
interface RouletteItem { label: string; weight: number; color: string }

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
  const [rouletteItems, setRouletteItems] = useState<RouletteItem[]>([])
  const [excludedWinners, setExcludedWinners] = useState<string[]>([])
  const [excludeEnabled, setExcludeEnabled]   = useState(true)
  const [rInput, setRInput]   = useState('')
  const [rWeight, setRWeight] = useState('1')
  const [spinning, setSpinning] = useState(false)
  const [winner, setWinner]     = useState<string|null>(null)
  const [angle, setAngle]       = useState(0)
  const [expandedIdx, setExpandedIdx] = useState<number|null>(null)
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const animRef    = useRef<number>()
  const chatEndRef = useRef<HTMLDivElement>(null)

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
        }
      } catch {}
    }
    return () => es.close()
  }, [auth])

  // 제외 목록 반영한 실제 룰렛 항목
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
      ctx.fillStyle='#131a24'; ctx.fill()
      ctx.fillStyle='#5a7a9a'; ctx.font='14px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle'
      ctx.fillText('항목을 추가하세요', cx, cy); return
    }
    const total = items.reduce((s,i)=>s+(i.weight||1),0)
    let a = rot*Math.PI/180
    items.forEach((item,i)=>{
      const slice=(item.weight||1)/total*Math.PI*2
      ctx.beginPath(); ctx.moveTo(cx,cy)
      ctx.arc(cx,cy,r,a,a+slice); ctx.closePath()
      ctx.fillStyle=item.color||COLORS[i%COLORS.length]; ctx.fill()
      ctx.strokeStyle='#07090f'; ctx.lineWidth=2; ctx.stroke()
      const mid=a+slice/2
      ctx.save(); ctx.translate(cx+r*.62*Math.cos(mid),cy+r*.62*Math.sin(mid))
      ctx.rotate(mid+Math.PI/2); ctx.fillStyle='#fff'
      ctx.font='bold 12px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle'
      ctx.fillText(item.label.length>7?item.label.slice(0,7)+'…':item.label,0,0)
      ctx.restore(); a+=slice
    })
    ctx.beginPath(); ctx.arc(cx,cy,18,0,Math.PI*2)
    ctx.fillStyle='#07090f'; ctx.fill()
    ctx.strokeStyle='#e8b84b'; ctx.lineWidth=3; ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx-10,cy-r+4); ctx.lineTo(cx+10,cy-r+4); ctx.lineTo(cx,cy-r+22)
    ctx.closePath(); ctx.fillStyle='#e8b84b'; ctx.fill()
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
        setWinner(winLabel)
        setAngle(cur%360)
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
  function removeExcluded(label:string) {
    setExcludedWinners(p=>p.filter(w=>w!==label))
  }

  // ── 공통 스타일 ──
  const S = {
    inp: (w='100%',extra:React.CSSProperties={}): React.CSSProperties => ({
      background:'#111820', border:'1px solid #1f2d42', color:'#c8d8ec',
      borderRadius:'6px', padding:'8px 12px', fontSize:'13px',
      fontFamily:'inherit', outline:'none', width:w,
      boxSizing:'border-box' as const, transition:'border-color .15s', ...extra,
    }),
    card: (extra:React.CSSProperties={}): React.CSSProperties => ({
      background:'#0d1117', border:'1px solid #1c2a3a',
      borderRadius:'10px', padding:'18px 20px', marginBottom:'12px', ...extra,
    }),
    btn: (bg='#e8b84b',fg='#0d1117',ghost=false): React.CSSProperties => ({
      padding:'8px 18px', borderRadius:'6px',
      border: ghost ? `1px solid ${bg}40` : 'none',
      background: ghost ? 'transparent' : bg,
      color: ghost ? bg : fg,
      cursor:'pointer', fontSize:'13px', fontWeight:600,
      fontFamily:'inherit', whiteSpace:'nowrap' as const, transition:'opacity .15s',
    }),
    label: (extra:React.CSSProperties={}): React.CSSProperties => ({
      fontSize:'11px', color:'#5a7a9a', marginBottom:'5px',
      letterSpacing:'.6px', textTransform:'uppercase' as const, display:'block', ...extra,
    }),
  }

  // ── 비밀번호 화면 ──
  if (!auth) return (
    <div style={{minHeight:'100vh',background:'#07090f',display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'\'Noto Sans KR\',sans-serif'}}>
      <div style={{background:'#0d1117',border:'1px solid #1c2a3a',borderRadius:'14px',padding:'52px',textAlign:'center',width:'360px',boxShadow:'0 24px 64px rgba(0,0,0,.7)'}}>
        <div style={{fontSize:'13px',color:'#5a7a9a',letterSpacing:'3px',textTransform:'uppercase',marginBottom:'10px'}}>DAVIDO</div>
        <div style={{fontSize:'26px',fontWeight:700,color:'#e8b84b',marginBottom:'4px'}}>⚔ 다비도의 내전</div>
        <div style={{fontSize:'13px',color:'#3a5068',marginBottom:'32px'}}>관리자 전용</div>
        <input type="password" value={pwInput} autoFocus
          onChange={e=>{setPwInput(e.target.value);setPwError(false)}}
          onKeyDown={e=>{if(e.key==='Enter'){if(pwInput===PASSWORD)setAuth(true);else setPwError(true)}}}
          placeholder="비밀번호"
          style={{...S.inp(),marginBottom:'8px',fontSize:'14px',padding:'11px 14px',
            border:`1px solid ${pwError?'#ea4335':'#1f2d42'}`}}
        />
        {pwError&&<div style={{fontSize:'12px',color:'#ea4335',marginBottom:'8px'}}>비밀번호가 틀렸습니다</div>}
        <button onClick={()=>{if(pwInput===PASSWORD)setAuth(true);else setPwError(true)}}
          style={{width:'100%',padding:'12px',borderRadius:'7px',border:'none',
            background:'#e8b84b',color:'#0d1117',fontWeight:700,fontSize:'14px',
            fontFamily:'inherit',cursor:'pointer',marginTop:'4px'}}>
          입장하기
        </button>
      </div>
    </div>
  )

  const total = vote.items.reduce((s,i)=>s+i.votes.length,0)

  return (
    <div style={{fontFamily:'\'Noto Sans KR\',sans-serif',minHeight:'100vh',background:'#07090f',color:'#c8d8ec'}}>

      {/* ── 헤더 ── */}
      <div style={{background:'#0a0f16',borderBottom:'1px solid #1c2a3a',padding:'0 28px',display:'flex',alignItems:'stretch',position:'sticky',top:0,zIndex:200}}>
        <div style={{fontSize:'15px',fontWeight:700,color:'#e8b84b',display:'flex',alignItems:'center',gap:'8px',marginRight:'28px',letterSpacing:'.5px'}}>
          ⚔ <span>다비도의 내전</span>
        </div>
        {(['inhouse','vote'] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{
            padding:'0 22px', border:'none',
            borderBottom: tab===t ? '2px solid #e8b84b' : '2px solid transparent',
            borderTop: '2px solid transparent',
            background:'none', color: tab===t ? '#e8b84b' : '#4a6a8a',
            cursor:'pointer', fontSize:'13px', fontFamily:'inherit',
            fontWeight: tab===t ? 700 : 400, transition:'all .15s',
          }}>
            {t==='inhouse' ? '⚔ 내전 진행' : '📊 채팅 투표'}
          </button>
        ))}
      </div>

      {/* ── 내전 탭 ── */}
      {tab==='inhouse' && (
        <iframe src="/inhouse.html" style={{width:'100%',height:'calc(100vh - 49px)',border:'none',display:'block'}} title="내전 진행"/>
      )}

      {/* ── 투표 탭 ── */}
      {tab==='vote' && (
        <div style={{display:'flex',flexDirection:'column',height:'calc(100vh - 49px)',overflow:'hidden'}}>

          {/* 치지직 연결 바 */}
          <div style={{background:'#0a0f16',borderBottom:'1px solid #1c2a3a',padding:'8px 28px',display:'flex',alignItems:'center',gap:'12px',flexWrap:'wrap',flexShrink:0}}>
            <div style={{display:'flex',alignItems:'center',gap:'7px'}}>
              <div style={{width:'7px',height:'7px',borderRadius:'50%',
                background:chzzkConnected?'#34a853':'#3a5068',
                boxShadow:chzzkConnected?'0 0 8px #34a853':'none',
                transition:'all .3s'}}/>
              <span style={{fontSize:'12px',color:'#4a6a8a',fontWeight:500}}>치지직</span>
            </div>
            {chzzkConnected ? <>
              <span style={{fontSize:'12px',color:'#34a853',fontWeight:600}}>{channelId.slice(0,24)}...</span>
              <button style={{...S.btn('#ea4335','#fff'),padding:'5px 12px',fontSize:'12px'}} onClick={()=>api('disconnect_chzzk')}>해제</button>
            </> : <>
              <input style={{...S.inp('220px'),padding:'5px 10px',fontSize:'12px'}}
                placeholder="채널 ID" value={inputCid}
                onChange={e=>setInputCid(e.target.value)}
                onKeyDown={e=>e.key==='Enter'&&api('connect_chzzk',{channelId:inputCid})}/>
              <button style={{...S.btn(),padding:'5px 14px',fontSize:'12px'}}
                onClick={()=>api('connect_chzzk',{channelId:inputCid})}>연결</button>
              <span style={{fontSize:'11px',color:'#3a5068'}}>chzzk.naver.com/<b style={{color:'#e8b84b'}}>채널ID</b></span>
            </>}
            <div style={{marginLeft:'auto',display:'flex',gap:'4px',alignItems:'center',fontSize:'11px',color:'#3a5068'}}>
              {['1','2','3','4','5'].map(n=>(
                <code key={n} style={{background:'#111820',padding:'2px 7px',borderRadius:'4px',color:'#c8a030',fontSize:'11px',border:'1px solid #1c2a3a'}}>!투표{n}</code>
              ))}
            </div>
          </div>

          {/* 메인 영역 */}
          <div style={{flex:1,overflow:'auto',padding:'20px 28px'}}>
            <div style={{display:'grid',gridTemplateColumns:'290px 1fr',gap:'16px',alignItems:'start',maxWidth:'1200px',margin:'0 auto'}}>

              {/* ── 왼쪽 패널 ── */}
              <div>
                {/* 투표 설정 */}
                <div style={S.card()}>
                  <div style={{fontWeight:700,color:'#c8d8ec',marginBottom:'16px',fontSize:'14px',display:'flex',alignItems:'center',gap:'8px'}}>
                    <span style={{fontSize:'16px'}}>📊</span> 투표 설정
                  </div>
                  <div style={{marginBottom:'12px'}}>
                    <label style={S.label()}>제목</label>
                    <input style={S.inp()} value={voteTitle} onChange={e=>setVoteTitle(e.target.value)}/>
                  </div>
                  <div style={{marginBottom:'14px'}}>
                    <label style={S.label()}>항목 <span style={{textTransform:'none',color:'#3a5068',fontWeight:400,letterSpacing:0}}>(한 줄에 하나)</span></label>
                    <textarea style={{...S.inp(),height:'105px',resize:'vertical',lineHeight:'1.9'}}
                      value={voteItemsText} onChange={e=>setVoteItemsText(e.target.value)}/>
                  </div>
                  <div style={{display:'flex',gap:'8px'}}>
                    {!vote.active
                      ? <button style={{...S.btn(),flex:1,padding:'9px 0'}}
                          onClick={()=>api('start_vote',{title:voteTitle,items:voteItemsText.split('\n').filter(i=>i.trim())})}>
                          ▶ 투표 시작
                        </button>
                      : <button style={{...S.btn('#ea4335','#fff'),flex:1,padding:'9px 0'}}
                          onClick={()=>api('end_vote')}>
                          ■ 투표 종료
                        </button>
                    }
                    <button style={{...S.btn('#1c2a3a','#5a7a9a',true)}} onClick={()=>api('reset_vote')}>초기화</button>
                  </div>
                  {!vote.active&&vote.items.length>0&&(
                    <button style={{...S.btn('#7b2fbe','#fff'),marginTop:'10px',width:'100%',padding:'8px 0'}}
                      onClick={()=>{api('vote_to_roulette');setShowRoulette(true)}}>
                      🎡 룰렛으로 넘기기
                    </button>
                  )}
                </div>

                {/* 실시간 채팅 */}
                <div style={S.card({padding:'16px 18px'})}>
                  <div style={{fontWeight:600,color:'#8aa8c4',marginBottom:'10px',fontSize:'13px',display:'flex',alignItems:'center',gap:'7px'}}>
                    <span style={{width:'6px',height:'6px',borderRadius:'50%',
                      background:chzzkConnected?'#34a853':'#3a5068',
                      display:'inline-block',flexShrink:0}}/>
                    실시간 채팅
                  </div>
                  <div style={{height:'200px',overflowY:'auto',fontSize:'12px',lineHeight:'1.75'}}>
                    {!chzzkConnected
                      ? <div style={{color:'#3a5068',textAlign:'center',padding:'28px 0',fontSize:'12px'}}>채널을 연결하세요</div>
                      : chatLog.length===0
                        ? <div style={{color:'#3a5068',textAlign:'center',padding:'28px 0',fontSize:'12px'}}>채팅 대기 중...</div>
                        : chatLog.map((c,i)=>(
                            <div key={i} style={{padding:'2px 0',borderBottom:'1px solid rgba(28,42,58,.5)'}}>
                              <span style={{color:c.text.startsWith('!투표')?'#e8b84b':'#6090b8',marginRight:'6px',fontWeight:600,fontSize:'11px'}}>{c.nickname}</span>
                              <span style={{color:c.text.startsWith('!투표')?'#34a853':'#8aa8c4',fontSize:'12px'}}>{c.text}</span>
                            </div>
                          ))
                    }
                    <div ref={chatEndRef}/>
                  </div>
                </div>
              </div>

              {/* ── 오른쪽: 투표 결과 ── */}
              <div style={S.card()}>
                <div style={{display:'flex',alignItems:'center',gap:'10px',marginBottom:'20px'}}>
                  <div style={{fontWeight:700,fontSize:'16px',color:'#c8d8ec'}}>{vote.title||'투표 결과'}</div>
                  {vote.active&&(
                    <span style={{fontSize:'11px',padding:'3px 10px',borderRadius:'20px',
                      background:'rgba(52,168,83,.1)',color:'#34a853',
                      border:'1px solid rgba(52,168,83,.25)',fontWeight:600,
                      display:'flex',alignItems:'center',gap:'5px'}}>
                      <span style={{width:'5px',height:'5px',borderRadius:'50%',background:'#34a853',display:'inline-block'}}/>
                      진행 중
                    </span>
                  )}
                  <span style={{marginLeft:'auto',fontSize:'13px',color:'#4a6a8a'}}>
                    총 <b style={{color:'#8aa8c4'}}>{total}</b>표
                  </span>
                </div>

                {vote.items.length===0 ? (
                  <div style={{textAlign:'center',padding:'70px 0',color:'#3a5068'}}>
                    <div style={{fontSize:'36px',marginBottom:'12px',opacity:.3}}>📊</div>
                    <div style={{fontSize:'14px'}}>투표를 시작하면 실시간으로 표시됩니다</div>
                  </div>
                ) : vote.items.map((item,i)=>{
                  const pct = total>0 ? Math.round(item.votes.length/total*100) : 0
                  const isExpanded = expandedIdx===i
                  return (
                    <div key={i} style={{
                      marginBottom:'8px',
                      background:'#0a0f16',
                      border:`1px solid ${isExpanded?item.color+'55':'#1c2a3a'}`,
                      borderRadius:'8px',overflow:'hidden',transition:'border-color .2s',
                    }}>
                      <div onClick={()=>setExpandedIdx(isExpanded?null:i)}
                        style={{display:'grid',gridTemplateColumns:'120px 1fr 44px 62px 20px',
                          gap:'12px',alignItems:'center',padding:'13px 16px',
                          cursor:'pointer',userSelect:'none',transition:'background .12s'}}
                        onMouseEnter={e=>(e.currentTarget.style.background='#111820')}
                        onMouseLeave={e=>(e.currentTarget.style.background='transparent')}>
                        <div>
                          <div style={{fontSize:'10px',color:item.color,fontFamily:'monospace',
                            fontWeight:700,marginBottom:'4px',letterSpacing:'1.2px'}}>!투표{i+1}</div>
                          <div style={{fontSize:'16px',fontWeight:700,color:'#c8d8ec'}}>{item.label}</div>
                        </div>
                        <div style={{height:'7px',background:'#1c2a3a',borderRadius:'4px',overflow:'hidden'}}>
                          <div style={{height:'100%',width:`${pct}%`,background:item.color,
                            borderRadius:'4px',transition:'width .5s ease'}}/>
                        </div>
                        <span style={{fontSize:'12px',color:'#4a6a8a',textAlign:'right'}}>{item.votes.length}표</span>
                        <span style={{fontSize:'20px',fontWeight:700,color:item.color,textAlign:'right'}}>{pct}%</span>
                        <span style={{fontSize:'11px',color:'#4a6a8a',transition:'transform .2s',
                          transform:isExpanded?'rotate(180deg)':'none',display:'block',textAlign:'center'}}>▼</span>
                      </div>

                      {isExpanded&&(
                        <div style={{padding:'10px 16px 14px',borderTop:`1px solid ${item.color}22`,background:'#070b10'}}>
                          <div style={{fontSize:'10px',color:'#3a5068',marginBottom:'8px',letterSpacing:'.6px',textTransform:'uppercase'}}>
                            투표자 {item.votes.length}명
                          </div>
                          {item.votes.length===0
                            ? <div style={{fontSize:'12px',color:'#3a5068',fontStyle:'italic'}}>아직 없습니다</div>
                            : <div style={{display:'flex',flexWrap:'wrap',gap:'5px'}}>
                                {item.votes.map((nick,j)=>(
                                  <span key={j} style={{
                                    fontSize:'12px',padding:'3px 10px',borderRadius:'20px',
                                    background:`${item.color}15`,color:item.color,
                                    border:`1px solid ${item.color}35`,fontWeight:500,
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

            {/* ── 룰렛 섹션 ── */}
            {showRoulette&&(
              <div style={{maxWidth:'1200px',margin:'16px auto 0',display:'grid',gridTemplateColumns:'380px 1fr',gap:'16px',alignItems:'start'}}>

                {/* 룰렛 휠 */}
                <div style={S.card({textAlign:'center'})}>
                  <div style={{fontWeight:700,color:'#e8b84b',marginBottom:'16px',fontSize:'15px',letterSpacing:'.5px'}}>🎡 룰렛</div>
                  <div style={{position:'relative',display:'inline-block'}}>
                    <canvas ref={canvasRef} width={320} height={320} style={{maxWidth:'100%',display:'block',margin:'0 auto',borderRadius:'50%'}}/>
                  </div>
                  <button
                    style={{...S.btn(),fontSize:'14px',padding:'11px 44px',marginTop:'16px',
                      opacity:spinning||!activeRouletteItems.length?0.45:1,
                      borderRadius:'8px',letterSpacing:'.5px'}}
                    onClick={spin} disabled={spinning||!activeRouletteItems.length}>
                    {spinning?'돌아가는 중...':'🎡 돌리기'}
                  </button>

                  {/* 제외 옵션 */}
                  <div style={{marginTop:'14px',display:'flex',alignItems:'center',justifyContent:'center',gap:'8px'}}>
                    <label style={{display:'flex',alignItems:'center',gap:'6px',cursor:'pointer',fontSize:'12px',color:'#8aa8c4',userSelect:'none'}}>
                      <input type="checkbox" checked={excludeEnabled}
                        onChange={e=>setExcludeEnabled(e.target.checked)}
                        style={{accentColor:'#34a853',width:'14px',height:'14px'}}/>
                      이미 뽑힌 참여자 제외하기
                    </label>
                  </div>

                  {/* 제외된 목록 */}
                  {excludedWinners.length>0&&(
                    <div style={{marginTop:'12px',padding:'10px 14px',background:'#070b10',borderRadius:'8px',border:'1px solid #1c2a3a',textAlign:'left'}}>
                      <div style={{fontSize:'10px',color:'#4a6a8a',marginBottom:'7px',letterSpacing:'.6px',textTransform:'uppercase'}}>
                        제외됨 ({excludedWinners.length}명)
                      </div>
                      <div style={{display:'flex',flexWrap:'wrap',gap:'5px'}}>
                        {excludedWinners.map((w,i)=>(
                          <span key={i}
                            onClick={()=>removeExcluded(w)}
                            title="클릭하여 제외 해제"
                            style={{fontSize:'12px',padding:'3px 8px 3px 10px',borderRadius:'20px',
                              background:'rgba(244,67,54,.12)',color:'#f06070',
                              border:'1px solid rgba(244,67,54,.25)',cursor:'pointer',
                              display:'flex',alignItems:'center',gap:'5px',transition:'background .15s',
                              userSelect:'none'}}
                            onMouseEnter={e=>(e.currentTarget.style.background='rgba(244,67,54,.22)')}
                            onMouseLeave={e=>(e.currentTarget.style.background='rgba(244,67,54,.12)')}>
                            {w} <span style={{fontSize:'10px',opacity:.7}}>✕</span>
                          </span>
                        ))}
                      </div>
                      <button
                        onClick={()=>setExcludedWinners([])}
                        style={{...S.btn('#1c2a3a','#5a7a9a',true),marginTop:'10px',width:'100%',padding:'6px 0',fontSize:'12px'}}>
                        전체 해제
                      </button>
                    </div>
                  )}

                  {/* 당첨 결과 */}
                  {winner&&(
                    <div style={{marginTop:'14px',padding:'16px',
                      background:'rgba(232,184,75,.07)',
                      border:'1px solid rgba(232,184,75,.25)',borderRadius:'8px'}}>
                      <div style={{fontSize:'11px',color:'#a08030',marginBottom:'6px',letterSpacing:'.5px'}}>🎉 당첨</div>
                      <div style={{fontSize:'28px',fontWeight:700,color:'#e8b84b'}}>{winner}</div>
                    </div>
                  )}
                </div>

                {/* 룰렛 항목 설정 */}
                <div style={S.card()}>
                  <div style={{fontWeight:700,color:'#c8d8ec',marginBottom:'14px',fontSize:'14px'}}>항목 설정</div>
                  <div style={{display:'flex',gap:'8px',marginBottom:'14px',flexWrap:'wrap'}}>
                    <input style={{...S.inp(),flex:1,minWidth:'100px'}}
                      placeholder="항목명" value={rInput}
                      onChange={e=>setRInput(e.target.value)}
                      onKeyDown={e=>e.key==='Enter'&&addRouletteItem()}/>
                    <div style={{display:'flex',alignItems:'center',gap:'6px',flexShrink:0}}>
                      <span style={{fontSize:'11px',color:'#4a6a8a'}}>가중치</span>
                      <input style={{...S.inp('52px'),textAlign:'center'}} type="number" min="1"
                        value={rWeight} onChange={e=>setRWeight(e.target.value)}/>
                    </div>
                    <button style={S.btn()} onClick={addRouletteItem}>추가</button>
                  </div>

                  <div style={{maxHeight:'260px',overflowY:'auto',marginBottom:'14px'}}>
                    {rouletteItems.length===0
                      ? <div style={{textAlign:'center',padding:'24px 0',color:'#3a5068',fontSize:'13px'}}>항목이 없습니다</div>
                      : rouletteItems.map((item,i)=>{
                          const t=rouletteItems.reduce((s,it)=>s+(it.weight||1),0)
                          const excluded=excludeEnabled&&excludedWinners.includes(item.label)
                          return (
                            <div key={i} style={{
                              display:'flex',alignItems:'center',gap:'8px',
                              padding:'9px 10px',borderRadius:'6px',marginBottom:'4px',
                              background:excluded?'rgba(244,67,54,.06)':'#0a0f16',
                              border:`1px solid ${excluded?'rgba(244,67,54,.2)':'#1c2a3a'}`,
                              opacity:excluded?0.6:1,transition:'all .15s',
                            }}>
                              <div style={{width:'9px',height:'9px',borderRadius:'3px',background:item.color,flexShrink:0}}/>
                              <span style={{flex:1,fontSize:'13px',color:excluded?'#f06070':'#c8d8ec',
                                textDecoration:excluded?'line-through':'none'}}>{item.label}</span>
                              {excluded&&<span style={{fontSize:'10px',color:'#f06070',opacity:.7}}>제외됨</span>}
                              <span style={{fontSize:'11px',color:'#3a5068'}}>
                                {item.weight}w · {Math.round((item.weight||1)/t*100)}%
                              </span>
                              <button style={{background:'none',border:'none',color:'#3a5068',
                                cursor:'pointer',fontSize:'15px',padding:'0 2px',lineHeight:1}}
                                onClick={()=>removeRouletteItem(i)}>✕</button>
                            </div>
                          )
                        })
                    }
                  </div>

                  <div style={{display:'flex',gap:'8px',flexWrap:'wrap',borderTop:'1px solid #1c2a3a',paddingTop:'14px'}}>
                    <button style={{...S.btn('#7b2fbe','#fff')}} onClick={async()=>{
                      await api('vote_to_roulette')
                      const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'get_state'})})
                      const data=await r.json()
                      if(data.roulette?.items) setRouletteItems(data.roulette.items)
                    }}>← 투표 결과 갱신</button>
                    <button style={S.btn('#1c2a3a','#5a7a9a',true)}
                      onClick={()=>{setRouletteItems([]);api('set_roulette',{items:[]})}}>전체 삭제</button>
                    <button style={{...S.btn('#1c2a3a','#5a7a9a',true),marginLeft:'auto'}}
                      onClick={()=>setShowRoulette(false)}>닫기</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #1c2a3a; border-radius: 2px; }
        ::-webkit-scrollbar-thumb:hover { background: #2a3d58; }
        input:focus, textarea:focus { border-color: #2a4060 !important; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
        button:hover { opacity: 0.85; }
      `}</style>
    </div>
  )
}
