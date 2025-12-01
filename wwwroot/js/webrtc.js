"use strict";

const connection = new signalR.HubConnectionBuilder().withUrl("/WebRTCHub").build();

const configuration = {
    // Add STUN/TURN servers here if needed
};

const peers = {};
const participants = new Set();

const roomNameTxt = document.getElementById('roomNameTxt');
const createRoomBtn = document.getElementById('createRoomBtn');
const leaveRoomBtn = document.getElementById('leaveRoomBtn');
const roomList = document.getElementById('roomList');
const participantList = document.getElementById('participantList');
const connectionStatusMessage = document.getElementById('connectionStatusMessage');
const roomBadge = document.getElementById('roomBadge');
const videoGrid = document.getElementById('videoGrid');
const localVideo = document.getElementById('localVideo');

let myRoomId = null;
let myConnectionId = null;
let localStream = null;

createRoomBtn.addEventListener('click', () => {
    const name = roomNameTxt.value || 'اتاق جدید';
    connection.invoke("CreateRoom", name).catch(console.error);
});

leaveRoomBtn.addEventListener('click', () => {
    if (myRoomId) {
        connection.invoke("LeaveRoom", myRoomId).catch(console.error);
        resetPeers();
        setRoomBadge(null);
        participants.clear();
        renderParticipants();
    }
});

roomList.addEventListener('click', (event) => {
    const card = event.target.closest('[data-room-id]');
    if (!card) return;
    if (myRoomId) {
        alert('در حال حاضر در یک اتاق هستید. ابتدا خارج شوید.');
        return;
    }
    const roomId = card.getAttribute('data-room-id');
    connection.invoke("Join", roomId).catch(console.error);
});

connection.start().then(() => {
    myConnectionId = connection.connectionId;
    connectionStatusMessage.innerText = 'متصل به سرور سیگنالینگ';
    connection.invoke("GetRoomInfo");
}).catch(console.error);

connection.on('updateRoom', function (data) {
    const rooms = JSON.parse(data);
    renderRooms(rooms);
});

connection.on('created', function (roomId) {
    myRoomId = roomId;
    participants.add(myConnectionId);
    setRoomBadge(roomId);
    connectionStatusMessage.innerText = `اتاق ${roomId} ساخته شد. منتظر پیوستن دیگران...`;
});

connection.on('joined', function (roomId) {
    myRoomId = roomId;
    participants.add(myConnectionId);
    setRoomBadge(roomId);
    connectionStatusMessage.innerText = `به اتاق ${roomId} پیوستید.`;
});

connection.on('participants', function (list) {
    list.forEach(id => participants.add(id));
    participants.add(myConnectionId);
    renderParticipants();
    list.forEach(handleNewParticipant);
});

connection.on('peerJoined', function (remoteId) {
    participants.add(remoteId);
    renderParticipants();
    handleNewParticipant(remoteId);
});

connection.on('peerLeft', function (remoteId) {
    participants.delete(remoteId);
    renderParticipants();
    tearDownPeer(remoteId);
});

connection.on('signal', function (payload) {
    const { from, data } = payload;
    handleSignaling(from, data);
});

connection.on('error', function (message) {
    alert(message);
});

window.addEventListener('unload', function () {
    if (myRoomId) {
        connection.invoke("LeaveRoom", myRoomId).catch(console.error);
    }
});

function renderRooms(rooms) {
    roomList.innerHTML = '';
    if (!rooms || rooms.length === 0) {
        roomList.innerHTML = '<p class="text-slate-400 text-sm">اتاقی در دسترس نیست</p>';
        return;
    }

    rooms.forEach(room => {
        const card = document.createElement('div');
        card.className = 'room-card';
        card.setAttribute('data-room-id', room.RoomId);
        card.innerHTML = `
            <div>
                <p class="text-sm text-slate-100 font-semibold">${room.Name || 'اتاق بدون نام'}</p>
                <p class="text-xs text-slate-400">شناسه: ${room.RoomId}</p>
            </div>
            <div class="badge text-emerald-100 bg-white/5">${room.ParticipantCount || 0} نفر</div>
        `;
        roomList.appendChild(card);
    });
}

function renderParticipants() {
    participantList.innerHTML = '';
    if (participants.size === 0) {
        participantList.innerHTML = '<span class="text-slate-400">کسی حضور ندارد</span>';
        return;
    }

    participants.forEach(id => {
        const badge = document.createElement('span');
        badge.className = 'badge bg-white/5 text-slate-100';
        badge.innerText = id === myConnectionId ? 'من' : `کاربر ${id.substring(0, 6)}`;
        participantList.appendChild(badge);
    });
}

function setRoomBadge(roomId) {
    roomBadge.innerText = roomId ? `اتاق #${roomId}` : 'بدون اتاق';
}

function grabWebCamVideo() {
    const config = {
        audio: document.getElementById('audio').checked,
        video: {
            facingMode: document.getElementById('camera_front').checked ? 'user' : 'environment',
            width: { exact: document.getElementById('camera_width').value },
            height: { exact: document.getElementById('camera_height').value }
        }
    };

    navigator.mediaDevices.getUserMedia(config)
        .then(gotStream)
        .catch(function (e) {
            alert('خطا در دریافت تصویر: ' + e.name);
        });
}

function gotStream(stream) {
    localStream = stream;
    localVideo.srcObject = stream;
    Object.values(peers).forEach(peer => {
        stream.getTracks().forEach(track => peer.addTrack(track, stream));
    });
}

function handleNewParticipant(remoteId) {
    if (remoteId === myConnectionId) return;

    const initiator = myConnectionId.localeCompare(remoteId) < 0;
    const pc = ensurePeer(remoteId);

    if (initiator) {
        pc.createOffer().then(offer => {
            return pc.setLocalDescription(offer);
        }).then(() => {
            sendSignal(remoteId, pc.localDescription);
        }).catch(logError);
    }
}

function ensurePeer(remoteId) {
    if (peers[remoteId]) return peers[remoteId];

    const pc = new RTCPeerConnection(configuration);

    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.onicecandidate = function (event) {
        if (event.candidate) {
            sendSignal(remoteId, {
                type: 'candidate',
                candidate: event.candidate
            });
        }
    };

    pc.ontrack = function (event) {
        attachRemoteVideo(remoteId, event.streams[0]);
    };

    pc.onconnectionstatechange = function () {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            tearDownPeer(remoteId);
        }
    };

    peers[remoteId] = pc;
    return pc;
}

function handleSignaling(from, data) {
    const pc = ensurePeer(from);

    if (data.type === 'offer') {
        pc.setRemoteDescription(new RTCSessionDescription(data))
            .then(() => pc.createAnswer())
            .then(answer => pc.setLocalDescription(answer))
            .then(() => sendSignal(from, pc.localDescription))
            .catch(logError);
    } else if (data.type === 'answer') {
        pc.setRemoteDescription(new RTCSessionDescription(data)).catch(logError);
    } else if (data.type === 'candidate') {
        pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(logError);
    }
}

function sendSignal(targetId, message) {
    if (!myRoomId) return;
    connection.invoke("SendSignal", myRoomId, targetId, message).catch(console.error);
}

function attachRemoteVideo(remoteId, stream) {
    let existing = document.getElementById(`remote-${remoteId}`);
    if (!existing) {
        const card = document.createElement('div');
        card.className = 'video-card';
        card.setAttribute('data-remote-id', remoteId);
        card.innerHTML = `
            <div class="flex items-center justify-between text-sm text-slate-300">
                <span>کاربر ${remoteId.substring(0, 6)}</span>
                <span class="text-xs bg-white/10 px-2 py-1 rounded-full">Remote</span>
            </div>
            <video id="remote-${remoteId}" class="video-frame" autoplay playsinline></video>
        `;
        videoGrid.appendChild(card);
        existing = card.querySelector('video');
    }
    existing.srcObject = stream;
}

function tearDownPeer(remoteId) {
    const pc = peers[remoteId];
    if (pc) {
        pc.close();
        delete peers[remoteId];
    }
    const videoCard = videoGrid.querySelector(`[data-remote-id="${remoteId}"]`);
    if (videoCard) {
        videoGrid.removeChild(videoCard);
    }
}

function resetPeers() {
    Object.keys(peers).forEach(tearDownPeer);
}

function logError(err) {
    if (!err) return;
    console.warn(err.toString(), err);
}
