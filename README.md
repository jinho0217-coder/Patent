# AMD그룹 특허 현황 대시보드

그룹(파트) 특허 포트폴리오를 한눈에 확인하는 웹 대시보드입니다.
데이터는 `data/patents.json` 을 기반으로 동작하며, 별도의 빌드 없이 정적 웹으로 실행됩니다.

## 주요 기능

- **KPI 요약**: 총 특허 수, 등록 완료(등록률), 출원·심사중, 올해 출원 건수
- **차트 시각화** (Chart.js)
  - 연도별 출원 추이 (라인)
  - 상태별 분포 (도넛)
  - 파트별 보유 현황 (상태별 누적 막대)
  - 기술 분야별 분포 (가로 막대)
- **파트 포트폴리오 비중** 바
- **특허 목록 테이블**
  - 통합 검색(특허명·발명자·출원/등록번호)
  - 파트 / 상태 / 기술분야 필터
  - 컬럼 정렬
  - **CSV 내보내기** (현재 필터 결과)
- **다크 모드** 토글 (설정 저장)
- 제공된 디자인 토큰(그린 테마, oklch) 그대로 적용

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
