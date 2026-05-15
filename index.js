require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const supabase = require('./supabase');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/scores', async (req, res) => {
  const { user_id, game_id, score, completed_at } = req.body || {};

  if (
    !user_id ||
    !game_id ||
    score === undefined ||
    score === null ||
    !completed_at
  ) {
    return res.status(400).json({
      error: 'user_id, game_id, score, and completed_at are required',
    });
  }

  const { data, error } = await supabase
    .from('scores')
    .insert({ user_id, game_id, score, completed_at })
    .select()
    .single();

  if (error) {
    console.error('[scores] insert error:', error);
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, data });
});

app.get('/api/scores/leaderboard/:gameId', async (req, res) => {
  const { gameId } = req.params;

  const { data, error } = await supabase
    .from('scores')
    .select('score, completed_at, profiles ( username )')
    .eq('game_id', gameId)
    .order('score', { ascending: false })
    .limit(10);

  if (error) {
    console.error('[leaderboard] fetch error:', error);
    return res.status(500).json({ error: error.message });
  }

  const leaderboard = (data || []).map((row) => ({
    username: row.profiles?.username ?? null,
    score: row.score,
    completed_at: row.completed_at,
  }));

  res.json(leaderboard);
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

io.on('connection', (socket) => {
  console.log(`[socket.io] client connected: ${socket.id}`);

  socket.on('disconnect', (reason) => {
    console.log(`[socket.io] client disconnected: ${socket.id} (${reason})`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Arcadia backend listening on port ${PORT}`);
});
