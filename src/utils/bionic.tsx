import React from 'react';

/**
 * Transforms a single word into its Bionic Reading format.
 * Bolds the first 40-60% of the word to assist visual processing.
 */
export function renderBionicWord(word: string, index: number): React.ReactNode {
  if (!word) return '';

  // Match the core word and separate trailing punctuation or symbols
  const match = word.match(/^([a-zA-Z0-9À-ÿ'-]+)(.*)$/);
  if (!match) {
    return <span key={index}>{word} </span>;
  }

  const [, pureWord, punctuation] = match;
  
  if (pureWord.length === 0) {
    return <span key={index}>{word} </span>;
  }

  let boldLen = 1;
  const len = pureWord.length;

  if (len === 1) {
    boldLen = 1;
  } else if (len <= 3) {
    // Bold 1 char for 2-letter word, 2 chars for 3-letter word
    boldLen = Math.ceil(len * 0.6);
  } else {
    // Bold approx 40-50% for longer words
    boldLen = Math.ceil(len * 0.4);
  }

  const boldPart = pureWord.substring(0, boldLen);
  const restPart = pureWord.substring(boldLen);

  return (
    <span key={index} className="bionic-word">
      <strong className="bionic-bold" style={{ fontWeight: 700 }}>{boldPart}</strong>
      <span>{restPart}</span>
      {punctuation}{' '}
    </span>
  );
}

/**
 * Transforms an entire text string into Bionic Reading elements.
 */
export function renderBionicParagraph(text: string): React.ReactNode {
  const words = text.split(/\s+/);
  return (
    <span className="bionic-paragraph">
      {words.map((word, idx) => renderBionicWord(word, idx))}
    </span>
  );
}
