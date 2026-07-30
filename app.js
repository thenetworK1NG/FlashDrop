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
var CHUNK_SIZE = 16384;
var SCAN_DELAY = 500;
var ICE_TIMEOUT = 5000; // 5s timeout for ICE gathering

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
        var margin = 2;
        var cellSize = Math.max(2, Math.floor(240 / count));
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
        img.style.cssText = 'display:block;max-width:256px;height:auto;width:' + px + 'px';
        el.appendChild(img);

        console.log('QR rendered as <img> from canvas, ' + count + 'x' + count + ' modules, ' + px + 'x' + px + 'px');
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
        var data = JSON.stringify({ type: 'offer', sdp: sdp });
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
                try {
                    const parsed = JSON.parse(code.data);
                    handleScan(parsed);
                    return;
                } catch (_) {}
            }
        }
        scanTimer = setTimeout(scan, SCAN_DELAY);
    }
    scanTimer = setTimeout(scan, SCAN_DELAY);
}

async function handleScan(data) {
    stopCamera();

    if (data.type === 'offer' && !isHost) {
        showScreen('connecting');
        $('connect-status').textContent = 'Connecting...';

        try {
            pc = new RTCPeerConnection(CONFIG);
            pc.oniceconnectionstatechange = () => tryConnect();
            pc.ondatachannel = ev => setupDC(ev.channel);

            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await waitForIceGathering(pc);

            var answerData = JSON.stringify({ type: 'answer', sdp: pc.localDescription.sdp });
            showScreen('show-answer');
            renderQR('qrcode-answer', answerData);
            $('answer-status').textContent = 'Show this to the host device';
        } catch (err) {
            $('connect-status').textContent = 'Error: ' + err.message;
            setTimeout(() => showScreen('home'), 2500);
        }

    } else if (data.type === 'answer' && isHost) {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
            $('host-status').textContent = 'Connected!';
            setTimeout(() => tryConnect(), 500);
        } catch (err) {
            $('host-status').textContent = 'Connection failed: ' + err.message;
            setTimeout(() => showScreen('home'), 2500);
        }
    }
}

// ===================== FILE TRANSFER =====================

function selectFiles() { $('file-input').click(); }

function onFilesSelected(e) {
    const files = Array.from(e.target.files);
    fileQueue.push(...files);
    renderFileList();
}

function renderFileList() {
    const container = $('file-list');
    if (fileQueue.length === 0) {
        container.innerHTML = '<p class="empty-state">No files selected</p>';
        $('btn-send').classList.add('hidden');
        return;
    }
    container.innerHTML = fileQueue.map((f, i) =>
        `<div class="file-item">
            <span class="name">${escHtml(f.name)}</span>
            <span class="size">${formatSize(f.size)}</span>
            <button class="btn-small" data-index="${i}">✕</button>
        </div>`
    ).join('');
    $('btn-send').classList.remove('hidden');
}

function escHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function removeFile(i) {
    fileQueue.splice(i, 1);
    renderFileList();
}

async function sendFiles() {
    if (!dc || dc.readyState !== 'open') return alert('Not connected to any device.');
    if (fileQueue.length === 0) return;

    const files = [...fileQueue];
    fileQueue = [];
    renderFileList();
    $('btn-send').classList.add('hidden');
    $('progress-section').classList.remove('hidden');

    for (const file of files) {
        await sendSingleFile(file);
    }

    setTimeout(() => { $('progress-section').classList.add('hidden'); }, 2000);
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
    for (let i = 0; i < totalChunks; i++) {
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const blob = file.slice(offset, end);
        const buf = await blob.arrayBuffer();
        dc.send(buf);
        offset = end;
        updateProgress((i + 1) / totalChunks);

        if (i % 8 === 0) await new Promise(r => setTimeout(r, 0));
    }

    dc.send(JSON.stringify({ type: 'file-end', fileId, name: file.name }));
    $('progress-label').textContent = 'Sent: ' + file.name;
    updateProgress(1);
}

function handleMsg(data) {
    if (typeof data === 'string') {
        try {
            const msg = JSON.parse(data);
            switch (msg.type) {
                case 'file-start':
                    recvBuffer = {
                        fileId: msg.fileId, name: msg.name, size: msg.size,
                        mimeType: msg.mimeType, chunks: [], received: 0, totalChunks: msg.totalChunks
                    };
                    $('progress-section').classList.remove('hidden');
                    $('progress-label').textContent = 'Receiving ' + msg.name;
                    updateProgress(0);
                    break;
                case 'file-end':
                    if (recvBuffer) {
                        const blob = new Blob(recvBuffer.chunks, { type: recvBuffer.mimeType });
                        dlBlob(blob, recvBuffer.name);
                        addReceived(recvBuffer.name, recvBuffer.size);
                        $('progress-label').textContent = 'Received: ' + recvBuffer.name;
                        updateProgress(1);
                        setTimeout(() => { $('progress-section').classList.add('hidden'); }, 2000);
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
    const container = $('received-files');
    const empty = container.querySelector('.empty-state');
    if (empty) empty.remove();

    const div = document.createElement('div');
    div.className = 'file-item';
    div.innerHTML = `<span class="name">⬇ ${escHtml(name)}</span><span class="size">${formatSize(size)}</span><span class="status">Complete</span>`;
    container.prepend(div);
}

function updateProgress(fraction) {
    const pct = Math.min(100, Math.round(fraction * 100));
    $('progress-fill').style.width = pct + '%';
    $('progress-text').textContent = pct + '%';
}

function disconnect() {
    if (dc) { try { dc.close(); } catch(_){} dc = null; }
    if (pc) { try { pc.close(); } catch(_){} pc = null; }
    isHost = false;
    autoConnected = false;
    fileQueue = [];
    recvBuffer = null;
    if (qrHost) { qrHost.clear(); qrHost = null; }
    if (qrAnswer) { qrAnswer.clear(); qrAnswer = null; }
    stopCamera();
    $('progress-section').classList.add('hidden');
    $('file-input').value = '';
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
    $('file-list').addEventListener('click', function(e) {
        var btn = e.target.closest('.btn-small');
        if (btn && btn.dataset.index !== undefined) {
            removeFile(parseInt(btn.dataset.index));
        }
    });
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
