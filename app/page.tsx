'use client'
import { useEffect, useRef, useState } from 'react'

const COLORS = ['#4285f4','#ea4335','#34a853','#fbbc04','#9c27b0','#00bcd4','#ff5722','#607d8b']
const PASSWORD = '09870987'

interface VoteItem { label: string; votes: string[]; color: string }
interface Vote { active: boolean; title: string; items: VoteItem[]; startedAt: number | null }
interface RouletteItem { label: string; weight: number; color: string }

export default function Home() {
  const [auth, setAuth] = useState(false)
  const [pwInput, setPwInput] = useState('')
  const [pwError, setPwError] = useState(false)
  const [tab, setTab] = useState<'inhouse'|'vote'>('inhouse')
  const [chzzkConnected, setChzzkConnected] = useState(false)
  const [channelId, setChannelId] = useState('')
  const [inputCid, setInputCid] = useState('')
  const [chatLog, setChatLog] = useState<{nickname:string,text:string}[]>([])
  const [vote, setVote] = useState<Vote>({ active: false, title: '', items: [], startedAt: null })
  const [voteTitle, setVoteTitle] = useState('내전 투표')
  const [voteItemsText, setVoteItemsText] = useState('첫참\n선참권\n중참\n연참\n취소')
  const [showRoulette, setShowRoulette] = useState(false)
  const [rouletteItems, setRouletteItems] = useState<RouletteItem[]>([])
  const [rInput, setRInput] = useState('')
  const [rWeight, setRWeight] = useState('1')
  const [spinning, setSpinning] = useState(false)
  const [winner, setWinner] = useState<string|null>(null)
  const [angle, setAngle] = useState(0)
  const [expandedIdx, setExpandedIdx] = useState<number|null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>()
  const chatEndRef = useRef<HTMLDivElement>(null)

  const api = async (type: string, extra?: object) => {
    await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  useEffect(() => { if (showRoulette) drawWheel(angle) }, [rouletteItems, angle, showRoulette])
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [chatLog])

  function drawWheel(rot: number) {
    const c = canvasRef.current; if (!c) return
    const ctx = c.getContext('2d')!
    const W = c.width, H = c.height, cx = W/2, cy = H/2, r = Math.min(cx,cy) - 12
    ctx.clearRect(0, 0, W, H)
    if (!rouletteItems.length) {
      ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2)
      ctx.fillStyle='#131a24'; ctx.fill()
      ctx.fillStyle='#5a7a9a'; ctx.font='15px sans-serif'; ctx.textAlign='center'
      ctx.fillText('항목을 추가하세요', cx, cy); return
    }
    const total = rouletteItems.reduce((s,i) => s+(i.weight||1), 0)
    let a = rot * Math.PI/180
    rouletteItems.forEach((item, i) => {
      const slice = (item.weight||1)/total * Math.PI*2
      ctx.beginPath(); ctx.moveTo(cx,cy)
      ctx.arc(cx,cy,r,a,a+slice); ctx.closePath()
      ctx.fillStyle = item.color||COLORS[i%COLORS.length]; ctx.fill()
      ctx.strokeStyle='#07090f'; ctx.lineWidth=2; ctx.stroke()
      const mid = a+slice/2
      ctx.save(); ctx.translate(cx+r*.62*Math.cos(mid), cy+r*.62*Math.sin(mid))
      ctx.rotate(mid+Math.PI/2); ctx.fillStyle='#fff'
      ctx.font='bold 12px sans-serif'; ctx.textAlign='center'
      ctx.fillText(item.label.length>7?item.label.slice(0,7)+'...':item.label, 0, 0)
      ctx.restore(); a += slice
    })
    ctx.beginPath(); ctx.arc(cx,cy,16,0,Math.PI*2)
    ctx.fillStyle='#07090f'; ctx.fill()
    ctx.strokeStyle='#e8b84b'; ctx.lineWidth=3; ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx-11,4); ctx.lineTo(cx+11,4); ctx.lineTo(cx,28)
    ctx.closePath(); ctx.fillStyle='#e8b84b'; ctx.fill()
  }

  function spin() {
    if (spinning||!rouletteItems.length) return
    if (animRef.current) cancelAnimationFrame(animRef.current)
    setSpinning(true); setWinner(null)
    const total = rouletteItems.reduce((s,i) => s+(i.weight||1), 0)
    const rand = Math.random()*total
    let acc=0, winIdx=0
    for (let i=0; i<rouletteItems.length; i++) {
      acc += rouletteItems[i].weight||1
      if (rand<=acc) { winIdx=i; break }
    }
    const sliceDeg = (rouletteItems[winIdx].weight||1)/total*360
    const winStart = rouletteItems.slice(0,winIdx).reduce((s,i)=>s+(i.weight||1)/total*360,0)
    const targetDeg = 360-(winStart+sliceDeg/2)
    const finalAngle = angle + 1800 + ((targetDeg-angle%360+360)%360)
    const startAngle = angle, startTime = performance.now()
    const animate = (now: number) => {
      const t = Math.min((now-startTime)/5000, 1)
      const ease = 1-Math.pow(1-t,4)
      const cur = startAngle+(finalAngle-startAngle)*ease
      setAngle(cur); drawWheel(cur)
      if (t<1) { animRef.current=requestAnimationFrame(animate) }
      else { setSpinning(false); setWinner(rouletteItems[winIdx].label); setAngle(cur%360) }
    }
    animRef.current = requestAnimationFrame(animate)
  }

  function addRouletteItem() {
    if (!rInput.trim()) return
    const newItems = [...rouletteItems, { label: rInput.trim(), weight: parseInt(rWeight)||1, color: COLORS[rouletteItems.length%COLORS.length] }]
    setRouletteItems(newItems); api('set_roulette', { items: newItems }); setRInput('')
  }

  function removeRouletteItem(idx: number) {
    const newItems = rouletteItems.filter((_,i)=>i!==idx)
    setRouletteItems(newItems); api('set_roulette', { items: newItems })
  }

  // ── 스타일 ──
  const inp = (w='100%'): React.CSSProperties => ({
    background:'#0d1117', border:'1px solid #1f2d42', color:'#c8d8ec',
    borderRadius:'6px', padding:'8px 12px', fontSize:'13px',
    fontFamily:'inherit', outline:'none', width:w, boxSizing:'border-box' as const,
  })
  const card: React.CSSProperties = {
    background:'#0d1117', border:'1px solid #1f2d42',
    borderRadius:'10px', padding:'20px', marginBottom:'12px',
  }
  const btn = (bg='#e8b84b', fg='#0d1117', outline=false): React.CSSProperties => ({
    padding:'8px 18px', borderRadius:'6px',
    border: outline ? `1px solid ${bg}` : 'none',
    background: outline ? 'transparent' : bg,
    color: outline ? bg : fg,
    cursor:'pointer', fontSize:'13px', fontWeight:600,
    fontFamily:'inherit', whiteSpace:'nowrap' as const,
  })

  // ── 비밀번호 화면 ──
  if (!auth) return (
    <div style={{minHeight:'100vh',background:'#07090f',display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'\'Noto Sans KR\',sans-serif'}}>
      <div style={{background:'#0d1117',border:'1px solid #1f2d42',borderRadius:'12px',padding:'48px 52px',textAlign:'center',minWidth:'340px',boxShadow:'0 20px 60px rgba(0,0,0,.6)'}}>
        <div style={{fontSize:'26px',fontWeight:700,color:'#e8b84b',marginBottom:'6px',letterSpacing:'1px'}}>⚔ 다비도의 내전</div>
        <div style={{fontSize:'13px',color:'#5a7a9a',marginBottom:'32px'}}>비밀번호를 입력하세요</div>
        <input type="password" value={pwInput} autoFocus
          onChange={e=>{setPwInput(e.target.value);setPwError(false)}}
          onKeyDown={e=>{if(e.key==='Enter'){if(pwInput===PASSWORD)setAuth(true);else setPwError(true)}}}
          placeholder="비밀번호"
          style={{...inp(),marginBottom:'8px',fontSize:'14px',padding:'11px 14px',border:`1px solid ${pwError?'#ea4335':'#1f2d42'}`}}
        />
        {pwError&&<div style={{fontSize:'12px',color:'#ea4335',marginBottom:'8px'}}>비밀번호가 틀렸습니다</div>}
        <button onClick={()=>{if(pwInput===PASSWORD)setAuth(true);else setPwError(true)}}
          style={{width:'100%',padding:'12px',borderRadius:'6px',border:'none',background:'#e8b84b',color:'#0d1117',fontWeight:700,fontSize:'14px',fontFamily:'inherit',cursor:'pointer',marginTop:'4px'}}>
          입장
        </button>
      </div>
    </div>
  )

  const total = vote.items.reduce((s,i)=>s+i.votes.length, 0)

  return (
    <div style={{fontFamily:'\'Noto Sans KR\',sans-serif',minHeight:'100vh',background:'#07090f',color:'#c8d8ec'}}>

      {/* 헤더 */}
      <div style={{background:'#0d1117',borderBottom:'1px solid #1f2d42',padding:'0 24px',display:'flex',alignItems:'stretch',position:'sticky',top:0,zIndex:100}}>
        <div style={{fontSize:'17px',fontWeight:700,color:'#e8b84b',display:'flex',alignItems:'center',marginRight:'24px',gap:'8px'}}>
          <span>⚔</span><span>다비도의 내전</span>
        </div>
        {(['inhouse','vote'] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{
            padding:'0 20px', border:'none',
            borderBottom: tab===t ? '2px solid #e8b84b' : '2px solid transparent',
            background:'none', color: tab===t ? '#e8b84b' : '#5a7a9a',
            cursor:'pointer', fontSize:'13px', fontFamily:'inherit',
            fontWeight: tab===t ? 700 : 400, transition:'all .15s',
          }}>
            {t==='inhouse' ? '⚔ 내전 진행' : '📊 채팅 투표'}
          </button>
        ))}
      </div>

      {/* 치지직 연결 바 */}
      {tab==='vote' && (
        <div style={{background:'#0d1117',borderBottom:'1px solid #1f2d42',padding:'8px 24px',display:'flex',alignItems:'center',gap:'10px',flexWrap:'wrap',fontSize:'13px'}}>
          <div style={{width:'8px',height:'8px',borderRadius:'50%',background:chzzkConnected?'#34a853':'#5a7a9a',flexShrink:0,boxShadow:chzzkConnected?'0 0 6px #34a853':'none'}}/>
          <span style={{color:'#5a7a9a',fontSize:'12px'}}>치지직 채팅</span>
          {chzzkConnected ? <>
            <span style={{color:'#34a853',fontWeight:600,fontSize:'12px'}}>{channelId.slice(0,20)}...</span>
            <button style={btn('#ea4335','#fff')} onClick={()=>api('disconnect_chzzk')}>연결 해제</button>
          </> : <>
            <input style={{...inp('240px'),padding:'5px 10px',fontSize:'12px'}} placeholder="채널 ID" value={inputCid} onChange={e=>setInputCid(e.target.value)} onKeyDown={e=>e.key==='Enter'&&api('connect_chzzk',{channelId:inputCid})}/>
            <button style={{...btn(),padding:'5px 14px',fontSize:'12px'}} onClick={()=>api('connect_chzzk',{channelId:inputCid})}>연결</button>
            <span style={{color:'#5a7a9a',fontSize:'11px'}}>예) chzzk.naver.com/<b style={{color:'#e8b84b'}}>여기</b></span>
          </>}
          <div style={{marginLeft:'auto',display:'flex',gap:'5px',alignItems:'center',fontSize:'11px',color:'#5a7a9a'}}>
            명령어:
            {['1','2','3','4','5','6'].map(n=>(
              <code key={n} style={{background:'#131a24',padding:'2px 6px',borderRadius:'3px',color:'#e8b84b',fontSize:'11px'}}>!투표{n}</code>
            ))}
          </div>
        </div>
      )}

      {/* 내전 탭 */}
      {tab==='inhouse' && (
        <iframe src="/inhouse.html" style={{width:'100%',height:'calc(100vh - 53px)',border:'none',display:'block'}} title="내전 진행"/>
      )}

      {/* 투표 탭 */}
      {tab==='vote' && (
        <div style={{maxWidth:'1100px',margin:'0 auto',padding:'20px 24px'}}>
          <div style={{display:'grid',gridTemplateColumns:'300px 1fr',gap:'16px',alignItems:'start'}}>

            {/* 왼쪽 */}
            <div>
              {/* 투표 설정 */}
              <div style={card}>
                <div style={{fontWeight:700,color:'#c8d8ec',marginBottom:'14px',fontSize:'14px',display:'flex',alignItems:'center',gap:'8px'}}>
                  <span style={{color:'#e8b84b'}}>📊</span> 투표 설정
                </div>
                <div style={{marginBottom:'10px'}}>
                  <div style={{fontSize:'11px',color:'#5a7a9a',marginBottom:'4px',letterSpacing:'.5px',textTransform:'uppercase'}}>제목</div>
                  <input style={inp()} value={voteTitle} onChange={e=>setVoteTitle(e.target.value)}/>
                </div>
                <div style={{marginBottom:'14px'}}>
                  <div style={{fontSize:'11px',color:'#5a7a9a',marginBottom:'4px',letterSpacing:'.5px',textTransform:'uppercase'}}>항목 <span style={{textTransform:'none',fontSize:'10px'}}>(한 줄에 하나)</span></div>
                  <textarea style={{...inp(),height:'110px',resize:'vertical',lineHeight:'1.9'}} value={voteItemsText} onChange={e=>setVoteItemsText(e.target.value)}/>
                </div>
                <div style={{display:'flex',gap:'8px',flexWrap:'wrap'}}>
                  {!vote.active
                    ? <button style={{...btn(),flex:1}} onClick={()=>api('start_vote',{title:voteTitle,items:voteItemsText.split('\n').filter(i=>i.trim())})}>▶ 투표 시작</button>
                    : <button style={{...btn('#ea4335','#fff'),flex:1}} onClick={()=>api('end_vote')}>■ 투표 종료</button>
                  }
                  <button style={btn('#1e2840','#5a7a9a',true)} onClick={()=>api('reset_vote')}>초기화</button>
                </div>
                {!vote.active && vote.items.length>0 && (
                  <button style={{...btn('#9c27b0','#fff'),marginTop:'8px',width:'100%'}}
                    onClick={()=>{api('vote_to_roulette');setShowRoulette(true)}}>
                    🎡 룰렛으로
                  </button>
                )}
              </div>

              {/* 실시간 채팅 */}
              <div style={{...card,padding:'16px'}}>
                <div style={{fontWeight:600,color:'#c8d8ec',marginBottom:'10px',fontSize:'13px',display:'flex',alignItems:'center',gap:'6px'}}>
                  <span style={{width:'6px',height:'6px',borderRadius:'50%',background:chzzkConnected?'#34a853':'#5a7a9a',display:'inline-block'}}/>
                  실시간 채팅
                </div>
                <div style={{height:'220px',overflowY:'auto',fontSize:'12px',lineHeight:'1.7'}}>
                  {!chzzkConnected
                    ? <div style={{color:'#5a7a9a',textAlign:'center',padding:'30px 0',fontSize:'12px'}}>채널을 연결하세요</div>
                    : chatLog.length===0
                      ? <div style={{color:'#5a7a9a',textAlign:'center',padding:'30px 0',fontSize:'12px'}}>채팅 대기 중...</div>
                      : chatLog.map((c,i)=>(
                          <div key={i} style={{padding:'2px 0',borderBottom:'1px solid rgba(31,45,66,.3)'}}>
                            <span style={{color:c.text.startsWith('!투표')?'#e8b84b':'#82b1ff',marginRight:'5px',fontWeight:500,fontSize:'11px'}}>{c.nickname}</span>
                            <span style={{color:c.text.startsWith('!투표')?'#34a853':'#8aa8c4',fontSize:'12px'}}>{c.text}</span>
                          </div>
                        ))
                  }
                  <div ref={chatEndRef}/>
                </div>
              </div>
            </div>

            {/* 오른쪽: 투표 결과 */}
            <div style={card}>
              <div style={{display:'flex',alignItems:'center',gap:'10px',marginBottom:'20px'}}>
                <div style={{fontWeight:700,fontSize:'16px',color:'#c8d8ec'}}>{vote.title||'투표 결과'}</div>
                {vote.active && (
                  <span style={{fontSize:'11px',padding:'3px 10px',borderRadius:'20px',background:'rgba(52,168,83,.15)',color:'#34a853',border:'1px solid rgba(52,168,83,.3)',fontWeight:600,display:'flex',alignItems:'center',gap:'4px'}}>
                    <span style={{width:'5px',height:'5px',borderRadius:'50%',background:'#34a853',display:'inline-block',animation:'pulse 1.2s ease-in-out infinite'}}/>
                    진행 중
                  </span>
                )}
                <span style={{marginLeft:'auto',fontSize:'13px',color:'#5a7a9a'}}>총 <b style={{color:'#c8d8ec'}}>{total}</b>표</span>
              </div>

              {vote.items.length===0
                ? (
                  <div style={{textAlign:'center',padding:'60px 0',color:'#5a7a9a',fontSize:'14px'}}>
                    <div style={{fontSize:'32px',marginBottom:'12px',opacity:.4}}>📊</div>
                    투표를 시작하면 실시간으로 표시됩니다
                  </div>
                )
                : vote.items.map((item,i)=>{
                    const pct = total>0 ? Math.round(item.votes.length/total*100) : 0
                    const isExpanded = expandedIdx === i
                    return (
                      <div key={i} style={{
                        marginBottom:'10px',
                        background:'#0d1117',
                        border:`1px solid ${isExpanded ? item.color+'66' : '#1f2d42'}`,
                        borderRadius:'8px', overflow:'hidden',
                        transition:'border-color .2s',
                      }}>
                        {/* 항목 행 - 클릭하면 투표자 목록 토글 */}
                        <div
                          onClick={()=>setExpandedIdx(isExpanded ? null : i)}
                          style={{
                            display:'grid',
                            gridTemplateColumns:'130px 1fr auto auto auto',
                            gap:'12px', alignItems:'center',
                            padding:'12px 16px', cursor:'pointer',
                            userSelect:'none',
                            transition:'background .15s',
                          }}
                          onMouseEnter={e=>(e.currentTarget.style.background='#131a24')}
                          onMouseLeave={e=>(e.currentTarget.style.background='transparent')}
                        >
                          {/* 명령어 + 라벨 */}
                          <div>
                            <div style={{fontSize:'11px',color:item.color,fontFamily:'monospace',fontWeight:700,marginBottom:'3px',letterSpacing:'1px'}}>!투표{i+1}</div>
                            <div style={{fontSize:'16px',fontWeight:700,color:'#c8d8ec'}}>{item.label}</div>
                          </div>

                          {/* 진행 바 */}
                          <div>
                            <div style={{height:'8px',background:'#131a24',borderRadius:'4px',overflow:'hidden'}}>
                              <div style={{height:'100%',width:`${pct}%`,background:item.color,borderRadius:'4px',transition:'width .4s ease'}}/>
                            </div>
                          </div>

                          {/* 표수 */}
                          <span style={{fontSize:'13px',color:'#5a7a9a',minWidth:'30px',textAlign:'right'}}>{item.votes.length}표</span>

                          {/* 퍼센트 */}
                          <span style={{fontSize:'22px',fontWeight:700,color:item.color,minWidth:'52px',textAlign:'right'}}>{pct}%</span>

                          {/* 펼치기 아이콘 */}
                          <span style={{fontSize:'12px',color:'#5a7a9a',transition:'transform .2s',transform:isExpanded?'rotate(180deg)':'none'}}>▼</span>
                        </div>

                        {/* 투표자 목록 (펼쳐지면 표시) */}
                        {isExpanded && (
                          <div style={{padding:'10px 16px 14px',borderTop:`1px solid ${item.color}33`,background:'#0a0f16'}}>
                            <div style={{fontSize:'11px',color:'#5a7a9a',marginBottom:'8px',letterSpacing:'.5px',textTransform:'uppercase'}}>
                              투표자 {item.votes.length}명
                            </div>
                            {item.votes.length === 0
                              ? <div style={{fontSize:'12px',color:'#5a7a9a',fontStyle:'italic'}}>아직 투표한 사람이 없습니다</div>
                              : (
                                <div style={{display:'flex',flexWrap:'wrap',gap:'6px'}}>
                                  {item.votes.map((nick,j)=>(
                                    <span key={j} style={{
                                      fontSize:'12px',padding:'3px 10px',
                                      borderRadius:'20px',
                                      background:`${item.color}18`,
                                      color:item.color,
                                      border:`1px solid ${item.color}44`,
                                      fontWeight:500,
                                    }}>{nick}</span>
                                  ))}
                                </div>
                              )
                            }
                          </div>
                        )}
                      </div>
                    )
                  })
              }
            </div>
          </div>

          {/* 룰렛 */}
          {showRoulette && (
            <div style={{marginTop:'16px',display:'grid',gridTemplateColumns:'400px 1fr',gap:'16px',alignItems:'start'}}>
              <div style={{...card,textAlign:'center'}}>
                <div style={{fontWeight:700,color:'#e8b84b',marginBottom:'14px',fontSize:'14px'}}>🎡 룰렛</div>
                <canvas ref={canvasRef} width={340} height={340} style={{maxWidth:'100%',display:'block',margin:'0 auto'}}/>
                <button style={{...btn(),fontSize:'14px',padding:'10px 36px',marginTop:'14px',opacity:spinning||!rouletteItems.length?.5:1}} onClick={spin} disabled={spinning||!rouletteItems.length}>
                  {spinning?'돌아가는 중...':'🎡 돌리기'}
                </button>
                {winner&&(
                  <div style={{marginTop:'14px',padding:'14px',background:'rgba(232,184,75,.1)',border:'1px solid rgba(232,184,75,.3)',borderRadius:'8px'}}>
                    <div style={{fontSize:'11px',color:'#5a7a9a',marginBottom:'4px'}}>🎉 당첨!</div>
                    <div style={{fontSize:'26px',fontWeight:700,color:'#e8b84b'}}>{winner}</div>
                  </div>
                )}
              </div>
              <div style={card}>
                <div style={{fontWeight:700,color:'#c8d8ec',marginBottom:'12px',fontSize:'14px'}}>항목 설정</div>
                <div style={{display:'flex',gap:'8px',marginBottom:'12px',flexWrap:'wrap'}}>
                  <input style={{...inp(),flex:1,minWidth:'100px'}} placeholder="항목명" value={rInput} onChange={e=>setRInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addRouletteItem()}/>
                  <div style={{display:'flex',alignItems:'center',gap:'6px',flexShrink:0}}>
                    <span style={{fontSize:'11px',color:'#5a7a9a'}}>가중치</span>
                    <input style={{...inp('52px'),textAlign:'center'}} type="number" min="1" value={rWeight} onChange={e=>setRWeight(e.target.value)}/>
                  </div>
                  <button style={btn()} onClick={addRouletteItem}>추가</button>
                </div>
                <div style={{maxHeight:'240px',overflowY:'auto'}}>
                  {rouletteItems.map((item,i)=>{
                    const t=rouletteItems.reduce((s,it)=>s+(it.weight||1),0)
                    return (
                      <div key={i} style={{display:'flex',alignItems:'center',gap:'8px',padding:'8px 0',borderBottom:'1px solid #1f2d42'}}>
                        <div style={{width:'8px',height:'8px',borderRadius:'2px',background:item.color,flexShrink:0}}/>
                        <span style={{flex:1,fontSize:'13px'}}>{item.label}</span>
                        <span style={{fontSize:'11px',color:'#5a7a9a'}}>가중치 {item.weight} ({Math.round((item.weight||1)/t*100)}%)</span>
                        <button style={{background:'none',border:'none',color:'#5a7a9a',cursor:'pointer',fontSize:'14px',padding:'0 4px'}} onClick={()=>removeRouletteItem(i)}>✕</button>
                      </div>
                    )
                  })}
                </div>
                <div style={{display:'flex',gap:'8px',marginTop:'12px',flexWrap:'wrap'}}>
                  <button style={btn('#9c27b0','#fff')} onClick={async()=>{
                    await api('vote_to_roulette')
                    const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'get_state'})})
                    const data=await r.json()
                    if(data.roulette?.items) setRouletteItems(data.roulette.items)
                  }}>← 투표 결과 갱신</button>
                  <button style={btn('#1e2840','#5a7a9a',true)} onClick={()=>{setRouletteItems([]);api('set_roulette',{items:[]})}}>전체 삭제</button>
                  <button style={btn('#1e2840','#5a7a9a',true)} onClick={()=>setShowRoulette(false)}>닫기</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <style>{`
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: #0d1117; }
        ::-webkit-scrollbar-thumb { background: #1f2d42; border-radius: 2px; }
        ::-webkit-scrollbar-thumb:hover { background: #2a3d58; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
      `}</style>
    </div>
  )
}
