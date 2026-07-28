// ==UserScript==
// @name         豆包助手
// @namespace    local.doubao.assistant
// @version      0.2.1
// @description  豆包对话素材工作台，集成媒体提取和 ZIP 打包下载
// @author       豆包助手
// @match        https://www.doubao.com/chat/*
// @match        https://www.doubao.com/thread/*
// @match        https://www.dola.com/chat/*
// @match        https://www.dola.com/thread/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      *
// @license      MIT
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const NativeReadableStream = pageWindow.ReadableStream || ReadableStream;
    const NativeResponse = pageWindow.Response || Response;

    let chatImages = [];
    let chatVideos = [];
    let uiInitialized = false;
    let currentTopicContext = { id: 'uncategorized', title: '未分类话题' };
    const chatImageIndex = new Map();
    const chatVideoUrlIndex = new Set();
    const chatVideoVidIndex = new Set();
    const processedFallbackApis = new Set();
    const fallbackVideoPosterIndex = new Map();
    const pendingFallbackVideoRequests = new Set();
    const fallbackVideoFailures = new Map();
    const VIDEO_REQUEST_TIMEOUT = 12000;
    const VIDEO_REQUEST_RETRY_COUNT = 1;
    let detectedFallbackVideoCount = 0;
    let currentSharePageInfo = null;
    let currentSharePagePayload = null;
    let mediaProgressReporter = null;

    const QAAB_SALT_HEX = '4dd4c2e6b83162090e52b3c7a6733ba4'
        + '1cb2462b829ab58a196b39db57177524'
        + 'f49baf7f08e8d68d26a72e37c1a95a2f'
        + '1f05a51892aef2949732b62a38aadd58';

    function isDoubaoPage() {
        return isDoubaoHost(pageWindow.location.hostname);
    }

    function isDoubaoHost(hostname) {
        return hostname.includes('doubao.com') || hostname.includes('dola.com');
    }

    function getDoubaoOrigin() {
        return isDoubaoPage() ? pageWindow.location.origin : 'https://www.doubao.com';
    }

    function updateTopicFromRequestBody(bodyText) {
        if (typeof bodyText !== 'string') return;
        try {
            const payload = JSON.parse(bodyText);
            currentTopicContext = createTopicContext(payload);
        } catch (error) {
        }
    }

    function normalizeImageUrl(url) {
        if (typeof url !== 'string') return '';

        const normalizedUrl = url.replace(/&amp;/g, '&');
        if (pageWindow.location.protocol !== 'https:' || !normalizedUrl.startsWith('http://')) {
            return normalizedUrl;
        }

        try {
            const parsedUrl = new URL(normalizedUrl);
            if (isDoubaoHost(parsedUrl.hostname)) {
                parsedUrl.protocol = 'https:';
                return parsedUrl.href;
            }
        } catch (error) {
            // Keep malformed or non-standard URLs unchanged for existing fallback handling.
        }
        return normalizedUrl;
    }

    function findConversationField(value, keys, depth = 0, seen = new Set()) {
        if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return '';
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value) {
                const result = findConversationField(item, keys, depth + 1, seen);
                if (result) return result;
            }
            return '';
        }
        for (const key of keys) {
            const candidate = value[key];
            if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
        }
        for (const child of Object.values(value)) {
            const result = findConversationField(child, keys, depth + 1, seen);
            if (result) return result;
        }
        return '';
    }

    function getConversationRouteId() {
        const match = pageWindow.location.pathname.match(/\/(chat|thread)\/([^/?#]+)/i);
        if (match?.[2]) return match[2];
        const params = new URLSearchParams(pageWindow.location.search);
        return params.get('conversation_id') || params.get('session_id') || pageWindow.location.pathname;
    }

    function getPageConversationTitle() {
        const title = String(document.title || '')
            .replace(/[-_|]\s*(豆包|Doubao).*$/i, '')
            .replace(/^豆包\s*[-_|]?\s*/i, '')
            .trim();
        return title && !/^豆包$/i.test(title) ? title : '';
    }

    function createTopicContext(source) {
        const value = source && typeof source === 'object' ? source : {};
        const sourceId = findConversationField(value, [
            'conversation_id', 'conversationId', 'session_id', 'sessionId', 'section_id', 'sectionId'
        ]);
        const routeId = getConversationRouteId();
        const currentId = currentTopicContext.id?.startsWith('conversation-')
            ? currentTopicContext.id.slice('conversation-'.length)
            : '';
        const id = sourceId || (!['/chat/', '/thread/'].includes(routeId) ? routeId : currentId) || routeId;
        let title = findConversationField(value, [
            'conversation_title', 'conversationTitle', 'conversation_name', 'session_name', 'topic_name', 'title'
        ]);
        if (!title && currentId === id && !currentTopicContext.isFallback) title = currentTopicContext.title;
        if (!title) title = getPageConversationTitle();
        title = title.replace(/\s+/g, ' ').trim();
        if (title.length > 34) title = `${title.slice(0, 34)}...`;
        const shortId = String(id || 'current').slice(-8);
        return { id: `conversation-${id || 'current'}`, title: title || `对话 ${shortId}`, isFallback: !title };
    }

    function refineTopicFromCreation(creation, topic) {
        return topic;
    }

    function rebuildChatImageIndex(images = chatImages) {
        chatImageIndex.clear();
        for (const image of images) {
            const url = normalizeImageUrl(image?.url);
            if (!url) continue;
            image.url = url;
            chatImageIndex.set(url, image);
        }
    }

    function replaceChatImages(images) {
        chatImages = Array.isArray(images) ? images : [];
        rebuildChatImageIndex(chatImages);
    }

    function addChatImage(imageInfo) {
        const url = normalizeImageUrl(imageInfo?.url);
        if (!url) return false;

        const width = imageInfo.width || 0;
        const height = imageInfo.height || 0;
        const existingImage = chatImageIndex.get(url);
        if (existingImage) {
            if (!existingImage.width && width) existingImage.width = width;
            if (!existingImage.height && height) existingImage.height = height;
            if (!existingImage.previewUrl && imageInfo.previewUrl) existingImage.previewUrl = imageInfo.previewUrl;
            if (imageInfo.topic && (!existingImage.topicId || existingImage.topicId === 'uncategorized')) {
                existingImage.topicId = imageInfo.topic.id;
                existingImage.topicTitle = imageInfo.topic.title;
            }
            return false;
        }

        const topic = imageInfo.topic || currentTopicContext;
        const image = {
            url,
            previewUrl: normalizeImageUrl(imageInfo.previewUrl),
            width,
            height,
            topicId: topic.id,
            topicTitle: topic.title
        };
        chatImages.push(image);
        chatImageIndex.set(url, image);
        return true;
    }

    function getUrlInfo(value) {
        if (typeof value === 'string') return { url: normalizeImageUrl(value), width: 0, height: 0 };
        if (!value || typeof value !== 'object') return null;
        if (Array.isArray(value)) return value.map(getUrlInfo).find(Boolean) || null;
        const url = normalizeImageUrl(value.url || value.image_url || value.src || value.uri);
        return url ? { url, width: value.width || 0, height: value.height || 0 } : null;
    }

    function getCreationImageInfo(creation) {
        const image = creation?.image || {};
        const imageData = image.image_ori_raw;
        const previewData = [
            image.image_thumb,
            image.image_thumb_raw,
            image.image_thumbnail,
            image.image_thumb_url,
            image.thumbnail,
            image.thumb,
            image.thumb_url,
            image.preview_url,
            image.image_ori
        ].map(getUrlInfo).find(Boolean);
        if (typeof imageData === 'string') {
            return { url: imageData, previewUrl: previewData?.url || '', width: 0, height: 0 };
        }
        if (imageData && typeof imageData === 'object' && imageData.url) {
            return {
                url: imageData.url,
                previewUrl: previewData?.url || '',
                width: imageData.width || 0,
                height: imageData.height || 0
            };
        }
        return null;
    }

    function getCreationVideoPoster(creation) {
        const video = creation?.video || {};
        const candidates = [
            video.poster_url,
            video.poster,
            video.cover_url,
            video.cover,
            video.thumbnail,
            video.first_frame,
            creation?.poster_url,
            creation?.cover_url
        ];
        return candidates.map(getUrlInfo).find(Boolean)?.url || '';
    }

    function addChatVideo(videoInfo, topic = currentTopicContext) {
        if (!videoInfo || !videoInfo.url) return;
        const url = normalizeImageUrl(videoInfo.url);
        const vid = videoInfo.vid ? String(videoInfo.vid) : '';
        if ((vid && chatVideoVidIndex.has(vid)) || chatVideoUrlIndex.has(url)) {
            const existingVideo = chatVideos.find(video => (vid && String(video.vid) === vid) || video.url === url);
            if (existingVideo && topic && (!existingVideo.topicId || existingVideo.topicId === 'uncategorized')) {
                existingVideo.topicId = topic.id;
                existingVideo.topicTitle = topic.title;
            }
            return;
        }

        const normalizedVideoInfo = {
            ...videoInfo,
            url,
            topicId: videoInfo.topicId || topic.id,
            topicTitle: videoInfo.topicTitle || topic.title
        };
        chatVideos.push(normalizedVideoInfo);
        chatVideoUrlIndex.add(url);
        if (vid) {
            chatVideoVidIndex.add(vid);
        }
    }

    const originalXHROpen = pageWindow.XMLHttpRequest.prototype.open;
    const originalXHRSend = pageWindow.XMLHttpRequest.prototype.send;

    pageWindow.XMLHttpRequest.prototype.open = function (method, url, ...args) {
        this._url = url;
        return originalXHROpen.apply(this, [method, url, ...args]);
    };

    pageWindow.XMLHttpRequest.prototype.send = function (...args) {
        const url = this._url;
        if (url && url.includes('/chat/completion') && typeof args[0] === 'string') {
            updateTopicFromRequestBody(args[0]);
        }
        this.addEventListener('load', function () {
            if (url && (url.includes('/im/chain/single'))) {
                try {
                    const data = JSON.parse(this.responseText);
                    currentTopicContext = createTopicContext(data);
                    const messages = data?.downlink_body?.pull_singe_chain_downlink_body?.messages;
                    if (messages && Array.isArray(messages)) {
                        parseChatHistoryImages(messages);
                        processDoubaoFallbackVideos(data, this.responseText);
                    } else {
                        processDoubaoFallbackVideos(data, this.responseText);
                    }
                } catch (e) {
                }
            }
        });
        return originalXHRSend.apply(this, args);
    };
    const originalFetch = pageWindow.fetch;
    pageWindow.fetch = async function (...args) {
        const url = args[0];
        const requestUrl = typeof url === 'string' ? url : (url?.url || '');

        if (requestUrl && requestUrl.includes('/im/chain/single')) {
            const response = await originalFetch.apply(this, args);
            response.clone().text().then(text => {
                try {
                    const data = JSON.parse(text);
                    currentTopicContext = createTopicContext(data);
                    const messages = data?.downlink_body?.pull_singe_chain_downlink_body?.messages;
                    if (Array.isArray(messages)) {
                        parseChatHistoryImages(messages);
                    }
                    processDoubaoFallbackVideos(data, text);
                } catch (e) {
                }
            }).catch(() => { });
            return response;
        }

        if (requestUrl && requestUrl.includes('/chat/completion')) {
            if (args[1]?.body && typeof args[1].body === 'string') {
                updateTopicFromRequestBody(args[1].body);
            }

            const response = await originalFetch.apply(this, args);
            if (!response.body || typeof response.body.getReader !== 'function') {
                return response;
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            const stream = new NativeReadableStream({
                async start(controller) {
                    let buffer = '';
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';

                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                try {
                                    const jsonStr = line.substring(6);
                                    if (jsonStr.includes('image_ori') || jsonStr.includes('fallback_api')) {
                                        const data = JSON.parse(jsonStr);
                                        if (jsonStr.includes('fallback_api')) {
                                            processDoubaoFallbackVideos(data, jsonStr);
                                        }
                                        if (data.event_data || data.patch_op) {
                                            parseStreamChunk(data);
                                        }
                                    }
                                } catch (e) { }
                            }
                        }

                        // 传递数据给原始响应
                        controller.enqueue(value);
                    }
                    controller.close();
                }
            });

            return new NativeResponse(stream, {
                headers: response.headers,
                status: response.status,
                statusText: response.statusText
            });
        }

        return originalFetch.apply(this, args);
    };
    function parseStreamChunk(data) {
        try {
            if (!data.event_data && !data.patch_op) {
                return;
            }

            let creations = [];
            let topic = currentTopicContext;

            if (data.patch_op) {

                for (const op of data.patch_op) {
                    if (
                        op.patch_value &&
                        Array.isArray(op.patch_value.content_block)
                    ) {
                        for (const block of op.patch_value.content_block) {
                            if (
                                block?.content?.creation_block &&
                                Array.isArray(block.content.creation_block.creations)
                            ) {
                                creations = block.content.creation_block.creations;
                                break;
                            }
                        }
                    }
                }

                if (creations.length === 0) {
                    const extPatch = data.patch_op.find(op =>
                        op.patch_value &&
                        typeof op.patch_value === 'object' &&
                        op.patch_value.ext?.creation_full_content
                    );

                    if (extPatch) {
                        try {
                            const creationFullContent = extPatch.patch_value.ext.creation_full_content;
                            const creationFullContent_obj = JSON.parse(creationFullContent);

                            for (const item of creationFullContent_obj) {
                                const content = item?.BlockInfo?.BlockContent?.content;
                                if (
                                    content &&
                                    typeof content === 'object' &&
                                    content.creation_block &&
                                    Array.isArray(content.creation_block.creations)
                                ) {
                                    creations = content.creation_block.creations;
                                    break;
                                }
                            }
                        } catch (e) { }
                    }
                }

            } else {
                let eventData;
                try {
                    eventData = JSON.parse(data.event_data);
                } catch (e) {
                    return;
                }

                if (!eventData.message?.content) {
                    return;
                }
                const detectedTopic = createTopicContext(eventData.message, chatImages.length + chatVideos.length);
                topic = detectedTopic.isFallback && currentTopicContext
                    ? { ...detectedTopic, title: currentTopicContext.title }
                    : detectedTopic;

                let messageContent;
                try {
                    messageContent = JSON.parse(eventData.message.content);
                } catch (e) {
                    return;
                }
                if (!messageContent.creations || !Array.isArray(messageContent.creations)) {
                    return;
                }

                creations = messageContent.creations;
            }



            for (const creation of creations) {
                const creationTopic = refineTopicFromCreation(creation, topic);
                if (creation?.video) {
                    handleDoubaoCreationVideo(creation, creationTopic);
                } else {
                    const imageInfo = getCreationImageInfo(creation);
                    if (imageInfo) addChatImage({ ...imageInfo, topic: creationTopic });
                }
            }
        } catch (e) { }
    }

    async function getDoubaoVideoInfo(vid) {
        if (!vid) {
            return null;
        }

        const params = {
            version_code: '20800',
            language: 'zh-CN',
            device_platform: 'web',
            aid: '497858',
            real_aid: '497858',
            pkg_type: 'release_version',
            device_id: '',
            pc_version: '2.51.7',
            region: '',
            sys_region: '',
            samantha_web: '1',
            'use-olympus-account': '1',
            web_tab_id: '',
        };

        const queryString = new URLSearchParams(params).toString();
        const apiUrl = `${getDoubaoOrigin()}/samantha/media/get_play_info?${queryString}`;

        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'origin': getDoubaoOrigin(),
                },
                body: JSON.stringify({ key: vid }),
            });

            const result = await response.json();

            if (!result || !result.data) {
                return null;
            }

            const originalMediaInfo = result.data.original_media_info || {};
            const meta = originalMediaInfo.meta || {};

            const videoInfo = {
                vid: vid,
                width: meta.width || 0,
                height: meta.height || 0,
                definition: meta.definition || '',
                duration: meta.duration || 0,
                codec_type: meta.codec_type || '',
                poster_url: result.data.poster_url || '',
                url: originalMediaInfo.main_url || '',
            };
            return videoInfo;
        } catch (e) {
            return null;
        }
    }

    function handleDoubaoCreationVideo(creation, topic = currentTopicContext) {
        processDoubaoFallbackVideos(
            creation,
            safeJsonStringify(creation),
            topic,
            getCreationVideoPoster(creation)
        );
    }

    function safeJsonStringify(value) {
        try {
            return JSON.stringify(value) || '';
        } catch {
            return '';
        }
    }

    function processDoubaoFallbackVideos(json, rawBody = '', topic = currentTopicContext, posterUrl = '') {
        const fallbackApis = findDoubaoFallbackApis(json, rawBody);
        if (!fallbackApis.length) return;
        detectedFallbackVideoCount += fallbackApis.length;
        removeLegacyDoubaoVideos();
        for (const fallbackApi of fallbackApis) {
            if (posterUrl) fallbackVideoPosterIndex.set(fallbackApi, posterUrl);
            if (processedFallbackApis.has(fallbackApi)) continue;
            processedFallbackApis.add(fallbackApi);

            const request = getDoubaoVideoInfoFromFallbackApi(fallbackApi)
                .then(info => {
                    if (info && !info.poster_url) {
                        info.poster_url = fallbackVideoPosterIndex.get(fallbackApi) || '';
                    }
                    fallbackVideoFailures.delete(fallbackApi);
                    addChatVideo(info, topic);
                })
                .catch(error => {
                    fallbackVideoFailures.set(fallbackApi, error);
                    processedFallbackApis.delete(fallbackApi);
                })
                .finally(() => pendingFallbackVideoRequests.delete(request));
            pendingFallbackVideoRequests.add(request);
        }
        mediaProgressReporter?.(`正在解析无水印视频（${pendingFallbackVideoRequests.size} 项）...`);
    }

    async function waitForFallbackVideos() {
        while (pendingFallbackVideoRequests.size) {
            await Promise.allSettled([...pendingFallbackVideoRequests]);
        }
    }

    async function getDoubaoVideoInfoFromFallbackApi(fallbackApi) {
        const apiUrl = replaceQueryParams(fallbackApi, {
            channel: 'no',
            codec_type: '8',
            logo_type: 'unwatermarked',
        });

        let payload;
        let lastError;
        for (let attempt = 0; attempt <= VIDEO_REQUEST_RETRY_COUNT; attempt++) {
            try {
                payload = await requestJson(apiUrl, VIDEO_REQUEST_TIMEOUT);
                break;
            } catch (error) {
                lastError = error;
                if (attempt >= VIDEO_REQUEST_RETRY_COUNT) throw error;
                mediaProgressReporter?.('视频解析超时，正在自动重试...');
                await new Promise(resolve => setTimeout(resolve, 450));
            }
        }
        if (!payload) throw lastError || new Error('视频信息为空');
        const data = getVideoData(payload);
        const picked = pickMainUrlEntry(data);
        if (!picked?.token) {
            throw new Error('未找到视频播放信息');
        }

        const videoUrl = await decodeMainUrl(picked.token, findKeySeedDeep(payload));
        if (!videoUrl) {
            throw new Error('视频地址解码失败');
        }

        const meta = picked.entry || {};
        return {
            vid: data.vid || data.video_id || meta.vid || meta.video_id || apiUrl,
            source: 'fallback_api',
            width: Number(meta.vwidth || meta.width || data.vwidth || data.width || 0),
            height: Number(meta.vheight || meta.height || data.vheight || data.height || 0),
            definition: meta.definition || data.definition || '',
            duration: Number(meta.duration || data.duration || 0),
            codec_type: meta.codec_type || data.codec_type || '',
            poster_url: data.poster_url || data.poster || '',
            url: videoUrl,
        };
    }

    function removeLegacyDoubaoVideos() {
        const nextVideos = chatVideos.filter(video => video?.source === 'fallback_api');
        if (nextVideos.length === chatVideos.length) return;

        chatVideos = nextVideos;
    }

    function requestJson(url, timeout = VIDEO_REQUEST_TIMEOUT) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    headers: {
                        accept: 'application/json,text/plain,*/*',
                    },
                    timeout,
                    onload: (response) => {
                        if (response.status < 200 || response.status >= 300) {
                            reject(new Error(`请求失败: ${response.status}`));
                            return;
                        }
                        try {
                            const body = response.responseText || response.response;
                            resolve(typeof body === 'string' ? JSON.parse(body) : body);
                        } catch (error) {
                            reject(error);
                        }
                    },
                    onerror: () => reject(new Error('请求失败')),
                    ontimeout: () => reject(new Error('视频接口请求超时')),
                });
                return;
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);
            originalFetch.call(pageWindow, url, {
                method: 'GET',
                credentials: 'omit',
                signal: controller.signal,
                headers: {
                    accept: 'application/json,text/plain,*/*',
                },
            })
                .then(response => {
                    if (!response.ok) throw new Error(`视频接口请求失败: ${response.status}`);
                    return response.json();
                })
                .then(resolve)
                .catch(error => reject(error?.name === 'AbortError' ? new Error('视频接口请求超时') : error))
                .finally(() => clearTimeout(timeoutId));
        });
    }

    function findDoubaoFallbackApis(json, rawBody = '') {
        const apis = new Set();

        for (const value of findValuesByKey(json, 'fallback_api')) {
            addFallbackApi(apis, value);
        }

        const body = typeof rawBody === 'string' ? rawBody : '';
        const patterns = [
            /fallback_api\\":\\"(.*?)\\"/g,
            /"fallback_api"\s*:\s*"([^"]+)"/g,
        ];

        for (const pattern of patterns) {
            let match = pattern.exec(body);
            while (match) {
                addFallbackApi(apis, decodeJsonEscapedFragment(match[1]));
                match = pattern.exec(body);
            }
        }

        return Array.from(apis);
    }

    function addFallbackApi(apis, value) {
        if (typeof value !== 'string' || !value) return;

        const url = decodeJsonEscapedFragment(value);
        if (isHttpUrl(url)) {
            apis.add(url);
        }
    }

    function decodeJsonEscapedFragment(value) {
        let text = value;
        for (let index = 0; index < 3; index++) {
            try {
                const decoded = JSON.parse(`"${text.replace(/"/g, '\\"')}"`);
                if (decoded === text) break;
                text = decoded;
            } catch {
                break;
            }
        }
        return text.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    }

    function replaceQueryParams(url, params) {
        const parsedUrl = new URL(url);
        for (const [key, value] of Object.entries(params)) {
            parsedUrl.searchParams.set(key, value);
        }
        return parsedUrl.toString();
    }

    function getVideoData(payload) {
        const videoInfo = payload?.video_info || payload?.data?.video_info || payload;
        const data = videoInfo?.data || videoInfo;
        return data && typeof data === 'object' ? data : {};
    }

    function pickMainUrlEntry(data) {
        const videoList = data?.video_list;
        const entries = videoList && typeof videoList === 'object' && Object.keys(videoList).length
            ? Object.values(videoList)
            : [data];
        let best = null;

        for (const entry of entries) {
            if (!entry || typeof entry !== 'object') continue;
            const token = entry.main_url || entry.play_url || '';
            if (typeof token !== 'string' || !token.trim()) continue;
            const score = Number(entry.bitrate || entry.real_bitrate || 0)
                + Number(entry.vwidth || entry.width || 0) * Number(entry.vheight || entry.height || 0);
            if (!best || score > best.score) {
                best = { token: token.trim(), score, entry };
            }
        }

        return best;
    }

    function findKeySeedDeep(value, depth = 0) {
        if (depth > 10 || value == null) return '';

        if (typeof value === 'string') {
            let match = value.match(/(?:^|[?&])key_seed=([^&"'<>\\\s]+)/i);
            if (match) return decodeURIComponent(match[1]);
            match = value.match(/["']key_seed["']\s*:\s*["']([^"']+)/i);
            return match ? decodeURIComponent(match[1]) : '';
        }

        if (typeof value !== 'object') return '';

        if (typeof value.key_seed === 'string' && value.key_seed.trim()) {
            return value.key_seed.trim();
        }

        for (const item of Object.values(value)) {
            const hit = findKeySeedDeep(item, depth + 1);
            if (hit) return hit;
        }

        return '';
    }

    async function decodeMainUrl(token, keySeed = '') {
        if (isHttpUrl(token)) return token;

        const plainUrl = tryDecodeBase64Url(token);
        if (plainUrl) return plainUrl;

        if (token.startsWith('qAAB') && keySeed) {
            return await decodeQaabToken(token, keySeed);
        }

        return '';
    }

    function tryDecodeBase64Url(token) {
        const bytes = base64DecodeLoose(token);
        if (!bytes) return '';
        const text = asciiUrlFromBytes(bytes);
        return isHttpUrl(text) ? text : '';
    }

    function base64DecodeLoose(text) {
        const input = String(text || '').trim();
        const variants = [
            input,
            input.replace(/[$@#]/g, char => ({ '$': '_', '@': '/', '#': '.' }[char])),
            input.replace(/[$@#]/g, char => ({ '$': '+', '@': '/', '#': '=' }[char])),
        ];
        const seen = new Set();

        for (const candidate of variants) {
            if (!candidate || seen.has(candidate)) continue;
            seen.add(candidate);
            try {
                const normalized = padBase64(candidate).replace(/-/g, '+').replace(/_/g, '/');
                const binary = atob(normalized);
                const bytes = new Uint8Array(binary.length);
                for (let index = 0; index < binary.length; index++) {
                    bytes[index] = binary.charCodeAt(index);
                }
                return bytes;
            } catch {
                // Try the next variant.
            }
        }

        return null;
    }

    function padBase64(text) {
        const pad = (4 - (text.length % 4)) % 4;
        return text + '='.repeat(pad);
    }

    function asciiUrlFromBytes(bytes) {
        if (!bytes || !bytes.length) return '';
        for (const byte of bytes) {
            if (byte !== 9 && byte !== 10 && byte !== 13 && (byte < 32 || byte > 126)) {
                return '';
            }
        }
        return new TextDecoder().decode(bytes);
    }

    async function decodeQaabToken(token, keySeed) {
        const data = base64DecodeLoose(token);
        const seed = base64DecodeLoose(keySeed);
        if (!data || !seed) return '';

        const digest1 = await crypto.subtle.digest('SHA-512', seed.slice(0, 32));
        const salt = hexToBytes(QAAB_SALT_HEX);
        const digest2Input = concatBytes(new Uint8Array(digest1), salt);
        const digest2 = new Uint8Array(await crypto.subtle.digest('SHA-512', digest2Input));
        const key = digest2.slice(0, 16);
        const iv = digest2.slice(16, 32);
        const attempts = [];

        if (data.length >= 4 && data[0] === 0xa8 && data[1] === 0x00 && data[2] === 0x01 && data[3] === 0x00) {
            attempts.push({ payload: data.slice(4), key, iv });
            attempts.push({ payload: data.slice(4), key: iv, iv: key });
            if (data.length > 36) {
                attempts.push({ payload: data.slice(36), key, iv: data.slice(20, 36) });
                attempts.push({ payload: data.slice(36), key, iv });
            }
        } else {
            attempts.push({ payload: data, key, iv });
        }

        for (const attempt of attempts) {
            const url = await decryptAesCbcUrl(attempt.payload, attempt.key, attempt.iv);
            if (url) return url;
        }

        return '';
    }

    async function decryptAesCbcUrl(payload, keyBytes, ivBytes) {
        if (!payload.length || payload.length % 16 !== 0) return '';

        try {
            const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['decrypt']);
            const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, key, payload));
            const direct = asciiUrlFromBytes(plain);
            if (isHttpUrl(direct)) return direct;
            const stripped = stripPkcs7(plain);
            const url = asciiUrlFromBytes(stripped);
            return isHttpUrl(url) ? url : '';
        } catch {
            return '';
        }
    }

    function stripPkcs7(bytes) {
        if (!bytes || !bytes.length) return new Uint8Array();
        const pad = bytes[bytes.length - 1];
        if (pad < 1 || pad > 16 || pad > bytes.length) return bytes;
        for (let index = bytes.length - pad; index < bytes.length; index++) {
            if (bytes[index] !== pad) return bytes;
        }
        return bytes.slice(0, bytes.length - pad);
    }

    function hexToBytes(hex) {
        const bytes = new Uint8Array(hex.length / 2);
        for (let index = 0; index < bytes.length; index++) {
            bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
        }
        return bytes;
    }

    function concatBytes(first, second) {
        const bytes = new Uint8Array(first.length + second.length);
        bytes.set(first, 0);
        bytes.set(second, first.length);
        return bytes;
    }

    function findValuesByKey(value, targetKey) {
        const values = [];
        walkJsonAndStrings(value, (node) => {
            if (!node || typeof node !== 'object' || Array.isArray(node)) return;
            if (Object.prototype.hasOwnProperty.call(node, targetKey)) {
                values.push(node[targetKey]);
            }
        });
        return values;
    }

    function walkJsonAndStrings(value, visitor, seen = new Set()) {
        if (value == null) return;

        if (typeof value === 'string') {
            const parsed = parseJsonString(value);
            if (parsed !== null) {
                walkJsonAndStrings(parsed, visitor, seen);
            }
            return;
        }

        if (typeof value !== 'object' || seen.has(value)) return;

        seen.add(value);
        visitor(value);

        if (Array.isArray(value)) {
            for (const item of value) {
                walkJsonAndStrings(item, visitor, seen);
            }
            return;
        }

        for (const key of Object.keys(value)) {
            walkJsonAndStrings(value[key], visitor, seen);
        }
    }

    function parseJsonString(text) {
        const trimmed = text.trim();
        if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
            return null;
        }

        try {
            return JSON.parse(trimmed);
        } catch {
            return null;
        }
    }

    function isHttpUrl(url) {
        return typeof url === 'string' && /^https?:\/\//i.test(url);
    }

    function parseChatHistoryImages(messages) {
        if (!Array.isArray(messages)) return;

        try {
            let lastNamedTopic = null;
            for (const [messageIndex, item] of messages.entries()) {
                try {
                    const detectedTopic = createTopicContext(item, messageIndex);
                    if (!detectedTopic.isFallback) lastNamedTopic = detectedTopic;
                    const topic = detectedTopic.isFallback && lastNamedTopic
                        ? { ...detectedTopic, title: lastNamedTopic.title }
                        : detectedTopic;
                    for (const content of item.content_block) {
                        const creationBlock = content.content?.creation_block;
                        if (!creationBlock || !Array.isArray(creationBlock.creations)) continue;
                        for (const creation of creationBlock.creations) {
                            const creationTopic = refineTopicFromCreation(creation, topic);
                            if (creation?.video) {
                                handleDoubaoCreationVideo(creation, creationTopic);
                            } else {
                                const imageInfo = getCreationImageInfo(creation);
                                if (imageInfo) addChatImage({ ...imageInfo, topic: creationTopic });
                            }
                        }
                    }

                } catch (e) {
                    continue;
                }
            }
        } catch (e) { }
    }

    function extractSharePageImages(routerDataOverride = null) {
        try {
            const imageList = [];
            const imageUrlIndex = new Set();

            const addCreationMedia = (creation, topic) => {
                const creationTopic = refineTopicFromCreation(creation, topic);
                if (creation?.video) {
                    handleDoubaoCreationVideo(creation, creationTopic);
                    return;
                }

                const imageInfo = getCreationImageInfo(creation);
                if (!imageInfo) return;
                const imageUrl = normalizeImageUrl(imageInfo.url);

                if (imageUrl && !imageUrlIndex.has(imageUrl)) {
                    imageUrlIndex.add(imageUrl);
                    imageList.push({
                        url: imageUrl,
                        previewUrl: imageInfo.previewUrl || '',
                        width: imageInfo.width,
                        height: imageInfo.height,
                        topicId: creationTopic.id,
                        topicTitle: creationTopic.title
                    });
                }
            };

            const parseContentBlock = (block) => {
                const contentData = block.content_v2 || block.content;
                if (!contentData) return null;
                return typeof contentData === 'string' ? JSON.parse(contentData) : contentData;
            };

            const parseMessageSnapshot = (messageSnapshot) => {
                if (!Array.isArray(messageSnapshot)) return;

                let lastNamedTopic = null;
                for (const [messageIndex, message] of messageSnapshot.entries()) {
                    const detectedTopic = createTopicContext(message, messageIndex);
                    if (!detectedTopic.isFallback) lastNamedTopic = detectedTopic;
                    const topic = detectedTopic.isFallback && lastNamedTopic
                        ? { ...detectedTopic, title: lastNamedTopic.title }
                        : detectedTopic;
                    for (const block of message.content_block || []) {
                        try {
                            const contentData = parseContentBlock(block);
                            const creations = contentData?.creation_block?.creations;
                            if (!Array.isArray(creations)) continue;

                            for (const creation of creations) {
                                addCreationMedia(creation, topic);
                            }
                        } catch (e) {
                            continue;
                        }
                    }
                }
            };

            const parseSharePayload = (payload) => {
                if (!payload || typeof payload !== 'object') return;
                const shareInfo = payload?.data?.share_info || payload?.share_info;
                const messageSnapshot = payload?.data?.message_snapshot?.message_list;
                if (!shareInfo && !Array.isArray(messageSnapshot)) return;
                currentSharePagePayload = payload;
                const shareId = shareInfo?.share_id || getConversationRouteId();
                const shareTitle = String(shareInfo?.share_name || getPageConversationTitle() || '').trim();
                const shareTopic = {
                    id: `conversation-${shareId}`,
                    title: shareTitle || `对话 ${String(shareId).slice(-8)}`,
                    isFallback: !shareTitle
                };
                currentTopicContext = shareTopic;
                currentSharePageInfo = shareInfo ? {
                    id: shareId,
                    title: shareTitle || shareTopic.title,
                    author: String(shareInfo?.user?.nick_name || '').trim(),
                    avatar: normalizeImageUrl(shareInfo?.user?.image?.tiny_url || shareInfo?.user?.image?.origin_url || ''),
                    sharedAt: Number(shareInfo?.share_time || 0),
                    status: shareInfo?.share_status,
                    messageCount: messageSnapshot?.length || 0
                } : null;
                const rawPayload = safeJsonStringify(payload);
                processDoubaoFallbackVideos(payload, rawPayload, shareTopic);
                parseMessageSnapshot(messageSnapshot);
            };

            const parseRouterDataItem = (data) => {
                if (typeof data === 'object' && data?.data?.message_snapshot?.message_list) {
                    parseSharePayload(data);
                    return;
                }

                if (Array.isArray(data) && data.length) {
                    const routerDataFnArg = data[0]?.routerDataFnArgs?.[0];
                    if (!routerDataFnArg) return;

                    const routerData = typeof routerDataFnArg === 'string'
                        ? JSON.parse(routerDataFnArg)
                        : routerDataFnArg;
                    parseSharePayload(routerData);
                }
            };

            if (routerDataOverride) {
                parseRouterDataItem(routerDataOverride);
                return imageList;
            }

            const scriptElement = document.querySelector(
                'script[data-script-src="modern-run-router-data-fn"], script[data-script-src="modern-run-window-fn"][data-fn-name="mergeLoaderData"]'
            );
            if (scriptElement) {
                const dataFnArgs = scriptElement.getAttribute('data-fn-args');
                if (dataFnArgs) {
                    const jsonStr = dataFnArgs.replace(/&quot;/g, '"');
                    const jsonData = JSON.parse(jsonStr);

                    for (const data of jsonData) {
                        parseRouterDataItem(data);
                    }
                    return imageList;
                }
            }

            return [];
        } catch (error) {
            return [];
        }
    }

    function extractImages() {

        if (isDoubaoPage() && pageWindow.location.pathname.includes('/chat/')) {
            return chatImages;
        } else {
            const images = extractSharePageImages();
            replaceChatImages(images);
            return images;
        }
    }

    function extractVideos() {
        return chatVideos;
    }

    function promiseWithTimeout(promise, timeout, message) {
        let timeoutId;
        return Promise.race([
            Promise.resolve(promise),
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(message)), timeout);
            })
        ]).finally(() => clearTimeout(timeoutId));
    }

    async function extractSharePageMedia(onProgress = null) {
        mediaProgressReporter = onProgress;
        detectedFallbackVideoCount = 0;
        fallbackVideoFailures.clear();
        processedFallbackApis.clear();
        chatVideos = [];
        chatVideoUrlIndex.clear();
        chatVideoVidIndex.clear();
        currentSharePageInfo = null;
        onProgress?.('正在读取分享内容...');
        const loaderData = pageWindow._ROUTER_DATA?.loaderData || {};
        let shareInfo = Object.values(loaderData)
            .map(routeData => routeData?.shareInfo)
            .find(value => value && (typeof value.then === 'function' || typeof value === 'object'));
        if (shareInfo && typeof shareInfo.then === 'function') {
            shareInfo = await promiseWithTimeout(shareInfo, 15000, '读取分享内容超时');
        }
        if (!shareInfo || (!shareInfo?.data?.message_snapshot && !shareInfo?.message_snapshot)) {
            shareInfo = currentSharePagePayload;
        }

        onProgress?.('正在解析分享媒体...');
        const images = shareInfo ? extractSharePageImages(shareInfo) : extractSharePageImages();
        if (!currentSharePageInfo) {
            mediaProgressReporter = null;
            throw new Error('分享内容不可用，可能已失效或被取消');
        }
        replaceChatImages(images);
        await waitForFallbackVideos();
        mediaProgressReporter = null;
        return {
            images,
            shareInfo: currentSharePageInfo,
            detectedVideoCount: detectedFallbackVideoCount,
            failedVideoCount: fallbackVideoFailures.size
        };
    }

    function createDownloadTask(url, filename) {
        const downloadUrl = normalizeImageUrl(url);
        let settled = false;
        let rejectDownload = null;
        let abortDownload = null;

        const promise = new Promise((resolve, reject) => {
            rejectDownload = reject;

            const finish = () => {
                if (settled) return;
                settled = true;
                resolve();
            };

            const fail = (error) => {
                if (settled) return;
                settled = true;
                reject(error);
            };

            if (typeof GM_download === 'function') {
                try {
                    const download = GM_download({
                        url: downloadUrl,
                        name: filename,
                        saveAs: false,
                        onload: finish,
                        onerror: fail,
                        ontimeout: () => fail(new Error('下载超时')),
                    });

                    if (download && typeof download.abort === 'function') {
                        abortDownload = () => download.abort();
                    }
                } catch (error) {
                    fail(error);
                }
                return;
            }

            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            abortDownload = () => controller?.abort();

            fetch(downloadUrl, { signal: controller?.signal })
                .then(response => response.blob())
                .then(blob => {
                    const blobUrl = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = blobUrl;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    setTimeout(() => URL.revokeObjectURL(blobUrl), 100);
                    finish();
                })
                .catch(fail);
        });

        return {
            promise,
            abort() {
                if (settled) return;
                settled = true;
                try {
                    if (abortDownload) abortDownload();
                } catch (error) { }
                rejectDownload(new Error('下载已取消'));
            },
        };
    }

    async function downloadImage(url, filename) {
        try {
            await createDownloadTask(url, filename).promise;
            return true;
        } catch (error) {
            if (error?.message === '下载已取消') return false;
            alert('下载失败，请重试');
            return false;
        }
    }

    function getMediaExtension(url, type) {
        try {
            const pathname = new URL(url, pageWindow.location.href).pathname;
            const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
            if (match) return `.${match[1].toLowerCase()}`;
        } catch (e) {
            // Ignore malformed URLs and fall back to a safe default extension.
        }
        return type === 'video' ? '.mp4' : '.png';
    }

    function getDownloadFilename(type, index, url, topicNumber = 1, topicItemNumber = index + 1) {
        const mediaType = type === 'video' ? 'video' : 'image';
        return `doubao_topic_${topicNumber}_${mediaType}_${topicItemNumber}${getMediaExtension(url, type)}`;
    }

    function fetchMediaBlob(url, signal) {
        const mediaUrl = normalizeImageUrl(url);
        if (typeof GM_xmlhttpRequest === 'function') {
            return new Promise((resolve, reject) => {
                const request = GM_xmlhttpRequest({
                    method: 'GET',
                    url: mediaUrl,
                    responseType: 'blob',
                    onload: response => {
                        if (response.status >= 200 && response.status < 300 && response.response) {
                            resolve(response.response);
                        } else {
                            reject(new Error(`素材请求失败: ${response.status}`));
                        }
                    },
                    onerror: () => reject(new Error('素材请求失败')),
                    ontimeout: () => reject(new Error('素材请求超时'))
                });
                signal?.addEventListener('abort', () => {
                    request?.abort?.();
                    reject(new DOMException('下载已取消', 'AbortError'));
                }, { once: true });
            });
        }

        return fetch(mediaUrl, { signal }).then(response => {
            if (!response.ok) throw new Error(`素材请求失败: ${response.status}`);
            return response.blob();
        });
    }

    function calculateCrc32(bytes) {
        let crc = 0xffffffff;
        for (const byte of bytes) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) {
                crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
            }
        }
        return (crc ^ 0xffffffff) >>> 0;
    }

    function getZipDosTime(date = new Date()) {
        const year = Math.max(1980, date.getFullYear());
        return {
            time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
            date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
        };
    }

    function createZipArchive(entries) {
        const encoder = new TextEncoder();
        const localParts = [];
        const centralParts = [];
        const stamp = getZipDosTime();
        let localOffset = 0;

        for (const entry of entries) {
            const nameBytes = encoder.encode(entry.name);
            const data = entry.data;
            const crc = calculateCrc32(data);
            const localHeader = new Uint8Array(30 + nameBytes.length);
            const localView = new DataView(localHeader.buffer);
            localView.setUint32(0, 0x04034b50, true);
            localView.setUint16(4, 20, true);
            localView.setUint16(6, 0x0800, true);
            localView.setUint16(8, 0, true);
            localView.setUint16(10, stamp.time, true);
            localView.setUint16(12, stamp.date, true);
            localView.setUint32(14, crc, true);
            localView.setUint32(18, data.length, true);
            localView.setUint32(22, data.length, true);
            localView.setUint16(26, nameBytes.length, true);
            localHeader.set(nameBytes, 30);
            localParts.push(localHeader, data);

            const centralHeader = new Uint8Array(46 + nameBytes.length);
            const centralView = new DataView(centralHeader.buffer);
            centralView.setUint32(0, 0x02014b50, true);
            centralView.setUint16(4, 20, true);
            centralView.setUint16(6, 20, true);
            centralView.setUint16(8, 0x0800, true);
            centralView.setUint16(10, 0, true);
            centralView.setUint16(12, stamp.time, true);
            centralView.setUint16(14, stamp.date, true);
            centralView.setUint32(16, crc, true);
            centralView.setUint32(20, data.length, true);
            centralView.setUint32(24, data.length, true);
            centralView.setUint16(28, nameBytes.length, true);
            centralView.setUint32(42, localOffset, true);
            centralHeader.set(nameBytes, 46);
            centralParts.push(centralHeader);
            localOffset += localHeader.length + data.length;
        }

        const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
        const end = new Uint8Array(22);
        const endView = new DataView(end.buffer);
        endView.setUint32(0, 0x06054b50, true);
        endView.setUint16(8, entries.length, true);
        endView.setUint16(10, entries.length, true);
        endView.setUint32(12, centralSize, true);
        endView.setUint32(16, localOffset, true);
        return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
    }

    function downloadBlob(blob, filename) {
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    }

    async function copyTextToClipboard(text) {
        const value = String(text || '').trim();
        if (!value) throw new Error('没有可复制的内容');

        if (navigator.clipboard?.writeText && pageWindow.isSecureContext) {
            try {
                await navigator.clipboard.writeText(value);
                return;
            } catch (error) {
                // Fall through to execCommand for userscript/browser permission edge cases.
            }
        }

        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', '');
        textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none';
        document.body.appendChild(textarea);
        textarea.select();
        textarea.setSelectionRange(0, value.length);
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('浏览器拒绝了剪贴板写入');
    }

    let initRetryCount = 0;
    const MAX_RETRY = 10;
    const LAUNCHER_ICON_DATA_URL = 'data:image/png;base64,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';

    function createAssistantWorkspace() {
        if (document.getElementById('dba-workspace')) {
            return;
        }
        const isThreadPage = pageWindow.location.pathname.includes('/thread/');

        const icon = (name) => {
            const paths = {
                library: '<path d="m16 6 4 14H4L8 6"/><path d="M8 6h8"/><path d="M9 2h6l1 4H8l1-4Z"/><path d="m10 11 2 2 2-2"/>',
                close: '<path d="m18 6-12 12"/><path d="m6 6 12 12"/>',
                image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
                video: '<path d="m16 13 5 3V8l-5 3"/><rect width="13" height="14" x="3" y="5" rx="2"/>',
                download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
                archive: '<rect width="18" height="5" x="3" y="3" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
                copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
                check: '<path d="m20 6-11 11-5-5"/>',
                refresh: '<path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/>',
                external: '<path d="M15 3h6v6"/><path d="m10 14 11-11"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'
            };
            return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ''}</svg>`;
        };

        const root = document.createElement('div');
        root.id = 'dba-workspace';
        root.innerHTML = `
            <style>
                #dba-workspace, #dba-workspace * { box-sizing: border-box; letter-spacing: 0; }
                #dba-launcher-host { position: fixed; right: 18px; bottom: 22px; z-index: 2147483645; }
                #doubao-assistant-btn { position: relative; min-width: 142px; height: 52px; display: flex; align-items: center; gap: 10px; padding: 0 14px 0 8px; border: 1px solid #9bdc63; border-radius: 14px; color: #20261d; background: rgba(255, 253, 247, .96); box-shadow: 0 10px 30px rgba(91, 145, 55, .2); backdrop-filter: blur(10px); cursor: pointer; font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; transition: transform .22s cubic-bezier(.2, .8, .2, 1), box-shadow .22s ease, border-color .18s ease, background-color .18s ease; }
                #doubao-assistant-btn[hidden] { display: none !important; }
                #doubao-assistant-btn:hover { border-color: #7fc746; background: #fffef9; box-shadow: 0 13px 34px rgba(91, 145, 55, .28); transform: translateY(-2px); }
                #doubao-assistant-btn:active { box-shadow: 0 7px 20px rgba(91, 145, 55, .2); transform: translateY(0) scale(.985); transition-duration: .1s; }
                #doubao-assistant-btn svg { width: 21px; height: 21px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
                .dba-launcher-icon { width: 36px; height: 36px; flex: none; display: grid; place-items: center; border-radius: 50%; background: #edf8e4; transition: transform .22s cubic-bezier(.2, .8, .2, 1), background-color .18s ease; }
                #doubao-assistant-btn:hover .dba-launcher-icon { background: #e3f5d4; transform: scale(1.05); }
                .dba-launcher-icon img { width: 25px; height: 25px; display: block; object-fit: contain; }
                .dba-launcher-copy { display: grid; gap: 3px; text-align: left; }
                .dba-launcher-name { white-space: nowrap; }
                .dba-launcher-kind { color: #718268; font-size: 9px; font-weight: 500; white-space: nowrap; }
                #dba-panel { position: fixed; z-index: 2147483644; top: 12px; right: 12px; bottom: 12px; width: min(404px, calc(100vw - 24px)); display: grid; grid-template-rows: ${isThreadPage ? 'auto auto auto minmax(0, 1fr) auto' : 'auto auto minmax(0, 1fr) auto'}; overflow: hidden; border: 1px solid #d9dce2; border-radius: 8px; color: #202124; background: #fff; box-shadow: 0 18px 56px rgba(20, 24, 31, .22); font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; transform: translateX(calc(100% + 28px)); visibility: hidden; transition: transform .2s ease, visibility .2s; }
                #dba-panel[data-open="true"] { transform: translateX(0); visibility: visible; }
                .dba-head { min-height: 58px; display: flex; align-items: center; gap: 12px; padding: 0 14px 0 16px; border-bottom: 1px solid #e6e8ec; }
                .dba-brand { min-width: 0; flex: 1; }
                .dba-title { font-size: 15px; font-weight: 650; color: #17191c; }
                .dba-summary { margin-top: 2px; color: #747982; font-size: 11px; }
                .dba-icon-btn { width: 32px; height: 32px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 6px; color: #646a73; background: transparent; cursor: pointer; }
                .dba-icon-btn:hover { color: #17191c; background: #f0f1f3; }
                .dba-icon-btn.loading svg { animation: dba-spin .7s linear infinite; }
                @keyframes dba-spin { to { transform: rotate(360deg); } }
                .dba-icon-btn svg, .dba-button svg, .dba-tab svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
                .dba-share-info { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 10px; align-items: center; min-height: 64px; padding: 10px 14px; border-bottom: 1px solid #e6e8ec; background: linear-gradient(135deg, #f7faf4, #fbfcfd); }
                .dba-share-info[hidden] { display: none; }
                .dba-share-avatar { width: 36px; height: 36px; display: grid; place-items: center; overflow: hidden; border: 1px solid #dfe5dc; border-radius: 50%; color: #66805b; background: #eaf3e5; font-size: 15px; font-weight: 700; }
                .dba-share-avatar img { width: 100%; height: 100%; object-fit: cover; }
                .dba-share-title { overflow: hidden; color: #252a24; font-size: 13px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
                .dba-share-meta { margin-top: 3px; overflow: hidden; color: #7a8178; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
                .dba-tabs { display: grid; grid-template-columns: 1fr 1fr; padding: 0 14px; border-bottom: 1px solid #e6e8ec; }
                .dba-tab { position: relative; height: 44px; display: flex; align-items: center; justify-content: center; gap: 7px; border: 0; color: #717680; background: transparent; font: 600 13px/1 inherit; cursor: pointer; }
                .dba-tab.active { color: #2459c4; }
                .dba-tab.active::after { content: ""; position: absolute; left: 20%; right: 20%; bottom: -1px; height: 2px; background: #3266d5; }
                .dba-tab-count { min-width: 20px; padding: 1px 6px; border-radius: 9px; color: inherit; background: #eef0f3; font-size: 10px; }
                .dba-list { overflow: auto; padding: 10px 12px 18px; background: #f7f8fa; transition: opacity .16s ease; }
                .dba-list.loading { opacity: .5; cursor: progress; pointer-events: none; }
                .dba-list::-webkit-scrollbar { width: 6px; }
                .dba-list::-webkit-scrollbar-thumb { border-radius: 3px; background: #c9cdd3; }
                .dba-topic-divider { display: flex; align-items: center; gap: 8px; min-height: 34px; margin: 8px 0 7px; padding: 0 4px; color: #353941; }
                .dba-topic-divider:first-child { margin-top: 0; }
                .dba-topic-divider::after { content: ""; height: 1px; flex: 1; background: #dfe2e7; }
                .dba-topic-title { max-width: 260px; overflow: hidden; font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
                .dba-topic-count { flex: none; color: #858a93; font-size: 10px; }
                .dba-topic-select { width: 18px; height: 18px; flex: none; accent-color: #3266d5; cursor: pointer; }
                .dba-item { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 12px; min-height: 102px; margin-bottom: 8px; padding: 9px; border: 1px solid #e0e3e8; border-radius: 7px; background: #fff; }
                .dba-item.selected { border-color: #9cb7ee; background: #f7faff; }
                .dba-preview { position: relative; width: 112px; height: 84px; overflow: hidden; border-radius: 5px; background: #e9ebef; cursor: pointer; }
                .dba-preview img { width: 100%; height: 100%; display: block; object-fit: cover; }
                .dba-preview-placeholder { width: 100%; height: 100%; display: grid; place-items: center; color: #8e949d; }
                .dba-preview-placeholder svg { width: 25px; height: 25px; fill: none; stroke: currentColor; stroke-width: 1.5; }
                .dba-type { position: absolute; left: 5px; bottom: 5px; padding: 2px 5px; border-radius: 3px; color: #fff; background: rgba(18, 20, 24, .72); font-size: 9px; }
                .dba-item-body { min-width: 0; display: flex; flex-direction: column; }
                .dba-item-title { overflow: hidden; color: #292c31; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
                .dba-meta { min-height: 18px; margin-top: 3px; color: #858a93; font-size: 11px; }
                .dba-actions { display: flex; align-items: center; gap: 5px; margin-top: auto; }
                .dba-button { height: 30px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 0 9px; border: 1px solid #d8dbe1; border-radius: 5px; color: #4f555e; background: #fff; font: 500 11px/1 inherit; cursor: pointer; }
                .dba-button:hover { color: #2459c4; border-color: #aabce1; background: #f5f8ff; }
                .dba-button:disabled { opacity: .48; cursor: not-allowed; pointer-events: none; }
                .dba-button.icon-only { width: 30px; padding: 0; }
                .dba-select { width: 18px; height: 18px; margin-left: auto; accent-color: #3266d5; cursor: pointer; }
                .dba-empty { height: 100%; min-height: 260px; display: grid; place-content: center; justify-items: center; color: #858a93; text-align: center; }
                .dba-empty svg { width: 34px; height: 34px; margin-bottom: 10px; fill: none; stroke: #a6abb3; stroke-width: 1.4; }
                .dba-empty strong { color: #555b64; font-size: 13px; }
                .dba-empty span { margin-top: 4px; font-size: 11px; }
                .dba-empty-loading svg { animation: dba-spin .7s linear infinite; }
                .dba-foot { min-height: 54px; display: flex; align-items: center; gap: 7px; padding: 10px 12px; border-top: 1px solid #e3e5e9; background: #fff; }
                .dba-foot-status { min-width: 0; flex: 1; color: #797e87; font-size: 11px; }
                .dba-primary { color: #fff; border-color: #3266d5; background: #3266d5; }
                .dba-primary:hover { color: #fff; border-color: #2858b9; background: #2858b9; }
                .dba-operation-loading { position: absolute; z-index: 20; inset: 0; display: grid; place-content: center; justify-items: center; gap: 12px; color: #2857b8; background: rgba(255, 255, 255, .86); backdrop-filter: blur(3px); cursor: progress; }
                .dba-operation-loading[hidden] { display: none; }
                .dba-operation-loading svg { width: 30px; height: 30px; fill: none; stroke: currentColor; stroke-width: 1.8; animation: dba-spin .7s linear infinite; }
                .dba-operation-loading span { font-size: 13px; font-weight: 650; }
                .dba-toast { position: absolute; z-index: 30; top: 70px; left: 50%; max-width: calc(100% - 32px); padding: 9px 14px; border: 1px solid #b9dfa0; border-radius: 8px; color: #33452b; background: rgba(248, 253, 244, .98); box-shadow: 0 8px 24px rgba(51, 69, 43, .16); font-size: 12px; font-weight: 600; white-space: nowrap; opacity: 0; pointer-events: none; transform: translate(-50%, -8px); transition: opacity .18s ease, transform .2s cubic-bezier(.2, .8, .2, 1); }
                .dba-toast.show { opacity: 1; transform: translate(-50%, 0); }
                #dba-preview { position: fixed; z-index: 2147483647; inset: 0; display: none; place-items: center; padding: 24px; background: rgba(10, 12, 16, .88); cursor: zoom-out; }
                #dba-preview.show { display: grid; }
                #dba-preview img { max-width: 100%; max-height: 100%; object-fit: contain; }
                @media (max-width: 520px) { #dba-panel { inset: 0; width: 100%; border: 0; border-radius: 0; } }
            </style>
            <div id="dba-launcher-host">
                <button id="doubao-assistant-btn" type="button" aria-label="打开豆包助手" title="打开豆包助手插件">
                    <span class="dba-launcher-icon"><img src="${LAUNCHER_ICON_DATA_URL}" alt=""></span>
                    <span class="dba-launcher-copy"><span class="dba-launcher-name">豆包助手</span></span>
                </button>
            </div>
            <aside id="dba-panel" data-open="false" aria-label="豆包助手工作台">
                <header class="dba-head">
                    <div class="dba-brand"><div class="dba-title">豆包助手</div><div class="dba-summary">${isThreadPage ? '分享素材工作台' : '对话素材工作台'}</div></div>
                    <button class="dba-icon-btn" data-action="refresh" title="重新获取素材" aria-label="重新获取素材">${icon('refresh')}</button>
                    <button class="dba-icon-btn" data-action="close" title="关闭" aria-label="关闭">${icon('close')}</button>
                </header>
                <section class="dba-share-info" ${isThreadPage ? '' : 'hidden'} aria-label="分享信息">
                    <div class="dba-share-avatar">享</div>
                    <div><div class="dba-share-title">正在读取分享信息...</div><div class="dba-share-meta">请稍候</div></div>
                </section>
                <nav class="dba-tabs" aria-label="素材类型">
                    <button class="dba-tab active" data-tab="image">${icon('image')} 图片 <span class="dba-tab-count" data-count="image">0</span></button>
                    <button class="dba-tab" data-tab="video">${icon('video')} 视频 <span class="dba-tab-count" data-count="video">0</span></button>
                </nav>
                <main class="dba-list"></main>
                <footer class="dba-foot">
                    <div class="dba-foot-status">未选择素材</div>
                    <button class="dba-button" data-action="select-all">全选</button>
                    <button class="dba-button" data-action="multi-download" disabled>${icon('download')} 批量下载</button>
                    <button class="dba-button dba-primary" data-action="batch" disabled>${icon('archive')} 打包下载</button>
                </footer>
                <div class="dba-operation-loading" hidden aria-live="polite" aria-busy="true">${icon('refresh')}<span>正在下载...</span></div>
                <div class="dba-toast" role="status" aria-live="polite"></div>
            </aside>
            <div id="dba-preview"><img alt="图片预览"></div>
        `;
        document.body.appendChild(root);

        const launcher = root.querySelector('#doubao-assistant-btn');
        const panel = root.querySelector('#dba-panel');
        const list = root.querySelector('.dba-list');
        const status = root.querySelector('.dba-foot-status');
        const operationLoading = root.querySelector('.dba-operation-loading');
        const toast = root.querySelector('.dba-toast');
        const preview = root.querySelector('#dba-preview');
        const shareInfoElement = root.querySelector('.dba-share-info');
        let activeTab = 'image';
        let images = [];
        let videos = [];
        let downloading = false;
        let toastTimer = null;

        const escapeAttr = (value) => String(value ?? '')
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const getItems = (type = activeTab) => type === 'image' ? images : videos;
        const selectedInputs = () => [...list.querySelectorAll('.dba-select:checked')];
        const showToast = (message) => {
            if (toastTimer) clearTimeout(toastTimer);
            toast.textContent = message;
            toast.classList.add('show');
            toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
        };
        const renderLoading = (message) => {
            list.innerHTML = `<div class="dba-empty dba-empty-loading">${icon('refresh')}<strong>${escapeAttr(message)}</strong><span>分享视频解析可能需要几秒钟</span></div>`;
            status.textContent = message;
        };
        const renderShareInfo = (shareInfo) => {
            if (!isThreadPage || !shareInfo) return;
            const avatar = shareInfoElement.querySelector('.dba-share-avatar');
            const title = shareInfoElement.querySelector('.dba-share-title');
            const meta = shareInfoElement.querySelector('.dba-share-meta');
            title.textContent = shareInfo.title || '未命名分享';
            const sharedAt = shareInfo.sharedAt > 0 && shareInfo.sharedAt < 1e12
                ? shareInfo.sharedAt * 1000
                : shareInfo.sharedAt;
            const timestamp = sharedAt > 0
                ? new Date(sharedAt).toLocaleString('zh-CN', { hour12: false })
                : '';
            meta.textContent = [shareInfo.author ? `作者：${shareInfo.author}` : '', timestamp ? `分享于 ${timestamp}` : '']
                .filter(Boolean).join(' · ') || '分享信息不可用';
            avatar.innerHTML = shareInfo.avatar
                ? `<img src="${escapeAttr(shareInfo.avatar)}" alt="" referrerpolicy="no-referrer">`
                : escapeAttr((shareInfo.author || shareInfo.title || '享').slice(0, 1));
        };
        const getRefreshErrorMessage = (error) => {
            const message = String(error?.message || '未知错误');
            if (message.includes('失效') || message.includes('取消') || message.includes('不可用')) return message;
            if (message.includes('超时')) return '获取超时，请检查网络后重试';
            if (message.includes('Failed to fetch') || message.includes('网络')) return '网络请求失败，请检查连接后重试';
            return `素材获取失败：${message}`;
        };
        const updateSelection = (message = '') => {
            const count = selectedInputs().length;
            const multiButton = root.querySelector('[data-action="multi-download"]');
            const batchButton = root.querySelector('[data-action="batch"]');
            multiButton.disabled = downloading || count < 2;
            batchButton.disabled = downloading || count < 2;
            status.textContent = message || (count ? `已选择 ${count} 项` : '未选择素材');
            list.querySelectorAll('.dba-item').forEach(item => {
                item.classList.toggle('selected', Boolean(item.querySelector('.dba-select:checked')));
            });
            list.querySelectorAll('.dba-topic-select').forEach(topicInput => {
                const topicInputs = [...list.querySelectorAll(`.dba-item[data-topic-number="${topicInput.dataset.topicNumber}"] .dba-select`)];
                const selectedCount = topicInputs.filter(input => input.checked).length;
                topicInput.checked = topicInputs.length > 0 && selectedCount === topicInputs.length;
                topicInput.indeterminate = selectedCount > 0 && selectedCount < topicInputs.length;
            });
        };

        const render = () => {
            root.querySelectorAll('.dba-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === activeTab));
            const items = getItems();
            if (!items.length) {
                list.innerHTML = `<div class="dba-empty">${icon(activeTab)}<strong>暂无${activeTab === 'image' ? '图片' : '视频'}</strong><span>点击右上角可重新获取当前页面素材</span></div>`;
                updateSelection();
                return;
            }
            const topicOrder = new Map();
            [...images, ...videos].forEach(media => {
                const topicId = media.topicId || 'uncategorized';
                if (!topicOrder.has(topicId)) topicOrder.set(topicId, topicOrder.size);
            });
            const displayItems = items
                .map((media, index) => ({ media, index }))
                .sort((first, second) => topicOrder.get(first.media.topicId || 'uncategorized')
                    - topicOrder.get(second.media.topicId || 'uncategorized'));

            list.innerHTML = displayItems.map(({ media, index }, displayIndex) => {
                const isImage = activeTab === 'image';
                const resolution = media.width && media.height ? `${media.width} × ${media.height}` : '尺寸未知';
                const duration = !isImage && media.duration ? ` · ${Math.floor(media.duration / 60)}:${String(Math.floor(media.duration % 60)).padStart(2, '0')}` : '';
                const previewSource = isImage
                    ? (media.previewUrl || media.url)
                    : (media.poster_url || media.previewUrl || '');
                const previewUrl = escapeAttr(previewSource);
                const topicId = media.topicId || 'uncategorized';
                const topicNumber = (topicOrder.get(topicId) ?? 0) + 1;
                const topicItemNumber = displayItems
                    .slice(0, displayIndex + 1)
                    .filter(entry => (entry.media.topicId || 'uncategorized') === topicId).length;
                media.topicNumber = topicNumber;
                media.topicItemNumber = topicItemNumber;
                const isNewTopic = displayIndex === 0
                    || (displayItems[displayIndex - 1]?.media.topicId || 'uncategorized') !== topicId;
                const topicCount = isNewTopic ? items.filter(item => (item.topicId || 'uncategorized') === topicId).length : 0;
                const topicHeader = isNewTopic
                    ? `<div class="dba-topic-divider"><span class="dba-topic-title">话题 ${topicNumber} · ${escapeAttr(media.topicTitle || '未分类话题')}</span><span class="dba-topic-count">${topicCount} 项</span><input class="dba-topic-select" type="checkbox" data-topic-number="${topicNumber}" aria-label="选择话题 ${topicNumber} 的全部素材"></div>`
                    : '';
                return `${topicHeader}<article class="dba-item" data-index="${index}" data-topic-number="${topicNumber}">
                    <div class="dba-preview" data-action="preview" data-index="${index}">
                        ${previewUrl
                            ? `<img src="${previewUrl}" alt="${isImage ? '图片' : '视频封面'} ${index + 1}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
                            : `<div class="dba-preview-placeholder">${icon('video')}</div>`}
                        <span class="dba-type">${isImage ? 'IMAGE' : 'VIDEO'}</span>
                    </div>
                    <div class="dba-item-body">
                        <div class="dba-item-title">话题 ${topicNumber} · ${isImage ? '图片' : '视频'} ${topicItemNumber}</div>
                        <div class="dba-meta">${resolution}${duration}</div>
                        <div class="dba-actions">
                            <button class="dba-button" data-action="download" data-index="${index}">${icon('download')} 下载</button>
                            <button class="dba-button" data-action="copy" data-index="${index}">${icon('copy')} 复制链接</button>
                            <button class="dba-button icon-only" data-action="open" data-index="${index}" title="在新标签页打开" aria-label="在新标签页打开第 ${index + 1} 项">${icon('external')}</button>
                            <input class="dba-select" type="checkbox" data-index="${index}" aria-label="选择第 ${index + 1} 项">
                        </div>
                    </div>
                </article>`;
            }).join('');
            updateSelection();
        };

        const notifyButton = (button, label) => {
            const original = button.innerHTML;
            button.innerHTML = `${icon('check')} ${label}`;
            setTimeout(() => { if (button.isConnected) button.innerHTML = original; }, 1400);
        };

        const refreshMedia = async (triggerButton = null) => {
            if (triggerButton?.disabled) return;
            const startedAt = Date.now();
            if (triggerButton) {
                triggerButton.disabled = true;
                triggerButton.classList.add('loading');
                triggerButton.setAttribute('aria-busy', 'true');
            }
            status.textContent = '正在获取当前页面素材...';
            list.setAttribute('aria-busy', 'true');
            list.classList.add('loading');
            renderLoading(isThreadPage ? '正在读取分享内容...' : '正在获取当前页面素材...');
            await new Promise(resolve => requestAnimationFrame(resolve));

            try {
                const shareResult = isThreadPage
                    ? await extractSharePageMedia(renderLoading)
                    : null;
                images = shareResult ? shareResult.images : extractImages();
                videos = extractVideos();
                if (shareResult) renderShareInfo(shareResult.shareInfo);
                root.querySelector('[data-count="image"]').textContent = images.length;
                root.querySelector('[data-count="video"]').textContent = videos.length;
                if (!getItems(activeTab).length && getItems(activeTab === 'image' ? 'video' : 'image').length) {
                    activeTab = activeTab === 'image' ? 'video' : 'image';
                }
                render();
                const total = images.length + videos.length;
                if (shareResult?.failedVideoCount && !total && shareResult.detectedVideoCount) {
                    status.textContent = '视频地址解析失败，请点击刷新重试';
                } else if (shareResult?.failedVideoCount) {
                    status.textContent = `已获取 ${total} 项素材，另有 ${shareResult.failedVideoCount} 个视频解析失败`;
                } else if (total) {
                    status.textContent = `已获取 ${images.length} 张图片、${videos.length} 个视频`;
                } else {
                    status.textContent = isThreadPage
                        ? '该分享没有可提取的图片或视频'
                        : '当前页面暂未获取到素材';
                }
            } catch (error) {
                const message = getRefreshErrorMessage(error);
                list.innerHTML = `<div class="dba-empty">${icon('refresh')}<strong>${escapeAttr(message)}</strong><span>点击右上角刷新按钮可重新尝试</span></div>`;
                status.textContent = message;
            } finally {
                mediaProgressReporter = null;
                const remainingDelay = 450 - (Date.now() - startedAt);
                if (remainingDelay > 0) {
                    await new Promise(resolve => setTimeout(resolve, remainingDelay));
                }
                list.removeAttribute('aria-busy');
                list.classList.remove('loading');
                if (triggerButton) {
                    triggerButton.disabled = false;
                    triggerButton.classList.remove('loading');
                    triggerButton.removeAttribute('aria-busy');
                }
            }
        };

        const beginDownloadOperation = (message) => {
            if (downloading) return false;
            downloading = true;
            operationLoading.querySelector('span').textContent = message;
            operationLoading.hidden = false;
            panel.setAttribute('aria-busy', 'true');
            updateSelection(message);
            return true;
        };

        const finishDownloadOperation = (message) => {
            downloading = false;
            operationLoading.hidden = true;
            panel.removeAttribute('aria-busy');
            updateSelection(message);
        };

        const getSelectedIndexes = () => selectedInputs().map(input => Number(input.dataset.index));

        const runMultiDownload = async () => {
            const indexes = getSelectedIndexes();
            if (indexes.length < 2 || !beginDownloadOperation('正在准备批量下载...')) return;
            const operationType = activeTab;
            const operationItems = getItems(operationType);

            let completed = 0;
            let resultMessage = '';
            try {
                for (let position = 0; position < indexes.length; position++) {
                    const index = indexes[position];
                    const media = operationItems[index];
                    if (!media) continue;
                    operationLoading.querySelector('span').textContent = `正在下载 ${position + 1}/${indexes.length}`;
                    const task = createDownloadTask(media.url, getDownloadFilename(
                        operationType,
                        index,
                        media.url,
                        media.topicNumber,
                        media.topicItemNumber
                    ));
                    await task.promise;
                    completed++;
                }
            } catch (error) {
                resultMessage = '批量下载失败，请稍后重试';
            }

            finishDownloadOperation(resultMessage || `已下载 ${completed} 项素材`);
        };

        const runBatch = async () => {
            const indexes = getSelectedIndexes();
            if (indexes.length < 2 || !beginDownloadOperation('正在准备打包...')) return;
            const operationType = activeTab;
            const operationItems = getItems(operationType);

            const archiveEntries = [];
            let resultMessage = '';
            try {
                for (let position = 0; position < indexes.length; position++) {
                    const index = indexes[position];
                    const media = operationItems[index];
                    if (!media) continue;
                    operationLoading.querySelector('span').textContent = `正在读取 ${position + 1}/${indexes.length}`;
                    const blob = await fetchMediaBlob(media.url);
                    archiveEntries.push({
                        name: getDownloadFilename(
                            operationType,
                            index,
                            media.url,
                            media.topicNumber,
                            media.topicItemNumber
                        ),
                        data: new Uint8Array(await blob.arrayBuffer())
                    });
                }

                if (archiveEntries.length) {
                    operationLoading.querySelector('span').textContent = '正在生成 ZIP 压缩包...';
                    await new Promise(resolve => requestAnimationFrame(resolve));
                    const zipBlob = createZipArchive(archiveEntries);
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                    downloadBlob(zipBlob, `doubao_${operationType}_${timestamp}.zip`);
                    resultMessage = `已打包 ${archiveEntries.length} 项素材`;
                }
            } catch (error) {
                resultMessage = '打包失败，请稍后重试';
            }

            finishDownloadOperation(resultMessage || `已打包 ${archiveEntries.length} 项素材`);
        };

        const closeWorkspace = () => {
            panel.dataset.open = 'false';
            launcher.hidden = false;
            preview.classList.remove('show');
        };

        launcher.addEventListener('click', async () => {
            panel.dataset.open = 'true';
            launcher.hidden = true;
            await refreshMedia(root.querySelector('[data-action="refresh"]'));
        });
        preview.addEventListener('click', () => preview.classList.remove('show'));
        document.addEventListener('pointerdown', event => {
            if (panel.dataset.open !== 'true') return;
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (panel.contains(target) || launcher.contains(target) || preview.contains(target)) return;
            closeWorkspace();
        });
        list.addEventListener('change', event => {
            if (event.target.matches('.dba-topic-select')) {
                const topicNumber = event.target.dataset.topicNumber;
                list.querySelectorAll(`.dba-item[data-topic-number="${topicNumber}"] .dba-select`)
                    .forEach(input => { input.checked = event.target.checked; });
                updateSelection();
                return;
            }
            if (event.target.matches('.dba-select')) updateSelection();
        });
        root.addEventListener('click', async event => {
            const target = event.target.closest('[data-action], [data-tab]');
            if (!target) return;
            if (target.dataset.tab) {
                activeTab = target.dataset.tab;
                render();
                return;
            }
            const action = target.dataset.action;
            if (action === 'close') {
                closeWorkspace();
            }
            if (action === 'refresh') await refreshMedia(target);
            if (action === 'select-all') {
                const inputs = [...list.querySelectorAll('.dba-select')];
                const shouldSelect = inputs.some(input => !input.checked);
                inputs.forEach(input => { input.checked = shouldSelect; });
                target.textContent = shouldSelect ? '取消全选' : '全选';
                updateSelection();
            }
            if (action === 'multi-download') await runMultiDownload();
            if (action === 'batch') await runBatch();
            if (action === 'preview') {
                const media = getItems()[Number(target.dataset.index)];
                if (!media) return;
                const previewUrl = activeTab === 'image'
                    ? (media.previewUrl || media.url)
                    : (media.poster_url || media.previewUrl || '');
                if (previewUrl) {
                    preview.querySelector('img').src = previewUrl;
                    preview.classList.add('show');
                } else {
                    status.textContent = '该视频没有可用封面，可通过新标签页打开';
                }
            }
            if (action === 'download') {
                const index = Number(target.dataset.index);
                const media = getItems()[index];
                if (media) {
                    const message = `已开始下载${activeTab === 'image' ? '图片' : '视频'} ${media.topicItemNumber || index + 1}`;
                    status.textContent = message;
                    showToast(message);
                    await downloadImage(media.url, getDownloadFilename(
                        activeTab,
                        index,
                        media.url,
                        media.topicNumber,
                        media.topicItemNumber
                    ));
                }
            }
            if (action === 'copy') {
                const media = getItems()[Number(target.dataset.index)];
                if (!media) return;
                try {
                    await copyTextToClipboard(media.url);
                    notifyButton(target, '已复制');
                } catch (error) { status.textContent = '复制失败，请检查浏览器权限'; }
            }
            if (action === 'open') {
                const media = getItems()[Number(target.dataset.index)];
                if (!media) return;
                if (typeof GM_openInTab === 'function') {
                    GM_openInTab(media.url, { active: true, insert: true, setParent: true });
                } else {
                    const openedWindow = pageWindow.open(media.url, '_blank', 'noopener,noreferrer');
                    if (!openedWindow) status.textContent = '新标签页被浏览器拦截';
                }
            }
        });

        uiInitialized = true;
    }

    function initScript() {
        if (pageWindow.location.pathname.includes('/chat/')) {
            createAssistantWorkspace();
            return;
        }

        const hasScriptData = !!document.querySelector(
            'script[data-script-src="modern-run-router-data-fn"], script[data-script-src="modern-run-window-fn"][data-fn-name="mergeLoaderData"]'
        );
        const hasRouterData = !!window._ROUTER_DATA;

        if (!hasScriptData && !hasRouterData) {
            initRetryCount++;
            if (initRetryCount < MAX_RETRY) {
                setTimeout(initScript, 500);
                return;
            }
        }

        if (isDoubaoPage() && pageWindow.location.pathname.includes('/thread/')) {
            replaceChatImages(extractSharePageImages());
        }

        createAssistantWorkspace();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initScript);
    } else if (document.readyState === 'interactive') {
        if (document.body) {
            initScript();
        } else {
            document.addEventListener('DOMContentLoaded', initScript);
        }
    } else {
        initScript();
    }

})();
