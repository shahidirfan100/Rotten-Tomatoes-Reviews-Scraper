import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';

const BASE_URL = 'https://www.rottentomatoes.com';
const DEFAULT_RESULTS_WANTED = 20;
const DEFAULT_MAX_PAGES = 10;
const PAGE_SIZE = 20;
const REQUEST_RETRY_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30000;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

const REVIEW_TYPE_TO_PARAMS = {
    'all-critics': { type: 'critic', topOnly: false, verified: false },
    'top-critics': { type: 'critic', topOnly: true, verified: false },
    'all-audience': { type: 'audience', topOnly: false, verified: false },
    'verified-audience': { type: 'audience', topOnly: false, verified: true },
};

await Actor.init();

function clampInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
}

function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function getInputValue(candidate) {
    if (typeof candidate === 'string') return candidate;
    if (candidate && typeof candidate === 'object') {
        return candidate.url || candidate.URL || candidate.href || candidate.HREF || candidate.value || candidate.VALUE;
    }
    return null;
}

function getField(value, ...keys) {
    if (!value || typeof value !== 'object') return undefined;

    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];

        const normalizedKey = key.toLowerCase();
        const matchedKey = Object.keys(value).find((existingKey) => existingKey.toLowerCase() === normalizedKey);
        if (matchedKey) return value[matchedKey];
    }

    return undefined;
}

function getPath(value, path) {
    return path.reduce((current, key) => getField(current, key), value);
}

function parseJsonSafely(body, context) {
    try {
        return JSON.parse(body);
    } catch (error) {
        log.warning(`Failed parsing JSON from ${context}: ${error.message}`);
        return null;
    }
}

function cleanObject(value) {
    if (value === null || value === undefined) return undefined;

    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length ? trimmed : undefined;
    }

    if (Array.isArray(value)) {
        const cleanedArray = value
            .map((item) => cleanObject(item))
            .filter((item) => item !== undefined);
        return cleanedArray.length ? cleanedArray : undefined;
    }

    if (typeof value === 'object') {
        const entries = Object.entries(value)
            .map(([key, val]) => [key, cleanObject(val)])
            .filter(([, val]) => val !== undefined);
        if (!entries.length) return undefined;
        return Object.fromEntries(entries);
    }

    return value;
}

function normalizeMovieUrl(rawUrl) {
    const inputValue = getInputValue(rawUrl);
    if (!inputValue || typeof inputValue !== 'string') return null;

    let cleanedUrl = inputValue.trim();
    if (!cleanedUrl) return null;

    if (cleanedUrl.startsWith('www.')) cleanedUrl = `https://${cleanedUrl}`;
    if (cleanedUrl.startsWith('/')) cleanedUrl = `${BASE_URL}${cleanedUrl}`;

    try {
        const parsed = new URL(cleanedUrl, BASE_URL);
        const host = parsed.hostname.toLowerCase();
        if (!host.includes('rottentomatoes.com')) return null;

        const segments = parsed.pathname.split('/').filter(Boolean);
        if ((segments[0] || '').toLowerCase() !== 'm' || !segments[1]) return null;

        return `${BASE_URL}/m/${segments[1]}`;
    } catch {
        return null;
    }
}

function parseQueryReviewType(urlString) {
    const inputValue = getInputValue(urlString);
    if (!inputValue || typeof inputValue !== 'string') return null;

    try {
        const parsed = new URL(inputValue.trim(), BASE_URL);
        const typeParam = [...parsed.searchParams.entries()]
            .find(([key]) => key.toLowerCase() === 'type')?.[1];
        const type = (typeParam || '').toLowerCase();
        if (type === 'user' || type === 'all_audience' || type === 'all-audience') return 'all-audience';
        if (type === 'verified_audience' || type === 'verified-audience') return 'verified-audience';
        if (type === 'top_critics' || type === 'top-critics') return 'top-critics';
        if (type === 'all_critics' || type === 'all-critics') return 'all-critics';
    } catch {
        return null;
    }
    return null;
}

function extractDataJsonBlock(html, key) {
    const pattern = new RegExp(`<script[^>]*data-json=["']${key}["'][^>]*>([\\s\\S]*?)<\\/script>`, 'i');
    const match = html.match(pattern);
    if (!match) return null;

    const payload = match[1]?.trim();
    if (!payload) return null;

    try {
        return JSON.parse(payload);
    } catch {
        return null;
    }
}

async function requestWithProxy(proxyConfig, url, options = {}) {
    let lastError;

    for (let attempt = 1; attempt <= REQUEST_RETRY_ATTEMPTS; attempt += 1) {
        const proxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;

        try {
            const response = await gotScraping({
                url,
                proxyUrl,
                throwHttpErrors: false,
                retry: { limit: 0 },
                timeout: { request: REQUEST_TIMEOUT_MS },
                ...options,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0',
                    Accept: 'application/json, text/plain, */*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    ...(options.headers || {}),
                },
            });

            if (!RETRYABLE_STATUS_CODES.has(response.statusCode) || attempt === REQUEST_RETRY_ATTEMPTS) {
                return response;
            }

            const retryAfter = Number.parseInt(response.headers?.['retry-after'] || '', 10);
            const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 750 * attempt;
            log.warning(`Temporary HTTP ${response.statusCode} for ${url}. Retrying attempt ${attempt + 1}/${REQUEST_RETRY_ATTEMPTS}.`);
            await delay(waitMs);
        } catch (error) {
            lastError = error;
            if (attempt === REQUEST_RETRY_ATTEMPTS) break;

            log.warning(`Request failed for ${url}: ${error.message}. Retrying attempt ${attempt + 1}/${REQUEST_RETRY_ATTEMPTS}.`);
            await delay(750 * attempt);
        }
    }

    throw lastError;
}

async function resolveMovieContext(movieUrl, proxyConfig) {
    const reviewsPageUrl = `${movieUrl}/reviews`;
    const response = await requestWithProxy(proxyConfig, reviewsPageUrl, {
        headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            Referer: movieUrl,
        },
    });

    if (response.statusCode !== 200) {
        throw new Error(`Unable to load movie reviews page (${response.statusCode}): ${reviewsPageUrl}`);
    }

    const props = extractDataJsonBlock(response.body, 'props');
    const reviewsData = extractDataJsonBlock(response.body, 'reviewsData');

    const emsId = getPath(props, ['vanity', 'emsId'])
        || getPath(props, ['media', 'emsId'])
        || getPath(reviewsData, ['media', 'emsId']);
    if (!emsId) {
        throw new Error(`Failed to resolve movie ID from ${reviewsPageUrl}`);
    }

    const movieDetailsUrl = `${BASE_URL}/napi/rtcf/v1/movies/${emsId}`;
    let movieDetails = {};
    try {
        const detailsResponse = await requestWithProxy(proxyConfig, movieDetailsUrl, {
            headers: {
                Referer: reviewsPageUrl,
            },
        });

        if (detailsResponse.statusCode !== 200) {
            log.warning(`Failed to fetch movie details (${detailsResponse.statusCode}) for ID: ${emsId}. Continuing with review data only.`);
        } else {
            const parsed = parseJsonSafely(detailsResponse.body, `movie details API for ID ${emsId}`);
            movieDetails = Array.isArray(parsed) ? getField(parsed[0], 'movieDetail') : getField(parsed, 'movieDetail');
        }
    } catch (error) {
        log.warning(`Failed to fetch movie details for ID ${emsId}: ${error.message}. Continuing with review data only.`);
    }

    return {
        movieUrl,
        reviewsPageUrl,
        emsId,
        props: props || {},
        movieDetails: movieDetails || {},
    };
}

function buildReviewRecord({ review, movieContext, reviewType, page }) {
    const movieDetail = movieContext.movieDetails;

    const baseRecord = {
        queryReviewType: reviewType,
        page,
        movieTitle: getField(movieDetail, 'title') || getPath(movieContext.props, ['media', 'title']),
        movieUrl: getField(movieDetail, 'rottenTomatoesUrl') || movieContext.movieUrl,
        mediaUrl: getField(movieDetail, 'mediaUrl'),
        movieVanity: getField(movieDetail, 'vanity') || getPath(movieContext.props, ['vanity', 'value']),
        movieEmsId: getField(movieDetail, 'emsMovieId') || movieContext.emsId,
        rottenTomatoesMovieId: getField(movieDetail, 'rottenTomatoesMovieId'),
        fandangoMovieId: getField(movieDetail, 'fandangoMovieId'),
        releaseDate: getPath(movieDetail, ['lifecycleWindow', 'date']),
        releaseLifecycle: getPath(movieDetail, ['lifecycleWindow', 'lifecycle']),
        tomatometerScore: getPath(movieDetail, ['tomatometerScore', 'score']),
        tomatometerSentiment: getPath(movieDetail, ['tomatometerScore', 'scoreSentiment']),
        audienceScore: getPath(movieDetail, ['audienceScore', 'score']),
        audienceSentiment: getPath(movieDetail, ['audienceScore', 'scoreSentiment']),
        criticsConsensus: getPath(movieDetail, ['criticsConsensus', 'consensus']),
        audienceConsensus: getPath(movieDetail, ['audienceConsensus', 'consensus']),
        reviewId: getField(review, 'reviewId'),
        ratingId: getField(review, 'ratingId'),
        createDate: getField(review, 'createDate'),
        updateDate: getField(review, 'updateDate'),
        scoreSentiment: getField(review, 'scoreSentiment'),
        originalScore: getField(review, 'originalScore'),
        rating: getField(review, 'rating'),
        isTopReview: getField(review, 'isTopReview'),
        isFresh: getField(review, 'isFresh'),
        isRotten: getField(review, 'isRotten'),
        quote: getField(review, 'reviewQuote') || getField(review, 'review'),
        fullReviewUrl: getField(review, 'publicationReviewUrl'),
        isSpoiler: getField(review, 'hasSpoilers'),
        hasProfanity: getField(review, 'hasProfanity'),
        isVerified: getField(review, 'isVerified'),
        isSuperReviewer: getField(review, 'isSuperReviewer'),
        userDisplayName: getField(review, 'displayName'),
        userInitials: getField(review, 'initials'),
        userRealm: getPath(review, ['user', 'realm']),
        criticName: getField(review, 'criticName') || getPath(review, ['critic', 'name']),
        criticSlug: getPath(review, ['critic', 'slug']),
        publicationName: getField(review, 'publicationName') || getPath(review, ['publication', 'name']),
        publicationUrl: getPath(review, ['publication', 'url']),
        publicationIconUrl: getPath(review, ['publication', 'icon', 'url']),
        rawReview: review,
    };

    return cleanObject(baseRecord);
}

function getRequestedReviewType(inputReviewType, urlReviewType) {
    if (urlReviewType && REVIEW_TYPE_TO_PARAMS[urlReviewType]) return urlReviewType;
    const normalizedInputReviewType = String(inputReviewType || '').trim().toLowerCase().replaceAll('_', '-');
    if (normalizedInputReviewType && REVIEW_TYPE_TO_PARAMS[normalizedInputReviewType]) return normalizedInputReviewType;
    if (inputReviewType) log.warning(`Unknown reviewType "${inputReviewType}". Falling back to all-critics.`);
    return 'all-critics';
}

try {
    const input = (await Actor.getInput()) || {};

    const {
        urls,
        url,
        startUrl,
        startUrls,
        results_wanted: resultsWantedRaw = DEFAULT_RESULTS_WANTED,
        max_pages: maxPagesRaw = DEFAULT_MAX_PAGES,
        reviewType,
        proxyConfiguration,
    } = input;

    const resultsWanted = clampInteger(resultsWantedRaw, DEFAULT_RESULTS_WANTED, 1, 100000);
    const maxPages = clampInteger(maxPagesRaw, DEFAULT_MAX_PAGES, 1, 100000);

    const proxyConfig = proxyConfiguration
        ? await Actor.createProxyConfiguration(proxyConfiguration)
        : undefined;

    const urlCandidates = [];
    if (Array.isArray(urls)) urlCandidates.push(...urls);
    if (Array.isArray(startUrls)) urlCandidates.push(...startUrls);
    if (startUrl) urlCandidates.push(startUrl);
    if (url) urlCandidates.push(url);

    const normalizedUrls = [...new Set(urlCandidates.map((candidate) => normalizeMovieUrl(candidate)).filter(Boolean))];

    if (!normalizedUrls.length) {
        throw new Error('Provide at least one Rotten Tomatoes movie URL in "urls".');
    }

    const skippedUrlCount = urlCandidates.filter((candidate) => !normalizeMovieUrl(candidate)).length;
    if (skippedUrlCount > 0) {
        log.warning(`Skipped ${skippedUrlCount} invalid or unsupported Rotten Tomatoes URL input(s).`);
    }

    const inferredTypeFromUrl = urlCandidates
        .map((candidate) => parseQueryReviewType(candidate))
        .find(Boolean);
    const selectedReviewType = getRequestedReviewType(reviewType, inferredTypeFromUrl);
    const reviewParams = REVIEW_TYPE_TO_PARAMS[selectedReviewType];

    let totalSaved = 0;

    for (const movieUrl of normalizedUrls) {
        if (totalSaved >= resultsWanted) break;

        let movieContext;
        try {
            movieContext = await resolveMovieContext(movieUrl, proxyConfig);
        } catch (error) {
            log.warning(`Skipping ${movieUrl}: ${error.message}`);
            continue;
        }

        log.info(`Collecting ${selectedReviewType} reviews for: ${movieContext.movieUrl}`);

        let after = '';
        let before = '';
        let page = 1;
        let hasNextPage = true;

        while (hasNextPage && page <= maxPages && totalSaved < resultsWanted) {
            const pageCount = Math.min(PAGE_SIZE, resultsWanted - totalSaved);
            const apiUrl = new URL(`${BASE_URL}/napi/rtcf/v1/movies/${movieContext.emsId}/reviews`);
            apiUrl.searchParams.set('after', after);
            apiUrl.searchParams.set('before', before);
            apiUrl.searchParams.set('pageCount', String(pageCount));
            apiUrl.searchParams.set('topOnly', String(reviewParams.topOnly));
            apiUrl.searchParams.set('type', reviewParams.type);
            apiUrl.searchParams.set('verified', String(reviewParams.verified));

            let response;
            try {
                response = await requestWithProxy(proxyConfig, apiUrl.toString(), {
                    headers: {
                        Referer: movieContext.reviewsPageUrl,
                    },
                });
            } catch (error) {
                log.warning(`Skipping remaining reviews for ${movieContext.movieUrl}: ${error.message}`);
                break;
            }

            if (response.statusCode !== 200) {
                log.warning(`Reviews API returned ${response.statusCode} for ${apiUrl}`);
                break;
            }

            const payload = parseJsonSafely(response.body, `reviews API for ${movieContext.movieUrl}`);
            if (!payload) {
                break;
            }

            const pageInfo = getField(payload, 'pageInfo') || {};
            const reviewsValue = getField(payload, 'reviews', 'edges', 'results', 'data');
            const reviews = Array.isArray(reviewsValue) ? reviewsValue : [];

            if (!reviews.length) {
                log.info(`No more reviews found on page ${page} for ${movieContext.movieUrl}`);
                if (page === 1) {
                    log.warning(`Reviews response did not contain a usable reviews array. Response keys: ${Object.keys(payload).join(', ')}`);
                }
                break;
            }

            const remainingSlots = resultsWanted - totalSaved;
            const trimmedReviews = reviews.slice(0, remainingSlots);
            const currentPage = page;
            const records = trimmedReviews
                .map((review) => buildReviewRecord({
                    review,
                    movieContext,
                    reviewType: selectedReviewType,
                    page: currentPage,
                }))
                .filter(Boolean);

            if (!records.length) break;

            await Dataset.pushData(records);
            totalSaved += records.length;

            log.info(`Saved ${records.length} reviews from page ${page}. Total saved: ${totalSaved}/${resultsWanted}`);

            hasNextPage = Boolean(getField(pageInfo, 'hasNextPage')) && records.length > 0;
            after = getField(pageInfo, 'endCursor') || '';
            before = getField(pageInfo, 'startCursor') || '';
            page += 1;
        }
    }

    if (totalSaved === 0) {
        log.warning('Run finished but no reviews were collected.');
    }

    log.info(`Finished successfully. Total reviews saved: ${totalSaved}`);
    await Actor.exit();
} catch (error) {
    log.exception(error, 'Actor failed');
    await Actor.fail(String(error));
}
