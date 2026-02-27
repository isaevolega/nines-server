// src/types/index.ts

export type Suit = 'diamonds' | 'hearts' | 'spades' | 'clubs';
export type Rank = '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';

export interface Card {
  suit: Suit;
  rank: Rank;
  value: number;
}

export type PlayerStatus = 'lobby' | 'active' | 'offline' | 'left';

export interface Player {
  id: string;
  name: string;
  socketId: string;
  hand: Card[];
  status: PlayerStatus;
  isOrganizer: boolean;
  cardCount: number;
}

export interface Pile {
  suit: Suit;
  cards: Card[];
}

export interface RoomState {
  roomId: string;
  players: Player[];
  piles: Record<Suit, Card[]>;
  turnIndex: number;
  timer: number;
  gameOver: boolean;
  firstMoveAutoPlayed: boolean;
  createdAt: number;
}

// === СООБЩЕНИЯ КЛИЕНТ -> СЕРВЕР ===
export type ClientMessageType = 'join' | 'start_game' | 'play_card' | 'skip_turn' | 'leave';

export interface ClientMessage {
  type: ClientMessageType;
  roomId?: string;
  playerName?: string;
  playerId?: string;
  card?: { suit: Suit; rank: Rank };
}

// === СООБЩЕНИЯ СЕРВЕР -> КЛИЕНТ ===
export type ServerMessageType = 
  | 'game_state' 
  | 'notification' 
  | 'game_over' 
  | 'join_success';

// Базовый интерфейс
export interface ServerMessage {
  type: ServerMessageType;
}

// Специфичные типы для каждого сообщения
export interface JoinSuccessMessage extends ServerMessage {
  type: 'join_success';
  playerId: string;
  roomState: any; // Санитайзированное состояние комнаты
}

export interface GameStateMessage extends ServerMessage {
  type: 'game_state';
  data: any; // Санитайзированное состояние комнаты
}

export interface NotificationMessage extends ServerMessage {
  type: 'notification';
  message: string;
  severity?: 'info' | 'error' | 'success';
}

export interface GameOverMessage extends ServerMessage {
  type: 'game_over';
  winner: string;
  rankings: { playerId: string; place: number }[];
}

// Объединённый тип для отправки
export type OutgoingMessage = 
  | JoinSuccessMessage 
  | GameStateMessage 
  | NotificationMessage 
  | GameOverMessage;

export interface GameStateData {
  roomId: string;
  players: Array<{
    id: string;
    name: string;
    cardCount: number;
    isCurrentTurn: boolean;
    status: string;
    isOrganizer: boolean;
  }>;
  myHand?: Array<{ suit: string; rank: string }>; // Только для владельца
  centerPiles: Record<string, string[]>;
  timer: number;
  gameOver: boolean;
  firstMoveAutoPlayed: boolean;
}