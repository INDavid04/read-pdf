import { GoogleGenAI } from '@google/genai';
import type { Paragraph } from './pdfParser';

const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });

export async function smartCleanParagraphsWithAI(
  paragraphs: Paragraph[], 
  startIndex: number = 0, 
  batchSize: number = 30,
  onProgress?: (processed: number, total: number) => void
) {
  const batch = paragraphs.slice(startIndex, startIndex + batchSize);
  if (batch.length === 0) return { updatedParagraphs: paragraphs, nextIndex: startIndex, hasMore: false };

  const textsToClean = batch.map(p => p.text);
  const expectedCount = batch.length;

  const prompt = `
Ești un corector tipografic expert în limba română și limba engleză. 
Sarcina ta este EXCLUSIV de a corecta erorile de parsare dintr-un PDF (cuvinte despărțite greșit de cratime la capăt de rând, spații anormale între litere, diacritice greșite, numere de pagină rătăcite sau antete).

REGULI ABSOLUTE ȘI STRICTE:
1. NU schimba sensul, NU rescrie stilul autorului și NU face NICIUN FEL DE REZUMAT. Textul trebuie să rămână în întregime, cuvânt cu cuvânt, doar cu erorile tipografice reparate.
2. LUNGIMEA ARRAY-ULUI: Trebuie să returnezi EXACT același număr de elemente pe care l-ai primit. Ai primit ${expectedCount} paragrafe, TREBUIE să returnezi un array JSON cu exact ${expectedCount} string-uri. Nu contopi paragrafe, nu tăia paragrafe și nu adăuga altele în plus.
3. FORMATUL: Returnează DOAR un array valid de string-uri JSON (de exemplu: ["text 1 corectat", "text 2 corectat"]). Fără elemente goale.
4. FĂRĂ MARKDOWN: Nu adăuga NICIUN fel de bloc markdown (fără \`\`\`json sau \`\`\` la început sau sfârșit), returnează doar textul JSON pur.

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
    rawText = rawText.replace(/,\s*,/g, ','); 

    const cleanedTexts: string[] = JSON.parse(rawText);
    
    // 🛡️ Plasăm o plasă de siguranță: dacă din greșeală modelul returnează alt număr de elemente,
    // păstrăm textul original pentru a nu corupe sau pierde date din carte!
    const updated = [...paragraphs];
    for (let i = 0; i < batch.length; i++) {
      if (cleanedTexts[i] !== undefined && cleanedTexts[i] !== null && typeof cleanedTexts[i] === 'string') {
        updated[startIndex + i] = { ...updated[startIndex + i], text: cleanedTexts[i] };
      }
    }

    const nextIndex = startIndex + batch.length;

    if (onProgress) {
      onProgress(Math.min(nextIndex, paragraphs.length), paragraphs.length);
    }

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
