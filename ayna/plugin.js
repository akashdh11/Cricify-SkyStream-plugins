(function() {
    /**
     * @typedef {Object} Response
     * @property {boolean} success
     * @property {any} [data]
     * @property {string} [errorCode]
     * @property {string} [message]
     */

    /**
     * @type {import('@skystream/sdk').Manifest}
     */
    // var manifest is injected at runtime

    /**
     * Base64 Polyfills for QuickJS (Environment Compatibility)
     */
    const b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    function atob(input) {
        let str = String(input).replace(/[=]+$/, '');
        if (str.length % 4 === 1) throw new Error("'atob' failed");
        for (var bc = 0, bs, buffer, idx = 0, output = ''; buffer = str.charAt(idx++); ~buffer && (bs = bc % 4 ? bs * 64 + buffer : buffer, bc++ % 4) ? output += String.fromCharCode(255 & bs >> (-2 * bc & 6)) : 0) {
            buffer = b64chars.indexOf(buffer);
        }
        return output;
    }

    function btoa(input) {
        let str = String(input);
        for (var block, charCode, idx = 0, map = b64chars, output = ''; str.charAt(idx | 0) || (map = '=', idx % 1); output += map.charAt(63 & block >> 8 - idx % 1 * 8)) {
            charCode = str.charCodeAt(idx += 3 / 4);
            block = block << 8 | charCode;
        }
        return output;
    }

    /**
     * DRM Helpers (Native Parity)
     */
    function base64ToHex(str) {
        if (!str) return null;
        try {
            const raw = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
            let result = '';
            for (let i = 0; i < raw.length; i++) {
                const hex = raw.charCodeAt(i).toString(16);
                result += (hex.length === 2 ? hex : '0' + hex);
            }
            return result.toLowerCase();
        } catch (e) { return null; }
    }

    function hexToBase64Url(hex) {
        if (!hex) return null;
        try {
            let str = '';
            for (let i = 0; i < hex.length; i += 2) {
                str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
            }
            return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        } catch (e) { return null; }
    }

    function normalizeDrmHex(str) {
        if (!str || str === "null") return null;
        const trimmed = str.trim();
        if (/^[0-9a-fA-F\-]+$/.test(trimmed)) {
            return trimmed.replace(/-/g, '').toLowerCase();
        }
        return base64ToHex(trimmed);
    }

    /**
     * AES Decryption for M3U content (Native Parity)
     */
    async function decryptM3U(content) {
        if (!content) return "";
        const trimmed = content.trim();
        if (trimmed.startsWith("#EXTM3U") || trimmed.startsWith("#EXTINF")) return trimmed;
        if (trimmed.length < 79) return trimmed;
        
        try {
            const ivBase64 = trimmed.substring(10, 34);
            const keyBase64 = trimmed.substring(trimmed.length - 54, trimmed.length - 10);
            const part1 = trimmed.substring(0, 10);
            const part2 = trimmed.substring(34, trimmed.length - 54);
            const part3 = trimmed.substring(trimmed.length - 10);
            const encryptedData = part1 + part2 + part3;
            
            const decrypted = await crypto.decryptAES(encryptedData, keyBase64, ivBase64, { mode: 'cbc' });
            return decrypted || trimmed;
        } catch (e) { return trimmed; }
    }

    /**
     * Helper to fetch the M3U playlist.
     */
    async function fetchM3U() {
        const url = `${manifest.baseUrl}/aynaott.php`;
        const headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; rv:78.0) Gecko/20100101 Firefox/78.0",
            "Referer": "https://ranapk.short.gy/"
        };
        const response = await http_get(url, headers);
        const status = response.status !== undefined ? response.status : response.statusCode;
        if (status >= 200 && status < 300) {
            return await decryptM3U(response.body);
        } else {
            throw new Error(`HTTP Error ${status || 'No Response'} fetching AYNA M3U`);
        }
    }

    /**
     * Helper to parse M3U string into MultimediaItems organized by category.
     */
    function parseM3U(m3uString) {
        const lines = m3uString.split('\n');
        const categories = { "Other Channels": [] };
        let currentChannel = null;
        
        let pendingProps = { headers: {}, kodiProps: {}, drmKeys: {} };

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            if (line.startsWith("#EXTINF:-1")) {
                currentChannel = { 
                    title: "Unknown Channel", 
                    poster: "", 
                    group: "Other Channels", 
                    headers: Object.assign({}, pendingProps.headers), 
                    kodiProps: Object.assign({}, pendingProps.kodiProps),
                    drmKeys: Object.assign({}, pendingProps.drmKeys)
                };
                pendingProps = { headers: {}, kodiProps: {}, drmKeys: {} };
                
                const logoMatch = line.match(/tvg-logo="([^"]*)"/);
                if (logoMatch && logoMatch[1]) currentChannel.poster = logoMatch[1];
                
                const groupMatch = line.match(/group-title="([^"]*)"/);
                if (groupMatch && groupMatch[1]) {
                    currentChannel.group = groupMatch[1];
                    if (!categories[currentChannel.group]) categories[currentChannel.group] = [];
                }
                
                const splitName = line.split(",");
                if (splitName.length > 1) currentChannel.title = splitName[splitName.length - 1].trim();
            } else if (line.startsWith("#EXTVLCOPT:http-user-agent=")) {
                const ua = line.split("=")[1].trim();
                const target = currentChannel || pendingProps;
                target.headers["User-Agent"] = ua;
            } else if (line.startsWith("#KODIPROP:inputstream.adaptive.license_key=")) {
                let licenseKey = line.split("=")[1].trim();
                if ((licenseKey.startsWith('"') && licenseKey.endsWith('"')) || (licenseKey.startsWith("'") && licenseKey.endsWith("'"))) {
                    licenseKey = licenseKey.substring(1, licenseKey.length - 1);
                }
                const target = currentChannel || pendingProps;
                if (licenseKey.startsWith("{")) {
                    try {
                        const json = JSON.parse(licenseKey);
                        const keys = json.keys || [];
                        keys.forEach(k => {
                            const kid = normalizeDrmHex(k.kid);
                            const key = normalizeDrmHex(k.k);
                            if (kid && key) target.drmKeys[kid] = key;
                        });
                        if (keys.length > 0) {
                            target.kodiProps.keyId = normalizeDrmHex(keys[0].kid);
                            target.kodiProps.key = normalizeDrmHex(keys[0].k);
                        }
                    } catch (e) {}
                } else {
                    target.kodiProps.licenseUrl = licenseKey;
                }
            } else if (line.startsWith("http")) {
                if (currentChannel) {
                    if (line.includes("|")) {
                        const parts = line.split("|");
                        currentChannel.url = parts[0];
                        const headersPart = parts[1];
                        const headerPairs = headersPart.split("&");
                        for (let j = 0; j < headerPairs.length; j++) {
                            const kv = headerPairs[j].split("=");
                            if (kv.length >= 2) currentChannel.headers[kv[0]] = kv.slice(1).join("=");
                        }
                    } else {
                        currentChannel.url = line;
                    }
                    
                    const item = new MultimediaItem({
                        title: currentChannel.title,
                        url: JSON.stringify(currentChannel),
                        posterUrl: currentChannel.poster || `https://placehold.co/400x600.png?text=${encodeURIComponent(currentChannel.title)}`,
                        type: "livestream",
                        description: `Live Stream from ${currentChannel.group}`,
                        headers: currentChannel.headers
                    });

                    categories[currentChannel.group].push(item);
                    currentChannel = null;
                }
            }
        }
        
        const finalOutput = {};
        for (const cat in categories) {
            if (categories[cat].length > 0) finalOutput[cat] = categories[cat];
        }
        return finalOutput;
    }

    /**
     * Loads the home screen categories.
     */
    async function getHome(cb) {
        try {
            const m3u = await fetchM3U();
            const data = parseM3U(m3u);
            cb({ success: true, data });
        } catch (e) {
            cb({ success: false, errorCode: "SITE_OFFLINE", message: e.message || String(e) });
        }
    }

    /**
     * Searches for media items.
     */
    async function search(query, cb) {
        try {
            const m3u = await fetchM3U();
            const categories = parseM3U(m3u);
            const results = [];
            const q = query.toLowerCase();
            for (const cat in categories) {
                categories[cat].forEach(item => {
                    if (item.title.toLowerCase().includes(q)) results.push(item);
                });
            }
            cb({ success: true, data: results });
        } catch (e) {
            cb({ success: false, errorCode: "SITE_OFFLINE", message: e.message || String(e) });
        }
    }

    /**
     * Loads details for a specific media item.
     */
    async function load(url, cb) {
        try {
            let channelData;
            try { channelData = JSON.parse(url); } catch (e) { channelData = { title: "Live Channel", url: url, poster: "", group: "IPTV", headers: {} }; }
            const poster = channelData.poster || `https://placehold.co/400x600.png?text=${encodeURIComponent(channelData.title)}`;
            cb({
                success: true,
                data: new MultimediaItem({
                    title: channelData.title,
                    url: url,
                    posterUrl: poster,
                    type: "livestream",
                    description: `Live TV Channel - ${channelData.group}`,
                    headers: channelData.headers || {},
                    episodes: [
                        new Episode({ name: "Live", season: 1, episode: 1, url: url, posterUrl: poster })
                    ]
                })
            });
        } catch (e) { cb({ success: false, errorCode: "PARSE_ERROR", message: e.message || String(e) }); }
    }

    /**
     * Resolves streams for a specific media item or episode.
     */
    async function loadStreams(url, cb) {
        try {
            const channelData = JSON.parse(url);
            let targetUrl = channelData.url;
            let targetKey = channelData.kodiProps.key;
            let targetKid = channelData.kodiProps.keyId;
            let licenseUrl = channelData.kodiProps.licenseUrl;
            
            const headers = {
                "User-Agent": channelData.headers["User-Agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            };
            
            // Apply any additional headers from M3U
            if (channelData.headers) {
                for (const h in channelData.headers) {
                    if (h.toLowerCase() !== "user-agent") headers[h] = channelData.headers[h];
                }
            }

            // Proxy Bypass Analysis
            if (channelData.drmKeys || targetUrl.includes(".mpd")) {
                try {
                    const response = await http_get(targetUrl, headers);
                    const body = response.body || "";
                    const kidMatch = body.match(/cenc:default_KID=["']([0-9a-fA-F\-]{36})["']/);
                    if (kidMatch && kidMatch[1]) {
                        const mpdKidHex = kidMatch[1].replace(/-/g, '').toLowerCase();
                        if (channelData.drmKeys && channelData.drmKeys[mpdKidHex]) {
                            targetKid = mpdKidHex;
                            targetKey = channelData.drmKeys[mpdKidHex];
                        }
                        if (!targetUrl.includes(".mpd")) targetUrl += targetUrl.includes("?") ? "&extension=.mpd" : "?extension=.mpd";
                    } else if (body.includes("#EXTM3U")) {
                        if (!targetUrl.includes(".m3u8")) targetUrl += targetUrl.includes("?") ? "&extension=.m3u8" : "?extension=.m3u8";
                    }
                } catch (e) {}
            } else if (targetUrl.includes(".php")) {
                // PHP links often redirect to HLS/DASH, add extension hint to bypass proxy
                if (!targetUrl.toLowerCase().includes("extension=")) {
                    targetUrl += targetUrl.includes("?") ? "&extension=.m3u8" : "?extension=.m3u8";
                }
            }

            cb({
                success: true,
                data: [
                    new StreamResult({
                        url: targetUrl,
                        source: "Auto",
                        headers: headers,
                        drmKey: hexToBase64Url(targetKey),
                        drmKid: hexToBase64Url(targetKid),
                        licenseUrl: licenseUrl
                    })
                ]
            });
        } catch (e) { cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) }); }
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
