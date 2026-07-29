import { GoogleGenAI } from '@google/genai';
import type { Paragraph } from './pdfParser';

const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });

export async function smartCleanParagraphsWithAI(paragraphs: Paragraph[], startIndex: number = 0, batchSize: number = 30) {
  const batch = paragraphs.slice(startIndex, startIndex + batchSize);
  if (batch.length === 0) return { updatedParagraphs: paragraphs, nextIndex: startIndex, hasMore: false };

  const textsToClean = batch.map(p => p.text);

  const prompt = `
Ești un corector tipografic expert în limba română. 
Corectează erorile de parsare dintr-un PDF (cuvinte despărțite greșit de cratime, spații anormale între litere, numere de pagină sau antete rătăcite).
REGULI STRICTE:
1. Nu schimba sensul și nu rescrie stilul autorului.
2. Returnează UN ARRAY VALID DE STRING-URI JSON (de exemplu: ["text 1", "text 2"]). Asigură-te că array-ul este corect formatat, fără elemente goale sau virgule în plus.
3. Nu adăuga niciun bloc markdown (fără \`\`\`json sau \`\`\` la început sau sfârșit), returnează doar textul JSON pur.

Iată paragrafele de corectat:
${JSON.stringify(textsToClean)}
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: prompt,
    });

    let rawText = response.text || '[]';
    rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    rawText = rawText.replace(/,\s*,/g, ','); // Curățare extra pentru virgule duble

    const cleanedTexts: string[] = JSON.parse(rawText);
    
    const updated = [...paragraphs];
    for (let i = 0; i < batch.length; i++) {
      if (cleanedTexts[i] !== undefined && cleanedTexts[i] !== null) {
        updated[startIndex + i] = { ...updated[startIndex + i], text: cleanedTexts[i] };
      }
    }

    const nextIndex = startIndex + batch.length;
    return {
      updatedParagraphs: updated,
      nextIndex,
      hasMore: nextIndex < paragraphs.length
    };

  } catch (error) {
    console.error("Eroare la curățarea batch-ului cu AI:", error);
    throw error;
  }
}
