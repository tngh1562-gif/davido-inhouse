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
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>()

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

  const inp: React.CSSProperties = { background:'#131a24', border:'1px solid #1f2d42', color:'#c8d8ec', borderRadius:'4px', padding:'7px 12px', fontSize:'13px', fontFamily:'inherit', outline:'none' }
  const card: React.CSSProperties = { background:'#0d1117', border:'1px solid #1f2d42', borderRadius:'6px', padding:'20px', marginBottom:'14px' }
  const btn = (bg='#e8b84b', fg='#0d1117'): React.CSSProperties => ({ padding:'7px 16px', borderRadius:'4px', border:'none', background:bg, color:fg, cursor:'pointer', fontSize:'13px', fontWeight:600, fontFamily:'inherit', whiteSpace:'nowrap' })
  const navBtn = (on:boolean): React.CSSProperties => ({ padding:'14px 20px', border:'none', borderBottom:on?'2px solid #e8b84b':'2px solid transparent', background:'none', color:on?'#e8b84b':'#5a7a9a', cursor:'pointer', fontSize:'13px', fontFamily:'inherit', fontWeight:on?700:400 })

  // ── 비밀번호 화면 ──
  if (!auth) return (
    <div style={{minHeight:'100vh',background:'#07090f',display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'sans-serif'}}>
      <div style={{background:'#0d1117',border:'1px solid #1f2d42',borderRadius:'8px',padding:'44px 52px',textAlign:'center',minWidth:'340px'}}>
        <div style={{fontSize:'24px',fontWeight:700,color:'#e8b84b',marginBottom:'6px'}}>⚔ 다비도의 내전</div>
        <div style={{fontSize:'13px',color:'#5a7a9a',marginBottom:'28px'}}>비밀번호를 입력하세요</div>
        <input type="password" value={pwInput} autoFocus
          onChange={e=>{setPwInput(e.target.value);setPwError(false)}}
          onKeyDown={e=>{if(e.key==='Enter'){if(pwInput===PASSWORD)setAuth(true);else setPwError(true)}}}
          placeholder="비밀번호"
          style={{...inp,width:'100%',boxSizing:'border-box',marginBottom:'8px',fontSize:'14px',padding:'10px 14px',border:`1px solid ${pwError?'#ea4335':'#1f2d42'}`}}
        />
        {pwError&&<div style={{fontSize:'12px',color:'#ea4335',marginBottom:'8px'}}>비밀번호가 틀렸습니다</div>}
        <button onClick={()=>{if(pwInput===PASSWORD)setAuth(true);else setPwError(true)}}
          style={{width:'100%',padding:'11px',borderRadius:'4px',border:'none',background:'#e8b84b',color:'#0d1117',fontWeight:700,fontSize:'14px',fontFamily:'inherit',cursor:'pointer',marginTop:'4px'}}>
          입장
        </button>
      </div>
    </div>
  )

  const total = vote.items.reduce((s,i)=>s+i.votes.length, 0)

  return (
    <div style={{fontFamily:'sans-serif',minHeight:'100vh',background:'#07090f',color:'#c8d8ec'}}>

      {/* 헤더 탭 */}
      <div style={{background:'#0d1117',borderBottom:'1px solid #1f2d42',padding:'0 24px',display:'flex',alignItems:'stretch'}}>
        <div style={{fontSize:'18px',fontWeight:700,color:'#e8b84b',display:'flex',alignItems:'center',marginRight:'20px'}}>⚔ 다비도의 내전</div>
        <button style={navBtn(tab==='inhouse')} onClick={()=>setTab('inhouse')}>⚔ 내전 진행</button>
        <button style={navBtn(tab==='vote')} onClick={()=>setTab('vote')}>📊 채팅 투표</button>
      </div>

      {/* 치지직 연결 바 - 투표 탭에서만 */}
      {tab==='vote' && (
        <div style={{background:'#0d1117',borderBottom:'1px solid #1f2d42',padding:'9px 24px',display:'flex',alignItems:'center',gap:'10px',flexWrap:'wrap',fontSize:'13px'}}>
          <div style={{width:'8px',height:'8px',borderRadius:'50%',background:chzzkConnected?'#34a853':'#ea4335',flexShrink:0}}/>
          <span style={{color:'#5a7a9a'}}>치지직 채팅</span>
          {chzzkConnected ? <>
            <span style={{color:'#34a853',fontWeight:600}}>{channelId.slice(0,16)}... 연결됨</span>
            <button style={btn('#ea4335','#fff')} onClick={()=>api('disconnect_chzzk')}>연결 해제</button>
          </> : <>
            <input style={{...inp,width:'280px'}} placeholder="채널 ID (URL 마지막 부분)" value={inputCid} onChange={e=>setInputCid(e.target.value)} onKeyDown={e=>e.key==='Enter'&&api('connect_chzzk',{channelId:inputCid})}/>
            <button style={btn()} onClick={()=>api('connect_chzzk',{channelId:inputCid})}>연결</button>
            <span style={{color:'#5a7a9a',fontSize:'12px'}}>예) chzzk.naver.com/<b style={{color:'#e8b84b'}}>여기 부분</b></span>
          </>}
          <div style={{marginLeft:'auto',display:'flex',gap:'6px',alignItems:'center',fontSize:'12px',color:'#5a7a9a'}}>
            채팅 명령어:
            {['1','2','3','4','5','6','7','8'].map(n=>(
              <code key={n} style={{background:'#131a24',padding:'2px 7px',borderRadius:'3px',color:'#e8b84b'}}>!투표{n}</code>
            ))}
          </div>
        </div>
      )}

      {/* 내전 진행 탭 */}
      {tab==='inhouse' && (
        <iframe src="/inhouse.html" style={{width:'100%',height:'calc(100vh - 53px)',border:'none',display:'block'}} title="내전 진행"/>
      )}

      {/* 투표 탭 */}
      {tab==='vote' && (
        <div style={{maxWidth:'1200px',margin:'0 auto',padding:'20px 24px'}}>
          <div style={{display:'grid',gridTemplateColumns:'320px 1fr',gap:'20px',alignItems:'start'}}>

            {/* 왼쪽: 설정 + 채팅 */}
            <div>
              <div style={card}>
                <div style={{fontWeight:700,color:'#e8b84b',marginBottom:'14px',fontSize:'14px'}}>📊 투표 설정</div>
                <div style={{marginBottom:'10px'}}>
                  <div style={{fontSize:'12px',color:'#5a7a9a',marginBottom:'4px'}}>투표 제목</div>
                  <input style={{...inp,width:'100%',boxSizing:'border-box'}} value={voteTitle} onChange={e=>setVoteTitle(e.target.value)}/>
                </div>
                <div style={{marginBottom:'14px'}}>
                  <div style={{fontSize:'12px',color:'#5a7a9a',marginBottom:'4px'}}>투표 항목 (한 줄에 하나)</div>
                  <textarea style={{...inp,width:'100%',height:'120px',resize:'vertical',boxSizing:'border-box',lineHeight:'1.8'}} value={voteItemsText} onChange={e=>setVoteItemsText(e.target.value)}/>
                </div>
                <div style={{display:'flex',gap:'8px',flexWrap:'wrap'}}>
                  {!vote.active
                    ? <button style={btn()} onClick={()=>api('start_vote',{title:voteTitle,items:voteItemsText.split('\n').filter(i=>i.trim())})}>▶ 투표 시작</button>
                    : <button style={btn('#ea4335','#fff')} onClick={()=>api('end_vote')}>■ 투표 종료</button>
                  }
                  <button style={btn('#2a3d58','#c8d8ec')} onClick={()=>api('reset_vote')}>초기화</button>
                  {!vote.active&&vote.items.length>0&&(
                    <button style={btn('#9c27b0','#fff')} onClick={()=>{api('vote_to_roulette');setShowRoulette(true)}}>🎡 룰렛으로</button>
                  )}
                </div>
              </div>

              {/* 채팅 로그 */}
              <div style={{...card,maxHeight:'300px',display:'flex',flexDirection:'column'}}>
                <div style={{fontWeight:700,color:'#e8b84b',marginBottom:'10px',fontSize:'14px',flexShrink:0}}>💬 실시간 채팅</div>
                <div style={{flex:1,overflowY:'auto',fontSize:'12px',lineHeight:'1.8'}}>
                  {!chzzkConnected
                    ? <div style={{color:'#5a7a9a',textAlign:'center',padding:'20px'}}>위에서 채널을 연결하세요</div>
                    : chatLog.length===0
                      ? <div style={{color:'#5a7a9a',textAlign:'center',padding:'20px'}}>채팅 대기 중...</div>
                      : [...chatLog].reverse().map((c,i)=>(
                          <div key={i} style={{padding:'2px 0',borderBottom:'1px solid rgba(31,45,66,.4)'}}>
                            <span style={{color:c.text.startsWith('!투표')?'#e8b84b':'#82b1ff',marginRight:'6px',fontWeight:500}}>{c.nickname}</span>
                            <span style={{color:c.text.startsWith('!투표')?'#34a853':'#c8d8ec'}}>{c.text}</span>
                          </div>
                        ))
                  }
                </div>
              </div>
            </div>

            {/* 오른쪽: 실시간 투표 결과 */}
            <div style={card}>
              <div style={{display:'flex',alignItems:'center',gap:'10px',marginBottom:'20px'}}>
                <div style={{fontWeight:700,fontSize:'16px'}}>{vote.title||'투표 결과'}</div>
                {vote.active&&<span style={{fontSize:'11px',padding:'3px 10px',borderRadius:'20px',background:'rgba(52,168,83,.15)',color:'#34a853',border:'1px solid rgba(52,168,83,.3)',fontWeight:600}}>● 진행 중</span>}
                <span style={{marginLeft:'auto',fontSize:'13px',color:'#5a7a9a'}}>총 {total}표</span>
              </div>

              {vote.items.length===0
                ? <div style={{textAlign:'center',padding:'60px 0',color:'#5a7a9a',fontSize:'14px'}}>투표를 시작하면 여기에 실시간으로 표시됩니다</div>
                : vote.items.map((item,i)=>{
                    const pct = total>0 ? Math.round(item.votes.length/total*100) : 0
                    return (
                      <div key={i} style={{display:'grid',gridTemplateColumns:'140px 1fr',gap:'12px',alignItems:'center',marginBottom:'16px'}}>
                        {/* 왼쪽: 라벨 */}
                        <div>
                          <div style={{fontSize:'11px',color:item.color,fontFamily:'monospace',fontWeight:700,marginBottom:'3px'}}>!투표{i+1}</div>
                          <div style={{fontSize:'17px',fontWeight:700,color:'#c8d8ec'}}>{item.label}</div>
                        </div>
                        {/* 오른쪽: 바 + 숫자 */}
                        <div>
                          <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:'6px'}}>
                            <span style={{fontSize:'13px',color:'#5a7a9a'}}>{item.votes.length}표</span>
                            <span style={{fontSize:'20px',fontWeight:700,color:item.color}}>{pct}%</span>
                          </div>
                          <div style={{height:'14px',background:'#192030',borderRadius:'7px',overflow:'hidden'}}>
                            <div style={{height:'100%',width:`${pct}%`,background:item.color,borderRadius:'7px',transition:'width .4s ease'}}/>
                          </div>
                          {item.votes.length>0&&(
                            <div style={{marginTop:'4px',fontSize:'11px',color:'#5a7a9a'}}>
                              {item.votes.slice(0,12).join(', ')}{item.votes.length>12?` 외 ${item.votes.length-12}명`:''}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })
              }
            </div>
          </div>

          {/* 룰렛 섹션 (투표 결과 가져오기 누르면 펼쳐짐) */}
          {showRoulette && (
            <div style={{marginTop:'20px',display:'grid',gridTemplateColumns:'420px 1fr',gap:'20px',alignItems:'start'}}>
              <div style={{...card,textAlign:'center'}}>
                <div style={{fontWeight:700,color:'#e8b84b',marginBottom:'14px',fontSize:'14px'}}>🎡 룰렛</div>
                <canvas ref={canvasRef} width={360} height={360} style={{maxWidth:'100%',display:'block',margin:'0 auto'}}/>
                <div style={{marginTop:'14px'}}>
                  <button style={{...btn(),fontSize:'14px',padding:'10px 32px',opacity:spinning||!rouletteItems.length?.5:1}} onClick={spin} disabled={spinning||!rouletteItems.length}>
                    {spinning?'돌아가는 중...':'🎡 돌리기'}
                  </button>
                </div>
                {winner&&(
                  <div style={{marginTop:'14px',padding:'14px',background:'rgba(232,184,75,.1)',border:'1px solid rgba(232,184,75,.3)',borderRadius:'6px'}}>
                    <div style={{fontSize:'12px',color:'#5a7a9a',marginBottom:'4px'}}>🎉 당첨!</div>
                    <div style={{fontSize:'24px',fontWeight:700,color:'#e8b84b'}}>{winner}</div>
                  </div>
                )}
              </div>
              <div style={card}>
                <div style={{fontWeight:700,color:'#e8b84b',marginBottom:'12px',fontSize:'14px'}}>항목 설정</div>
                <div style={{display:'flex',gap:'8px',marginBottom:'12px',flexWrap:'wrap'}}>
                  <input style={{...inp,flex:1,minWidth:'120px'}} placeholder="항목명" value={rInput} onChange={e=>setRInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addRouletteItem()}/>
                  <div style={{display:'flex',alignItems:'center',gap:'6px'}}>
                    <span style={{fontSize:'12px',color:'#5a7a9a'}}>가중치</span>
                    <input style={{...inp,width:'56px',textAlign:'center'}} type="number" min="1" value={rWeight} onChange={e=>setRWeight(e.target.value)}/>
                  </div>
                  <button style={btn()} onClick={addRouletteItem}>추가</button>
                </div>
                {rouletteItems.map((item,i)=>{
                  const t=rouletteItems.reduce((s,it)=>s+(it.weight||1),0)
                  return (
                    <div key={i} style={{display:'flex',alignItems:'center',gap:'8px',padding:'7px 0',borderBottom:'1px solid #1f2d42'}}>
                      <div style={{width:'10px',height:'10px',borderRadius:'2px',background:item.color,flexShrink:0}}/>
                      <span style={{flex:1,fontSize:'13px'}}>{item.label}</span>
                      <span style={{fontSize:'11px',color:'#5a7a9a'}}>가중치 {item.weight} ({Math.round((item.weight||1)/t*100)}%)</span>
                      <button style={{background:'none',border:'none',color:'#5a7a9a',cursor:'pointer',fontSize:'15px'}} onClick={()=>removeRouletteItem(i)}>✕</button>
                    </div>
                  )
                })}
                <div style={{display:'flex',gap:'8px',marginTop:'12px'}}>
                  <button style={btn('#9c27b0','#fff')} onClick={async()=>{
                    await api('vote_to_roulette')
                    const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'get_state'})})
                    const data=await r.json()
                    if(data.roulette?.items) setRouletteItems(data.roulette.items)
                  }}>← 투표 결과 갱신</button>
                  <button style={btn('#2a3d58','#c8d8ec')} onClick={()=>{setRouletteItems([]);api('set_roulette',{items:[]})}}>전체 삭제</button>
                  <button style={btn('#607080','#c8d8ec')} onClick={()=>setShowRoulette(false)}>닫기</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
