# Rotten Tomatoes Reviews Scraper

Extract Rotten Tomatoes movie reviews with a single run. Collect critic or audience review records at scale with clean, analysis-ready fields for research, trend tracking, and sentiment monitoring.

## Features

- **URL list input** - Add one or more Rotten Tomatoes movie URLs in a single run.
- **Multiple review modes** - Collect All Critics, Top Critics, All Audience, or Verified Audience reviews.
- **Pagination support** - Automatically fetches additional pages until your limits are reached.
- **Clean output** - Removes null and empty values from dataset items.
- **Production-ready controls** - Includes result caps, page caps, and proxy configuration.

## Use Cases

### Sentiment Analysis
Build review datasets to measure audience and critic sentiment over time. Compare title-level trends across release windows.

### Market Intelligence
Track reception of new releases and sequels. Identify how review tone changes between critic groups and audience segments.

### Content Research
Collect quote-level review data for editorial summaries, dashboards, and reporting.

### Competitive Comparison
Compare review signals across multiple titles using the same structured output format.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `urls` | Array<String> | No | `["https://www.rottentomatoes.com/m/mortal_kombat_ii#critics-reviews"]` | One or more Rotten Tomatoes movie URLs. Supports `/reviews`, query params, and hash fragments. |
| `reviewType` | String | No | `"all-critics"` | One of `all-critics`, `top-critics`, `all-audience`, `verified-audience`. |
| `results_wanted` | Integer | No | `20` | Maximum number of reviews to collect. |
| `max_pages` | Integer | No | `10` | Maximum pages to request per movie. |
| `proxyConfiguration` | Object | No | Apify Proxy Residential | Proxy settings for reliable collection. |

---

## Output Data

Each dataset item can include:

| Field | Type | Description |
|-------|------|-------------|
| `movieTitle` | String | Movie title |
| `queryReviewType` | String | Selected review mode |
| `movieUrl` | String | Canonical movie URL |
| `movieVanity` | String | Movie vanity slug |
| `movieEmsId` | String | Internal movie identifier |
| `rottenTomatoesMovieId` | String | Rotten Tomatoes movie ID |
| `fandangoMovieId` | String | Fandango movie ID |
| `releaseDate` | String | Release date |
| `releaseLifecycle` | String | Release lifecycle status |
| `tomatometerScore` | String | Tomatometer score |
| `tomatometerSentiment` | String | Tomatometer sentiment |
| `audienceScore` | String | Audience score |
| `audienceSentiment` | String | Audience sentiment |
| `criticsConsensus` | String | Critics consensus |
| `audienceConsensus` | String | Audience consensus |
| `reviewId` | String | Critic review ID |
| `ratingId` | String | Audience rating ID |
| `createDate` | String | Review creation timestamp |
| `updateDate` | String | Review update timestamp |
| `scoreSentiment` | String | Review sentiment |
| `originalScore` | String | Original critic score text |
| `rating` | String | Audience rating value |
| `isTopReview` | Boolean | Top critic flag |
| `isFresh` | Boolean | Fresh flag |
| `isRotten` | Boolean | Rotten flag |
| `quote` | String | Review text |
| `fullReviewUrl` | String | External full review link |
| `isSpoiler` | Boolean | Spoiler flag |
| `hasProfanity` | Boolean | Profanity flag |
| `isVerified` | Boolean | Verified audience flag |
| `isSuperReviewer` | Boolean | Super reviewer flag |
| `userDisplayName` | String | Audience display name |
| `userInitials` | String | Audience initials |
| `userRealm` | String | Audience user realm |
| `criticName` | String | Critic name |
| `criticSlug` | String | Critic slug |
| `publicationName` | String | Publication name |
| `publicationUrl` | String | Publication URL |
| `publicationIconUrl` | String | Publication icon URL |
| `rawReview` | Object | Original review payload |

---

## Usage Examples

### Basic URL Run

```json
{
  "urls": [
    "https://www.rottentomatoes.com/m/mortal_kombat_ii#critics-reviews"
  ],
  "results_wanted": 20,
  "max_pages": 5
}
```

### Audience Reviews Only

```json
{
  "urls": [
    "https://www.rottentomatoes.com/m/mortal_kombat_ii/reviews?type=user"
  ],
  "reviewType": "all-audience",
  "results_wanted": 40
}
```

### Multi-URL Run

```json
{
  "urls": [
    "https://www.rottentomatoes.com/m/inception",
    "https://www.rottentomatoes.com/m/mortal_kombat_ii#critics-reviews"
  ],
  "reviewType": "top-critics",
  "results_wanted": 30,
  "max_pages": 3
}
```

---

## Sample Output

```json
{
  "queryReviewType": "all-critics",
  "page": 1,
  "movieTitle": "Mortal Kombat II",
  "movieUrl": "https://www.rottentomatoes.com/m/mortal_kombat_ii",
  "movieVanity": "mortal_kombat_ii",
  "movieEmsId": "94e1d509-39a2-4c9b-8ca8-ef6ea6e92c39",
  "rottenTomatoesMovieId": "900088891",
  "createDate": "2026-05-11T22:16:45.000Z",
  "scoreSentiment": "POSITIVE",
  "originalScore": "3.5/5",
  "isTopReview": false,
  "quote": "A film like this is never going to get the emotional beats right.",
  "criticName": "Aisha Harris",
  "publicationName": "NPR",
  "fullReviewUrl": "https://www.npr.org/transcripts/nx-s1-5814848"
}
```

---

## Tips for Best Results

### Start With Working Movie URLs
- Use canonical movie pages under `/m/<slug>`.
- URLs with `/reviews` also work.

### Keep QA Runs Fast
- Use `results_wanted: 20` for quick validation.
- Keep `max_pages` low during initial testing.

### Choose the Right Review Mode
- Use `all-critics` for broad critic coverage.
- Use `verified-audience` when you need ticket-verified user reviews.

### Proxy Configuration

```json
{
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

---

## Integrations

Connect dataset output to:

- **Google Sheets** - Quick team reporting
- **Airtable** - Structured review databases
- **Looker Studio** - Dashboards and trend charts
- **Webhooks** - Push results into internal systems
- **Make** - Automation workflows
- **Zapier** - No-code app automations

### Export Formats

- **JSON** - API and app integrations
- **CSV** - Spreadsheet workflows
- **Excel** - Business reporting
- **XML** - System interoperability

---

## Frequently Asked Questions

### How many movie URLs can I provide?
You can provide one or multiple URLs in `urls`.

### Can I scrape audience and critic reviews in one run?
Each run uses one `reviewType`. Run twice with different `reviewType` values for both.

### Why are some fields missing in some items?
Not every review includes every field. Empty values are automatically removed.

### Can I collect all available reviews?
Yes. Increase `results_wanted` and `max_pages` based on your needs.

---

## Support

For issues or feature requests, use the Apify Console issue flow.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [Apify API Reference](https://docs.apify.com/api/v2)
- [Apify Scheduling](https://docs.apify.com/platform/schedules)

---

## Legal Notice

This actor is intended for legitimate data collection. You are responsible for complying with website terms and applicable laws.
