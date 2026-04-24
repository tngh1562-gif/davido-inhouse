'use client'
import { useEffect, useRef, useState, useCallback } from 'react'

const COLORS = ['#4285f4','#ea4335','#34a853','#fbbc04','#9c27b0','#00bcd4','#ff5722','#607d8b']

interface VoteItem { label: string; votes: string[]; color: string }
interface Vote { active: boolean; title: string; items: VoteItem[]; startedAt: number | null }
interface RouletteItem { label: string; weight: number; color: string }

export default function Home() {
  const [tab, setTab] = useState<'vote'|'roulette'>('vote')
  const [chzzkConnected, setChzzkConnected] = useState(false)
  const [channelId, setChannelId] = useState('')
  const [inputCid, setInputCid] = useState('')
  const [chatLog, setChatLog] = useState<{nick:string,text:string}[]>([])

  // 투표
  const [vote, setVote] = useState<Vote>({ active: false, title: '', items: [], startedAt: null })
  const [voteTitle, setVoteTitle] = useState('블루팀 vs 레드팀')
  const [voteItemsText, setVoteItemsText] = useState('블루팀 승리\n레드팀 승리')

  // 룰렛
  const [rouletteItems, setRouletteItems] = useState<RouletteItem[]>([])
  const [rInput, setRInput] = useState('')
  const [rWeight, setRWeight] = useState('1')
  const [spinning, setSpinning] = useState(false)
  const [winner, setWinner] = useState<string|null>(null)
  const [angle, setAngle] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>()

  const api = useCallback(async (type: string, extra?: object) => {
    try {
      await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, ...extra }),
      })
    } catch(e) { console.error(e) }
  }, [])

  // SSE 연결
  useEffect(() => {
    const es = new EventSource('/api/stream')
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        switch(msg.type) {
          case 'full_state':
            setVote(msg.data.vote)
            setRouletteItems(msg.data.roulette.items)
            setChzzkConnected(msg.data.chzzkConnected)
            if (msg.data.channelId) setChannelId(msg.data.channelId)
            break
          case 'vote_started': case 'vote_update': case 'vote_ended':
            setVote(msg.data); break
          case 'vote_reset':
            setVote({ active:false, title:'', items:[], startedAt:null }); break
          case 'roulette_updated':
            setRouletteItems(msg.data.items); break
          case 'chzzk_connected':
            setChzzkConnected(true); setChannelId(msg.data.channelId); break
          case 'chzzk_disconnected':
            setChzzkConnected(false); break
          case 'chat':
            setChatLog(p => [...p.slice(-199), msg.data]); break
        }
      } catch {}
    }
    return () => es.close()
  }, [])

  // 룰렛 그리기
  useEffect(() => { drawWheel(angle) }, [rouletteItems, angle])

  function drawWheel(rot: number) {
    const c = canvasRef.current; if (!c) return
    const ctx = c.getContext('2d')!
    const W = c.width, H = c.height, cx = W/2, cy = H/2, r = Math.min(cx,cy) - 12
    ctx.clearRect(0, 0, W, H)
    if (!rouletteItems.length) {
      ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2)
      ctx.fillStyle='#131a24'; ctx.fill()
      ctx.fillStyle='#5a7a9a'; ctx.font='15px Noto Sans KR'; ctx.textAlign='center'
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
      ctx.font=`bold 12px Noto Sans KR`; ctx.textAlign='center'
      ctx.fillText(item.label.length>7?item.label.slice(0,7)+'…':item.label, 0, 0)
      ctx.restore(); a += slice
    })
    // 중앙
    ctx.beginPath(); ctx.arc(cx,cy,16,0,Math.PI*2)
    ctx.fillStyle='#07090f'; ctx.fill()
    ctx.strokeStyle='#e8b84b'; ctx.lineWidth=3; ctx.stroke()
    // 화살표
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
    const startAngle = angle
    const startTime = performance.now()
    const dur = 5000
    const animate = (now: number) => {
      const t = Math.min((now-startTime)/dur, 1)
      const ease = 1-Math.pow(1-t,4)
      const cur = startAngle+(finalAngle-startAngle)*ease
      setAngle(cur); drawWheel(cur)
      if (t<1) { animRef.current=requestAnimationFrame(animate) }
      else { setSpinning(false); setWinner(rouletteItems[winIdx].label); setAngle(cur%360) }
    }
    animRef.current = requestAnimationFrame(animate)
  }

  const S = {
    wrap: { fontFamily:"'Noto Sans KR',sans-serif", minHeight:'100vh', background:'#07090f', color:'#c8d8ec' } as React.CSSProperties,
    hdr: { background:'#0d1117', borderBottom:'1px solid #1f2d42', padding:'0 24px', display:'flex', alignItems:'stretch', gap:'0' } as React.CSSProperties,
    logo: { fontFamily:"'Rajdhani',sans-serif", fontSize:'20px', fontWeight:700, color:'#e8b84b', display:'flex', alignItems:'center', marginRight:'24px' } as React.CSSProperties,
    navBtn: (on:boolean) => ({ padding:'14px 20px', border:'none', borderBottom:on?'2px solid #e8b84b':'2px solid transparent', background:'none', color:on?'#e8b84b':'#5a7a9a', cursor:'pointer', fontSize:'13px', fontFamily:'inherit', fontWeight:on?700:400 } as React.CSSProperties),
    bar: { background:'#0d1117', borderBottom:'1px solid #1f2d42', padding:'9px 24px', display:'flex', alignItems:'center', gap:'10px', flexWrap:'wrap' as const, fontSize:'13px' } as React.CSSProperties,
    dot: (on:boolean) => ({ width:'8px', height:'8px', borderRadius:'50%', flexShrink:0, background:on?'#34a853':'#ea4335' } as React.CSSProperties),
    inp: { background:'#131a24', border:'1px solid #1f2d42', color:'#c8d8ec', borderRadius:'4px', padding:'7px 12px', fontSize:'13px', fontFamily:'inherit', outline:'none' } as React.CSSProperties,
    btn: (bg='#e8b84b', fg='#0d1117') => ({ padding:'7px 16px', borderRadius:'4px', border:'none', background:bg, color:fg, cursor:'pointer', fontSize:'13px', fontWeight:600, fontFamily:'inherit', whiteSpace:'nowrap' as const }) as React.CSSProperties,
    card: { background:'#0d1117', border:'1px solid #1f2d42', borderRadius:'6px', padding:'20px', marginBottom:'14px' } as React.CSSProperties,
    ct: { maxWidth:'1100px', margin:'0 auto', padding:'20px 24px' } as React.CSSProperties,
    label: { fontSize:'12px', color:'#5a7a9a', marginBottom:'5px', display:'block' } as React.CSSProperties,
    sec: { marginBottom:'14px' } as React.CSSProperties,
  }

  return (
    <div style={S.wrap}>
      {/* 헤더 */}
      <div style={S.hdr}>
        <div style={S.logo}>⚔ 다비도의 내전</div>
        {(['vote','roulette'] as const).map(t=>(
          <button key={t} style={S.navBtn(tab===t)} onClick={()=>setTab(t)}>
            {t==='vote'?'📊 채팅 투표':'🎡 룰렛'}
          </button>
        ))}
      </div>

      {/* 치지직 연결 바 */}
      <div style={S.bar}>
        <div style={S.dot(chzzkConnected)}/>
        <span style={{color:'#5a7a9a'}}>치지직 채팅</span>
        {chzzkConnected ? <>
          <span style={{color:'#34a853', fontWeight:600}}>{channelId.slice(0,12)}... 연결됨</span>
          <button style={S.btn('#ea4335','#fff')} onClick={()=>api('disconnect_chzzk')}>연결 해제</button>
        </> : <>
          <input style={{...S.inp, width:'300px'}} placeholder="채널 ID (URL 마지막 부분)" value={inputCid} onChange={e=>setInputCid(e.target.value)} onKeyDown={e=>e.key==='Enter'&&api('connect_chzzk',{channelId:inputCid})}/>
          <button style={S.btn()} onClick={()=>api('connect_chzzk',{channelId:inputCid})}>연결</button>
          <span style={{color:'#5a7a9a', fontSize:'12px'}}>예) chzzk.naver.com/<b style={{color:'#e8b84b'}}>여기 부분</b></span>
        </>}
        <div style={{marginLeft:'auto', display:'flex', gap:'6px', alignItems:'center', fontSize:'12px', color:'#5a7a9a'}}>
          채팅 명령어: <code style={{background:'#131a24', padding:'2px 6px', borderRadius:'3px', color:'#e8b84b'}}>!투표1</code> <code style={{background:'#131a24', padding:'2px 6px', borderRadius:'3px', color:'#e8b84b'}}>!투표2</code>
        </div>
      </div>

      <div style={S.ct}>

        {/* ── 투표 탭 ── */}
        {tab === 'vote' && (
          <div style={{display:'grid', gridTemplateColumns:'360px 1fr', gap:'20px', alignItems:'start'}}>

            {/* 설정 패널 */}
            <div>
              <div style={S.card}>
                <div style={{fontWeight:700, color:'#e8b84b', marginBottom:'16px', fontSize:'14px'}}>📊 투표 설정</div>
                <div style={S.sec}>
                  <label style={S.label}>투표 제목</label>
                  <input style={{...S.inp, width:'100%', boxSizing:'border-box'}} value={voteTitle} onChange={e=>setVoteTitle(e.target.value)}/>
                </div>
                <div style={S.sec}>
                  <label style={S.label}>투표 항목 (한 줄에 하나, 최대 8개)</label>
                  <textarea style={{...S.inp, width:'100%', height:'130px', resize:'vertical', boxSizing:'border-box', lineHeight:'1.6'}} value={voteItemsText} onChange={e=>setVoteItemsText(e.target.value)} placeholder={'블루팀 승리\n레드팀 승리\n무승부'}/>
                </div>
                <div style={{display:'flex', gap:'8px', flexWrap:'wrap'}}>
                  {!vote.active
                    ? <button style={S.btn()} onClick={()=>api('start_vote',{title:voteTitle, items:voteItemsText.split('\n').filter(i=>i.trim())})}>▶ 투표 시작</button>
                    : <button style={S.btn('#ea4335','#fff')} onClick={()=>api('end_vote')}>■ 투표 종료</button>
                  }
                  <button style={S.btn('#2a3d58','#c8d8ec')} onClick={()=>api('reset_vote')}>초기화</button>
                  {!vote.active && vote.items.length>0 &&
                    <button style={S.btn('#9c27b0','#fff')} onClick={()=>{api('vote_to_roulette'); setTab('roulette')}}>룰렛으로 →</button>
                  }
                </div>
              </div>

              {/* 채팅 로그 */}
              <div style={{...S.card, maxHeight:'280px', display:'flex', flexDirection:'column'}}>
                <div style={{fontWeight:700, color:'#e8b84b', marginBottom:'10px', fontSize:'14px', flexShrink:0}}>💬 채팅</div>
                <div style={{flex:1, overflowY:'auto', fontSize:'12px', lineHeight:'1.7'}}>
                  {!chzzkConnected
                    ? <div style={{color:'#5a7a9a', textAlign:'center', padding:'20px'}}>치지직 채널을 연결하세요</div>
                    : chatLog.length===0
                      ? <div style={{color:'#5a7a9a', textAlign:'center', padding:'20px'}}>채팅 대기 중...</div>
                      : [...chatLog].reverse().map((c,i)=>(
                          <div key={i} style={{padding:'2px 0', borderBottom:'1px solid rgba(31,45,66,.4)'}}>
                            <span style={{color:c.text.startsWith('!투표')?'#e8b84b':'#82b1ff', marginRight:'6px', fontWeight:500}}>{c.nick}</span>
                            <span style={{color:c.text.startsWith('!투표')?'#34a853':'#c8d8ec'}}>{c.text}</span>
                          </div>
                        ))
                  }
                </div>
              </div>
            </div>

            {/* 결과 패널 */}
            <div style={S.card}>
              <div style={{display:'flex', alignItems:'center', gap:'10px', marginBottom:'20px'}}>
                <div style={{fontWeight:700, fontSize:'16px'}}>{vote.title||'투표 결과'}</div>
                {vote.active && <span style={{fontSize:'11px', padding:'2px 10px', borderRadius:'20px', background:'rgba(52,168,83,.15)', color:'#34a853', border:'1px solid rgba(52,168,83,.3)', fontWeight:600}}>진행 중</span>}
                <span style={{marginLeft:'auto', fontSize:'13px', color:'#5a7a9a'}}>총 {vote.items.reduce((s,i)=>s+i.votes.length,0)}표</span>
              </div>
              {vote.items.length===0
                ? <div style={{textAlign:'center', padding:'60px 0', color:'#5a7a9a'}}>투표를 시작하면 여기에 실시간으로 표시됩니다</div>
                : vote.items.map((item, i) => {
                    const total = vote.items.reduce((s,it)=>s+it.votes.length, 0)
                    const pct = total>0 ? Math.round(item.votes.length/total*100) : 0
                    return (
                      <div key={i} style={{marginBottom:'18px'}}>
                        <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:'6px'}}>
                          <div style={{display:'flex', alignItems:'center', gap:'10px'}}>
                            <span style={{fontSize:'11px', padding:'2px 8px', borderRadius:'3px', background:item.color+'22', color:item.color, border:`1px solid ${item.color}44`, fontFamily:'monospace', fontWeight:600}}>!투표{i+1}</span>
                            <span style={{fontSize:'15px', fontWeight:500}}>{item.label}</span>
                          </div>
                          <div style={{display:'flex', alignItems:'baseline', gap:'8px'}}>
                            <span style={{fontSize:'22px', fontWeight:700, color:item.color}}>{pct}%</span>
                            <span style={{fontSize:'13px', color:'#5a7a9a'}}>{item.votes.length}표</span>
                          </div>
                        </div>
                        <div style={{height:'12px', background:'#131a24', borderRadius:'6px', overflow:'hidden'}}>
                          <div style={{height:'100%', width:`${pct}%`, background:item.color, borderRadius:'6px', transition:'width .4s ease'}}/>
                        </div>
                        {item.votes.length>0 && (
                          <div style={{marginTop:'5px', fontSize:'11px', color:'#5a7a9a'}}>
                            {item.votes.slice(0,15).join(' · ')}{item.votes.length>15?` 외 ${item.votes.length-15}명`:''}
                          </div>
                        )}
                      </div>
                    )
                  })
              }
            </div>
          </div>
        )}

        {/* ── 룰렛 탭 ── */}
        {tab === 'roulette' && (
          <div style={{display:'grid', gridTemplateColumns:'420px 1fr', gap:'20px', alignItems:'start'}}>

            {/* 룰렛 캔버스 */}
            <div style={{...S.card, textAlign:'center'}}>
              <canvas ref={canvasRef} width={380} height={380} style={{maxWidth:'100%', display:'block', margin:'0 auto'}}/>
              <div style={{marginTop:'16px'}}>
                <button style={{...S.btn(), fontSize:'15px', padding:'12px 36px', opacity:spinning||!rouletteItems.length?.5:1}} onClick={spin} disabled={spinning||!rouletteItems.length}>
                  {spinning ? '돌아가는 중...' : '🎡 돌리기'}
                </button>
              </div>
              {winner && (
                <div style={{marginTop:'16px', padding:'16px', background:'rgba(232,184,75,.1)', border:'1px solid rgba(232,184,75,.3)', borderRadius:'6px'}}>
                  <div style={{fontSize:'12px', color:'#5a7a9a', marginBottom:'6px'}}>🎉 당첨!</div>
                  <div style={{fontSize:'26px', fontWeight:700, color:'#e8b84b'}}>{winner}</div>
                </div>
              )}
            </div>

            {/* 항목 설정 */}
            <div>
              <div style={S.card}>
                <div style={{fontWeight:700, color:'#e8b84b', marginBottom:'14px', fontSize:'14px'}}>항목 추가</div>
                <div style={{display:'flex', gap:'8px', marginBottom:'14px', flexWrap:'wrap'}}>
                  <input style={{...S.inp, flex:1, minWidth:'150px'}} placeholder="항목명" value={rInput} onChange={e=>setRInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')addRouletteItem()}}/>
                  <div style={{display:'flex', alignItems:'center', gap:'6px'}}>
                    <span style={{fontSize:'12px', color:'#5a7a9a'}}>가중치</span>
                    <input style={{...S.inp, width:'60px', textAlign:'center'}} type="number" min="1" value={rWeight} onChange={e=>setRWeight(e.target.value)}/>
                  </div>
                  <button style={S.btn()} onClick={addRouletteItem}>추가</button>
                </div>

                {rouletteItems.length===0
                  ? <div style={{textAlign:'center', padding:'24px', color:'#5a7a9a', fontSize:'13px'}}>항목을 추가하거나 투표 결과를 가져오세요</div>
                  : <div style={{marginBottom:'12px'}}>
                      {rouletteItems.map((item, i) => (
                        <div key={i} style={{display:'flex', alignItems:'center', gap:'10px', padding:'8px 0', borderBottom:'1px solid #1f2d42'}}>
                          <div style={{width:'10px', height:'10px', borderRadius:'2px', background:item.color, flexShrink:0}}/>
                          <span style={{flex:1, fontSize:'13px'}}>{item.label}</span>
                          <span style={{fontSize:'11px', color:'#5a7a9a'}}>가중치 {item.weight}</span>
                          <span style={{fontSize:'11px', color:'#5a7a9a'}}>({Math.round((item.weight||1)/rouletteItems.reduce((s,it)=>s+(it.weight||1),0)*100)}%)</span>
                          <button style={{background:'none',border:'none',color:'#5a7a9a',cursor:'pointer',fontSize:'16px',padding:'0 4px'}} onClick={()=>removeRouletteItem(i)}>✕</button>
                        </div>
                      ))}
                    </div>
                }

                <div style={{display:'flex', gap:'8px', flexWrap:'wrap'}}>
                  <button style={S.btn('#9c27b0','#fff')} onClick={()=>api('vote_to_roulette').then(async()=>{
                    const r = await fetch('/api/action', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({type:'get_state'})})
                    const data = await r.json()
                    setRouletteItems(data.roulette.items)
                  })}>← 투표 결과 가져오기</button>
                  <button style={S.btn('#2a3d58','#c8d8ec')} onClick={()=>{setRouletteItems([]); api('set_roulette',{items:[]})}}>전체 삭제</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )

  function addRouletteItem() {
    if (!rInput.trim()) return
    const newItem = { label: rInput.trim(), weight: parseInt(rWeight)||1, color: COLORS[rouletteItems.length%COLORS.length] }
    const newItems = [...rouletteItems, newItem]
    setRouletteItems(newItems)
    api('set_roulette', { items: newItems })
    setRInput('')
  }

  function removeRouletteItem(idx: number) {
    const newItems = rouletteItems.filter((_,i)=>i!==idx)
    setRouletteItems(newItems)
    api('set_roulette', { items: newItems })
  }
}
