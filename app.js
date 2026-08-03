'use strict';

var CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
    ]
};
var ICE_TIMEOUT = 800;
var CHUNK_SIZE_BASE = 65536;
var CHUNK_SIZE_MIN = 16384;
var CHUNK_SIZE_MAX = 4194304;
var BUF_TARGET = 1048576;
var BUF_LOW = 131072;
var NUM_DATA_CHANNELS = 4;
var ADAPT_EMA_ALPHA = 0.3;

var state = 'home';
var pc = null;
var ctrlDC = null;
var dataDCs = [];
var isHost = false;
var fileQueue = [];
var recvStreams = {};
var pendingChunks = {};
var autoConnected = false;
var lastPeerName = null;
var avgThroughput = 0;
var currentChunkSize = CHUNK_SIZE_BASE;

var _txTotalBytes = 0;
var _txSentBytes = 0;
var _rxTotalBytes = 0;
var _rxReceivedBytes = 0;
var _bgProgressTimer = 0;
var _receivedCount = 0;
var _receivedBytes = 0;
var _txStart = 0;
var _rxBatchStart = 0;
var _lastPct = -1;
var _throttleTimer = 0;
var _linkCallbacks = [];
var _jarvisAutoDone = false;
var _jarvisTargetId = null;
var _incomingFiles = [];

function isJarvisDevice(d) {
    return !!(d && (d.isJarvis || (d.username && normalizeUsername(d.username) === 'jarvis')));
}

function $(id) { return document.getElementById(id); }

var FB_CONFIG = {
    apiKey: 'AIzaSyAwwm1NYa-jaKNqmJCGzKD6Blyq5VUVWuc',
    authDomain: 'share-it-414ed.firebaseapp.com',
    databaseURL: 'https://share-it-414ed-default-rtdb.firebaseio.com',
    projectId: 'share-it-414ed',
    storageBucket: 'share-it-414ed.firebasestorage.app',
    appId: '1:280437631286:web:ed636e0fa0a4c7c5d56b97'
};
var DB = null;
try {
    if (typeof firebase !== 'undefined' && firebase.initializeApp) {
        firebase.initializeApp(FB_CONFIG);
        DB = firebase.database();
    }
} catch (e) { console.warn('Firebase init failed:', e); DB = null; }

var DEVICE_ID = null;
var DEVICE_NAME = null;

function genUuid() {
    try {
        var arr = new Uint8Array(16);
        crypto.getRandomValues(arr);
        var s = '';
        for (var i = 0; i < arr.length; i++) {
            s += arr[i].toString(16);
            if (i === 3 || i === 5 || i === 7 || i === 9) s += '-';
        }
        return s;
    } catch (e) {
        return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
}
function getDeviceId() {
    if (DEVICE_ID) return DEVICE_ID;
    try { DEVICE_ID = localStorage.getItem('jl.deviceId'); } catch (e) {}
    if (!DEVICE_ID) {
        DEVICE_ID = genUuid();
        try { localStorage.setItem('jl.deviceId', DEVICE_ID); } catch (e) {}
    }
    return DEVICE_ID;
}
function getDeviceName() {
    if (DEVICE_NAME) return DEVICE_NAME;
    var sessionUser = getSessionUser();
    if (sessionUser) { DEVICE_NAME = sessionUser; return DEVICE_NAME; }
    try { DEVICE_NAME = localStorage.getItem('jl.deviceName'); } catch (e) {}
    if (!DEVICE_NAME) {
        DEVICE_NAME = 'Phone-' + getDeviceId().slice(0, 4).toUpperCase();
        try { localStorage.setItem('jl.deviceName', DEVICE_NAME); } catch (e) {}
    }
    return DEVICE_NAME;
}

function apiBase() {
    return location.origin;
}

function normalizeUsername(u) {
    return (u || '').trim().toLowerCase();
}

function getSessionUser() {
    try { return localStorage.getItem('jl.username'); } catch (e) { return null; }
}
function setSessionUser(u) {
    try { localStorage.setItem('jl.username', u); } catch (e) {}
}
function clearSessionUser() {
    try { localStorage.removeItem('jl.username'); } catch (e) {}
}
function getWhitelistUsers() {
    try {
        var arr = JSON.parse(localStorage.getItem('jl.whitelistUsers') || '[]');
        return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
}
function setWhitelistUsers(arr) {
    try { localStorage.setItem('jl.whitelistUsers', JSON.stringify(arr)); } catch (e) {}
}

// The whitelist lives on the J.A.R.V.I.S. server AND in the Firebase database,
// so signing in works no matter where this app is hosted (GitHub Pages, the
// J.A.R.V.I.S. server, a file server...). The server is tried first; when it
// is not reachable, the database is used instead.
function fbUsersRead() {
    return new Promise(function(resolve, reject) {
        if (!DB) { reject(new Error('no-db')); return; }
        DB.ref('whitelist/users').once('value').then(function(snap) {
            var v = snap.val();
            var map = {};
            if (v && typeof v === 'object') {
                Object.keys(v).forEach(function(k) {
                    map[String(k).trim().toLowerCase()] = String(v[k]);
                });
            }
            resolve(map);
        }).catch(function(e) { reject(e); });
    });
}

function fbUsersWrite(user, password) {
    return new Promise(function(resolve, reject) {
        if (!DB) { reject(new Error('no-db')); return; }
        DB.ref('whitelist/users').child(user).set(password).then(resolve, reject);
    });
}

// 'ok' | 'invalid:<error>' | 'unreachable'
async function serverLoginAttempt(username, password) {
    var res;
    try {
        res = await fetch(apiBase() + '/api/wetransfer/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username, password: password })
        });
    } catch (e) {
        return 'unreachable';
    }
    if (res.status === 404 || res.status === 405 || res.status === 501) return 'unreachable';
    var data = await res.json().catch(function() { return {}; });
    if (res.ok && data.ok) return 'ok';
    return 'invalid:' + (data.error || 'Login failed.');
}

async function whitelistLogin(username, password) {
    var result = await serverLoginAttempt(username, password);
    if (result === 'ok') return username;
    if (result.indexOf('invalid:') === 0) throw new Error(result.slice(8));
    if (DB) {
        var map;
        try {
            map = await fbUsersRead();
        } catch (e) {
            throw new Error('Can\u2019t reach J.A.R.V.I.S. or the database to check the whitelist.');
        }
        var key = normalizeUsername(username);
        if (!(key in map)) throw new Error('That username isn\u2019t on the whitelist yet \u2014 register it first.');
        if (map[key] !== password) throw new Error('Wrong password.');
        return username;
    }
    throw new Error('No login server here and no database to check the whitelist.');
}

async function whitelistAdd(username, password) {
    var res = null;
    try {
        res = await fetch(apiBase() + '/api/wetransfer/whitelist/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username, password: password })
        });
    } catch (e) {
        res = null;
    }
    if (res && res.status !== 404 && res.status !== 405 && res.status !== 501) {
        var data = await res.json().catch(function() { return {}; });
        if (!res.ok || !data.ok) throw new Error(data.error || 'Could not add the account.');
        return data.username || username;
    }
    if (!DB) throw new Error('No login server here and no database to register with.');
    var key = normalizeUsername(username);
    var map;
    try {
        map = await fbUsersRead();
    } catch (e) {
        throw new Error('Can\u2019t reach the database to register.');
    }
    if (key in map) throw new Error('That username is already on the whitelist.');
    await fbUsersWrite(key, password);
    return username;
}

function loadWhitelistUsers() {
    return fetch(apiBase() + '/api/wetransfer/whitelist')
        .then(function(res) { return res.json().catch(function() { return {}; }); })
        .then(function(data) {
            if (data && data.ok && Array.isArray(data.users)) {
                setWhitelistUsers(data.users);
                return data.users;
            }
            return null;
        })
        .then(function(users) {
            if (users) return users;
            return fbUsersRead().then(function(map) {
                var list = Object.keys(map);
                setWhitelistUsers(list);
                return list;
            });
        })
        .catch(function() { return getWhitelistUsers(); });
}

function doLogin() {
    var u = $('login-username').value.trim();
    var p = $('login-password').value;
    var st = $('login-status');
    if (!u || !p) { st.textContent = 'Enter your username and password.'; return; }
    st.textContent = 'Signing in...';
    whitelistLogin(u, p).then(function(name) {
        DEVICE_NAME = name;
        setSessionUser(name);
        loadWhitelistUsers();
        startApp();
    }).catch(function(e) {
        st.textContent = e.message;
    });
}

function doAddDevice() {
    var u = $('reg-username').value.trim();
    var p = $('reg-password').value;
    var p2 = $('reg-password2').value;
    var st = $('reg-status');
    if (!u || !p) { st.textContent = 'Enter a username and password.'; return; }
    if (p !== p2) { st.textContent = 'Passwords do not match.'; return; }
    if (p.length < 4) { st.textContent = 'Password must be at least 4 characters.'; return; }
    st.textContent = 'Adding to whitelist...';
    whitelistAdd(u, p).then(function(name) {
        DEVICE_NAME = name;
        setSessionUser(name);
        loadWhitelistUsers();
        startApp();
    }).catch(function(e) {
        st.textContent = e.message;
    });
}

function doLogout() {
    if (state === 'connected') disconnect();
    _jarvisAutoDone = false;
    _jarvisTargetId = null;
    _linkCallbacks = [];
    stopPresence();
    clearSessionUser();
    DEVICE_NAME = null;
    var l1 = $('login-username'), l2 = $('login-password'), r1 = $('reg-username'), r2 = $('reg-password'), r3 = $('reg-password2');
    if (l1) l1.value = '';
    if (l2) l2.value = '';
    if (r1) r1.value = '';
    if (r2) r2.value = '';
    if (r3) r3.value = '';
    showScreen('login');
}

function deviceShort() {
    return getDeviceId().slice(0, 4).toUpperCase();
}
function presenceName() {
    var u = getSessionUser();
    return u ? (u + ' \u00b7 ' + deviceShort()) : deviceShort();
}

var onlineDevices = {};
var _presenceTimer = 0;

function publishPresence() {
    if (!DB) return;
    var userKey = normalizeUsername(getSessionUser());
    if (!userKey) return;
    var ref = DB.ref('presence/' + userKey + '/' + getDeviceId());
    try {
        ref.onDisconnect().set({
            username: getSessionUser(), name: presenceName(),
            deviceId: getDeviceId(), online: false
        });
    } catch (e) {}
    ref.set({
        username: getSessionUser(), name: presenceName(),
        deviceId: getDeviceId(), online: true,
        lastSeen: firebase.database.ServerValue.TIMESTAMP
    });
}

function heartbeatPresence() {
    if (!DB) return;
    var userKey = normalizeUsername(getSessionUser());
    if (!userKey) return;
    DB.ref('presence/' + userKey + '/' + getDeviceId()).update({
        online: true,
        lastSeen: firebase.database.ServerValue.TIMESTAMP
    });
}

function stopPresence() {
    if (_presenceTimer) { clearInterval(_presenceTimer); _presenceTimer = 0; }
    if (!DB) return;
    var userKey = normalizeUsername(getSessionUser());
    if (!userKey) return;
    try { DB.ref('presence/' + userKey + '/' + getDeviceId()).set({ online: false }); } catch (e) {}
}

function formatTimeAgo(ts) {
    if (!ts) return 'online';
    var diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
}

function findJarvisDevice() {
    var keys = Object.keys(onlineDevices);
    for (var i = 0; i < keys.length; i++) {
        var d = onlineDevices[keys[i]];
        if (!d || d.isSelf || !d.online) continue;
        if (isJarvisDevice(d)) return d;
    }
    return null;
}

function updateJarvisCard() {
    var dot = $('jarvis-status-dot'), txt = $('jarvis-status-text'), btn = $('btn-jarvis-send');
    if (!dot || !txt || !btn) return;
    var j = findJarvisDevice();
    if (autoConnected && _jarvisTargetId) {
        dot.className = 'dot dot-green';
        txt.textContent = 'linked \u00b7 ready to send & receive';
        btn.textContent = '\ud83d\udce4 Send to J.A.R.V.I.S.';
        btn.disabled = false;
        return;
    }
    if (reconnecting) {
        dot.className = 'dot dot-gold';
        txt.textContent = 'linking\u2026';
        btn.textContent = 'Linking to J.A.R.V.I.S.\u2026';
        btn.disabled = true;
        return;
    }
    if (j) {
        dot.className = 'dot dot-green';
        txt.textContent = 'online \u00b7 tap to link';
        btn.textContent = '\ud83d\udce4 Send to J.A.R.V.I.S.';
        btn.disabled = false;
    } else {
        dot.className = 'dot dot-red';
        txt.textContent = 'offline \u00b7 start J.A.R.V.I.S. on your PC';
        btn.textContent = 'J.A.R.V.I.S. is offline';
        btn.disabled = true;
    }
}

function renderDevices() {
    var sec = $('device-section'), wrap = $('device-list');
    var whitelist = getWhitelistUsers();
    var items = [];
    Object.keys(onlineDevices).forEach(function(id) {
        var d = onlineDevices[id];
        if (!d || !d.online) return;
        if (whitelist.length > 0 && whitelist.indexOf((d.username || '').toLowerCase()) === -1) return;
        d.isSelf = (id === getDeviceId());
        items.push(d);
    });
    items.sort(function(a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0); });
    if (!items.length) {
        if (sec) sec.classList.add('hidden');
        updateJarvisCard();
        return;
    }
    if (sec) sec.classList.remove('hidden');
    if (wrap) wrap.innerHTML = '';
    var others = 0;
    items.forEach(function(d) {
        var row = document.createElement('div');
        row.className = 'recent-row';
        if (d.isSelf) row.classList.add('self-device');
        var info = document.createElement('div');
        info.className = 'recent-info';
        var nm = document.createElement('div');
        nm.className = 'recent-name';
        nm.textContent = (d.label || d.username || 'Device') + (d.isSelf ? '  \u00b7  you' : '');
        if (isJarvisDevice(d) && !d.isSelf) {
            var badge = document.createElement('span');
            badge.className = 'jarvis-badge';
            badge.textContent = 'J.A.R.V.I.S.';
            nm.appendChild(badge);
        }
        var tm = document.createElement('div');
        tm.className = 'recent-time';
        tm.textContent = (d.username || '') + ' \u00b7 ' + formatTimeAgo(d.lastSeen);
        info.appendChild(nm);
        info.appendChild(tm);
        row.appendChild(info);
        if (!d.isSelf) {
            others++;
            var btn = document.createElement('button');
            btn.className = 'reconnect-btn';
            btn.textContent = 'Connect';
            btn.addEventListener('click', function() {
                _jarvisTargetId = isJarvisDevice(d) ? d.deviceId : null;
                connectToDevice(d.deviceId, isJarvisDevice(d) ? 'J.A.R.V.I.S.' : (d.label || d.username || 'device'));
            });
            row.appendChild(btn);
        } else {
            var tag = document.createElement('div');
            tag.className = 'recent-time';
            tag.textContent = 'ready';
            tag.style.alignSelf = 'center';
            row.appendChild(tag);
        }
        if (wrap) wrap.appendChild(row);
    });
    if (others === 0 && wrap) {
        var hint = document.createElement('div');
        hint.className = 'recent-time';
        hint.style.padding = '8px 2px';
        hint.textContent = 'Only your phone is online. Other whitelisted devices appear here when signed in.';
        wrap.appendChild(hint);
    }
    updateJarvisCard();
}

function maybeAutoLink() {
    if (state !== 'home') return;
    if (autoConnected || reconnecting || _jarvisAutoDone) return;
    var j = findJarvisDevice();
    if (!j) return;
    _jarvisAutoDone = true;
    _jarvisTargetId = j.deviceId;
    connectToDevice(j.deviceId, 'J.A.R.V.I.S.');
}

function listenForPresence() {
    if (!DB) return;
    DB.ref('presence/').on('value', function(snap) {
        var data = snap.val();
        var next = {};
        if (data && typeof data === 'object') {
            Object.keys(data).forEach(function(uKey) {
                var byDev = data[uKey];
                if (!byDev || typeof byDev !== 'object') return;
                Object.keys(byDev).forEach(function(devId) {
                    var e = byDev[devId];
                    if (!e) return;
                    next[devId] = {
                        deviceId: devId,
                        username: e.username || uKey,
                        label: e.name || e.username || devId,
                        lastSeen: (typeof e.lastSeen === 'number' ? e.lastSeen : Date.now()),
                        online: !!e.online,
                        isJarvis: !!e.isJarvis
                    };
                });
            });
        }
        onlineDevices = next;
        renderDevices();
        maybeAutoLink();
    });
}

var roomCode = null;
var currentRoomRef = null;
var currentReqRef = null;
var recvReqRef = null;
var answered = false;
var reqAnswered = false;
var reconnecting = false;
var connTimer = null;

function stopCurrentSignaling() {
    if (connTimer) { clearTimeout(connTimer); connTimer = null; }
    if (currentRoomRef) { try { currentRoomRef.off(); } catch (e) {} currentRoomRef = null; }
    if (currentReqRef) { try { currentReqRef.off(); } catch (e) {} currentReqRef = null; }
    if (recvReqRef) { try { recvReqRef.off(); } catch (e) {} recvReqRef = null; }
    roomCode = null;
    answered = false;
    reqAnswered = false;
    reconnecting = false;
}
function cleanupSignalingData() {
    if (currentRoomRef) { try { currentRoomRef.remove(); } catch (e) {} }
    if (currentReqRef) { try { currentReqRef.remove(); } catch (e) {} }
    stopCurrentSignaling();
}

var wakeLock = null;

function requestNotificationPermission() {
    try {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission().then(function(p) {
                updateNotifHint();
            }).catch(function() {});
        } else if ('Notification' in window && Notification.permission === 'granted') {
            updateNotifHint();
        }
    } catch (e) {}
}

function updateNotifHint() {
    try {
        var b = $('btn-notif-blocked');
        if (!b) return;
        var blocked = 'Notification' in window && Notification.permission === 'denied';
        b.classList.toggle('hidden', !blocked);
    } catch (e) {}
}

function notify(title, body, soundName, vibratePattern) {
    if (soundName) playSound(soundName);
    try {
        if (navigator.vibrate) navigator.vibrate(vibratePattern || [200, 100, 200]);
    } catch (e) {}
    try {
        if ('Notification' in window && Notification.permission === 'granted') {
            var n = new Notification(title, { body: body, icon: 'icon-192.png', tag: 'jarvis-link' });
            setTimeout(function() { try { n.close(); } catch (e) {} }, 6000);
        }
    } catch (e) {}
}

function requestWakeLock() {
    try {
        if ('wakeLock' in navigator && navigator.wakeLock && !wakeLock) {
            navigator.wakeLock.request('screen').then(function(l) {
                wakeLock = l;
                l.addEventListener('release', function() { wakeLock = null; });
            }).catch(function() {});
        }
    } catch (e) {}
}

function releaseWakeLock() {
    try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {}
}

function initKeepAlive() { }
function startKeepAlive() { }
function stopKeepAlive() { }

function showScreen(id) {
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i++) {
        screens[i].classList.remove('active');
    }
    var el = $('screen-' + id);
    if (el) el.classList.add('active');
    state = id;
}

function waitForIceGathering(p) {
    if (p.iceGatheringState === 'complete') return Promise.resolve();
    return Promise.race([
        new Promise(function(resolve) {
            p.onicegatheringstatechange = function() {
                if (p.iceGatheringState === 'complete') {
                    p.onicegatheringstatechange = null;
                    resolve();
                }
            };
        }),
        new Promise(function(resolve) {
            setTimeout(function() { resolve(); }, ICE_TIMEOUT);
        })
    ]);
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
}

function fmtSpeed(bps) {
    if (bps < 1e6) return (bps / 1e3).toFixed(0) + ' Kbps';
    if (bps < 1e9) return (bps / 1e6).toFixed(1) + ' Mbps';
    return (bps / 1e9).toFixed(2) + ' Gbps';
}

function fmtDuration(sec) {
    if (sec < 1) return (sec * 1000).toFixed(0) + 'ms';
    if (sec < 60) return sec.toFixed(1) + 's';
    var m = Math.floor(sec / 60);
    var s = (sec % 60).toFixed(0);
    return m + 'm ' + s + 's';
}

function playSound(name) {
    try {
        var a = new Audio('sound/' + name + '.mp3');
        a.volume = 0.6;
        a.play().catch(function() {});
    } catch (e) {}
}

function updateThroughput(fileSizeBytes, elapsedMs) {
    if (elapsedMs <= 0) return;
    var fileBps = (fileSizeBytes * 8) / (elapsedMs / 1000);
    if (avgThroughput === 0) {
        avgThroughput = fileBps;
    } else {
        avgThroughput = avgThroughput * (1 - ADAPT_EMA_ALPHA) + fileBps * ADAPT_EMA_ALPHA;
    }
    if (avgThroughput > 200e6) currentChunkSize = CHUNK_SIZE_MAX;
    else if (avgThroughput > 50e6) currentChunkSize = 1048576;
    else if (avgThroughput > 10e6) currentChunkSize = 262144;
    else currentChunkSize = CHUNK_SIZE_BASE;
}

function setupCtrlDC(channel) {
    ctrlDC = channel;
    channel.binaryType = 'arraybuffer';
    channel.onmessage = function(e) {
        if (typeof e.data === 'string') handleCtrlMsg(e.data);
    };
    channel.onopen = function() {
        if (!autoConnected) tryConnect();
    };
    channel.onerror = function(e) { console.error('CTRL DC error', e); };
    channel.onclose = function() {
        if (state === 'connected') {
            disconnect();
        }
    };
}

function setupDataDC(channel, index) {
    dataDCs[index] = channel;
    channel.binaryType = 'arraybuffer';
    channel.onmessage = function(e) {
        if (e.data instanceof ArrayBuffer) handleDataMsg(e.data, index);
    };
    channel.onopen = function() {
        console.log('Data channel ' + index + ' open');
        if (!autoConnected) tryConnect();
    };
    channel.onerror = function(e) { console.warn('Data DC ' + index + ' error', e); };
    channel.onclose = function() {
        console.log('Data channel ' + index + ' closed');
    };
}

function tryConnect() {
    if (!ctrlDC || ctrlDC.readyState !== 'open') return;
    if (!pc || (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed')) return;
    if (autoConnected) return;
    autoConnected = true;
    if (connTimer) { clearTimeout(connTimer); connTimer = null; }
    requestWakeLock();
    startKeepAlive();
    showScreen('connected');
    var peer = $('peer-label');
    if (peer) peer.textContent = lastPeerName || 'J.A.R.V.I.S.';
    notify('JARVIS Link', 'Linked to ' + (lastPeerName || 'your device'), 'granted', [80]);
    try { ctrlDC.send(JSON.stringify({ type: 'hello', deviceId: getDeviceId(), name: getDeviceName() })); } catch (e) {}
    if (currentRoomRef) { try { currentRoomRef.update({ status: 'connected' }); } catch (e) {} }
    if (currentReqRef) { try { currentReqRef.update({ status: 'connected' }); } catch (e) {} }
    var cbs = _linkCallbacks; _linkCallbacks = [];
    for (var i = 0; i < cbs.length; i++) { try { cbs[i](); } catch (e) {} }
    updateJarvisCard();
}

function selectFiles() { $('file-input').click(); }

function onFilesSelected(e) {
    const files = Array.from(e.target.files);
    fileQueue.push.apply(fileQueue, files);
    renderSummary();
}

function renderSummary() {
    var el = $('file-summary');
    var countEl = $('file-count');
    var sizeEl = $('file-total-size');
    if (fileQueue.length === 0) {
        el.classList.add('hidden');
        $('btn-send').classList.add('hidden');
        return;
    }
    var total = fileQueue.reduce(function(s, f) { return s + f.size; }, 0);
    countEl.textContent = fileQueue.length + ' file' + (fileQueue.length !== 1 ? 's' : '');
    sizeEl.textContent = '· ' + formatSize(total);
    el.classList.remove('hidden');
    $('btn-send').classList.remove('hidden');
}

function clearFiles() {
    fileQueue = [];
    renderSummary();
}

async function sendFiles() {
    if (!ctrlDC || ctrlDC.readyState !== 'open') return alert('Not linked to any device.');
    var openDCs = dataDCs.filter(function(c) { return c && c.readyState === 'open'; });
    if (openDCs.length === 0) return alert('No data channels available.');

    if (fileQueue.length === 0) return;

    requestWakeLock();
    startKeepAlive();
    startBgProgress();

    const files = [...fileQueue];
    fileQueue = [];
    renderSummary();
    $('btn-send').classList.add('hidden');
    $('progress-section').classList.remove('hidden');
    resetProgressDisplay();
    setProgressRole(true);

    var sFill = $('liquid-sender'), rFill = $('liquid-receiver');
    if (sFill) sFill.style.height = '100%';
    if (rFill) rFill.style.height = '0%';
    var ps = $('pct-sender'), pr = $('pct-receiver');
    if (ps) ps.textContent = '0%';
    if (pr) pr.textContent = '0%';
    _lastPct = -1;
    _throttleTimer = 0;
    var fs = $('file-summary');
    if (fs) fs.classList.add('hidden');

    _txTotalBytes = files.reduce(function(s, f) { return s + f.size; }, 0);
    _txSentBytes = 0;
    _txStart = Date.now();
    $('progress-label').textContent = 'Sending ' + files.length + ' file' + (files.length !== 1 ? 's' : '') + '...';

    var fileIndex = 0;
    var numWorkers = Math.min(openDCs.length, files.length);

    function assignNext(chanIdx) {
        if (fileIndex >= files.length) return Promise.resolve();
        var file = files[fileIndex++];
        return sendSingleFile(file, chanIdx).then(function() {
            var cur = _txSentBytes;
            updateProgress(cur / _txTotalBytes);
            return assignNext(chanIdx);
        });
    }

    var workers = [];
    for (var i = 0; i < numWorkers; i++) {
        workers.push(assignNext(i));
    }
    await Promise.all(workers);

    var elapsed = (Date.now() - _txStart) / 1000;
    var speed = elapsed > 0 ? (_txTotalBytes * 8) / elapsed : 0;
    ctrlDC.send(JSON.stringify({ type: 'transfer-complete', elapsed: elapsed, speed: speed }));
    stopBgProgress();
    playSound('sent');
    notify('Transfer Complete', files.length + ' file' + (files.length !== 1 ? 's' : '') + ' sent to ' + (lastPeerName || 'J.A.R.V.I.S.'), 'sent', [200, 100, 200]);
    showSuccess(elapsed, speed);
}

async function sendSingleFile(file, channelIndex) {
    var dc = dataDCs[channelIndex];
    if (!dc || dc.readyState !== 'open') return;

    var chunkSize = currentChunkSize;
    var totalChunks = Math.ceil(file.size / chunkSize);
    var fileId = Date.now() + '-' + Math.random().toString(36).substr(2, 6);

    ctrlDC.send(JSON.stringify({
        type: 'file-start', fileId: fileId, channelIndex: channelIndex,
        name: file.name, size: file.size,
        mimeType: file.type || 'application/octet-stream',
        totalChunks: totalChunks
    }));

    var fileStartTime = Date.now();
    var offset = 0;

    for (var i = 0; i < totalChunks; i++) {
        var end = Math.min(offset + chunkSize, file.size);
        var blob = file.slice(offset, end);
        var buf = await blob.arrayBuffer();
        dc.send(buf);
        _txSentBytes += buf.byteLength;
        updateProgress(_txSentBytes / _txTotalBytes);
        offset = end;
        if (dc.bufferedAmount >= BUF_TARGET) await waitBufferDrain(dc);
    }

    ctrlDC.send(JSON.stringify({ type: 'file-end', fileId: fileId, name: file.name, channelIndex: channelIndex }));

    var fileElapsed = Date.now() - fileStartTime;
    updateThroughput(file.size, fileElapsed);
}

async function waitBufferDrain(dataDC) {
    if (!dataDC || dataDC.readyState !== 'open') return;
    if (dataDC.bufferedAmount <= BUF_LOW) return;
    return new Promise(function(resolve) {
        dataDC.bufferedAmountLowThreshold = BUF_LOW;
        dataDC.onbufferedamountlow = function() {
            dataDC.onbufferedamountlow = null;
            if (pollTimer) clearTimeout(pollTimer);
            resolve();
        };
        var pollTimer = setTimeout(function poll() {
            if (!dataDC || dataDC.readyState !== 'open') { resolve(); return; }
            if (dataDC.bufferedAmount <= BUF_LOW) {
                dataDC.onbufferedamountlow = null;
                resolve();
            } else {
                pollTimer = setTimeout(poll, 50);
            }
        }, 100);
    });
}

async function handleCtrlMsg(data) {
    try {
        var msg = JSON.parse(data);
    } catch (_) { return; }

    switch (msg.type) {
        case 'hello':
            lastPeerName = msg.name || lastPeerName;
            break;

        case 'transfer-complete':
            stopBgProgress();
            if (_rxBatchStart) {
                var rxElapsed = (Date.now() - _rxBatchStart) / 1000;
                var rxSpeed = rxElapsed > 0 ? (_rxReceivedBytes * 8) / rxElapsed : 0;
                showSuccess(rxElapsed, rxSpeed);
            }
            _rxBatchStart = 0;
            playSound('sent');
            notify('Files Received', _receivedCount + ' item' + (_receivedCount !== 1 ? 's' : '') + ' from ' + (lastPeerName || 'J.A.R.V.I.S.'), 'sent', [200, 100, 200]);
            break;

        case 'file-start':
            if (!_rxBatchStart) _rxBatchStart = Date.now();
            await setupRecvStream(msg);
            break;

        case 'file-end':
            finalizeRecvStream(msg);
            break;
    }
}

function handleDataMsg(data, channelIndex) {
    var stream = recvStreams[channelIndex];
    if (stream) {
        stream.received += data.byteLength;
        _rxReceivedBytes += data.byteLength;
        writeChunk(stream, data);
        updateProgress(_rxReceivedBytes / _rxTotalBytes);
    } else {
        if (!pendingChunks[channelIndex]) pendingChunks[channelIndex] = [];
        pendingChunks[channelIndex].push(data);
    }
}

async function setupRecvStream(msg) {
    var ci = msg.channelIndex;
    if (recvStreams[ci]) {
        finalizeRecvStream({ channelIndex: ci, force: true });
    }

    var stream = {
        fileId: msg.fileId,
        name: msg.name,
        size: msg.size,
        mimeType: msg.mimeType,
        totalChunks: msg.totalChunks,
        received: 0,
        chunks: []
    };

    _rxTotalBytes += msg.size;
    startBgProgress();

    if (pendingChunks[ci] && pendingChunks[ci].length > 0) {
        var pend = pendingChunks[ci];
        delete pendingChunks[ci];
        for (var j = 0; j < pend.length; j++) {
            stream.received += pend[j].byteLength;
            _rxReceivedBytes += pend[j].byteLength;
            writeChunk(stream, pend[j]);
        }
    }

    recvStreams[ci] = stream;

    notify('Receiving File', msg.name + ' from ' + (lastPeerName || 'J.A.R.V.I.S.'), null, [150]);
    $('progress-section').classList.remove('hidden');
    resetProgressDisplay();
    setProgressRole(false);
    var rf = $('liquid-receiver');
    if (rf) rf.style.height = '0%';
    var pr = $('pct-receiver');
    if (pr) pr.textContent = '0%';
    _lastPct = -1;
    _throttleTimer = 0;
    $('progress-label').textContent = 'Receiving ' + msg.name;
    updateProgress(_rxTotalBytes > 0 ? _rxReceivedBytes / _rxTotalBytes : 0);
}

function writeChunk(stream, chunk) {
    stream.chunks.push(chunk);
}

function finalizeRecvStream(msg) {
    var ci = msg.channelIndex;
    var stream = recvStreams[ci];
    if (!stream) return;

    var blob = new Blob(stream.chunks, { type: stream.mimeType });
    _incomingFiles.push({ blob: blob, name: stream.name });
    doDownload(blob, stream.name);

    addReceived(stream.name, stream.size);
    renderSaveButton();
    delete recvStreams[ci];

    $('progress-label').textContent = 'Received ' + stream.name;
    updateProgress(_rxTotalBytes > 0 ? _rxReceivedBytes / _rxTotalBytes : 1);
}

function renderSaveButton() {
    var b = $('btn-save-received');
    if (!b) return;
    if (_incomingFiles.length) {
        b.classList.remove('hidden');
        b.textContent = 'Save ' + _incomingFiles.length + ' received file' + (_incomingFiles.length !== 1 ? 's' : '');
    } else {
        b.classList.add('hidden');
    }
}

function saveReceived() {
    for (var i = 0; i < _incomingFiles.length; i++) {
        doDownload(_incomingFiles[i].blob, _incomingFiles[i].name);
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function doDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 30000);
}

function addReceived(name, size) {
    _receivedCount++;
    _receivedBytes += size;
    var empty = $('received-empty');
    var text = $('received-text');
    if (empty) empty.classList.add('hidden');
    if (text) {
        text.classList.remove('hidden');
        text.innerHTML = '<span class="hit">' + _receivedCount + '</span> ' + (_receivedCount === 1 ? 'item' : 'items') + ' received \u00b7 ' + formatSize(_receivedBytes);
    }
}

function updateProgress(fraction) {
    var pct = Math.min(100, Math.round(fraction * 100));
    if (pct === _lastPct) return;
    _lastPct = pct;
    if (pct > 0 && pct < 100 && Date.now() - _throttleTimer < 100) return;
    _throttleTimer = Date.now();
    var s = $('liquid-sender');
    if (s) s.style.height = (100 - pct) + '%';
    var ps = $('pct-sender');
    if (ps) ps.textContent = pct + '%';
    var r = $('liquid-receiver');
    if (r) r.style.height = pct + '%';
    var pr = $('pct-receiver');
    if (pr) pr.textContent = pct + '%';
}

function startBgProgress() {
    if (_bgProgressTimer) return;
    _bgProgressTimer = setInterval(function() {
        try {
            if (document.visibilityState !== 'hidden') return;
            var total = _txTotalBytes > 0 ? _txTotalBytes : _rxTotalBytes;
            var got = _txTotalBytes > 0 ? _txSentBytes : _rxReceivedBytes;
            if (!total || got <= 0 || got >= total) return;
            var pct = Math.min(99, Math.round((got / total) * 100));
            notify('JARVIS Link', (_txTotalBytes > 0 ? 'Sending' : 'Receiving') + ' ' + pct + '%', null, null);
        } catch (e) {}
    }, 10000);
}
function stopBgProgress() {
    if (_bgProgressTimer) { clearInterval(_bgProgressTimer); _bgProgressTimer = 0; }
}

function showSuccess(elapsed, speed) {
    var wrap = document.querySelector('.liquid-wrap');
    if (wrap) wrap.classList.add('fade-out');
    var label = $('progress-label');
    if (label) label.textContent = '';
    var t = $('success-time'), sp = $('success-speed'), n = $('success-notification');
    if (t) t.textContent = fmtDuration(elapsed);
    if (sp) sp.textContent = fmtSpeed(speed);
    if (n) {
        n.classList.add('delayed');
        void n.offsetHeight;
        n.classList.add('show');
    }
}

function setProgressRole(sending) {
    var s = $('circle-sender'), r = $('circle-receiver'), a = document.querySelector('.liquid-arrow');
    if (!s || !r) return;
    if (sending) {
        s.style.display = ''; r.style.display = 'none';
        if (a) a.style.display = 'none';
    } else {
        s.style.display = 'none'; r.style.display = '';
        if (a) a.style.display = 'none';
    }
}

function resetProgressDisplay() {
    var wrap = document.querySelector('.liquid-wrap');
    if (wrap) { wrap.classList.remove('fade-out'); wrap.style.opacity = ''; wrap.style.transform = ''; }
    var notif = $('success-notification');
    if (notif) { notif.classList.remove('show', 'delayed'); }
    var s = $('circle-sender'), r = $('circle-receiver'), a = document.querySelector('.liquid-arrow');
    if (s) s.style.display = ''; if (r) r.style.display = ''; if (a) a.style.display = '';
}

function ensureLinked(deviceId, label) {
    return new Promise(function(resolve) {
        if (autoConnected) { resolve(); return; }
        var done = false;
        function fin() { if (!done) { done = true; resolve(); } }
        _linkCallbacks.push(fin);
        if (!reconnecting) connectToDevice(deviceId, label);
        setTimeout(fin, 26000);
    });
}

function sendToJarvis() {
    var j = findJarvisDevice();
    if (!j) {
        alert('J.A.R.V.I.S. is offline. Start J.A.R.V.I.S. on your PC first.');
        return;
    }
    _jarvisTargetId = j.deviceId;
    ensureLinked(j.deviceId, 'J.A.R.V.I.S.').then(function() {
        setTimeout(function() { selectFiles(); }, 300);
    });
}

async function connectToDevice(deviceId, label) {
    if (!DB) { alert('Network required to link. Please check your connection.'); return; }
    if (!window.RTCPeerConnection) { alert('WebRTC not supported in this browser.'); return; }
    if (reconnecting) return;
    lastPeerName = label || 'device';
    initKeepAlive();

    isHost = true;
    autoConnected = false;
    dataDCs = [];
    pendingChunks = {};
    recvStreams = {};
    stopCurrentSignaling();
    reconnecting = true;

    showScreen('connecting');
    $('connect-status').textContent = 'Linking to ' + lastPeerName + '...';

    try {
        pc = new RTCPeerConnection(CONFIG);
        pc.oniceconnectionstatechange = function() { tryConnect(); };

        ctrlDC = pc.createDataChannel('control');
        setupCtrlDC(ctrlDC);
        for (var i = 0; i < NUM_DATA_CHANNELS; i++) {
            var ch = pc.createDataChannel('data-' + i);
            setupDataDC(ch, i);
            dataDCs[i] = ch;
        }

        var offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc);

        var reqId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        currentReqRef = DB.ref('requests/' + deviceId + '/' + reqId);
        await currentReqRef.set({
            from: { deviceId: getDeviceId(), name: getDeviceName(), username: getSessionUser() },
            offer: pc.localDescription.sdp,
            createdAt: firebase.database.ServerValue.TIMESTAMP
        });

        $('connect-status').textContent = 'Waking ' + lastPeerName + '...';

        currentReqRef.on('value', function(snap) {
            var v = snap.val();
            if (!v || reqAnswered) return;
            if (v.answer) {
                reqAnswered = true;
                if (connTimer) { clearTimeout(connTimer); connTimer = null; }
                pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: v.answer }))
                    .then(function() {
                        $('connect-status').textContent = 'Linked!';
                        if (currentReqRef) { try { currentReqRef.update({ status: 'connected' }); } catch (e) {} }
                        setTimeout(function() { tryConnect(); }, 300);
                    })
                    .catch(function(err) {
                        $('connect-status').textContent = 'Link failed: ' + err.message;
                        reconnecting = false;
                        setTimeout(function() { showScreen('home'); }, 2500);
                    });
            }
        });

        connTimer = setTimeout(function() {
            if (!reqAnswered) {
                $('connect-status').textContent = 'J.A.R.V.I.S. did not answer. Make sure his app is open, then tap Send to J.A.R.V.I.S. again.';
                reconnecting = false;
                setTimeout(function() { showScreen('home'); }, 3000);
            }
        }, 20000);
    } catch (err) {
        console.error('Link error:', err);
        reconnecting = false;
        $('connect-status').textContent = 'Error: ' + err.message;
        setTimeout(function() { showScreen('home'); }, 2500);
    }
}

function listenForRequests() {
    if (!DB) return;
    var myId = getDeviceId();
    DB.ref('requests/' + myId).on('child_added', function(snap) {
        var req = snap.val();
        if (!req || !req.offer) return;
        if (req.answer || req.status === 'connected') {
            try { snap.ref.remove(); } catch (e) {}
            return;
        }
        if (!req.from || !req.from.deviceId || !req.from.username) {
            try { snap.ref.remove(); } catch (e) {}
            return;
        }
        var peer = {
            deviceId: req.from.deviceId,
            name: req.from.username,
            username: req.from.username
        };
        handleIncomingRequest(req, snap.key, peer);
    });
}

async function handleIncomingRequest(req, reqKey, peer) {
    if (pc && pc.iceConnectionState && pc.iceConnectionState !== 'new' &&
        pc.iceConnectionState !== 'failed' && pc.iceConnectionState !== 'closed') {
        return;
    }
    stopCurrentSignaling();
    lastPeerName = peer.name;
    isHost = false;
    autoConnected = false;
    dataDCs = [];
    pendingChunks = {};
    recvStreams = {};

    showScreen('connecting');
    $('connect-status').textContent = 'Linking with ' + peer.name + '...';
    playSound('scan');

    try {
        pc = new RTCPeerConnection(CONFIG);
        pc.oniceconnectionstatechange = function() { tryConnect(); };
        pc.ondatachannel = function(ev) {
            var label = ev.channel.label;
            if (label === 'control') {
                setupCtrlDC(ev.channel);
            } else if (label.indexOf('data-') === 0) {
                var idx = parseInt(label.split('-')[1], 10);
                setupDataDC(ev.channel, idx);
            }
        };

        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: req.offer }));
        var answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitForIceGathering(pc);

        recvReqRef = DB.ref('requests/' + getDeviceId() + '/' + reqKey);
        await recvReqRef.update({ answer: pc.localDescription.sdp });
        $('connect-status').textContent = 'Linking...';
    } catch (err) {
        console.error('Incoming request error:', err);
        showScreen('home');
    }
}

function disconnect() {
    if (ctrlDC) { try { ctrlDC.close(); } catch(_){} ctrlDC = null; }
    for (var i = 0; i < dataDCs.length; i++) {
        if (dataDCs[i]) { try { dataDCs[i].close(); } catch(_){} }
    }
    dataDCs = [];
    if (pc) { try { pc.close(); } catch(_){} pc = null; }
    cleanupSignalingData();
    isHost = false;
    autoConnected = false;
    fileQueue = [];
    recvStreams = {};
    pendingChunks = {};
    avgThroughput = 0;
    currentChunkSize = CHUNK_SIZE_BASE;
    _rxTotalBytes = 0;
    _rxReceivedBytes = 0;
    var fs = $('file-summary');
    if (fs) fs.classList.add('hidden');
    var bs = $('btn-send');
    if (bs) bs.classList.add('hidden');
    _receivedCount = 0;
    _receivedBytes = 0;
    _rxBatchStart = 0;
    _incomingFiles = [];
    renderSaveButton();
    resetProgressDisplay();
    releaseWakeLock();
    stopKeepAlive();
    var ps = $('progress-section');
    if (ps) ps.classList.add('hidden');
    var fi = $('file-input');
    if (fi) fi.value = '';
    var empty = $('received-empty'), text = $('received-text');
    if (empty) empty.classList.remove('hidden');
    if (text) text.classList.add('hidden');
    renderDevices();
    showScreen('home');
}

function init() {
    $('btn-jarvis-send').addEventListener('click', sendToJarvis);
    $('btn-select-files').addEventListener('click', selectFiles);
    $('file-input').addEventListener('change', onFilesSelected);
    $('btn-send').addEventListener('click', sendFiles);
    $('btn-clear-files').addEventListener('click', clearFiles);
    $('btn-disconnect').addEventListener('click', disconnect);
    var saveBtn = $('btn-save-received');
    if (saveBtn) saveBtn.addEventListener('click', saveReceived);
    $('btn-login').addEventListener('click', doLogin);
    $('login-password').addEventListener('keydown', function(e) { if (e.key === 'Enter') doLogin(); });
    $('btn-show-register').addEventListener('click', function() { showScreen('register'); });
    $('btn-register').addEventListener('click', doAddDevice);
    $('reg-password2').addEventListener('keydown', function(e) { if (e.key === 'Enter') doAddDevice(); });
    $('btn-show-login').addEventListener('click', function() { showScreen('login'); });
    $('btn-logout').addEventListener('click', doLogout);
    var notifBtn = $('btn-notif-blocked');
    if (notifBtn) notifBtn.addEventListener('click', requestNotificationPermission);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
        try { init(); } catch (e) { console.error('Init error:', e); }
    });
} else {
    try { init(); } catch (e) { console.error('Init error:', e); }
}

window.connectToDevice = connectToDevice;
window.selectFiles = selectFiles;
window.sendFiles = sendFiles;
window.sendToJarvis = sendToJarvis;
window.disconnect = disconnect;

var _appStarted = false;
function startApp() {
    showScreen('home');
    var dl = $('device-name-label');
    if (dl) dl.textContent = 'Signed in as ' + getDeviceName();
    renderDevices();
    updateNotifHint();
    publishPresence();
    if (!_presenceTimer) _presenceTimer = setInterval(heartbeatPresence, 25000);
    if (_appStarted) return;
    _appStarted = true;
    listenForRequests();
    listenForPresence();
    if ('Notification' in window && window.Notification && typeof window.Notification.addEventListener === 'function') {
        window.Notification.addEventListener('permissionchange', updateNotifHint);
    }
    var armedKeepAlive = false;
    function armKeepAlive() {
        if (armedKeepAlive) return;
        armedKeepAlive = true;
        initKeepAlive();
        startKeepAlive();
    }
    document.addEventListener('pointerdown', armKeepAlive);
    document.addEventListener('touchstart', armKeepAlive);
    document.addEventListener('keydown', armKeepAlive);
    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'visible') updateNotifHint();
        if (state === 'connected') {
            if (document.visibilityState === 'visible') {
                requestWakeLock();
            } else {
                startKeepAlive();
            }
        }
    });
}

(function boot() {
    if (getSessionUser()) {
        startApp();
    } else {
        showScreen('login');
        setTimeout(function() { try { $('login-username').focus(); } catch (e) {} }, 60);
    }
})();

try {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(function() {});
    }
} catch (e) {}
