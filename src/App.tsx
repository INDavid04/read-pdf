import React, { useState, useEffect, useRef } from 'react';
import { parsePdfFile } from './utils/pdfParser';
import type { ParsedPDF } from './utils/pdfParser';
import { renderBionicParagraph } from './utils/bionic';
import { saveParsedPDF, getParsedPDF, deleteParsedPDF } from './utils/db';
import { smartCleanParagraphsWithAI } from './utils/aiCleaner';
import {
  signInWithGoogle,
  signOutUser,
  subscribeToAuthChanges,
  fetchCloudBookList,
  uploadFullBookToCloud,
  saveCloudBookMetadata,
  downloadBookContent,
  deleteFullBookFromCloud,
  isFirebaseConfigured,
  type User,
} from './utils/cloudSync';
import './App.css';

interface BookMetadata {
  id: string;
  title: string;
  totalPages: number;
  progressPercentage: number;
  lastActiveParagraphId: string | null;
  updatedAtMs: number;
  coverImage?: string;
  createdAt?: string;
  lastAccessedAt?: string;
}

interface UserProfile {
  name: string;
  totalBooksParsed: number;
  preferredTheme: string;
  joinedDate: string;
}

const FONT_SIZES = [16, 18, 20, 24, 28, 32, 36];

// In modul Coloane, randam intreaga carte deodata era principala cauza de
// incetineala la carti mari (1000+ pagini) - browserul trebuie sa calculeze
// layout-ul CSS multi-coloana pentru tot continutul simultan. Impartim cartea
// in "bucati" de PAGE_CHUNK_SIZE pagini originale din PDF si randam DOAR
// bucata curenta (+ trecem la urmatoarea/anterioara cand ajungi la capat).
const PAGE_CHUNK_SIZE = 150;

function App() {
  // --- APP STATE ---
  const [parsedPdf, setParsedPdf] = useState<ParsedPDF | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseProgress, setParseProgress] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [activeBookId, setActiveBookId] = useState<string | null>(null);

  // --- SETTINGS STATE ---
  const [theme, setTheme] = useState<string>('sepia');
  const [fontSize, setFontSize] = useState<number>(16);
  const [lineSpacing, setLineSpacing] = useState<number>(1.65);
  const [fontFamily, setFontFamily] = useState<string>('serif');
  const [isBionic, setIsBionic] = useState<boolean>(false);
  const [isProcessingBionic, setIsProcessingBionic] = useState<boolean>(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [layoutMode, setLayoutMode] = useState<'scroll' | 'page'>('scroll');
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageChunkIndex, setPageChunkIndex] = useState<number>(0);

  // --- PROFILE & SYNC STATE ---
  const [userProfile, setUserProfile] = useState<UserProfile>({
    name: 'Cititor Pasionat',
    totalBooksParsed: 0,
    preferredTheme: 'sepia',
    joinedDate: new Date().toLocaleDateString('ro-RO'),
  });
  const [recentBooks, setRecentBooks] = useState<BookMetadata[]>([]);
  const [tempProfileName, setTempProfileName] = useState('');

  // --- CLOUD SYNC STATE ---
  const [cloudUser, setCloudUser] = useState<User | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const progressSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- READER SCROLL STATE ---
  const [scrollPercentage, setScrollPercentage] = useState(0);
  const readerMainRef = useRef<HTMLDivElement>(null);
  const paragraphRefs = useRef<{ [key: string]: HTMLDivElement | null }>({});

  // Marcheaza momentul in care setarile INITIALE (din localStorage) au fost
  // efectiv aplicate in state. Fara acest flag, efectele de mai jos (care
  // salveaza tema/setarile in localStorage la orice schimbare) rulau si ele
  // la PRIMA randare, cand state-ul inca avea valorile default (setTheme/
  // setLayoutMode etc. din efectul de incarcare nu se aplicasera inca) -
  // suprascriind valorile reale salvate anterior cu default-uri, INAINTE ca
  // acestea sa apuce sa fie citite si afisate. De-asta parea ca "nimic nu se
  // salveaza" desi salvarea propriu-zisa functiona corect.
  const [hasHydrated, setHasHydrated] = useState(false);

  // --- AI CLEANER STATE ---
  const isCleaningRef = useRef(false);
  const [isAiCleaning, setIsAiCleaning] = useState(false);
  const [aiCleanStatus, setAiCleanStatus] = useState<string>('0 / 0');

  // --- LOADING SCREEN STATE ---
  const [isAppLoading, setIsAppLoading] = useState(true);
  const [isOpeningBook, setIsOpeningBook] = useState(false);

  // --------------------------------------------------------------------------
  // INITIAL LOADING & SYNC LOGIC
  // --------------------------------------------------------------------------
  useEffect(() => {
    // 1. Load profile from localStorage
    const savedProfile = localStorage.getItem('pdf_reader_profile');
    if (savedProfile) {
      try {
        const parsed = JSON.parse(savedProfile);
        setUserProfile(parsed);
        setTempProfileName(parsed.name);
      } catch (e) {
        console.error('Failed to parse local profile', e);
      }
    } else {
      setTempProfileName('Cititor Pasionat');
    }

    // 2. Load recent books metadata from localStorage
    let recents: BookMetadata[] = [];
    const savedRecent = localStorage.getItem('pdf_reader_recent_books');
    if (savedRecent) {
      try {
        recents = JSON.parse(savedRecent);
        setRecentBooks(recents);
      } catch (e) {
        console.error('Failed to parse recent books', e);
      }
    }

    // 3. Load reading settings from localStorage
    let loadedLayoutMode: 'scroll' | 'page' = 'scroll';
    const savedSettings = localStorage.getItem('pdf_reader_settings');
    if (savedSettings) {
      try {
        const settings = JSON.parse(savedSettings);
        if (settings.fontSize) setFontSize(settings.fontSize);
        if (settings.lineSpacing) setLineSpacing(settings.lineSpacing);
        if (settings.fontFamily) setFontFamily(settings.fontFamily);
        if (settings.isBionic !== undefined) setIsBionic(settings.isBionic);
        if (settings.layoutMode !== undefined) {
          setLayoutMode(settings.layoutMode);
          loadedLayoutMode = settings.layoutMode;
        }
      } catch (e) {
        console.error('Failed to parse settings', e);
      }
    }

    // 4. Load theme
    const savedTheme = localStorage.getItem('pdf_reader_theme');
    if (savedTheme) {
      setTheme(savedTheme);
    }

    // 5. Load active book from IndexedDB if exists
    const savedActiveId = localStorage.getItem('pdf_reader_active_book_id');
    if (savedActiveId && recents.some(b => b.id === savedActiveId)) {
      setActiveBookId(savedActiveId);
      // IMPORTANT: trecem loadedLayoutMode ca parametru explicit, NU ne bazam
      // pe state-ul "layoutMode" din React - la acest moment (tot in interiorul
      // efectului initial), setLayoutMode(...) de mai sus inca nu s-a aplicat
      // (actualizarile de state sunt asincrone), deci orice cod care ar citi
      // "layoutMode" chiar acum ar vedea inca valoarea default ('scroll'),
      // indiferent ce era salvat cu adevarat -> exact motivul pentru care
      // pozitia se restaura gresit la refresh, desi modul se salva corect.
      loadBookOnStartup(savedActiveId, recents, loadedLayoutMode);
    }

    // Abia ACUM marcam hidratarea ca fiind completa - toate setarile reale
    // au fost programate spre aplicare (impreuna, in acelasi batch). Efectele
    // de mai jos vor rula din nou dupa ce randarea reflecta aceste valori,
    // in loc sa scrie in localStorage valorile default de dinainte de incarcare.
    setHasHydrated(true);

    const timer = setTimeout(() => {
      setIsAppLoading(false);
    }, 400); // O mică întârziere fină de 0.4s ca să fie tranziția lină

    return () => clearTimeout(timer);
  }, []);

  const loadBookOnStartup = async (id: string, recentsList: BookMetadata[], modeAtLoad: 'scroll' | 'page') => {
    try {
      const bookData = await getParsedPDF(id);
      if (bookData) {
        setParsedPdf(bookData);
        
        // Restore last active paragraph and scroll or page position
        const metadata = recentsList.find(b => b.id === id);
        if (metadata) {
          setScrollPercentage(metadata.progressPercentage || 0);
          if (metadata.lastActiveParagraphId) {
            const p = bookData.paragraphs.find(par => par.id === metadata.lastActiveParagraphId);
            if (p) {
              if (modeAtLoad === 'scroll') setCurrentPage(p.pageNumber);
              restoreReadingPosition(p.id, 500, modeAtLoad, bookData);
            }
          }
          if (bookData.coverImage && !metadata.coverImage) {
            const updated = recentsList.map(b => {
              if (b.id === id) {
                return { ...b, coverImage: bookData.coverImage, updatedAtMs: Date.now() };
              }
              return b;
            });
            setRecentBooks(updated);
            localStorage.setItem('pdf_reader_recent_books', JSON.stringify(updated));
          }
        }
      } else {
        localStorage.removeItem('pdf_reader_active_book_id');
        setActiveBookId(null);
      }
    } catch (e) {
      console.error('Failed to load active book on startup', e);
    }
  };

  // Sync settings back to localStorage whenever they change
  useEffect(() => {
    if (!hasHydrated) return; // nu suprascrie inainte ca setarile reale sa fie incarcate
    const settings = { fontSize, lineSpacing, fontFamily, isBionic, layoutMode };
    localStorage.setItem('pdf_reader_settings', JSON.stringify(settings));
  }, [hasHydrated, fontSize, lineSpacing, fontFamily, isBionic, layoutMode]);

  // Sync theme to the html/body element
  useEffect(() => {
    document.body.className = '';
    document.body.classList.add(`theme-${theme}`);
    if (!hasHydrated) return; // clasa se aplica mereu, dar NU suprascriem localStorage inainte de hidratare
    localStorage.setItem('pdf_reader_theme', theme);
  }, [hasHydrated, theme]);

  // --------------------------------------------------------------------------
  // CLOUD SYNC (Firebase) - autentificare + reconciliere lista de carti
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (!isFirebaseConfigured) return;
    const unsubscribe = subscribeToAuthChanges(async (user) => {
      setCloudUser(user);
      if (!user) return;

      setIsSyncing(true);
      try {
        const cloudBooks = await fetchCloudBookList(user.uid);

        // Combinam local + cloud: pentru carti care exista in ambele, pastram
        // versiunea MAI RECENTA (dupa timestamp), nu pe cea cu procent mai mare -
        // altfel, daca revii cu bun-stiinta la inceputul cartii pe un device,
        // sincronizarea ar readuce procentul vechi, mai mare, de pe celalalt device.
        setRecentBooks(prevLocal => {
          const merged = new Map<string, BookMetadata>();
          prevLocal.forEach(b => merged.set(b.id, b));
          cloudBooks.forEach(cb => {
            const existing = merged.get(cb.id);
            if (existing) {
              const localTime = existing.updatedAtMs || 0;
              const cloudTime = cb.updatedAtMs || 0;
              if (cloudTime > localTime) {
                merged.set(cb.id, { ...existing, ...cb });
              }
              // altfel pastram local-ul neschimbat, e mai recent
            } else {
              merged.set(cb.id, cb);
            }
          });
          const result = Array.from(merged.values());
          localStorage.setItem('pdf_reader_recent_books', JSON.stringify(result));
          return result;
        });
      } catch (e) {
        console.error('Eroare la sincronizarea cu cloud-ul:', e);
      } finally {
        setIsSyncing(false);
      }
    });
    return unsubscribe;
  }, []);

  const handleGoogleSignIn = async () => {
    try {
      await signInWithGoogle();
    } catch (e) {
      console.error('Autentificare esuata:', e);
      alert('Autentificarea cu Google a esuat. Incearca din nou.');
    }
  };

  const handleSignOut = async () => {
    try {
      await signOutUser();
    } catch (e) {
      console.error('Delogare esuata:', e);
    }
  };

  // Handle page turn shortcuts in page mode
  useEffect(() => {
    if (!parsedPdf || layoutMode !== 'page') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if editing user profile in modal
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) {
        return;
      }

      if ((e.key === ' ' && !e.shiftKey) || e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        goToNextPage();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || (e.key === ' ' && e.shiftKey)) {
        e.preventDefault();
        goToPrevPage();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [parsedPdf, layoutMode, currentPage]);

  // --------------------------------------------------------------------------
  // PARSING PDF FILE
  // --------------------------------------------------------------------------
  const handlePdfUpload = async (uploadedFile: File) => {
    if (uploadedFile.type !== 'application/pdf') {
      alert('Te rugăm să încarci un fișier de tip PDF valid.');
      return;
    }

    setIsParsing(true);
    setParseProgress(0);

    let parsed: ParsedPDF | null = null;

    try {
      // 1. Parsarea PDF-ului (aici crește progress bar-ul de la 0 la 100%)
      parsed = await parsePdfFile(uploadedFile, (progress) => {
        setParseProgress(progress);
      });
    } catch (e) {
      console.error(e);
      alert('A apărut o eroare la procesarea documentului PDF. Asigură-te că fișierul nu este securizat sau corupt.');
      setIsParsing(false);
      setParseProgress(0);
      return;
    } finally {
      // Oprim ecranul de parsare cu bară de progres, deoarece parsarea brută s-a terminat
      setIsParsing(false);
      setParseProgress(0);
    }

    // 2. Acum activăm ecranul curat de loading (cel de la istoric, "Se deschide cartea...") 
    // pentru partea de salvare și pregătire a interfeței!
    setIsOpeningBook(true); 

    try {
      const bookId = `book-${Date.now()}`;
      
      // Salvez în IndexedDB
      await saveParsedPDF(bookId, parsed);

      const existingBook = recentBooks.find(b => b.title === parsed.title);
      const now = new Date().toISOString();
      const nowMs = Date.now();

      let updatedRecents: BookMetadata[] = [];
      if (existingBook) {
        updatedRecents = [
          {
            ...existingBook,
            lastAccessedAt: now,          
            updatedAtMs: nowMs,           
            coverImage: existingBook.coverImage || parsed.coverImage,
          },
          ...recentBooks.filter(b => b.id !== existingBook.id)
        ];
        
        setActiveBookId(existingBook.id);
        localStorage.setItem('pdf_reader_active_book_id', existingBook.id);
        setParsedPdf(parsed);

        await deleteParsedPDF(bookId);
        restoreReadingPosition(existingBook.lastActiveParagraphId, 500, undefined, parsed);
      } else {
        const newBook: BookMetadata = {
          id: bookId,
          title: parsed.title,
          totalPages: parsed.totalPages,
          progressPercentage: 0,
          lastActiveParagraphId: parsed.paragraphs[0]?.id || null,
          updatedAtMs: nowMs,
          createdAt: now,                 
          lastAccessedAt: now,            
          coverImage: parsed.coverImage,
        };
        updatedRecents = [newBook, ...recentBooks];

        setActiveBookId(bookId);
        localStorage.setItem('pdf_reader_active_book_id', bookId);
        setParsedPdf(parsed);
      }

      setRecentBooks(updatedRecents);
      localStorage.setItem('pdf_reader_recent_books', JSON.stringify(updatedRecents));

      if (cloudUser) {
        const savedMeta = updatedRecents.find(b => b.id === (existingBook ? existingBook.id : bookId));
        if (savedMeta) {
          setIsSyncing(true);
          uploadFullBookToCloud(cloudUser.uid, { ...savedMeta, updatedAtMs: savedMeta.updatedAtMs ?? Date.now() }, parsed)
            .catch(e => console.error('Eroare la urcarea cartii in cloud:', e))
            .finally(() => setIsSyncing(false));
        }
      }

      // O mică pauză de tranziție ca să fie totul fluid
      await new Promise(resolve => setTimeout(resolve, 200));

    } catch (e) {
      console.error(e);
      alert('A apărut o eroare la salvarea documentului.');
    } finally {
      // 3. Închidem definitiv ecranul de "Se deschide cartea..." când totul e gata
      setIsOpeningBook(false);
    }
  };

  const loadBookFromHistory = async (id: string) => {
    setIsOpeningBook(true);
    try {
      let bookData = await getParsedPDF(id);

      if (!bookData && cloudUser) {
        setIsSyncing(true);
        bookData = await downloadBookContent(cloudUser.uid, id);
        if (bookData) {
          await saveParsedPDF(id, bookData);
        }
        setIsSyncing(false);
      }

      if (bookData) {
        setParsedPdf(bookData);
        setActiveBookId(id);
        localStorage.setItem('pdf_reader_active_book_id', id);

        const metadata = recentBooks.find(b => b.id === id);
        if (metadata) {
          setScrollPercentage(metadata.progressPercentage || 0);
          if (metadata.lastActiveParagraphId) {
            const p = bookData.paragraphs.find(par => par.id === metadata.lastActiveParagraphId);
            if (p) {
              if (layoutMode === 'scroll') setCurrentPage(p.pageNumber);
              
              // 🚀 Pune un setTimeout mic aici ca DOM-ul să apuce să randeze cartea 
              // înainte să încerce să facă scroll la paragraful respectiv
              setTimeout(() => {
                try {
                  restoreReadingPosition(p.id, 400, undefined, bookData);
                } catch (err) {
                  console.warn("Nu s-a putut restabili poziția exactă:", err);
                } finally {
                  setIsOpeningBook(false); // Oprește loading-ul aici sigur!
                }
              }, 100);
            } else {
              setIsOpeningBook(false);
            }
          } else {
            setIsOpeningBook(false);
          }

          if (bookData.coverImage && !metadata.coverImage) {
            const updated = recentBooks.map(b => {
              if (b.id === id) {
                return { ...b, coverImage: bookData.coverImage, updatedAtMs: Date.now() };
              }
              return b;
            });
            setRecentBooks(updated);
            localStorage.setItem('pdf_reader_recent_books', JSON.stringify(updated));
            if (cloudUser) {
              const updatedMeta = updated.find(b => b.id === id);
              if (updatedMeta) {
                saveCloudBookMetadata(cloudUser.uid, updatedMeta).catch(e =>
                  console.error('Eroare la sincronizarea cover-ului:', e)
                );
              }
            }
          }
        } else {
          setIsOpeningBook(false);
        }
      } else {
        alert('Cartea selectată nu a fost găsită nici local, nici în cloud.');
        setIsOpeningBook(false);
      }
    } catch (error) {
      console.error(error);
      alert('A apărut o eroare la încărcarea cărții.');
      setIsOpeningBook(false);
    }
  };

  const handleDeleteBook = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('Ești sigur că vrei să ștergi această carte din istoric?')) return;

    try {
      const updated = recentBooks.filter(b => b.id !== id);
      setRecentBooks(updated);
      localStorage.setItem('pdf_reader_recent_books', JSON.stringify(updated));

      await deleteParsedPDF(id);

      if (cloudUser) {
        deleteFullBookFromCloud(cloudUser.uid, id).catch(e =>
          console.error('Eroare la stergerea din cloud:', e)
        );
      }

      if (activeBookId === id) {
        setActiveBookId(null);
        localStorage.removeItem('pdf_reader_active_book_id');
        setParsedPdf(null);
      }
    } catch (error) {
      console.error('Failed to delete book:', error);
    }
  };

  // Drag and Drop Handlers
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handlePdfUpload(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handlePdfUpload(e.target.files[0]);
    }
  };

  // --------------------------------------------------------------------------
  // SCROLL PROGRESS TRACKING
  // --------------------------------------------------------------------------
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (layoutMode !== 'scroll') return;
    const target = e.currentTarget;
    const progress = (target.scrollTop / (target.scrollHeight - target.clientHeight)) * 100;
    const currentPercent = Math.round(progress || 0);
    setScrollPercentage(currentPercent); // ieftin, ramane instant la fiecare scroll

    // PARTEA SCUMPA: gasirea paragrafului vizibil parcurge TOATE paragrafele
    // cartii si calculeaza getBoundingClientRect() pentru fiecare. La o carte
    // de sute de pagini, rulat la fiecare eveniment de scroll (zeci/secunda),
    // asta era principala cauza de "lag" in timpul citirii. O rulam acum doar
    // dupa ce scroll-ul s-a oprit (150ms fara alt eveniment), nu la fiecare pixel.
    if (!parsedPdf) return;
    if (scrollSearchTimer.current) clearTimeout(scrollSearchTimer.current);
    scrollSearchTimer.current = setTimeout(() => {
      if (!readerMainRef.current) return;
      const containerRect = readerMainRef.current.getBoundingClientRect();
      const containerMiddle = containerRect.top + containerRect.height / 3;

      let closestId: string | null = null;
      let minDistance = Infinity;

      parsedPdf.paragraphs.forEach(p => {
        const el = paragraphRefs.current[p.id];
        if (el) {
          const rect = el.getBoundingClientRect();
          const distance = Math.abs(rect.top - containerMiddle);
          if (distance < minDistance) {
            minDistance = distance;
            closestId = p.id;
          }
        }
      });

      if (closestId) {
        updateBookProgress(closestId, currentPercent);
      }
    }, 150);
  };

  const updateBookProgress = (paragraphId: string, percent: number) => {
    if (!parsedPdf || !activeBookId) return;
    let updatedMeta: BookMetadata | null = null;
    const updated = recentBooks.map(b => {
      if (b.id === activeBookId) {
        updatedMeta = {
          ...b,
          progressPercentage: percent,
          lastActiveParagraphId: paragraphId,
          updatedAtMs: Date.now(),
        };
        return updatedMeta;
      }
      return b;
    });
    setRecentBooks(updated);
    localStorage.setItem('pdf_reader_recent_books', JSON.stringify(updated));

    // Trimitem si in cloud, dar cu debounce (nu la fiecare eveniment de scroll/pagina)
    // ca sa nu facem sute de scrieri Firestore in timpul citirii.
    if (cloudUser && updatedMeta) {
      const metaToSync = updatedMeta;
      if (progressSyncTimer.current) clearTimeout(progressSyncTimer.current);
      progressSyncTimer.current = setTimeout(() => {
        saveCloudBookMetadata(cloudUser.uid, metaToSync).catch(e =>
          console.error('Eroare la sincronizarea progresului:', e)
        );
      }, 1500);
    }
  };

  // --------------------------------------------------------------------------
  // PAGE MODE PROGRESS TRACKING
  // --------------------------------------------------------------------------
  // handleScroll (mai sus) salveaza progresul DOAR cand layoutMode === 'scroll'.
  // In modul 'page' (Pagini/Coloane) nu exista niciun echivalent care sa apeleze
  // updateBookProgress -> de-asta nu se retinea NICIODATA unde ai ramas cand
  // citeai pe coloane, indiferent cat timp stateai pe o pagina. Nu tine de tine,
  // era pur si simplu neimplementat pentru acest mod.
  const findVisibleParagraphId = (mode: 'scroll' | 'page' = layoutMode): string | null => {
    if (!readerMainRef.current || !parsedPdf) return null;
    const containerRect = readerMainRef.current.getBoundingClientRect();
    let closestId: string | null = null;
    let minDistance = Infinity;

    if (mode === 'scroll') {
      // In scroll, cautam paragraful cel mai apropiat de mijlocul VERTICAL al ecranului.
      const containerMiddle = containerRect.top + containerRect.height / 3;
      parsedPdf.paragraphs.forEach(p => {
        const el = paragraphRefs.current[p.id];
        if (el) {
          const rect = el.getBoundingClientRect();
          const distance = Math.abs(rect.top - containerMiddle);
          if (distance < minDistance) {
            minDistance = distance;
            closestId = p.id;
          }
        }
      });
    } else {
      // In modul coloane, cautam paragraful vizibil cel mai apropiat de marginea
      // stanga a ecranului (verificare ORIZONTALA, are sens doar cand paragrafele
      // sunt asezate in coloane, nu stivuite vertical ca in scroll).
      parsedPdf.paragraphs.forEach(p => {
        const el = paragraphRefs.current[p.id];
        if (el) {
          const rect = el.getBoundingClientRect();
          const isVisible = rect.right > containerRect.left && rect.left < containerRect.right;
          if (isVisible) {
            const distance = Math.abs(rect.left - containerRect.left);
            if (distance < minDistance) {
              minDistance = distance;
              closestId = p.id;
            }
          }
        }
      });
    }

    return closestId;
  };

  const savePageModeProgress = () => {
    const id = findVisibleParagraphId();
    if (id && parsedPdf && parsedPdf.paragraphs.length > 1) {
      // Procentul e calculat DIN INDEXUL GLOBAL al paragrafului in carte,
      // nu din pagina curenta/total (care acum sunt relative la bucata
      // randata) - altfel procentul ar sari haotic intre 0-100% la fiecare
      // bucata, in loc sa reflecte progresul real prin toata cartea.
      const globalIndex = parsedPdf.paragraphs.findIndex(p => p.id === id);
      const percent = globalIndex >= 0
        ? Math.round((globalIndex / (parsedPdf.paragraphs.length - 1)) * 100)
        : 0;
      updateBookProgress(id, percent);
    }
  };

  // --------------------------------------------------------------------------
  // AUTOSAVE PERIODIC (plasa de siguranta)
  // --------------------------------------------------------------------------
  // In loc sa depindem DOAR de "a prinde exact momentul potrivit" (scroll
  // debounce + flush la iesire), salvam pozitia curenta la fiecare 2 secunde,
  // cat timp o carte e deschisa - complet independent de evenimente de
  // scroll/navigare. Simplu si robust: indiferent ce se intampla (inchizi
  // tab-ul, dai refresh, navighezi altfel decat prin butonul standard), nu
  // poti pierde mai mult de ~2 secunde de progres.
  //
  // Optimizare: sarim peste cautarea costisitoare (parcurgerea tuturor
  // paragrafelor) daca pozitia NU s-a schimbat deloc fata de ultima verificare
  // (ex. stai pe loc si citesti, fara sa dai scroll/pagina) - un simplu
  // numar comparat la fiecare 2 secunde e practic gratuit.
  const lastCheckedScrollPos = useRef<number>(-1);
  const saveCurrentProgress = () => {
    if (!parsedPdf || !activeBookId || !readerMainRef.current) return;
    const currentPos = layoutMode === 'scroll'
      ? readerMainRef.current.scrollTop
      : readerMainRef.current.scrollLeft;

    if (currentPos === lastCheckedScrollPos.current) return; // nu s-a miscat nimic, nu recalculam
    lastCheckedScrollPos.current = currentPos;

    if (layoutMode === 'scroll') {
      const id = findVisibleParagraphId('scroll');
      if (id) {
        const target = readerMainRef.current;
        const progress = (target.scrollTop / (target.scrollHeight - target.clientHeight)) * 100;
        updateBookProgress(id, Math.round(progress || 0));
      }
    } else {
      savePageModeProgress();
    }
  };

  useEffect(() => {
    if (!parsedPdf) return;
    const interval = setInterval(saveCurrentProgress, 2000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedPdf, activeBookId, layoutMode, pageChunkIndex]);

  // --------------------------------------------------------------------------
  // RESTORE READING POSITION (scroll SAU coloane)
  // --------------------------------------------------------------------------
  // BUG anterior: la restaurare, codul seta currentPage = p.pageNumber (numarul
  // paginii ORIGINALE din PDF), dar in modul coloane currentPage inseamna cu
  // totul altceva (indexul "ecranului" orizontal din text-ul reflow-uit) ->
  // sarea mereu intr-un loc gresit. Acum calculam exact la ce ecran orizontal
  // se afla paragraful, pe baza pozitiei lui reale in DOM dupa layout.
  //
  // De cand am introdus randarea pe bucati (PAGE_CHUNK_SIZE), trebuie intai
  // sa comutam pe bucata care contine paragraful tinta, INAINTE sa calculam
  // pozitia orizontala - altfel paragraful nici nu exista in DOM.
  const restoreReadingPosition = (paragraphId: string | null, delay = 500, modeOverride?: 'scroll' | 'page', pdfDataOverride?: ParsedPDF) => {
    // IMPORTANT: folosim pdfDataOverride (transmis explicit) in loc sa ne
    // bazam pe "parsedPdf" din closure. Cand aceasta functie e apelata din
    // loadBookOnStartup/loadBookFromHistory (chiar dupa un setParsedPdf(...)),
    // closure-ul lui restoreReadingPosition ramane "inghetat" la randarea in
    // care a fost creat - unde parsedPdf era inca null (cartea nu era inca
    // incarcata) - INDIFERENT ca setParsedPdf a fost apelat ulterior in acea
    // executie. Verificarea "if (!parsedPdf) return" ar iesi mereu tacut,
    // fara sa restaureze nimic - exact motivul pentru care sarea pe o pagina
    // "aleatoare" (de fapt: nicio restaurare nu se intampla deloc).
    const pdfData = pdfDataOverride ?? parsedPdf;
    if (!paragraphId || !pdfData) return;
    const mode = modeOverride ?? layoutMode;

    if (mode === 'page') {
      const targetPara = pdfData.paragraphs.find(p => p.id === paragraphId);
      if (targetPara) {
        const targetChunk = Math.floor((targetPara.pageNumber - 1) / PAGE_CHUNK_SIZE);
        setPageChunkIndex(targetChunk);
      }
    }

    setTimeout(() => {
      const element = paragraphRefs.current[paragraphId];
      if (!element || !readerMainRef.current) return;

      if (mode === 'scroll') {
        element.scrollIntoView({ behavior: 'auto', block: 'center' });
        return;
      }

      const article = readerMainRef.current.querySelector('.reader-article') as HTMLElement | null;
      if (!article) return;
      const step = getScrollStep();
      if (step <= 0) return;

      const articleRect = article.getBoundingClientRect();
      const elRect = element.getBoundingClientRect();
      const offsetLeft = (elRect.left - articleRect.left) + readerMainRef.current.scrollLeft;
      const targetPage = Math.max(1, Math.floor(offsetLeft / step) + 1);

      setCurrentPage(targetPage);
      readerMainRef.current.scrollTo({ left: (targetPage - 1) * step, behavior: 'auto' });
    }, delay);
  };

  // --------------------------------------------------------------------------
  // PAGE NAVIGATION HANDLERS (PAGE MODE - HORIZONTAL)
  // --------------------------------------------------------------------------
  const [totalHorizontalPages, setTotalHorizontalPages] = useState<number>(1);

  // Funcție care determină distanța exactă la pixel pe care trebuie să o dăm "paginii"
  // (Este lățimea vizibilă a containerului + golul de column-gap invizibil dintre ecrane)
  // IMPORTANT: masuram latimea REALA a lui .reader-article (containerul cu coloane),
  // NU a parintelui .reader-main. Parintele are propriul padding, iar daca foloseam
  // clientWidth-ul lui + gap, padding-ul era numarat de doua ori => fiecare "pagina"
  // sarea cu ~48px in plus, motiv pentru care textul se taia la margini.
  const getScrollStep = () => {
    if (!readerMainRef.current) return 0;
    const article = readerMainRef.current.querySelector('.reader-article') as HTMLElement | null;
    if (!article) return readerMainRef.current.clientWidth;

    let gap = 0;
    const gapStr = window.getComputedStyle(article).columnGap;
    if (gapStr && gapStr.endsWith('px')) {
      gap = parseFloat(gapStr);
    } else {
      gap = 32;
    }

    const articleWidth = article.getBoundingClientRect().width;
    return articleWidth + gap;
  };

  // Recalculates horizontal pages when rendering finishes or window resizes,
  // and RE-SYNCS the actual scroll position to match currentPage.
  // Fără acest re-sync, orice reflow (schimbare font, spațiere, resize) lasă
  // scrollLeft "înghețat" la o poziție în pixeli care nu mai cade pe o graniță
  // de coloană validă -> exact cauza textului tăiat la mijloc.
  useEffect(() => {
    if (layoutMode !== 'page' || !parsedPdf) return;
    const calculatePages = () => {
      if (readerMainRef.current) {
        const step = getScrollStep();
        if (step > 0) {
          const total = Math.ceil(readerMainRef.current.scrollWidth / step);
          const clampedTotal = Math.max(1, total);
          setTotalHorizontalPages(clampedTotal);

          const safePage = Math.min(currentPage, clampedTotal);
          if (safePage !== currentPage) setCurrentPage(safePage);
          readerMainRef.current.scrollTo({ left: (safePage - 1) * step, behavior: 'smooth' });
          setTimeout(() => savePageModeProgress(), 350);
        }
      }
    };
    setTimeout(calculatePages, 200);
    // Debounce resize: fara asta, calculatePages (care recalculeaza scrollWidth
    // si repozitioneaza scroll-ul) rula la FIECARE pixel de redimensionare a
    // ferestrei, ceea ce e inutil de scump.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(calculatePages, 200);
    };
    window.addEventListener('resize', debouncedResize);
    return () => {
      window.removeEventListener('resize', debouncedResize);
      if (resizeTimer) clearTimeout(resizeTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutMode, parsedPdf, fontSize, lineSpacing, fontFamily, pageChunkIndex]);

  // Navigare ABSOLUTĂ (scrollTo pe baza paginii țintă), nu relativă (scrollBy).
  const goToNextPage = () => {
    if (!parsedPdf) return;
    if (layoutMode === 'page' && readerMainRef.current) {
      if (currentPage < totalHorizontalPages) {
        const next = currentPage + 1;
        const step = getScrollStep();
        setCurrentPage(next);
        readerMainRef.current.scrollTo({ left: (next - 1) * step, behavior: 'smooth' });
        setScrollPercentage(Math.round((next / totalHorizontalPages) * 100));
        setTimeout(() => savePageModeProgress(), 350);
      } else {
        // Am ajuns la finalul bucatii randate - trecem la urmatoarea bucata
        // de continut (daca mai exista), in loc sa fim blocati la "ultima
        // pagina" cand de fapt cartea mai continua.
        const maxChunk = Math.floor((parsedPdf.totalPages - 1) / PAGE_CHUNK_SIZE);
        if (pageChunkIndex < maxChunk) {
          setPageChunkIndex(c => c + 1);
          setCurrentPage(1);
        }
      }
    }
  };

  const goToPrevPage = () => {
    if (!parsedPdf) return;
    if (layoutMode === 'page' && readerMainRef.current) {
      if (currentPage > 1) {
        const prev = currentPage - 1;
        const step = getScrollStep();
        setCurrentPage(prev);
        readerMainRef.current.scrollTo({ left: (prev - 1) * step, behavior: 'smooth' });
        setScrollPercentage(Math.round((prev / totalHorizontalPages) * 100));
        setTimeout(() => savePageModeProgress(), 350);
      } else if (pageChunkIndex > 0) {
        // La inceputul bucatii curente - trecem la bucata anterioara si
        // aterizam pe ULTIMA ei pagina (sentinel mare, clampat automat de
        // efectul de recalculare cand bucata noua se randeaza).
        setPageChunkIndex(c => c - 1);
        setCurrentPage(Number.MAX_SAFE_INTEGER);
      }
    }
  };

  const toggleBionic = () => {
    setIsProcessingBionic(true);
    setTimeout(() => {
      setIsBionic(prev => !prev);
      setIsProcessingBionic(false);
    }, 120); // allow browser to paint loader first
  };

  // --------------------------------------------------------------------------
  // CLOSING THE READER
  // --------------------------------------------------------------------------
  const handleBackToDashboard = () => {
    // Daca exista o salvare de progres in asteptare (debounce dupa scroll
    // sau schimbare de pagina), o "golim"/executam IMEDIAT inainte sa
    // parasim cartea. Altfel, daca dai scroll si apesi rapid "inapoi"
    // (in mai putin de 150-350ms), salvarea programata ajunge sa ruleze
    // DUPA ce activeBookId a fost deja sters -> se pierde silentios ultima
    // pozitie, si la redeschidere te trimite cine stie unde (sau la inceput).
    if (scrollSearchTimer.current) {
      clearTimeout(scrollSearchTimer.current);
      scrollSearchTimer.current = null;
    }
    if (layoutMode === 'scroll') {
      const id = findVisibleParagraphId('scroll');
      if (id) updateBookProgress(id, scrollPercentage);
    } else {
      savePageModeProgress();
    }

    setParsedPdf(null);
    localStorage.removeItem('pdf_reader_active_book_id');
    setActiveBookId(null);
  };

  // Helper to resolve custom responsive greetings
  const getGreetingText = () => {
    const isDefault = userProfile.name.trim() === 'Cititor Pasionat' || userProfile.name.trim() === '';
    return isDefault ? 'Salut, Cititorule!' : `Salut, ${userProfile.name}!`;
  };

  // Functie de formatare a intervalului de citire a unei carti si afisare in ui
  const formatDateRange = (createdAt?: string, lastAccessedAt?: string): string => {
    if (!createdAt) return '';
    
    const start = new Date(createdAt);
    const end = lastAccessedAt ? new Date(lastAccessedAt) : new Date();

    const optionsStart: Intl.DateTimeFormatOptions = { 
      day: 'numeric', 
      month: 'long', 
      year: start.getFullYear() !== end.getFullYear() ? 'numeric' : undefined 
    };
    
    const optionsEnd: Intl.DateTimeFormatOptions = { 
      day: 'numeric', 
      month: 'long', 
      year: 'numeric' 
    };

    const formattedStart = start.toLocaleDateString('ro-RO', optionsStart);
    const formattedEnd = end.toLocaleDateString('ro-RO', optionsEnd);

    if (formattedStart === formattedEnd) {
      return formattedEnd;
    }

    return `${formattedStart} – ${formattedEnd}`;
  };

  // Funcția inteligentă de Start / Stop cu reluare de unde a rămas a corectarii tipografice
  const handleToggleAICleanup = async () => {
    if (isAiCleaning) {
      isCleaningRef.current = false;
      setIsAiCleaning(false);
      return;
    }

    if (!parsedPdf || !activeBookId) return;
    
    let currentParagraphs = parsedPdf.paragraphs;
    let startIndex = (parsedPdf as any).lastCleanedIndex || 0;
    const totalParagraphs = currentParagraphs.length;
    
    if (startIndex >= totalParagraphs) {
      if (confirm("Cartea pare deja curățată integral. Vrei să o iei de la capăt?")) {
        startIndex = 0;
      } else {
        return;
      }
    }

    let hasMore = startIndex < totalParagraphs;

    isCleaningRef.current = true;
    setIsAiCleaning(true);
    setAiCleanStatus(`${startIndex} / ${totalParagraphs}`);

    try {
      while (hasMore && isCleaningRef.current) {
        const targetIndex = Math.min(startIndex + 30, totalParagraphs);

        // 🚀 Facem o creștere vizuală lină (din aproape în aproape) până la următorul batch
        const animateProgress = async (from: number, to: number) => {
          let current = from;
          while (current < to && isCleaningRef.current) {
            current++;
            setAiCleanStatus(`${current} / ${totalParagraphs}`);
            // Interval mic între pași ca să pară natural (ex: 100ms pe paragraf)
            await new Promise(r => setTimeout(r, 100)); 
          }
        };

        // Pornim animația vizuală în paralel cu cererea la AI
        const animationPromise = animateProgress(startIndex, targetIndex);

        const result = await smartCleanParagraphsWithAI(
          currentParagraphs, 
          startIndex, 
          30, 
          (processed, total) => {
            setAiCleanStatus(`${processed} / ${total}`);
          }
        );
        
        // Ne asigurăm că animația s-a terminat sau sincronizăm exact cu rezultatul real
        await animationPromise;

        if (!isCleaningRef.current) break;

        currentParagraphs = result.updatedParagraphs;
        startIndex = result.nextIndex;
        hasMore = result.hasMore;

        const updatedParsed = { 
          ...parsedPdf, 
          paragraphs: currentParagraphs,
          lastCleanedIndex: startIndex 
        };
        setParsedPdf(updatedParsed);
        await saveParsedPDF(activeBookId, updatedParsed);
        
        // Pauza de 3 secunde cerută de rate limit
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      
      if (!isCleaningRef.current) {
        console.log(`Proces oprit de utilizator la paragraful ${startIndex}. Progresul a fost salvat.`);
      } else {
        alert('✨ Cartea a fost curățată complet și impecabil cu AI!');
      }
    } catch (error) {
      console.error('Eroare la curățarea cu AI:', error);
      alert('A apărut o eroare în timpul curățării cu AI. Verifică consola.');
    } finally {
      isCleaningRef.current = false;
      setIsAiCleaning(false);
    }
  };

  // --------------------------------------------------------------------------
  // RENDER SECTIONS
  // --------------------------------------------------------------------------

  // Dashboard / Upload Screen
  const renderDashboard = () => {
    return (
      <>
        {/* Top bar - in afara app-container, la fel ca in reader, ca sa se intinda
            pe toata latimea ecranului si sa arate identic in ambele ecrane */}
        <header className="app-header">
          <div className="brand">
            <span>read-pdf</span>
          </div>
          <div className="header-actions">
            {isFirebaseConfigured ? (
              cloudUser ? (
                <button
                  className="btn sync-status-btn"
                  onClick={handleSignOut}
                  title={`Conectat ca ${cloudUser.displayName || cloudUser.email}. Click pentru deconectare.`}
                >
                  {isSyncing ? '⏳ Sincronizare...' : `☁️ ${getGreetingText()}`}
                </button>
              ) : (
                <button className="btn sync-status-btn" onClick={handleGoogleSignIn} title="Conecteaza-te cu Google pentru sincronizare intre device-uri">
                  🔗 {getGreetingText()}
                </button>
              )
            ) : (
              <span className="user-badge">{getGreetingText()}</span>
            )}
            <button className="btn btn-icon-only hamburger-btn" onClick={() => {
              setTempProfileName(userProfile.name);
              setShowProfileModal(true);
            }} title="Deschide Setări & Personalizare">
              ☰
            </button>
          </div>
        </header>

        <div className="app-container">

        {/* Hero Section */}
        <section className="welcome-hero">
          <h2>Lectură Re-definită în Browser</h2>
          <p>Încarcă orice fișier PDF și transformă-l instantaneu într-o carte digitală captivantă, ușor de citit, cu moduri de focusare, paginare pe coloane și teme confortabile.</p>
        </section>

        {/* Drag and Drop Zone */}
        <div className="dropzone-container">
          {isParsing ? (
            <div className="loading-box">
              <h3>📖 Se extrage textul din documentul tău...</h3>
              <p>Analizăm structura paginilor și re-creăm paragrafele pentru o citire optimă.</p>
              <div className="progress-track">
                <div className="progress-bar" style={{ width: `${parseProgress}%` }}></div>
              </div>
              <p className="sidebar-label">{parseProgress}% finalizat</p>
            </div>
          ) : (
            <div 
              className={`dropzone ${dragActive ? 'active' : ''}`}
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
              onClick={() => document.getElementById('file-upload')?.click()}
            >
              <div className="dropzone-icon">📥</div>
              <div className="dropzone-text">
                <h3>Trage și plasează fișierul PDF aici</h3>
                <p>Sau dă click pentru a alege un fișier de pe calculatorul tău.</p>
              </div>
              <input 
                id="file-upload"
                type="file"
                className="file-input"
                accept=".pdf"
                onChange={handleFileChange}
              />
            </div>
          )}
        </div>

        {/* Library History Section */}
        {recentBooks.length > 0 && (
          <section className="recent-library">
            <h3 className="section-title">📂 Continuă Lectura (Istoric Recente)</h3>
            <div className="recent-grid">
              {recentBooks.map((book) => (
                <div 
                  key={book.id} 
                  className="recent-card"
                  onClick={() => loadBookFromHistory(book.id)}
                  style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '1rem' }}
                >
                  
                  {/* RÂNDUL 1: Titlul cărții */}
                  <div className="card-details" style={{ margin: 0 }}>
                    <h4 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 600, lineHeight: '1.4' }}>
                      {book.title}
                    </h4>
                  </div>

                  {/* RÂNDUL 2: Bara de progres */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.4rem' }}>
                    <div className="card-progress-bar-container" style={{ margin: 0, flexGrow: 1 }}>
                      <div className="card-progress-bar" style={{ width: `${book.progressPercentage}%` }}></div>
                    </div>
                    <span style={{ fontSize: '0.75rem', fontWeight: 'bold', color: 'var(--accent-color)', minWidth: '35px', textAlign: 'right' }}>
                      {book.progressPercentage}%
                    </span>
                  </div>

                  {/* RÂNDUL 3: Imaginea + Coloana cu detalii unificate stilistic */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem' }}>
                    {book.coverImage ? (
                      <img 
                        src={book.coverImage} 
                        alt={book.title} 
                        className="card-cover-thumbnail" 
                        style={{ width: '60px', height: '80px', objectFit: 'cover', borderRadius: '6px', flexShrink: 0 }} 
                      />
                    ) : (
                      <span className="card-icon" style={{ width: '60px', height: '80px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>📄</span>
                    )}
                    
                    {/* Coloana din dreapta: Pagini, Interval, Ștergere - Stil unitar */}
                    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: '80px', flexGrow: 1 }}>
                      
                      {/* Interval date */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '1rem', color: 'var(--text-muted, #a1a1aa)' }}>
                        <span>
                          <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><title>time-fill</title><g fill="none"><path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z"/><path fill="currentColor" d="M12 2c5.523 0 10 4.477 10 10s-4.477 10-10 10S2 17.523 2 12S6.477 2 12 2m0 4a1 1 0 0 0-1 1v5a1 1 0 0 0 .293.707l3 3a1 1 0 0 0 1.414-1.414L13 11.586V7a1 1 0 0 0-1-1"/></g></svg>
                        </span>
                        <span>{formatDateRange(book.createdAt, book.lastAccessedAt)}</span>
                      </div>

                      {/* Număr pagini */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '1rem', color: 'var(--text-muted, #a1a1aa)' }}>
                        <span>
                          <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 512 512"><title>book</title><path fill="currentColor" d="M202.24 74C166.11 56.75 115.61 48.3 48 48a31.36 31.36 0 0 0-17.92 5.33A32 32 0 0 0 16 79.9V366c0 19.34 13.76 33.93 32 33.93c71.07 0 142.36 6.64 185.06 47a4.11 4.11 0 0 0 6.94-3V106.82a15.9 15.9 0 0 0-5.46-12A143 143 0 0 0 202.24 74m279.68-20.7A31.33 31.33 0 0 0 464 48c-67.61.3-118.11 8.71-154.24 26a143.3 143.3 0 0 0-32.31 20.78a15.93 15.93 0 0 0-5.45 12v337.13a3.93 3.93 0 0 0 6.68 2.81c25.67-25.5 70.72-46.82 185.36-46.81a32 32 0 0 0 32-32v-288a32 32 0 0 0-14.12-26.61"/></svg>
                        </span>
                        <span>{book.totalPages} pagini</span>
                      </div>

                      {/* Buton ștergere cu iconiță conturată */}
                      <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                        <button 
                          onClick={(e) => handleDeleteBook(e, book.id)}
                          title="Șterge cartea din istoric"
                          style={{ 
                            background: 'transparent', 
                            border: 'none', 
                            color: 'var(--text-muted, #a1a1aa)', 
                            cursor: 'pointer', 
                            display: 'flex', 
                            alignItems: 'center', 
                            gap: '0.4rem', 
                            fontSize: '1rem',
                            padding: 0,
                            transition: 'color 0.2s',
                            fontFamily: 'var(--font-sans)'
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.color = '#ef4444'}
                          onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-muted, #a1a1aa)'}
                        >
                          <span>
                            <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><title>trash-bin-2-bold</title><path fill="currentColor" d="M2.75 6.167c0-.46.345-.834.771-.834h2.665c.529-.015.996-.378 1.176-.916l.03-.095l.115-.372c.07-.228.131-.427.217-.605c.338-.702.964-1.189 1.687-1.314c.184-.031.377-.031.6-.031h3.478c.223 0 .417 0 .6.031c.723.125 1.35.612 1.687 1.314c.086.178.147.377.217.605l.115.372l.03.095c.18.538.74.902 1.27.916h2.57c.427 0 .772.373.772.834S20.405 7 19.979 7H3.52c-.426 0-.771-.373-.771-.833M11.607 22h.787c2.707 0 4.06 0 4.941-.863c.88-.864.97-2.28 1.15-5.111l.26-4.081c.098-1.537.147-2.305-.295-2.792s-1.187-.487-2.679-.487H8.23c-1.491 0-2.237 0-2.679.487s-.392 1.255-.295 2.792l.26 4.08c.18 2.833.27 4.248 1.15 5.112S8.9 22 11.607 22"/></svg>
                          </span>
                          <span>Șterge cartea</span>
                        </button>
                      </div>

                    </div>
                  </div>

                </div>
              ))}
            </div>
          </section>
        )}

        </div>
      </>
    );
  };

  // Main Reader Workspace View
  const renderReader = () => {
    if (!parsedPdf) return null;

    // Font styles mapper
    let activeFontClass = 'var(--font-serif)';
    if (fontFamily === 'sans') activeFontClass = 'var(--font-sans)';
    if (fontFamily === 'dyslexic') activeFontClass = 'var(--font-dyslexic)';

    // In modul Coloane, randam DOAR paragrafele din bucata curenta de
    // PAGE_CHUNK_SIZE pagini (nu toata cartea) - optimizare de performanta
    // pentru carti mari (1000+ pagini). In modul Scroll, ramane neschimbat.
    const visibleParagraphs = layoutMode === 'page'
      ? parsedPdf.paragraphs.filter(p => Math.floor((p.pageNumber - 1) / PAGE_CHUNK_SIZE) === pageChunkIndex)
      : parsedPdf.paragraphs;

    return (
      <div className="reader-wrapper">
        
        {/* Top Control Bar - Unifed to look exactly like Dashboard Navbar */}
        <header className="reader-topbar app-header">
          <div className="brand clickable" onClick={handleBackToDashboard} title="Mergi înapoi la Dashboard">
            <span>read-pdf</span>
          </div>

          <div className="reader-topbar-center">
            {/* Displaying Page navigation in center of navbar */}
            {layoutMode === 'page' ? (
              <div className="header-navigation">
                <button 
                  className="btn btn-icon-only page-nav-mini-btn" 
                  onClick={goToPrevPage} 
                  disabled={currentPage === 1 && pageChunkIndex === 0}
                  title="Pagina precedentă (Taste: Stânga / Sus)"
                >
                  ◀
                </button>
                <span className="page-nav-info">
                  {currentPage} / {totalHorizontalPages}
                </span>
                <button 
                  className="btn btn-icon-only page-nav-mini-btn" 
                  onClick={goToNextPage} 
                  disabled={currentPage >= totalHorizontalPages && pageChunkIndex >= Math.floor((parsedPdf.totalPages - 1) / PAGE_CHUNK_SIZE)}
                  title="Pagina următoare (Taste: Space / Dreapta / Jos)"
                >
                  ▶
                </button>
              </div>
            ) : (
              <span className="scroll-progress-badge">
                📖 Progres: {scrollPercentage}%
              </span>
            )}
          </div>

          <div className="reader-topbar-right header-actions">
            {isFirebaseConfigured ? (
              cloudUser ? (
                <button
                  className="btn sync-status-btn"
                  onClick={handleSignOut}
                  title={`Conectat ca ${cloudUser.displayName || cloudUser.email}. Click pentru deconectare.`}
                >
                  {isSyncing ? '⏳ Sincronizare...' : `☁️ ${getGreetingText()}`}
                </button>
              ) : (
                <button className="btn sync-status-btn" onClick={handleGoogleSignIn} title="Conecteaza-te cu Google pentru sincronizare intre device-uri">
                  🔗 {getGreetingText()}
                </button>
              )
            ) : (
              <span className="user-badge">{getGreetingText()}</span>
            )}
            <button className="btn btn-icon-only hamburger-btn" onClick={() => {
              setTempProfileName(userProfile.name);
              setShowProfileModal(true);
            }} title="Deschide Setări & Personalizare">
              ☰
            </button>
          </div>
        </header>

        {/* Reader Container */}
        <div className="reader-container">
          
          {/* Main article container */}
          <main 
            ref={readerMainRef}
            className={`reader-main ${layoutMode === 'page' ? 'page-mode' : ''}`} 
            onScroll={handleScroll}
          >
            <article 
              className={`reader-article ${layoutMode === 'page' ? 'page-mode' : ''}`}
              style={{
                '--font-active': activeFontClass,
                '--font-size-active': `${fontSize}px`,
                '--line-spacing-active': lineSpacing,
              } as React.CSSProperties}
            >
              {visibleParagraphs.map((p) => {
                  return (
                    <div 
                      key={p.id}
                      ref={el => { paragraphRefs.current[p.id] = el; }}
                      className="reader-paragraph-wrapper"
                    >
                      {layoutMode === 'scroll' && (
                        <span className="page-indicator-badge">
                          Pag. {p.pageNumber}
                        </span>
                      )}
                      {isBionic ? (
                        renderBionicParagraph(p.text)
                      ) : (
                        <p>{p.text}</p>
                      )}
                    </div>
                  );
                })}
            </article>
          </main>

        </div>
      </div>
    );
  };

  // Unified Settings Modal Dialog (Curățat de butoane inutile & mai aerisit)
  const renderProfileModal = () => {
    if (!showProfileModal) return null;
    return (
      <div className="modal-backdrop" onClick={() => setShowProfileModal(false)}>
        <div className="modal-content unified-settings-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>⚙️ Setări & Personalizare</h3>
          </div>
          
          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* 1. Name input */}
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="user-name-input">Numele Tău de Cititor</label>
              <input 
                id="user-name-input"
                type="text" 
                className="form-input"
                value={tempProfileName}
                onChange={(e) => setTempProfileName(e.target.value)}
                placeholder="Ex: Mihai, Elena, etc."
              />
            </div>

            {/* 2. Layout Mode Selector */}
            {parsedPdf && (
              <div className="settings-section" style={{ marginBottom: 0 }}>
                <span className="settings-label">Mod Vizualizare Document</span>
                <div className="choice-grid" style={{ marginTop: '0.5rem' }}>
                  <button 
                    className={`btn ${layoutMode === 'scroll' ? 'btn-primary' : ''}`} 
                    onClick={() => {
                      const currentId = findVisibleParagraphId(layoutMode);
                      setLayoutMode('scroll');
                      restoreReadingPosition(currentId, 100, 'scroll');
                    }}
                  >
                    📖 Scroll Clasic
                  </button>
                  <button 
                    className={`btn ${layoutMode === 'page' ? 'btn-primary' : ''}`} 
                    onClick={() => {
                      const currentId = findVisibleParagraphId(layoutMode);
                      setLayoutMode('page');
                      restoreReadingPosition(currentId, 400, 'page');
                    }}
                  >
                    📄 Pagini / Coloane
                  </button>
                </div>
              </div>
            )}

            {/* 3. Theme Selector */}
            <div className="settings-section" style={{ marginBottom: 0 }}>
              <span className="settings-label">Tema de Lectură</span>
              <div className="theme-selector" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button 
                  className={`theme-btn theme-btn-sepia ${theme === 'sepia' ? 'active' : ''}`} 
                  onClick={() => setTheme('sepia')}
                  title="Sepia Hârtie"
                >
                  🍂
                </button>
                <button 
                  className={`theme-btn theme-btn-light ${theme === 'light' ? 'active' : ''}`} 
                  onClick={() => setTheme('light')}
                  title="Luminos"
                >
                  ☀️
                </button>
                <button 
                  className={`theme-btn theme-btn-dark ${theme === 'dark' ? 'active' : ''}`} 
                  onClick={() => setTheme('dark')}
                  title="Întunecat"
                >
                  🌙
                </button>
                <button 
                  className={`theme-btn theme-btn-forest ${theme === 'forest' ? 'active' : ''}`} 
                  onClick={() => setTheme('forest')}
                  title="Midnight Forest"
                >
                  🌲
                </button>
                <button 
                  className={`theme-btn theme-btn-sunset ${theme === 'sunset' ? 'active' : ''}`} 
                  onClick={() => setTheme('sunset')}
                  title="Sunset Oasis"
                >
                  🌆
                </button>
              </div>
            </div>

            {/* 4. Text Size & Line spacing in grid */}
            <div className="settings-grid-2col" style={{ marginBottom: 0 }}>
              <div className="settings-section" style={{ marginBottom: 0 }}>
                <span className="settings-label">Dimensiune Text ({fontSize}px)</span>
                <div className="font-size-controls" style={{ marginTop: '0.5rem' }}>
                  <button className="btn font-size-btn" onClick={() => {
                    const currentIndex = FONT_SIZES.indexOf(fontSize);
                    if (currentIndex > 0) setFontSize(FONT_SIZES[currentIndex - 1]);
                    else if (currentIndex === -1) setFontSize(16);
                  }}>A-</button>
                  <button className="btn font-size-btn" onClick={() => {
                    const currentIndex = FONT_SIZES.indexOf(fontSize);
                    if (currentIndex !== -1 && currentIndex < FONT_SIZES.length - 1) setFontSize(FONT_SIZES[currentIndex + 1]);
                    else if (currentIndex === -1) setFontSize(18);
                  }}>A+</button>
                </div>
              </div>

              <div className="settings-section" style={{ marginBottom: 0 }}>
                <span className="settings-label">Citire Bionică</span>
                <button 
                  className={`btn ${isBionic ? 'btn-primary' : ''}`} 
                  onClick={toggleBionic}
                  style={{ width: '100%', height: '38px', marginTop: '0.5rem' }}
                >
                  {isBionic ? '🧠 Activată' : 'Dezactivată'}
                </button>
              </div>
            </div>

            {/* 5. Line Spacing */}
            <div className="settings-section" style={{ marginBottom: 0 }}>
              <span className="settings-label">Distanțiere Linii</span>
              <div className="choice-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: '0.5rem' }}>
                <button 
                  className={`btn ${lineSpacing === 1.4 ? 'btn-primary' : ''}`} 
                  onClick={() => setLineSpacing(1.4)}
                  style={{ fontSize: '0.8rem', padding: '0.5rem' }}
                >
                  Compactă
                </button>
                <button 
                  className={`btn ${lineSpacing === 1.65 ? 'btn-primary' : ''}`} 
                  onClick={() => setLineSpacing(1.65)}
                  style={{ fontSize: '0.8rem', padding: '0.5rem' }}
                >
                  Normală
                </button>
                <button 
                  className={`btn ${lineSpacing === 2.0 ? 'btn-primary' : ''}`} 
                  onClick={() => setLineSpacing(2.0)}
                  style={{ fontSize: '0.8rem', padding: '0.5rem' }}
                >
                  Aerisită
                </button>
              </div>
            </div>

            {/* 6. Font Style Selector */}
            <div className="settings-section" style={{ marginBottom: 0 }}>
              <span className="settings-label">Tip Font Text</span>
              <div className="font-family-selector" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button 
                  className={`btn ${fontFamily === 'serif' ? 'btn-primary' : ''}`} 
                  onClick={() => setFontFamily('serif')}
                  style={{ fontSize: '0.8rem', padding: '0.5rem' }}
                >
                  Serif (Carte)
                </button>
                <button 
                  className={`btn ${fontFamily === 'sans' ? 'btn-primary' : ''}`} 
                  onClick={() => setFontFamily('sans')}
                  style={{ fontSize: '0.8rem', padding: '0.5rem' }}
                >
                  Sans-Serif
                </button>
                <button 
                  className={`btn ${fontFamily === 'dyslexic' ? 'btn-primary' : ''}`} 
                  onClick={() => setFontFamily('dyslexic')}
                  style={{ fontSize: '0.8rem', padding: '0.5rem' }}
                >
                  Dyslexic
                </button>
              </div>
            </div>

            {/* 7. Secțiunea de Curățare Tipografică cu AI */}
            {parsedPdf && (
              <div className="settings-section" style={{ marginBottom: 0 }}>
                <span className="settings-label">Corectare Tipografică Text (AI)</span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
                  <button 
                    className={`btn ${isAiCleaning ? 'btn-danger' : 'btn-primary'}`} 
                    onClick={handleToggleAICleanup}
                    style={{ width: '100%' }}
                  >
                    {isAiCleaning ? `⏹️ Oprește Curățarea (${aiCleanStatus} paragrafe)` : '✨ Curăță Cartea cu Gemini AI'}
                  </button>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                    {isAiCleaning ? 'Procesul rulează. Poți opri oricând.' : 'Repară automat cuvintele rupte, spațiile și antetele.'}
                  </span>
                </div>
              </div>
            )}

            {/* 8. Statistics / Info tag */}
            <div className="settings-stats-footer" style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border-color)', paddingTop: '1rem', marginTop: '0.5rem' }}>
              <span className="stats-tag" style={{ fontSize: '0.8rem', fontWeight: 'bold', color: 'var(--text-muted)' }}>
                📚 {userProfile.totalBooksParsed} Cărți
              </span>
              <span className="stats-tag" style={{ fontSize: '0.8rem', fontWeight: 'bold', color: 'var(--text-muted)' }}>
                📅 Din: {userProfile.joinedDate}
              </span>
              <span className="stats-tag" style={{ fontSize: '0.8rem', fontWeight: 'bold', color: 'var(--text-muted)' }}>
                🎨 Temă: {theme}
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      {/* 🚀 Ecranul de încărcare la pornire/refresh */}
      {isAppLoading && (
        <div className="app-startup-overlay">
          <div className="bionic-spinner"></div>
          <p>Se pregătește biblioteca ta...</p>
        </div>
      )}

      {/* 🚀 Ecranul de încărcare la deschiderea unei carti */}
      {isOpeningBook && (
        <div className="bionic-loading-overlay">
          <div className="bionic-spinner"></div>
          <p>Se deschide cartea...</p>
        </div>
      )}

      {/* 🚀 Ecranul de încărcare la citire bionica */}
      {parsedPdf ? renderReader() : renderDashboard()}
      {renderProfileModal()}
      {isProcessingBionic && (
        <div className="bionic-loading-overlay">
          <div className="bionic-spinner"></div>
          <p>Se optimizează textul pentru citire bionică...</p>
        </div>
      )}
    </>
  );
}

export default App;
