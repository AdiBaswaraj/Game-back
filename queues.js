const queues = {
  'chess': [],
  'snake-and-ladder': [],
  'word-puzzle': [],
};

const SUPPORTED = new Set(Object.keys(queues));

function isSupported(gameId) {
  return SUPPORTED.has(gameId);
}

function joinQueue(gameId, player) {
  const q = queues[gameId];
  if (!q) return 0;
  q.push({
    userId: player.userId,
    username: player.username,
    socketId: player.socketId,
    joinedAt: Date.now(),
  });
  return q.length;
}

function leaveQueue(gameId, userId) {
  const q = queues[gameId];
  if (!q) return;
  const i = q.findIndex((p) => p.userId === userId);
  if (i >= 0) q.splice(i, 1);
}

function leaveAllQueues(socketId) {
  for (const gameId of Object.keys(queues)) {
    const q = queues[gameId];
    for (let i = q.length - 1; i >= 0; i--) {
      if (q[i].socketId === socketId) q.splice(i, 1);
    }
  }
}

function findMatch(gameId) {
  const q = queues[gameId];
  if (!q || q.length < 2) return null;
  const p1 = q.shift();
  const p2 = q.shift();
  return [p1, p2];
}

function getQueueLength(gameId) {
  const q = queues[gameId];
  return q ? q.length : 0;
}

module.exports = {
  isSupported,
  joinQueue,
  leaveQueue,
  leaveAllQueues,
  findMatch,
  getQueueLength,
};
