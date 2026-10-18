const $ = (selector, root = document) => root.querySelector(selector); const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const DB_NAME = 'RazoGamesDB';
const DB_VERSION = 2;

// أسماء الأدمن الحصريين لغرفة الإدارة فقط
const ADMIN_USERS = ['raft_99', 'zeno'];

let db = null;
let games = [];
let users = [];
let currentUser = null;
let authMode = 'login';
let currentLang = localStorage.getItem('razo-lang') || 'ar';
let imageData = '';

function safeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function isLoggedIn() {
  return Boolean(currentUser?.username);
}

// فحص إن كان المستخدم الحالي هو Raft_99 أو Zeno لغرفة الإدارة
function isAdmin() {
  if (!isLoggedIn()) return false;
  return ADMIN_USERS.includes(currentUser.username.toLowerCase().trim());
}

function canUpload(type = 'normal') {
  if (!isLoggedIn()) return false;
  // قسم الألعاب المشهورة مخصص للمديرين فقط.
  if (type === 'popular') return isAdmin();
  return isAdmin() || currentUser.uploadApproved === true;
}

async function refreshCurrentUser() {
  if (!currentUser?.username) return;
  const saved = (await getAllStore('users')).find(u => u.username.toLowerCase() === currentUser.username.toLowerCase());
  if (saved) currentUser = { ...saved };
}

async function registerOrUpdateUser(username) {
  const existing = (await getAllStore('users')).find(u => u.username.toLowerCase() === username.toLowerCase());
  if (existing) return existing;
  const user = { username, uploadApproved: false, created: Date.now() };
  await putStore('users', user);
  return user;
}

function toast(message) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = String(message);
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2800);
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('فشل قراءة الملف'));
    reader.readAsDataURL(file);
  });
}

function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = event => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains('games')) database.createObjectStore('games', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('users')) database.createObjectStore('users', { keyPath: 'username' });
      if (!database.objectStoreNames.contains('session')) database.createObjectStore('session', { keyPath: 'key' });
      if (!database.objectStoreNames.contains('notifications')) database.createObjectStore('notifications', { keyPath: 'id' });
    };
    request.onsuccess = event => { db = event.target.result; resolve(db); };
    request.onerror = () => reject(request.error);
  });
}

function getAllStore(storeName) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve([]);
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => resolve([]);
  });
}

function putStore(storeName, item) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function deleteStore(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function renderNotifications() {
  const list = $('#notification-list');
  const count = $('#notification-count');
  if (!list || !count) return;
  if (!isLoggedIn()) {
    list.innerHTML = '<p class="notification-empty">سجّل الدخول لعرض إشعاراتك.</p>';
    count.classList.add('hidden');
    return;
  }
  const all = await getAllStore('notifications');
  const mine = all.filter(n => n.target === 'all' || String(n.target).toLowerCase() === currentUser.username.toLowerCase())
    .sort((a,b) => b.created - a.created);
  const unread = mine.filter(n => !Array.isArray(n.readBy) || !n.readBy.includes(currentUser.username)).length;
  count.textContent = unread > 99 ? '99+' : String(unread);
  count.classList.toggle('hidden', unread === 0);
  list.innerHTML = mine.length ? mine.map(n => {
    const read = Array.isArray(n.readBy) && n.readBy.includes(currentUser.username);
    return `<article class="notification-item ${read ? 'is-read' : 'is-unread'}"><span class="notification-item-mark">${read ? '✓' : '✦'}</span><div><b>${safeText(n.title)}</b><p>${safeText(n.message)}</p><small>${new Date(n.created).toLocaleString(currentLang === 'ar' ? 'ar' : 'en')}</small></div></article>`;
  }).join('') : '<p class="notification-empty">لا توجد إشعارات حتى الآن ✨</p>';
}

async function sendAdminNotification(event) {
  event.preventDefault();
  if (!isAdmin()) return toast('إرسال الإشعارات مخصص للإدارة فقط.');
  const title = $('#admin-notification-title')?.value.trim();
  const message = $('#admin-notification-message')?.value.trim();
  const target = $('#admin-notification-target')?.value || 'all';
  if (!title || !message) return toast('أدخل عنوان الإشعار ونصه.');
  const item = { id: `notice-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, title, message, target, created: Date.now(), sender: currentUser.username, readBy: [] };
  await putStore('notifications', item);
  $('#admin-notification-form')?.reset();
  const status = $('#admin-notification-status');
  if (status) status.textContent = 'تم حفظ الإشعار في قاعدة بيانات هذا المتصفح.';
  toast('تم إرسال الإشعار.');
  await renderNotifications();
}

async function markNotificationsRead() {
  if (!isLoggedIn()) return;
  const all = await getAllStore('notifications');
  for (const n of all) {
    if (n.target === 'all' || String(n.target).toLowerCase() === currentUser.username.toLowerCase()) {
      n.readBy = Array.isArray(n.readBy) ? n.readBy : [];
      if (!n.readBy.includes(currentUser.username)) n.readBy.push(currentUser.username);
      await putStore('notifications', n);
    }
  }
  await renderNotifications();
}

function refreshNotificationRecipients() {
  const select = $('#admin-notification-target');
  if (!select) return;
  const prior = select.value || 'all';
  select.innerHTML = '<option value="all">جميع المستخدمين</option>' + users
    .slice().sort((a,b) => a.username.localeCompare(b.username))
    .map(u => `<option value="${safeText(u.username)}">${safeText(u.username)}</option>`).join('');
  if ([...select.options].some(o => o.value === prior)) select.value = prior;
}

function updateAccountUI() {
  const accountBtn = $('#account-button');
  const badge = $('#user-profile-badge');
  const topUsername = $('#top-username');
  const adminNav = $('#admin-nav-item');
  const exportContainer = $('#admin-export-container');

  const isUserLoggedIn = isLoggedIn();
  const userIsAdmin = isAdmin();

  if (accountBtn) accountBtn.textContent = isUserLoggedIn ? 'تسجيل الخروج' : 'تسجيل الدخول';
  if (badge) badge.classList.toggle('hidden', !isUserLoggedIn);
  if (topUsername) topUsername.textContent = currentUser?.username || '';

  // إظهار/إخفاء زر روم الإدارة حصرياً لـ Raft_99 و Zeno
  if (adminNav) {
    adminNav.classList.toggle('hidden', !userIsAdmin);
  }

  refreshNotificationRecipients();
  renderNotifications();
  if (exportContainer) {
    exportContainer.innerHTML = userIsAdmin ? `
      <button id="export-btn" class="submit-btn" style="width: auto;">📥 تصدير نسخة احتياطية (JSON)</button>
      <div class="permission-panel"><h3>👥 إدارة صلاحيات الرفع</h3><p>اختر المستخدم ثم امنحه أو اسحب منه صلاحية رفع المحتوى. الألعاب المشهورة تبقى للمديرين فقط.</p><div id="users-permissions-list"></div></div>
    ` : '';
    $('#export-btn')?.addEventListener('click', exportData);
    if (userIsAdmin) renderUserPermissions();
  }
}

function card(item) {
  const id = safeText(item.id);
  const canDelete = isLoggedIn() && (item.owner === currentUser.username || isAdmin());

  return `
    <article class="game-card">
      <div class="game-image">
        ${item.image ? `<img src="${item.image}" alt="${safeText(item.name)}">` : '<div style="padding:40px; text-align:center;">🎮</div>'}
        <span class="card-tag">${safeText(item.category || 'عام')}</span>
      </div>
      <div class="game-body">
        <h3>${safeText(item.name)}</h3>
        <p>${safeText(item.description || 'لا يوجد وصف متاح.')}</p>
        <div class="game-meta">
          <span>بواسطة: ${safeText(item.owner || 'مجهول')}</span>
        </div>
        <div class="game-action-buttons">
          ${item.zipData ? `<button type="button" class="game-download-btn" data-file="${id}">⇩ تنزيل الملف</button>` : ''}
          ${canDelete ? `<button type="button" class="game-delete-btn" data-delete="${id}">حذف</button>` : ''}
        </div>
      </div>
    </article>
  `;
}

function render() {
  const term = ($('#search')?.value || '').trim().toLowerCase();

  const filtered = games.filter(g => 
    [g.name, g.category, g.description, g.type].join(' ').toLowerCase().includes(term)
  );

  const homeGrid = $('#home-grid');
  if (homeGrid) homeGrid.innerHTML = filtered.slice(0, 8).map(card).join('');

  const libraryGrid = $('#library-grid');
  if (libraryGrid) libraryGrid.innerHTML = filtered.map(card).join('');

  const popularGrid = $('#popular-games-grid');
  if (popularGrid) popularGrid.innerHTML = filtered.filter(g => g.type === 'popular').map(card).join('');

  const crackedGrid = $('#cracked-games-grid');
  if (crackedGrid) crackedGrid.innerHTML = filtered.filter(g => g.type === 'cracked').map(card).join('');

  const modelsGrid = $('#models3d-grid');
  if (modelsGrid) modelsGrid.innerHTML = filtered.filter(g => g.type === 'model3d').map(card).join('');

  const setText = (id, val) => { const el = $(id); if (el) el.textContent = String(val); };
  setText('#stat-games', games.length);
  setText('#stat-cracked', games.filter(g => g.type === 'cracked').length);
  setText('#stat-models', games.filter(g => g.type === 'model3d').length);
  setText('#library-result', `${filtered.length} عناصر متوفرة`);

  updateAccountUI();
}

async function renderUserPermissions() {
  const target = $('#users-permissions-list');
  if (!target || !isAdmin()) return;
  const allUsers = await getAllStore('users');
  if (!allUsers.length) { target.innerHTML = '<p>لا يوجد مستخدمون مسجلون بعد. سيظهر المستخدم هنا بعد تسجيل اسمه.</p>'; return; }
  target.innerHTML = allUsers.map(user => {
    const admin = ADMIN_USERS.includes(user.username.toLowerCase().trim());
    const approved = user.uploadApproved === true;
    return `<div class="permission-user"><div><b>${safeText(user.username)}</b><small>${admin ? 'مدير' : approved ? 'مسموح له بالرفع' : 'غير مسموح له بالرفع'}</small></div>${admin ? '<span class="permission-status">مدير</span>' : `<button type="button" class="permission-toggle ${approved ? 'revoke' : ''}" data-permission-user="${safeText(user.username)}" data-approved="${approved ? '1' : '0'}">${approved ? 'سحب الصلاحية' : 'السماح بالرفع'}</button>`}</div>`;
  }).join('');
}

function showPage(name) {
  if (name === 'admin' && !isAdmin()) {
    toast('عفواً! روم الإدارة مخصصة فقط لـ Raft_99 و Zeno');
    return;
  }

  $$('.page').forEach(p => p.classList.toggle('active', p.id === `page-${name}`));
  $$('.nav').forEach(n => n.classList.toggle('active', n.dataset.page === name));

  const crumb = $('#crumb-page');
  if (crumb) crumb.textContent = '/ ' + name;

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function exportData() {
  try {
    const payload = { app: 'Razo Games', exportedAt: new Date().toISOString(), games };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `razo_backup_${Date.now()}.json`;
    a.click();
    toast('تم تصدير النسخة الاحتياطية بنجاح!');
  } catch {
    toast('تعذر التصدير.');
  }
}

async function downloadGame(id) {
  const item = games.find(g => g.id === id);
  if (!item?.zipData) return toast('الملف غير متوفر.');

  const a = document.createElement('a');
  a.href = item.zipData;
  a.download = `${item.name}.zip`;
  a.click();
  toast('بدأ التنزيل...');
}

async function deleteGame(id) {
  if (!isLoggedIn()) return toast('يرجى تسجيل الدخول أولاً');
  const item = games.find(g => g.id === id);
  if (!item) return;

  if (!confirm(`هل تريد حذف "${item.name}"؟`)) return;

  await deleteStore('games', id);
  games = games.filter(g => g.id !== id);
  render();
  toast('تم الحذف بنجاح');
}

// الأحداث والتفاعلات
document.addEventListener('click', async e => {
  const permissionBtn = e.target.closest('[data-permission-user]');
  if (permissionBtn) {
    if (!isAdmin()) return toast('هذه العملية للمدير فقط.');
    const username = permissionBtn.dataset.permissionUser;
    const allUsers = await getAllStore('users');
    const user = allUsers.find(u => u.username === username);
    if (!user) return;
    user.uploadApproved = permissionBtn.dataset.approved !== '1';
    await putStore('users', user);
    if (currentUser?.username === username) currentUser = { ...user };
    await renderUserPermissions();
    render();
    toast(user.uploadApproved ? `تم منح ${username} صلاحية الرفع` : `تم سحب صلاحية الرفع من ${username}`);
    return;
  }

  const nav = e.target.closest('[data-page]');
  if (nav) {
    e.preventDefault();
    showPage(nav.dataset.page);
    return;
  }

  const fileBtn = e.target.closest('[data-file]');
  if (fileBtn) {
    downloadGame(fileBtn.dataset.file);
    return;
  }

  const delBtn = e.target.closest('[data-delete]');
  if (delBtn) {
    deleteGame(delBtn.dataset.delete);
    return;
  }
});

$('#open-add-top')?.addEventListener('click', () => $('#add-dialog')?.showModal());
$('#open-add-side')?.addEventListener('click', () => $('#add-dialog')?.showModal());
$('#close-add')?.addEventListener('click', () => $('#add-dialog')?.close());
$('#cancel-add')?.addEventListener('click', () => $('#add-dialog')?.close());

$('#account-button')?.addEventListener('click', () => {
  if (isLoggedIn()) {
    if (confirm('هل تريد تسجيل الخروج؟')) {
      currentUser = null;
      deleteStore('session', 'currentUser');
      updateAccountUI();
      render();
      toast('تم تسجيل الخروج');
    }
  } else {
    $('#auth-dialog')?.showModal();
  }
});

$('#close-auth')?.addEventListener('click', () => $('#auth-dialog')?.close());

$('#auth-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('#auth-username')?.value.trim();
  if (!username) return;
  currentUser = await registerOrUpdateUser(username);
  await putStore('session', { key: 'currentUser', username });
  $('#auth-dialog')?.close();
  updateAccountUI();
  render();
  toast(isAdmin() ? `أهلاً بالمدير ${username}` : currentUser.uploadApproved ? `أهلاً بك ${username}، يمكنك رفع المحتوى` : `أهلاً بك ${username}. رفع المحتوى يحتاج موافقة الإدارة.`);
});

$('#game-zip')?.addEventListener('change', e => {
  const file = e.target.files?.[0];
  if (file) $('#zip-filename').textContent = file.name;
});

$('#game-image')?.addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (file) {
    $('#image-filename').textContent = file.name;
    imageData = await readFileAsDataURL(file);
  }
});

// Admin shortcuts select the correct content category and accepted file formats.
$$('.admin-upload-tile').forEach(tile => tile.addEventListener('click', () => {
  if (!isAdmin()) return toast('هذه الأدوات مخصصة للإدارة فقط.');
  const type = tile.dataset.uploadType;
  const selector = $('#game-type-select');
  if (selector) selector.value = type;
  const fileInput = $('#game-zip');
  const label = $('#upload-file-label');
  if (type === 'model3d') {
    if (fileInput) fileInput.accept = '.fbx,.obj,.glb,.gltf,.blend,.stl,.dae,.3ds,.ply,.abc,.usd,.usdz,.zip';
    if (label) label.innerHTML = 'ملف الموديل ثلاثي الأبعاد <span>*</span>';
  } else {
    if (fileInput) fileInput.accept = '.zip,.rar,.7z';
    if (label) label.innerHTML = 'ملف اللعبة (ZIP / RAR / 7Z) <span>*</span>';
  }
  $('#add-dialog')?.showModal();
}));

$('#game-type-select')?.addEventListener('change', e => {
  const isModel = e.target.value === 'model3d';
  const input = $('#game-zip');
  if (input) input.accept = isModel ? '.fbx,.obj,.glb,.gltf,.blend,.stl,.dae,.3ds,.ply,.abc,.usd,.usdz,.zip' : '.zip,.rar,.7z';
  const label = $('#upload-file-label');
  if (label) label.innerHTML = isModel ? 'ملف الموديل ثلاثي الأبعاد <span>*</span>' : 'ملف اللعبة (ZIP / RAR / 7Z) <span>*</span>';
});

$('#game-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#game-name')?.value.trim();
  const type = $('#game-type-select')?.value || 'normal';
  if (!isLoggedIn()) return toast('يرجى تسجيل الدخول أولاً.');
  if (!canUpload(type)) return toast(type === 'popular' ? 'الألعاب المشهورة ينشرها المدير فقط.' : 'حسابك يحتاج موافقة الإدارة قبل رفع المحتوى.');
  const category = $('#game-category')?.value.trim();
  const description = $('#game-description')?.value.trim();
  const zipFile = $('#game-zip')?.files?.[0];

  if (name && zipFile && imageData) {
    const zipData = await readFileAsDataURL(zipFile);

    const newItem = {
      id: Date.now().toString(36),
      owner: currentUser.username,
      name, type, category, description, zipData, image: imageData, created: Date.now(),
      published: true
    };

    await putStore('games', newItem);
    games.push(newItem);
    render();
    $('#add-dialog')?.close();
    $('#game-form')?.reset();
    imageData = '';
    toast('تمت إضافة المحتوى بنجاح!');
  }
});

$('#search')?.addEventListener('input', render);
$('#admin-notification-form')?.addEventListener('submit', sendAdminNotification);
$('#notification-bell')?.addEventListener('click', async () => {
  if (!isLoggedIn()) return toast('سجّل الدخول أولاً لعرض الإشعارات.');
  $('#notification-popover')?.classList.toggle('hidden');
  await renderNotifications();
});
$('#mark-notifications-read')?.addEventListener('click', markNotificationsRead);
document.addEventListener('click', event => {
  const wrap = $('#notification-wrap');
  if (wrap && !wrap.contains(event.target)) $('#notification-popover')?.classList.add('hidden');
});

const savedColor = localStorage.getItem('razo-color'); if (savedColor) document.body.setAttribute('data-color', savedColor);
$$('.color-circle').forEach(btn => { btn.classList.toggle('active', btn.dataset.color === (savedColor || 'cyan')); btn.addEventListener('click', () => { const c = btn.dataset.color; document.body.setAttribute('data-color', c); localStorage.setItem('razo-color', c); $$
('.color-circle').forEach(b => b.classList.toggle('active', b === btn));
  });
});

if (localStorage.getItem('razo-theme') === 'light') document.body.classList.add('light-theme');
$('#theme-toggle-btn')?.addEventListener('click', () => {
  document.body.classList.toggle('light-theme');
  localStorage.setItem('razo-theme', document.body.classList.contains('light-theme') ? 'light' : 'dark');
});

$('#password-change-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  if (!isLoggedIn()) return toast('سجّل الدخول أولاً.');
  const oldPassword = $('#old-password').value;
  const newPassword = $('#new-password').value;
  const confirmPassword = $('#confirm-password').value;
  const stored = (await getAllStore('users')).find(u => u.username.toLowerCase() === currentUser.username.toLowerCase());
  if (!stored) return toast('تعذر العثور على الحساب.');
  if (stored.password && stored.password !== oldPassword) return toast('كلمة المرور الحالية غير صحيحة.');
  if (newPassword.length < 8) return toast('كلمة المرور يجب أن تكون 8 أحرف على الأقل.');
  if (newPassword !== confirmPassword) return toast('تأكيد كلمة المرور غير متطابق.');
  stored.password = newPassword;
  await putStore('users', stored);
  currentUser = { ...stored };
  $('#password-change-form').reset();
  toast('تم تحديث كلمة المرور لهذا المتصفح.');
});

async function init() {
  await initDB();
  games = await getAllStore('games');
  users = await getAllStore('users');
  refreshNotificationRecipients();

  const sessions = await getAllStore('session');
  if (sessions.length) {
    const savedUser = users.find(u => u.username.toLowerCase() === String(sessions[0].username).toLowerCase());
    currentUser = savedUser || { username: sessions[0].username, uploadApproved: false };
  }

  render();
  await renderNotifications();
}

init();
// Responsive sidebar toggle
(() => {
  const menuButton = document.getElementById('mobile-menu');
  const sidebar = document.getElementById('sidebar');
  if (!menuButton || !sidebar) return;
  menuButton.addEventListener('click', () => sidebar.classList.toggle('open'));
  document.addEventListener('click', event => {
    if (window.innerWidth > 760 || !sidebar.classList.contains('open')) return;
    if (!sidebar.contains(event.target) && !menuButton.contains(event.target)) sidebar.classList.remove('open');
  });
  sidebar.querySelectorAll('.nav').forEach(item => item.addEventListener('click', () => {
    if (window.innerWidth <= 760) sidebar.classList.remove('open');
  }));
})();
