// src/server.ts
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { Room } from './game/Room';
import { ClientMessage, Player, Card, RoomState } from './types';
import { generateRoomId } from './utils/idGenerator';

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
  
  console.log('');
  console.log('Message', msg);
  console.log('============================');

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
  if (!msg.playerName) return;

  let room: Room | undefined;
  const playerId = msg.playerId || randomUUID();
  
  wsClients.set(ws, playerId);

  if (!msg.roomId) {
    // 🔥 Создаём новую комнату
    let roomId = generateRoomId();
    while (rooms.has(roomId)) {
      roomId = generateRoomId();
    }
    
    const organizer: Player = {
      id: playerId,
      name: msg.playerName,
      socketId: '',
      hand: [],
      status: 'active',
      isOrganizer: true,
      cardCount: 0
    };
    
    // 🔥 Передаём callback'и при создании комнаты
    room = new Room(
      roomId, 
      organizer, 
      (room) => broadcastGameState(room),
      (room, message, severity) => broadcastNotification(room, message, severity)
    );
    
    rooms.set(roomId, room);
  } else {
    // 🔥 Вход в существующую комнату
    room = rooms.get(msg.roomId);
    
    if (!room) {
      send(ws, { type: 'notification', message: 'Комната не найдена', severity: 'error' });
      return;
    }
    
    if (room.state.gameOver || room.state.players.some(p => p.hand.length > 0)) {
      send(ws, { type: 'notification', message: 'Игра уже началась', severity: 'error' });
      return;
    }

    if (room.state.players.length >= 4) {
      send(ws, { type: 'notification', message: 'Комната заполнена', severity: 'error' });
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

  room.cancelDisconnect(playerId);

  // 🔥 Отправляем успешный join новому игроку
  send(ws, {
    type: 'join_success',
    playerId: playerId,
    roomState: sanitizeState(room!.state, playerId)
  });
  
  // 🔥 Уведомляем остальных о присоединении
  broadcast(room!, {
    type: 'notification',
    message: `${msg.playerName} присоединился`,
    severity: 'info'
  }, playerId);

  // 🔥 Отправляем обновлённое состояние всем (кроме нового игрока — он уже получил в join_success)
  broadcastGameStateExcept(room!, playerId);
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
      // 🔥 Room сам отправит game_state через callback после startGame
    } else {
      send(ws, { type: 'notification', message: 'Нужно минимум 2 игрока', severity: 'error' });
    }
  }
}

function handlePlayCard(ws: WebSocket, msg: ClientMessage) {
  const playerId = wsClients.get(ws);
  if (!playerId || !msg.card) return;
  
  console.log('[WS] play_card:', msg.card);

  const room = Array.from(rooms.values()).find(r => 
    r.state.players.some(p => p.id === playerId)
  );

  if (room) {
    const result = room.playCard(playerId, msg.card as Card);
    if (result.success) {
      if (room.state.gameOver) {
        // 🔥 Отправляем game_over всем
        broadcast(room, {
          type: 'game_over',
          winner: playerId,
          rankings: room.getRankings()
        });
        
        setTimeout(() => {
          if (rooms.has(room.id)) {
            room.destroy();
            rooms.delete(room.id);
          }
        }, 120000);
      }
      // 🔥 Room сам отправит game_state через callback после playCard
    } else {
      send(ws, { 
        type: 'notification', 
        message: result.message || 'Неверный ход', 
        severity: 'error' 
      });
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
    if (!result.success) {
      send(ws, {
        type: 'notification',
        message: result.message || 'Ошибка пропуска',
        severity: 'error'
      });
    }
    // 🔥 Room сам отправит notification и game_state через callback
  }
}

function handleLeave(ws: WebSocket, msg: ClientMessage) {
  const playerId = wsClients.get(ws);
  if (!playerId) return;

  const room = Array.from(rooms.values()).find(r => 
    r.state.players.some(p => p.id === playerId)
  );

  if (room) {
    const playerName = room.state.players.find(p => p.id === playerId)?.name || 'Игрок';
    room.removePlayer(playerId);
    // 🔥 Room сам отправит notification и game_state через callback
  }
  
  wsClients.delete(ws);
  ws.close();
}

function handleDisconnect(playerId: string) {
  const room = Array.from(rooms.values()).find(r => 
    r.state.players.some(p => p.id === playerId)
  );

  if (room) {
    room.scheduleDisconnect(playerId, () => {
      // 🔥 Room сам отправит notification через callback
    });
  }
}

function send(ws: WebSocket, msg: any) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// 🔥 Broadcast с исключением игрока (для простых уведомлений)
function broadcast(room: Room, msg: any, excludeId?: string) {
  console.log(`[BROADCAST] Тип: ${msg.type}, Исключаем: ${excludeId}`);
  
  wss.clients.forEach(client => {
    const pId = wsClients.get(client);
    
    if (!pId) return;
    
    const player = room.state.players.find(p => p.id === pId);
    
    if (!player) return;
    
    if (client.readyState !== WebSocket.OPEN) return;
    
    if (pId === excludeId) return;
    
    console.log(`[BROADCAST] Отправка ${msg.type} игроку ${player.name}`);
    send(client, msg);
  });
}

// 🔥 Отправка game_state всем игрокам комнаты (вызывается из Room через callback)
function broadcastGameState(room: Room) {
  console.log(`[BROADCAST] Game state для комнаты ${room.id}`);
  
  wss.clients.forEach(client => {
    const pId = wsClients.get(client);
    if (!pId) return;
    
    const player = room.state.players.find(p => p.id === pId);
    if (!player || client.readyState !== WebSocket.OPEN) return;
    
    send(client, {
      type: 'game_state',
      data: sanitizeState(room.state, pId)
    });
  });
}

// 🔥 Отправка game_state всем КРОМЕ указанного игрока
function broadcastGameStateExcept(room: Room, excludeId: string) {
  wss.clients.forEach(client => {
    const pId = wsClients.get(client);
    if (!pId || pId === excludeId) return;
    
    const player = room.state.players.find(p => p.id === pId);
    if (!player || client.readyState !== WebSocket.OPEN) return;
    
    send(client, {
      type: 'game_state',
      data: sanitizeState(room.state, pId)
    });
  });
}

// 🔥 Отправка уведомления всем игрокам комнаты (вызывается из Room через callback)
function broadcastNotification(room: Room, message: string, severity: string) {
  console.log(`[BROADCAST] Уведомление: ${message} (${severity})`);
  
  wss.clients.forEach(client => {
    const pId = wsClients.get(client);
    if (!pId) return;
    
    const player = room.state.players.find(p => p.id === pId);
    if (!player || client.readyState !== WebSocket.OPEN) return;
    
    send(client, {
      type: 'notification',
      message: message,
      severity: severity
    });
  });
}

function sanitizeState(state: RoomState, viewerId: string): any {
  const activePlayers = state.players.filter(p => p.status === 'active');
  const currentPlayer = activePlayers[state.turnIndex];
  const viewer = state.players.find(p => p.id === viewerId);

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
    myHand: viewer?.id === viewerId 
      ? viewer?.hand.map(c => ({ suit: c.suit, rank: c.rank })) 
      : [],
    centerPiles: Object.fromEntries(
      Object.entries(state.piles).map(([suit, cards]) => [
        suit,
        [...cards.map(c => c.rank)]
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