// src/game/Deck.ts
import { Card, Suit, Rank } from '../types';

const SUITS: Suit[] = ['diamonds', 'hearts', 'spades', 'clubs'];
const RANKS: Rank[] = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export function createDeck(): Card[] {
  const deck: Card[] = [];
  SUITS.forEach(suit => {
    RANKS.forEach((rank, index) => {
      deck.push({ suit, rank, value: index });
    });
  });
  return deck;
}

export function shuffleDeck(deck: Card[]): Card[] {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function getRankValue(rank: Rank): number {
  return RANKS.indexOf(rank);
}