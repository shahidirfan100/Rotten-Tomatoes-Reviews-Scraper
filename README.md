# Rotten Tomatoes Reviews Scraper

Extract Rotten Tomatoes movie reviews with a single run. Collect critic or audience review records at scale with clean, analysis-ready fields for research, trend tracking, and sentiment monitoring.

## Features

- **URL list input** - Add one or more Rotten Tomatoes movie URLs in a single run.
- **Multiple review modes** - Collect All Critics, Top Critics, All Audience, or Verified Audience reviews.
- **Resilient collection** - Automatically retries temporary failures, rotates request profiles, and keeps collecting when one title is temporarily unavailable.
- **Rich review records** - Captures review text, sentiment, scores, dates, critic and publication details, audience ratings, and verification flags.
- **Clean output** - Removes null and empty values from dataset items so every record is ready to use.
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
| `urls` | Array<String> | No | `["https://www.rottentomatoes.com/m/inception"]` | One or more Rotten Tomatoes movie URLs. Accepts `/reviews`, query params, and hash fragments. |
| `reviewType` | String | No | `"all-critics"` | One of `all-critics`, `top-critics`, `all-audience`, `verified-audience`. |
| `results_wanted` | Integer | No | `20` | Maximum number of reviews to collect. |
| `max_pages` | Integer | No | `10` | Maximum pages to request per movie. |
| `proxyConfiguration` | Object | No | Apify Proxy disabled | Proxy settings for request routing. |

---

## Output Data

Each dataset item can include:

| Field | Type | Description |
|-------|------|-------------|
| `movieTitle` | String | Movie title |
| `movieUrl` | String | Canonical movie URL |
| `movieVanity` | String | Movie slug |
| `movieEmsId` | String | Movie identifier |
| `releaseDate` | String | Release date |
| `releaseLifecycle` | String | Release lifecycle status |
| `tomatometerScore` | String | Tomatometer score |
| `tomatometerSentiment` | String | Tomatometer sentiment |
| `tomatometerReviews` | Number | Number of critic reviews counted |
| `audienceScore` | String | Audience score |
| `audienceSentiment` | String | Audience sentiment |
| `audienceReviews` | Number | Number of audience reviews counted |
| `criticsConsensus` | String | Critics consensus text |
| `queryReviewType` | String | Selected review mode |
| `source` | String | Where the record was collected from |
| `page` | Number | Result page number |
| `createDate` | String | Review publication date |
| `scoreSentiment` | String | Review sentiment (critic reviews) |
| `originalScore` | String | Original critic score text |
| `rating` | String | Audience star rating |
| `ratingRange` | String | Audience rating description |
| `quote` | String | Review text |
| `fullReviewUrl` | String | External full review link |
| `isTopReview` | Boolean | Top review flag |
| `isTopCritic` | Boolean | Top critic flag (critic reviews) |
| `isFresh` | Boolean | Fresh flag (critic reviews) |
| `isRotten` | Boolean | Rotten flag (critic reviews) |
| `isVerified` | Boolean | Verified audience flag |
| `isFandangoReview` | Boolean | Fandango-sourced audience review |
| `userDisplayName` | String | Audience display name |
| `userInitials` | String | Audience initials |
| `userRealm` | String | Audience account realm |
| `userProfileLink` | String | Audience profile link |
| `criticName` | String | Critic name |
| `criticSlug` | String | Critic slug |
| `publicationName` | String | Publication name |
| `publicationUrl` | String | Publication link |
| `rawReview` | Object | Original review payload |

---

## Usage Examples

### Basic URL Run

```json
{
  "urls": [
    "https://www.rottentomatoes.com/m/inception"
  ],
  "results_wanted": 20,
  "max_pages": 5
}
```

### Audience Reviews Only

```json
{
  "urls": [
    "https://www.rottentomatoes.com/m/inception/reviews?type=user"
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
    "https://www.rottentomatoes.com/m/the_dark_knight"
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
  "movieTitle": "Inception",
  "movieUrl": "https://www.rottentomatoes.com/m/inception",
  "movieVanity": "inception",
  "movieEmsId": "afbf1c81-1bfe-3996-9cbc-2e1be23d1f61",
  "releaseDate": "2010-07-16",
  "releaseLifecycle": "OUT_OF_THEATERS",
  "tomatometerScore": "86",
  "tomatometerSentiment": "POSITIVE",
  "audienceScore": "91",
  "audienceSentiment": "POSITIVE",
  "criticsConsensus": "Smart, innovative, and thrilling, Inception is that rare summer blockbuster that succeeds viscerally as well as intellectually.",
  "source": "public-page",
  "queryReviewType": "all-critics",
  "page": 1,
  "createDate": "Mar 20, 2024",
  "scoreSentiment": "POSITIVE",
  "isTopReview": true,
  "isTopCritic": true,
  "isFresh": true,
  "quote": "Nolan is exploring dreams and the possibilities are endless, which is why it's a little disappointing that so much of the film feels like a generic CGI action movie, albeit a high-class one.",
  "criticName": "Wendy Ide",
  "criticSlug": "wendy-ide",
  "publicationName": "The Times (UK)",
  "fullReviewUrl": "https://www.thetimes.co.uk/article/whats-on-tv-and-radio-tonight-wednesday-march-20-3wg7jpprw"
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
The actor collects every review Rotten Tomatoes exposes for each title and continues across all the movie URLs you provide. Add more titles to grow your dataset.

### What happens if a title is temporarily unavailable?
The actor retries temporary failures, rotates request profiles, and moves on to the next title instead of failing the whole run. Re-run later to pick up anything that was missed.

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
