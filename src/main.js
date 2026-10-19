import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import { Impit } from 'impit';

const BASE_URL = 'https://www.rottentomatoes.com';
const DEFAULT_RESULTS_WANTED = 20;
const DEFAULT_MAX_PAGES = 10;
const PAGE_SIZE = 20;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 3;
const BROWSER_PROFILES = ['chrome', 'firefox', 'chrome142', 'okhttp4', 'ios18'];

const REVIEW_TYPE_TO_PARAMS = {
    'all-critics': { type: 'critic', topOnly: false, verified: false },
    'top-critics': { type: 'critic', topOnly: true, verified: false },
    'all-audience': { type: 'audience', topOnly: false, verified: false },
    'verified-audience': { type: 'audience', topOnly: false, verified: true },
};

await Actor.init();

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function clampInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
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

function absoluteUrl(href) {
    if (!href || typeof href !== 'string') return undefined;
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith('/')) return `${BASE_URL}${href}`;
    return href;
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

function getRequestedReviewType(inputReviewType, urlReviewType) {
    if (urlReviewType && REVIEW_TYPE_TO_PARAMS[urlReviewType]) return urlReviewType;
    const normalizedInputReviewType = String(inputReviewType || '').trim().toLowerCase().replaceAll('_', '-');
    if (normalizedInputReviewType && REVIEW_TYPE_TO_PARAMS[normalizedInputReviewType]) return normalizedInputReviewType;
    if (inputReviewType) log.warning(`Unknown reviewType "${inputReviewType}". Falling back to all-critics.`);
    return 'all-critics';
}

function createCookieJar() {
    const store = new Map();
    return {
        setCookie(cookieString) {
            const pair = String(cookieString || '').split(';')[0];
            const separator = pair.indexOf('=');
            if (separator <= 0) return;
            store.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
        },
        getCookieString() {
            return [...store.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
        },
        size() {
            return store.size;
        },
    };
}

class RtSession {
    constructor(proxyUrl) {
        this.proxyUrl = proxyUrl;
        this.jar = createCookieJar();
        this.clients = new Map();
        this.activeProfile = null;
    }

    client(profile) {
        if (!this.clients.has(profile)) {
            this.clients.set(
                profile,
                new Impit({
                    browser: profile,
                    cookieJar: this.jar,
                    timeout: REQUEST_TIMEOUT_MS,
                    ...(this.proxyUrl && { proxyUrl: this.proxyUrl }),
                }),
            );
        }
        return this.clients.get(profile);
    }

    setActiveProfile(profile) {
        this.activeProfile = profile;
    }
}

function retryDelay(attempt, response) {
    const retryAfter = Number.parseInt(response?.headers?.get('retry-after') ?? '', 10);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 15000);
    return Math.min(750 * 2 ** (attempt - 1), 8000) + Math.round(Math.random() * 400);
}

async function fetchWithRetry(client, url, options, attempts = MAX_ATTEMPTS) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const response = await client.fetch(url, options);
            const isTemporary = response.status === 429 || response.status >= 500;
            if (isTemporary && attempt < attempts) {
                const wait = retryDelay(attempt, response);
                log.warning(`HTTP ${response.status} for ${url} — retrying in ${Math.round(wait)}ms (attempt ${attempt}/${attempts})`);
                await sleep(wait);
                lastError = new Error(`HTTP ${response.status}`);
                continue;
            }
            return response;
        } catch (error) {
            lastError = error;
            if (attempt < attempts) {
                const wait = retryDelay(attempt);
                log.warning(`Request error (${error.message}) — retrying in ${Math.round(wait)}ms (attempt ${attempt}/${attempts})`);
                await sleep(wait);
            }
        }
    }
    throw lastError ?? new Error(`Request failed for ${url}`);
}

async function fetchMoviePage(session, movieUrl) {
    let lastStatus = null;
    for (const profile of BROWSER_PROFILES) {
        const client = session.client(profile);
        try {
            const response = await fetchWithRetry(
                client,
                movieUrl,
                { headers: { accept: 'text/html,application/xhtml+xml' } },
                2,
            );
            if (response.status === 200) {
                session.setActiveProfile(profile);
                return await response.text();
            }
            lastStatus = response.status;
            log.warning(`Profile "${profile}" returned HTTP ${response.status} for ${movieUrl}`);
        } catch (error) {
            log.warning(`Profile "${profile}" failed for ${movieUrl}: ${error.message}`);
        }
    }
    throw new Error(`Could not load movie page (last HTTP status ${lastStatus ?? 'n/a'}).`);
}

function parseJsonScript($, key) {
    const element = $(`script[data-json="${key}"]`).first();
    if (!element.length) return null;
    const payload = element.text().trim();
    if (!payload) return null;
    try {
        return JSON.parse(payload);
    } catch {
        return null;
    }
}

function extractConsensus($) {
    const element = $('#critics-consensus');
    if (!element.length) return undefined;
    const text = element
        .text()
        .replace(/\s+/g, ' ')
        .replace(/Critics Consensus/i, '')
        .replace(/Read Critics Reviews[\s\S]*$/i, '')
        .trim();
    return text || undefined;
}

function buildMovieMeta($, vanity, scorecard, reviewsData) {
    const criticsScore = scorecard?.criticsScore || reviewsData?.criticsScore;
    const audienceScore = scorecard?.audienceScore || reviewsData?.audienceScore;

    return {
        movieTitle: vanity?.title || reviewsData?.title || getPath(scorecard, ['cta', 'buttonAnnouncement']),
        movieUrl: vanity?.href ? `${BASE_URL}${vanity.href}` : undefined,
        movieVanity: vanity?.value,
        movieEmsId: vanity?.emsId || reviewsData?.vanity?.emsId,
        releaseDate: vanity?.lifecycleWindow?.date,
        releaseLifecycle: vanity?.lifecycleWindow?.lifecycle,
        tomatometerScore: criticsScore?.score,
        tomatometerSentiment: criticsScore?.sentiment,
        tomatometerReviews: criticsScore?.reviewCount,
        audienceScore: audienceScore?.score,
        audienceSentiment: audienceScore?.sentiment,
        audienceReviews: audienceScore?.reviewCount,
        criticsConsensus: extractConsensus($),
    };
}

function parseCriticCards($, meta, reviewType) {
    const records = [];

    $('review-card-critic').each((_, element) => {
        const card = $(element);
        const attributes = card.attr() || {};
        const nameSlot = card.find('[slot="name"]').first();
        const publicationSlot = card.find('[slot="publication"]').first();
        const ratingSlot = card.find('[slot="rating"]').first();
        const sentiment = ratingSlot.find('score-icon-critics').attr('sentiment');
        const normalizedSentiment = sentiment ? sentiment.toUpperCase() : undefined;
        const originalScore = ratingSlot.find('span').first().text().replace(/\s+/g, ' ').trim();

        records.push(cleanObject({
            ...meta,
            source: 'public-page',
            queryReviewType: reviewType,
            page: 1,
            reviewId: attributes['data-review-id'],
            createDate: card.find('[slot="timestamp"]').first().text().trim(),
            scoreSentiment: normalizedSentiment,
            originalScore,
            isTopReview: Object.prototype.hasOwnProperty.call(attributes, 'top-critic'),
            isTopCritic: Object.prototype.hasOwnProperty.call(attributes, 'top-critic'),
            isFresh: normalizedSentiment ? normalizedSentiment === 'POSITIVE' : undefined,
            isRotten: normalizedSentiment ? normalizedSentiment === 'NEGATIVE' : undefined,
            quote: card.find('[slot="review"]').first().text().replace(/\s+/g, ' ').trim(),
            fullReviewUrl: card.find('[slot="review-link"]').first().attr('href'),
            criticName: nameSlot.text().replace(/\s+/g, ' ').trim(),
            criticSlug: (nameSlot.attr('href') || '').split('/').filter(Boolean).pop(),
            publicationName: publicationSlot.text().replace(/\s+/g, ' ').trim(),
            publicationUrl: absoluteUrl(publicationSlot.attr('href')),
            rawReview: { attributes },
        }));
    });

    return records;
}

function parseAudienceReviews(reviewsData, meta, reviewType) {
    const reviews = Array.isArray(reviewsData?.reviews) ? reviewsData.reviews : [];

    return reviews.map((review) => cleanObject({
        ...meta,
        source: 'public-page',
        queryReviewType: reviewType,
        page: 1,
        ratingId: getField(review, 'ratingId'),
        createDate: getField(review, 'displayDate'),
        rating: getField(review, 'rating') !== undefined ? String(getField(review, 'rating')) : undefined,
        ratingRange: getField(review, 'ratingRangeA11y') || getField(review, 'ratingRange'),
        isVerified: getField(review, 'isVerified'),
        isFandangoReview: getField(review, 'isFandangoReview'),
        userDisplayName: getField(review, 'displayName'),
        userInitials: getField(review, 'avatarInitials'),
        userRealm: getPath(review, ['user', 'realm']),
        userProfileLink: absoluteUrl(getField(review, 'profileLink')),
        quote: getField(review, 'review'),
        rawReview: review,
    }));
}

function mapApiReview(review, meta, reviewType, page) {
    return cleanObject({
        ...meta,
        source: 'reviews-api',
        queryReviewType: reviewType,
        page,
        reviewId: getField(review, 'reviewId'),
        ratingId: getField(review, 'ratingId'),
        createDate: getField(review, 'createDate'),
        updateDate: getField(review, 'updateDate'),
        scoreSentiment: getField(review, 'scoreSentiment'),
        originalScore: getField(review, 'originalScore'),
        rating: getField(review, 'rating') !== undefined ? String(getField(review, 'rating')) : undefined,
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
        criticName: getField(review, 'criticName') || getPath(review, ['critic', 'name']) || getPath(review, ['critic', 'displayName']),
        criticSlug: getPath(review, ['critic', 'slug']) || getPath(review, ['critic', 'vanity']),
        publicationName: getField(review, 'publicationName') || getPath(review, ['publication', 'name']),
        publicationUrl: getPath(review, ['publication', 'url']) || getPath(review, ['publication', 'editorialUrl']),
        publicationIconUrl: getPath(review, ['publication', 'icon', 'url']),
        rawReview: review,
    });
}

async function tryReviewsApi({ session, emsId, movieUrl, reviewType, params, maxPages, limit }) {
    const client = session.client(session.activeProfile || 'chrome');
    const records = [];
    let after = '';
    let before = '';

    for (let page = 1; page <= maxPages && records.length < limit; page++) {
        const url = new URL(`${BASE_URL}/napi/rtcf/v1/movies/${emsId}/reviews`);
        url.searchParams.set('after', after);
        url.searchParams.set('before', before);
        url.searchParams.set('pageCount', String(Math.min(PAGE_SIZE, limit - records.length)));
        url.searchParams.set('topOnly', String(params.topOnly));
        url.searchParams.set('type', params.type);
        url.searchParams.set('verified', String(params.verified));

        let response;
        try {
            response = await fetchWithRetry(
                client,
                url.toString(),
                { headers: { accept: 'application/json', referer: `${movieUrl}/reviews` } },
                2,
            );
        } catch (error) {
            return { ok: false, reason: error.message, records };
        }

        if (response.status !== 200) {
            return { ok: false, reason: `HTTP ${response.status}`, records };
        }

        const body = await response.text();
        let payload;
        try {
            payload = JSON.parse(body);
        } catch {
            return { ok: false, reason: 'response was not JSON', records };
        }

        const reviews = Array.isArray(payload?.reviews) ? payload.reviews : [];
        if (!reviews.length) break;

        for (const review of reviews) records.push(mapApiReview(review, {}, reviewType, page));

        const pageInfo = payload?.pageInfo || {};
        if (pageInfo.hasNextPage !== true) break;
        after = pageInfo.endCursor || '';
        before = pageInfo.startCursor || '';
    }

    return { ok: records.length > 0, reason: records.length ? 'ok' : 'empty payload', records };
}

function selectPageRecords($, reviewsData, meta, reviewType, params) {
    if (params.type === 'critic') {
        const critics = parseCriticCards($, meta, reviewType);
        const topCritics = params.topOnly ? critics.filter((record) => record.isTopReview) : critics;
        const selected = params.topOnly && topCritics.length ? topCritics : critics;
        return selected.map((record) => ({ ...record, rawReview: record.rawReview }));
    }

    const audience = parseAudienceReviews(reviewsData, meta, reviewType);
    const verified = params.verified ? audience.filter((record) => record.isVerified) : audience;
    return params.verified && verified.length ? verified : audience;
}

function dedupeRecords(records) {
    const seen = new Set();
    const unique = [];
    for (const record of records) {
        const key = record.reviewId || record.ratingId
            || `${record.criticName || ''}|${record.userDisplayName || ''}|${record.quote || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(record);
    }
    return unique;
}

async function collectMovieReviews({ session, movieUrl, reviewType, maxPages, resultsWanted, totalSaved }) {
    const html = await fetchMoviePage(session, movieUrl);
    const $ = cheerio.load(html);

    const vanity = parseJsonScript($, 'vanity');
    const scorecard = parseJsonScript($, 'mediaScorecard');
    const reviewsData = parseJsonScript($, 'reviewsData');
    const meta = buildMovieMeta($, vanity, scorecard, reviewsData);

    const emsId = meta.movieEmsId;
    const params = REVIEW_TYPE_TO_PARAMS[reviewType];
    const remaining = resultsWanted - totalSaved;

    let records = [];
    if (emsId) {
        const apiResult = await tryReviewsApi({ session, emsId, movieUrl, reviewType, params, maxPages, limit: remaining });
        if (apiResult.records.length) {
            records = apiResult.records.map((record) => ({ ...meta, ...record }));
            log.info(`Collected ${records.length} reviews from the reviews service for ${meta.movieTitle || movieUrl}.`);
        } else {
            log.info(`Reviews service unavailable (${apiResult.reason}) for ${movieUrl}; using server-rendered review data.`);
        }
    }

    if (!records.length) {
        records = selectPageRecords($, reviewsData, meta, reviewType, params);
    }

    records = dedupeRecords(records).slice(0, remaining);

    if (!records.length) {
        log.warning(`No ${reviewType} reviews found on ${movieUrl}.`);
        return 0;
    }

    await Actor.pushData(records);
    log.info(`Saved ${records.length} reviews for ${meta.movieTitle || movieUrl}. Total: ${totalSaved + records.length}/${resultsWanted}`);
    return records.length;
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
    const proxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;

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

    const session = new RtSession(proxyUrl);
    let totalSaved = 0;
    let loadedPages = 0;
    let failedPages = 0;

    for (const movieUrl of normalizedUrls) {
        if (totalSaved >= resultsWanted) break;

        try {
            const saved = await collectMovieReviews({
                session,
                movieUrl,
                reviewType: selectedReviewType,
                maxPages,
                resultsWanted,
                totalSaved,
            });
            totalSaved += saved;
            loadedPages++;
        } catch (error) {
            failedPages++;
            log.warning(`Skipping ${movieUrl}: ${error.message}`);
        }
    }

    if (totalSaved === 0) {
        if (loadedPages === 0 && failedPages > 0) {
            throw new Error('Unable to collect any reviews: every movie page failed to load.');
        }
        log.warning('Run finished but no reviews were collected for the requested review type.');
    }

    log.info(`Finished. Total reviews saved: ${totalSaved} (pages loaded: ${loadedPages}, failed: ${failedPages}).`);
    await Actor.exit();
} catch (error) {
    log.exception(error, 'Actor failed');
    await Actor.fail(String(error));
}
