const accountList = document.getElementById('accountList');
const countText = document.getElementById('countText');
const statusText = document.getElementById('statusText');
const pendingPanel = document.getElementById('pendingPanel');
const startLoginBtn = document.getElementById('startLoginBtn');
const saveCurrentBtn = document.getElementById('saveCurrentBtn');
const finishLoginBtn = document.getElementById('finishLoginBtn');
const cancelLoginBtn = document.getElementById('cancelLoginBtn');
const currentAccountBody = document.getElementById('currentAccountBody');
const accountManager = document.getElementById('accountManager');
const dolaPanel = document.getElementById('dolaPanel');
let currentAccountId = '';
let isCurrentLoggedIn = false;
let accountUiActive = false;

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload }).then(response => {
    if (!response?.ok) throw new Error(response?.error || '操作失败');
    return response;
  });
}

function setStatus(text) {
  statusText.textContent = text || '';
}

function formatTime(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function getInitial(name) {
  return String(name || '豆').trim().slice(0, 1).toUpperCase() || '豆';
}

function renderAvatar(account) {
  if (account.avatarUrl) {
    return `<img class="account-avatar" src="${escapeHtml(account.avatarUrl)}" alt="${escapeHtml(account.name || '账号头像')}" referrerpolicy="no-referrer">`;
  }
  return `<div class="account-avatar fallback">${escapeHtml(getInitial(account.name))}</div>`;
}

function renderCurrentAccount(account) {
  if (!account) {
    currentAccountBody.innerHTML = `
      <div class="current-empty">
        <strong>未记录当前账号</strong>
        <span>保存或切换账号后会在这里显示</span>
      </div>
    `;
    return;
  }
  currentAccountBody.innerHTML = `
    <div class="account-main">
      ${renderAvatar(account)}
      <div class="account-info">
        <div class="account-name">${escapeHtml(account.name || '未命名账号')}</div>
        <div class="account-meta">${account.mobile ? `${escapeHtml(account.mobile)} · ` : ''}${account.cookies?.length || 0} 个 Cookie</div>
      </div>
    </div>
  `;
}

function renderAccounts(accounts) {
  countText.textContent = `${accounts.length} 个`;
  if (accounts.length === 0) {
    accountList.innerHTML = '<div class="empty">还没有账号。点击“添加账号”开始。</div>';
    return;
  }
  accountList.innerHTML = accounts.map(account => `
    <article class="account-card ${account.id === currentAccountId ? 'current' : ''}" data-id="${escapeHtml(account.id)}">
      <div class="account-main">
        ${renderAvatar(account)}
        <div class="account-info">
          <div class="account-name">${escapeHtml(account.name || '未命名账号')}${account.id === currentAccountId ? '<span class="current-badge">当前</span>' : ''}</div>
          <div class="account-meta">${account.mobile ? `${escapeHtml(account.mobile)} · ` : ''}${account.cookies?.length || 0} 个 Cookie · ${escapeHtml(formatTime(account.updatedAt || account.createdAt))}</div>
        </div>
      </div>
      <div class="card-actions">
        <button data-action="switch" type="button">切换</button>
        <button data-action="rename" type="button">改名</button>
        <button class="danger" data-action="delete" type="button">删除</button>
      </div>
    </article>
  `).join('');
}

async function refresh() {
  const response = await send('LIST_ACCOUNTS');
  currentAccountId = response.currentAccount?.id || '';
  isCurrentLoggedIn = Boolean(response.canSaveCurrentAccount);
  pendingPanel.classList.toggle('hidden', !response.pendingLogin);
  startLoginBtn.disabled = Boolean(response.pendingLogin);
  saveCurrentBtn.disabled = Boolean(
    response.pendingLogin
    || response.currentAccount
    || !response.canSaveCurrentAccount
  );
  saveCurrentBtn.textContent = response.currentAccount ? '当前已保存' : '保存当前账号';
  saveCurrentBtn.title = response.currentAccount
    ? '当前账号已经在账号列表中'
    : (response.canSaveCurrentAccount ? '' : '当前豆包账号未登录');
  renderCurrentAccount(response.currentAccount || null);
  renderAccounts(response.accounts || []);
}

async function runAction(action) {
  try {
    setStatus('处理中...');
    await action();
    await refresh();
    setStatus('已完成');
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

startLoginBtn.addEventListener('click', () => {
  if (isCurrentLoggedIn) {
    const confirmed = confirm(
      '添加账号会退出当前豆包账号。\n\n如果需要保留当前账号，请先取消，然后点击“保存当前账号”。\n\n确定继续添加账号吗？'
    );
    if (!confirmed) return;
  }
  runAction(async () => {
    await send('START_QR_LOGIN');
    setStatus('已打开账号登录窗口');
  });
});

saveCurrentBtn.addEventListener('click', () => runAction(async () => {
  await send('SAVE_CURRENT');
}));

finishLoginBtn.addEventListener('click', () => runAction(async () => {
  await send('FINISH_QR_LOGIN', { restorePrevious: false });
}));

cancelLoginBtn.addEventListener('click', () => runAction(async () => {
  await send('CANCEL_QR_LOGIN');
}));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (!accountUiActive) return;
  if (areaName !== 'local') return;
  if (!changes.accounts && !changes.pendingLogin && !changes.currentAccountId) return;
  refresh().catch(error => setStatus(error.message || String(error)));
});

accountList.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  const card = event.target.closest('.account-card');
  if (!button || !card) return;

  const accountId = card.dataset.id;
  const action = button.dataset.action;
  runAction(async () => {
    if (action === 'switch') {
      await send('SWITCH_ACCOUNT', { accountId });
      return;
    }
    if (action === 'rename') {
      const name = prompt('输入新的账号名称');
      if (!name?.trim()) return;
      await send('RENAME_ACCOUNT', { accountId, name: name.trim() });
      return;
    }
    if (action === 'delete') {
      if (!confirm('删除这个账号快照？')) return;
      await send('DELETE_ACCOUNT', { accountId });
    }
  });
});

async function initPopup() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let hostname = '';
  try {
    hostname = new URL(activeTab?.url || '').hostname.replace(/^www\./, '');
  } catch {}

  const isDoubao = hostname === 'doubao.com' || hostname.endsWith('.doubao.com');
  const isDola = hostname === 'dola.com' || hostname.endsWith('.dola.com');
  accountUiActive = isDoubao;
  accountManager.classList.toggle('hidden', !isDoubao);
  dolaPanel.classList.toggle('hidden', !isDola);

  if (isDoubao) {
    await refresh();
  }
}

initPopup().catch(error => setStatus(error.message || String(error)));
