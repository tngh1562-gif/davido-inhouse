import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '다비도의 내전',
  description: '치지직 내전 투표/룰렛',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&family=Rajdhani:wght@700&display=swap" rel="stylesheet"/>
      </head>
      <body style={{ margin: 0, padding: 0, background: '#07090f', color: '#c8d8ec' }}>
        {children}
      </body>
    </html>
  )
}
