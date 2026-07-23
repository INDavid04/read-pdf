import React, { useState, useEffect, useRef } from 'react';
import { parsePdfFile } from './utils/pdfParser';
import type { ParsedPDF } from './utils/pdfParser';
import { renderBionicParagraph } from './utils/bionic';
import { saveParsedPDF, getParsedPDF, deleteParsedPDF } from './utils/db';
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
  lastReadDate: string;
  progressPercentage: number;
  lastActiveParagraphId: string | null;
  updatedAtMs: number;
  coverImage?: string;
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
  }, []);

  const loadBookOnStartup = async (id: string, recentsList: BookMetadata[], modeAtLoad: 'scroll' | 'page') => {
    setIsParsing(true);
    setParseProgress(0);
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
    } finally {
      setIsParsing(false);
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

    try {
      const parsed = await parsePdfFile(uploadedFile, (progress) => {
        setParseProgress(progress);
      });

      const bookId = `book-${Date.now()}`;
      
      // Save full parsed PDF to IndexedDB for quick persistent loading
      await saveParsedPDF(bookId, parsed);

      // Check if this book title is already in recent books list to restore progress
      const existingBook = recentBooks.find(b => b.title === parsed.title);
      
      const now = new Date().toLocaleDateString('ro-RO', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      let updatedRecents: BookMetadata[] = [];
      if (existingBook) {
        // Move to the top of list, reuse ID to avoid duplicate store entries
        updatedRecents = [
          {
            ...existingBook,
            lastReadDate: now,
            coverImage: existingBook.coverImage || parsed.coverImage,
          },
          ...recentBooks.filter(b => b.id !== existingBook.id)
        ];
        
        setActiveBookId(existingBook.id);
        localStorage.setItem('pdf_reader_active_book_id', existingBook.id);
        setParsedPdf(parsed);

        // Delete the redundant newly generated DB entry since we reuse the existing one
        await deleteParsedPDF(bookId);

        // Restore position
        restoreReadingPosition(existingBook.lastActiveParagraphId, 500, undefined, parsed);
      } else {
        const newBook: BookMetadata = {
          id: bookId,
          title: parsed.title,
          totalPages: parsed.totalPages,
          lastReadDate: now,
          progressPercentage: 0,
          lastActiveParagraphId: parsed.paragraphs[0]?.id || null,
          updatedAtMs: Date.now(),
          coverImage: parsed.coverImage,
        };
        updatedRecents = [newBook, ...recentBooks];

        // Increment total parsed books count in profile
        const updatedProfile = {
          ...userProfile,
          totalBooksParsed: userProfile.totalBooksParsed + 1
        };
        setUserProfile(updatedProfile);
        localStorage.setItem('pdf_reader_profile', JSON.stringify(updatedProfile));

        setActiveBookId(bookId);
        localStorage.setItem('pdf_reader_active_book_id', bookId);
        setParsedPdf(parsed);
        setCurrentPage(1);
        setScrollPercentage(0);
      }

      setRecentBooks(updatedRecents);
      localStorage.setItem('pdf_reader_recent_books', JSON.stringify(updatedRecents));

      // Urcam cartea completa in cloud daca userul e autentificat, ca sa fie
      // disponibila si pe celelalte device-uri fara sa o reincarce manual.
      if (cloudUser) {
        const savedMeta = updatedRecents.find(b => b.id === (existingBook ? existingBook.id : bookId));
        if (savedMeta) {
          setIsSyncing(true);
          // updatedAtMs poate lipsi la carti mai vechi (adaugate inainte de acest
          // camp) - punem un fallback ca sa satisfacem tipul cerut de upload.
          uploadFullBookToCloud(cloudUser.uid, { ...savedMeta, updatedAtMs: savedMeta.updatedAtMs ?? Date.now() }, parsed)
            .catch(e => console.error('Eroare la urcarea cartii in cloud:', e))
            .finally(() => setIsSyncing(false));
        }
      }

    } catch (e) {
      console.error(e);
      alert('A apărut o eroare la procesarea documentului PDF. Asigură-te că fișierul nu este securizat sau corupt.');
      setIsParsing(false);
    }
  };

  const loadBookFromHistory = async (id: string) => {
    setIsParsing(true);
    setParseProgress(0);
    try {
      let bookData = await getParsedPDF(id);

      // Daca nu exista local (ex: pe un device nou, dupa sincronizare), o luam
      // din cloud si o salvam local pentru acces rapid data viitoare.
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
              restoreReadingPosition(p.id, 400, undefined, bookData);
            }
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
        }
      } else {
        alert('Cartea selectată nu a fost găsită nici local, nici în cloud.');
      }
    } catch (error) {
      console.error(error);
      alert('A apărut o eroare la încărcarea cărții.');
    } finally {
      setIsParsing(false);
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
  // USER PROFILE SAVE LOGIC
  // --------------------------------------------------------------------------
  const saveProfile = () => {
    if (tempProfileName.trim() === '') return;
    const updated = {
      ...userProfile,
      name: tempProfileName.trim()
    };
    setUserProfile(updated);
    localStorage.setItem('pdf_reader_profile', JSON.stringify(updated));
    setShowProfileModal(false);
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
                >
                  <button 
                    className="delete-book-btn" 
                    onClick={(e) => handleDeleteBook(e, book.id)}
                    title="Șterge din istoric"
                  >
                    ✕
                  </button>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                    {book.coverImage ? (
                      <img src={book.coverImage} alt={book.title} className="card-cover-thumbnail" />
                    ) : (
                      <span className="card-icon">📄</span>
                    )}
                    <span className="page-indicator-badge" style={{ opacity: 1, position: 'static' }}>
                      {book.totalPages} pagini
                    </span>
                  </div>
                  <div className="card-details">
                    <h4>{book.title}</h4>
                    <p>Ultima accesare: {book.lastReadDate}</p>
                    <p style={{ marginTop: '0.25rem', fontWeight: 'bold', color: 'var(--accent-color)' }}>
                      Progres: {book.progressPercentage}%
                    </p>
                    <div className="card-progress-bar-container">
                      <div className="card-progress-bar" style={{ width: `${book.progressPercentage}%` }}></div>
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

  // Unified Settings Modal Dialog
  const renderProfileModal = () => {
    if (!showProfileModal) return null;
    return (
      <div className="modal-backdrop" onClick={() => setShowProfileModal(false)}>
        <div className="modal-content unified-settings-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>⚙️ Setări & Personalizare</h3>
            <button className="btn btn-icon-only" onClick={() => setShowProfileModal(false)}>✕</button>
          </div>
          
          <div className="modal-body">
            {/* 1. Name input */}
            <div className="form-group">
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
              <div className="settings-section">
                <span className="settings-label">Mod Vizualizare Document</span>
                <div className="choice-grid">
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
            <div className="settings-section">
              <span className="settings-label">Tema de Lectură</span>
              <div className="theme-selector" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '0.5rem' }}>
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
            <div className="settings-grid-2col">
              <div className="settings-section">
                <span className="settings-label">Dimensiune Text ({fontSize}px)</span>
                <div className="font-size-controls">
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

              <div className="settings-section">
                <span className="settings-label">Citire Bionică</span>
                <button 
                  className={`btn ${isBionic ? 'btn-primary' : ''}`} 
                  onClick={toggleBionic}
                  style={{ width: '100%', height: '38px' }}
                >
                  {isBionic ? '🧠 Activată' : 'Dezactivată'}
                </button>
              </div>
            </div>

            {/* 5. Font Style Selector & Line Spacing */}
            <div className="settings-section">
              <span className="settings-label">Distanțiere Linii</span>
              <div className="choice-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
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

            <div className="settings-section">
              <span className="settings-label">Tip Font Text</span>
              <div className="font-family-selector" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}>
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

            {/* 6. Statistics / Info tag */}
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

          <div className="modal-footer">
            <button className="btn" onClick={() => setShowProfileModal(false)}>Anulează</button>
            <button className="btn btn-primary" onClick={saveProfile}>Salvează & Aplică</button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
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
