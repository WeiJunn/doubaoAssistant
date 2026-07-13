function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
}

function normalizeName(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 40) return '';
  if (/^(cn|zh|zh-cn|en|en-us|ja|ko|sg|us|gb)$/i.test(text)) return '';
  if (/^[a-z]{2}[-_][a-z]{2}$/i.test(text)) return '';
  if (/登录|登陆|注册|扫码|退出|设置|下载|豆包|Doubao/i.test(text)) return '';
  return text;
}

function findNameInObject(value, depth = 0) {
  if (!value || depth > 4 || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNameInObject(item, depth + 1);
      if (found) return found;
    }
    return '';
  }

  const keys = ['nickname', 'nick_name', 'screen_name', 'display_name', 'user_name', 'username', 'userName'];
  for (const key of keys) {
    const found = normalizeName(value[key]);
    if (found) return found;
  }
  if (/user|account|profile|author|owner/i.test(Object.keys(value).join(' '))) {
    const found = normalizeName(value.name);
    if (found) return found;
  }
  for (const item of Object.values(value)) {
    const found = findNameInObject(item, depth + 1);
    if (found) return found;
  }
  return '';
}

function normalizeAvatarUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('//')) return `${location.protocol}${text}`;
  if (text.startsWith('/')) return new URL(text, location.origin).href;
  if (!/^https?:\/\//i.test(text)) return '';
  if (!/\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(text) && !/avatar|image|img|user|tos|byteimg/i.test(text)) return '';
  return text;
}

function findAvatarInObject(value, depth = 0) {
  if (!value || depth > 4 || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAvatarInObject(item, depth + 1);
      if (found) return found;
    }
    return '';
  }

  const keys = ['avatar', 'avatar_url', 'avatarUrl', 'icon', 'icon_url', 'picture', 'photo', 'profile_image_url'];
  for (const key of keys) {
    const found = normalizeAvatarUrl(value[key]);
    if (found) return found;
  }
  for (const item of Object.values(value)) {
    const found = findAvatarInObject(item, depth + 1);
    if (found) return found;
  }
  return '';
}

function inferNameFromStorage() {
  for (const storage of [localStorage, sessionStorage]) {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      const raw = storage.getItem(key);
      if (!raw || raw.length > 200000) continue;
      try {
        const found = findNameInObject(JSON.parse(raw));
        if (found) return found;
      } catch {
        if (/nick|display.?name|user.?name|screen.?name|profile/i.test(key)) {
          const found = normalizeName(raw);
          if (found) return found;
        }
      }
    }
  }
  return '';
}

function inferAvatarFromStorage() {
  for (const storage of [localStorage, sessionStorage]) {
    for (let i = 0; i < storage.length; i++) {
      const raw = storage.getItem(storage.key(i));
      if (!raw || raw.length > 200000) continue;
      try {
        const found = findAvatarInObject(JSON.parse(raw));
        if (found) return found;
      } catch {}
    }
  }
  return '';
}

function inferNameFromPage() {
  const selectors = [
    '[data-testid*="user" i]',
    '[class*="user" i]',
    '[class*="avatar" i]',
    '[aria-label*="用户"]',
    '[aria-label*="账号"]',
    'button'
  ];
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (!isVisible(el)) continue;
      const found = normalizeName(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent);
      if (found) return found;
    }
  }
  return '';
}

function inferAvatarFromPage() {
  const scopedCandidates = [
    ...document.querySelectorAll('[class*="avatar" i] img, [data-testid*="avatar" i] img, img[alt*="头像"], img[aria-label*="头像"]')
  ];
  for (const img of scopedCandidates) {
    if (!isVisible(img)) continue;
    const src = normalizeAvatarUrl(img.currentSrc || img.src);
    if (src) return src;
  }

  const candidates = Array.from(document.querySelectorAll('img'))
    .filter(img => {
      const rect = img.getBoundingClientRect();
      return rect.top < 180 && rect.width <= 96 && rect.height <= 96;
    });
  for (const img of candidates) {
    if (!isVisible(img)) continue;
    const src = normalizeAvatarUrl(img.currentSrc || img.src);
    if (src) return src;
  }

  for (const el of document.querySelectorAll('[class*="avatar" i], [data-testid*="avatar" i], [style*="background-image"]')) {
    if (!isVisible(el)) continue;
    const style = getComputedStyle(el);
    const match = /url\(["']?(.+?)["']?\)/.exec(style.backgroundImage || '');
    const found = normalizeAvatarUrl(match?.[1]);
    if (found) return found;
  }
  return '';
}

let accountInfoCache = null;
let accountInfoCacheTime = 0;

function parseRouterDataFromHtml(html) {
  const documentRoot = new DOMParser().parseFromString(html, 'text/html');
  for (const script of documentRoot.querySelectorAll('script')) {
    const source = script.textContent || '';
    if (!source.includes('window._ROUTER_DATA')) continue;
    const assignmentIndex = source.indexOf('window._ROUTER_DATA');
    const objectStart = source.indexOf('{', assignmentIndex);
    const objectEnd = source.lastIndexOf('}');
    if (objectStart < 0 || objectEnd <= objectStart) continue;
    try {
      return JSON.parse(source.slice(objectStart, objectEnd + 1));
    } catch {}
  }
  return null;
}

function getAccountInfoFromRouterData(routerData) {
  const accountInfo = routerData
    ?.loaderData
    ?.chat_layout
    ?.chat_layout
    ?.accountInfo
    ?.data;
  if (!accountInfo || typeof accountInfo !== 'object') return null;

  const name = normalizeName(accountInfo.screen_name) || normalizeName(accountInfo.name);
  const avatarUrl = normalizeAvatarUrl(accountInfo.avatar_url);
  const mobile = String(accountInfo.mobile || '').trim();
  if (!name && !avatarUrl && !mobile) return null;
  const hasAuthenticatedIdentity = Boolean(
    mobile
    || accountInfo.phone_collected
    || accountInfo.email
    || accountInfo.email_collected
    || Number(accountInfo.has_password) === 1
  );
  return {
    name,
    avatarUrl,
    mobile,
    source: 'router',
    isLoggedIn: accountInfo.is_visitor_account === false && hasAuthenticatedIdentity
  };
}

async function fetchAccountInfoFromChatPage() {
  if (accountInfoCache && Date.now() - accountInfoCacheTime < 10000) {
    return accountInfoCache;
  }
  try {
    const response = await fetch('https://www.doubao.com/chat/', {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store'
    });
    if (!response.ok) return null;
    const routerData = parseRouterDataFromHtml(await response.text());
    const profile = getAccountInfoFromRouterData(routerData);
    if (profile) {
      accountInfoCache = profile;
      accountInfoCacheTime = Date.now();
    }
    return profile;
  } catch {
    return null;
  }
}

function getAccountName() {
  return inferNameFromStorage() || inferNameFromPage();
}

async function getAccountProfile() {
  const routerProfile = await fetchAccountInfoFromChatPage();
  if (routerProfile) return routerProfile;
  return {
    name: getAccountName(),
    avatarUrl: inferAvatarFromStorage() || inferAvatarFromPage(),
    mobile: '',
    source: 'fallback',
    isLoggedIn: isLoggedIn()
  };
}

function hasVisibleLoginEntry() {
  return getClickableElements().some(el => {
    const text = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.trim();
    return /扫码登录|二维码登录|登录|登陆|注册|使用其他账号/i.test(text) && !/退出登录|已登录/i.test(text);
  });
}

function hasVisibleQrCode() {
  return Array.from(document.querySelectorAll('canvas, img, svg')).some(el => {
    if (!isVisible(el)) return false;
    const rect = el.getBoundingClientRect();
    const label = `${el.getAttribute('alt') || ''} ${el.getAttribute('aria-label') || ''} ${el.className || ''}`;
    return /二维码|扫码|qr/i.test(label) || (rect.width >= 120 && rect.height >= 120 && rect.width <= 360 && rect.height <= 360);
  });
}

function isLoggedIn() {
  const name = getAccountName();
  const avatarUrl = inferAvatarFromStorage() || inferAvatarFromPage();
  if (!name && !avatarUrl) return false;
  if (hasVisibleLoginEntry() || hasVisibleQrCode()) return false;
  return true;
}

function getClickableElements() {
  return Array.from(document.querySelectorAll('button, a, [role="button"], [tabindex]'))
    .filter(el => el instanceof HTMLElement && isVisible(el));
}

function clickByText(pattern, excludePattern = null) {
  const target = getClickableElements().find(el => {
    const text = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.trim();
    if (!pattern.test(text)) return false;
    return !excludePattern || !excludePattern.test(text);
  });
  if (!target) return false;
  target.click();
  return true;
}

function clickPossibleAccountMenu() {
  const target = getClickableElements().find(el => {
    const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.className || ''}`;
    return /账号|用户|个人|头像|profile|user|avatar|account/i.test(label);
  });
  if (!target) return false;
  target.click();
  return true;
}

function autoClickLoginEntry() {
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (attempts > 20) {
      clearInterval(timer);
      return;
    }
    if (clickByText(/切换账号|使用其他账号|其他账号|换个账号/i)) return;
    if (clickByText(/退出登录|退出当前账号|登出/i)) return;
    if (clickByText(/扫码登录|二维码登录|登录|登陆/i, /退出登录|已登录/i)) {
      clearInterval(timer);
      return;
    }
    if (attempts % 3 === 0) clickPossibleAccountMenu();
  }, 700);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'GET_ACCOUNT_NAME') {
    fetchAccountInfoFromChatPage().then(profile => {
      sendResponse({ name: profile?.name || getAccountName() });
    });
    return true;
  }
  if (message?.type === 'GET_ACCOUNT_PROFILE') {
    getAccountProfile().then(sendResponse);
    return true;
  }
  if (message?.type === 'AUTO_CLICK_LOGIN') {
    autoClickLoginEntry();
    sendResponse({ ok: true });
  }
});
