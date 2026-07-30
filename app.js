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
var CHUNK_SIZE = 65536;      // 64KB base (was 16KB)
var MAX_CHUNK = 524288;      // 512KB ceiling
var BUF_TARGET = 1048576;    // 1MB send buffer target
var BUF_LOW = 262144;        // Resume sending at 256KB
var SCAN_DELAY = 500;
var ICE_TIMEOUT = 200; // 200ms timeout for ICE gathering (shorter → smaller SDP → less dense QR)

var state = 'home';
var pc = null;
var dc = null;
var isHost = false;
var mediaStream = null;
var scanTimer = null;
var fileQueue = [];
var qrHost = null;
var qrAnswer = null;
var recvBuffer = null;
var autoConnected = false;

function $(id) { return document.getElementById(id); }

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

function playSound(name) {
    try {
        var a = new Audio('sound/' + name + '.mp3');
        a.volume = 0.6;
        a.play().catch(function() {});
    } catch (e) {}
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

        console.log('QR rendered, ' + count + 'x' + count + ' modules, canvas=' + px + 'x' + px + ', displayed at container width');
    } catch (e) {
        console.error('QR render error:', e);
        el.innerHTML = '<div style="color:#333;padding:16px;font-size:10px;word-break:break-all;max-width:256px">Data: ' + text.substring(0, 60) + '...</div>';
    }
}

// ===================== WEBRTC =====================

function setupDC(channel) {
    dc = channel;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
        if (!autoConnected) tryConnect();
    };
    dc.onmessage = e => handleMsg(e.data);
    dc.onerror = e => console.error('DC error', e);
    dc.onclose = () => {
        if (state === 'connected') {
            alert('Connection closed');
            disconnect();
        }
    };
}

function tryConnect() {
    if (!dc || dc.readyState !== 'open') return;
    if (!pc || (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed')) return;
    if (autoConnected) return;
    autoConnected = true;
    playSound('granted');
    showScreen('connected');
}

async function startHosting() {
    console.log('startHosting called');
    if (!window.RTCPeerConnection) { alert('WebRTC not supported in this browser.'); return; }
    isHost = true;
    autoConnected = false;
    showScreen('hosting');
    $('host-status').textContent = 'Setting up...';
    $('btn-scan-answer').classList.add('hidden');
    if (qrHost) { qrHost.clear(); qrHost = null; }

    try {
        console.log('Creating RTCPeerConnection...');
        pc = new RTCPeerConnection(CONFIG);
        pc.oniceconnectionstatechange = function() { console.log('ICE state:', pc.iceConnectionState); tryConnect(); };

        var channel = pc.createDataChannel('transfer');
        setupDC(channel);

        console.log('Creating offer...');
        var offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log('Waiting for ICE gathering...');
        await waitForIceGathering(pc);

        var sdp = pc.localDescription.sdp;
        console.log('Offer SDP length:', sdp.length);
        var data = JSON.stringify({ t: 'o', s: sdp });
        renderQR('qrcode-host', data);

        $('host-status').textContent = 'Ask your friend to scan this QR code';
        $('btn-scan-answer').classList.remove('hidden');
        console.log('Hosting ready');
    } catch (err) {
        console.error('Hosting error:', err);
        $('host-status').textContent = 'Error: ' + err.message;
    }
}

async function startJoining() {
    console.log('startJoining called');
    if (!navigator.mediaDevices) { alert('Camera access not supported in this browser.'); return; }
    if (!window.RTCPeerConnection) { alert('WebRTC not supported in this browser.'); return; }
    isHost = false;
    autoConnected = false;
    showScreen('scanning');
    $('scan-status').textContent = 'Scan the QR code from the host device';
    try { await initCamera(); } catch (e) {
        console.error('Camera init failed:', e);
        alert('Could not open camera: ' + e.message);
        showScreen('home');
    }
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
        mediaStream.getTracks().forEach(t => t.stop());
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
                console.log('QR scanned, data length:', code.data.length);
                try {
                    const parsed = JSON.parse(code.data);
                    console.log('QR parsed:', parsed.type);
                    handleScan(parsed);
                    return;
                } catch (e) {
                    console.error('QR parse fail:', e.message);
                }
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
            pc.oniceconnectionstatechange = () => tryConnect();
            pc.ondatachannel = ev => setupDC(ev.channel);

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
            setTimeout(() => showScreen('home'), 2500);
        }

    } else if (data.t === 'a' && isHost) {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.s }));
            $('host-status').textContent = 'Connected!';
            setTimeout(() => tryConnect(), 500);
        } catch (err) {
            $('host-status').textContent = 'Connection failed: ' + err.message;
            setTimeout(() => showScreen('home'), 2500);
        }
    }
}

// ===================== FILE TRANSFER =====================

var _receivedCount = 0;
var _receivedBytes = 0;
var _txStart = 0;
var _rxBatchStart = 0;

function selectFiles() { $('file-input').click(); }

function onFilesSelected(e) {
    const files = Array.from(e.target.files);
    fileQueue.push(...files);
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
    if (!dc || dc.readyState !== 'open') return alert('Not connected to any device.');
    if (fileQueue.length === 0) return;

    const files = [...fileQueue];
    fileQueue = [];
    renderSummary();
    $('btn-send').classList.add('hidden');
    $('progress-section').classList.remove('hidden');
    resetProgressDisplay();
    // Reset progress circles
    var sFill = $('liquid-sender'), rFill = $('liquid-receiver');
    if (sFill) sFill.style.height = '100%';
    if (rFill) rFill.style.height = '0%';
    var ps = $('pct-sender'), pr = $('pct-receiver');
    if (ps) ps.textContent = '0%';
    if (pr) pr.textContent = '0%';
    _lastPct = -1;
    _throttleTimer = 0;
    // Hide send summary since files are being sent
    var fs = $('file-summary');
    if (fs) fs.classList.add('hidden');

    _txStart = Date.now();
    for (const file of files) {
        await sendSingleFile(file);
    }
    var elapsed = (Date.now() - _txStart) / 1000;
    var totalBytes = files.reduce(function(s, f) { return s + f.size; }, 0);
    var speed = elapsed > 0 ? (totalBytes * 8) / elapsed : 0;
    dc.send(JSON.stringify({ type: 'transfer-complete', elapsed: elapsed, speed: speed }));
    showSuccess(elapsed, speed);
    playSound('sent');
}

// ===================== ADAPTIVE STREAMING ENGINE =====================
// Uses bufferedAmount-based backpressure for zero-delay flow control.
// No artificial setTimeout bottlenecks — runs at wire speed.

var throughput = { start: 0, bytes: 0, current: 0 };

function fmtSpeed(bps) {
    if (bps < 1e6) return (bps / 1e3).toFixed(0) + ' Kbps';
    if (bps < 1e9) return (bps / 1e6).toFixed(1) + ' Mbps';
    return (bps / 1e9).toFixed(2) + ' Gbps';
}

async function waitBufferDrain() {
    if (!dc || dc.readyState !== 'open') return;
    if (dc.bufferedAmount <= BUF_LOW) return;
    return new Promise(r => {
        dc.bufferedAmountLowThreshold = BUF_LOW;
        dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; r(); };
        setTimeout(r, 500);
    });
}

async function sendSingleFile(file) {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const fileId = Date.now() + '-' + Math.random().toString(36).substr(2, 6);

    dc.send(JSON.stringify({
        type: 'file-start', fileId,
        name: file.name, size: file.size,
        mimeType: file.type || 'application/octet-stream',
        totalChunks
    }));

    $('progress-label').textContent = 'Sending ' + file.name;
    updateProgress(0);

    let offset = 0;
    throughput.start = Date.now();
    throughput.bytes = 0;

    for (let i = 0; i < totalChunks; i++) {
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const blob = file.slice(offset, end);
        const buf = await blob.arrayBuffer();
        dc.send(buf);
        offset = end;
        throughput.bytes += buf.byteLength;
        updateProgress((i + 1) / totalChunks);
        if (dc.bufferedAmount >= BUF_TARGET) await waitBufferDrain();
    }

    dc.send(JSON.stringify({ type: 'file-end', fileId, name: file.name }));
    updateProgress(1);
    $('progress-label').textContent = 'Sent ' + file.name;
}

function handleMsg(data) {
    if (typeof data === 'string') {
        try {
            const msg = JSON.parse(data);
            switch (msg.type) {
                case 'transfer-complete':
                    if (_rxBatchStart) {
                        var rxElapsed = (Date.now() - _rxBatchStart) / 1000;
                        var rxSpeed = rxElapsed > 0 ? (_receivedBytes * 8) / rxElapsed : 0;
                        showSuccess(rxElapsed, rxSpeed);
                    }
                    _rxBatchStart = 0;
                    playSound('sent');
                    break;
                case 'file-start':
                    if (!_rxBatchStart) _rxBatchStart = Date.now();
                    recvBuffer = {
                        fileId: msg.fileId, name: msg.name, size: msg.size,
                        mimeType: msg.mimeType, chunks: [], received: 0,
                        totalChunks: msg.totalChunks, rxStart: Date.now()
                    };
                    $('progress-section').classList.remove('hidden');
                    resetProgressDisplay();
                    // Reset receiver circle, sender stays full
                    var rf = $('liquid-receiver');
                    if (rf) rf.style.height = '0%';
                    var pr = $('pct-receiver');
                    if (pr) pr.textContent = '0%';
                    _lastPct = -1;
                    _throttleTimer = 0;
                    $('progress-label').textContent = 'Receiving ' + msg.name;
                    updateProgress(0);
                    break;
                case 'file-end':
                    if (recvBuffer) {
                        const blob = new Blob(recvBuffer.chunks, { type: recvBuffer.mimeType });
                        dlBlob(blob, recvBuffer.name);
                        addReceived(recvBuffer.name, recvBuffer.size);
                        updateProgress(1);
                        $('progress-label').textContent = 'Received ' + recvBuffer.name;
                        recvBuffer = null;
                    }
                    break;
            }
        } catch (_) {}
    } else if (data instanceof ArrayBuffer) {
        if (recvBuffer) {
            recvBuffer.chunks.push(data);
            recvBuffer.received += data.byteLength;
            updateProgress(recvBuffer.received / recvBuffer.size);
        }
    }
}

function dlBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
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

var _lastPct = -1;
var _throttleTimer = 0;

function updateProgress(fraction) {
    var pct = Math.min(100, Math.round(fraction * 100));
    if (pct === _lastPct) return;
    _lastPct = pct;
    // Always update 0% and 100%; throttle intermediate to 100ms for smooth waves
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

function fmtDuration(sec) {
    if (sec < 1) return (sec * 1000).toFixed(0) + 'ms';
    if (sec < 60) return sec.toFixed(1) + 's';
    var m = Math.floor(sec / 60);
    var s = (sec % 60).toFixed(0);
    return m + 'm ' + s + 's';
}

function showSuccess(elapsed, speed) {
    var wrap = document.querySelector('.liquid-wrap');
    if (wrap) wrap.classList.add('fade-out');
    $('progress-label').textContent = '';
    setTimeout(function() {
        $('success-time').textContent = fmtDuration(elapsed);
        $('success-speed').textContent = fmtSpeed(speed);
        $('success-notification').classList.add('show');
    }, 480);
}

function resetProgressDisplay() {
    var wrap = document.querySelector('.liquid-wrap');
    if (wrap) { wrap.classList.remove('fade-out'); wrap.style.opacity = ''; wrap.style.transform = ''; }
    var notif = $('success-notification');
    if (notif) notif.classList.remove('show');
}

function disconnect() {
    if (dc) { try { dc.close(); } catch(_){} dc = null; }
    if (pc) { try { pc.close(); } catch(_){} pc = null; }
    isHost = false;
    autoConnected = false;
    fileQueue = [];
    var fs = $('file-summary');
    if (fs) fs.classList.add('hidden');
    $('btn-send').classList.add('hidden');
    _receivedCount = 0;
    _receivedBytes = 0;
    _rxBatchStart = 0;
    resetProgressDisplay();
    recvBuffer = null;
    if (qrHost) { qrHost.clear(); qrHost = null; }
    if (qrAnswer) { qrAnswer.clear(); qrAnswer = null; }
    stopCamera();
    $('progress-section').classList.add('hidden');
    $('file-input').value = '';
    var empty = $('received-empty'), text = $('received-text');
    if (empty) empty.classList.remove('hidden');
    if (text) text.classList.add('hidden');
    showScreen('home');
}

// ===================== INIT =====================
function init() {
    console.log('QuickShare initializing...');
    var b = $('btn-host');
    if (!b) {
        console.error('Critical: btn-host not found. App cannot initialize.');
        return;
    }
    // btn-host and btn-join use inline onclick in HTML; addEventListener not needed here
    $('btn-scan-answer').addEventListener('click', hostScanAnswer);
    $('btn-cancel-scan').addEventListener('click', function() { stopCamera(); showScreen('home'); });
    $('btn-back-host').addEventListener('click', disconnect);
    $('btn-select-files').addEventListener('click', selectFiles);
    $('file-input').addEventListener('change', onFilesSelected);
    $('btn-send').addEventListener('click', sendFiles);
    $('btn-clear-files').addEventListener('click', clearFiles);
    $('btn-disconnect').addEventListener('click', disconnect);
    console.log('QuickShare initialized successfully');
}

// Support both DOMContentLoaded and direct execution
// (scripts at end of body may run after DOM is ready)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
        try { init(); } catch (e) { console.error('Init error:', e); }
    });
} else {
    try { init(); } catch (e) { console.error('Init error:', e); }
}

// Explicitly expose entry points for inline onclick
window.startHosting = startHosting;
window.startJoining = startJoining;
window.selectFiles = selectFiles;
window.sendFiles = sendFiles;
window.disconnect = disconnect;

// Register service worker (in try-catch for file:// safety)
try {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(function() {});
    }
} catch (e) {
    console.warn('SW registration not supported:', e);
}
