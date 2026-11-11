import asyncio
import json
import logging
import re
import time
from urllib.parse import parse_qsl, urljoin, urlparse

from apify import Actor
from scrapling.fetchers import AsyncStealthySession

BASE_URL = 'https://www.rottentomatoes.com'
DEFAULT_RESULTS_WANTED = 20
DEFAULT_MAX_PAGES = 10
FIRST_API_TIMEOUT_S = 12
NEXT_PAGE_TIMEOUT_S = 10

REVIEW_TYPE_TO_PARAMS = {
    'all-critics': {'type': 'critic', 'topOnly': False, 'verified': False},
    'top-critics': {'type': 'critic', 'topOnly': True, 'verified': False},
    'all-audience': {'type': 'audience', 'topOnly': False, 'verified': False},
    'verified-audience': {'type': 'audience', 'topOnly': False, 'verified': True},
}

CLICK_LOAD_MORE_JS = """() => {
    const button = document.querySelector('[data-pagemediareviewsmanager="loadMoreBtn:click"]');
    if (!button) return 'missing';
    button.scrollIntoView();
    button.click();
    return 'clicked';
}"""

_MISSING = object()


def clamp_integer(value, fallback, minimum=1, maximum=10**15):
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return fallback
    return min(max(parsed, minimum), maximum)


def get_input_value(candidate):
    if isinstance(candidate, str):
        return candidate
    if isinstance(candidate, dict):
        return candidate.get('url') or candidate.get('URL') or candidate.get('href') \
            or candidate.get('HREF') or candidate.get('value') or candidate.get('VALUE')
    return None


def get_field(value, *keys, default=None):
    if not isinstance(value, dict):
        return default
    for key in keys:
        if key in value:
            return value[key]
        lowered = key.lower()
        for existing, field_value in value.items():
            if existing.lower() == lowered:
                return field_value
    return default


def get_path(value, path):
    for key in path:
        value = get_field(value, key)
    return value


def js_or(*values):
    for value in values:
        if value is not None and value is not False and value != '' and value != 0:
            return value
    return None


def js_string(value):
    if value is None:
        return None
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def clean_object(value):
    if value is None:
        return None
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, list):
        cleaned = [clean_object(item) for item in value]
        cleaned = [item for item in cleaned if item is not None]
        return cleaned or None
    if isinstance(value, dict):
        cleaned = {key: clean_object(item) for key, item in value.items()}
        cleaned = {key: item for key, item in cleaned.items() if item is not None}
        return cleaned or None
    return value


def absolute_url(href):
    if not href or not isinstance(href, str):
        return None
    if re.match(r'^https?://', href, re.I):
        return href
    if href.startswith('/'):
        return f'{BASE_URL}{href}'
    return href


def normalize_movie_url(raw_url):
    input_value = get_input_value(raw_url)
    if not input_value or not isinstance(input_value, str):
        return None

    cleaned_url = input_value.strip()
    if not cleaned_url:
        return None
    if cleaned_url.startswith('www.'):
        cleaned_url = f'https://{cleaned_url}'
    if cleaned_url.startswith('/'):
        cleaned_url = f'{BASE_URL}{cleaned_url}'

    try:
        parsed = urlparse(urljoin(BASE_URL, cleaned_url))
    except ValueError:
        return None
    host = (parsed.hostname or '').lower()
    if 'rottentomatoes.com' not in host:
        return None

    segments = [segment for segment in parsed.path.split('/') if segment]
    if not segments or segments[0].lower() != 'm' or len(segments) < 2:
        return None

    return f'{BASE_URL}/m/{segments[1]}'


def parse_query_review_type(url_string):
    input_value = get_input_value(url_string)
    if not input_value or not isinstance(input_value, str):
        return None

    try:
        parsed = urlparse(urljoin(BASE_URL, input_value.strip()))
    except ValueError:
        return None
    type_param = next((value for key, value in parse_qsl(parsed.query, keep_blank_values=True)
                       if key.lower() == 'type'), None)
    review_type = (type_param or '').lower()
    if review_type in ('user', 'all_audience', 'all-audience'):
        return 'all-audience'
    if review_type in ('verified_audience', 'verified-audience'):
        return 'verified-audience'
    if review_type in ('top_critics', 'top-critics'):
        return 'top-critics'
    if review_type in ('all_critics', 'all-critics'):
        return 'all-critics'
    return None


def get_requested_review_type(input_review_type, url_review_type):
    if url_review_type and url_review_type in REVIEW_TYPE_TO_PARAMS:
        return url_review_type
    normalized = str(input_review_type or '').strip().lower().replace('_', '-')
    if normalized and normalized in REVIEW_TYPE_TO_PARAMS:
        return normalized
    if input_review_type:
        Actor.log.warning(f'Unknown reviewType "{input_review_type}". Falling back to all-critics.')
    return 'all-critics'


def text_content(element):
    if element is None:
        return ''
    return ''.join(element.css('::text').getall())


def parse_json_script(page, key):
    elements = page.css(f'script[data-json="{key}"]')
    if not elements:
        return None
    payload = text_content(elements[0]).strip()
    if not payload:
        return None
    try:
        return json.loads(payload)
    except ValueError:
        return None


def extract_consensus(page):
    elements = page.css('#critics-consensus')
    if not elements:
        return None
    text = re.sub(r'\s+', ' ', text_content(elements[0]))
    text = re.sub(r'Critics Consensus', '', text, count=1, flags=re.I)
    text = re.sub(r'Read Critics Reviews[\s\S]*$', '', text, flags=re.I)
    return text.strip() or None


def build_movie_meta(page, vanity, scorecard, reviews_data):
    critics_score = js_or(get_field(scorecard, 'criticsScore'), get_field(reviews_data, 'criticsScore'))
    audience_score = js_or(get_field(scorecard, 'audienceScore'), get_field(reviews_data, 'audienceScore'))

    return {
        'movieTitle': js_or(get_field(vanity, 'title'), get_field(reviews_data, 'title'),
                            get_path(scorecard, ['cta', 'buttonAnnouncement'])),
        'movieUrl': f'{BASE_URL}{get_field(vanity, "href")}' if get_field(vanity, 'href') else None,
        'movieVanity': get_field(vanity, 'value'),
        'movieEmsId': js_or(get_field(vanity, 'emsId'), get_path(reviews_data, ['vanity', 'emsId'])),
        'releaseDate': get_path(vanity, ['lifecycleWindow', 'date']),
        'releaseLifecycle': get_path(vanity, ['lifecycleWindow', 'lifecycle']),
        'tomatometerScore': get_field(critics_score, 'score'),
        'tomatometerSentiment': get_field(critics_score, 'sentiment'),
        'tomatometerReviews': get_field(critics_score, 'reviewCount'),
        'audienceScore': get_field(audience_score, 'score'),
        'audienceSentiment': get_field(audience_score, 'sentiment'),
        'audienceReviews': get_field(audience_score, 'reviewCount'),
        'criticsConsensus': extract_consensus(page),
    }


def first_element(element, selector):
    found = element.css(selector)
    return found[0] if found else None


def squash_text(element):
    if element is None:
        return ''
    return re.sub(r'\s+', ' ', text_content(element)).strip()


def element_attr(element, name):
    if element is None:
        return None
    return (element.attrib or {}).get(name)


def parse_critic_cards(page, meta, review_type):
    records = []
    for card in page.css('review-card-critic'):
        attributes = dict(card.attrib or {})
        name_slot = first_element(card, '[slot="name"]')
        publication_slot = first_element(card, '[slot="publication"]')
        rating_slot = first_element(card, '[slot="rating"]')

        sentiment = element_attr(first_element(rating_slot, 'score-icon-critics'), 'sentiment')
        normalized_sentiment = sentiment.upper() if sentiment else None
        score_span = first_element(rating_slot, 'span')
        original_score = re.sub(r'\s+', ' ', text_content(score_span)).strip()

        name_href = element_attr(name_slot, 'href') or ''

        records.append(clean_object({
            **meta,
            'source': 'public-page',
            'queryReviewType': review_type,
            'page': 1,
            'reviewId': attributes.get('data-review-id'),
            'createDate': text_content(first_element(card, '[slot="timestamp"]')).strip(),
            'scoreSentiment': normalized_sentiment,
            'originalScore': original_score,
            'isTopReview': 'top-critic' in attributes,
            'isTopCritic': 'top-critic' in attributes,
            'isFresh': normalized_sentiment == 'POSITIVE' if normalized_sentiment else None,
            'isRotten': normalized_sentiment == 'NEGATIVE' if normalized_sentiment else None,
            'quote': squash_text(first_element(card, '[slot="review"]')),
            'fullReviewUrl': element_attr(first_element(card, '[slot="review-link"]'), 'href'),
            'criticName': squash_text(name_slot),
            'criticSlug': [part for part in name_href.split('/') if part][-1] if name_href else None,
            'publicationName': squash_text(publication_slot),
            'publicationUrl': absolute_url(element_attr(publication_slot, 'href')),
            'rawReview': {'attributes': attributes},
        }))

    return records


def parse_audience_reviews(reviews_data, meta, review_type):
    reviews = reviews_data.get('reviews') if isinstance(reviews_data, dict) else None
    if not isinstance(reviews, list):
        return []

    records = []
    for review in reviews:
        rating = get_field(review, 'rating', default=_MISSING)
        records.append(clean_object({
            **meta,
            'source': 'public-page',
            'queryReviewType': review_type,
            'page': 1,
            'ratingId': get_field(review, 'ratingId'),
            'createDate': get_field(review, 'displayDate'),
            'rating': js_string(rating) if rating is not _MISSING else None,
            'ratingRange': js_or(get_field(review, 'ratingRangeA11y'), get_field(review, 'ratingRange')),
            'isVerified': get_field(review, 'isVerified'),
            'isFandangoReview': get_field(review, 'isFandangoReview'),
            'userDisplayName': get_field(review, 'displayName'),
            'userInitials': get_field(review, 'avatarInitials'),
            'userRealm': get_path(review, ['user', 'realm']),
            'userProfileLink': absolute_url(get_field(review, 'profileLink')),
            'quote': get_field(review, 'review'),
            'rawReview': review,
        }))

    return records


def map_api_review(review, meta, review_type, page):
    rating = get_field(review, 'rating', default=_MISSING)
    return clean_object({
        **meta,
        'source': 'reviews-api',
        'queryReviewType': review_type,
        'page': page,
        'reviewId': get_field(review, 'reviewId'),
        'ratingId': get_field(review, 'ratingId'),
        'createDate': get_field(review, 'createDate'),
        'updateDate': get_field(review, 'updateDate'),
        'scoreSentiment': get_field(review, 'scoreSentiment'),
        'originalScore': get_field(review, 'originalScore'),
        'rating': js_string(rating) if rating is not _MISSING else None,
        'isTopReview': get_field(review, 'isTopReview'),
        'isFresh': get_field(review, 'isFresh'),
        'isRotten': get_field(review, 'isRotten'),
        'quote': js_or(get_field(review, 'reviewQuote'), get_field(review, 'review')),
        'fullReviewUrl': get_field(review, 'publicationReviewUrl'),
        'isSpoiler': get_field(review, 'hasSpoilers'),
        'hasProfanity': get_field(review, 'hasProfanity'),
        'isVerified': get_field(review, 'isVerified'),
        'isSuperReviewer': get_field(review, 'isSuperReviewer'),
        'userDisplayName': get_field(review, 'displayName'),
        'userInitials': get_field(review, 'initials'),
        'userRealm': get_path(review, ['user', 'realm']),
        'criticName': js_or(get_field(review, 'criticName'), get_path(review, ['critic', 'name']),
                            get_path(review, ['critic', 'displayName'])),
        'criticSlug': js_or(get_path(review, ['critic', 'slug']), get_path(review, ['critic', 'vanity'])),
        'publicationName': js_or(get_field(review, 'publicationName'), get_path(review, ['publication', 'name'])),
        'publicationUrl': js_or(get_path(review, ['publication', 'url']),
                                get_path(review, ['publication', 'editorialUrl'])),
        'publicationIconUrl': get_path(review, ['publication', 'icon', 'url']),
        'rawReview': review,
    })


def select_page_records(page, reviews_data, meta, review_type, params):
    if params['type'] == 'critic':
        critics = parse_critic_cards(page, meta, review_type)
        if params['topOnly']:
            top_critics = [record for record in critics if record.get('isTopReview')]
            return top_critics or critics
        return critics

    audience = parse_audience_reviews(reviews_data, meta, review_type)
    if params['verified']:
        verified = [record for record in audience if record.get('isVerified')]
        return verified or audience
    return audience


def dedupe_records(records):
    seen = set()
    unique = []
    for record in records:
        key = record.get('reviewId') or record.get('ratingId') \
            or f"{record.get('criticName') or ''}|{record.get('userDisplayName') or ''}|{record.get('quote') or ''}"
        if key in seen:
            continue
        seen.add(key)
        unique.append(record)
    return unique


async def wait_for(condition, timeout_s):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if condition():
            return True
        await asyncio.sleep(0.25)
    return condition()


def count_reviews(payloads):
    return sum(len(payload.get('reviews') or []) for payload in payloads if isinstance(payload, dict))


class BrowserEngine:
    def __init__(self, proxy_configuration):
        self.proxy_configuration = proxy_configuration
        self.proxy_url = None
        self.session = None
        self.needs_solve = True

    async def start(self):
        if self.proxy_configuration:
            try:
                self.proxy_url = await self.proxy_configuration.new_url()
            except Exception as error:
                Actor.log.warning(f'Proxy URL unavailable ({error}); continuing without a proxy.')
                self.proxy_configuration = None
                self.proxy_url = None

        last_error = None
        for real_chrome, headless in ((True, False), (False, False), (False, True)):
            session = AsyncStealthySession(
                headless=headless,
                real_chrome=real_chrome,
                solve_cloudflare=True,
                hide_canvas=True,
                block_webrtc=True,
                block_ads=True,
                locale='en-US',
                timeout=45_000,
                retries=1,
                max_pages=1,
                proxy=self.proxy_url,
            )
            try:
                await session.start()
            except Exception as error:
                last_error = error
                try:
                    await session.close()
                except Exception:
                    pass
                continue
            self.session = session
            Actor.log.debug(f'Browser started (real_chrome={real_chrome}, headless={headless}).')
            return

        raise RuntimeError(f'Could not start a browser session: {last_error}')

    async def restart(self):
        await self.close()
        await self.start()

    async def close(self):
        session, self.session = self.session, None
        if session:
            try:
                await session.close()
            except Exception:
                pass

    async def fetch(self, url, validate, page_setup=None, page_action=None, attempts=2):
        if self.session is None:
            await self.start()

        for attempt in range(1, attempts + 1):
            try:
                response = await self.session.fetch(
                    url,
                    page_setup=page_setup,
                    page_action=page_action,
                    solve_cloudflare=self.needs_solve,
                )
            except Exception as error:
                if attempt == attempts:
                    raise RuntimeError(f'Could not load {url}: {error}') from error
                Actor.log.debug(f'Retrying {url} with a fresh session: {error}')
                await self.restart()
                continue

            if response.status == 200 and validate(response):
                self.needs_solve = False
                return response

            if attempt == attempts:
                raise RuntimeError(f'Could not load {url} (last HTTP status {response.status}).')
            Actor.log.debug(f'{url} returned HTTP {response.status} or a blocked page; rotating session.')
            await self.restart()

        raise RuntimeError(f'Could not load {url}.')


async def fetch_review_payloads(engine, movie_url, review_type, max_pages, limit):
    url = f'{movie_url}/reviews/{review_type}'
    captured = []
    seen = set()

    statuses = []

    async def page_setup(page):
        captured.clear()
        seen.clear()
        statuses.clear()

        async def on_response(response):
            if '/napi/rtcf/v1/movies/' not in response.url:
                return
            if not response.url.split('?', 1)[0].endswith('/reviews'):
                return
            statuses.append(response.status)
            if response.url in seen:
                return
            try:
                payload = json.loads(await response.text())
            except Exception:
                return
            if isinstance(payload, dict):
                seen.add(response.url)
                captured.append(payload)

        page.on('response', on_response)

    async def page_action(page):
        if not await wait_for(lambda: bool(captured), FIRST_API_TIMEOUT_S):
            return
        guard = 0
        retries_for_page = 0
        while len(captured) < max_pages and count_reviews(captured) < limit and guard < max_pages * 4 + 4:
            guard += 1
            page_info = captured[-1].get('pageInfo') or {}
            if page_info.get('hasNextPage') is not True:
                break
            before = len(captured)
            clicked = await page.evaluate(CLICK_LOAD_MORE_JS)
            if clicked != 'clicked':
                break
            if await wait_for(lambda: len(captured) > before, NEXT_PAGE_TIMEOUT_S):
                retries_for_page = 0
                continue
            # Akamai rejects some requests with a 401 and the site retries; click again.
            retries_for_page += 1
            if retries_for_page >= 3:
                break
            await asyncio.sleep(retries_for_page * 1.5)

    def validate(response):
        if captured:
            return True
        return bool(response.css('review-card-critic')) or bool(response.css('review-card-audience'))

    try:
        attempts = 2 if engine.proxy_configuration else 1
        await engine.fetch(url, validate=validate, page_setup=page_setup,
                           page_action=page_action, attempts=attempts)
    except Exception as error:
        Actor.log.warning(f'Reviews page failed for {movie_url}: {error}')

    if not captured:
        reason = f'HTTP {statuses[0]}' if statuses else 'no review request was made'
        Actor.log.info(f'Reviews service unavailable ({reason}) for {movie_url}.')

    return captured[:max_pages]


async def collect_movie_reviews(engine, movie_url, review_type, max_pages, results_wanted, total_saved):
    movie_response = await engine.fetch(
        movie_url,
        validate=lambda response: b'data-json="vanity"' in (response.body or b''),
    )

    vanity = parse_json_script(movie_response, 'vanity')
    scorecard = parse_json_script(movie_response, 'mediaScorecard')
    reviews_data = parse_json_script(movie_response, 'reviewsData')
    meta = build_movie_meta(movie_response, vanity, scorecard, reviews_data)

    params = REVIEW_TYPE_TO_PARAMS[review_type]
    remaining = results_wanted - total_saved
    records = []

    if meta['movieEmsId']:
        payloads = await fetch_review_payloads(engine, movie_url, review_type, max_pages, remaining)
        if payloads:
            for page_number, payload in enumerate(payloads, 1):
                for review in payload.get('reviews') or []:
                    if isinstance(review, dict):
                        records.append(map_api_review(review, meta, review_type, page_number))
            Actor.log.info(
                f'Collected {len(records)} reviews from the reviews service for '
                f'{meta["movieTitle"] or movie_url}.',
            )

    if not records:
        records = select_page_records(movie_response, reviews_data, meta, review_type, params)

    records = dedupe_records(records)[:remaining]

    if not records:
        Actor.log.warning(f'No {review_type} reviews found on {movie_url}.')
        return 0

    await Actor.push_data(records)
    Actor.log.info(
        f'Saved {len(records)} reviews for {meta["movieTitle"] or movie_url}. '
        f'Total: {total_saved + len(records)}/{results_wanted}',
    )
    return len(records)


async def run():
    actor_input = (await Actor.get_input()) or {}

    results_wanted = clamp_integer(actor_input.get('results_wanted', DEFAULT_RESULTS_WANTED),
                                  DEFAULT_RESULTS_WANTED, 1, 100000)
    max_pages = clamp_integer(actor_input.get('max_pages', DEFAULT_MAX_PAGES), DEFAULT_MAX_PAGES, 1, 100000)

    proxy_input = actor_input.get('proxyConfiguration')

    proxy_configuration = None
    if proxy_input:
        try:
            proxy_configuration = await Actor.create_proxy_configuration(actor_proxy_input=proxy_input)
        except Exception as error:
            Actor.log.warning(f'Proxy configuration unavailable ({error}); continuing without a proxy.')

    candidates = []
    urls = actor_input.get('urls')
    start_urls = actor_input.get('startUrls')
    if isinstance(urls, list):
        candidates.extend(urls)
    if isinstance(start_urls, list):
        candidates.extend(start_urls)
    for key in ('startUrl', 'url'):
        if actor_input.get(key):
            candidates.append(actor_input[key])

    normalized_urls = list(dict.fromkeys(
        url for url in (normalize_movie_url(candidate) for candidate in candidates) if url
    ))

    if not normalized_urls:
        raise RuntimeError('Provide at least one Rotten Tomatoes movie URL in "urls".')

    skipped = sum(1 for candidate in candidates if not normalize_movie_url(candidate))
    if skipped:
        Actor.log.warning(f'Skipped {skipped} invalid or unsupported Rotten Tomatoes URL input(s).')

    inferred_type = next(
        (review_type for review_type in (parse_query_review_type(candidate) for candidate in candidates) if review_type),
        None,
    )
    review_type = get_requested_review_type(actor_input.get('reviewType'), inferred_type)

    engine = BrowserEngine(proxy_configuration)
    total_saved = 0
    loaded_pages = 0
    failed_pages = 0

    try:
        for movie_url in normalized_urls:
            if total_saved >= results_wanted:
                break
            try:
                saved = await collect_movie_reviews(
                    engine, movie_url, review_type, max_pages, results_wanted, total_saved,
                )
                total_saved += saved
                loaded_pages += 1
            except Exception as error:
                failed_pages += 1
                Actor.log.warning(f'Skipping {movie_url}: {error}')
    finally:
        await engine.close()

    if total_saved == 0:
        if loaded_pages == 0 and failed_pages > 0:
            raise RuntimeError('Unable to collect any reviews: every movie page failed to load.')
        Actor.log.warning('Run finished but no reviews were collected for the requested review type.')

    Actor.log.info(
        f'Finished. Total reviews saved: {total_saved} '
        f'(pages loaded: {loaded_pages}, failed: {failed_pages}).',
    )


async def main():
    logging.getLogger('scrapling').setLevel(logging.CRITICAL)
    async with Actor:
        await run()



