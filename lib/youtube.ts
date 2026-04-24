// 유튜브 비공식 검색 (API 키 불필요)
export async function searchYouTube(query: string): Promise<{
  videoId: string
  title: string
  channel: string
  thumbnail: string
} | null> {
  try {
    const encoded = encodeURIComponent(query)
    const url = `https://www.youtube.com/results?search_query=${encoded}&sp=EgIQAQ%3D%3D`
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      }
    })
    const html = await res.text()

    // ytInitialData에서 첫 번째 영상 파싱
    const match = html.match(/var ytInitialData = ({.+?});<\/script>/)
    if (!match) return null

    const data = JSON.parse(match[1])
    const contents = data?.contents?.twoColumnSearchResultsRenderer
      ?.primaryContents?.sectionListRenderer?.contents?.[0]
      ?.itemSectionRenderer?.contents

    if (!contents) return null

    for (const item of contents) {
      const video = item?.videoRenderer
      if (!video?.videoId) continue

      const title = video.title?.runs?.[0]?.text || ''
      const channel = video.ownerText?.runs?.[0]?.text || ''
      const thumbnail = `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`

      return { videoId: video.videoId, title, channel, thumbnail }
    }
    return null
  } catch (e) {
    console.error('[YouTube] search error:', e)
    return null
  }
}
