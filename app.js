'use strict';

const CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ]
};
const CHUNK_SIZE = 16384;
const SCAN_DELAY = 500;

let state = 'home';
let pc = null;
let dc = null;
let isHost = false;
let mediaStream = null;
let scanTimer = null;
let fileQueue = [];
let qrHost = null;
let qrAnswer = null;
let recvBuffer = null;
let autoConnected = false;

const $ = id => document.getElementById(id);

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
    const el = $(id);
    if (el) el.classList.add('active');
    state = id;
}

function waitForIceGathering(p) {
    if (p.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(resolve => {
        p.onicegatheringstatechange = () => {
            if (p.iceGatheringState === 'complete') {
                p.onicegatheringstatechange = null;
                resolve();
            }
        };
    });
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
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
    if (!window.RTCPeerConnection) return alert('WebRTC not supported in this browser.');
    isHost = true;
    autoConnected = false;
    showScreen('hosting');
    $('host-status').textContent = 'Setting up...';
    $('btn-scan-answer').classList.add('hidden');
    if (qrHost) { qrHost.clear(); qrHost = null; }

    try {
        pc = new RTCPeerConnection(CONFIG);
        pc.oniceconnectionstatechange = () => tryConnect();
        pc.onicecandidate = null;

        const channel = pc.createDataChannel('transfer');
        setupDC(channel);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc);

        const data = JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp });
        $('qrcode-host').innerHTML = '';

        qrHost = new QRCode($('qrcode-host'), {
            text: data,
            width: 256,
            height: 256,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.L
        });

        $('host-status').textContent = 'Ask your friend to scan this QR code';
        $('btn-scan-answer').classList.remove('hidden');
    } catch (err) {
        $('host-status').textContent = 'Error: ' + err.message;
    }
}

async function startJoining() {
    if (!navigator.mediaDevices || !window.RTCPeerConnection)
        return alert('Camera or WebRTC not supported.');
    isHost = false;
    autoConnected = false;
    showScreen('scanning');
    $('scan-status').textContent = 'Scan the QR code from the host device';
    await initCamera();
}

async function hostScanAnswer() {
    showScreen('scanning');
    $('scan-status').textContent = 'Scan the reply QR from your friend\'s device';
    await initCamera();
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

            const answerData = JSON.stringify({ type: 'answer', sdp: pc.localDescription.sdp });
            showScreen('show-answer');
            $('qrcode-answer').innerHTML = '';
            if (qrAnswer) qrAnswer.clear();

            qrAnswer = new QRCode($('qrcode-answer'), {
                text: answerData,
                width: 256,
                height: 256,
                colorDark: '#000000',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.L
            });

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
document.addEventListener('DOMContentLoaded', () => {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    $('btn-host').addEventListener('click', startHosting);
    $('btn-join').addEventListener('click', startJoining);
    $('btn-scan-answer').addEventListener('click', hostScanAnswer);
    $('btn-cancel-scan').addEventListener('click', () => { stopCamera(); showScreen('home'); });
    $('btn-back-host').addEventListener('click', disconnect);
    $('btn-select-files').addEventListener('click', selectFiles);
    $('file-input').addEventListener('change', onFilesSelected);
    $('btn-send').addEventListener('click', sendFiles);
    $('file-list').addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-small');
        if (btn && btn.dataset.index !== undefined) {
            removeFile(parseInt(btn.dataset.index));
        }
    });
    $('btn-disconnect').addEventListener('click', disconnect);
});
