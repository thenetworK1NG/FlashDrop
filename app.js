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
var SCAN_DELAY = 500;
var ADAPT_EMA_ALPHA = 0.3;

var state = 'home';
var pc = null;
var ctrlDC = null;
var dataDCs = [];
var isHost = false;
var mediaStream = null;
var scanTimer = null;
var fileQueue = [];
var qrHost = null;
var qrAnswer = null;
var recvStreams = {};
var pendingChunks = {};
var autoConnected = false;
var avgThroughput = 0;
var currentChunkSize = CHUNK_SIZE_BASE;

var _txTotalBytes = 0;
var _txSentBytes = 0;
var _rxTotalBytes = 0;
var _rxReceivedBytes = 0;
var _receivedCount = 0;
var _receivedBytes = 0;
var _txStart = 0;
var _rxBatchStart = 0;
var _lastPct = -1;
var _throttleTimer = 0;

function $(id) { return document.getElementById(id); }

// ===================== FIREBASE SIGNALING =====================

var FB_CONFIG = {
    apiKey: 'AIzaSyAwwm1NYa-jaKNqmJCGzKD6Blyq5VUVWuc',
    authDomain: 'share-it-414ed.firebaseapp.com',
    databaseURL: 'https://share-it-414ed-default-rtdb.firebaseio.com',
    projectId: 'share-it-414ed',
    storageBucket: 'share-it-414ed.firebasestorage.app',
    messagingSenderId: '280437631286',
    appId: '1:280437631286:web:ed636e0fa0a4c7c5d56b97'
};
var DB = null;
try {
    if (typeof firebase !== 'undefined' && firebase.initializeApp) {
        firebase.initializeApp(FB_CONFIG);
        DB = firebase.database();
    }
} catch (e) { console.warn('Firebase init failed:', e); DB = null; }

// ---- device identity ----
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
    try { DEVICE_ID = localStorage.getItem('qs.deviceId'); } catch (e) {}
    if (!DEVICE_ID) {
        DEVICE_ID = genUuid();
        try { localStorage.setItem('qs.deviceId', DEVICE_ID); } catch (e) {}
    }
    return DEVICE_ID;
}
function getDeviceName() {
    if (DEVICE_NAME) return DEVICE_NAME;
    try { DEVICE_NAME = localStorage.getItem('qs.deviceName'); } catch (e) {}
    if (!DEVICE_NAME) {
        DEVICE_NAME = 'Device-' + getDeviceId().slice(0, 4).toUpperCase();
        try { localStorage.setItem('qs.deviceName', DEVICE_NAME); } catch (e) {}
    }
    return DEVICE_NAME;
}

// ---- remembered devices (pairs) ----
var PAIRS_KEY = 'qs.pairs';
function getPairs() {
    try { return JSON.parse(localStorage.getItem(PAIRS_KEY)) || {}; } catch (e) { return {}; }
}
function savePairs(p) { try { localStorage.setItem(PAIRS_KEY, JSON.stringify(p)); } catch (e) {} }
function recordPair(peerId, name) {
    if (!peerId || peerId === getDeviceId()) return;
    var pairs = getPairs();
    pairs[peerId] = { peerId: peerId, name: name || 'Unknown device', lastConnected: Date.now() };
    savePairs(pairs);
    renderRecent();
}
function formatTimeAgo(ts) {
    var diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
}
function renderRecent() {
    var sec = $('recent-section'), wrap = $('recent-list');
    if (!sec || !wrap) return;
    var pairs = getPairs();
    var keys = Object.keys(pairs);
    if (keys.length === 0) { sec.classList.add('hidden'); return; }
    sec.classList.remove('hidden');
    wrap.innerHTML = '';
    keys.sort(function(a, b) { return pairs[b].lastConnected - pairs[a].lastConnected; });
    for (var i = 0; i < keys.length; i++) {
        (function(p) {
            var row = document.createElement('div');
            row.className = 'recent-row';
            var info = document.createElement('div');
            info.className = 'recent-info';
            var nm = document.createElement('div');
            nm.className = 'recent-name';
            nm.textContent = p.name;
            var tm = document.createElement('div');
            tm.className = 'recent-time';
            tm.textContent = 'Connected ' + formatTimeAgo(p.lastConnected);
            info.appendChild(nm);
            info.appendChild(tm);
            var btn = document.createElement('button');
            btn.className = 'reconnect-btn';
            btn.textContent = 'Connect';
            btn.addEventListener('click', function() { reconnectTo(p.peerId); });
            row.appendChild(info);
            row.appendChild(btn);
            wrap.appendChild(row);
        })(pairs[keys[i]]);
    }
}

// ---- signaling state ----
var roomCode = null;
var currentRoomRef = null;
var currentReqRef = null;
var recvReqRef = null;
var answered = false;
var reqAnswered = false;
var reconnecting = false;
var connTimer = null;

var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode(len) {
    var s = '';
    for (var i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return s;
}
function uniqueRoomCode() {
    return new Promise(function(resolve) {
        if (!DB) { resolve(null); return; }
        (function attempt() {
            var code = genCode(4);
            DB.ref('rooms/' + code).once('value').then(function(snap) {
                if (snap.exists()) attempt();
                else resolve(code);
            }).catch(function() { resolve(null); });
        })();
    });
}
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

// ===================== QR CODE RENDERING =====================

function renderQR(elementId, text) {
    var el = $(elementId);
    el.innerHTML = '';
    if (typeof qrcode === 'undefined') {
        el.innerHTML = '<div style="color:#333;padding:20px;text-align:center">QR library not loaded.</div>';
        console.error('qrcode library not found');
        return;
    }
    try {
        var qr = qrcode(0, 'L');
        qr.addData(text);
        qr.make();
        var count = qr.getModuleCount();
        var margin = 4;
        var cellSize = Math.max(4, Math.floor(440 / count));
        var px = (count + margin * 2) * cellSize;
        var c = document.createElement('canvas');
        c.width = px;
        c.height = px;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, px, px);
        ctx.fillStyle = '#000000';
        for (var r = 0; r < count; r++) {
            for (var col = 0; col < count; col++) {
                if (qr.isDark(r, col)) {
                    ctx.fillRect((col + margin) * cellSize, (r + margin) * cellSize, cellSize, cellSize);
                }
            }
        }
        var img = document.createElement('img');
        img.src = c.toDataURL();
        img.style.cssText = 'display:block;width:100%;height:auto;max-width:' + px + 'px';
        el.appendChild(img);
        el.style.cssText = 'background:#fff;padding:16px;display:flex;align-items:center;justify-content:center';
    } catch (e) {
        console.error('QR render error:', e);
        el.innerHTML = '<div style="color:#333;padding:16px;font-size:10px;word-break:break-all;max-width:256px">Data: ' + text.substring(0, 60) + '...</div>';
    }
}

// ===================== WEBRTC =====================

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
    playSound('granted');
    showScreen('connected');
    try { ctrlDC.send(JSON.stringify({ type: 'hello', deviceId: getDeviceId(), name: getDeviceName() })); } catch (e) {}
    if (currentRoomRef) { try { currentRoomRef.update({ status: 'connected' }); } catch (e) {} }
    if (currentReqRef) { try { currentReqRef.update({ status: 'connected' }); } catch (e) {} }
}

async function startHosting() {
    if (!window.RTCPeerConnection) { alert('WebRTC not supported in this browser.'); return; }
    isHost = true;
    autoConnected = false;
    dataDCs = [];
    pendingChunks = {};
    recvStreams = {};
    stopCurrentSignaling();
    showScreen('hosting');
    $('host-status').textContent = 'Setting up...';
    $('btn-scan-answer').classList.add('hidden');
    $('btn-copy-link').classList.add('hidden');
    $('host-code').textContent = '····';
    if (qrHost) { qrHost.clear(); qrHost = null; }

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

        var sdp = pc.localDescription.sdp;

        if (DB) {
            try {
                var code = await uniqueRoomCode();
                if (code) {
                    roomCode = code;
                    currentRoomRef = DB.ref('rooms/' + code);
                    await currentRoomRef.set({
                        host: { deviceId: getDeviceId(), name: getDeviceName() },
                        offer: sdp,
                        status: 'waiting',
                        createdAt: firebase.database.ServerValue.TIMESTAMP
                    });
                    $('host-code').textContent = code;
                    $('btn-copy-link').classList.remove('hidden');
                    currentRoomRef.on('value', function(snap) {
                        var v = snap.val();
                        if (!v || answered) return;
                        if (v.guest && v.guest.answer) {
                            answered = true;
                            hostGotAnswer(v.guest.answer);
                        }
                    });
                    $('host-status').textContent = 'Code: ' + code + ' · or scan the QR below';
                } else {
                    $('host-status').textContent = 'QR mode (no network)';
                }
            } catch (e) {
                console.warn('Room create failed, falling back to QR:', e);
                $('host-status').textContent = 'QR mode (Firebase write failed)';
            }
        } else {
            $('host-status').textContent = 'QR mode (Firebase unavailable)';
        }

        renderQR('qrcode-host', JSON.stringify({ t: 'o', s: sdp, room: roomCode || '' }));
        $('btn-scan-answer').classList.remove('hidden');
    } catch (err) {
        console.error('Hosting error:', err);
        $('host-status').textContent = 'Error: ' + err.message;
    }
}

async function hostGotAnswer(sdp) {
    try {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: sdp }));
        $('host-status').textContent = 'Connected!';
        if (currentRoomRef) { try { currentRoomRef.update({ status: 'connected' }); } catch (e) {} }
        setTimeout(function() { tryConnect(); }, 300);
    } catch (err) {
        $('host-status').textContent = 'Connection failed: ' + err.message;
        setTimeout(function() { showScreen('home'); }, 2500);
    }
}

function startJoining() {
    if (!window.RTCPeerConnection) { alert('WebRTC not supported in this browser.'); return; }
    stopCurrentSignaling();
    showScreen('code');
    $('code-input').value = '';
    setTimeout(function() { try { $('code-input').focus(); } catch (e) {} }, 50);
}

async function openScanner() {
    if (!navigator.mediaDevices) { alert('Camera access not supported in this browser.'); return; }
    showScreen('scanning');
    $('scan-status').textContent = 'Scan the QR code from the host device';
    try { await initCamera(); } catch (e) {
        console.error('Camera init failed:', e);
        alert('Could not open camera: ' + e.message);
        showScreen('code');
    }
}

async function joinByCode(code) {
    code = (code || '').trim().toUpperCase();
    if (!code) { alert('Please enter the share code.'); return; }
    if (!DB) { alert('No network available. Please use the QR scan option instead.'); return; }
    showScreen('connecting');
    $('connect-status').textContent = 'Finding room...';
    try {
        var snap = await DB.ref('rooms/' + code).once('value');
        var room = snap.val();
        if (!room || !room.offer) {
            $('connect-status').textContent = 'Invalid code. Please check and try again.';
            setTimeout(function() { showScreen('code'); }, 2200);
            return;
        }
        await joinRoomWithOffer(room, code);
    } catch (err) {
        console.error('Join error:', err);
        $('connect-status').textContent = 'Error: ' + err.message;
        setTimeout(function() { showScreen('code'); }, 2500);
    }
}

async function joinRoomWithOffer(room, code) {
    isHost = false;
    autoConnected = false;
    dataDCs = [];
    pendingChunks = {};
    recvStreams = {};
    stopCurrentSignaling();

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

    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: room.offer }));
    var answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGathering(pc);

    currentRoomRef = DB.ref('rooms/' + code);
    roomCode = code;
    await currentRoomRef.update({
        guest: { deviceId: getDeviceId(), name: getDeviceName(), answer: pc.localDescription.sdp }
    });
    $('connect-status').textContent = 'Connecting...';

    connTimer = setTimeout(function() {
        if (!autoConnected) {
            $('connect-status').textContent = 'Could not connect. Try again or scan the QR.';
            setTimeout(function() { showScreen('code'); }, 2200);
        }
    }, 25000);
}

async function hostScanAnswer() {
    showScreen('scanning');
    $('scan-status').textContent = 'Scan the reply QR from your friend\'s device';
    try { await initCamera(); } catch (e) {
        console.error('Camera init failed:', e);
        alert('Could not open camera: ' + e.message);
        showScreen('home');
    }
}

// ===================== CAMERA =====================

async function initCamera() {
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
        });
        const video = $('camera-view');
        video.srcObject = mediaStream;
        await video.play();
        startScanLoop();
    } catch (err) {
        alert('Camera access is required to scan QR codes.\nPlease grant permission and try again.');
        showScreen('home');
    }
}

function stopCamera() {
    if (mediaStream) {
        mediaStream.getTracks().forEach(function(t) { t.stop(); });
        mediaStream = null;
    }
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    $('camera-view').srcObject = null;
}

function startScanLoop() {
    const video = $('camera-view');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    function scan() {
        if (state !== 'scanning') return;
        if (video.readyState === 4) {
            canvas.width = video.videoWidth || 640;
            canvas.height = video.videoHeight || 480;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imageData.data, imageData.width, imageData.height);
            if (code && code.data) {
                try {
                    const parsed = JSON.parse(code.data);
                    handleScan(parsed);
                    return;
                } catch (e) {}
            }
        }
        scanTimer = setTimeout(scan, SCAN_DELAY);
    }
    scanTimer = setTimeout(scan, SCAN_DELAY);
}

async function handleScan(data) {
    stopCamera();
    playSound('scan');

    if (data.t === 'o' && !isHost) {
        showScreen('connecting');
        $('connect-status').textContent = 'Connecting...';

        try {
            pc = new RTCPeerConnection(CONFIG);
            pc.oniceconnectionstatechange = function() { tryConnect(); };
            pc.ondatachannel = function(ev) {
                var label = ev.channel.label;
                if (label === 'control') {
                    setupCtrlDC(ev.channel);
                } else if (label.startsWith('data-')) {
                    var idx = parseInt(label.split('-')[1], 10);
                    setupDataDC(ev.channel, idx);
                }
            };

            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.s }));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await waitForIceGathering(pc);

            var answerData = JSON.stringify({ t: 'a', s: pc.localDescription.sdp });
            showScreen('show-answer');
            renderQR('qrcode-answer', answerData);
            $('answer-status').textContent = 'Show this to the host device';
        } catch (err) {
            $('connect-status').textContent = 'Error: ' + err.message;
            setTimeout(function() { showScreen('home'); }, 2500);
        }

    } else if (data.t === 'a' && isHost) {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.s }));
            $('host-status').textContent = 'Connected!';
            setTimeout(function() { tryConnect(); }, 500);
        } catch (err) {
            $('host-status').textContent = 'Connection failed: ' + err.message;
            setTimeout(function() { showScreen('home'); }, 2500);
        }
    }
}

// ===================== FILE SELECTION =====================

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

// ===================== SEND ENGINE =====================

async function sendFiles() {
    if (!ctrlDC || ctrlDC.readyState !== 'open') return alert('Not connected to any device.');
    var openDCs = dataDCs.filter(function(c) { return c && c.readyState === 'open'; });
    if (openDCs.length === 0) return alert('No data channels available.');

    if (fileQueue.length === 0) return;

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
    playSound('sent');
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

// ===================== RECEIVE ENGINE =====================

async function handleCtrlMsg(data) {
    try {
        var msg = JSON.parse(data);
    } catch (_) { return; }

    switch (msg.type) {
        case 'hello':
            if (msg.deviceId && msg.deviceId !== getDeviceId()) recordPair(msg.deviceId, msg.name);
            break;

        case 'transfer-complete':
            if (_rxBatchStart) {
                var rxElapsed = (Date.now() - _rxBatchStart) / 1000;
                var rxSpeed = rxElapsed > 0 ? (_rxReceivedBytes * 8) / rxElapsed : 0;
                showSuccess(rxElapsed, rxSpeed);
            }
            _rxBatchStart = 0;
            playSound('sent');
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
    dlBlob(blob, stream.name);

    addReceived(stream.name, stream.size);
    delete recvStreams[ci];

    $('progress-label').textContent = 'Received ' + stream.name;
    updateProgress(_rxTotalBytes > 0 ? _rxReceivedBytes / _rxTotalBytes : 1);
}

function dlBlob(blob, name) {
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
        text.innerHTML = '<span class="hit">' + _receivedCount + '</span> ' + (_receivedCount === 1 ? 'item' : 'items') + ' received · ' + formatSize(_receivedBytes);
    }
}

// ===================== PROGRESS UI =====================

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

// ===================== RECONNECT (REMEMBERED DEVICES) =====================

async function reconnectTo(peerId) {
    if (!DB) { alert('Network required to reconnect. Please use Send/Receive instead.'); return; }
    if (!window.RTCPeerConnection) { alert('WebRTC not supported in this browser.'); return; }
    if (reconnecting) return;
    var pairs = getPairs();
    var peer = pairs[peerId];
    if (!peer) { renderRecent(); return; }

    isHost = true;
    autoConnected = false;
    dataDCs = [];
    pendingChunks = {};
    recvStreams = {};
    stopCurrentSignaling();
    reconnecting = true;

    showScreen('connecting');
    $('connect-status').textContent = 'Connecting to ' + peer.name + '...';

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
        currentReqRef = DB.ref('requests/' + peerId + '/' + reqId);
        await currentReqRef.set({
            from: { deviceId: getDeviceId(), name: getDeviceName() },
            offer: pc.localDescription.sdp,
            createdAt: firebase.database.ServerValue.TIMESTAMP
        });
        $('connect-status').textContent = 'Waking ' + peer.name + '...';

        currentReqRef.on('value', function(snap) {
            var v = snap.val();
            if (!v || reqAnswered) return;
            if (v.answer) {
                reqAnswered = true;
                if (connTimer) { clearTimeout(connTimer); connTimer = null; }
                pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: v.answer }))
                    .then(function() {
                        $('connect-status').textContent = 'Connected!';
                        if (currentReqRef) { try { currentReqRef.update({ status: 'connected' }); } catch (e) {} }
                        setTimeout(function() { tryConnect(); }, 300);
                    })
                    .catch(function(err) {
                        $('connect-status').textContent = 'Connection failed: ' + err.message;
                        reconnecting = false;
                        setTimeout(function() { showScreen('home'); }, 2500);
                    });
            }
        });

        connTimer = setTimeout(function() {
            if (!reqAnswered) {
                $('connect-status').textContent = 'Device not available. Make sure the other app is open, then try again.';
                reconnecting = false;
                setTimeout(function() { showScreen('home'); }, 2500);
            }
        }, 20000);
    } catch (err) {
        console.error('Reconnect error:', err);
        reconnecting = false;
        $('connect-status').textContent = 'Error: ' + err.message;
        setTimeout(function() { showScreen('home'); }, 2500);
    }
}

function listenForReconnectRequests() {
    if (!DB) return;
    var myId = getDeviceId();
    DB.ref('requests/' + myId).on('child_added', function(snap) {
        var req = snap.val();
        if (!req || !req.offer) return;
        if (req.answer || req.status === 'connected') {
            try { snap.ref.remove(); } catch (e) {}
            return;
        }
        var pairs = getPairs();
        var fromId = req.from && req.from.deviceId;
        var peer = fromId ? pairs[fromId] : null;
        if (!peer) {
            try { snap.ref.remove(); } catch (e) {}
            return;
        }
        handleIncomingRequest(req, snap.key, peer);
    });
}

async function handleIncomingRequest(req, reqKey, peer) {
    if (pc && pc.iceConnectionState && pc.iceConnectionState !== 'new' &&
        pc.iceConnectionState !== 'failed' && pc.iceConnectionState !== 'closed') {
        return;
    }
    stopCurrentSignaling();
    isHost = false;
    autoConnected = false;
    dataDCs = [];
    pendingChunks = {};
    recvStreams = {};

    showScreen('connecting');
    $('connect-status').textContent = 'Reconnecting with ' + peer.name + '...';
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
        $('connect-status').textContent = 'Connecting...';
    } catch (err) {
        console.error('Incoming request error:', err);
        showScreen('home');
    }
}

function copyShareLink() {
    if (!roomCode) return;
    var link = location.href.split('#')[0] + '#c=' + roomCode;
    var done = function() {
        $('btn-copy-link').textContent = '✓ Link Copied';
        setTimeout(function() { $('btn-copy-link').textContent = '🔗 Copy Share Link'; }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(done).catch(function() { fallbackCopy(link, done); });
    } else fallbackCopy(link, done);
}
function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    document.body.removeChild(ta);
}

// ===================== CONNECTION LIFECYCLE =====================

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
    $('btn-send').classList.add('hidden');
    _receivedCount = 0;
    _receivedBytes = 0;
    _rxBatchStart = 0;
    resetProgressDisplay();
    if (qrHost) { qrHost.clear(); qrHost = null; }
    if (qrAnswer) { qrAnswer.clear(); qrAnswer = null; }
    stopCamera();
    $('progress-section').classList.add('hidden');
    $('file-input').value = '';
    var empty = $('received-empty'), text = $('received-text');
    if (empty) empty.classList.remove('hidden');
    if (text) text.classList.add('hidden');
    renderRecent();
    showScreen('home');
}

// ===================== INIT =====================

function init() {
    $('btn-scan-answer').addEventListener('click', hostScanAnswer);
    $('btn-cancel-scan').addEventListener('click', function() { stopCamera(); showScreen('home'); });
    $('btn-back-host').addEventListener('click', disconnect);
    $('btn-select-files').addEventListener('click', selectFiles);
    $('file-input').addEventListener('change', onFilesSelected);
    $('btn-send').addEventListener('click', sendFiles);
    $('btn-clear-files').addEventListener('click', clearFiles);
    $('btn-disconnect').addEventListener('click', disconnect);
    $('btn-connect-code').addEventListener('click', function() { joinByCode($('code-input').value); });
    $('code-input').addEventListener('keydown', function(e) { if (e.key === 'Enter') joinByCode($('code-input').value); });
    $('code-input').addEventListener('input', function() { this.value = this.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 4); });
    $('btn-scan-qr').addEventListener('click', openScanner);
    $('btn-back-code').addEventListener('click', function() { stopCamera(); showScreen('home'); });
    $('btn-copy-link').addEventListener('click', copyShareLink);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
        try { init(); } catch (e) { console.error('Init error:', e); }
    });
} else {
    try { init(); } catch (e) { console.error('Init error:', e); }
}

window.startHosting = startHosting;
window.startJoining = startJoining;
window.selectFiles = selectFiles;
window.sendFiles = sendFiles;
window.disconnect = disconnect;
window.reconnectTo = reconnectTo;

(function boot() {
    var dl = $('device-name-label');
    if (dl) dl.textContent = 'You are ' + getDeviceName();
    renderRecent();
    listenForReconnectRequests();
    try {
        var hm = location.hash.match(/[#&]c=([A-Za-z0-9]+)/);
        if (hm) {
            startJoining();
            setTimeout(function() { joinByCode(hm[1]); }, 400);
        }
    } catch (e) {}
})();

try {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(function() {});
    }
} catch (e) {}
