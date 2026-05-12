import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';

const BASE_URL = 'https://www.rottentomatoes.com';
const DEFAULT_RESULTS_WANTED = 20;
const DEFAULT_MAX_PAGES = 10;
const PAGE_SIZE = 20;

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
    try {
        const parsed = new URL(rawUrl, BASE_URL);
        const host = parsed.hostname.toLowerCase();
        if (!host.includes('rottentomatoes.com')) return null;

        const segments = parsed.pathname.split('/').filter(Boolean);
        if (segments[0] !== 'm' || !segments[1]) return null;

        return `${BASE_URL}/m/${segments[1]}`;
    } catch {
        return null;
    }
}

function parseQueryReviewType(urlString) {
    try {
        const parsed = new URL(urlString, BASE_URL);
        const type = (parsed.searchParams.get('type') || '').toLowerCase();
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
    const proxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;

    return gotScraping({
        url,
        proxyUrl,
        throwHttpErrors: false,
        retry: { limit: 2 },
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0',
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            ...(options.headers || {}),
        },
        ...options,
    });
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

    const emsId = props?.vanity?.emsId || props?.media?.emsId || reviewsData?.media?.emsId;
    if (!emsId) {
        throw new Error(`Failed to resolve movie ID from ${reviewsPageUrl}`);
    }

    const movieDetailsUrl = `${BASE_URL}/napi/rtcf/v1/movies/${emsId}`;
    const detailsResponse = await requestWithProxy(proxyConfig, movieDetailsUrl, {
        headers: {
            Referer: reviewsPageUrl,
        },
    });

    if (detailsResponse.statusCode !== 200) {
        throw new Error(`Failed to fetch movie details (${detailsResponse.statusCode}) for ID: ${emsId}`);
    }

    let movieDetails = null;
    try {
        const parsed = JSON.parse(detailsResponse.body);
        movieDetails = Array.isArray(parsed) ? parsed[0]?.movieDetail : parsed?.movieDetail;
    } catch {
        movieDetails = null;
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
        movieTitle: movieDetail.title || movieContext.props?.media?.title,
        movieUrl: movieDetail.rottenTomatoesUrl || movieContext.movieUrl,
        mediaUrl: movieDetail.mediaUrl,
        movieVanity: movieDetail.vanity || movieContext.props?.vanity?.value,
        movieEmsId: movieDetail.emsMovieId || movieContext.emsId,
        rottenTomatoesMovieId: movieDetail.rottenTomatoesMovieId,
        fandangoMovieId: movieDetail.fandangoMovieId,
        releaseDate: movieDetail.lifecycleWindow?.date,
        releaseLifecycle: movieDetail.lifecycleWindow?.lifecycle,
        tomatometerScore: movieDetail.tomatometerScore?.score,
        tomatometerSentiment: movieDetail.tomatometerScore?.scoreSentiment,
        audienceScore: movieDetail.audienceScore?.score,
        audienceSentiment: movieDetail.audienceScore?.scoreSentiment,
        criticsConsensus: movieDetail.criticsConsensus?.consensus,
        audienceConsensus: movieDetail.audienceConsensus?.consensus,
        reviewId: review.reviewId,
        ratingId: review.ratingId,
        createDate: review.createDate,
        updateDate: review.updateDate,
        scoreSentiment: review.scoreSentiment,
        originalScore: review.originalScore,
        rating: review.rating,
        isTopReview: review.isTopReview,
        isFresh: review.isFresh,
        isRotten: review.isRotten,
        quote: review.reviewQuote || review.review,
        fullReviewUrl: review.publicationReviewUrl,
        isSpoiler: review.hasSpoilers,
        hasProfanity: review.hasProfanity,
        isVerified: review.isVerified,
        isSuperReviewer: review.isSuperReviewer,
        userDisplayName: review.displayName,
        userInitials: review.initials,
        userRealm: review.user?.realm,
        criticName: review.criticName || review.critic?.name,
        criticSlug: review.critic?.slug,
        publicationName: review.publicationName || review.publication?.name,
        publicationUrl: review.publication?.url,
        publicationIconUrl: review.publication?.icon?.url,
        rawReview: review,
    };

    return cleanObject(baseRecord);
}

function getRequestedReviewType(inputReviewType, urlReviewType) {
    if (urlReviewType && REVIEW_TYPE_TO_PARAMS[urlReviewType]) return urlReviewType;
    if (inputReviewType && REVIEW_TYPE_TO_PARAMS[inputReviewType]) return inputReviewType;
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

    const inferredTypeFromUrl = urlCandidates
        .map((candidate) => parseQueryReviewType(candidate))
        .find(Boolean);
    const selectedReviewType = getRequestedReviewType(reviewType, inferredTypeFromUrl);
    const reviewParams = REVIEW_TYPE_TO_PARAMS[selectedReviewType];

    let totalSaved = 0;

    for (const movieUrl of normalizedUrls) {
        if (totalSaved >= resultsWanted) break;

        const movieContext = await resolveMovieContext(movieUrl, proxyConfig);

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

            const response = await requestWithProxy(proxyConfig, apiUrl.toString(), {
                headers: {
                    Referer: movieContext.reviewsPageUrl,
                },
            });

            if (response.statusCode !== 200) {
                log.warning(`Reviews API returned ${response.statusCode} for ${apiUrl}`);
                break;
            }

            let payload;
            try {
                payload = JSON.parse(response.body);
            } catch {
                log.warning(`Failed parsing JSON from reviews API for ${movieContext.movieUrl}`);
                break;
            }

            const pageInfo = payload?.pageInfo || {};
            const reviews = Array.isArray(payload?.reviews) ? payload.reviews : [];

            if (!reviews.length) {
                log.info(`No more reviews found on page ${page} for ${movieContext.movieUrl}`);
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

            hasNextPage = Boolean(pageInfo.hasNextPage) && records.length > 0;
            after = pageInfo.endCursor || '';
            before = pageInfo.startCursor || '';
            page += 1;
        }
    }

    if (totalSaved === 0) {
        throw new Error('Run finished but no reviews were collected.');
    }

    log.info(`Finished successfully. Total reviews saved: ${totalSaved}`);
    await Actor.exit();
} catch (error) {
    log.exception(error, 'Actor failed');
    await Actor.fail(String(error));
}
