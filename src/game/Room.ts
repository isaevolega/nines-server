// src/game/Room.ts
import { v4 as uuidv4 } from 'uuid';
import { Card, Player, RoomState, Suit, PlayerStatus } from '../types';
import { createDeck, shuffleDeck } from './Deck';

export class Room {
  public id: string;
  public state: RoomState;
  private timerInterval: NodeJS.Timeout | null = null;

  constructor(id: string, organizer: Player) {
    this.id = id;
    this.state = {
      roomId: id,
      players: [organizer],
      piles: { diamonds: [], hearts: [], spades: [], clubs: [] },
      turnIndex: 0,
      timer: 30,
      gameOver: false,
      firstMoveAutoPlayed: false,
      createdAt: Date.now(),
    };
  }

  addPlayer(player: Player): boolean {
    if (this.state.players.length >= 4) return false;
    if (this.state.gameOver) return false;
    // Если игрок переподключается (same ID), обновляем socketId и статус
    const existing = this.state.players.find(p => p.id === player.id);
    if (existing) {
      existing.socketId = player.socketId;
      existing.status = 'active';
      return true;
    }
    this.state.players.push(player);
    return true;
  }

  removePlayer(playerId: string): void {
    const player = this.state.players.find(p => p.id === playerId);
    if (player) {
      player.status = 'left';
      // Если организатор вышел, передаем права первому активному
      if (player.isOrganizer) {
        const newOrganizer = this.state.players.find(p => p.id !== playerId && p.status === 'active');
        if (newOrganizer) newOrganizer.isOrganizer = true;
      }
    }
  }

  startGame(): boolean {
    const activePlayers = this.state.players.filter(p => p.status === 'active');
    if (activePlayers.length < 2) return false;

    // Раздача карт
    const deck = shuffleDeck(createDeck());
    const cardsPerPlayer = 36 / activePlayers.length; // 18, 12 или 9

    activePlayers.forEach((player, index) => {
      player.hand = deck.slice(index * cardsPerPlayer, (index + 1) * cardsPerPlayer);
      player.cardCount = player.hand.length;
    });

    this.state.firstMoveAutoPlayed = false;
    this.state.gameOver = false;
    this.state.turnIndex = 0; // Временно, будет пересчитано после авто-хода 9♦

    // Логика первого хода (9♦)
    this.executeFirstAutoMove();
    
    this.startTimer();
    return true;
  }

  private executeFirstAutoMove(): void {
    // Найти игрока с 9 бубен
    const playerWith9Diamonds = this.state.players.find(p => 
      p.hand.some(c => c.suit === 'diamonds' && c.rank === '9')
    );

    if (playerWith9Diamonds) {
      // Найти индекс игрока в массиве activePlayers
      const activePlayers = this.state.players.filter(p => p.status === 'active');
      const playerIndex = activePlayers.findIndex(p => p.id === playerWith9Diamonds.id);
      
      // Удалить карту из руки
      const cardIndex = playerWith9Diamonds.hand.findIndex(c => c.suit === 'diamonds' && c.rank === '9');
      if (cardIndex > -1) {
        const card = playerWith9Diamonds.hand.splice(cardIndex, 1)[0];
        // Положить на стол
        this.state.piles.diamonds.push(card);
        playerWith9Diamonds.cardCount = playerWith9Diamonds.hand.length;
        
        this.state.firstMoveAutoPlayed = true;
        // Ход переходит к следующему
        this.state.turnIndex = (playerIndex + 1) % activePlayers.length;
      }
    } else {
      // Если 9♦ нет (ошибка логики или колоды), начинаем с 0
      this.state.firstMoveAutoPlayed = true;
      this.state.turnIndex = 0;
    }
  }

  startTimer(): void {
    if (this.timerInterval) clearInterval(this.timerInterval);
    
    this.state.timer = 30;
    this.timerInterval = setInterval(() => {
      if (this.state.timer > 0) {
        this.state.timer--;
      } else {
        this.handleTimerEnd();
      }
    }, 1000);
  }

  private handleTimerEnd(): void {
    // Логика авто-хода или пропуска будет вызвана из обработчика WS
    // Здесь просто сбрасываем таймер, логика хода в handler
    if (this.timerInterval) clearInterval(this.timerInterval);
  }

  stopTimer(): void {
    if (this.timerInterval) clearInterval(this.timerInterval);
  }

  getCurrentPlayer(): Player | undefined {
    const activePlayers = this.state.players.filter(p => p.status === 'active');
    return activePlayers[this.state.turnIndex];
  }
}