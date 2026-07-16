import * as pdfjsLib from 'pdfjs-dist';

// We configure the PDF.js worker to load locally from node_modules using Vite's native URL asset system
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

export interface Paragraph {
  id: string;
  text: string;
  pageNumber: number;
}

export interface ParsedPDF {
  title: string;
  paragraphs: Paragraph[];
  totalPages: number;
}

/**
 * Extracts structured text from a PDF file as reflowable paragraphs.
 */
export async function parsePdfFile(file: File, onProgress?: (progress: number) => void): Promise<ParsedPDF> {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  
  // Track loading progress if requested
  loadingTask.onProgress = (progressData: any) => {
    if (onProgress && progressData.total > 0) {
      const percentage = Math.round((progressData.loaded / progressData.total) * 100);
      onProgress(percentage);
    }
  };

  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;
  const paragraphs: Paragraph[] = [];
  let paragraphCounter = 0;

  // IMPORTANT: acest text "curent" e tinut in AFARA buclei de pagini si NU se
  // mai forteaza sa fie salvat la finalul fiecarei pagini. Inainte, orice
  // propozitie care se intampla sa fie taiata exact la granita dintre doua
  // pagini PDF (foarte frecvent) devenea automat DOUA paragrafe separate:
  // unul minuscul la finalul unei pagini si continuarea lui, la fel de
  // minuscula, la inceputul paginii urmatoare. Vizual, acel "paragraf" de
  // 2-3 cuvinte primea acelasi spatiu gol ca un paragraf normal -> exact
  // golurile ciudate observate in citire.
  let runningText = '';
  let runningStartPage = 1;

  const pushRunningParagraph = () => {
    if (runningText.trim().length > 0) {
      paragraphs.push({
        id: `p-${runningStartPage}-${paragraphCounter++}`,
        text: cleanText(runningText),
        pageNumber: runningStartPage,
      });
    }
    runningText = '';
  };

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const items = textContent.items as any[];

    if (items.length === 0) continue;

    // Sort items by vertical position top-to-bottom (Y decreases downwards in PDF space)
    // and then by horizontal position left-to-right (X increases)
    // Note: page.getTextContent() usually returns them in physical reading order,
    // but a sort guarantees robust reading order in multi-column or complex layouts.
    
    // Let's analyze line structure
    let currentPageLines: { text: string; y: number; height: number; x: number }[] = [];
    let currentLine: { text: string; y: number; height: number; x: number } | null = null;

    // We tolerance Y values that are within 3-4 points of each other as being on the "same line"
    const Y_TOLERANCE = 3;

    for (const item of items) {
      if (!item.str || item.str.trim() === '') continue;

      const x = item.transform[4];
      const y = item.transform[5];
      const height = item.transform[3]; // Approx font height

      if (!currentLine) {
        currentLine = { text: item.str, y, height, x };
      } else if (Math.abs(currentLine.y - y) <= Y_TOLERANCE) {
        // Same line: append text, spacing out if they are not adjacent
        const needsSpace = x > (currentLine.x + currentLine.text.length * (currentLine.height * 0.3));
        currentLine.text += (needsSpace ? ' ' : '') + item.str;
        currentLine.x = x;
      } else {
        // New line: save previous line and start a new one
        currentPageLines.push(currentLine);
        currentLine = { text: item.str, y, height, x };
      }
    }
    if (currentLine) {
      currentPageLines.push(currentLine);
    }

    // Now, let's assemble lines into Paragraphs!
    // A paragraph break is defined by a larger vertical gap between consecutive lines
    // than the standard line height.
    if (currentPageLines.length > 0) {
      // Sort lines top-to-bottom (Y is descending)
      currentPageLines.sort((a, b) => b.y - a.y);

      for (let i = 0; i < currentPageLines.length; i++) {
        const line = currentPageLines[i];

        if (runningText === '') {
          runningText = line.text;
          runningStartPage = pageNum;
          continue;
        }

        let isParagraphBreak: boolean;
        if (i === 0) {
          // Prima linie a acestei pagini: nu avem coordonate Y comparabile cu
          // pagina anterioara (sistemul de coordonate se reseteaza per pagina),
          // deci decidem DOAR pe baza de punctuatie: daca textul anterior se
          // termina clar cu semn de final de propozitie SI linia noua incepe
          // cu majuscula, e probabil un paragraf nou. Altfel, e continuarea
          // aceleiasi propozitii taiate de saltul de pagina -> le unim.
          const endsWithSentencePunct = /[.!?"'\u201D\u2019]$/.test(runningText.trim());
          const startsWithCapital = /^[A-Z"\u201C]/.test(line.text.trim());
          isParagraphBreak = endsWithSentencePunct && startsWithCapital;
        } else {
          const prevLine = currentPageLines[i - 1];
          const verticalGap = prevLine.y - line.y - prevLine.height;
          // If vertical gap is greater than 1.5 times the line height, we treat it as a paragraph break.
          // Or if the line ends with common sentence end characters and the next starts with capital.
          isParagraphBreak = verticalGap > (prevLine.height * 1.5) ||
                              (runningText.trim().endsWith('.') && /^[A-Z]/.test(line.text.trim()));
        }

        if (isParagraphBreak) {
          pushRunningParagraph();
          runningText = line.text;
          runningStartPage = pageNum;
        } else {
          // Continue paragraph
          // If the last word of the paragraph doesn't end with hyphen, add a space
          const endsWithHyphen = runningText.trim().endsWith('-');
          if (endsWithHyphen) {
            runningText = runningText.trim().slice(0, -1) + line.text;
          } else {
            runningText += ' ' + line.text;
          }
        }
      }
    }

    // Provide progress update (scale up to 100%)
    if (onProgress) {
      const percentage = Math.round((pageNum / numPages) * 100);
      onProgress(percentage);
    }
  }

  // Push whatever paragraph remained accumulated after the very last page
  pushRunningParagraph();

  // Fallback title to filename if metadata is missing
  let title = file.name.replace(/\.[^/.]+$/, "");
  
  // Try to get PDF metadata title
  try {
    const metadata = await pdf.getMetadata();
    if (metadata?.info && (metadata.info as any).Title) {
      title = (metadata.info as any).Title;
    }
  } catch (e) {
    console.warn("Failed to extract PDF title metadata", e);
  }

  return {
    title,
    paragraphs,
    totalPages: numPages,
  };
}

/**
 * Clean up text anomalies like multiple spaces, weird hyphens, or spacing characters.
 */
function cleanText(text: string): string {
  return text
    .replace(/\s+/g, ' ') // Replace multiple consecutive whitespaces with a single space
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // Remove zero-width spaces
    .trim();
}
