const onlineUsers = new Map();
const socketToUser = new Map();

function setOnline(userId, username, socketId) {
  const existing = onlineUsers.get(userId);
  if (existing && existing.socketId !== socketId) {
    socketToUser.delete(existing.socketId);
  }
  onlineUsers.set(userId, { socketId, username, connectedAt: Date.now() });
  socketToUser.set(socketId, userId);
}

function setOffline(socketId) {
  const userId = socketToUser.get(socketId);
  if (!userId) return null;
  socketToUser.delete(socketId);
  const entry = onlineUsers.get(userId);
  if (entry && entry.socketId === socketId) {
    onlineUsers.delete(userId);
  }
  return userId;
}

function isOnline(userId) {
  return onlineUsers.has(userId);
}

function getSocketId(userId) {
  return onlineUsers.get(userId)?.socketId ?? null;
}

function getUserId(socketId) {
  return socketToUser.get(socketId) ?? null;
}

module.exports = {
  setOnline,
  setOffline,
  isOnline,
  getSocketId,
  getUserId,
};
