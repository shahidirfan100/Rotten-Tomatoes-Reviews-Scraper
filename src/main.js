import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { chromium } from 'playwright';

const BASE_URL = 'https://www.rottentomatoes.com';
const DEFAULT_RESULTS_WANTED = 20;
const DEFAULT_MAX_PAGES = 10;
const PAGE_SIZE = 20;
const REQUEST_TIMEOUT_MS = 30000;

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

async function createBrowserPage(proxyUrl) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
        ...(proxyUrl && { proxy: { server: proxyUrl } }),
    });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        locale: 'en-US',
        extraHTTPHeaders: {
            'sec-ch-ua': '"Chromium";v="147", "Google Chrome";v="147", "Not.A/Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
        },
    });
    const page = await context.newPage();

    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        window.chrome = window.chrome || { runtime: {} };
    });

    await page.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        if (['image', 'font', 'media'].includes(resourceType)) return route.abort();
        return route.continue();
    });

    return { browser, page };
}

function buildMovieContext(movieUrl, reviewsPageUrl, html) {
    const props = extractDataJsonBlock(html, 'props');
    const reviewsData = extractDataJsonBlock(html, 'reviewsData');

    const emsId = getPath(props, ['vanity', 'emsId'])
        || getPath(props, ['media', 'emsId'])
        || getPath(reviewsData, ['media', 'emsId']);
    if (!emsId) {
        throw new Error(`Failed to resolve movie ID from ${reviewsPageUrl}`);
    }

    return {
        movieUrl,
        reviewsPageUrl,
        emsId,
        props: props || {},
        movieDetails: {},
    };
}

async function collectReviewsWithBrowser({
    movieUrl,
    reviewParams,
    selectedReviewType,
    maxPages,
    resultsWanted,
    totalSaved,
    proxyUrl,
}) {
    let browser;
    let saved = 0;

    try {
        const browserSession = await createBrowserPage(proxyUrl);
        browser = browserSession.browser;
        const { page } = browserSession;
        const reviewsPageUrl = `${movieUrl}/reviews`;

        await page.goto(reviewsPageUrl, { waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT_MS });
        await page.waitForLoadState('networkidle', { timeout: REQUEST_TIMEOUT_MS }).catch(() => {});

        const movieContext = buildMovieContext(movieUrl, reviewsPageUrl, await page.content());
        log.info(`Collecting ${selectedReviewType} reviews for: ${movieContext.movieUrl}`);

        const pages = await page.evaluate(
            async (browserRequestConfig) => {
                const {
                    baseUrl,
                    emsId,
                    reviewParams: browserReviewParams,
                    pageSize,
                    resultsWanted: browserResultsWanted,
                    totalSaved: browserTotalSaved,
                    maxPages: browserMaxPages,
                } = browserRequestConfig;
                const collectedPages = [];
                let after = '';
                let before = '';
                let pageNumber = 1;
                let savedCount = browserTotalSaved;
                let hasNextPage = true;

                while (hasNextPage && pageNumber <= browserMaxPages && savedCount < browserResultsWanted) {
                    const pageCount = Math.min(pageSize, browserResultsWanted - savedCount);
                    const apiUrl = new URL(`${baseUrl}/napi/rtcf/v1/movies/${emsId}/reviews`);
                    apiUrl.searchParams.set('after', after);
                    apiUrl.searchParams.set('before', before);
                    apiUrl.searchParams.set('pageCount', String(pageCount));
                    apiUrl.searchParams.set('topOnly', String(browserReviewParams.topOnly));
                    apiUrl.searchParams.set('type', browserReviewParams.type);
                    apiUrl.searchParams.set('verified', String(browserReviewParams.verified));

                    const response = await fetch(apiUrl.toString());
                    if (!response.ok) {
                        throw new Error(`Browser reviews API returned ${response.status} for ${apiUrl}`);
                    }

                    const payload = await response.json();
                    const reviews = Array.isArray(payload?.reviews) ? payload.reviews : [];
                    const pageInfo = payload?.pageInfo || {};
                    collectedPages.push({ page: pageNumber, reviews, pageInfo });

                    if (!reviews.length) break;

                    savedCount += reviews.length;
                    hasNextPage = Boolean(pageInfo.hasNextPage);
                    after = pageInfo.endCursor || '';
                    before = pageInfo.startCursor || '';
                    pageNumber += 1;
                }

                return collectedPages;
            },
            {
                baseUrl: BASE_URL,
                emsId: movieContext.emsId,
                reviewParams,
                pageSize: PAGE_SIZE,
                resultsWanted,
                totalSaved,
                maxPages,
            },
        );

        for (const browserPage of pages) {
            const remainingSlots = resultsWanted - totalSaved - saved;
            const records = browserPage.reviews
                .slice(0, remainingSlots)
                .map((review) => buildReviewRecord({
                    review,
                    movieContext,
                    reviewType: selectedReviewType,
                    page: browserPage.page,
                }))
                .filter(Boolean);

            if (!records.length) break;

            await Dataset.pushData(records);
            saved += records.length;
            log.info(`Saved ${records.length} reviews from page ${browserPage.page}. Total saved: ${totalSaved + saved}/${resultsWanted}`);
        }
    } finally {
        if (browser) await browser.close();
    }

    return saved;
}

function buildReviewRecord({ review, movieContext, reviewType, page }) {
    const movieDetail = movieContext.movieDetails;

    const baseRecord = {
        queryReviewType: reviewType,
        page,
        movieTitle: getField(movieDetail, 'title') || getPath(movieContext.props, ['media', 'title']),
        movieUrl: getField(movieDetail, 'rottenTomatoesUrl') || movieContext.movieUrl,
        mediaUrl: getField(movieDetail, 'mediaUrl') || getPath(movieContext.props, ['media', 'link']),
        movieVanity: getField(movieDetail, 'vanity') || getPath(movieContext.props, ['vanity', 'value']),
        movieEmsId: getField(movieDetail, 'emsMovieId') || movieContext.emsId,
        rottenTomatoesMovieId: getField(movieDetail, 'rottenTomatoesMovieId'),
        fandangoMovieId: getField(movieDetail, 'fandangoMovieId'),
        releaseDate: getPath(movieDetail, ['lifecycleWindow', 'date']) || getPath(movieContext.props, ['vanity', 'lifecycleWindow', 'date']),
        releaseLifecycle: getPath(movieDetail, ['lifecycleWindow', 'lifecycle']) || getPath(movieContext.props, ['vanity', 'lifecycleWindow', 'lifecycle']),
        tomatometerScore: getPath(movieDetail, ['tomatometerScore', 'score']) || getPath(movieContext.props, ['media', 'tomatometerScore', 'value']),
        tomatometerSentiment: getPath(movieDetail, ['tomatometerScore', 'scoreSentiment'])
            || getPath(movieContext.props, ['media', 'tomatometerScore', 'state']),
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
        criticName: getField(review, 'criticName') || getPath(review, ['critic', 'name']) || getPath(review, ['critic', 'displayName']),
        criticSlug: getPath(review, ['critic', 'slug']) || getPath(review, ['critic', 'vanity']),
        publicationName: getField(review, 'publicationName') || getPath(review, ['publication', 'name']),
        publicationUrl: getPath(review, ['publication', 'url']) || getPath(review, ['publication', 'editorialUrl']),
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
    const reviewParams = REVIEW_TYPE_TO_PARAMS[selectedReviewType];

    let totalSaved = 0;

    for (const movieUrl of normalizedUrls) {
        if (totalSaved >= resultsWanted) break;

        try {
            const saved = await collectReviewsWithBrowser({
                movieUrl,
                reviewParams,
                selectedReviewType,
                maxPages,
                resultsWanted,
                totalSaved,
                proxyUrl,
            });
            totalSaved += saved;
        } catch (error) {
            log.warning(`Skipping ${movieUrl}: ${error.message}`);
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
