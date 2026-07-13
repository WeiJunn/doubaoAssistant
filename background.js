const DOUBAO_URL = 'https://www.doubao.com/chat/';
const COOKIE_URL = 'https://www.doubao.com/';
const DOUBAO_ORIGINS = [
  'https://www.doubao.com',
  'https://doubao.com'
];
const STORAGE_KEYS = {
  accounts: 'accounts',
  pendingLogin: 'pendingLogin',
  currentAccountId: 'currentAccountId'
};
const LOGIN_COOKIE_MIN_COUNT = 2;
const LOGIN_DETECT_DELAY_MS = 1400;
const PROFILE_READY_DELAY_MS = 1800;
const loginDetectTimers = new Map();
const autoClosingLoginWindows = new Set();

async function getStored(key, fallback) {
  const result = await chrome.storage.local.get(key);
  return result[key] ?? fallback;
}

async function setStored(values) {
  await chrome.storage.local.set(values);
}

function setBadge(text, color = '#203b27') {
  chrome.action.setBadgeText({ text }).catch(() => null);
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => null);
}

function nowId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getCookieIdentity(cookie) {
  return [
    cookie.name || '',
    cookie.domain || '',
    cookie.path || '/',
    cookie.value || ''
  ].join('\n');
}

function getCookieFingerprint(cookies) {
  return (cookies || [])
    .map(getCookieIdentity)
    .sort()
    .join('\n---\n');
}

function getAuthCookieWeight(name) {
  const normalizedName = String(name || '').toLowerCase();
  if (/^(sessionid|sessionid_ss|sid_tt|sid_tt_ss|uid_tt|uid_tt_ss)$/.test(normalizedName)) return 5;
  if (/session|passport_auth|login|oauth|auth_token|user_token|sid_guard/.test(normalizedName)) return 2;
  return 0;
}

function getCookieMatchKey(cookie) {
  return [
    String(cookie.name || '').toLowerCase(),
    String(cookie.domain || '').replace(/^\./, '').toLowerCase(),
    cookie.path || '/'
  ].join('|');
}

function findSavedAccountByCookies(accounts, cookies) {
  const fingerprint = getCookieFingerprint(cookies);
  if (!fingerprint) return null;
  const exactMatch = (accounts || []).find(account => getCookieFingerprint(account.cookies || []) === fingerprint);
  if (exactMatch) return exactMatch;

  const currentAuthCookies = new Map(
    (cookies || [])
      .filter(cookie => getAuthCookieWeight(cookie.name) > 0 && cookie.value)
      .map(cookie => [getCookieMatchKey(cookie), cookie.value])
  );
  if (!currentAuthCookies.size) return null;

  let bestMatch = null;
  let bestScore = 0;
  for (const account of accounts || []) {
    let score = 0;
    let matchedCount = 0;
    for (const cookie of account.cookies || []) {
      const weight = getAuthCookieWeight(cookie.name);
      if (!weight || !cookie.value) continue;
      if (currentAuthCookies.get(getCookieMatchKey(cookie)) === cookie.value) {
        score += weight;
        matchedCount += 1;
      }
    }
    if ((score >= 5 || matchedCount >= 2) && score > bestScore) {
      bestMatch = account;
      bestScore = score;
    }
  }
  return bestMatch;
}

function findSavedAccountByProfile(accounts, profile) {
  if (!profile?.isLoggedIn) return null;
  if (profile.mobile) {
    const mobileMatches = (accounts || []).filter(account => account.mobile && account.mobile === profile.mobile);
    if (mobileMatches.length === 1) return mobileMatches[0];
  }
  const name = String(profile.name || '').trim();
  if (!name) return null;
  const nameMatches = (accounts || []).filter(account => String(account.name || '').trim() === name);
  return nameMatches.length === 1 ? nameMatches[0] : null;
}

async function getDoubaoCookies() {
  const allCookies = await chrome.cookies.getAll({});
  const cookies = allCookies.filter(cookie => isDoubaoCookie(cookie));
  return cookies.map(cookie => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    hostOnly: cookie.hostOnly,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate,
    storeId: cookie.storeId,
    partitionKey: cookie.partitionKey
  }));
}

function isDoubaoCookie(cookie) {
  const domain = String(cookie.domain || '').replace(/^\./, '');
  return domain === 'doubao.com' || domain.endsWith('.doubao.com');
}

function getCookieSetUrl(cookie) {
  const domain = String(cookie.domain || 'www.doubao.com').replace(/^\./, '');
  const protocol = cookie.secure ? 'https:' : 'http:';
  return `${protocol}//${domain}${cookie.path || '/'}`;
}

async function clearDoubaoCookies() {
  const allCookies = await chrome.cookies.getAll({});
  const cookies = allCookies.filter(cookie => isDoubaoCookie(cookie));
  await Promise.all(cookies.map(cookie => {
    const details = {
      url: getCookieSetUrl(cookie),
      name: cookie.name,
      storeId: cookie.storeId
    };
    if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
    return chrome.cookies.remove(details).catch(() => null);
  }));
}

async function clearDoubaoSiteData() {
  await clearOpenDoubaoTabStorage();
  await clearDoubaoCookies();
  await chrome.browsingData.remove({
    origins: DOUBAO_ORIGINS
  }, {
    cacheStorage: true,
    cookies: true,
    fileSystems: true,
    indexedDB: true,
    localStorage: true,
    serviceWorkers: true,
    webSQL: true
  }).catch(error => {
    console.warn('[豆包账号切换器] 清理站点数据失败:', error);
  });
  await clearDoubaoCookies();
}

async function restoreCookies(cookies) {
  await clearDoubaoSiteData();
  for (const cookie of cookies || []) {
    const details = {
      url: getCookieSetUrl(cookie),
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || '/',
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      sameSite: cookie.sameSite || 'unspecified'
    };
    if (!cookie.hostOnly && cookie.domain) details.domain = cookie.domain;
    if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;
    if (cookie.storeId) details.storeId = cookie.storeId;
    if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
    await chrome.cookies.set(details).catch(error => {
      console.warn('[豆包账号切换器] 写入 Cookie 失败:', cookie.name, error);
    });
  }
}

async function queryDoubaoTabs() {
  return chrome.tabs.query({ url: ['https://www.doubao.com/*', 'https://*.doubao.com/*'] });
}

function isDoubaoPageUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return hostname === 'doubao.com' || hostname.endsWith('.doubao.com');
  } catch {
    return false;
  }
}

function isDolaPageUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return hostname === 'dola.com' || hostname.endsWith('.dola.com');
  } catch {
    return false;
  }
}

async function updateActionAvailability(tabId, url) {
  if (!Number.isInteger(tabId)) return;
  const isDoubao = isDoubaoPageUrl(url);
  const isDola = isDolaPageUrl(url);
  const available = isDoubao || isDola;
  if (available) {
    await chrome.action.enable(tabId).catch(() => null);
    await chrome.action.setTitle({
      tabId,
      title: isDoubao ? '豆包助手与账号管理' : 'Dola 素材助手'
    }).catch(() => null);
  } else {
    await chrome.action.disable(tabId).catch(() => null);
    await chrome.action.setTitle({ tabId, title: '请先打开豆包或 Dola 页面' }).catch(() => null);
  }
}

async function syncActionAvailability() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(tab => updateActionAvailability(tab.id, tab.url || '')));
}

async function clearOpenDoubaoTabStorage() {
  const tabs = await queryDoubaoTabs();
  await Promise.all(tabs.map(tab => chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
      try {
        if (indexedDB?.databases) {
          indexedDB.databases().then(databases => {
            databases.forEach(database => {
              if (database?.name) indexedDB.deleteDatabase(database.name);
            });
          });
        }
      } catch {}
      try {
        if (caches?.keys) {
          caches.keys().then(keys => keys.forEach(key => caches.delete(key)));
        }
      } catch {}
    }
  }).catch(() => null)));
}

async function reloadDoubaoTabs() {
  const tabs = await queryDoubaoTabs();
  await Promise.all(tabs.map(tab => chrome.tabs.reload(tab.id).catch(() => null)));
}

async function getActiveDoubaoTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const active = tabs[0];
  if (active?.url && active.url.includes('doubao.com')) return active;
  const doubaoTabs = await queryDoubaoTabs();
  return doubaoTabs[0] || null;
}

async function askContentForAccountName(tabId) {
  if (!tabId) return '';
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_ACCOUNT_NAME' });
    return response?.name || '';
  } catch {
    return '';
  }
}

async function askContentForAccountProfile(tabId) {
  if (!tabId) return { name: '', avatarUrl: '', mobile: '', source: '' };
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_ACCOUNT_PROFILE' });
    return {
      name: response?.name || '',
      avatarUrl: response?.avatarUrl || '',
      mobile: response?.mobile || '',
      source: response?.source || '',
      isLoggedIn: Boolean(response?.isLoggedIn)
    };
  } catch {
    return { name: '', avatarUrl: '', mobile: '', source: '', isLoggedIn: false };
  }
}

function fallbackAccountName() {
  return `豆包账号 ${new Date().toLocaleString()}`;
}

async function saveCurrentAccount(preferredName = '') {
  const tab = await getActiveDoubaoTab();
  const profile = await askContentForAccountProfile(tab?.id);
  if (!profile.isLoggedIn || profile.source !== 'router') {
    throw new Error('当前豆包账号未登录，无法保存');
  }
  const cookies = await getDoubaoCookies();
  if (!cookies.length) {
    throw new Error('当前没有检测到豆包登录 Cookie，无法保存');
  }
  const accounts = await getStored(STORAGE_KEYS.accounts, []);
  const existingAccount = findSavedAccountByCookies(accounts, cookies)
    || findSavedAccountByProfile(accounts, profile);
  if (existingAccount) {
    await setStored({ [STORAGE_KEYS.currentAccountId]: existingAccount.id });
    throw new Error(`当前账号已保存：${existingAccount.name || '未命名账号'}`);
  }

  const account = {
    id: nowId(),
    name: preferredName || profile.name || fallbackAccountName(),
    avatarUrl: profile.avatarUrl || '',
    mobile: profile.mobile || '',
    cookies,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  accounts.push(account);
  await setStored({
    [STORAGE_KEYS.accounts]: accounts,
    [STORAGE_KEYS.currentAccountId]: account.id
  });
  return account;
}

async function saveAccountFromLoginTab(tabId, preferredName = '') {
  const profile = await askContentForAccountProfile(tabId);
  if (!profile.isLoggedIn || profile.source !== 'router') {
    throw new Error('账号尚未完成登录，无法保存');
  }
  const cookies = await getDoubaoCookies();
  if (!cookies.length) {
    throw new Error('当前没有检测到豆包登录 Cookie，无法保存');
  }
  const accounts = await getStored(STORAGE_KEYS.accounts, []);
  const existingAccount = findSavedAccountByCookies(accounts, cookies)
    || findSavedAccountByProfile(accounts, profile);
  if (existingAccount) {
    await setStored({ [STORAGE_KEYS.currentAccountId]: existingAccount.id });
    return existingAccount;
  }

  const account = {
    id: nowId(),
    name: preferredName || profile.name || fallbackAccountName(),
    avatarUrl: profile.avatarUrl || '',
    mobile: profile.mobile || '',
    cookies,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  accounts.push(account);
  await setStored({
    [STORAGE_KEYS.accounts]: accounts,
    [STORAGE_KEYS.currentAccountId]: account.id
  });
  return account;
}

async function switchAccount(accountId) {
  const accounts = await getStored(STORAGE_KEYS.accounts, []);
  const account = accounts.find(item => item.id === accountId);
  if (!account) throw new Error('账号不存在');
  await restoreCookies(account.cookies);
  await setStored({ [STORAGE_KEYS.currentAccountId]: account.id });
  await reloadDoubaoTabs();
  return account;
}

async function deleteAccount(accountId) {
  const accounts = await getStored(STORAGE_KEYS.accounts, []);
  await setStored({ [STORAGE_KEYS.accounts]: accounts.filter(account => account.id !== accountId) });
  const currentAccountId = await getStored(STORAGE_KEYS.currentAccountId, '');
  if (currentAccountId === accountId) {
    await chrome.storage.local.remove(STORAGE_KEYS.currentAccountId);
  }
}

async function renameAccount(accountId, name) {
  const accounts = await getStored(STORAGE_KEYS.accounts, []);
  const account = accounts.find(item => item.id === accountId);
  if (!account) throw new Error('账号不存在');
  account.name = name;
  account.updatedAt = new Date().toISOString();
  await setStored({ [STORAGE_KEYS.accounts]: accounts });
  return account;
}

async function getCurrentAccount(accounts = null, profile = null) {
  const savedAccounts = accounts || await getStored(STORAGE_KEYS.accounts, []);
  if (!savedAccounts.length) return null;
  const currentCookies = await getDoubaoCookies();
  const matchedAccount = findSavedAccountByCookies(savedAccounts, currentCookies)
    || findSavedAccountByProfile(savedAccounts, profile);
  if (!matchedAccount) return null;
  let profileUpdated = false;
  if (profile?.source === 'router') {
    if (profile.mobile && matchedAccount.mobile !== profile.mobile) {
      matchedAccount.mobile = profile.mobile;
      profileUpdated = true;
    }
    if (profile.avatarUrl && matchedAccount.avatarUrl !== profile.avatarUrl) {
      matchedAccount.avatarUrl = profile.avatarUrl;
      profileUpdated = true;
    }
    if (profile.name && /^(豆包账号|未命名账号)/.test(matchedAccount.name || '')) {
      matchedAccount.name = profile.name;
      profileUpdated = true;
    }
  }
  if (profileUpdated) {
    matchedAccount.updatedAt = new Date().toISOString();
    await setStored({ [STORAGE_KEYS.accounts]: savedAccounts });
  }
  await setStored({ [STORAGE_KEYS.currentAccountId]: matchedAccount.id });
  return matchedAccount;
}

async function startQrLogin() {
  const backupCookies = await getDoubaoCookies();
  await setStored({
    [STORAGE_KEYS.pendingLogin]: {
      backupCookies,
      windowId: null,
      tabId: null,
      startedAt: new Date().toISOString()
    }
  });
  await clearDoubaoSiteData();

  const popupWindow = await chrome.windows.create({
    url: DOUBAO_URL,
    type: 'popup',
    width: 520,
    height: 760,
    focused: true
  });
  const tabId = popupWindow.tabs?.[0]?.id || null;
  await setStored({
    [STORAGE_KEYS.pendingLogin]: {
      backupCookies,
      windowId: popupWindow.id,
      tabId,
      status: 'waiting',
      startedAt: new Date().toISOString()
    }
  });
  setBadge('...');
  if (tabId) {
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, { type: 'AUTO_CLICK_LOGIN' }).catch(() => null);
    }, 1200);
    scheduleAutoFinishLogin(tabId, 'start');
  }
  return { windowId: popupWindow.id, tabId };
}

async function finishQrLogin({ restorePrevious = false } = {}) {
  const pending = await getStored(STORAGE_KEYS.pendingLogin, null);
  const tabId = pending?.tabId || null;
  await new Promise(resolve => setTimeout(resolve, PROFILE_READY_DELAY_MS));
  const account = await saveAccountFromLoginTab(tabId);
  await chrome.storage.local.remove(STORAGE_KEYS.pendingLogin);
  setBadge('');
  if (pending?.windowId) {
    autoClosingLoginWindows.add(pending.windowId);
    await chrome.windows.remove(pending.windowId).catch(() => null);
    setTimeout(() => autoClosingLoginWindows.delete(pending.windowId), 5000);
  }
  if (restorePrevious && pending?.backupCookies) {
    await restoreCookies(pending.backupCookies);
    await reloadDoubaoTabs();
  }
  return account;
}

async function cancelQrLogin() {
  const pending = await getStored(STORAGE_KEYS.pendingLogin, null);
  await chrome.storage.local.remove(STORAGE_KEYS.pendingLogin);
  setBadge('');
  if (pending?.windowId) {
    autoClosingLoginWindows.add(pending.windowId);
    await chrome.windows.remove(pending.windowId).catch(() => null);
    setTimeout(() => autoClosingLoginWindows.delete(pending.windowId), 5000);
  }
  if (pending?.backupCookies) {
    await restoreCookies(pending.backupCookies);
    await reloadDoubaoTabs();
  }
}

function hasEnoughLoginCookies(cookies) {
  return cookies.length >= LOGIN_COOKIE_MIN_COUNT && cookies.some(cookie => {
    const name = String(cookie.name || '').toLowerCase();
    return /session|sid|token|passport|auth|login|sso|uid|user/.test(name);
  });
}

function scheduleAutoFinishLogin(tabId, reason) {
  if (!tabId) return;
  if (loginDetectTimers.has(tabId)) {
    clearTimeout(loginDetectTimers.get(tabId));
  }
  const timer = setTimeout(() => {
    loginDetectTimers.delete(tabId);
    tryAutoFinishLogin(tabId, reason).catch(error => {
      console.warn('[豆包账号切换器] 自动保存扫码账号失败:', error);
    });
  }, LOGIN_DETECT_DELAY_MS);
  loginDetectTimers.set(tabId, timer);
}

async function tryAutoFinishLogin(tabId, reason) {
  const pending = await getStored(STORAGE_KEYS.pendingLogin, null);
  if (!pending || pending.tabId !== tabId || pending.status === 'saving') return;

  const cookies = await getDoubaoCookies();
  if (!hasEnoughLoginCookies(cookies)) {
    scheduleAutoFinishLogin(tabId, reason);
    return;
  }

  const profile = await askContentForAccountProfile(tabId);
  if (!profile.isLoggedIn || profile.source !== 'router') {
    scheduleAutoFinishLogin(tabId, 'profile-not-ready');
    return;
  }

  await setStored({
    [STORAGE_KEYS.pendingLogin]: {
      ...pending,
      status: 'saving',
      detectedAt: new Date().toISOString()
    }
  });

  await new Promise(resolve => setTimeout(resolve, PROFILE_READY_DELAY_MS));
  const account = await saveAccountFromLoginTab(tabId, profile.name);
  await chrome.storage.local.remove(STORAGE_KEYS.pendingLogin);
  setBadge('✓', '#166534');
  setTimeout(() => setBadge(''), 2500);
  if (pending.windowId) {
    autoClosingLoginWindows.add(pending.windowId);
    await chrome.windows.remove(pending.windowId).catch(() => null);
    setTimeout(() => autoClosingLoginWindows.delete(pending.windowId), 5000);
  }
  console.log('[豆包账号切换器] 已自动保存扫码账号:', account.name);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'LIST_ACCOUNTS':
        const accounts = await getStored(STORAGE_KEYS.accounts, []);
        const activeTab = await getActiveDoubaoTab();
        const activeProfile = await askContentForAccountProfile(activeTab?.id);
        return {
          accounts,
          currentAccount: await getCurrentAccount(accounts, activeProfile),
          pendingLogin: await getStored(STORAGE_KEYS.pendingLogin, null),
          canSaveCurrentAccount: activeProfile.source === 'router' && activeProfile.isLoggedIn
        };
      case 'SAVE_CURRENT':
        return { account: await saveCurrentAccount(message.name || '') };
      case 'START_QR_LOGIN':
        return await startQrLogin();
      case 'FINISH_QR_LOGIN':
        return { account: await finishQrLogin({ restorePrevious: Boolean(message.restorePrevious) }) };
      case 'CANCEL_QR_LOGIN':
        await cancelQrLogin();
        return { ok: true };
      case 'SWITCH_ACCOUNT':
        return { account: await switchAccount(message.accountId) };
      case 'DELETE_ACCOUNT':
        await deleteAccount(message.accountId);
        return { ok: true };
      case 'RENAME_ACCOUNT':
        return { account: await renameAccount(message.accountId, message.name || '') };
      default:
        throw new Error('未知操作');
    }
  })().then(result => sendResponse({ ok: true, ...result })).catch(error => {
    console.error('[豆包账号切换器]', error);
    sendResponse({ ok: false, error: error.message || String(error) });
  });
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    updateActionAvailability(tabId, changeInfo.url || tab.url || '').catch(() => null);
  }
  if (changeInfo.status !== 'complete' || !isDoubaoPageUrl(tab.url)) return;
  getStored(STORAGE_KEYS.pendingLogin, null).then(pending => {
    if (pending?.tabId !== tabId) return;
    chrome.tabs.sendMessage(tabId, { type: 'AUTO_CLICK_LOGIN' }).catch(() => null);
    scheduleAutoFinishLogin(tabId, 'tab-updated');
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId)
    .then(tab => updateActionAvailability(tabId, tab.url || ''))
    .catch(() => null);
});

chrome.runtime.onInstalled.addListener(() => {
  syncActionAvailability().catch(() => null);
});

chrome.runtime.onStartup.addListener(() => {
  syncActionAvailability().catch(() => null);
});

syncActionAvailability().catch(() => null);

chrome.cookies.onChanged.addListener(changeInfo => {
  if (!isDoubaoCookie(changeInfo.cookie)) return;
  getStored(STORAGE_KEYS.pendingLogin, null).then(pending => {
    if (!pending?.tabId) return;
    scheduleAutoFinishLogin(pending.tabId, 'cookie-changed');
  });
});

chrome.windows.onRemoved.addListener(windowId => {
  getStored(STORAGE_KEYS.pendingLogin, null).then(pending => {
    if (pending?.windowId !== windowId) return;
    if (autoClosingLoginWindows.has(windowId)) {
      autoClosingLoginWindows.delete(windowId);
      return;
    }
    chrome.storage.local.remove(STORAGE_KEYS.pendingLogin);
    setBadge('');
  });
});
