// ==UserScript==
// @name         TikTok Studio 批量发布助手 v2
// @namespace    tiktok-bulk-upload
// @version      0.3.13
// @description  选一次文件夹(文件名=商品ID)，跨页面自动恢复文件、追加新视频，并按1.5~2.5小时随机间隔全自动发布
// @match        https://www.tiktok.com/tiktokstudio/upload*
// @match        https://www.tiktok.com/tiktokstudio/content*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ========================= 配置区 =========================
  const CONFIG = {
    HASHTAG_KEYWORDS: ['fyp', 'tiktok', 'tiktokshop'], // 对应你截图历史标签里的 # fyp # tiktok # tiktokshop
    MIN_INTERVAL_MS: 1.5 * 60 * 60 * 1000,
    MAX_INTERVAL_MS: 2.5 * 60 * 60 * 1000,
    FOLDER_SCAN_INTERVAL_MS: 30 * 1000,
    VIDEO_EXTENSIONS: ['.mp4', '.mov', '.avi', '.webm'],

    TEXT: {
      NEXT_BTN: 'Berikutnya',
      SEARCH_PRODUCT_PLACEHOLDER: 'Cari produk',
      NOW_RADIO_LABEL: 'Sekarang',
      PRODUCT_CONFIRM_BUTTONS: ['Berikutnya', 'Tambah', 'Tambahkan', 'Konfirmasi', 'Simpan'],
    },
  };

  // ========================= 工具函数 =========================

  function checkIfPaused() {
    const state = getState();
    if (state && state.autoPaused) {
      const err = new Error('任务已被手动暂停');
      err.code = 'user_paused';
      throw err;
    }
  }

  function sleep(ms) {
    return new Promise((resolve, reject) => {
      const step = 100;
      let spent = 0;
      const timer = setInterval(() => {
        try {
          checkIfPaused();
        } catch (err) {
          clearInterval(timer);
          reject(err);
          return;
        }
        spent += step;
        if (spent >= ms) {
          clearInterval(timer);
          resolve();
        }
      }, step);
    });
  }

  // 人类化的随机停顿，避免所有操作像机器一样毫无间隔地连续发生
  function humanDelay(minMs = 800, maxMs = 2200) {
    return sleep(minMs + Math.random() * (maxMs - minMs));
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function findByText(tag, text, exact = false) {
    const nodes = Array.from(document.querySelectorAll(tag));
    return nodes.find((el) => {
      const t = (el.textContent || '').trim();
      if (!isVisible(el)) return false;
      return exact ? t === text : t.includes(text);
    });
  }

  function findClickableByText(text, exact = false) {
    const candidates = ['button', 'div', 'span', 'a', 'label'];
    for (const tag of candidates) {
      const el = findByText(tag, text, exact);
      if (el) {
        const btnAncestor = el.closest('button');
        return btnAncestor || el;
      }
    }
    return null;
  }

  function findActionByTextsWithin(root, texts) {
    if (!root) return null;
    const candidates = Array.from(root.querySelectorAll('button, [role="button"]'));
    for (const text of texts) {
      const match = candidates.find((el) =>
        isVisible(el) && isEnabled(el) && (el.textContent || '').trim() === text
      );
      if (match) return match;
    }
    return null;
  }

  function getModalRoot(el) {
    if (!el) return null;
    const modalSelector = [
      '[role="dialog"]',
      '[aria-modal="true"]',
      '.TUXModal',
      '[class*="TUXModal"]',
      '[class*="modal-content"]',
      '[class*="ModalContent"]',
      '[class*="modal-container"]',
      '[class*="ModalContainer"]',
    ].join(',');

    // 取最外层而不是closest到的内层内容区，保证弹窗换步骤时根节点仍可用于关闭检测。
    let semanticRoot = null;
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (node.matches(modalSelector)) semanticRoot = node;
    }
    if (semanticRoot) return semanticRoot;

    // TikTok偶尔不给弹窗加role；这种情况下取包含目标元素的最外层fixed容器。
    let fixedRoot = null;
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (window.getComputedStyle(node).position === 'fixed') fixedRoot = node;
    }
    return fixedRoot || document.body;
  }

  function getVisibleModalRoots() {
    const selector = [
      '[role="dialog"]',
      '[aria-modal="true"]',
      '.TUXModal',
      '[class*="TUXModal"]',
      '[class*="modal-container"]',
      '[class*="ModalContainer"]',
    ].join(',');
    const roots = [];
    for (const candidate of document.querySelectorAll(selector)) {
      if (!isVisible(candidate)) continue;
      const root = getModalRoot(candidate);
      if (root && root !== document.body && isVisible(root) && !roots.includes(root)) {
        roots.push(root);
      }
    }
    return roots;
  }

  function isProductPickerOpen() {
    return Array.from(document.querySelectorAll('input')).some((input) =>
      isVisible(input) &&
      (input.getAttribute('placeholder') || '').includes(CONFIG.TEXT.SEARCH_PRODUCT_PLACEHOLDER)
    );
  }

  function isProductWorkflowModal(root) {
    if (!root || !isVisible(root)) return false;
    const text = (root.innerText || root.textContent || '').replace(/\s+/g, ' ').trim();
    return Boolean(root.querySelector(`input[placeholder*="${CONFIG.TEXT.SEARCH_PRODUCT_PLACEHOLDER}"]`)) ||
      text.includes('Tambah tautan') ||
      text.includes('Nama produk');
  }

  function getTopProductWorkflowModal() {
    // TikTok会把“选商品”和“编辑展示名”做成两个同级弹窗；后创建的弹窗位于DOM后面。
    return getVisibleModalRoots().filter(isProductWorkflowModal).pop() || null;
  }

  function hasOpenProductWorkflowModal() {
    return Boolean(getTopProductWorkflowModal());
  }

  function hasAttachedProduct() {
    return Array.from(document.querySelectorAll('.anchor-container .content-anchor-label'))
      .some(isVisible);
  }

  function assertProductPickerClosed(nextAction) {
    if (hasOpenProductWorkflowModal()) {
      throw new Error(`商品流程弹窗仍然打开，禁止继续${nextAction}，避免后台误点击`);
    }
  }

  async function waitForOrNull(fn, timeout = 5000, interval = 150) {
    try {
      return await waitFor(fn, timeout, interval);
    } catch (err) {
      if (err && err.message === '等待元素超时') return null;
      throw err;
    }
  }

  async function waitFor(fn, timeout = 10000, interval = 300) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      checkIfPaused();
      checkForAppCrash();
      const result = fn();
      if (result) return result;
      await sleep(interval);
    }
    checkIfPaused();
    throw new Error('等待元素超时');
  }

  function fireClick(el) {
    el.scrollIntoView({ block: 'center' });
    el.click();
  }

  function log(msg) {
    console.log('[TK批量发布]', msg);
    const panel = document.getElementById('tkq-log');
    if (panel) {
      const line = document.createElement('div');
      line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
      panel.appendChild(line);
      panel.scrollTop = panel.scrollHeight;
    }
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function randomInterval() {
    const { MIN_INTERVAL_MS, MAX_INTERVAL_MS } = CONFIG;
    return MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
  }

  // ========================= 状态（跨页面/跨日期保留，避免重复发布） =========================
  const STATE_KEY = 'tkq_state_v2';
  const FOLDER_DB_NAME = 'tkq_file_access_v1';
  const FOLDER_STORE_NAME = 'handles';
  const FOLDER_HANDLE_KEY = 'auto-upload-folder';

  function getState() {
    const state = GM_getValue(STATE_KEY, null);
    if (!state || !Array.isArray(state.items)) return null;
    if (!Number.isInteger(state.doneIndex)) state.doneIndex = -1;
    if (!Number.isInteger(state.pendingIndex)) state.pendingIndex = null;
    if (state.pendingIndex === null) state.pendingSince = null;
    if (!Number.isFinite(state.nextTime)) state.nextTime = Date.now();
    if (typeof state.autoPaused !== 'boolean') state.autoPaused = false;
    if (typeof state.pauseReason !== 'string') state.pauseReason = '';
    if (typeof state.pauseCode !== 'string') state.pauseCode = '';
    if (typeof state.returnToUploadPending !== 'boolean') state.returnToUploadPending = false;
    return state;
  }

  function setState(state) {
    if (!state.date) state.date = todayStr();
    state.updatedAt = Date.now();
    GM_setValue(STATE_KEY, state);
  }

  function openFolderDb() {
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(FOLDER_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(FOLDER_STORE_NAME)) {
          db.createObjectStore(FOLDER_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法打开浏览器文件夹存储'));
    });
  }

  async function saveDirectoryHandle(handle) {
    const db = await openFolderDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(FOLDER_STORE_NAME, 'readwrite');
        tx.objectStore(FOLDER_STORE_NAME).put(handle, FOLDER_HANDLE_KEY);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('保存文件夹权限失败'));
        tx.onabort = () => reject(tx.error || new Error('保存文件夹权限被中止'));
      });
    } finally {
      db.close();
    }
  }

  async function loadDirectoryHandle() {
    const db = await openFolderDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(FOLDER_STORE_NAME, 'readonly');
        const request = tx.objectStore(FOLDER_STORE_NAME).get(FOLDER_HANDLE_KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('读取文件夹权限失败'));
      });
    } finally {
      db.close();
    }
  }

  async function hasDirectoryPermission(handle, requestIfNeeded = false) {
    if (!handle) return false;
    const options = { mode: 'read' };
    if (typeof handle.queryPermission === 'function') {
      const status = await handle.queryPermission(options);
      if (status === 'granted') return true;
      if (status === 'denied' || !requestIfNeeded) return false;
    }
    if (requestIfNeeded && typeof handle.requestPermission === 'function') {
      return (await handle.requestPermission(options)) === 'granted';
    }
    return false;
  }

  function productIdFromFilename(name) {
    // 先去扩展名，比如 "1736825684750795855 (2).mp4" -> "1736825684750795855 (2)"
    let base = name.replace(/\.[^.]+$/, '');
    // 再去掉Windows同文件夹重名时自动加的" (1)" "(2)"这种后缀，比如同一个商品挂了4条视频时会出现这种命名
    base = base.replace(/\s*\(\d+\)$/, '');
    return base.trim();
  }

  function isVideoFile(file) {
    const lower = file.name.toLowerCase();
    return CONFIG.VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  function isVideoFilename(name) {
    const lower = name.toLowerCase();
    return CONFIG.VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  function queuePath(item) {
    return (item.relativePath || item.filename || '').replace(/\\/g, '/');
  }

  function queueIdentity(item) {
    return `${queuePath(item).toLowerCase()}|${item.size || 0}|${item.lastModified || 0}`;
  }

  async function scanDirectory(handle, prefix = '') {
    const results = [];
    for await (const [name, entry] of handle.entries()) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === 'directory') {
        results.push(...await scanDirectory(entry, relativePath));
      } else if (entry.kind === 'file' && isVideoFilename(name)) {
        const file = await entry.getFile();
        results.push({
          filename: name,
          relativePath,
          productId: productIdFromFilename(name),
          size: file.size,
          lastModified: file.lastModified,
        });
      }
    }
    return results;
  }

  async function getFileFromDirectory(handle, relativePath) {
    const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length) throw new Error('队列中的视频路径为空');
    let folder = handle;
    for (const part of parts.slice(0, -1)) {
      folder = await folder.getDirectoryHandle(part);
    }
    const fileHandle = await folder.getFileHandle(parts.at(-1));
    return fileHandle.getFile();
  }

  // ========================= 自动化步骤 =========================

  async function setVideoFile(inputFileEl, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    inputFileEl.files = dt.files;
    inputFileEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function checkForAppCrash() {
    const text = document.body.innerText || '';
    if (text.includes('Ada masalah') && text.includes('Coba lagi')) {
      throw new Error('TikTok页面自己崩溃报错了(Ada masalah/Coba lagi)，脚本停止，需要人工刷新页面重试');
    }
  }

  function getCaptionEditable() {
    // TikTok在页面切换/上传初始化时可能短暂保留旧的隐藏编辑器。
    // 只取当前可见且面积最大的文案框，避免清空了旧节点、真正的文案框却没动。
    return Array.from(document.querySelectorAll('.caption-editor [contenteditable="true"]'))
      .filter(isVisible)
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return bRect.width * bRect.height - aRect.width * aRect.height;
      })[0] || null;
  }

  function getCaptionText(editable) {
    if (!editable) return '';
    return (editable.innerText || editable.textContent || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim();
  }

  function selectEditableContents(editable) {
    const selection = window.getSelection();
    if (!selection) throw new Error('浏览器无法取得文案框选区');
    const range = document.createRange();
    range.selectNodeContents(editable);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function waitForCaptionEmpty(timeout = 1500) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      checkForAppCrash();
      const editable = getCaptionEditable();
      if (editable && !getCaptionText(editable)) return editable;
      await sleep(100);
    }
    return null;
  }

  async function clearCaptionSafely() {
    // 不能使用 execCommand('delete') 或直接改 innerHTML/textContent：
    // 那会绕过 Draft.js 状态，已确认会触发 removeChild NotFoundError 并让整页崩溃。
    // 页面脚本构造的 KeyboardEvent.isTrusted=false，Draft.js不会执行浏览器默认的删除动作。
    // 经现场验证：全选后用浏览器的 insertText 命令替换成一个普通空格，Draft.js会同步
    // 自己的 EditorState；后续点击历史标签可连续插入，页面不会崩溃。getCaptionText会忽略空白。
    // 某些指纹浏览器里，Draft.js会在第一次替换后延迟重绘旧标题；最多重试3次，
    // 且每次都等待空白稳定1.5秒，不能只看某一瞬间DOM为空。
    for (let attempt = 1; attempt <= 3; attempt++) {
      let editable = await waitFor(getCaptionEditable);
      const before = getCaptionText(editable);
      if (before) {
        editable.focus();
        selectEditableContents(editable);
        document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
        editable.dispatchEvent(new Event('select', { bubbles: true }));
        await sleep(250);

        const selection = window.getSelection();
        if (!selection || !selection.toString()) {
          throw new Error('自动清空失败：Draft.js文案没有被全选，已停止以避免误发布');
        }

        const replaced = document.execCommand('insertText', false, ' ');
        if (!replaced) {
          throw new Error('浏览器没有执行安全文案替换，已停止以避免带错误文案发布');
        }
      }

      editable = await waitForCaptionEmpty(1800);
      if (editable) {
        editable.blur();
        await sleep(1500);
        const current = getCaptionEditable();
        if (current && !getCaptionText(current)) {
          log(`已通过Draft.js安全替换清空默认文案（第${attempt}次）`);
          return current;
        }
      }

      log(`⚠️ 默认标题在清空后又被页面恢复，正在重试（${attempt}/3）`);
      await sleep(400);
    }

    throw new Error('Draft.js没有稳定清空默认标题，已停止，绝不会带商品ID/文件名发布');
  }

  function captionContainsHashtag(text, keyword) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9_])#\\s*${escaped}(?=$|[^a-z0-9_])`, 'i').test(text);
  }

  function captionUnexpectedRemainder(text) {
    let remainder = text;
    for (const keyword of CONFIG.HASHTAG_KEYWORDS) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      remainder = remainder.replace(new RegExp(`#\\s*${escaped}(?=$|[^a-z0-9_])`, 'gi'), ' ');
    }
    return remainder.replace(/[\s#]+/g, '').trim();
  }

  function assertCaptionSafe(stage, requireAllHashtags = true) {
    const editable = getCaptionEditable();
    const text = getCaptionText(editable);
    if (!editable || !text) {
      throw new Error(`${stage}：文案框为空或不可见，已停止以避免误发布`);
    }

    const remainder = captionUnexpectedRemainder(text);
    if (remainder) {
      throw new Error(`${stage}：发现未清除的默认标题“${text.slice(0, 120)}”，已停止，绝不会发布`);
    }

    if (requireAllHashtags) {
      const missing = CONFIG.HASHTAG_KEYWORDS.filter((keyword) => !captionContainsHashtag(text, keyword));
      if (missing.length) {
        throw new Error(`${stage}：缺少话题标签 ${missing.map((item) => '#' + item).join(' ')}，已停止以避免误发布`);
      }
    }
    return text;
  }

  async function waitForCaptionHashtag(keyword, timeout = 2000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      checkForAppCrash();
      const editable = getCaptionEditable();
      if (editable && captionContainsHashtag(getCaptionText(editable), keyword)) return true;
      await sleep(100);
    }
    return false;
  }

  async function waitForUploadComplete(filename) {
    const expectedDefaultCaption = filename.replace(/\.[^.]+$/, '').trim();
    const productId = productIdFromFilename(filename);
    let stableText = '';
    let stableSince = 0;
    log('等待视频上传并等待TikTok填入默认标题…');
    await waitFor(() => {
      const text = document.body.innerText || '';
      const editable = getCaptionEditable();
      const caption = getCaptionText(editable);

      // 明确的上传完成标志：出现 "Diunggah" / "Uploaded" / "Selesai"
      const isExplicitDone = /Diunggah\s*\(|Uploaded\s*\(|Selesai/i.test(text);

      // 只有在明确出现上传倒计时或上传百分比时，才判定为“正在上传中”
      // 注意：严禁全文正则匹配模糊的 "Mengunggah"，因为页面下方的封面生成区/按钮也带有 "Mengunggah... / Edit sampul" 会导致误判永远在上传中并卡死3分钟
      const isUploading = /Tersisa\s*\d+\s*(?:detik|menit|s|m)|(?:Uploading|Mengunggah)\s*\(\d+%\)/i.test(text);

      const hasVideoPreview = Boolean(
        document.querySelector('video') ||
        document.querySelector('[data-e2e="video_preview"]') ||
        document.querySelector('.preview-container') ||
        document.querySelector('.player-container')
      );

      const isExpectedDefault = caption && (
        caption.includes(expectedDefaultCaption) ||
        caption.includes(productId)
      );

      // 如果仍在上传倒计时且没有完成标志，继续等待
      if (isUploading && !isExplicitDone) {
        stableText = '';
        stableSince = 0;
        return null;
      }

      // 需要文案框可见且标题或视频预览已就绪
      if (!editable || (!isExpectedDefault && !hasVideoPreview && !isExplicitDone)) {
        stableText = '';
        stableSince = 0;
        return null;
      }

      if (caption !== stableText) {
        stableText = caption;
        stableSince = Date.now();
        return null;
      }

      return Date.now() - stableSince >= 1000 ? editable : null;
    }, 3 * 60 * 1000, 200);
    log(`视频和默认标题均已就绪 ✅（待清空：${stableText.slice(0, 80)}）`);
  }

  async function fillCaption() {
    // 文案框是React控制的contenteditable；必须让编辑器自己同步清空，不能直接改DOM。
    await clearCaptionSafely();

    // 历史话题标签用 .suggest-item 精确定位（比模糊文字匹配更稳）
    const targets = CONFIG.HASHTAG_KEYWORDS; // 例如 ['fyp', 'tiktok', 'tiktokshop']
    let allFound = true;
    for (const keyword of targets) {
      // 点完一个标签，历史标签面板经常会自动收起，重新聚焦一下让它再出现
      const editable = await waitFor(getCaptionEditable);
      editable.focus();
      await sleep(300);
      checkForAppCrash();

      const chip = Array.from(document.querySelectorAll('.suggest-item')).find((el) =>
        isVisible(el) && el.textContent.replace(/\s/g, '').toLowerCase() === ('#' + keyword).toLowerCase()
      );
      if (chip) {
        fireClick(chip);
        const inserted = await waitForCaptionHashtag(keyword);
        if (inserted) {
          // 每点一次标签就检查一次；如果Draft.js把旧文件名恢复出来，立即停在发布前。
          assertCaptionSafe(`添加 #${keyword} 后检查`, false);
          log(`已添加并确认历史话题: #${keyword}`);
        } else {
          allFound = false;
          log(`⚠️ 已点击 #${keyword}，但文案框里没有确认到该标签，需要人工检查`);
        }
      } else {
        allFound = false;
        log(`⚠️ 没找到历史话题 #${keyword}，可能是这个账号还没用过这个标签，或者面板没弹出来`);
      }
    }
    if (!allFound) {
      throw new Error('部分历史话题标签没有成功加入，已自动暂停，避免带错误文案发布');
    }

    // 失焦后再等一次Draft.js落盘，防止它延迟恢复旧标题。
    const editable = getCaptionEditable();
    if (editable) editable.blur();
    await sleep(1200);
    const finalCaption = assertCaptionSafe('文案填写完成终检');
    log(`文案终检通过 ✅：${finalCaption}`);
  }

  async function addProductLink(productId) {
    log('开始添加商品链接: ' + productId);
    // "+ Tambah" 按钮：文字精确是"Tambah"（不是"Tambah tautan"标题，也不是"Tambah tautan produk"）
    const addBtn = await waitFor(() => findClickableByText('Tambah', true), 20000);
    fireClick(addBtn);

    // "Jenis tautan" 默认就是"Produk"，不用手动选；但下一步按钮必须限制在当前弹窗内。
    const nextBtn1 = await waitFor(() => {
      const globalBtn = findClickableByText(CONFIG.TEXT.NEXT_BTN, true);
      if (!globalBtn) return null;
      const dialog = getModalRoot(globalBtn);
      return findActionByTextsWithin(dialog, [CONFIG.TEXT.NEXT_BTN]);
    });
    fireClick(nextBtn1);

    // 搜索商品：输入ID后要点放大镜图标触发搜索，不是打字就自动搜
    await sleep(500);
    const searchInput = await waitFor(() =>
      Array.from(document.querySelectorAll('input')).find((input) =>
        isVisible(input) &&
        (input.getAttribute('placeholder') || '').includes(CONFIG.TEXT.SEARCH_PRODUCT_PLACEHOLDER)
      )
    );
    const productDialog = getModalRoot(searchInput);
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(searchInput, productId);
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));

    const searchIcon = await waitFor(() =>
      productDialog.querySelector('.product-search-icon') || searchInput.parentElement.querySelector('svg')?.closest('div')
    );
    fireClick(searchIcon);

    // 等结果出来，按商品ID"精确相等"匹配某个单元格（不是子串包含），避免"12345"误撞"123456"
    const findProductRow = () => {
      const rows = Array.from(productDialog.querySelectorAll('tr, [role="row"]')).filter(isVisible);
      return rows.find((r) => {
        const leafCells = Array.from(r.querySelectorAll('*')).filter((el) => el.children.length === 0);
        return leafCells.some((cell) => (cell.textContent || '').trim() === productId.trim());
      });
    };
    let row = await waitFor(findProductRow, 10000);
    let radio = row.querySelector('input[type="radio"].TUXRadioStandalone-input') || row.querySelector('input[type="radio"]');
    if (!radio) throw new Error('找到了商品行但没找到单选框，需要人工检查页面结构');

    const isSelected = () => {
      row = findProductRow();
      if (!row) return false;
      radio = row.querySelector('input[type="radio"].TUXRadioStandalone-input') || row.querySelector('input[type="radio"]');
      if (!radio) return false;
      return radio.checked ||
        radio.getAttribute('aria-checked') === 'true' ||
        row.getAttribute('aria-selected') === 'true' ||
        Boolean(radio.closest('[aria-checked="true"], [data-state="checked"]'));
    };

    const explicitLabel = radio.id
      ? Array.from(productDialog.querySelectorAll('label')).find((label) => label.htmlFor === radio.id)
      : null;
    const radioClickTarget =
      explicitLabel || radio.closest('label') || radio.closest('[role="radio"]') || radio.parentElement || radio;
    fireClick(radioClickTarget);

    let selectionConfirmed = await waitForOrNull(() => isSelected() || null, 3000, 100);
    if (!selectionConfirmed && radioClickTarget !== radio) {
      log('商品单选框第一次点击未生效，尝试点击radio本体');
      fireClick(radio);
      selectionConfirmed = await waitForOrNull(() => isSelected() || null, 3000, 100);
    }
    if (!selectionConfirmed) {
      throw new Error(`商品 ${productId} 已搜到，但单选框没有真正选中，已停止后续发布`);
    }
    log('商品已选中，等待最终确认按钮可用');

    // TikTok在“选商品”后会销毁列表弹窗，再创建一个同级的“编辑展示名”弹窗。
    // 不能一直使用上面的productDialog旧引用；每一步都必须重新定位当前最上层商品弹窗。
    let dialogClosed = false;
    for (let step = 1; step <= 4; step++) {
      const activeModal = await waitFor(getTopProductWorkflowModal, 10000, 150);
      const actionBtn = await waitFor(() =>
        findActionByTextsWithin(activeModal, CONFIG.TEXT.PRODUCT_CONFIRM_BUTTONS)
      , 10000, 150);
      const actionRoot = getModalRoot(actionBtn);
      const actionText = (actionBtn.textContent || '').trim();
      log(`点击商品弹窗操作按钮(${step}/4): ${actionText}`);
      fireClick(actionBtn);

      const outcome = await waitForOrNull(() => {
        if (!hasOpenProductWorkflowModal() && hasAttachedProduct()) return 'closed';

        const rootClosed = actionRoot !== document.body &&
          (!actionRoot.isConnected || !isVisible(actionRoot));
        const actionReplaced = !actionBtn.isConnected || !isVisible(actionBtn);
        const nextModal = getTopProductWorkflowModal();
        if ((rootClosed || actionReplaced) && nextModal) return 'advanced';
        if (nextModal && nextModal !== actionRoot) return 'advanced';
        return null;
      }, 8000, 150);

      if (outcome === 'closed') {
        dialogClosed = true;
        break;
      }
      if (outcome !== 'advanced') {
        throw new Error(`商品弹窗按钮“${actionText}”点击后页面没有变化，已停止后续发布`);
      }
      log('商品弹窗已进入下一步，继续查找最终确认按钮');
      await sleep(400);
    }

    // 只有商品弹窗全部关闭且页面出现商品锚点才算挂车完成；否则严禁继续AI声明和发布。
    if (!dialogClosed) {
      dialogClosed = Boolean(await waitForOrNull(() => {
        return !hasOpenProductWorkflowModal() && hasAttachedProduct();
      }, 5000, 150));
    }
    if (!dialogClosed) {
      throw new Error('商品弹窗经过最多4步仍未关闭，或页面没有出现商品锚点；挂车未确认，已停止后续发布');
    }
    log('商品链接添加完成: ' + productId);
  }

  async function setPublishNow() {
    assertProductPickerClosed('设置立即发布');
    const radio = await waitFor(() => findClickableByText(CONFIG.TEXT.NOW_RADIO_LABEL));
    // 默认就是选中"Sekarang"，这里再点一下确保万无一失
    fireClick(radio);
    await sleep(300);
    const input = radio.closest('div')?.querySelector('input[type="radio"]');
    if (input && !input.checked) {
      log('⚠️ "Sekarang"看起来没有被选中，尝试直接点击radio本体');
      fireClick(input);
    }
  }

  async function setAiDisclosure() {
    assertProductPickerClosed('设置AI声明');

    // 检查AI声明开关是否已经在界面上可见（避免重复点击导致折叠收起）
    const findAiLabel = () =>
      findByText('span', 'Konten yang dihasilkan AI') || findByText('div', 'Konten yang dihasilkan AI');

    let label = findAiLabel();
    if (!label || !isVisible(label)) {
      const expandTrigger = await waitForOrNull(() =>
        document.querySelector('[data-e2e="advanced_settings_container"] .more-btn') ||
        findClickableByText('Tampilkan lebih banyak', false) ||
        findClickableByText('Tampilkan lainnya', false)
      , 5000);
      if (expandTrigger) {
        fireClick(expandTrigger);
        await sleep(500);
      }
    }

    // 用label文字定位到"Konten yang dihasilkan AI"这一行，再找它旁边的开关本体(data-part="thumb")
    const toggleThumb = await waitFor(() => {
      const currentLabel = findAiLabel();
      if (!currentLabel) return null;
      const row = currentLabel.closest('div');
      return row ? row.querySelector('[data-part="thumb"]') : null;
    }, 10000);

    if (toggleThumb.getAttribute('data-state') === 'checked') {
      log('AI声明开关已经是打开状态，跳过');
    } else {
      const clickTarget = toggleThumb.closest('[role="switch"]') || toggleThumb.closest('button') || toggleThumb.parentElement;
      fireClick(clickTarget);
      log('AI声明开关已打开');
    }
  }

  function isEnabled(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (window.getComputedStyle(el).pointerEvents === 'none') return false;
    return true;
  }

  function getPostButton() {
    return document.querySelector('[data-e2e="post_video_button"]') ||
      findClickableByText('Posting', true) ||
      findClickableByText('Post', true);
  }

  async function waitForChecksPass() {
    log('等待"Pemeriksaan"版权/内容检测完成或发布按钮就绪…');
    const start = Date.now();
    const maxWaitMs = 30000; // 最多等30秒，不因未出现特定文字而卡死3分钟

    while (Date.now() - start < maxWaitMs) {
      checkForAppCrash();
      const text = document.body.innerText || '';

      // 1. 如果有明确的版权违规或拦截性报错，主动中断
      if (text.includes('Masalah hak cipta ditemukan') || text.includes('Pelanggaran terdeteksi') || text.includes('Video tidak dapat diposting')) {
        throw new Error('检测到版权或内容严重违规，已自动暂停');
      }

      // 2. 检查是否有明确的检测通过提示
      const explicitPassed = text.includes('Tidak ada masalah yang ditemukan') ||
        text.includes('Tidak ditemukan masalah') ||
        text.includes('Pemeriksaan selesai');

      // 3. 检查发布按钮是否已处于可用状态
      const postBtn = getPostButton();
      const isPostReady = postBtn && isEnabled(postBtn);

      // 4. 检查是否仍在“正在检测”中
      const isChecking = /Sedang memeriksa|Memeriksa hak cipta|Checking|Sedang memverifikasi/i.test(text);

      if (explicitPassed || (isPostReady && !isChecking)) {
        log('检测通过或发布按钮已就绪 ✅');
        return true;
      }

      await sleep(1000);
    }

    log('检测等待结束，未发现拦截性报错，继续进入发布流程…');
  }

  async function finalSubmit(idx) {
    assertProductPickerClosed('点击Posting');
    await waitForChecksPass();
    assertCaptionSafe('内容检测完成后的文案终检');
    log('等待Posting按钮变亮…');
    const submitBtn = await waitFor(() => {
      const btn = getPostButton();
      return btn && isEnabled(btn) ? btn : null;
    }, 60 * 1000, 1000);
    await sleep(500); // 保险起见再等一下，避免刚变亮就点导致状态还没稳定
    assertCaptionSafe('点击Posting前最后检查');

    // 点击前先把这一条记成"待确认"，而不是点完就直接标记完成——
    // 因为点了发布之后页面很可能立即跳转，脚本上下文可能来不及执行后续代码，
    // 所以必须在点击前就把状态存下来，靠后面跳转到content页面时再"转正"成已完成
    const state = getState();
    if (state) {
      state.pendingIndex = idx;
      state.pendingSince = Date.now();
      setState(state);
    }
    fireClick(submitBtn);
    log('已点击最终发布按钮，等待跳转确认成功…');

    // 看门狗：如果点完45秒还停在上传页，结果已经不确定。暂停而不是自动重试，避免重复发布。
    setTimeout(() => {
      if (!location.pathname.includes('/tiktokstudio/upload')) return; // 已经跳走了，正常
      const s = getState();
      if (s && s.pendingIndex === idx) {
        s.pendingIndex = null;
        s.pendingSince = null;
        s.autoPaused = true;
        s.pauseReason = '点击发布后45秒仍未跳转，发布结果不确定；请检查后再恢复自动发布';
        s.pauseCode = 'uncertain_publish';
        setState(s);
        log('⚠️ ' + s.pauseReason);
        refreshUI();
      }
    }, 45000);
  }

  async function processOne(file, idx) {
    checkIfPaused();
    const productId = productIdFromFilename(file.name);
    log(`开始处理: ${file.name} -> 商品ID ${productId}`);
    const fileInput = await waitFor(() => document.querySelector('input[type="file"][accept="video/*"]'));
    await setVideoFile(fileInput, file);

    checkIfPaused();
    await humanDelay(1500, 3000);
    await waitForUploadComplete(file.name);

    checkIfPaused();
    await humanDelay();
    await fillCaption();

    checkIfPaused();
    await humanDelay();
    await addProductLink(productId);

    checkIfPaused();
    await humanDelay();
    await setAiDisclosure();

    checkIfPaused();
    await humanDelay();
    await setPublishNow();

    checkIfPaused();
    await humanDelay();
    await finalSubmit(idx);
    log(`已点击发布，等待页面确认: ${file.name}`);
  }

  // ========================= 面板 UI =========================

  let currentFiles = []; // 仅作为不支持持久文件夹权限时的兼容降级
  let directoryHandle = null;
  let automationInitialized = false;
  let initializationStarted = false;
  let isProcessing = false;
  let tickInProgress = false;
  let folderSyncInProgress = false;
  let lastFolderScanAt = 0;
  let uiTimer = null;

  function buildPanel() {
    if (document.getElementById('tkq-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'tkq-panel';
    panel.style = 'position:fixed;right:12px;top:80px;width:300px;background:#fff;border:1px solid #ddd;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.15);z-index:999998;font-size:13px;font-family:sans-serif;';
    panel.innerHTML = `
      <div style="background:#ff2b56;color:#fff;padding:8px 12px;border-radius:10px 10px 0 0;font-weight:bold;">批量发布助手</div>
      <div style="padding:10px;">
        <input type="file" id="tkq-folder" webkitdirectory multiple style="display:none;">
        <button id="tkq-choose-folder-btn" style="width:100%;padding:6px;background:#333;color:#fff;border:none;border-radius:6px;cursor:pointer;margin-bottom:5px;">选择并授权自动发布文件夹</button>
        <div id="tkq-folder-status" style="margin-bottom:7px;color:#777;font-size:12px;">正在恢复文件夹权限…</div>
        <button id="tkq-scan-btn" style="width:100%;padding:5px;background:#fff;color:#333;border:1px solid #bbb;border-radius:6px;cursor:pointer;margin-bottom:8px;">立即扫描新增视频</button>
        <div id="tkq-queue" style="margin-bottom:8px;max-height:190px;overflow:auto;"></div>
        <button id="tkq-action-btn" style="width:100%;padding:6px;background:#ff2b56;color:#fff;border:none;border-radius:6px;cursor:pointer;">暂停自动发布</button>
        <div id="tkq-review-actions" style="display:none;gap:6px;margin-top:6px;">
          <button id="tkq-mark-published-btn" style="flex:1;padding:6px;background:#07883d;color:#fff;border:none;border-radius:6px;cursor:pointer;">上次已发布，跳过</button>
          <button id="tkq-retry-btn" style="flex:1;padding:6px;background:#ff2b56;color:#fff;border:none;border-radius:6px;cursor:pointer;">上次未发布，重试</button>
        </div>
        <div id="tkq-countdown" style="margin-top:8px;color:#666;"></div>
        <div id="tkq-log" style="margin-top:8px;max-height:150px;overflow:auto;background:#f7f7f7;padding:6px;border-radius:6px;"></div>
      </div>
    `;
    document.body.appendChild(panel);

    document.getElementById('tkq-choose-folder-btn').addEventListener('click', chooseAutomationFolder);
    document.getElementById('tkq-folder').addEventListener('change', onFolderSelected);
    document.getElementById('tkq-scan-btn').addEventListener('click', scanNow);
    document.getElementById('tkq-action-btn').addEventListener('click', toggleAutomation);
    document.getElementById('tkq-mark-published-btn').addEventListener('click', () => resolveUncertainPublish(true));
    document.getElementById('tkq-retry-btn').addEventListener('click', () => resolveUncertainPublish(false));
    // TikTok是SPA，偶尔会在内部路由切换时重绘页面并删掉外部节点。
    // 全局只保留一个看门狗；面板被删后1秒内重建，不重复创建调度定时器。
    if (!uiTimer) {
      uiTimer = setInterval(() => {
        if (!document.getElementById('tkq-panel')) {
          buildPanel();
        }
        refreshUI();
        void handleRouteState();
        void automationTick();
      }, 1000);
    }
    refreshUI();
    if (!initializationStarted) {
      initializationStarted = true;
      void initializeAutomation();
    } else if (directoryHandle) {
      setFolderStatus(`已授权：${directoryHandle.name}（每30秒自动扫描）`, true);
    } else if (automationInitialized) {
      setFolderStatus('尚未授权文件夹，请点击顶部按钮选择一次');
    }
  }

  function setFolderStatus(text, ok = false) {
    const el = document.getElementById('tkq-folder-status');
    if (!el) return;
    el.textContent = text;
    el.style.color = ok ? '#07883d' : '#777';
  }

  function syncFilesIntoQueue(fileRecords) {
    const records = [...fileRecords].sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true })
    );
    let state = getState();
    if (!state) {
      state = {
        items: records,
        doneIndex: -1,
        pendingIndex: null,
        nextTime: Date.now(),
        autoPaused: false,
        pauseReason: '',
        pauseCode: '',
        returnToUploadPending: false,
      };
      setState(state);
      return { added: records.length, removed: 0, total: records.length, resumed: false };
    }

    // 最终发布刚点下去时，pendingIndex 还在等 content 页确认。
    // 这个几秒的窗口内暂不改队列下标，确认完成后下一次扫描会立即镜像文件夹。
    if (Number.isInteger(state.pendingIndex)) {
      return { added: 0, removed: 0, total: state.items.length, resumed: false, deferred: true };
    }

    // 兼容0.2.x旧队列：首次扫描时给只有filename的项目补上路径和文件信息。
    for (const item of state.items) {
      if (item.relativePath) continue;
      const matches = records.filter((record) => record.filename === item.filename);
      if (matches.length === 1) Object.assign(item, matches[0]);
    }

    const previousItems = state.items;
    const previousDoneIndex = Math.min(state.doneIndex, previousItems.length - 1);
    const currentByIdentity = new Map(records.map((record) => [queueIdentity(record), record]));
    const retainedItems = [];
    const retainedIdentities = new Set();
    let retainedCompletedCount = 0;

    // 已有项保持原队列顺序，但文件夹里已不存在的项会被真正删除。
    // 这样即使删除的是已发布视频，doneIndex 也会跟着正确前移。
    previousItems.forEach((item, oldIndex) => {
      const identity = queueIdentity(item);
      const currentRecord = currentByIdentity.get(identity);
      if (!currentRecord) return;
      retainedItems.push(currentRecord);
      retainedIdentities.add(identity);
      if (oldIndex <= previousDoneIndex) retainedCompletedCount += 1;
    });

    const additions = records.filter((record) => !retainedIdentities.has(queueIdentity(record)));
    const removed = previousItems.length - retainedItems.length;
    state.items = [...retainedItems, ...additions];
    state.doneIndex = retainedCompletedCount - 1;

    // 如果之前正是因为队列里留着一个已被删除的文件而暂停，
    // 镜像同步删掉旧记录后直接恢复，不再要求用户手动点“继续”。
    const wasMissingFilePause = state.autoPaused && (
      state.pauseCode === 'missing_queue_file' ||
      (state.pauseCode === 'runtime' && state.pauseReason.includes('找不到队列视频'))
    );
    const resumed = wasMissingFilePause && removed > 0;
    if (resumed) {
      state.autoPaused = false;
      state.pauseReason = '';
      state.pauseCode = '';
      state.nextTime = Math.min(state.nextTime, Date.now());
    }

    setState(state);
    return { added: additions.length, removed, total: state.items.length, resumed };
  }

  async function syncFolderQueue(announceNoChanges = false) {
    if (!directoryHandle || folderSyncInProgress || isProcessing) return;
    folderSyncInProgress = true;
    try {
      if (!await hasDirectoryPermission(directoryHandle, false)) {
        throw new Error('文件夹读取权限已失效，请点击“选择并授权自动发布文件夹”恢复');
      }
      const records = await scanDirectory(directoryHandle);
      const result = syncFilesIntoQueue(records);
      lastFolderScanAt = Date.now();
      setFolderStatus(`已授权：${directoryHandle.name}（每30秒自动扫描）`, true);
      if (result.deferred) {
        if (announceNoChanges) log('本条正在等待发布结果确认，确认后再同步文件夹');
      } else if (result.added > 0 || result.removed > 0) {
        log(`文件夹同步完成：新增 ${result.added} 个，移除 ${result.removed} 个，队列共 ${result.total} 个`);
        if (result.resumed) log('▶️ 已移除缺失文件的旧记录，自动发布已恢复');
      } else if (announceNoChanges) {
        log(`扫描完成，文件夹和队列已一致（共 ${result.total} 个）`);
      }
      refreshUI();
    } finally {
      folderSyncInProgress = false;
    }
  }

  async function initializeAutomation() {
    try {
      const existingState = getState();
      // content 页就是 TikTok 发布成功后的落地页。即使上次记录已超时，
      // 只要此刻已在 content 页，也应交给路由处理器确认成功，不能先判成未知。
      if (existingState && Number.isInteger(existingState.pendingIndex) && !isContentPage()) {
        const pendingIsStale = !Number.isFinite(existingState.pendingSince) ||
          Date.now() - existingState.pendingSince > 2 * 60 * 1000;
        if (pendingIsStale) {
          existingState.pendingIndex = null;
          existingState.pendingSince = null;
          existingState.autoPaused = true;
          existingState.pauseReason = '发现上次遗留的未确认发布记录；请先检查TikTok内容列表，再点击继续自动发布';
          existingState.pauseCode = 'uncertain_publish';
          setState(existingState);
          log('⚠️ ' + existingState.pauseReason);
        }
      }

      const restored = await loadDirectoryHandle();
      if (restored && await hasDirectoryPermission(restored, false)) {
        directoryHandle = restored;
        setFolderStatus(`已恢复：${restored.name}（无需重新选择）`, true);
        await syncFolderQueue(false);
      } else if (restored) {
        setFolderStatus('已记住文件夹，但浏览器要求重新授权一次');
        log('⚠️ 文件夹权限需要恢复，请点击顶部文件夹按钮一次');
      } else {
        setFolderStatus('首次使用，请选择一次自动发布文件夹');
      }
    } catch (err) {
      setFolderStatus('恢复文件夹失败，请重新选择');
      log('⚠️ 恢复文件夹失败: ' + err.message);
    } finally {
      automationInitialized = true;
      refreshUI();
      void automationTick();
    }
  }

  async function chooseAutomationFolder() {
    try {
      if (typeof window.showDirectoryPicker !== 'function') {
        log('⚠️ 当前浏览器不支持持久文件夹权限，只能使用兼容选择器，页面跳转后仍会失效');
        document.getElementById('tkq-folder').click();
        return;
      }
      const handle = await window.showDirectoryPicker({ id: 'tkq-auto-upload', mode: 'read' });
      if (!await hasDirectoryPermission(handle, true)) {
        throw new Error('没有取得文件夹读取权限');
      }
      await saveDirectoryHandle(handle);
      directoryHandle = handle;
      automationInitialized = true;
      lastFolderScanAt = 0;

      const state = getState();
      if (state && state.pauseCode !== 'uncertain_publish') {
        state.autoPaused = false;
        state.pauseReason = '';
        state.pauseCode = '';
        setState(state);
      }
      setFolderStatus(`已授权：${handle.name}`, true);
      log(`文件夹已持久授权：${handle.name}；以后页面跳转会自动恢复`);
      await syncFolderQueue(true);
      await automationTick();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        log('已取消选择文件夹，现有队列没有变化');
        return;
      }
      log('❌ 选择文件夹失败: ' + err.message);
      setFolderStatus('文件夹授权失败，请重试');
    }
  }

  async function onFolderSelected(e) {
    const files = Array.from(e.target.files).filter(isVideoFile);
    currentFiles = files;
    const records = files.map((file) => ({
      filename: file.name,
      relativePath: file.webkitRelativePath || file.name,
      productId: productIdFromFilename(file.name),
      size: file.size,
      lastModified: file.lastModified,
    }));
    const result = syncFilesIntoQueue(records);
    automationInitialized = true;
    log(`兼容模式已按文件夹同步：新增 ${result.added} 个，移除 ${result.removed} 个；此模式不能跨页面自动恢复`);
    refreshUI();
    await automationTick();
  }

  async function scanNow() {
    if (!directoryHandle) {
      await chooseAutomationFolder();
      return;
    }
    try {
      await syncFolderQueue(true);
      await automationTick();
    } catch (err) {
      pauseAutomation(err.message);
    }
  }

  function pauseAutomation(reason, code = 'runtime') {
    const state = getState();
    if (state) {
      state.autoPaused = true;
      state.pauseReason = reason || '自动发布已暂停';
      state.pauseCode = code;
      setState(state);
    }
    log('⏸ ' + (reason || '自动发布已暂停'));
    refreshUI();
  }

  async function toggleAutomation() {
    const state = getState();
    if (!state) {
      await chooseAutomationFolder();
      return;
    }
    if (!state.autoPaused) {
      state.autoPaused = true;
      state.pauseReason = '用户手动暂停';
      state.pauseCode = 'user';
      setState(state);
      log('⏸ 已手动暂停，正在立即中断当前动作…');
      refreshUI();
      return;
    }

    if (directoryHandle && !await hasDirectoryPermission(directoryHandle, true)) {
      log('⚠️ 无法恢复文件夹权限，请重新选择文件夹');
      return;
    }
    state.autoPaused = false;
    state.pauseReason = '';
    state.pauseCode = '';
    setState(state);
    log('▶️ 已恢复全自动发布');
    refreshUI();
    await automationTick();
  }

  async function resolveUncertainPublish(wasPublished) {
    let state = getState();
    if (!state || state.pauseCode !== 'uncertain_publish') return;

    if (wasPublished) {
      const uncertainIndex = state.doneIndex + 1;
      if (uncertainIndex < state.items.length) state.doneIndex = uncertainIndex;
      state.nextTime = Date.now() + randomInterval();
      log('✅ 已按“上次实际发布成功”处理，将从下一条继续');
    } else {
      if (!directoryHandle || !await hasDirectoryPermission(directoryHandle, false)) {
        await chooseAutomationFolder();
        state = getState();
        if (!directoryHandle || !state) return;
      }
      state.nextTime = Date.now();
      log('↻ 已按“上次没有发布”处理，将自动重试当前视频');
    }

    state.autoPaused = false;
    state.pauseReason = '';
    state.pauseCode = '';
    state.pendingIndex = null;
    state.pendingSince = null;
    setState(state);
    refreshUI();
    await automationTick();
  }

  function refreshUI() {
    const state = getState();
    const queueEl = document.getElementById('tkq-queue');
    const countdownEl = document.getElementById('tkq-countdown');
    const actionBtn = document.getElementById('tkq-action-btn');
    const scanBtn = document.getElementById('tkq-scan-btn');
    const reviewActions = document.getElementById('tkq-review-actions');
    if (!queueEl) return;

    if (scanBtn) scanBtn.disabled = folderSyncInProgress || isProcessing;
    if (reviewActions) reviewActions.style.display = 'none';

    if (!state) {
      queueEl.innerHTML = '<div style="color:#999;">还没有视频队列</div>';
      countdownEl.textContent = automationInitialized ? '请选择一次文件夹，随后会全自动运行' : '正在初始化…';
      actionBtn.textContent = '等待文件夹授权';
      actionBtn.style.display = 'block';
      actionBtn.disabled = true;
      actionBtn.style.background = '#ff2b56';
      return;
    }

    queueEl.innerHTML = state.items.length
      ? state.items
        .map((it, idx) => {
          let status = '⬜';
          if (idx <= state.doneIndex) status = '✅';
          else if (state.pendingIndex === idx) status = '🕓待确认';
          else if (idx === state.doneIndex + 1) status = '⏳';
          return `<div>${status} ${escapeHtml(queuePath(it))}</div>`;
        })
        .join('')
      : '<div style="color:#999;">文件夹里没有可发布的视频</div>';

    actionBtn.style.display = 'block';
    actionBtn.disabled = false;
    if (state.autoPaused) {
      actionBtn.textContent = '继续自动发布';
      actionBtn.style.background = '#07883d';
    } else {
      actionBtn.textContent = isProcessing ? '暂停当前发布' : '暂停自动发布';
      actionBtn.style.background = '#ff2b56';
    }

    if (state.autoPaused) {
      countdownEl.textContent = `⏸ 已暂停：${state.pauseReason || '等待恢复'}`;
      if (state.pauseCode === 'uncertain_publish') {
        actionBtn.style.display = 'none';
        if (reviewActions) reviewActions.style.display = 'flex';
      }
      return;
    }

    if (!isUploadPage()) {
      countdownEl.textContent = state.returnToUploadPending
        ? '发布已确认，正在点击左侧“上传”返回上传页…'
        : '当前在内容管理页；手动打开的内容页不会被强制跳转';
      return;
    }

    const nextIdx = state.doneIndex + 1;
    if (nextIdx >= state.items.length) {
      countdownEl.textContent = '队列已完成；正在自动扫描文件夹里的新增视频';
      return;
    }

    if (isProcessing) {
      countdownEl.textContent = '正在全自动处理，请勿刷新/关闭页面…';
      return;
    }

    if (state.pendingIndex === nextIdx) {
      countdownEl.textContent = `第 ${nextIdx + 1} 条已点发布，等待跳转确认成功…`;
      return;
    }

    const remain = state.nextTime - Date.now();
    if (remain > 0) {
      const h = Math.floor(remain / 3600000);
      const m = Math.floor((remain % 3600000) / 60000);
      const s = Math.floor((remain % 60000) / 1000);
      countdownEl.textContent = `全自动等待：下一条还要 ${h}小时${m}分${s}秒`;
    } else {
      countdownEl.textContent = `已到时间，正在自动启动第 ${nextIdx + 1} 条…`;
    }
  }

  async function resolveQueueFile(item) {
    if (directoryHandle) {
      if (!await hasDirectoryPermission(directoryHandle, false)) {
        throw new Error('文件夹权限已失效，请重新授权');
      }
      try {
        return await getFileFromDirectory(directoryHandle, queuePath(item));
      } catch (err) {
        const missingError = new Error(`找不到队列视频“${queuePath(item)}”，将重新按文件夹实际内容同步`);
        missingError.code = 'missing_queue_file';
        throw missingError;
      }
    }
    const fallback = currentFiles.find((file) =>
      (file.webkitRelativePath || file.name).replace(/\\/g, '/') === queuePath(item) || file.name === item.filename
    );
    if (fallback) return fallback;
    throw new Error('没有可跨页面恢复的文件夹权限，请重新选择并授权文件夹');
  }

  async function triggerNext(idx) {
    if (isProcessing) return;
    isProcessing = true;
    refreshUI();
    try {
      const state = getState();
      if (!state || state.autoPaused || state.pendingIndex !== null || idx !== state.doneIndex + 1) return;
      const file = await resolveQueueFile(state.items[idx]);
      await processOne(file, idx);
      // 注意：这里不直接标记doneIndex="idx"完成——因为点击发布后页面通常会跳转，
      // 真正的"完成"确认要等跳转到 content 页面那一刻(见文件最下方入口逻辑)才转正，
      // 这样能避免"点了发布但实际没成功"却被误标记为已完成的情况
    } catch (err) {
      if (err && err.code === 'user_paused') {
        log('⏸ 已成功中断当前任务，自动化已处于暂停状态');
      } else {
        log('❌ 出错: ' + err.message);
        pauseAutomation(err.message, err.code || 'runtime');
        if (err.code === 'missing_queue_file') lastFolderScanAt = 0;
      }
    } finally {
      isProcessing = false;
      refreshUI();
    }
  }

  async function maybeAutoStart() {
    if (!automationInitialized || isProcessing) return;
    const state = getState();
    if (!state || state.autoPaused || state.pendingIndex !== null) return;
    const nextIdx = state.doneIndex + 1;
    if (nextIdx >= state.items.length || Date.now() < state.nextTime) return;
    await triggerNext(nextIdx);
  }

  async function automationTick() {
    // 内容管理页只展示面板和确认发布结果，绝不能在这里启动上传流程。
    if (!isUploadPage() || !automationInitialized || tickInProgress || isProcessing) return;
    tickInProgress = true;
    try {
      if (directoryHandle && Date.now() - lastFolderScanAt >= CONFIG.FOLDER_SCAN_INTERVAL_MS) {
        await syncFolderQueue(false);
      }
      await maybeAutoStart();
    } catch (err) {
      pauseAutomation(err.message);
    } finally {
      tickInProgress = false;
    }
  }

  // ========================= 入口 =========================
  function isUploadPage() {
    return location.pathname.includes('/tiktokstudio/upload');
  }

  function isContentPage() {
    return location.pathname.includes('/tiktokstudio/content');
  }

  let routeHandling = false;

  function findVisibleUploadEntranceButton() {
    // TikTok 会根据窗口宽度同时渲染宽栏与窄栏入口，但只显示其中一个。
    // HU 指纹浏览器常用窄栏布局，按钮名不带 Wide，不能只查宽栏按钮。
    const stableSelectors = [
      'button[data-tt="Sidebar_UploadEntrance_Button"]',
      'button[data-tt="Sidebar_UploadEntrance_WideButton"]',
    ];
    for (const selector of stableSelectors) {
      const button = Array.from(document.querySelectorAll(selector))
        .find((candidate) => isVisible(candidate) && isEnabled(candidate));
      if (button) return button;
    }

    // 兼容 TikTok 后续再次改按钮 data-tt：只在上传入口容器内寻找带 PlusSquare 图标的按钮，
    // 避免误点页面上其他“加号”按钮。
    const iconBtn = Array.from(document.querySelectorAll('[data-tt="Sidebar_UploadEntrance_Container"] button'))
      .find((candidate) =>
        isVisible(candidate) &&
        isEnabled(candidate) &&
        Boolean(candidate.querySelector('[data-icon="PlusSquare"], [data-icon="plus-square"], svg'))
      );
    if (iconBtn) return iconBtn;

    // 兜底：查找侧边栏中包含 "Unggah" / "Upload" 的按钮或带 /tiktokstudio/upload 链接
    const sidebar = document.querySelector('nav, aside, [class*="sidebar"], [class*="Sidebar"]');
    if (sidebar) {
      const candidates = Array.from(sidebar.querySelectorAll('button, a'))
        .filter((el) => isVisible(el) && isEnabled(el));
      const match = candidates.find((el) => {
        const text = (el.textContent || '').trim();
        return text.includes('Unggah') || text.includes('Upload') || (el.getAttribute('href') || '').includes('/upload');
      });
      if (match) return match;
    }

    return null;
  }

  async function clickUploadEntranceAndWait() {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (isUploadPage()) return true;

      const uploadButton = await waitForOrNull(
        () => findVisibleUploadEntranceButton(),
        10000,
        200
      );

      if (!uploadButton) {
        log(`暂未找到左侧“上传”按钮，等待后重试（${attempt}/3）`);
        await humanDelay(800, 1600);
        continue;
      }

      log(`发布已确认，点击左侧“上传”返回上传页（${attempt}/3）`);
      fireClick(uploadButton);
      const reachedUploadPage = await waitForOrNull(() => isUploadPage() || null, 10000, 200);
      if (reachedUploadPage) return true;
      await humanDelay(800, 1600);
    }
    return false;
  }

  async function handleRouteState() {
    if (routeHandling) return;

    // 0.3.9 只识别宽栏上传按钮。升级后自动恢复这类已确认发布、但返回上传页失败的状态，
    // 不要求每个指纹环境再人工点一次“继续自动发布”。
    const recoveryState = getState();
    if (recoveryState && recoveryState.autoPaused && recoveryState.pauseCode === 'return_upload_failed') {
      recoveryState.autoPaused = false;
      recoveryState.pauseReason = '';
      recoveryState.pauseCode = '';
      recoveryState.returnToUploadPending = isContentPage();
      setState(recoveryState);
      log('▶️ 已自动修复旧版返回上传页失败状态，继续全自动发布');
      refreshUI();
    }

    // TikTok 有时以 SPA 方式切页，用户脚本不会重新执行，因此每秒动态判断路由。
    if (isUploadPage()) {
      const uploadState = getState();
      if (uploadState && uploadState.returnToUploadPending) {
        uploadState.returnToUploadPending = false;
        setState(uploadState);
        log('已返回上传页，将按原定时间继续全自动发布');
        refreshUI();
      }
      return;
    }

    if (!isContentPage()) return;

    let state = getState();
    if (!state) return;

    // 只有“脚本刚点过发布，且随后进入 content 页”才标记成功并自动返回。
    // 用户平时手动打开 content 页不会被脚本强制带走。
    if (Number.isInteger(state.pendingIndex)) {
      state.doneIndex = state.pendingIndex;
      state.pendingIndex = null;
      state.pendingSince = null;
      state.nextTime = Date.now() + randomInterval();
      state.autoPaused = false;
      state.pauseReason = '';
      state.pauseCode = '';
      state.returnToUploadPending = true;
      setState(state);
      log('检测到发布后进入内容页，已确认本条发布成功');
      refreshUI();
    }

    state = getState();
    if (!state || !state.returnToUploadPending) return;

    routeHandling = true;
    try {
      await humanDelay(1200, 2400);
      const reachedUploadPage = await clickUploadEntranceAndWait();
      const latestState = getState();

      if (reachedUploadPage) {
        if (latestState) {
          latestState.returnToUploadPending = false;
          setState(latestState);
        }
        log('已返回上传页，继续等待下一条或扫描新视频');
        refreshUI();
        return;
      }

      if (latestState) {
        latestState.returnToUploadPending = false;
        latestState.autoPaused = true;
        latestState.pauseReason = '发布已确认，但连续3次点击左侧上传仍未进入上传页';
        latestState.pauseCode = 'return_upload_failed';
        setState(latestState);
        log('❌ ' + latestState.pauseReason);
        refreshUI();
      }
    } catch (err) {
      const latestState = getState();
      if (latestState) {
        latestState.returnToUploadPending = false;
        latestState.autoPaused = true;
        latestState.pauseReason = `返回上传页时出错：${err.message}`;
        latestState.pauseCode = 'return_upload_failed';
        setState(latestState);
      }
      log('❌ 返回上传页时出错: ' + err.message);
      refreshUI();
    } finally {
      routeHandling = false;
    }
  }

  // 上传页和内容管理页都显示 UI；automationTick 会保证只有上传页可以启动任务。
  buildPanel();
  void handleRouteState();
})();
