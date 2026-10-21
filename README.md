# 스페인 신혼여행 앱 (PWA)

2027.4.5 ~ 4.17 · 세비야 → 그라나다 → 마요르카 → 바르셀로나

## 파일
| 파일 | 역할 |
|---|---|
| `index.html` | 화면 뼈대 |
| `styles.css` | 디자인 (다크모드 지원) |
| `data.js` | 초기 일정·체크리스트·예약 데이터 (첫 실행 시 한 번만 사용) |
| `app.js` | 앱 동작 |
| `sw.js` | 오프라인 캐시 |
| `manifest.webmanifest`, `icons/` | 홈 화면 설치용 |

## 폰에 설치하기 (GitHub Pages, 무료)
1. github.com 가입 → New repository (예: `spain-trip`, Public)
2. "uploading an existing file" → 이 폴더의 파일 전부(icons 폴더 포함) 드래그해서 업로드 → Commit
3. Settings → Pages → Branch: `main` / `(root)` → Save
4. 1~2분 뒤 `https://<아이디>.github.io/spain-trip/` 접속
5. 홈 화면에 추가
   - 아이폰: **Safari**로 열기 → 공유 버튼 → "홈 화면에 추가"
   - 안드로이드: Chrome → ⋮ 메뉴 → "홈 화면에 추가" (또는 "앱 설치")
6. 비행기 모드로 켜서 열리는지 확인

## 데이터
- 데이터는 폰 안(localStorage)에만 저장됩니다. 서버로 전송되지 않습니다.
- 폰마다 따로 저장되므로 두 사람이 같이 쓰려면: 한 명이 ⚙ → 내보내기 → 파일 공유 → 다른 폰에서 가져오기.
- 출국 전에 꼭 한 번 백업해 두세요.

## 수정 후 다시 배포할 때
`sw.js`의 `CACHE = 'spain-trip-v1'` 숫자를 올려야 폰에 새 버전이 반영됩니다.
(앱에서 입력한 데이터는 그대로 유지됩니다.)
