# API Discovery

## Selected API
- Endpoint: `https://www.rottentomatoes.com/napi/rtcf/v1/movies/{emsId}/reviews`
- Method: `GET`
- Auth: None for review calls
- Pagination: cursor-based query params (`after`, `before`) with `pageInfo.hasNextPage`, `pageInfo.endCursor`, `pageInfo.startCursor`
- Fields available: critic and audience review payloads including `reviewId` / `ratingId`, sentiment, dates, quote/review text, critic/publication/user metadata, verification flags, and more
- Fields currently missing in old actor: all movie/review-specific Rotten Tomatoes fields
- Field count: 30+ useful fields after mapping and cleanup

## Supporting Endpoint
- Endpoint: `https://www.rottentomatoes.com/napi/rtcf/v1/movies/{emsId}`
- Method: `GET`
- Purpose: enrich reviews with movie metadata (title, IDs, score blocks, consensus, lifecycle)

## Query Model Used
- `after`: cursor
- `before`: cursor
- `pageCount`: page size (20)
- `topOnly`: `true|false`
- `type`: `critic|audience`
- `verified`: `true|false`

## Why This API Was Selected
- Direct JSON response
- Rich review + metadata coverage
- Reliable pagination model
- Works with direct HTTP requests via `gotScraping`

## Weaker Candidates Rejected
- `/napi/search/all` (POST): protected with CSRF/session requirements from browser state
- Legacy `/napi/movie/*` patterns: return 404 on current site behavior
- HTML review parsing: rejected in favor of structured API output

## Notes
- URLScan workflow was attempted but required API key from this environment.
- Keyword fallback resolves a movie URL first, then all review extraction remains API-based.
