const rooms = new Map();

const CODE_LENGTH = 6;
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const MAX_PLAYERS = 2;
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const ROOM_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

function createRoom(gameId) {
  let code;
  do {
    code = generateCode();
  } while (rooms.has(code));

  const room = {
    code,
    gameId,
    players: [],
    status: 'waiting',
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(code) || null;
}

function addPlayer(code, player) {
  const room = rooms.get(code);
  if (!room) return null;
  if (room.players.length >= MAX_PLAYERS) return null;
  room.players.push({ ...player, ready: false });
  return room;
}

function removePlayer(code, socketId) {
  const room = rooms.get(code);
  if (!room) return null;
  room.players = room.players.filter((p) => p.socketId !== socketId);
  if (room.players.length === 0) {
    rooms.delete(code);
    return null;
  }
  return room;
}

function markDisconnected(code, socketId) {
  const room = rooms.get(code);
  if (!room) return null;
  const player = room.players.find((p) => p.socketId === socketId);
  if (!player) return null;
  player.socketId = null;
  return room;
}

function reattachPlayer(code, username, newSocketId) {
  const room = rooms.get(code);
  if (!room) return null;
  const player = room.players.find((p) => p.username === username);
  if (!player) return null;
  player.socketId = newSocketId;
  return room;
}

function setReady(code, socketId) {
  const room = rooms.get(code);
  if (!room) return null;
  const player = room.players.find((p) => p.socketId === socketId);
  if (!player) return null;
  player.ready = true;
  const bothReady =
    room.players.length === MAX_PLAYERS && room.players.every((p) => p.ready);
  return { room, bothReady };
}

function updateStatus(code, status) {
  const room = rooms.get(code);
  if (!room) return null;
  room.status = status;
  return room;
}

function setGameState(code, state) {
  const room = rooms.get(code);
  if (!room) return null;
  room.gameState = state;
  return room;
}

function toPublicRoom(room) {
  return {
    code: room.code,
    gameId: room.gameId,
    status: room.status,
    createdAt: room.createdAt,
    players: room.players.map((p) => ({
      id: p.id,
      userId: p.id,
      username: p.username,
      ready: p.ready,
    })),
    gameState: room.gameState ?? null,
  };
}

function findRoomBySocketId(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some((p) => p.socketId === socketId)) return room;
  }
  return null;
}

function cleanupExpiredRooms() {
  const now = Date.now();
  let removed = 0;
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_MAX_AGE_MS) {
      rooms.delete(code);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[rooms] cleanup removed ${removed} expired room(s)`);
  }
}

function startCleanup() {
  return setInterval(cleanupExpiredRooms, CLEANUP_INTERVAL_MS);
}

module.exports = {
  createRoom,
  getRoom,
  addPlayer,
  removePlayer,
  markDisconnected,
  reattachPlayer,
  setReady,
  updateStatus,
  setGameState,
  toPublicRoom,
  findRoomBySocketId,
  startCleanup,
};
