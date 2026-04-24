// 유튜브 비공식 검색 (API 키 불필요)
export interface YTTrack {
  videoId: string
  title: string
  channel: string
  thumbnail: string
  duration?: string
}

export async function searchYouTube(query: string, maxResults = 8): Promise<YTTrack[]> {
  try {
    const encoded = encodeURIComponent(query)
    const url = `https://www.youtube.com/results?search_query=${encoded}&sp=EgIQAQ%3D%3D`
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      }
    })
    const html = await res.text()

    const match = html.match(/var ytInitialData = (\{.+?\});<\/script>/)
    if (!match) return []

    const data = JSON.parse(match[1])
    const contents = data?.contents?.twoColumnSearchResultsRenderer
      ?.primaryContents?.sectionListRenderer?.contents?.[0]
      ?.itemSectionRenderer?.contents

    if (!contents) return []

    const results: YTTrack[] = []
    for (const item of contents) {
      const video = item?.videoRenderer
      if (!video?.videoId) continue

      const title = video.title?.runs?.[0]?.text || ''
      const channel = video.ownerText?.runs?.[0]?.text || ''
      const thumbnail = `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`
      const duration = video.lengthText?.simpleText || ''

      results.push({ videoId: video.videoId, title, channel, thumbnail, duration })
      if (results.length >= maxResults) break
    }
    return results
  } catch (e) {
    console.error('[YouTube] search error:', e)
    return []
  }
}
