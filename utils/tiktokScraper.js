const https = require('https');
const http = require('http');
const querystring = require('querystring');

/**
 * Scrapes REAL TikTok public video metrics (Views & Likes).
 * Uses TikWM API as primary method and Direct HTML Parsing as fallback.
 * @param {string} videoUrl 
 */
async function fetchTikTokMetrics(videoUrl) {
    try {
        const cleanUrl = videoUrl.trim();

        // 1. Primary Method: TikWM Public API (Supports vt.tiktok.com short links & full URLs)
        let metrics = await fetchFromTikWM(cleanUrl);

        // 2. Fallback Method: Direct HTML Scraping with Redirect Resolver & Browser Headers
        if (!metrics || metrics.views === 0) {
            metrics = await fetchFromTikTokDirect(cleanUrl);
        }

        if (!metrics) {
            metrics = {
                authorUsername: '@unknown',
                views: 0,
                likes: 0
            };
        }

        const views = metrics.views || 0;
        const likes = metrics.likes || 0;

        // Calculate Engagement Rate (%) based on 10:1 ratio (10% Like Rate = 100% Score)
        const likeRatePercent = views > 0 ? (likes / views) * 100 : 0;
        const engagementScore = views > 0 ? Math.round((likeRatePercent / 10) * 100) : 0;

        return {
            success: views > 0,
            authorUsername: metrics.authorUsername || '@unknown',
            views,
            likes,
            engagementScore,
            likeRatePercent: likeRatePercent.toFixed(2)
        };
    } catch (error) {
        console.error('[TIKTOK SCRAPER ERROR]:', error.message);
        return {
            success: false,
            authorUsername: '@unknown',
            views: 0,
            likes: 0,
            engagementScore: 0,
            likeRatePercent: '0.00'
        };
    }
}

/**
 * Primary Method: Fetch video metrics via TikWM API
 */
function fetchFromTikWM(videoUrl) {
    return new Promise((resolve) => {
        const postData = querystring.stringify({
            url: videoUrl,
            count: 12,
            cursor: 0,
            web: 1
        });

        const options = {
            hostname: 'www.tikwm.com',
            port: 443,
            path: '/api/',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'X-Requested-With': 'XMLHttpRequest'
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    if (json && json.code === 0 && json.data) {
                        resolve({
                            authorUsername: json.data.author?.unique_id ? `@${json.data.author.unique_id}` : '@unknown',
                            views: parseInt(json.data.play_count || 0, 10),
                            likes: parseInt(json.data.digg_count || 0, 10)
                        });
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    resolve(null);
                }
            });
        });

        req.on('error', () => resolve(null));
        req.setTimeout(8000, () => {
            req.destroy();
            resolve(null);
        });
        req.write(postData);
        req.end();
    });
}

/**
 * Fallback Method: Resolve redirects and scrape directly from HTML
 */
async function fetchFromTikTokDirect(videoUrl) {
    try {
        const resolvedUrl = await resolveAllRedirects(videoUrl);
        const html = await fetchHtml(resolvedUrl);

        if (!html) return null;

        let views = 0;
        let likes = 0;
        let authorUsername = '@unknown';

        // Extract from JSON script tags
        const rehydrationMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)<\/script>/s);
        if (rehydrationMatch && rehydrationMatch[1]) {
            try {
                const jsonData = JSON.parse(rehydrationMatch[1]);
                const defaultScope = jsonData.__DEFAULT_SCOPE__ || {};
                const videoDetail = defaultScope['webapp.video-detail'] || {};
                const itemInfo = videoDetail.itemInfo?.itemStruct;

                if (itemInfo) {
                    views = parseInt(itemInfo.stats?.playCount || 0, 10);
                    likes = parseInt(itemInfo.stats?.diggCount || 0, 10);
                    authorUsername = itemInfo.author?.uniqueId ? `@${itemInfo.author.uniqueId}` : authorUsername;
                }
            } catch (e) {}
        }

        // Regex Fallback
        if (views === 0) {
            const playMatch = html.match(/"playCount":\s*(\d+)/) || html.match(/"play_count":\s*(\d+)/);
            if (playMatch) views = parseInt(playMatch[1], 10);

            const diggMatch = html.match(/"diggCount":\s*(\d+)/) || html.match(/"digg_count":\s*(\d+)/);
            if (diggMatch) likes = parseInt(diggMatch[1], 10);

            const authorMatch = html.match(/"uniqueId":\s*"([^"]+)"/);
            if (authorMatch) authorUsername = `@${authorMatch[1]}`;
        }

        return { authorUsername, views, likes };
    } catch (e) {
        return null;
    }
}

function resolveAllRedirects(url, maxRedirects = 5) {
    return new Promise((resolve) => {
        let currentUrl = url;
        let count = 0;

        function step(targetUrl) {
            if (count >= maxRedirects || (!targetUrl.includes('vt.tiktok.com') && !targetUrl.includes('vm.tiktok.com') && !targetUrl.includes('/t/'))) {
                return resolve(targetUrl);
            }
            count++;

            const client = targetUrl.startsWith('https') ? https : http;
            const req = client.get(targetUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                }
            }, (res) => {
                if (res.headers.location) {
                    let loc = res.headers.location;
                    if (loc.startsWith('/')) {
                        try {
                            const parsed = new URL(targetUrl);
                            loc = `${parsed.protocol}//${parsed.host}${loc}`;
                        } catch (e) {}
                    }
                    step(loc);
                } else {
                    resolve(targetUrl);
                }
            });

            req.on('error', () => resolve(targetUrl));
            req.setTimeout(5000, () => {
                req.destroy();
                resolve(targetUrl);
            });
        }

        step(currentUrl);
    });
}

function fetchHtml(url) {
    return new Promise((resolve) => {
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.tiktok.com/'
            }
        };

        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });

        req.on('error', () => resolve(''));
        req.setTimeout(8000, () => {
            req.destroy();
            resolve('');
        });
    });
}

module.exports = { fetchTikTokMetrics };
