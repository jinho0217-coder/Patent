# 현황 대시보드

포트폴리오를 한눈에 확인하는 웹 대시보드입니다.
데이터는 `data/patents.json` 을 기반으로 동작하며, 별도의 빌드 없이 정적 웹으로 실행됩니다.

## 실행 방법

`fetch` 로 JSON을 불러오므로 `index.html` 을 더블클릭해 `file://` 로 열면
브라우저 보안정책(CORS)에 의해 데이터 로드가 차단됩니다. **로컬 서버**로 실행하세요.

### Python (설치되어 있으면 가장 간단)

```bash
python -m http.server 5500
```

→ 브라우저에서 http://localhost:5500 접속

### Node.js

```bash
npx serve -l 5500
```

### VS Code

`Live Server` 확장 설치 후 `index.html`에서 "Go Live" 클릭

## 파일 구조

```
Patent System/
├─ index.html        # 페이지 구조
├─ styles.css        # 디자인 토큰 + 컴포넌트 스타일
├─ app.js            # JSON 로드, 통계/차트/테이블/필터 로직
├─ data/
│  └─ patents.json   # 특허 데이터 (소스)
└─ README.md
```

## 데이터 수정 / 확장

`data/patents.json` 만 수정하면 화면이 자동 반영됩니다.

- `companies`: 파트 목록 (`id`, `name`, `color` — color는 `chart-1`~`chart-5`)
- `statusMeta`: 상태 정의 (`id`, `label`, `tone` — `primary`/`accent`/`destructive`/`muted`)
- `patents`: 특허 레코드
  - `id`(관리번호), `title`, `company`(파트 id), `status`(상태 id),
    `field`(기술분야), `country`, `inventor`, `filingDate`, `regDate`,
    `appNo`(출원번호), `regNo`(등록번호)

실제 데이터로 교체하면 그대로 사내 IP 관리 대시보드로 사용할 수 있습니다.
