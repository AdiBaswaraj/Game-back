const { Chess } = require('chess.js');

const SNAKE_LADDER_LADDERS = {
  1: 38, 4: 14, 9: 31, 21: 42, 28: 84, 36: 44, 51: 67, 71: 91, 80: 100,
};
const SNAKE_LADDER_SNAKES = {
  16: 6, 47: 26, 49: 11, 56: 53, 62: 19, 64: 60, 87: 24, 93: 73, 95: 75, 98: 78,
};
const FINAL_SQUARE = 100;
const CHESS_CLOCK_SECONDS = 600;

function initGameState(gameId, players) {
  if (gameId === 'snake-and-ladder') {
    const [p1, p2] = players;
    return {
      positions: { [p1.id]: 1, [p2.id]: 1 },
      turn: p1.id,
    };
  }
  if (gameId === 'chess') {
    return {
      fen: new Chess().fen(),
      clock: {
        white: CHESS_CLOCK_SECONDS,
        black: CHESS_CLOCK_SECONDS,
        activeColor: 'w',
        lastTickAt: Date.now(),
      },
    };
  }
  return null;
}

function rollDice(state, playerIds, playerId) {
  if (state.turn !== playerId) {
    return { error: 'Not your turn' };
  }
  const roll = Math.floor(Math.random() * 6) + 1;
  let newPosition = state.positions[playerId] + roll;

  // Overshooting 100 means you don't move this turn.
  if (newPosition > FINAL_SQUARE) {
    newPosition = state.positions[playerId];
  } else if (SNAKE_LADDER_LADDERS[newPosition]) {
    newPosition = SNAKE_LADDER_LADDERS[newPosition];
  } else if (SNAKE_LADDER_SNAKES[newPosition]) {
    newPosition = SNAKE_LADDER_SNAKES[newPosition];
  }

  state.positions[playerId] = newPosition;
  const winner = newPosition === FINAL_SQUARE ? playerId : null;
  const otherId = playerIds.find((id) => id !== playerId);
  const nextTurn = winner ? null : otherId;
  state.turn = nextTurn;

  return { roll, newPosition, nextTurn, winner };
}

function applyChessMove(state, move) {
  const chess = new Chess(state.fen);
  let result;
  try {
    result = chess.move(move);
  } catch {
    return { error: 'Invalid move' };
  }
  if (!result) return { error: 'Invalid move' };

  state.fen = chess.fen();

  let clock = null;
  let timedOut = null;
  if (state.clock) {
    const moverColor = state.clock.activeColor;
    const moverKey = moverColor === 'w' ? 'white' : 'black';
    const elapsed = (Date.now() - state.clock.lastTickAt) / 1000;
    state.clock[moverKey] = Math.max(0, state.clock[moverKey] - elapsed);
    state.clock.activeColor = moverColor === 'w' ? 'b' : 'w';
    state.clock.lastTickAt = Date.now();
    clock = { ...state.clock };
    if (state.clock[moverKey] <= 0) {
      timedOut = moverColor;
    }
  }

  return {
    move: result,
    fen: chess.fen(),
    turn: chess.turn(),
    isCheck: chess.inCheck(),
    isCheckmate: chess.isCheckmate(),
    clock,
    timedOut,
  };
}

module.exports = { initGameState, rollDice, applyChessMove };
