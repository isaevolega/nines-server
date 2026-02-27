// src/game/Validator.ts
import { Card, Suit, Rank, Player } from '../types';

const RANKS: Rank[] = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function getRankIndex(rank: Rank): number {
  return RANKS.indexOf(rank);
}

export function isValidMove(card: Card, pile: Card[]): boolean {
  // 1. Если стопка пустая — можно класть только 9
  if (pile.length === 0) {
    return card.rank === '9';
  }

  // 2. Если стопка не пустая — 9 класть нельзя (только в пустую)
  if (card.rank === '9') {
    return false;
  }

  const topCard = pile[pile.length - 1];
  const bottomCard = pile[0];

  const cardValue = getRankIndex(card.rank);
  const topValue = getRankIndex(topCard.rank);
  const bottomValue = getRankIndex(bottomCard.rank);

  // Можно положить на 1 выше верхней ИЛИ на 1 ниже нижней
  const canPlaceOnTop = cardValue === topValue + 1;
  const canPlaceOnBottom = cardValue === bottomValue - 1;

  return canPlaceOnTop || canPlaceOnBottom;
}

export function getValidMoves(hand: Card[], piles: Record<Suit, Card[]>): Card[] {
  return hand.filter(card => {
    const pile = piles[card.suit];
    return isValidMove(card, pile || []);
  });
}