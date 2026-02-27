// src/server.ts
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Room } from './game/Room';
import { ClientMessage, Player, Card, RoomState } from './types';
import { v4 as uuidv4 } from 'uuid';

const PORT = process.env.PORT || 10000;
const rooms = new Map<string, Room>();
const wsClients = new Map<WebSocket, string>(); // ws -> playerId

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('New connection');

  ws.on('message', (data) => {
    try {
      const msg: ClientMessage = JSON.parse(data.toString());
      handleMessage(ws, msg);
    } catch (e) {
      console.error('Invalid JSON', e);
    }
  });

  ws.on('close', () => {
    const playerId = wsClients.get(ws);
    if (playerId) {
      console.log(`Player ${playerId} disconnected`);
      handleDisconnect(playerId);
    }
    wsClients.delete(ws);
  });
});

function handleMessage(ws: WebSocket, msg: ClientMessage) {
  const playerId = wsClients.get(ws);
  if (!playerId && msg.type !== 'join') return;

  switch (msg.type) {
    case 'join':
      handleJoin(ws, msg);
      break;
    case 'start_game':
      handleStartGame(ws, msg);
      break;
    case 'play_card':
      handlePlayCard(ws, msg);
      break;
    case 'skip_turn':
      handleSkipTurn(ws, msg);
      break;
    case 'leave':
      handleLeave(ws, msg);
      break;
  }
}

function handleJoin(ws: WebSocket, msg: ClientMessage) {
  if (!msg.roomId || !msg.playerName) return;

  let room = rooms.get(msg.roomId);
  const playerId = msg.playerId || uuidv4();
  
  wsClients.set(ws, playerId);

  if (!room) {
    const organizer: Player = {
      id: playerId,
      name: msg.playerName,
      socketId: '',
      hand: [],
      status: 'active',
      isOrganizer: true,
      cardCount: 0
    };
    room = new Room(msg.roomId, organizer);
    rooms.set(msg.roomId, room);
  } else {
    if (room.state.gameOver) {
      send(ws, { type: 'notification', message: 'Игра уже завершилась', severity: 'error' });
      return;
    }
    
    // Проверка на присоединение к начатой игре (если игры нет в лобби)
    // По ТЗ: Нельзя присоединиться к комнате, в которой игра уже началась
    // Но у нас флаг gameOver. Если игра идет (cards dealt), но gameOver=false, то нужно проверить.
    // Упростим: если есть карты у игроков — игра началась.
    const gameStarted = room.state.players.some(p => p.hand.length > 0);
    if (gameStarted) {
       send(ws, { type: 'notification', message: 'Игра уже началась', severity: 'error' });
       return;
    }

    room.addPlayer({
      id: playerId,
      name: msg.playerName,
      socketId: '',
      hand: [],
      status: 'active',
      isOrganizer: false,
      cardCount: 0
    });
  }

  // Отмена дисконнекта если был
  room.cancelDisconnect(playerId);

  send(ws, {
    type: 'join_success',
    playerId: playerId,
    roomState: sanitizeState(room!.state, playerId)
  });
  
  broadcast(room!, {
    type: 'notification',
    message: `${msg.playerName} присоединился`,
    severity: 'info'
  }, playerId);
}

function handleStartGame(ws: WebSocket, msg: ClientMessage) {
  const playerId = wsClients.get(ws);
  if (!playerId) return;

  const room = Array.from(rooms.values()).find(r => 
    r.state.players.some(p => p.id === playerId && p.isOrganizer)
  );

  if (room) {
    const activePlayers = room.state.players.filter(p => p.status === 'active');
    if (activePlayers.length >= 2) {
      room.startGame();
      broadcast(room, { type: 'game_state', data: {} });
    } else {
      send(ws, { type: 'notification', message: 'Нужно минимум 2 игрока', severity: 'error' });
    }
  }
}

function handlePlayCard(ws: WebSocket, msg: ClientMessage) {
  const playerId = wsClients.get(ws);
  if (!playerId || !msg.card) return;

  const room = Array.from(rooms.values()).find(r => 
    r.state.players.some(p => p.id === playerId)
  );

  if (room) {
    const result = room.playCard(playerId, msg.card as Card);
    if (result.success) {
      broadcast(room, { type: 'game_state', data: {} });
    } else {
      send(ws, { type: 'notification', message: result.message || 'Ошибка хода', severity: 'error' });
    }
  }
}

function handleSkipTurn(ws: WebSocket, msg: ClientMessage) {
  const playerId = wsClients.get(ws);
  if (!playerId) return;

  const room = Array.from(rooms.values()).find(r => 
    r.state.players.some(p => p.id === playerId)
  );

  if (room) {
    const result = room.skipTurn(playerId);
    if (result.success) {
      broadcast(room, { 
        type: 'notification', 
        message: 'Ход пропущен', 
        severity: 'info' 
      });
      broadcast(room, { type: 'game_state', data: {} });
    } else {
      send(ws, { type: 'notification', message: result.message || 'Нельзя пропустить', severity: 'error' });
    }
  }
}

function handleLeave(ws: WebSocket, msg: ClientMessage) {
  const playerId = wsClients.get(ws);
  if (!playerId) return;

  const room = Array.from(rooms.values()).find(r => 
    r.state.players.some(p => p.id === playerId)
  );

  if (room) {
    room.removePlayer(playerId);
    broadcast(room, {
      type: 'notification',
      message: 'Игрок покинул игру',
      severity: 'info'
    });
    broadcast(room, { type: 'game_state', data: {} });
    
    // Если комната пустая — удаляем
    if (room.state.players.every(p => p.status === 'left')) {
      rooms.delete(room.id);
    }
  }
  wsClients.delete(ws);
  ws.close();
}

function handleDisconnect(playerId: string) {
  const room = Array.from(rooms.values()).find(r => 
    r.state.players.some(p => p.id === playerId)
  );

  if (room) {
    // Запускаем таймер 10 сек перед помечанием offline
    room.scheduleDisconnect(playerId, () => {
      broadcast(room, {
        type: 'notification',
        message: 'Игрок потерял соединение',
        severity: 'info'
      });
      broadcast(room, { type: 'game_state', data: {} });
    });
  }
}

function send(ws: WebSocket, msg: any) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(room: Room, msg: any, excludeId?: string) {
  wss.clients.forEach(client => {
    const pId = wsClients.get(client);
    const player = room.state.players.find(p => p.id === pId);
    
    if (client.readyState === WebSocket.OPEN && player && pId !== excludeId) {
      if (msg.type === 'game_state') {
        send(client, {
          type: 'game_state',
          data: sanitizeState(room.state, pId!)
        });
      } else {
        send(client, msg);
      }
    }
  });
}

function sanitizeState(state: RoomState, viewerId: string): any {
  const activePlayers = state.players.filter(p => p.status === 'active');
  const currentPlayer = activePlayers[state.turnIndex];

  return {
    roomId: state.roomId,
    players: state.players.map(p => ({
      id: p.id,
      name: p.name,
      cardCount: p.cardCount,
      isCurrentTurn: currentPlayer?.id === p.id,
      status: p.status,
      isOrganizer: p.isOrganizer
    })),
    centerPiles: Object.fromEntries(
      Object.entries(state.piles).map(([suit, cards]) => [
        suit,
        cards.map(c => c.rank) // Только ранги для клиента
      ])
    ),
    timer: state.timer,
    gameOver: state.gameOver,
    firstMoveAutoPlayed: state.firstMoveAutoPlayed
  };
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});