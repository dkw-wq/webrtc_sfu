/**
 * Mediasoup SFU server (invite room + auth + db)
 * run on linux
 * environment
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const Database = require('better-sqlite3');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const mediasoup = require('mediasoup');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || '127.0.0.1';
const RTC_MIN_PORT = Number(process.env.RTC_MIN_PORT || 2000);
const RTC_MAX_PORT = Number(process.env.RTC_MAX_PORT || 2100);

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';
const SEED_USERNAME = process.env.SEED_USERNAME || 'admin';
const SEED_PASSWORD = process.env.SEED_PASSWORD;

if (!JWT_SECRET) {
  throw new Error('Missing JWT_SECRET in environment variables.');
}

if (!SEED_PASSWORD) {
  throw new Error('Missing SEED_PASSWORD in environment variables.');
}

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

app.use(cors({ origin: '*' }));
app.use(express.json());

let worker;
const rooms = new Map(); // roomId -> { id, router, creatorUserId, participants:Set<userId>, participantNames:Map<userId, username>, peers:Set<socketId> }
const invitations = new Map(); // inviteId -> { id, roomId, fromUserId, fromUsername, toUserId, status }
const peers = new Map(); // socketId -> { roomId, socket, transports, producers, consumers, user }
const userSockets = new Map(); // userId -> Set<socketId>
const onlineUsers = new Map(); // userId -> { id, username }

const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 }
  }
];

function initDatabase() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      user_id INTEGER PRIMARY KEY,
      session_token TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  const seedHash = bcrypt.hashSync(SEED_PASSWORD, 10);
  db.prepare(`
    INSERT INTO users (username, password_hash)
    VALUES (?, ?)
    ON CONFLICT(username) DO UPDATE SET
      password_hash = excluded.password_hash,
      updated_at = CURRENT_TIMESTAMP;
  `).run(SEED_USERNAME, seedHash);

  console.log(`Login user ready: ${SEED_USERNAME}`);
  console.log(`SQLite DB: ${DB_PATH}`);

  return db;
}

const db = initDatabase();

function issueToken(user) {
  const sessionToken = randomUUID();

  db.prepare(`
    INSERT INTO user_sessions (user_id, session_token)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      session_token = excluded.session_token,
      updated_at = CURRENT_TIMESTAMP;
  `).run(user.id, sessionToken);

  return jwt.sign(
    {
      sub: String(user.id),
      username: user.username,
      sid: sessionToken
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function emitToUser(userId, eventName, payload) {
  const sockets = userSockets.get(String(userId));
  if (!sockets) return;

  for (const socketId of sockets) {
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
      targetSocket.emit(eventName, payload);
    }
  }
}

function getOnlineUsersFor(userId) {
  const result = [];
  for (const [onlineUserId, sockets] of userSockets.entries()) {
    if (!sockets || sockets.size === 0) continue;
    if (onlineUserId === userId) continue;

    const user = onlineUsers.get(onlineUserId);
    if (user) {
      result.push({
        id: user.id,
        username: user.username
      });
    }
  }

  result.sort((a, b) => a.username.localeCompare(b.username));
  return result;
}

function broadcastOnlineUsers() {
  for (const [userId, sockets] of userSockets.entries()) {
    if (!sockets || sockets.size === 0) continue;

    const payload = { users: getOnlineUsersFor(userId) };
    for (const socketId of sockets) {
      const targetSocket = io.sockets.sockets.get(socketId);
      if (targetSocket) {
        targetSocket.emit('onlineUsers', payload);
      }
    }
  }
}

async function ensureRoomRouter(room) {
  if (room.router) return room.router;

  room.router = await worker.createRouter({ mediaCodecs });
  console.log(`room router created: ${room.id}`);
  return room.router;
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    const user = db
      .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
      .get(username);

    if (!user) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    const activeSockets = userSockets.get(String(user.id));
    if (activeSockets && activeSockets.size > 0) {
      return res.status(409).json({ error: 'account already logged in on another page' });
    }

    const token = issueToken(user);
    return res.json({
      token,
      user: {
        id: user.id,
        username: user.username
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

async function runMediasoup() {
  worker = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort: RTC_MIN_PORT,
    rtcMaxPort: RTC_MAX_PORT
  });

  worker.on('died', () => {
    console.error('mediasoup worker died');
    process.exit(1);
  });

  console.log('mediasoup worker started');
}

async function createWebRtcTransport(router) {
  return router.createWebRtcTransport({
    listenIps: [
      {
        ip: '0.0.0.0',
        announcedIp: ANNOUNCED_IP
      }
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true
  });
}

function getPeer(socketId) {
  return peers.get(socketId);
}

function ensureRoomParticipantNames(room) {
  if (!room.participantNames) {
    room.participantNames = new Map();
  }

  return room.participantNames;
}

function getRoomMembersSnapshot(room) {
  const participantNames = ensureRoomParticipantNames(room);
  const joinedUserIds = new Set();

  for (const peerId of room.peers) {
    const peer = peers.get(peerId);
    if (!peer) continue;
    joinedUserIds.add(peer.user.id);
  }

  const members = [...room.participants].map((userId) => ({
    id: userId,
    username:
      participantNames.get(userId) ||
      onlineUsers.get(String(userId))?.username ||
      `user-${userId}`,
    isCreator: room.creatorUserId === userId,
    isJoined: joinedUserIds.has(userId)
  }));

  members.sort((a, b) => {
    if (a.isCreator !== b.isCreator) {
      return a.isCreator ? -1 : 1;
    }

    return a.username.localeCompare(b.username);
  });

  return members;
}

function emitToRoomPeers(roomId, eventName, payload, excludedSocketId) {
  const room = rooms.get(roomId);
  if (!room) return;

  for (const peerId of room.peers) {
    if (peerId === excludedSocketId) continue;
    const peer = peers.get(peerId);
    if (!peer) continue;
    peer.socket.emit(eventName, payload);
  }
}

function emitRoomMembers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  emitToRoomPeers(roomId, 'roomMembersUpdate', {
    roomId,
    members: getRoomMembersSnapshot(room)
  });
}

function destroyRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.router) {
    room.router.close();
  }

  rooms.delete(roomId);
  console.log(`room removed: ${roomId}`);
}

function cleanupEmptyRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.peers.size > 0) return;

  let hasPendingInvite = false;
  for (const invite of invitations.values()) {
    if (invite.roomId === roomId && invite.status === 'pending') {
      hasPendingInvite = true;
      break;
    }
  }

  if (hasPendingInvite) return;

  destroyRoom(roomId);
}

function notifyProducerClosed(roomId, producerId, excludedSocketId) {
  emitToRoomPeers(roomId, 'producerClosed', { producerId }, excludedSocketId);
}

function cancelPendingInvitesForRoom(roomId, reason) {
  for (const invite of [...invitations.values()]) {
    if (invite.roomId !== roomId || invite.status !== 'pending') continue;

    emitToUser(invite.toUserId, 'inviteCanceled', {
      inviteId: invite.id,
      roomId,
      reason
    });

    invitations.delete(invite.id);
  }
}

function findPendingInvite(roomId, userId) {
  for (const invite of invitations.values()) {
    if (
      invite.roomId === roomId &&
      invite.toUserId === userId &&
      invite.status === 'pending'
    ) {
      return invite;
    }
  }

  return null;
}

function cleanupPeer(socketId, options = {}) {
  const peer = getPeer(socketId);
  if (!peer) return;

  const {
    notifyPeerLeft = false,
    leftReason = 'left the room',
    removeParticipant = true,
    skipEmptyRoomCleanup = false
  } = options;

  const room = rooms.get(peer.roomId);
  if (room) {
    room.peers.delete(socketId);
    if (removeParticipant) {
      room.participants.delete(peer.user.id);
      ensureRoomParticipantNames(room).delete(peer.user.id);
      if (room.creatorUserId === peer.user.id) {
        const nextCreatorUserId = [...room.participants][0];
        room.creatorUserId = nextCreatorUserId || '';
      }
    }
  }

  for (const consumer of [...peer.consumers.values()]) {
    consumer.close();
  }
  for (const producer of [...peer.producers.values()]) {
    producer.close();
  }
  for (const transport of [...peer.transports.values()]) {
    transport.close();
  }

  if (room && notifyPeerLeft) {
    emitToRoomPeers(peer.roomId, 'peerLeft', {
      roomId: peer.roomId,
      user: {
        id: peer.user.id,
        username: peer.user.username
      },
      reason: leftReason
    });
  }

  if (room) {
    emitRoomMembers(peer.roomId);
  }

  if (room && !skipEmptyRoomCleanup) {
    cleanupEmptyRoom(peer.roomId);
  }

  peers.delete(socketId);
}

function endRoom(roomId, reason, endedByUserId = null) {
  const room = rooms.get(roomId);
  if (!room) return;

  const payload = {
    roomId,
    reason,
    endedByUserId
  };

  for (const participantUserId of room.participants) {
    if (participantUserId === endedByUserId) continue;
    emitToUser(participantUserId, 'roomEnded', payload);
  }

  cancelPendingInvitesForRoom(roomId, reason);

  for (const peerId of [...room.peers]) {
    cleanupPeer(peerId, {
      removeParticipant: true,
      skipEmptyRoomCleanup: true
    });
  }

  destroyRoom(roomId);
}

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('UNAUTHORIZED: missing token'));
    }

    const payload = jwt.verify(token, JWT_SECRET);
    const currentSession = db
      .prepare('SELECT session_token FROM user_sessions WHERE user_id = ?')
      .get(String(payload.sub));

    if (!payload.sid || !currentSession || currentSession.session_token !== payload.sid) {
      return next(new Error('UNAUTHORIZED: session replaced'));
    }

    const activeSockets = userSockets.get(String(payload.sub));
    if (activeSockets && activeSockets.size > 0) {
      return next(new Error('ALREADY_ONLINE'));
    }

    socket.user = {
      id: String(payload.sub),
      username: payload.username,
      sid: payload.sid
    };

    return next();
  } catch (_err) {
    return next(new Error('UNAUTHORIZED: invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log(`connected ${socket.id} user=${socket.user.username}`);
  if (!userSockets.has(socket.user.id)) {
    userSockets.set(socket.user.id, new Set());
  }
  userSockets.get(socket.user.id).add(socket.id);
  onlineUsers.set(socket.user.id, {
    id: socket.user.id,
    username: socket.user.username
  });

  broadcastOnlineUsers();

  for (const invite of invitations.values()) {
    if (invite.toUserId === socket.user.id && invite.status === 'pending') {
      socket.emit('incomingInvite', {
        inviteId: invite.id,
        roomId: invite.roomId,
        fromUser: {
          id: invite.fromUserId,
          username: invite.fromUsername
        }
      });
    }
  }

  socket.on('getOnlineUsers', (_data, callback = () => {}) => {
    callback({ users: getOnlineUsersFor(socket.user.id) });
  });

  socket.on('createRoomInvite', ({ targetUserId, roomId }, callback = () => {}) => {
    try {
      const normalizedTargetUserId = String(targetUserId || '').trim();
      const requestedRoomId = String(roomId || '').trim();
      if (!normalizedTargetUserId) {
        return callback({ error: 'targetUserId is required' });
      }
      if (normalizedTargetUserId === socket.user.id) {
        return callback({ error: 'cannot invite yourself' });
      }

      const targetSockets = userSockets.get(normalizedTargetUserId);
      if (!targetSockets || targetSockets.size === 0) {
        return callback({ error: 'target user is offline' });
      }

      const targetUser = onlineUsers.get(normalizedTargetUserId);
      if (!targetUser) {
        return callback({ error: 'target user not found' });
      }

      let room;
      let effectiveRoomId = requestedRoomId;

      if (effectiveRoomId) {
        room = rooms.get(effectiveRoomId);
        if (!room) {
          return callback({ error: 'room not found' });
        }
        if (!room.participants.has(socket.user.id)) {
          return callback({ error: 'you are not a participant in this room' });
        }
        if (!room.creatorUserId) {
          room.creatorUserId = socket.user.id;
        }
      } else {
        effectiveRoomId = randomUUID().split('-')[0];
        room = {
          id: effectiveRoomId,
          router: null,
          creatorUserId: socket.user.id,
          participants: new Set([socket.user.id]),
          participantNames: new Map([[socket.user.id, socket.user.username]]),
          peers: new Set()
        };
        rooms.set(effectiveRoomId, room);
      }

      ensureRoomParticipantNames(room).set(socket.user.id, socket.user.username);

      if (room.participants.has(normalizedTargetUserId)) {
        return callback({ error: 'target user is already in this room' });
      }

      const existingInvite = findPendingInvite(effectiveRoomId, normalizedTargetUserId);
      if (existingInvite) {
        return callback({ error: 'target user already has a pending invite for this room' });
      }

      const inviteId = randomUUID();
      invitations.set(inviteId, {
        id: inviteId,
        roomId: effectiveRoomId,
        fromUserId: socket.user.id,
        fromUsername: socket.user.username,
        toUserId: normalizedTargetUserId,
        status: 'pending'
      });

      emitToUser(normalizedTargetUserId, 'incomingInvite', {
        inviteId,
        roomId: effectiveRoomId,
        fromUser: {
          id: socket.user.id,
          username: socket.user.username
        }
      });

      return callback({
        inviteId,
        roomId: effectiveRoomId,
        toUser: targetUser
      });
    } catch (err) {
      return callback({ error: err.message });
    }
  });

  socket.on('respondRoomInvite', ({ inviteId, accept }, callback = () => {}) => {
    try {
      const normalizedInviteId = String(inviteId || '').trim();
      const invite = invitations.get(normalizedInviteId);

      if (!invite || invite.status !== 'pending') {
        return callback({ error: 'invite not found or already handled' });
      }
      if (invite.toUserId !== socket.user.id) {
        return callback({ error: 'invite does not belong to current user' });
      }

      const accepted = Boolean(accept);
      invite.status = accepted ? 'accepted' : 'rejected';
      invitations.delete(normalizedInviteId);

      const room = rooms.get(invite.roomId);

      if (!accepted) {
        if (room && room.peers.size === 0) {
          cleanupEmptyRoom(invite.roomId);
        }

        emitToUser(invite.fromUserId, 'inviteResponded', {
          inviteId: normalizedInviteId,
          accepted: false,
          roomId: invite.roomId,
          by: {
            id: socket.user.id,
            username: socket.user.username
          }
        });

        return callback({ ok: true, accepted: false });
      }

      if (!room) {
        return callback({ error: 'room no longer exists' });
      }

      room.participants.add(invite.toUserId);
      if (!room.creatorUserId) {
        room.creatorUserId = invite.toUserId;
      }
      ensureRoomParticipantNames(room).set(invite.toUserId, socket.user.username);
      emitRoomMembers(invite.roomId);

      emitToUser(invite.fromUserId, 'inviteResponded', {
        inviteId: normalizedInviteId,
        accepted: true,
        roomId: invite.roomId,
        by: {
          id: socket.user.id,
          username: socket.user.username
        }
      });

      return callback({
        ok: true,
        accepted: true,
        roomId: invite.roomId,
        fromUser: {
          id: invite.fromUserId,
          username: invite.fromUsername
        }
      });
    } catch (err) {
      return callback({ error: err.message });
    }
  });

  socket.on('joinRoom', async ({ roomId }, callback = () => {}) => {
    try {
      const normalizedRoomId = String(roomId || '').trim();
      if (!normalizedRoomId) {
        return callback({ error: 'roomId is required' });
      }

      const room = rooms.get(normalizedRoomId);
      if (!room) {
        return callback({ error: 'room not found' });
      }

      if (!room.participants.has(socket.user.id)) {
        return callback({ error: 'you are not invited to this room' });
      }

      const existingPeer = peers.get(socket.id);
      if (existingPeer) {
        if (existingPeer.roomId !== normalizedRoomId) {
          cleanupPeer(socket.id, {
            notifyPeerLeft: true,
            leftReason: 'switched rooms'
          });
        } else {
          const existingProducers = [];
          for (const peerId of room.peers) {
            if (peerId === socket.id) continue;
            const otherPeer = peers.get(peerId);
            if (!otherPeer) continue;

            for (const producer of otherPeer.producers.values()) {
              existingProducers.push({ producerId: producer.id });
            }
          }

          return callback({
            rtpCapabilities: room.router.rtpCapabilities,
            existingProducers,
            isCreator: room.creatorUserId === socket.user.id,
            members: getRoomMembersSnapshot(room)
          });
        }
      }

      const router = await ensureRoomRouter(room);
      ensureRoomParticipantNames(room).set(socket.user.id, socket.user.username);
      room.peers.add(socket.id);
      peers.set(socket.id, {
        user: socket.user,
        socket,
        roomId: normalizedRoomId,
        transports: new Map(),
        producers: new Map(),
        consumers: new Map()
      });

      const existingProducers = [];
      for (const peerId of room.peers) {
        if (peerId === socket.id) continue;
        const otherPeer = peers.get(peerId);
        if (!otherPeer) continue;

        for (const producer of otherPeer.producers.values()) {
          existingProducers.push({ producerId: producer.id });
        }
      }

      const members = getRoomMembersSnapshot(room);
      emitRoomMembers(normalizedRoomId);

      return callback({
        rtpCapabilities: router.rtpCapabilities,
        existingProducers,
        isCreator: room.creatorUserId === socket.user.id,
        members
      });
    } catch (err) {
      return callback({ error: err.message });
    }
  });

  socket.on('leaveRoom', (_data, callback = () => {}) => {
    try {
      const peer = getPeer(socket.id);
      if (!peer) {
        return callback({ error: 'peer not joined' });
      }

      const roomId = peer.roomId;
      cleanupPeer(socket.id, {
        notifyPeerLeft: true,
        leftReason: 'left the room'
      });

      return callback({ ok: true, roomId });
    } catch (err) {
      return callback({ error: err.message });
    }
  });

  socket.on('endRoom', (_data, callback = () => {}) => {
    try {
      const peer = getPeer(socket.id);
      if (!peer) {
        return callback({ error: 'peer not joined' });
      }

      const room = rooms.get(peer.roomId);
      if (!room) {
        return callback({ error: 'room not found' });
      }

      if (room.creatorUserId !== socket.user.id) {
        return callback({ error: 'only the room creator can end the call' });
      }

      endRoom(peer.roomId, `${socket.user.username} ended the call`, socket.user.id);
      return callback({ ok: true, roomId: peer.roomId });
    } catch (err) {
      return callback({ error: err.message });
    }
  });

  socket.on('createWebRtcTransport', async ({ direction } = {}, callback = () => {}) => {
    try {
      const peer = getPeer(socket.id);
      if (!peer) {
        return callback({ error: 'peer not joined' });
      }

      const room = rooms.get(peer.roomId);
      if (!room) {
        return callback({ error: 'room not found' });
      }

      const router = await ensureRoomRouter(room);
      const transport = await createWebRtcTransport(router);
      transport.appData = {
        direction: direction === 'send' ? 'send' : 'recv'
      };
      peer.transports.set(transport.id, transport);

      return callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      });
    } catch (err) {
      return callback({ error: err.message });
    }
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback = () => {}) => {
    try {
      const peer = getPeer(socket.id);
      const transport = peer?.transports.get(transportId);
      if (!transport) {
        return callback({ error: 'transport not found' });
      }

      await transport.connect({ dtlsParameters });
      return callback({ ok: true });
    } catch (err) {
      return callback({ error: err.message });
    }
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters }, callback = () => {}) => {
    try {
      const peer = getPeer(socket.id);
      const transport = peer?.transports.get(transportId);
      if (!transport) {
        return callback({ error: 'transport not found' });
      }

      const producer = await transport.produce({ kind, rtpParameters });
      peer.producers.set(producer.id, producer);

      producer.observer.on('close', () => {
        peer.producers.delete(producer.id);
        notifyProducerClosed(peer.roomId, producer.id, socket.id);
      });

      producer.on('transportclose', () => {
        producer.close();
      });

      const room = rooms.get(peer.roomId);
      if (room) {
        for (const otherId of room.peers) {
          if (otherId === socket.id) continue;
          const otherPeer = peers.get(otherId);
          if (!otherPeer) continue;
          otherPeer.socket.emit('newProducer', { producerId: producer.id });
        }
      }

      return callback({ id: producer.id });
    } catch (err) {
      return callback({ error: err.message });
    }
  });

  socket.on('pauseProducer', async ({ producerId }, callback = () => {}) => {
    try {
      const normalizedProducerId = String(producerId || '').trim();
      if (!normalizedProducerId) {
        return callback({ error: 'producerId is required' });
      }

      const peer = getPeer(socket.id);
      const producer = peer?.producers.get(normalizedProducerId);
      if (!producer) {
        return callback({ error: 'producer not found' });
      }

      await producer.pause();
      return callback({ ok: true });
    } catch (err) {
      return callback({ error: err.message });
    }
  });

  socket.on('resumeProducer', async ({ producerId }, callback = () => {}) => {
    try {
      const normalizedProducerId = String(producerId || '').trim();
      if (!normalizedProducerId) {
        return callback({ error: 'producerId is required' });
      }

      const peer = getPeer(socket.id);
      const producer = peer?.producers.get(normalizedProducerId);
      if (!producer) {
        return callback({ error: 'producer not found' });
      }

      await producer.resume();
      return callback({ ok: true });
    } catch (err) {
      return callback({ error: err.message });
    }
  });

  socket.on('consume', async ({ producerId, rtpCapabilities }, callback = () => {}) => {
    try {
      const peer = getPeer(socket.id);
      if (!peer) {
        return callback({ error: 'peer not joined' });
      }

      const room = rooms.get(peer.roomId);
      if (!room) {
        return callback({ error: 'room not found' });
      }
      if (!room.router) {
        return callback({ error: 'room media router is not ready' });
      }

      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        return callback({ error: 'cannot consume' });
      }

      let recvTransport = [...peer.transports.values()].find((t) => t.appData.direction === 'recv');
      if (!recvTransport) {
        recvTransport = await createWebRtcTransport(room.router);
        recvTransport.appData = { direction: 'recv' };
        peer.transports.set(recvTransport.id, recvTransport);
      }

      const consumer = await recvTransport.consume({
        producerId,
        rtpCapabilities,
        paused: true
      });

      peer.consumers.set(consumer.id, consumer);

      consumer.on('transportclose', () => {
        peer.consumers.delete(consumer.id);
      });

      consumer.on('producerclose', () => {
        peer.consumers.delete(consumer.id);
      });

      return callback({
        transportOptions: {
          id: recvTransport.id,
          iceParameters: recvTransport.iceParameters,
          iceCandidates: recvTransport.iceCandidates,
          dtlsParameters: recvTransport.dtlsParameters
        },
        consumerOptions: {
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters
        }
      });
    } catch (err) {
      return callback({ error: err.message });
    }
  });

  socket.on('resume', async ({ consumerId }, callback = () => {}) => {
    try {
      const peer = getPeer(socket.id);
      const consumer = peer?.consumers.get(consumerId);
      if (!consumer) {
        return callback({ error: 'consumer not found' });
      }

      await consumer.resume();
      return callback({ ok: true });
    } catch (err) {
      return callback({ error: err.message });
    }
  });

  socket.on('disconnect', () => {
    const sockets = userSockets.get(socket.user.id);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        userSockets.delete(socket.user.id);
        onlineUsers.delete(socket.user.id);
      }
    }

    for (const invite of [...invitations.values()]) {
      if (invite.status !== 'pending') continue;

      if (invite.fromUserId === socket.user.id) {
        emitToUser(invite.toUserId, 'inviteCanceled', {
          inviteId: invite.id,
          roomId: invite.roomId,
          reason: `${socket.user.username} went offline`
        });
        invitations.delete(invite.id);
        cleanupEmptyRoom(invite.roomId);
      } else if (invite.toUserId === socket.user.id) {
        emitToUser(invite.fromUserId, 'inviteCanceled', {
          inviteId: invite.id,
          roomId: invite.roomId,
          reason: `${socket.user.username} went offline`
        });
        invitations.delete(invite.id);
        cleanupEmptyRoom(invite.roomId);
      }
    }

    cleanupPeer(socket.id, {
      notifyPeerLeft: true,
      leftReason: 'went offline'
    });
    broadcastOnlineUsers();
    console.log(`disconnected ${socket.id}`);
  });
});

(async () => {
  await runMediasoup();
  httpServer.listen(PORT, () => {
    console.log(`SFU server listening on :${PORT}`);
  });
})();
