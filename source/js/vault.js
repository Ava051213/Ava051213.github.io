(() => {
  'use strict';

  const SELF = document.currentScript;
  const VAULT_URL = SELF ? new URL('../private-vault.json', SELF.src).href : '/private-vault.json';
  const MIN_ITER = 100000;
  const MAX_ITER = 2000000;
  const DECODER = new TextDecoder();

  let dialog = null;
  let ui = null;
  let entries = null;
  let busy = false;

  const decode = (value) => Uint8Array.from(atob(String(value)), (ch) => ch.charCodeAt(0));

  function setMessage(text, tone) {
    ui.message.textContent = text || '';
    ui.message.dataset.tone = tone || '';
  }

  function showStage(name) {
    Object.entries(ui.stages).forEach(([key, el]) => {
      el.hidden = key !== name;
    });
    dialog.dataset.stage = name;
  }

  function resetVault() {
    entries = null;
    busy = false;
    if (!ui) return;
    ui.input.value = '';
    ui.input.disabled = false;
    ui.submit.disabled = false;
    setMessage('');
    ui.list.replaceChildren();
    ui.listCount.textContent = '';
    ui.entryTitle.textContent = '';
    ui.entryDate.textContent = '';
    ui.entryBody.textContent = '';
    showStage('lock');
    document.documentElement.classList.remove('vault-page-locked');
  }

  async function decryptVault(password) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('unsupported');
    }

    const response = await fetch(VAULT_URL, { cache: 'no-cache', credentials: 'same-origin' });
    if (!response.ok) throw new Error('fetch');
    const vault = await response.json();

    if (!vault || vault.v !== 1 || vault.alg !== 'AES-256-GCM' || vault.kdf !== 'PBKDF2-SHA256') {
      throw new Error('format');
    }
    const iterations = Number(vault.iter);
    if (!Number.isInteger(iterations) || iterations < MIN_ITER || iterations > MAX_ITER) {
      throw new Error('format');
    }

    const material = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: decode(vault.salt), iterations, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decode(vault.iv), tagLength: 128 },
      key,
      decode(vault.data)
    );

    const payload = JSON.parse(DECODER.decode(plain));
    if (!payload || payload.v !== 1 || !Array.isArray(payload.entries)) {
      throw new Error('format');
    }

    return payload.entries
      .filter((entry) => entry
        && typeof entry.title === 'string'
        && typeof entry.date === 'string'
        && typeof entry.body === 'string')
      .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title, 'zh-CN'));
  }

  function openEntry(entry) {
    ui.entryTitle.textContent = entry.title;
    ui.entryDate.textContent = entry.date;
    ui.entryBody.textContent = entry.body;
    showStage('read');
    ui.stages.read.scrollTop = 0;
    ui.back.focus();
  }

  function renderList() {
    ui.list.replaceChildren();
    ui.listCount.textContent = entries.length ? `共 ${entries.length} 篇` : '还没有日记';

    entries.forEach((entry) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'vault-list-item';

      const date = document.createElement('time');
      date.className = 'vault-list-date';
      date.textContent = entry.date;

      const title = document.createElement('span');
      title.className = 'vault-list-title';
      title.textContent = entry.title;

      item.append(date, title);
      item.addEventListener('click', () => openEntry(entry));
      ui.list.append(item);
    });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;

    const password = ui.input.value;
    if (!password) {
      setMessage('请输入密码。', 'error');
      ui.input.focus();
      return;
    }

    busy = true;
    ui.input.disabled = true;
    ui.submit.disabled = true;
    setMessage('正在解密…');

    try {
      entries = await decryptVault(password);
      ui.input.value = '';
      setMessage('');
      renderList();
      showStage('list');
      const first = ui.list.querySelector('.vault-list-item');
      if (first) requestAnimationFrame(() => first.focus());
    } catch (error) {
      const message = error && error.message === 'fetch'
        ? '密文加载失败，请刷新页面再试。'
        : error && error.message === 'unsupported'
          ? '当前浏览器或环境不支持解密，需要 HTTPS。'
          : '密码不对，或密文已损坏。';
      setMessage(message, 'error');
      ui.input.select();
    } finally {
      busy = false;
      ui.input.disabled = false;
      ui.submit.disabled = false;
      if (dialog.dataset.stage === 'lock') ui.input.focus();
    }
  }

  function closeDialog() {
    if (dialog && dialog.open) dialog.close();
  }

  function openDialog() {
    ensureDialog();
    if (dialog.open) return;
    resetVault();
    dialog.showModal();
    document.documentElement.classList.add('vault-page-locked');
    requestAnimationFrame(() => ui.input.focus());
  }

  function ensureDialog() {
    if (dialog && dialog.isConnected) return;

    dialog = document.createElement('dialog');
    dialog.className = 'vault-dialog';
    dialog.setAttribute('aria-labelledby', 'vault-title');
    dialog.innerHTML = `
      <div class="vault-shell">
        <header class="vault-head">
          <span class="vault-badge" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20"><rect x="4.5" y="10" width="15" height="10" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 10V7.8a4 4 0 0 1 8 0V10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="14.6" r="1.15" fill="currentColor"/><path d="M12 15.6v1.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
          </span>
          <span class="vault-heading">
            <h2 class="vault-title" id="vault-title">私密</h2>
            <span class="vault-sub">密码只在本机使用，不会被保存</span>
          </span>
          <button type="button" class="vault-icon-btn" data-vault-close aria-label="关闭并锁定">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </button>
        </header>

        <div class="vault-stage vault-lock-stage">
          <p class="vault-copy">输入密码打开这个文件夹。</p>
          <form class="vault-form">
            <input class="vault-input" type="password" autocomplete="current-password" spellcheck="false" placeholder="密码" aria-label="密码">
            <button class="vault-submit" type="submit">解锁</button>
          </form>
          <p class="vault-message" role="status"></p>
          <p class="vault-footnote">关闭窗口后自动锁定，再打开需要重新输入密码。</p>
        </div>

        <div class="vault-stage vault-list-stage" hidden>
          <div class="vault-list-head">
            <span class="vault-list-count"></span>
            <span class="vault-list-hint">关闭后自动锁定</span>
          </div>
          <div class="vault-list"></div>
        </div>

        <div class="vault-stage vault-read-stage" hidden>
          <button type="button" class="vault-back">← 返回目录</button>
          <article class="vault-entry">
            <h3 class="vault-entry-title"></h3>
            <time class="vault-entry-date"></time>
            <div class="vault-entry-body"></div>
          </article>
        </div>
      </div>`;

    ui = {
      stages: {
        lock: dialog.querySelector('.vault-lock-stage'),
        list: dialog.querySelector('.vault-list-stage'),
        read: dialog.querySelector('.vault-read-stage')
      },
      form: dialog.querySelector('.vault-form'),
      input: dialog.querySelector('.vault-input'),
      submit: dialog.querySelector('.vault-submit'),
      message: dialog.querySelector('.vault-message'),
      list: dialog.querySelector('.vault-list'),
      listCount: dialog.querySelector('.vault-list-count'),
      back: dialog.querySelector('.vault-back'),
      entryTitle: dialog.querySelector('.vault-entry-title'),
      entryDate: dialog.querySelector('.vault-entry-date'),
      entryBody: dialog.querySelector('.vault-entry-body')
    };

    ui.form.addEventListener('submit', handleSubmit);
    ui.back.addEventListener('click', () => {
      showStage('list');
      const first = ui.list.querySelector('.vault-list-item');
      if (first) first.focus();
    });
    dialog.querySelector('[data-vault-close]').addEventListener('click', closeDialog);
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeDialog();
    });
    dialog.addEventListener('close', resetVault);

    document.body.appendChild(dialog);
    showStage('lock');
  }

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-vault-open]');
    if (!trigger) return;
    event.preventDefault();
    openDialog();
  });

  document.addEventListener('pjax:send', closeDialog);
  window.addEventListener('pagehide', closeDialog);
})();
